/**
 * /api/* 路由核心：鉴权解析、CSRF 双提交校验、限流、错误归一。
 * 页面/静态资源由 Cloudflare Pages 直接托管，这里只处理 API。
 */
import {
    approveUser, AuthUser, authenticate, changePassword, countUsers, createToken, csrfCookie,
    CSRF_COOKIE, CSRF_HEADER, constantTimeEqual, cookieValue, deleteUser, findById, isAtLeast,
    listActiveContributors, listUsers, newCsrfToken, registerUser, rejectUser,
    renewAfter, sessionCookie, SESSION_COOKIE, SessionData, setRole, setupOwner, updateNickname, verifyToken,
} from "./auth";
import { ApiError, DIFFICULTY_NAMES, forbidden, tooMany, unauthorized } from "./util";
import * as store from "./store";
import { fetchLuoguProblem } from "./luogu";
import { ensureSchema } from "./ensureSchema";
import { cleanupExpired, runSnapshot } from "./snapshot";
export interface Env {
    DB: D1Database;
    /** 静态资产绑定：非 /api 请求由入口转交（SPA 回退由 assets.not_found_handling 处理） */
    ASSETS: Fetcher;
    /** 原生限流 binding（wrangler.toml [[ratelimits]]，跨 isolate 可靠；周期仅 10/60 秒） */
    WRITE_LIMIT?: RateLimit;
    AUTH_LIMIT?: RateLimit;
    /** 每日数据快照 R2 桶 */
    SNAPSHOT_BUCKET?: R2Bucket;
    /** 公网首次初始化站长用的一次性口令（wrangler secret put SETUP_TOKEN） */
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
    /** 是否为 HTTPS（决定 Cookie 是否带 Secure；本地 http://127.0.0.1 开发环境不带） */
    secure: boolean;
    /** 请求结束后仍可执行的工作（审计写、R2 清理等）；本地/测试环境退化为内联 await */
    defer: (task: Promise<unknown>) => void;
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

// ---------------------------------------------------------------- 限流

/** 进程内滑动窗口：只挡长窗（尽力而为，跨 isolate 靠原生 binding）。
 *  旧实现 `buckets.size > 10000 → buckets.clear()` 会被攻击者用随机 IP 撑满后**清空所有人的计数**，
 *  等价于把限流关掉；现在改成按窗口过期清扫最旧的键。 */
const buckets = new Map<string, number[]>();
const BUCKETS_MAX = 10_000;

function tryAcquire(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
        buckets.set(key, hits);
        pruneBuckets(now);
        return false;
    }
    hits.push(now);
    buckets.set(key, hits);
    pruneBuckets(now);
    return true;
}

/** 清掉整个窗口都已过期的键（按插入顺序 = 最旧先淘汰，不会误伤活跃键） */
function pruneBuckets(now: number): void {
    if (buckets.size <= BUCKETS_MAX) return;
    const overflow = buckets.size - BUCKETS_MAX;
    let removed = 0;
    for (const [k, hits] of buckets) {
        if (removed >= overflow) break;
        const newest = hits[hits.length - 1];
        if (newest === undefined || now - newest >= 3_600_000) {
            buckets.delete(k);
            removed += 1;
        }
    }
    // 仍然超量（全是活跃键）时不再处理：宁可占内存也不给攻击者重置计数的机会
}

function clientIp(req: Request): string {
    return req.headers.get("CF-Connecting-IP") || "local";
}

/** 限流键：登录用户按 uid（同 NAT 出口不再互相误伤），游客按 IP */
function principalKey(req: Request, user: AuthUser | null): string {
    return user ? `u${user.uid}` : `ip${clientIp(req)}`;
}

/** 原生限流优先（跨 isolate 可靠）；binding 异常时**退回进程内窗口**（旧实现是 return true 静默放行） */
async function burstLimit(
    env: Env,
    binding: RateLimit | undefined,
    key: string,
    fallbackLimit: number,
    fallbackWindowMs = 60_000,
): Promise<boolean> {
    if (binding) {
        try {
            return (await binding.limit({ key })).success;
        } catch (e) {
            console.warn("[ratelimit] binding 异常，退回进程内窗口：", e instanceof Error ? e.message : e);
            return tryAcquire(key, fallbackLimit, fallbackWindowMs);
        }
    }
    return tryAcquire(key, fallbackLimit, fallbackWindowMs);
}

// ---------------------------------------------------------------- 工具

/** 这些端点在 handler 内已有更严的 AUTH_LIMIT 长窗，不再叠加通用写限流 */
const AUTH_SCOPED_PATHS = new Set(["/api/setup", "/api/login", "/api/auth/register", "/api/change-password"]);

