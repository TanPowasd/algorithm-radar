/**
 * /api/* 路由核心：鉴权解析、CSRF 双提交校验、限流、错误归一。
 * 页面/静态资源由 Cloudflare Pages 直接托管，这里只处理 API。
 */
import {
    approveUser, AuthUser, authenticate, changePassword, countUsers, createToken, csrfCookie,
    CSRF_COOKIE, CSRF_HEADER, constantTimeEqual, cookieValue, isAtLeast,
    listActiveContributors, listUsers, newCsrfToken, registerUser, rejectUser,
    renewAfter, sessionCookie, SESSION_COOKIE, SessionData, setRole, setupOwner, verifyToken,
} from "./auth";
import { ApiError, DIFFICULTY_NAMES, forbidden, tooMany, unauthorized } from "./util";
import * as store from "./store";
import { fetchLuoguProblem } from "./luogu";
import { ensureSchema } from "./ensureSchema";
export interface Env {
    DB: D1Database;
    /** 公网首次初始化站长用的一次性口令（wrangler pages secret put SETUP_TOKEN） */
    SETUP_TOKEN?: string;
}

interface RouteCtx {
    req: Request;
    url: URL;
    env: Env;
    params: Record<string, string>;
    user: AuthUser | null;
    session: SessionData | null;
    body: any;
    /** 本次响应要追加的 Set-Cookie */
    cookies: string[];
    /** 当前 CSRF 令牌（已有 Cookie 或本次新签发） */
    csrf: string;
}

type Json = Record<string, unknown> | Array<unknown>;

interface Route {
    method: string;
    /** 如 "/api/records/:id/status" */
    path: string;
    /** 需要的最低角色；null 表示游客可访问 */
    role: string | null;
    handler: (ctx: RouteCtx) => Promise<Json | Response> | Json | Response;
}

// ---------------------------------------------------------------- 限流（进程内滑动窗口，尽力而为）

const buckets = new Map<string, number[]>();

function tryAcquire(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
        buckets.set(key, hits);
        if (buckets.size > 10000) buckets.clear();
        return false;
    }
    hits.push(now);
    buckets.set(key, hits);
    return true;
}

function clientIp(req: Request): string {
    return req.headers.get("CF-Connecting-IP") || "local";
}

// ---------------------------------------------------------------- 工具

function isLocalHost(url: URL): boolean {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function requireRole(ctx: RouteCtx, role: string): AuthUser {
    if (!ctx.user) throw unauthorized("请先登录");
    if (!isAtLeast(ctx.user, role)) {
        throw forbidden("权限不足，需要" +
            (role === "owner" ? "站长" : role === "admin" ? "管理员" : "贡献者") + "权限");
    }
    return ctx.user;
}

function str(value: unknown): string {
    return value === undefined || value === null ? "" : String(value);
}

function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
    const pp = pattern.split("/").filter(Boolean);
    const up = pathname.split("/").filter(Boolean);
    if (pp.length !== up.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < pp.length; i++) {
        const seg = pp[i];
        if (seg.startsWith(":")) {
            params[seg.slice(1)] = decodeURIComponent(up[i]);
        } else if (seg !== up[i]) {
            return null;
        }
    }
    return params;
}

async function currentRevision(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'")
        .first<{ n: number }>();
    return row?.n ?? 0;
}

async function loginResponse(ctx: RouteCtx, user: AuthUser): Promise<Json> {
    ctx.cookies.push(sessionCookie(await createToken(ctx.env.DB, user)));
    return {
        ok: true, admin: isAtLeast(user, "admin"), role: user.role,
        username: user.username, nickname: user.nickname ?? "",
    };
}

// ---------------------------------------------------------------- 路由表

