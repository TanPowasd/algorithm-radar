/**
 * 认证：PBKDF2 口令哈希（WebCrypto）+ HMAC 签名会话令牌 + 用户表管理（D1）。
 * 哈希格式：pbkdf2_sha256$<iters>$<salt_b64url>$<hash_b64url>
 * 迭代次数取 100k：Workers 有 CPU 限额，原生 WebCrypto 下 100k 约几十毫秒，
 * 登录又有 6 次/10 分钟限流，安全性与平台约束的平衡点。
 */
import type { UserRow } from "./util";
import { ApiError, badRequest, forbidden, notFound, tooMany, unauthorized } from "./util";

export interface AuthUser {
    uid: number;
    /** 登录 ID（用户 ID） */
    username: string;
    /** 显示昵称（缺失时前端回退到 username） */
    nickname: string;
    role: string;
}

export interface SessionData {
    user: AuthUser;
    iat: number;
    exp: number;
}

export const SESSION_COOKIE = "radar_session";
export const CSRF_COOKIE = "radar_csrf";
export const CSRF_HEADER = "X-CSRF-Token";
const SESSION_TTL = 43200;       // 12h
const RENEW_AFTER = 3600;        // 签发 1h 后续签
const USERNAME_RE = /^[\w\u4e00-\u9fff-]{2,24}$/;
// 账号级登录失败锁定（渗透报告 medium-2 的跨 isolate 部分）：连续 5 次失败锁定 15 分钟。
// D1 计数可被并发请求竞态突破 1~2 次（尽力而为），并发高频爆破仍需 CF Rate Limiting / DO。
const MAX_LOGIN_FAILS = 5;
const LOGIN_LOCK_MINUTES = 15;

const enc = new TextEncoder();