/** 统一写限流：任何非安全方法都过一遍 WRITE_LIMIT（旧实现只有 3 个写端点接了限流，
 *  PUT /api/records/:id、发布题目、/api/import、回收站等全部裸奔）。
 *  键 = 单个主体的全部写操作合计（登录态按 uid，游客按 IP），避免"每个端点各自 200/分"被绕成 N×200。 */
async function requireWriteBudget(ctx: RouteCtx): Promise<void> {
    if (AUTH_SCOPED_PATHS.has(ctx.url.pathname)) return;
    if (!(await burstLimit(ctx.env, ctx.env.WRITE_LIMIT, `w:${principalKey(ctx.req, ctx.user)}`, 200))) {
        throw tooMany("操作过于频繁，请稍后再试");
    }
}

function isLocalHost(url: URL): boolean {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

/** 恒定时间比较 SETUP_TOKEN（报告 medium-4）：未配置时恒为 false，避免 `===` 时序侧信道 */
function tokenMatches(secret: string | undefined, provided: unknown): boolean {
    if (!secret) return false;
    return constantTimeEqual(secret, str(provided));
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

/** 路径段解码：非法转义（`%E0%A4%A`）应判 400，而不是抛 URIError 冒泡成 500 */
function decodeSegment(raw: string): string {
    try {
        return decodeURIComponent(raw);
    } catch {
        throw new ApiError(400, "请求路径包含非法转义字符");
    }
}

function matchRoute(pattern: string, pathname: string): Record<string, string> | null {
    const pp = pattern.split("/").filter(Boolean);
    const up = pathname.split("/").filter(Boolean);
    if (pp.length !== up.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < pp.length; i++) {
        const seg = pp[i];
        if (seg.startsWith(":")) {
            params[seg.slice(1)] = decodeSegment(up[i]);
        } else if (seg !== up[i]) {
            return null;
        }
    }
    return params;
}

/** 路由匹配结果：null = 404；"method-mismatch" = 路径存在但方法不对（405） */
export type MatchResult = { r: Route; params: Record<string, string> } | "method-mismatch" | null;

export function matchRoutes(method: string, pathname: string): MatchResult {
    let pathExists = false;
    for (const r of routes) {
        const params = matchRoute(r.path, pathname);
        if (params === null) continue;
        pathExists = true;
        if (r.method === method) return { r, params };
    }
    return pathExists ? "method-mismatch" : null;
}

async function currentRevision(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'")
        .first<{ n: number }>();
    return row?.n ?? 0;
}

async function loginResponse(ctx: RouteCtx, user: AuthUser): Promise<Json> {
    ctx.cookies.push(sessionCookie(await createToken(ctx.env.DB, user), false, ctx.secure));
    return {
        ok: true, admin: isAtLeast(user, "admin"), role: user.role,
        username: user.username, nickname: user.nickname ?? "",
    };
}

/** 发布/编辑前尝试用洛谷抓取补全缺失的标题/难度/题面/限制（失败不阻塞：可手动填） */
async function maybeFetchLuogu(pid: string, info: Record<string, unknown>) {
    const needTitle = !info.title || !String(info.title).trim();
    const needDifficulty = info.difficulty === undefined || info.difficulty === null;
    const needContent = !info.content || !String(info.content).trim();
    if (!needTitle && !needDifficulty && !needContent) return;
    try {
        const fetched = await fetchLuoguProblem(pid);
        if (needTitle) info.title = fetched.title;
        if (needDifficulty && fetched.difficulty !== null) info.difficulty = fetched.difficulty;
        if (needContent) {
            info.content = fetched.content;
            info.timeLimit = fetched.timeLimit;
            info.memoryLimit = fetched.memoryLimit;
        }
        // 附件标记：抓取结果可信（attachments 数组）；管理员随后可手动覆盖
        info.hasAttachments = fetched.hasAttachments;
        if ((!Array.isArray(info.tags) || info.tags.length === 0) && fetched.tags.length) {
            info.tags = fetched.tags;
        }
        if ((!Array.isArray(info.categories) || info.categories.length === 0) && fetched.categories.length) {
            info.categories = fetched.categories;
        }
        if (!info.fetchedAt) info.fetchedAt = fetched.fetchedAt;
    } catch (e) {
        // 抓取失败不阻塞发布：管理员可手动补全，但要在日志里可见
        console.warn("[problem] 洛谷自动补全失败：", e instanceof Error ? e.message : e);
    }
}

// ---------------------------------------------------------------- 路由表

/** 解析比赛参数：缺省用默认比赛；指定了不存在的短名直接 404 */
async function resolveCompetitionId(ctx: any, raw: unknown): Promise<string> {
    const key = String(raw ?? "").trim().toLowerCase();
    if (!key) return store.DEFAULT_COMPETITION;
    const c = await store.getCompetition(ctx.env.DB, key);
    if (!c) throw new ApiError(404, "没找到比赛 " + key);
    return c.id;
}

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
            ctx.cookies.push(sessionCookie(await createToken(ctx.env.DB, ctx.session.user), false, ctx.secure));
        }
        // canSetup 面向「唯一初始化场景」：不泄露 SETUP_TOKEN 是否已配置（渗透报告 medium-4）
        return {
            loggedIn: !!ctx.user,
            username: ctx.user?.username ?? "",
            nickname: ctx.user?.nickname ?? "",
            role: ctx.user?.role ?? "",
            admin: isAtLeast(ctx.user, "admin"),
            canSetup: userCount === 0,
            configured: userCount > 0,
            csrfToken: ctx.csrf,
        };
    } },

    { method: "POST", path: "/api/setup", role: null, handler: async (ctx) => {
        // 初始化端点同样限速（渗透报告 medium-4）：原生 binding 爆发层 + 进程内 10 分钟窗口；
        // 限速放在 DB 检查之前，避免初始化窗口内无谓的 D1 读放大
        const ip = clientIp(ctx.req);
        if (!(await burstLimit(ctx.env, ctx.env.AUTH_LIMIT, "setup:" + ip, 5))
            || !tryAcquire("setup:" + ip, 5, 600_000)) {
            throw tooMany("初始化尝试过于频繁，请 10 分钟后再试");
        }
        if (await countUsers(ctx.env.DB) > 0) {
            throw new ApiError(409, "站长账号已初始化，请直接登录");
        }
        const localOk = isLocalHost(ctx.url)
            // wrangler dev 挂了自定义域路由后 req.url 会呈现为域名（如 http://k4u.top），
            // 本地判定只能退而求其次：生产上 Cloudflare 恒定注入 CF-Connecting-IP，缺失即本地 dev
            || clientIp(ctx.req) === "local";
        // 恒定时间比较 SETUP_TOKEN（渗透报告 medium-4；普通 === 存在时序侧信道）
        const tokenOk = tokenMatches(ctx.env.SETUP_TOKEN, ctx.body?.setupToken);
        if (!localOk && !tokenOk) {
            throw forbidden("公网初始化需要 SETUP_TOKEN（wrangler secret put SETUP_TOKEN）");
        }
        const user = await setupOwner(ctx.env.DB, str(ctx.body?.username), str(ctx.body?.password), str(ctx.body?.nickname) || undefined);
        return loginResponse(ctx, { uid: user.id, username: user.username, nickname: user.nickname ?? "", role: user.role });
    } },

    { method: "POST", path: "/api/login", role: null, handler: async (ctx) => {
        const ip = clientIp(ctx.req);
        // 原生 binding 挡 60 秒爆发，进程内 20 次/10 分钟挡长窗（爆破由账号级 5 次失败锁 15 分钟兜底）
        if (!(await burstLimit(ctx.env, ctx.env.AUTH_LIMIT, "login:" + ip, 30))
            || !tryAcquire("login:" + ip, 20, 600_000)) {
            throw tooMany("登录尝试过于频繁，请 10 分钟后再试");
        }
        const user = await authenticate(ctx.env.DB, str(ctx.body?.username), str(ctx.body?.password));
        return loginResponse(ctx, user);
    } },

    { method: "POST", path: "/api/logout", role: null, handler: (ctx) => {
        ctx.cookies.push(sessionCookie("", true, ctx.secure));
        return { ok: true };
    } },

    /** 修改密码（任何登录用户）：旧密码校验通过后更新哈希并递增 password_version，
     *  其他设备旧令牌立即失效；当前设备换发新会话 Cookie。限流 5 次/10 分钟防爆破 */
    { method: "POST", path: "/api/change-password", role: "contributor", handler: async (ctx) => {
        const user = requireRole(ctx, "contributor");
        const ip = clientIp(ctx.req);
        if (!(await burstLimit(ctx.env, ctx.env.AUTH_LIMIT, "changepw:" + ip, 5))
            || !tryAcquire("changepw:" + ip, 5, 600_000)) {
            throw tooMany("操作过于频繁，请 10 分钟后再试");
        }
        await changePassword(ctx.env.DB, user.uid, str(ctx.body?.oldPassword), str(ctx.body?.newPassword));
        ctx.cookies.push(sessionCookie(await createToken(ctx.env.DB, user), false, ctx.secure));
        return { ok: true, message: "密码已修改，其他设备已退出登录" };
    } },

    /** 自助改昵称（显示名即时生效：会话回查用户表取最新昵称，无需重新登录） */
    { method: "POST", path: "/api/profile/nickname", role: "contributor", handler: async (ctx) => {
        const user = requireRole(ctx, "contributor");
        const nickname = await updateNickname(ctx.env.DB, user.uid, str(ctx.body?.nickname));
        return { ok: true, nickname, message: "昵称已更新" };
    } },

    { method: "POST", path: "/api/auth/register", role: null, handler: async (ctx) => {
        const ip = clientIp(ctx.req);
        // 2026-09-06 放宽：IP 级 20 次/小时（原 6 次）；注册垃圾仍由站长审核环节兜底
        if (!(await burstLimit(ctx.env, ctx.env.AUTH_LIMIT, "register:" + ip, 30))
            || !tryAcquire("register:" + ip, 20, 3_600_000)) {
            throw tooMany("注册尝试过于频繁，请稍后再试");
        }
        await registerUser(ctx.env.DB, str(ctx.body?.username), str(ctx.body?.nickname), str(ctx.body?.password));
        return { ok: true, message: "注册成功，请等待站长审核" };
    } },

    /** 数据快照（ETag/304）：先用一次 meta 读做条件请求判定（命中即 304，完全不扫 records/problems），
     *  校验器 = "<cache_epoch>:<revision>-角色"，破坏性操作会换 epoch，杜绝 revision 归零撞旧 ETag */
    { method: "GET", path: "/api/data", role: null, handler: async (ctx) => {
        const adminLike = isAtLeast(ctx.user, "admin");
        const suffix = adminLike ? "a" : "g";
        const inm = ctx.req.headers.get("If-None-Match");
        const preflight = `"${await store.readValidator(ctx.env.DB)}-${suffix}"`;
        if (inm && inm.split(",").some((t) => t.trim() === preflight)) {
            return new Response(null, { status: 304, headers: { ETag: preflight, "Cache-Control": "no-cache" } });
        }
        const snap = await store.snapshot(ctx.env.DB, ctx.user?.username ?? null, adminLike);
        const etag = `"${snap.epoch}:${snap.revision}-${suffix}"`;
        if (inm && inm.split(",").some((t) => t.trim() === etag)) {
            return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
        }
        return new Response(JSON.stringify({
            revision: snap.revision, updatedAt: snap.updatedAt, records: snap.records, problems: snap.problems,
        }), {
            headers: {
                "Content-Type": "application/json;charset=UTF-8",
                ETag: etag,
                "Cache-Control": "no-cache",
            },
        });
    } },

    { method: "POST", path: "/api/records", role: "contributor", handler: async (ctx) => {
        const user = requireRole(ctx, "contributor");
        const raw = ctx.body?.record && typeof ctx.body.record === "object" ? ctx.body.record : ctx.body;
        const { rec, revision } = await store.addRecord(ctx.env.DB, raw,
            { uid: user.uid, username: user.username, isAdminLike: isAtLeast(user, "admin") });
        return {
            ok: true, record: rec, revision,
            message: rec.status === "approved" ? "已保存并计入统计" : "已提交，等待管理员审核",
        };
    } },

    { method: "PUT", path: "/api/records/:id", role: "contributor", handler: async (ctx) => {
        const user = requireRole(ctx, "contributor");
        const raw = ctx.body?.record && typeof ctx.body.record === "object" ? ctx.body.record : ctx.body;
        const isAdminLike = isAtLeast(user, "admin");
        const { rec, revision } = await store.updateRecord(ctx.env.DB, ctx.params.id, raw, {
            uid: user.uid,
            username: user.username,
            isAdminLike,
            // 可选乐观并发基线：客户端带上自己读到的 record.updatedAt，冲突时得到 409
            baseUpdatedAt: typeof ctx.body?.baseUpdatedAt === "string" ? ctx.body.baseUpdatedAt
                : (typeof raw?.baseUpdatedAt === "string" ? raw.baseUpdatedAt : null),
        });
        return {
            ok: true,
            record: rec,
            revision,
            message: rec.status === "approved" ? "已更新并计入统计" : "已更新，需管理员重新审核后生效",
        };
    } },

    { method: "DELETE", path: "/api/records/:id", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const revision = await store.deleteRecord(ctx.env.DB, ctx.params.id); // 软删除 → 回收站
        await store.logAudit(ctx.env.DB, actor, "record.delete", `记录 ${ctx.params.id} 移入回收站`);
        return { ok: true, revision };
    } },

    // ---- 回收站（软删除记录：查看 / 恢复 / 永久删除 / 清空）----
    { method: "GET", path: "/api/trash", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        return { ok: true, records: await store.listTrash(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/trash/restore", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : [];
        const restored = await store.restoreTrash(ctx.env.DB, ids);
        await store.logAudit(ctx.env.DB, actor, "trash.restore", `从回收站恢复 ${restored} 条记录`);
        return { ok: true, restored, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/trash/purge", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const ids: string[] = Array.isArray(ctx.body?.ids) ? ctx.body.ids.map(String) : [];
        const purged = await store.purgeTrash(ctx.env.DB, ids);
        await store.logAudit(ctx.env.DB, actor, "trash.purge", `永久删除 ${purged} 条记录`);
        return { ok: true, purged, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/trash/empty", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const purged = await store.emptyTrash(ctx.env.DB);
        await store.logAudit(ctx.env.DB, actor, "trash.empty", `清空回收站 ${purged} 条记录`);
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
        if (str(ctx.body?.action) === "reject") {
            await store.logAudit(ctx.env.DB, reviewer, "records.bulk", `批量移入回收站 ${affected} 条`);
        }
        return { ok: true, affected, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/problems", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const pid = str(ctx.body?.pid);
        const info = ctx.body?.problem && typeof ctx.body.problem === "object" ? { ...ctx.body.problem } : {};
        await maybeFetchLuogu(pid, info);
        const problem = await store.putProblem(ctx.env.DB, pid, info);
        await store.logAudit(ctx.env.DB, actor, "problem.publish", `发布/更新题目 ${problem.pid}（${problem.title || "无题名"}）`);
        return { ok: true, problem, revision: await currentRevision(ctx.env.DB) };
    } },

    /** 编辑题目（题号不变，全量覆盖字段） */
    { method: "PUT", path: "/api/problems/:pid", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const info = ctx.body?.problem && typeof ctx.body.problem === "object" ? { ...ctx.body.problem } : {};
        const problem = await store.updateProblem(ctx.env.DB, ctx.params.pid, info);
        await store.logAudit(ctx.env.DB, actor, "problem.update", `编辑题目 ${problem.pid}`);
        return { ok: true, problem, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "DELETE", path: "/api/problems/:pid", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const revision = await store.deleteProblem(ctx.env.DB, ctx.params.pid);
        await store.logAudit(ctx.env.DB, actor, "problem.delete", `题目 ${ctx.params.pid}`);
        return { ok: true, revision };
    } },

    { method: "GET", path: "/api/models", role: null, handler: async (ctx) => ({
        models: await store.listModels(ctx.env.DB),
    }) },

    /** 贡献者名册（公开）：两条聚合 SQL（按 author 分组 + 「全民制作人」整体）出结果，
     *  旧实现调 store.snapshot() 拉全库再在 JS 里数 —— 公开端点 + 全表读，是个放大面。
     *  口径与游客视角一致：approved 且题目已收录且模型已收录。 */
    { method: "GET", path: "/api/contributors", role: null, handler: async (ctx) => {
        const [users, stats, legacy] = await Promise.all([
            listActiveContributors(ctx.env.DB),
            store.contributorStats(ctx.env.DB),
            store.legacyContributorStats(ctx.env.DB),
        ]);
        const byAuthor = new Map(stats.map((s) => [s.author, s]));
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
                problems: b?.problems ?? 0,
                models: b?.models ?? 0,
                lastDate: b?.lastDate ?? "",
            };
        });
        if (legacy.total > 0) {
            contributors.push({
                uid: null, username: "全民制作人", nickname: "", role: "legacy", joinedAt: "",
                contributions: legacy.total, problems: legacy.problems, models: legacy.models,
                lastDate: legacy.lastDate,
            });
        }
        return { contributors };
    } },

    { method: "POST", path: "/api/models", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const model = await store.createModel(ctx.env.DB, str(ctx.body?.name), str(ctx.body?.vendor), str(ctx.body?.note));
        await store.logAudit(ctx.env.DB, actor, "model.create", `收录模型 ${model.name}`);
        return { ok: true, model, revision: await currentRevision(ctx.env.DB) };
    } },

    { method: "PUT", path: "/api/models/:id", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const prev = (await store.listModels(ctx.env.DB)).find((m) => m.id === Number(ctx.params.id));
        const model = await store.updateModel(ctx.env.DB, Number(ctx.params.id),
            str(ctx.body?.name), str(ctx.body?.vendor), str(ctx.body?.note));
        if (prev && prev.name !== model.name) {
            await store.logAudit(ctx.env.DB, actor, "model.rename", `模型改名：${prev.name} → ${model.name}（历史记录随名迁移）`);
        }
        return { ok: true, model };
    } },

    { method: "DELETE", path: "/api/models/:id", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const id = Number(ctx.params.id);
        const model = (await store.listModels(ctx.env.DB)).find((m) => m.id === id);
        await store.deleteModel(ctx.env.DB, id);
        await store.logAudit(ctx.env.DB, actor, "model.delete", `模型 ${model?.name ?? "#" + id}`);
        return { ok: true };
    } },

    /** 用户列表：站长看全部；管理员只能看到已激活贡献者（删除贡献者的操作面） */
    { method: "GET", path: "/api/admin/users", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        let users = await listUsers(ctx.env.DB);
        if (!isAtLeast(ctx.user, "owner")) {
            users = users.filter((u) => u.role === "contributor" && u.status === "active");
        }
        return { users };
    } },

    { method: "POST", path: "/api/admin/users/:id/approve", role: "owner", handler: async (ctx) => {
        const owner = requireRole(ctx, "owner");
        await approveUser(ctx.env.DB, Number(ctx.params.id), owner.username);
        const target = await findById(ctx.env.DB, Number(ctx.params.id));
        await store.logAudit(ctx.env.DB, owner, "user.approve", `批准注册 ${target?.username ?? "#" + ctx.params.id}`);
        return { ok: true };
    } },

    { method: "POST", path: "/api/admin/users/:id/reject", role: "owner", handler: async (ctx) => {
        const owner = requireRole(ctx, "owner");
        await rejectUser(ctx.env.DB, Number(ctx.params.id));
        const target = await findById(ctx.env.DB, Number(ctx.params.id));
        await store.logAudit(ctx.env.DB, owner, "user.reject", `拒绝注册 ${target?.username ?? "#" + ctx.params.id}`);
        return { ok: true };
    } },

    { method: "POST", path: "/api/admin/users/:id/role", role: "owner", handler: async (ctx) => {
        const owner = requireRole(ctx, "owner");
        const target = await findById(ctx.env.DB, Number(ctx.params.id));
        const role = str(ctx.body?.role);
        await setRole(ctx.env.DB, Number(ctx.params.id), role);
        await store.logAudit(ctx.env.DB, owner, "user.role",
            `${target?.username ?? "#" + ctx.params.id} 角色 → ${role === "admin" ? "管理员" : "贡献者"}`);
        return { ok: true };
    } },

    /** 删除账号（物理删除）：管理员可删已激活贡献者，站长可删任意非站长账号（含待审/已拒）；测评记录保留 */
    { method: "DELETE", path: "/api/admin/users/:id", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const target = await deleteUser(ctx.env.DB, Number(ctx.params.id), actor);
        await store.logAudit(ctx.env.DB, actor, "user.delete",
            `删除账号 ${target.username}#${target.id}（${target.role}/${target.status}）`);
        return { ok: true };
    } },

    /** 敏感操作审计（新→旧，最近 100 条）：管理员及以上只读 */
    { method: "GET", path: "/api/admin/audit", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        return { entries: await store.listAudit(ctx.env.DB) };
    } },

    { method: "GET", path: "/api/luogu", role: "admin", handler: async (ctx) => {
        requireRole(ctx, "admin");
        const ip = clientIp(ctx.req);
        if (!(await burstLimit(ctx.env, ctx.env.WRITE_LIMIT, "luogu:" + ip, 30))
            || !tryAcquire("luogu:" + ip, 30, 60_000)) {
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
        const actor = requireRole(ctx, "admin");
        const model = str(ctx.body?.model);
        const moved = await store.purgeRecordsByModel(ctx.env.DB, model);
        await store.logAudit(ctx.env.DB, actor, "records.purgeModel", `模型「${model}」下 ${moved} 条隐藏记录移入回收站`);
        return { ok: true, moved, revision: await currentRevision(ctx.env.DB) };
    } },

    /** 一键清空收录目录（题目 + 模型）与全部记录：清库重建，重新开始收录 */
    { method: "POST", path: "/api/catalog/reset", role: "owner", handler: async (ctx) => {
        const owner = requireRole(ctx, "owner");
        await store.resetCatalog(ctx.env.DB);
        await store.logAudit(ctx.env.DB, owner, "catalog.reset", "清空收录目录与全部记录");
        return { ok: true, revision: await store.getRevision(ctx.env.DB) };
    } },

    /** 手动触发数据快照（与每日 Cron 同一实现）：快照本身要回结果给调用方，90 天过期清理丢给 waitUntil */
    { method: "POST", path: "/api/admin/snapshot", role: "owner", handler: async (ctx) => {
        const owner = requireRole(ctx, "owner");
        const bucket = ctx.env.SNAPSHOT_BUCKET;
        const r = await runSnapshot(ctx.env, new Date(), { cleanup: false });
        if (bucket) ctx.defer(cleanupExpired(bucket));
        await store.logAudit(ctx.env.DB, owner, "snapshot", `数据快照 ${r.key}`);
        return { ok: true, ...r };
    } },

    /** 批量补全题面（仅管理员）：为缺失题面/限制的旧题目重新抓取洛谷，每次最多 20 题；写审计 */
    { method: "POST", path: "/api/admin/backfill-content", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        if (!(await burstLimit(ctx.env, ctx.env.WRITE_LIMIT, "write:" + clientIp(ctx.req), 60))) {
            throw tooMany("操作过于频繁，请稍后再试");
        }
        const r = await store.backfillProblemContent(ctx.env.DB, 20);
        await store.logAudit(ctx.env.DB, actor, "problem.backfill", `补全题面 ${r.updated} 题（剩余 ${r.remaining}）`);
        return { ok: true, ...r };
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
        const actor = requireRole(ctx, "admin");
        const mode = str(ctx.body?.mode) || "merge";
        const data = ctx.body?.data && typeof ctx.body.data === "object" ? ctx.body.data : ctx.body;
        const r = await store.importBundle(ctx.env.DB, data, mode);
        // 被白名单丢弃的条数必须回显并留痕：旧实现静默少写，管理员以为导入完整
        const lost = r.invalid + r.duplicate;
        await store.logAudit(ctx.env.DB, actor, "import",
            `${mode} 模式导入 ${r.imported} 条记录（${r.statements} 条批量语句）` +
            (lost ? `；丢弃 ${r.invalid} 条不合法 + ${r.duplicate} 条重复 id` : ""));
        return { ok: true, ...r, revision: await currentRevision(ctx.env.DB) };
    } },

    // ---- 比赛（同一站点承载多个比赛；缺省比赛 = 农场对抗赛）----
    { method: "GET", path: "/api/competitions", role: null, handler: async (ctx) => {
        return { ok: true, competitions: await store.listCompetitions(ctx.env.DB) };
    } },

    { method: "POST", path: "/api/competitions", role: "owner", handler: async (ctx) => {
        const user = requireRole(ctx, "owner");
        const raw = ctx.body?.competition && typeof ctx.body.competition === "object" ? ctx.body.competition : ctx.body;
        const c = await store.addCompetition(ctx.env.DB, raw);
        await store.logAudit(ctx.env.DB, user, "competition_add", "新建比赛 " + c.slug + "（" + c.name + "）");
        return { ok: true, competition: c, message: "比赛已创建" };
    } },

    { method: "GET", path: "/api/competitions/:slug", role: null, handler: async (ctx) => {
        const c = await store.getCompetition(ctx.env.DB, ctx.params.slug);
        if (!c) throw new ApiError(404, "没找到这个比赛");
        const matches = await store.listArenaMatches(ctx.env.DB, 300, c.id);
        const replays = await store.listArenaReplays(ctx.env.DB, 200, c.id);
        return { ok: true, competition: c, matches, standings: store.arenaStandings(matches), replays };
    } },

    // ---- 农场对抗赛战绩（只登记谁和谁打、谁赢了、赢了多少）----
    { method: "GET", path: "/api/arena/matches", role: null, handler: async (ctx) => {
        const cid = await resolveCompetitionId(ctx, ctx.url.searchParams.get("competition"));
        const rows = await store.listArenaMatches(ctx.env.DB, 300, cid);
        return { ok: true, competitionId: cid, matches: rows, standings: store.arenaStandings(rows) };
    } },

    { method: "POST", path: "/api/arena/matches", role: "owner", handler: async (ctx) => {
        const user = requireRole(ctx, "owner");
        const raw = ctx.body?.match && typeof ctx.body.match === "object" ? ctx.body.match : ctx.body;
        const cid = await resolveCompetitionId(ctx, raw?.competition ?? ctx.body?.competition);
        const m = await store.addArenaMatch(ctx.env.DB, raw, { uid: user.uid, username: user.username }, cid);
        return { ok: true, match: m, message: "战绩已登记" };
    } },

    { method: "DELETE", path: "/api/arena/matches/:id", role: "admin", handler: async (ctx) => {
        const actor = requireRole(ctx, "admin");
        const removed = await store.deleteArenaMatch(ctx.env.DB, ctx.params.id);
        if (!removed) throw new ApiError(404, "没找到这条战绩（可能已被删除）");
        await store.logAudit(ctx.env.DB, actor, "arena_delete", "删除战绩 " + ctx.params.id);
        return { ok: true };
    } },

    // ---- 对抗赛回放（blob 存 R2，元数据存 D1；只有站长可写）----
    { method: "GET", path: "/api/arena/replays", role: null, handler: async (ctx) => {
        const cid = await resolveCompetitionId(ctx, ctx.url.searchParams.get("competition"));
        return { ok: true, competitionId: cid, replays: await store.listArenaReplays(ctx.env.DB, 200, cid) };
    } },

    { method: "POST", path: "/api/arena/replays", role: "owner", handler: async (ctx) => {
        const user = requireRole(ctx, "owner");
        const bucket = ctx.env.SNAPSHOT_BUCKET;
        if (!bucket) throw new ApiError(503, "回放存储（R2）未配置，暂时无法上传");
        const body = ctx.body?.replay && typeof ctx.body.replay === "object" ? ctx.body.replay : ctx.body;
        const cid = await resolveCompetitionId(ctx, body?.competition ?? ctx.body?.competition);
        const info = await store.addArenaReplay(ctx.env.DB, bucket, body, { uid: user.uid, username: user.username }, cid);
        await store.logAudit(ctx.env.DB, user, "arena_replay_add",
            "上传回放 " + info.id + "（" + Math.round(info.bytes / 1024) + " KB，种子 " + (info.seed ?? "-") + "）");
        return { ok: true, replay: info, message: "回放已上传" };
    } },

    { method: "GET", path: "/api/arena/replays/:id", role: null, handler: async (ctx) => {
        const meta = await store.getArenaReplay(ctx.env.DB, ctx.params.id);
        if (!meta) throw new ApiError(404, "没找到这份回放（可能已被删除）");
        const bucket = ctx.env.SNAPSHOT_BUCKET;
        if (!bucket) throw new ApiError(503, "回放存储（R2）未配置");
        const etag = "\"" + meta.sha256 + "\"";
        const cache = { ETag: etag, "Cache-Control": "public, max-age=31536000, immutable" };
        if (ctx.req.headers.get("If-None-Match") === etag) {
            return new Response(null, { status: 304, headers: cache });
        }
        const obj = await bucket.get(store.replayObjectKey(meta.id));
        if (!obj) throw new ApiError(404, "回放文件已不存在（可能已被清理）");
        return new Response(obj.body, {
            headers: { "Content-Type": "application/json; charset=utf-8", ...cache },
        });
    } },

    { method: "DELETE", path: "/api/arena/replays/:id", role: "owner", handler: async (ctx) => {
        const user = requireRole(ctx, "owner");
        const meta = await store.getArenaReplay(ctx.env.DB, ctx.params.id);
        if (!meta) throw new ApiError(404, "没找到这份回放（可能已被删除）");
        await store.deleteArenaReplay(ctx.env.DB, meta.id);
        const bucket = ctx.env.SNAPSHOT_BUCKET;
        if (bucket) await bucket.delete(store.replayObjectKey(meta.id));
        await store.logAudit(ctx.env.DB, user, "arena_replay_delete", "删除回放 " + meta.id);
        return { ok: true };
    } },
];