const routes: Route[] = [
    { method: "GET", path: "/api/ping", role: null, handler: () => ({
        ok: true,
        app: "AI vs 洛谷",
        time: new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, ""),
        difficultyNames: DIFFICULTY_NAMES,
    }) },

    { method: "GET", path: "/api/session", role: null, handler: async (ctx) => {
        const userCount = await countUsers(ctx.env.DB);
        // 会话签发超过阈值时自动续签（重发 Cookie）
        if (ctx.session && Date.now() / 1000 - ctx.session.iat > renewAfter()) {
            ctx.cookies.push(sessionCookie(await createToken(ctx.env.DB, ctx.session.user)));
        }
        return {
            loggedIn: !!ctx.user,
            username: ctx.user?.username ?? "",
            nickname: ctx.user?.nickname ?? "",
            role: ctx.user?.role ?? "",
            admin: isAtLeast(ctx.user, "admin"),
            canSetup: userCount === 0 && (isLocalHost(ctx.url) || !!ctx.env.SETUP_TOKEN),
            configured: userCount > 0,
            csrfToken: ctx.csrf,
        };
    } },

    { method: "POST", path: "/api/setup", role: null, handler: async (ctx) => {
        if (await countUsers(ctx.env.DB) > 0) {
            throw new ApiError(409, "站长账号已初始化，请直接登录");
        }
        const localOk = isLocalHost(ctx.url);
        const tokenOk = !!ctx.env.SETUP_TOKEN && ctx.body?.setupToken === ctx.env.SETUP_TOKEN;
        if (!localOk && !tokenOk) {
            throw forbidden("公网初始化需要 SETUP_TOKEN（wrangler pages secret put SETUP_TOKEN）");
        }
        const user = await setupOwner(ctx.env.DB, str(ctx.body?.username), str(ctx.body?.password), str(ctx.body?.nickname) || undefined);
        return loginResponse(ctx, { uid: user.id, username: user.username, nickname: user.nickname ?? "", role: user.role });
    } },

    { method: "POST", path: "/api/login", role: null, handler: async (ctx) => {
        if (!tryAcquire("login:" + clientIp(ctx.req), 6, 600_000)) {
            throw tooMany("登录尝试过于频繁，请 10 分钟后再试");
        }
        const user = await authenticate(ctx.env.DB, str(ctx.body?.username), str(ctx.body?.password));
        return loginResponse(ctx, user);
    } },

    { method: "POST", path: "/api/logout", role: null, handler: (ctx) => {
        ctx.cookies.push(sessionCookie("", true));
        return { ok: true };
    } },

    /** 修改密码（任何登录用户）：旧密码校验通过后更新哈希并递增 password_version，
     *  其他设备旧令牌立即失效；当前设备换发新会话 Cookie。限流 5 次/10 分钟防爆破 */
    { method: "POST", path: "/api/change-password", role: "contributor", handler: async (ctx) => {
        const user = requireRole(ctx, "contributor");
        if (!tryAcquire("changepw:" + clientIp(ctx.req), 5, 600_000)) {
            throw tooMany("操作过于频繁，请 10 分钟后再试");
        }
        await changePassword(ctx.env.DB, user.uid, str(ctx.body?.oldPassword), str(ctx.body?.newPassword));
        ctx.cookies.push(sessionCookie(await createToken(ctx.env.DB, user)));
        return { ok: true, message: "密码已修改，其他设备已退出登录" };
    } },

    { method: "POST", path: "/api/auth/register", role: null, handler: async (ctx) => {
        if (!tryAcquire("register:" + clientIp(ctx.req), 6, 3_600_000)) {
            throw tooMany("注册尝试过于频繁，请稍后再试");
        }
        await registerUser(ctx.env.DB, str(ctx.body?.username), str(ctx.body?.nickname), str(ctx.body?.password));
        return { ok: true, message: "注册成功，请等待站长审核" };
    } },

    { method: "GET", path: "/api/data", role: null, handler: async (ctx) => {
        const snap = await store.snapshot(ctx.env.DB, ctx.user?.username ?? null, isAtLeast(ctx.user, "admin"));
        return { revision: snap.revision, updatedAt: snap.updatedAt, records: snap.records, problems: snap.problems };
    } },

    { method: "POST", path: "/api/records", role: "contributor", handler: async (ctx) => {
        if (!tryAcquire("write:" + clientIp(ctx.req), 60, 60_000)) {
            throw tooMany("操作过于频繁，请稍后再试");
        }
        const user = requireRole(ctx, "contributor");
        const raw = ctx.body?.record && typeof ctx.body.record === "object" ? ctx.body.record : ctx.body;
        const { rec, revision } = await store.addRecord(ctx.env.DB, raw,
            { uid: user.uid, username: user.username, isAdminLike: isAtLeast(user, "admin") });
        return {
            ok: true, record: rec, revision,
            message: rec.status === "approved" ? "已保存并计入统计" : "已提交，等待管理员审核",
        };
    } },

    { method: "PUT", path: "/api/records/:id", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const raw = ctx.body?.record && typeof ctx.body.record === "object" ? ctx.body.record : ctx.body;
        const { rec, revision } = await store.updateRecord(ctx.env.DB, ctx.params.id, raw);
        return { ok: true, record: rec, revision };
    } },

    { method: "DELETE", path: "/api/records/:id", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const revision = await store.deleteRecord(ctx.env.DB, ctx.params.id); // 软删除 → 回收站
        return { ok: true, revision };
    } },

    // ---- 回收站（软删除记录：查看 / 恢复 / 永久删除 / 清空）----
    { method: "GET", path: "/api/trash", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        return { ok: true, records: await store.listTrash(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/trash/restore", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : [];
        const restored = await store.restoreTrash(ctx.env.DB, ids);
        return { ok: true, restored, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/trash/purge", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : [];
        const purged = await store.purgeTrash(ctx.env.DB, ids);
        return { ok: true, purged, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/trash/empty", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const purged = await store.emptyTrash(ctx.env.DB);
        return { ok: true, purged, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/records/:id/status", role: "admin", handler: async (ctx) => {
        const reviewer = requireRole(ctx, "admin");
        const rec = await store.setStatus(ctx.env.DB, ctx.params.id, str(ctx.body?.status), reviewer.uid);
        return { ok: true, record: rec, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/records/bulk", role: "admin", handler: async (ctx) => {
        const reviewer = requireRole(ctx, "admin");
        const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : [];
        const affected = await store.bulkStatus(ctx.env.DB, ids, str(ctx.body?.action), reviewer.uid);
        return { ok: true, affected, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/problems", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const pid = str(ctx.body?.pid);
        const info = ctx.body?.problem && typeof ctx.body.problem === "object" ? { ...ctx.body.problem } : {};
        const needTitle = !info.title || !String(info.title).trim();
        const needDifficulty = info.difficulty === undefined || info.difficulty === null;
        if (needTitle || needDifficulty) {
            try {
                const fetched = await fetchLuoguProblem(pid);
                if (needTitle) info.title = fetched.title;
                if (needDifficulty && fetched.difficulty !== null) info.difficulty = fetched.difficulty;
                if ((!Array.isArray(info.tags) || info.tags.length === 0) && fetched.tags.length) info.tags = fetched.tags;
                if ((!Array.isArray(info.categories) || info.categories.length === 0) && fetched.categories.length) {
                    info.categories = fetched.categories;
                }
                if (!info.fetchedAt) info.fetchedAt = fetched.fetchedAt;
            } catch (e) {
                // 抓取失败不阻塞发布：管理员可手动补全，但要在日志里可见
                console.warn("[problem] 洛谷自动补全失败：", e instanceof Error ? e.message : e);
            }
        }
        const problem = await store.putProblem(ctx.env.DB, pid, info);
        return { ok: true, problem, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "DELETE", path: "/api/problems/:pid", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const revision = await store.deleteProblem(ctx.env.DB, ctx.params.pid);
        return { ok: true, revision };
    } },

    { method: "GET", path: "/api/models", role: null, handler: async (ctx) => ({
        models: await store.listModels(ctx.env.DB),
    }) },

    /** 贡献者名册（公开）：已激活账号 + 各自贡献统计（仅基于已审核记录，游客视角一致） */
    { method: "GET", path: "/api/contributors", role: null, handler: async (ctx) => {
        const users = await listActiveContributors(ctx.env.DB);
        const snap = await store.snapshot(ctx.env.DB, null, false);
        const byAuthor = new Map<string, { total: number; problems: Set<string>; models: Set<string>; lastDate: string }>();
        for (const r of snap.records) {
            const key = r.author || "—";
            if (!byAuthor.has(key)) byAuthor.set(key, { total: 0, problems: new Set(), models: new Set(), lastDate: "" });
            const b = byAuthor.get(key)!;
            b.total += 1;
            b.problems.add(r.pid);
            b.models.add(r.model);
            if (r.date > b.lastDate) b.lastDate = r.date;
        }
        const contributors: Array<{
            uid: number | null; username: string; nickname: string; role: string; joinedAt: string;
            contributions: number; problems: number; models: number; lastDate: string;
        }> = users.map((u) => {
            const b = byAuthor.get(u.username);
            return {
                uid: u.id,
                username: u.username,
                nickname: u.nickname ?? "",
                role: u.role,
                joinedAt: u.joinedAt,
                contributions: b?.total ?? 0,
                problems: b?.problems.size ?? 0,
                models: b?.models.size ?? 0,
                lastDate: b?.lastDate ?? "",
            };
        });
        // 历史导入数据（author 不在活跃用户表）合并为单一「全民制作人」条目
        const known = new Set(users.map((u) => u.username));
        const legacy = { total: 0, problems: new Set<string>(), models: new Set<string>(), lastDate: "" };
        let hasLegacy = false;
        for (const [author, b] of byAuthor) {
            if (known.has(author)) continue;
            hasLegacy = true;
            legacy.total += b.total;
            b.problems.forEach((p) => legacy.problems.add(p));
            b.models.forEach((m) => legacy.models.add(m));
            if (b.lastDate > legacy.lastDate) legacy.lastDate = b.lastDate;
        }
        if (hasLegacy) {
            contributors.push({
                uid: null, username: "全民制作人", nickname: "", role: "legacy", joinedAt: "",
                contributions: legacy.total, problems: legacy.problems.size, models: legacy.models.size, lastDate: legacy.lastDate,
            });
        }
        return { contributors };
    } },

    { method: "POST", path: "/api/models", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const model = await store.createModel(ctx.env.DB, str(ctx.body?.name), str(ctx.body?.vendor), str(ctx.body?.note));
        return { ok: true, model };
    } },

    { method: "PUT", path: "/api/models/:id", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const model = await store.updateModel(ctx.env.DB, Number(ctx.params.id),
            str(ctx.body?.name), str(ctx.body?.vendor), str(ctx.body?.note));
        return { ok: true, model };
    } },

    { method: "DELETE", path: "/api/models/:id", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        await store.deleteModel(ctx.env.DB, Number(ctx.params.id));
        return { ok: true };
    } },

    { method: "GET", path: "/api/admin/users", role: "owner", handler: async (ctx) => {
        requireRole(ctx, "owner");
        return { users: await listUsers(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/admin/users/:id/approve", role: "owner", handler: async (ctx) => {
        const owner = requireRole(ctx, "owner");
        await approveUser(ctx.env.DB, Number(ctx.params.id), owner.username);
        return { ok: true };
    } },

    { method: "POST", path: "/api/admin/users/:id/reject", role: "owner", handler: async (ctx) => {
        requireRole(ctx, "owner");
        await rejectUser(ctx.env.DB, Number(ctx.params.id));
        return { ok: true };
    } },

    { method: "POST", path: "/api/admin/users/:id/role", role: "owner", handler: async (ctx) => {
        requireRole(ctx, "owner");
        await setRole(ctx.env.DB, Number(ctx.params.id), str(ctx.body?.role));
        return { ok: true };
    } },

    { method: "GET", path: "/api/luogu", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        if (!tryAcquire("luogu:" + clientIp(ctx.req), 30, 60_000)) {
            throw tooMany("抓取过于频繁，请稍后再试");
        }
        const problem = await fetchLuoguProblem(ctx.url.searchParams.get("pid") || "");
        return { ok: true, ...problem };
    } },

    { method: "GET", path: "/api/export", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const snap = await store.exportBundle(ctx.env.DB);
        return {
            app: "AI vs 洛谷", version: 3, exportedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            revision: snap.revision, updatedAt: snap.updatedAt,
            records: snap.records, problems: snap.problems, models: snap.models,
        };
    } },

    /** 未收录历史记录分组（收录管理页用）：approved 中题目/模型不在目录的 pid/model 及计数 */
    { method: "GET", path: "/api/hidden-records", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const { problems, models, total } = await store.listHiddenGroups(ctx.env.DB);
        return { ok: true, problems, models, total };
    } },

    /** 隐藏（approved 但未收录）记录明细：管理端查看/处理用 */
    { method: "GET", path: "/api/hidden-records/detail", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        return { ok: true, records: await store.listHiddenRecords(ctx.env.DB) };
    } },

    /** 把某个未收录模型名下的全部隐藏历史记录移入回收站（按模型名；可在回收站恢复） */
    { method: "POST", path: "/api/admin/purge-records", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const moved = await store.purgeRecordsByModel(ctx.env.DB, str(ctx.body?.model));
        return { ok: true, moved };
    } },

    /** 一键清空收录目录（题目 + 模型）与全部记录：清库重建，重新开始收录 */
    { method: "POST", path: "/api/catalog/reset", role: "owner", handler: async (ctx) => {
        requireRole(ctx, "owner");
        await store.resetCatalog(ctx.env.DB);
        return { ok: true, revision: await store.getRevision(ctx.env.DB) };
    } },

    { method: "GET", path: "/api/export/public", role: null, handler: async (ctx) => {
        const snap = await store.snapshot(ctx.env.DB, null, false);
        const format = ctx.url.searchParams.get("format") || "json";
        const dateTag = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        if (format === "csv") {
            const body = "\ufeff" + store.buildCsv(snap.records);
            return new Response(body, {
                headers: {
                    "Content-Type": "text/csv;charset=UTF-8",
                    "Content-Disposition": `attachment; filename="ai-vs-luogu-${dateTag}.csv"`,
                },
            });
        }
        return new Response(JSON.stringify({
            app: "AI vs 洛谷", version: 3, scope: "approved",
            exportedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
            revision: snap.revision, updatedAt: snap.updatedAt,
            records: snap.records, problems: snap.problems,
        }), {
            headers: {
                "Content-Type": "application/json;charset=UTF-8",
                "Content-Disposition": `attachment; filename="ai-vs-luogu-${dateTag}.json"`,
            },
        });
    } },

    { method: "POST", path: "/api/import", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const mode = str(ctx.body?.mode) || "merge";
        const data = ctx.body?.data && typeof ctx.body.data === "object" ? ctx.body.data : ctx.body;
        const { imported } = await store.importBundle(ctx.env.DB, data, mode);
        return { ok: true, imported, revision: await currentRevision(ctx.env.DB) };
    } },
];