function b64urlEncode(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
    const norm = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = norm.length % 4 ? "=".repeat(4 - (norm.length % 4)) : "";
    const bin = atob(norm + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function toHex(bytes: Uint8Array): string {
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function roleLevel(role: string | undefined | null): number {
    return role === "owner" ? 3 : role === "admin" ? 2 : role === "contributor" ? 1 : 0;
}

export function isAtLeast(user: AuthUser | null, role: string): boolean {
    return roleLevel(user?.role) >= roleLevel(role);
}

// ---------------------------------------------------------------- 口令哈希

async function pbkdf2(password: string, salt: Uint8Array, iters: number): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: iters },
        key, 256);
    return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const dk = await pbkdf2(password, salt, 100000);
    return `pbkdf2_sha256$100000$${b64urlEncode(salt)}$${b64urlEncode(dk)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = (stored || "").split("$");
    if (parts.length !== 4 || parts[0] !== "pbkdf2_sha256") return false;
    const iters = parseInt(parts[1], 10);
    if (!Number.isFinite(iters) || iters < 1000) return false;
    try {
        const salt = b64urlDecode(parts[2]);
        const expect = b64urlDecode(parts[3]);
        const actual = await pbkdf2(password, salt, iters);
        if (actual.length !== expect.length) return false;
        return crypto.subtle.timingSafeEqual
            ? crypto.subtle.timingSafeEqual(actual, expect)
            : actual.every((b, i) => b === expect[i]);
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------- 会话令牌

async function sessionSecret(db: D1Database): Promise<Uint8Array> {
    const row = await db.prepare("SELECT value FROM meta WHERE key = 'session_secret'").first<{ value: string }>();
    if (row?.value) {
        const hex = row.value;
        const out = new Uint8Array(hex.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
    }
    const secret = crypto.getRandomValues(new Uint8Array(32));
    await db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('session_secret', ?)")
        .bind(toHex(secret)).run();
    return secret;
}

export async function createToken(db: D1Database, user: AuthUser): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    // 密码版本以库内实时值为准（登录/续签/改密后签发的令牌都携带最新 pv）
    const pvRow = await db.prepare("SELECT password_version FROM users WHERE id = ?1")
        .bind(user.uid).first<{ password_version: number }>();
    const pv = Number(pvRow?.password_version ?? 0);
    const payload = {
        uid: user.uid, u: user.username, n: user.nickname ?? "", r: user.role,
        pv, iat: now, exp: now + SESSION_TTL,
    };
    const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
    const key = await crypto.subtle.importKey("raw", await sessionSecret(db) as BufferSource,
        { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
    return `${body}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyToken(db: D1Database, token: string | null | undefined): Promise<SessionData | null> {
    if (!token) return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    try {
        const bodyStr = token.slice(0, dot);
        const sig = b64urlDecode(token.slice(dot + 1));
        const secret = await sessionSecret(db);
        const key = await crypto.subtle.importKey("raw", secret as BufferSource,
            { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
        // 签名对象 = base64url 字符串本身的字节（与 createToken 的 enc.encode(body) 保持一致）
        const ok = await crypto.subtle.verify("HMAC", key, sig as BufferSource, enc.encode(bodyStr) as BufferSource);
        if (!ok) return null;
        const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(bodyStr)));
        if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
        // 会话状态回查用户表：改密（password_version+1）或封禁/降权后旧令牌立即失效，
        // 角色/昵称也以库内最新为准
        const row = await db
            .prepare("SELECT id, username, nickname, role, status, password_version FROM users WHERE id = ?1")
            .bind(Number(payload.uid))
            .first<any>();
        if (!row || row.status !== "active") return null;
        const tokenPv = payload.pv === undefined ? 0 : Number(payload.pv);
        if (tokenPv !== Number(row.password_version)) return null;
        return {
            user: {
                uid: row.id,
                username: row.username,
                nickname: row.nickname ?? "",
                role: row.role,
            },
            iat: Number(payload.iat) || 0,
            exp: payload.exp,
        };
    } catch {
        return null;
    }
}

export const sessionTtl = () => SESSION_TTL;
export const renewAfter = () => RENEW_AFTER;

/** 修改密码：校验旧密码 → 更新哈希并递增 password_version（其他设备会话立即失效） */
export async function changePassword(db: D1Database, uid: number, oldPassword: string, newPassword: string): Promise<void> {
    const user = await findById(db, uid);
    if (!user) throw unauthorized("请先登录");
    if (!(await verifyPassword(oldPassword, user.password_hash))) {
        throw badRequest("旧密码不正确");
    }
    if (!newPassword || newPassword.length < 8 || newPassword.length > 64) {
        throw badRequest("新密码长度需在 8–64 位之间");
    }
    await db.prepare("UPDATE users SET password_hash = ?1, password_version = password_version + 1 WHERE id = ?2")
        .bind(await hashPassword(newPassword), uid).run();
}

// ---------------------------------------------------------------- Cookie 工具

export function cookieValue(req: Request, name: string): string | null {
    const header = req.headers.get("Cookie");
    if (!header) return null;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq > 0 && part.slice(0, eq).trim() === name) {
            return part.slice(eq + 1).trim();
        }
    }
    return null;
}

export function sessionCookie(token: string, clear = false, secure = true): string {
    // Secure 仅在生产 HTTPS 下发；本地 http://127.0.0.1 开发环境不携带（否则 curl/浏览器拒绝存储）
    const attrs = `Path=/; HttpOnly${secure ? "; Secure" : ""}; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_TTL}`;
    return `${SESSION_COOKIE}=${token}; ${attrs}`;
}

export function csrfCookie(token: string, secure = true): string {
    return `${CSRF_COOKIE}=${token}; Path=/${secure ? "; Secure" : ""}; SameSite=Strict; Max-Age=${SESSION_TTL}`;
}

export function newCsrfToken(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return b64urlEncode(bytes);
}

export function constantTimeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    const ab = enc.encode(a), bb = enc.encode(b);
    let diff = 0;
    for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
    return diff === 0;
}

// ---------------------------------------------------------------- 用户管理

const USER_COLS = "id, username, nickname, password_hash, role, status, created_at, approved_at, approved_by";

function mapUser(row: any): UserRow {
    return row as UserRow;
}

export async function countUsers(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    return row?.n ?? 0;
}