// ---------------------------------------------------------------- 入口

const BODY_LIMITS: Array<[string, number]> = [
    ["/api/import", 16 * 1024 * 1024],
    ["/api/records", 2 * 1024 * 1024],
    ["/api/arena/replays", 8 * 1024 * 1024],
];
const DEFAULT_BODY_LIMIT = 64 * 1024;

/** 非安全方法的统一入口守卫（在角色检查之后、handler 之前） */
export async function handleApi(req: Request, env: Env, waitUntil?: (task: Promise<unknown>) => void): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const baseHeaders: Record<string, string> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "same-origin",
        "X-Frame-Options": "DENY",
    };
    const rayId = req.headers.get("CF-Ray") || "";
    if (rayId) baseHeaders["X-Request-Id"] = rayId;

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
        // 回源协议可能是 http（Flexible SSL），Cookie 的 Secure 以客户端实际协议为准
        const proto = (req.headers.get("X-Forwarded-Proto") || "").split(",")[0].trim() || url.protocol.replace(":", "");
        const secure = proto === "https";
        if (!csrfCookieValue) cookies.push(csrfCookie(csrf, secure));

        const session = await verifyToken(env.DB, cookieValue(req, SESSION_COOKIE));
        const ctx: RouteCtx = {
            req, url, env, params: {}, user: session?.user ?? null, session,
            body: undefined, cookies, csrf, secure,
            // 审计写、R2 过期清理这类"不该拖住响应"的工作
            defer: (task) => {
                if (waitUntil) waitUntil(task.catch((e) => console.warn("[api] 后台任务失败：", e instanceof Error ? e.message : e)));
                else task.catch((e) => console.warn("[api] 内联任务失败：", e instanceof Error ? e.message : e));
            },
        };

        const matched = matchRoutes(method, url.pathname);
        if (matched === "method-mismatch") {
            return json({ error: "该接口不支持此方法" }, 405);
        }
        if (!matched) {
            return json({ error: "接口不存在" }, 404);
        }
        ctx.params = matched.params;

        // 请求体解析（带大小上限；按**字节**判定，中文正文用 string.length 会低估）
        if (!methodSafe) {
            const limit = BODY_LIMITS.find(([prefix]) => url.pathname.startsWith(prefix))?.[1] ?? DEFAULT_BODY_LIMIT;
            const len = Number(req.headers.get("Content-Length") || "0");
            if (len > limit) return json({ error: "请求体过大" }, 413);
            const text = await req.text();
            if (text && new TextEncoder().encode(text).length > limit) return json({ error: "请求体过大" }, 413);
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
        // 所有写操作统一过 WRITE_LIMIT（登录态按 uid 计），不再逐端点补
        if (!methodSafe) {
            await requireWriteBudget(ctx);
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