// ---------------------------------------------------------------- 入口

const BODY_LIMITS: Array<[string, number]> = [
    ["/api/import", 16 * 1024 * 1024],
    ["/api/records", 2 * 1024 * 1024],
];
const DEFAULT_BODY_LIMIT = 64 * 1024;

export async function handleApi(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const baseHeaders: Record<string, string> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
    };

    const json = (payload: unknown, status = 200): Response => {
        const headers = new Headers({
            "Content-Type": "application/json;charset=UTF-8",
            ...baseHeaders,
        });
        return new Response(JSON.stringify(payload), { status, headers });
    };

    try {
        await ensureSchema(env.DB);

        // CSRF 双提交（对齐旧站）：非 GET 必须带 X-CSRF-Token 且与 radar_csrf Cookie 一致
        const methodSafe = method === "GET" || method === "HEAD" || method === "OPTIONS";
        const csrfCookieValue = cookieValue(req, CSRF_COOKIE);
        if (!methodSafe) {
            const header = req.headers.get(CSRF_HEADER);
            if (!header || !csrfCookieValue || !constantTimeEqual(header, csrfCookieValue)) {
                return json({ error: "CSRF 校验失败，请刷新页面后重试" }, 403);
            }
        }
        const csrf = csrfCookieValue ?? newCsrfToken();
        const cookies: string[] = [];
        if (!csrfCookieValue) cookies.push(csrfCookie(csrf));

        const session = await verifyToken(env.DB, cookieValue(req, SESSION_COOKIE));
        const ctx: RouteCtx = {
            req, url, env, params: {}, user: session?.user ?? null, session,
            body: undefined, cookies, csrf,
        };

        const matched = routes
            .map((r) => ({ r, params: r.method === method ? matchRoute(r.path, url.pathname) : null }))
            .find((m) => m.params !== null);
        if (!matched) {
            return json({ error: "接口不存在" }, 404);
        }
        ctx.params = matched.params!;

        // 请求体解析（带大小上限）
        if (!methodSafe) {
            const limit = BODY_LIMITS.find(([prefix]) => url.pathname.startsWith(prefix))?.[1] ?? DEFAULT_BODY_LIMIT;
            const len = Number(req.headers.get("Content-Length") || "0");
            if (len > limit) return json({ error: "请求体过大" }, 413);
            const text = await req.text();
            if (text.length > limit) return json({ error: "请求体过大" }, 413);
            if (text) {
                try {
                    ctx.body = JSON.parse(text);
                } catch {
                    return json({ error: "请求体不是合法 JSON" }, 400);
                }
            }
        }

        // 角色检查（路由表声明式）
        if (matched.r.role) {
            requireRole(ctx, matched.r.role);
        }

        const result = await matched.r.handler(ctx);
        const withCookies = (res: Response): Response => {
            for (const c of cookies) res.headers.append("Set-Cookie", c);
            for (const [k, v] of Object.entries(baseHeaders)) {
                if (!res.headers.has(k)) res.headers.set(k, v);
            }
            return res;
        };
        if (result instanceof Response) {
            return withCookies(result);
        }
        return withCookies(json(result));
    } catch (e) {
        if (e instanceof ApiError) {
            return json({ error: e.message }, e.status);
        }
        console.error("[api] 未处理错误：", e);
        return json({ error: "服务器内部错误" }, 500);
    }
}