export async function findByUsername(db: D1Database, username: string): Promise<UserRow | null> {
    const row = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE username = ?1 COLLATE NOCASE`)
        .bind(username).first();
    return row ? mapUser(row) : null;
}

export async function findById(db: D1Database, id: number): Promise<UserRow | null> {
    const row = await db.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?1`).bind(id).first();
    return row ? mapUser(row) : null;
}

export function validateUsernamePassword(userId: string, password: string) {
    if (!userId || !USERNAME_RE.test(userId)) {
        throw badRequest("用户 ID 需 2–24 位，仅限中英文、数字、下划线和连字符");
    }
    if (!password || password.length < 8 || password.length > 64) {
        throw badRequest("密码长度需在 8–64 位之间");
    }
}

export function validateNickname(nickname: string) {
    const n = (nickname || "").trim();
    if (!n || n.length > 24) {
        throw badRequest("昵称需 1–24 字");
    }
    return n;
}

/** 开放注册：用户 ID + 昵称 + 密码；创建「待站长审核」的贡献者账号 */
export async function registerUser(db: D1Database, userId: string, nickname: string, password: string): Promise<void> {
    validateUsernamePassword(userId, password);
    const nick = validateNickname(nickname);
    if (await findByUsername(db, userId)) throw badRequest("该用户 ID 已被使用");
    await db.prepare(
        "INSERT INTO users(username, nickname, password_hash, role, status, created_at) VALUES (?1, ?2, ?3, 'contributor', 'pending', ?4)")
        .bind(userId, nick, await hashPassword(password), new Date().toISOString()).run();
}

/** 站长初始化（仅用户表为空 + 本地回环或 SETUP_TOKEN 匹配时调用）。
 *  TOCTOU 修复（渗透报告 low-3）：单条 INSERT…SELECT WHERE NOT EXISTS 原子完成
 *  「查空 + 插入」；并发请求在 SQLite 中串行执行，只有第一个能写入（即使 username 不同），
 *  后续请求 changes=0 → 409，杜绝并发创建多个 owner。 */
export async function setupOwner(db: D1Database, userId: string, password: string, nickname?: string): Promise<UserRow> {
    validateUsernamePassword(userId, password);
    const nick = nickname ? validateNickname(nickname) : userId;
    const res = await db.prepare(
        "INSERT INTO users(username, nickname, password_hash, role, status, created_at) " +
        "SELECT ?1, ?2, ?3, 'owner', 'active', ?4 WHERE NOT EXISTS (SELECT 1 FROM users)")
        .bind(userId, nick, await hashPassword(password), new Date().toISOString()).run();
    if (!res.meta?.changes) {
        throw new ApiError(409, "站长账号已初始化，请直接登录");
    }
    const user = await findByUsername(db, userId);
    if (!user) throw new Error("setup failed");
    return user;
}

export async function authenticate(db: D1Database, userId: string, password: string): Promise<AuthUser> {
    // 登录前先查账号级锁定状态（按 username COLLATE NOCASE，与查询口径一致）
    const lockRow = await db.prepare(
        "SELECT fail_count, locked_until FROM login_guard WHERE username = ?1 COLLATE NOCASE")
        .bind(userId).first<{ fail_count: number; locked_until: string | null }>();
    const now = Date.now();
    if (lockRow && lockRow.locked_until && Date.parse(lockRow.locked_until) > now) {
        throw tooMany("失败次数过多，账号已临时锁定，请 15 分钟后再试");
    }
    const user = await findByUsername(db, userId);
    if (!user) throw unauthorized("用户 ID 或口令错误");
    if (!(await verifyPassword(password, user.password_hash))) {
        // 口令错误：累计失败次数，达到阈值锁定（跨 isolate 持久化）
        const fails = (lockRow?.fail_count ?? 0) + 1;
        if (fails >= MAX_LOGIN_FAILS) {
            await db.prepare(
                "INSERT INTO login_guard(username, fail_count, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4) " +
                "ON CONFLICT(username) DO UPDATE SET fail_count = ?2, locked_until = ?3, updated_at = ?4")
                .bind(user.username, fails, new Date(now + LOGIN_LOCK_MINUTES * 60_000).toISOString(), new Date().toISOString()).run();
        } else if (lockRow && lockRow.locked_until && Date.parse(lockRow.locked_until) <= now) {
            // 锁定期已过：重置计数并从 1 重新累计（否则窗口内只剩 MAX-1 次机会）
            await db.prepare(
                "INSERT INTO login_guard(username, fail_count, locked_until, updated_at) VALUES (?1, ?2, NULL, ?3) " +
                "ON CONFLICT(username) DO UPDATE SET fail_count = ?2, locked_until = NULL, updated_at = ?3")
                .bind(user.username, 1, new Date().toISOString()).run();
        } else {
            await db.prepare(
                "INSERT INTO login_guard(username, fail_count, locked_until, updated_at) VALUES (?1, ?2, NULL, ?3) " +
                "ON CONFLICT(username) DO UPDATE SET fail_count = ?2, locked_until = NULL, updated_at = ?3")
                .bind(user.username, fails, new Date().toISOString()).run();
        }
        throw unauthorized("用户 ID 或口令错误");
    }
    if (user.status === "pending") throw unauthorized("账号待站长审核，请稍后再试");
    if (user.status === "rejected") throw unauthorized("注册申请已被拒绝");
    // 登录成功：清除失败计数与锁定
    await db.prepare("DELETE FROM login_guard WHERE username = ?1").bind(user.username).run();
    return { uid: user.id, username: user.username, nickname: user.nickname ?? "", role: user.role };
}

export interface UserView {
    id: number; username: string; nickname: string; role: string; status: string;
    createdAt: string; approvedAt: string | null; approvedBy: string | null;
}

export async function listUsers(db: D1Database): Promise<UserView[]> {
    const { results } = await db.prepare(`SELECT ${USER_COLS} FROM users ORDER BY id`).all<any>();
    return (results || []).map((r) => ({
        id: r.id, username: r.username, nickname: r.nickname ?? "", role: r.role, status: r.status,
        createdAt: r.created_at, approvedAt: r.approved_at, approvedBy: r.approved_by,
    }));
}

/** 公开的贡献者名册：仅已激活账号的基础信息（贡献榜页面用） */
export async function listActiveContributors(db: D1Database): Promise<Array<{ id: number; username: string; nickname: string; role: string; joinedAt: string }>> {
    const { results } = await db
        .prepare("SELECT id, username, nickname, role, created_at FROM users WHERE status = 'active' ORDER BY created_at")
        .all<any>();
    return (results || []).map((r) => ({
        id: r.id, username: r.username, nickname: r.nickname ?? "", role: r.role, joinedAt: r.created_at,
    }));
}

async function requireUser(db: D1Database, id: number): Promise<UserRow> {
    const user = await findById(db, id);
    if (!user) throw notFound("用户不存在");
    return user;
}

/** 批准注册：账号激活为贡献者 */
export async function approveUser(db: D1Database, id: number, by: string): Promise<void> {
    const user = await requireUser(db, id);
    if (user.status !== "pending") throw badRequest("该账号不是待审核状态");
    await db.prepare("UPDATE users SET status = 'active', approved_at = ?1, approved_by = ?2 WHERE id = ?3")
        .bind(new Date().toISOString(), by, id).run();
}

export async function rejectUser(db: D1Database, id: number): Promise<void> {
    const user = await requireUser(db, id);
    if (user.status !== "pending") throw badRequest("该账号不是待审核状态");
    await db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?1").bind(id).run();
}

/** 站长任命/免除管理员（owner 账号不可被改动） */
export async function setRole(db: D1Database, id: number, role: string): Promise<void> {
    if (role !== "admin" && role !== "contributor") {
        throw badRequest("目标角色只能是 admin 或 contributor");
    }
    const user = await requireUser(db, id);
    if (user.role === "owner") throw forbidden("不能修改站长账号的角色");
    if (role === "admin" && user.status !== "active") throw badRequest("只能对已激活账号任命管理员");
    await db.prepare("UPDATE users SET role = ?1 WHERE id = ?2").bind(role, id).run();
}
