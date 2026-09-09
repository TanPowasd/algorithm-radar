/**
 * 服务端权威存储（D1/SQLite）：记录与题目的读写、审核流程、题目发布制、
 * revision 单调递增、导入导出、AI 模型目录。写操作走 db.batch（原子事务）。
 *
 * v3.4「收录制」口径：统计展示只纳入「题目已收录（problems 表）且模型已收录
 * （models 表）」的已审核记录；其余记录保留入库但一律隐藏（不含游客导出的公开数据，
 * 但含管理员全量导出）。旧数据由管理员重新收录题目/模型后逐步可见。
 */
import type { ProblemEntry, Rec, Sub } from "./util";
import {
    MAX_CATEGORIES, MAX_CATEGORY, MAX_MODEL, MAX_NOTE, MAX_PROBLEMS, MAX_RECORDS,
    MAX_SUBMISSIONS, MAX_TAGS, MAX_TITLE, MAX_VARIANT, MAX_AGENT, MAX_TOKEN_SOURCE,
    STATUSES, nowIso, sanitizeProblem, sanitizeRecord, badRequest, notFound, text,
    nameList, intOrNull, forbidden, ApiError,
} from "./util";
import { fetchLuoguProblem } from "./luogu";

export interface Snapshot {
    revision: number;
    /** 缓存分代：清库/覆盖导入等破坏性操作会换掉它，避免 revision 归零后撞上旧 ETag */
    epoch: string;
    updatedAt: string;
    records: Rec[];
    problems: Record<string, ProblemEntry>;
}

function mapRec(row: any): Rec {
    let categories: string[] = [];
    let submissions: Sub[] = [];
    try { categories = JSON.parse(row.categories || "[]"); } catch { /* 空值兜底 */ }
    try { submissions = JSON.parse(row.submissions || "[]"); } catch { /* 空值兜底 */ }
    return {
        id: row.id, model: row.model, variant: row.variant, agent: row.agent,
        tokenSource: row.token_source, pid: row.pid, title: row.title,
        thinking: row.thinking, difficulty: row.difficulty,
        categories, submissions,
        minutes: row.minutes ?? null, memory: row.memory ?? null,
        date: row.date, note: row.note, status: row.status, author: row.author,
        authorId: row.author_id ?? null,
        reviewerId: row.reviewer_id ?? null,
        reviewedAt: row.reviewed_at ?? null,
        deletedAt: row.deleted_at ?? null,
        createdAt: row.created_at, updatedAt: row.updated_at,
    };
}

function mapProblem(row: any): ProblemEntry {
    let tags: string[] = [];
    let categories: string[] = [];
    try { tags = JSON.parse(row.tags || "[]"); } catch { /* 空值兜底 */ }
    try { categories = JSON.parse(row.categories || "[]"); } catch { /* 空值兜底 */ }
    return {
        pid: row.pid, title: row.title, difficulty: row.difficulty ?? null,
        tags, categories, manual: Boolean(row.manual),
        prompt: row.prompt ?? "",
        content: row.content ?? "",
        timeLimit: row.time_limit ?? null,
        memoryLimit: row.memory_limit ?? null,
        hasAttachments: Boolean(row.has_attachments),
        fetchedAt: row.fetched_at ?? "",
    };
}

const recParams = (r: Rec): unknown[] => [
    r.id, r.model, r.variant, r.agent, r.tokenSource, r.pid, r.title, r.thinking,
    r.difficulty, JSON.stringify(r.categories), JSON.stringify(r.submissions),
    r.minutes, r.memory, r.date, r.note, r.status, r.author, r.authorId,
    r.reviewerId, r.reviewedAt, r.deletedAt, r.createdAt, r.updatedAt,
];

const insertRecStmt = (db: D1Database, r: Rec) => db.prepare(
    "INSERT INTO records(id, model, variant, agent, token_source, pid, title, thinking, difficulty, categories, submissions, minutes, memory, date, note, status, author, author_id, reviewer_id, reviewed_at, deleted_at, created_at, updated_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23)").bind(...recParams(r));

const updateRecStmt = (db: D1Database, r: Rec) => db.prepare(
    "UPDATE records SET model=?2, variant=?3, agent=?4, token_source=?5, pid=?6, title=?7, thinking=?8, " +
    "difficulty=?9, categories=?10, submissions=?11, minutes=?12, memory=?13, date=?14, note=?15, " +
    "status=?16, author=?17, author_id=?18, reviewer_id=?19, reviewed_at=?20, deleted_at=?21, created_at=?22, updated_at=?23 WHERE id=?1").bind(...recParams(r));

const saveProblemStmt = (db: D1Database, p: ProblemEntry) => db.prepare(
    "INSERT INTO problems(pid, title, difficulty, tags, categories, manual, prompt, content, time_limit, memory_limit, has_attachments, fetched_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12) " +
    "ON CONFLICT(pid) DO UPDATE SET title=excluded.title, difficulty=excluded.difficulty, tags=excluded.tags, " +
    "categories=excluded.categories, manual=excluded.manual, prompt=excluded.prompt, content=excluded.content, " +
    "time_limit=excluded.time_limit, memory_limit=excluded.memory_limit, has_attachments=excluded.has_attachments, " +
    "fetched_at=excluded.fetched_at")
    .bind(p.pid, p.title, p.difficulty, JSON.stringify(p.tags), JSON.stringify(p.categories),
        p.manual ? 1 : 0, p.prompt ?? "", p.content ?? "", p.timeLimit, p.memoryLimit,
        p.hasAttachments ? 1 : 0, p.fetchedAt);

/** updatedAt 的两条 meta 语句（INSERT OR IGNORE 兜底建行 + 写当前时间） */
const updatedAtStmts = (db: D1Database): D1PreparedStatement[] => [
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('updatedAt', '')"),
    db.prepare("UPDATE meta SET value = ?1 WHERE key = 'updatedAt'").bind(nowIso()),
];

const bumpMetaStmts = (db: D1Database): D1PreparedStatement[] => [
    db.prepare("INSERT INTO meta(key, value) VALUES ('revision', '1') " +
        "ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)"),
    ...updatedAtStmts(db),
];

/** 缓存分代令牌：破坏性操作（清空目录 / replace 覆盖导入）换一个新值 */
function newEpoch(): string {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

const bumpEpochStmt = (db: D1Database): D1PreparedStatement =>
    db.prepare("INSERT INTO meta(key, value) VALUES ('cache_epoch', ?1) ON CONFLICT(key) DO UPDATE SET value = ?1")
        .bind(newEpoch());

/** 廉价的条件请求判定用：只读 meta（1 条查询），不扫 records/problems。格式 = "<epoch>:<revision>" */
export async function readValidator(db: D1Database): Promise<string> {
    const { results } = await db
        .prepare("SELECT key, value FROM meta WHERE key IN ('revision', 'cache_epoch')")
        .all<{ key: string; value: string }>();
    const m = new Map((results || []).map((r) => [r.key, r.value]));
    return `${m.get("cache_epoch") || "0"}:${Number(m.get("revision") ?? 0) || 0}`;
}

export async function getRevision(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'").first<{ n: number }>();
    return row?.n ?? 0;
}

// ---------------------------------------------------------------- 快照

export interface SnapshotOpts {
    /** 记录可见性过滤：true=全量（管理员导出）；false=收录制可见（已审核且题目/模型均已收录） */
    all?: boolean;
}

/**
 * 可见记录：status=approved 且题目在 problems 目录、模型在 models 目录。
 * 收录制口径统一作用于前台/统计/公开导出/隐藏原因判断（单处实现）。
 */
export function isRecordVisible(r: Pick<Rec, "pid" | "model" | "status">, problems: Set<string>, models: Set<string>): boolean {
    return r.status === "approved" && problems.has(r.pid) && models.has(r.model);
}

export async function loadVisibleSets(db: D1Database): Promise<{ problems: Set<string>; models: Set<string> }> {
    const [probs, mods] = await Promise.all([
        db.prepare("SELECT pid FROM problems").all<{ pid: string }>(),
        db.prepare("SELECT name FROM models").all<{ name: string }>(),
    ]);
    const problems = new Set((probs.results || []).map((r) => r.pid));
    const models = new Set((mods.results || []).map((r) => r.name));
    return { problems, models };
}

export async function loadCatalog(db: D1Database): Promise<{ problemPids: string[]; modelNames: string[] }> {
    const visible = await loadVisibleSets(db);
    return { problemPids: [...visible.problems], modelNames: [...visible.models] };
}

export async function snapshot(db: D1Database, username: string | null, adminLike: boolean, opts: SnapshotOpts = {}): Promise<Snapshot> {
    // 查询范围：管理员=全部行（待审全部可见）；登录用户=已通过+自己的待审；游客=仅已通过
    let recStmt: D1PreparedStatement;
    if (adminLike) {
        recStmt = db.prepare("SELECT * FROM records WHERE deleted_at IS NULL ORDER BY created_at, id");
    } else if (username) {
        recStmt = db.prepare("SELECT * FROM records WHERE deleted_at IS NULL AND (status = 'approved' OR author = ?1) ORDER BY created_at, id").bind(username);
    } else {
        recStmt = db.prepare("SELECT * FROM records WHERE deleted_at IS NULL AND status = 'approved' ORDER BY created_at, id");
    }
    const full = opts.all === true;
    // meta 一次取回 revision + updatedAt；收录制需要模型目录（题目目录已随 probs 取回，不再重复查）
    const [recs, probs, meta, mods] = await Promise.all([
        recStmt.all<any>(),
        db.prepare("SELECT * FROM problems").all<any>(),
        db.prepare("SELECT key, value FROM meta WHERE key IN ('revision', 'updatedAt', 'cache_epoch')").all<{ key: string; value: string }>(),
        full ? Promise.resolve(null as D1Result<{ name: string }> | null)
            : db.prepare("SELECT name FROM models").all<{ name: string }>(),
    ]);
    const metaMap = new Map((meta.results || []).map((r) => [r.key, r.value]));
    const revision = Number(metaMap.get("revision") ?? 0) || 0;
    const epoch = metaMap.get("cache_epoch") || "0";
    const updatedAt = metaMap.get("updatedAt") ?? "";
    const problems: Record<string, ProblemEntry> = {};
    for (const row of probs.results || []) {
        const p = mapProblem(row);
        problems[p.pid] = p;
    }
    let records = (recs.results || []).map(mapRec);
    if (!full) {
        // 收录制过滤（只对 approved 生效）：pending 走审核流程可见性
        const pset = new Set(Object.keys(problems));
        const mset = new Set((mods?.results || []).map((r) => r.name));
        records = records.filter((r) => {
            if (r.status === "pending") {
                return adminLike || (username !== null && r.author === username);
            }
            return isRecordVisible(r, pset, mset);
        });
    }
    return { revision, epoch, updatedAt, records, problems };
}

/** 贡献者名册聚合：一条 SQL 出「每位 author 的记录数 / 覆盖题数 / 覆盖模型数 / 最近日期」，
 *  口径 = 收录制可见集合（approved + 题目已收录 + 模型已收录），与游客视角一致。 */
export interface AuthorStat { author: string; total: number; problems: number; models: number; lastDate: string }

/** 名册里的「全民制作人」条目：author 不在活跃用户表（历史导入 / 已删账号）的可见记录整体聚合。
 *  用子查询排除活跃用户，避免把用户名当绑定参数传（人数可能超 100 个参数上限）。 */
export interface LegacyStat { total: number; problems: number; models: number; lastDate: string }

export async function legacyContributorStats(db: D1Database): Promise<LegacyStat> {
    const row = await db.prepare(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT r.pid) AS problems, COUNT(DISTINCT r.model) AS models," +
        " MAX(r.date) AS lastDate" +
        " FROM records r JOIN problems p ON p.pid = r.pid JOIN models m ON m.name = r.model" +
        " WHERE r.status = 'approved' AND r.deleted_at IS NULL" +
        " AND COALESCE(NULLIF(r.author, ''), '—') NOT IN (SELECT username FROM users WHERE status = 'active')")
        .first<any>();
    return {
        total: Number(row?.total) || 0,
        problems: Number(row?.problems) || 0,
        models: Number(row?.models) || 0,
        lastDate: String(row?.lastDate ?? ""),
    };
}

export async function contributorStats(db: D1Database): Promise<AuthorStat[]> {
    const { results } = await db.prepare(
        "SELECT COALESCE(NULLIF(r.author, ''), '—') AS author," +
        " COUNT(*) AS total, COUNT(DISTINCT r.pid) AS problems," +
        " COUNT(DISTINCT r.model) AS models, MAX(r.date) AS lastDate" +
        " FROM records r JOIN problems p ON p.pid = r.pid JOIN models m ON m.name = r.model" +
        " WHERE r.status = 'approved' AND r.deleted_at IS NULL" +
        " GROUP BY author",
    ).all<any>();
    return (results || []).map((r) => ({
        author: String(r.author ?? "—"),
        total: Number(r.total) || 0,
        problems: Number(r.problems) || 0,
        models: Number(r.models) || 0,
        lastDate: String(r.lastDate ?? ""),
    }));
}

// ---------------------------------------------------------------- 记录操作

async function requirePublished(db: D1Database, pid: string) {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM problems WHERE pid = ?1").bind(pid).first<{ n: number }>();
    if (!row || row.n === 0) {
        throw badRequest(`题目 ${pid} 尚未发布：请让管理员先在「发布新题」中发布该题，再提交测试`);
    }
}

async function findProblem(db: D1Database, pid: string): Promise<ProblemEntry | null> {
    const row = await db.prepare("SELECT * FROM problems WHERE pid = ?1").bind(pid).first();
    return row ? mapProblem(row) : null;
}

/** 保存记录时把题目信息并入已发布条目（不新建条目：题目目录由管理员发布维护）。
 *  P1 安全修复（渗透报告 medium-1）：只有管理员提交/编辑记录时才允许把记录里的
 *  title/difficulty 写回目录（收录/改错场景）；贡献者提交一律以目录权威值为准，
 *  记录为 pending 也不得污染目录（调用点在非管理员路径下不执行 saveProblem）。
 *  推荐提示词永远不被记录保存改动（由管理员发布/编辑端点维护）。 */
async function mergeProblemFromRecord(prev: ProblemEntry | null, rec: Rec, raw: any): Promise<ProblemEntry> {
    const src = raw && typeof raw === "object" ? raw.problem : null;
    const srcTags = src && typeof src === "object" ? src.tags : undefined;
    return {
        pid: rec.pid,
        title: rec.title || prev?.title || "",
        difficulty: rec.difficulty ?? prev?.difficulty ?? null,
        tags: Array.isArray(srcTags) && srcTags.length ? nameList(srcTags, MAX_TAGS, MAX_CATEGORY, "标签") : (prev?.tags ?? []),
        categories: rec.categories.length ? rec.categories : (prev?.categories ?? []),
        manual: Boolean(prev?.manual),
        // 推荐提示词与题面/限制/附件标记永远不被记录保存改动（由管理员发布/编辑端点维护）
        prompt: prev?.prompt || "",
        content: prev?.content ?? "",
        timeLimit: prev?.timeLimit ?? null,
        memoryLimit: prev?.memoryLimit ?? null,
        hasAttachments: Boolean(prev?.hasAttachments),
        fetchedAt: prev?.fetchedAt || (src && typeof src === "object" ? String(src.fetchedAt ?? "") : ""),
    };
}

/** 题目信息单一来源（服务端权威）：以目录值覆盖记录里的题名/难度；
 *  目录没有难度时保留提交者所选（README 里明示的例外）。 */
function applyCatalogTruth(rec: Rec, problem: ProblemEntry): void {
    if (problem.title) rec.title = problem.title;
    if (problem.difficulty !== null && problem.difficulty !== undefined) rec.difficulty = problem.difficulty;
}

export interface AddRecordResult { rec: Rec; revision: number }

async function requirePublishedModel(db: D1Database, model: string) {
    const row = await db.prepare("SELECT id FROM models WHERE name = ?1").bind(model).first();
    if (!row) {
        throw badRequest(`模型 ${model} 尚未收录：请让管理员先在「AI 模型管理」中添加该模型，再提交测试`);
    }
}

export async function addRecord(db: D1Database, raw: any, user: { uid: number; username: string; isAdminLike: boolean }): Promise<AddRecordResult> {
    const status = user.isAdminLike ? "approved" : "pending";
    const rec = sanitizeRecord(raw, null, status);
    rec.author = user.username;
    rec.authorId = user.uid; // 提供者 id
    if (user.isAdminLike) {
        // 管理员/站长直接提交即通过：自己即为审核人
        rec.reviewerId = user.uid;
        rec.reviewedAt = nowIso();
    }
    const countRow = await db.prepare("SELECT COUNT(*) AS n FROM records WHERE deleted_at IS NULL").first<{ n: number }>();
    if ((countRow?.n ?? 0) >= MAX_RECORDS) throw badRequest(`记录数量已达上限（${MAX_RECORDS}）`);
    await requirePublished(db, rec.pid);
    await requirePublishedModel(db, rec.model);
    const prev = await findProblem(db, rec.pid);
    // 题目信息单一来源（服务端权威）：非管理员提交的题名/难度一律以目录为准，
    // 只有目录里确实没有难度时才保留提交者选的值。UI 锁不是安全边界，这里兜住。
    if (!user.isAdminLike && prev) applyCatalogTruth(rec, prev);
    // 越权修复（medium-1）：只有管理员可把记录里的题目信息写回目录（收录/改错场景）；
    // 贡献者提交时 problems 表必须有该题（requirePublished 已强制），故 prev 必存在，
    // merged 一律以目录权威值为准，且不执行 saveProblem（避免 pending 记录污染目录）。
    const stmts: D1PreparedStatement[] = [insertRecStmt(db, rec)];
    if (user.isAdminLike) {
        const merged = await mergeProblemFromRecord(prev, rec, raw);
        if (prev) stmts.push(saveProblemStmt(db, merged));
    }
    stmts.push(...bumpMetaStmts(db));
    await db.batch(stmts);
    return { rec, revision: await getRevision(db) };
}

export interface UpdateUserCtx {
    uid: number;
    username: string;
    isAdminLike: boolean;
    /** 乐观并发基线（客户端读到的 updatedAt）；不匹配 → 409，避免两个管理员互相静默覆盖 */
    baseUpdatedAt?: string | null;
}

export async function updateRecord(
    db: D1Database,
    rid: string,
    raw: any,
    userOrAdminLike: UpdateUserCtx | boolean = false,
): Promise<AddRecordResult> {
    const isAdminLike = typeof userOrAdminLike === "object" ? userOrAdminLike.isAdminLike : Boolean(userOrAdminLike);
    const baseUpdatedAt = typeof userOrAdminLike === "object" ? (userOrAdminLike.baseUpdatedAt ?? null) : null;
    const row = await db.prepare("SELECT * FROM records WHERE id = ?1 AND deleted_at IS NULL").bind(rid).first();
    if (!row) throw notFound("记录不存在（可能已在回收站）");
    const existing = mapRec(row);
    // 乐观并发：调用方带了读取时看到的 updatedAt 基线，与他人已写入的新值不符 → 409（而不是静默覆盖）
    if (baseUpdatedAt && baseUpdatedAt !== existing.updatedAt) {
        throw new ApiError(409, "该记录已被他人更新，请刷新后重试");
    }

    // 鉴权校验：非管理员只能修改自己提交的记录。
    // 归属只认 author_id（数值主键）——author 是用户名字符串快照，账号被删后用户名会被释放重新注册，
    // 用字符串兜底等于允许同名新账号认领他人历史记录。author_id 为 null 的历史数据只有管理员能改。
    if (!isAdminLike) {
        if (typeof userOrAdminLike !== "object") {
            throw forbidden("权限不足，无法修改此记录");
        }
        const isOwner = existing.authorId !== null && existing.authorId === userOrAdminLike.uid;
        if (!isOwner) {
            throw forbidden("只能修改自己提交的记录（历史导入数据由管理员维护）");
        }
    }

    // 贡献者修改后强制退回 pending，重新等待管理员审核；管理员修改保持原审核状态
    const targetStatus = isAdminLike ? existing.status : "pending";
    const rec = sanitizeRecord(raw, existing, targetStatus);
    if (!isAdminLike) {
        rec.status = "pending";
        rec.reviewerId = null;
        rec.reviewedAt = null;
    }
    rec.author = existing.author;
    rec.authorId = existing.authorId;
    rec.updatedAt = nowIso();

    await requirePublished(db, rec.pid);
    await requirePublishedModel(db, rec.model);
    const prev = await findProblem(db, rec.pid);
    if (!isAdminLike && prev) applyCatalogTruth(rec, prev); // 同 addRecord：目录权威
    const stmts: D1PreparedStatement[] = [updateRecStmt(db, rec)];
    if (prev && isAdminLike) {
        const merged = await mergeProblemFromRecord(prev, rec, raw);
        stmts.push(saveProblemStmt(db, merged));
    }
    stmts.push(...bumpMetaStmts(db));
    await db.batch(stmts);
    return { rec, revision: await getRevision(db) };
}

/** 软删除：记录移入回收站（deleted_at 置时间），不物理删除。id 不存在/已在回收站 → 404 */
export async function deleteRecord(db: D1Database, rid: string): Promise<number> {
    const res = await db.batch([
        db.prepare("UPDATE records SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL")
            .bind(nowIso(), nowIso(), rid),
        ...bumpMetaStmts(db),
    ]);
    if (!(res[0]?.meta?.changes ?? 0)) throw notFound("记录不存在（或已在回收站）");
    return getRevision(db);
}

export async function setStatus(db: D1Database, rid: string, status: string, reviewerUid: number): Promise<Rec> {
    if (!(STATUSES as readonly string[]).includes(status)) throw badRequest("状态不合法");
    const row = await db.prepare("SELECT * FROM records WHERE id = ?1 AND deleted_at IS NULL").bind(rid).first();
    if (!row) throw notFound("记录不存在");
    // 批准时记录审核人 id 与时间；退回待审则清空审核信息
    const reviewer = status === "approved" ? reviewerUid : null;
    const reviewedAt = status === "approved" ? nowIso() : null;
    await db.batch([
        db.prepare("UPDATE records SET status = ?1, reviewer_id = ?2, reviewed_at = ?3, updated_at = ?4 WHERE id = ?5")
            .bind(status, reviewer, reviewedAt, nowIso(), rid),
        ...bumpMetaStmts(db),
    ]);
    const updated = await db.prepare("SELECT * FROM records WHERE id = ?1").bind(rid).first();
    return mapRec(updated);
}

/** 批量审核：approve 置为通过（记录审核人）；reject 移入回收站（软删除）。返回实际影响条数。
 *  按 IN(…) 分块，每块 1 条语句（≤94 个绑定参数），不再「一个 id 一条语句」。 */
export async function bulkStatus(db: D1Database, ids: string[], action: string, reviewerUid: number): Promise<number> {
    let approve: boolean;
    if (action === "approve") approve = true;
    else if (action === "reject") approve = false;
    else throw badRequest("action 只能是 approve 或 reject");
    const uniq = [...new Set(ids.filter((s) => typeof s === "string" && s))];
    if (uniq.length > MAX_RECORDS) throw badRequest("批量数量超出上限");
    const ts = nowIso();
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < uniq.length; i += IN_CHUNK) {
        const chunk = uniq.slice(i, i + IN_CHUNK);
        const ph = chunk.map((_, k) => `?${k + (approve ? 4 : 3)}`).join(",");
        stmts.push(approve
            ? db.prepare(`UPDATE records SET status = 'approved', reviewer_id = ?1, reviewed_at = ?2, updated_at = ?3` +
                ` WHERE id IN (${ph}) AND status != 'approved' AND deleted_at IS NULL`)
                .bind(reviewerUid, ts, ts, ...chunk)
            : db.prepare(`UPDATE records SET deleted_at = ?1, updated_at = ?2 WHERE id IN (${ph}) AND deleted_at IS NULL`)
                .bind(ts, ts, ...chunk));
    }
    return runBulk(db, stmts, bumpMetaStmts(db));
}

// ---------------------------------------------------------------- 题目操作

/** 题目合并（发布口）：布尔标记按**三态**处理——「未提供 → 保留目录旧值」「显式提供（含 false）→ 覆盖」。
 *  旧实现是 `clean.x || prev.x`，一旦 hasAttachments 被置真就再也清不掉（全站永久弹附件提醒）。
 *  文本/可空字段沿用「新值非空才覆盖」的既有口径（README 明示：再次发布同题号用于补提示词/题面，不做清空）。 */
function mergeProblem(prev: ProblemEntry | null, clean: ProblemEntry, provided: Set<string>): ProblemEntry {
    /** 三态：请求里没这个 key → 保留目录旧值；给了（哪怕是 false）→ 以请求为准 */
    const bool = (key: "manual" | "hasAttachments"): boolean =>
        (provided.has(key) ? Boolean(clean[key]) : Boolean(prev?.[key]));
    return {
        pid: clean.pid,
        title: clean.title || prev?.title || "",
        difficulty: clean.difficulty ?? prev?.difficulty ?? null,
        tags: clean.tags.length ? clean.tags : (prev?.tags ?? []),
        categories: clean.categories.length ? clean.categories : (prev?.categories ?? []),
        manual: bool("manual"),
        prompt: clean.prompt || prev?.prompt || "",
        content: clean.content || prev?.content || "",
        timeLimit: clean.timeLimit ?? prev?.timeLimit ?? null,
        memoryLimit: clean.memoryLimit ?? prev?.memoryLimit ?? null,
        hasAttachments: bool("hasAttachments"),
        fetchedAt: clean.fetchedAt || prev?.fetchedAt || "",
    };
}

export async function putProblem(db: D1Database, pid: string, info: any): Promise<ProblemEntry> {
    const clean = sanitizeProblem(pid, info);
    if (!clean) throw badRequest("题号格式不正确");
    const prev = await findProblem(db, clean.pid);
    if (!prev) {
        const row = await db.prepare("SELECT COUNT(*) AS n FROM problems").first<{ n: number }>();
        if ((row?.n ?? 0) >= MAX_PROBLEMS) throw badRequest("题目缓存已达上限");
    }
    const provided = new Set(info && typeof info === "object" ? Object.keys(info) : []);
    const merged = mergeProblem(prev, clean, provided);
    await db.batch([saveProblemStmt(db, merged), ...bumpMetaStmts(db)]);
    return merged;
}

export async function deleteProblem(db: D1Database, pid: string): Promise<number> {
    const key = String(pid ?? "").trim().toUpperCase();
    if (!(await findProblem(db, key))) throw badRequest(`题目 ${key} 不存在（可能已被删除）`);
    // 只移出目录：该题下的记录保留入库、暂时隐藏（可在「历史数据收录」中重新收录该题找回）
    await db.batch([db.prepare("DELETE FROM problems WHERE pid = ?1").bind(key), ...bumpMetaStmts(db)]);
    return getRevision(db);
}

/** 编辑题目：全量覆盖式（区别于发布 upsert——编辑允许清空 tags/prompt）。
 *  题号不可改；categories 由发布/抓取维护，编辑不改动。 */
export async function updateProblem(db: D1Database, pid: string, info: any): Promise<ProblemEntry> {
    const key = String(pid ?? "").trim().toUpperCase();
    const prev = await findProblem(db, key);
    if (!prev) throw notFound(`题目 ${key} 不存在（可能已被移除）`);
    const clean = sanitizeProblem(key, info);
    if (!clean) throw badRequest("题目信息格式不正确");
    if (!clean.title) throw badRequest("题名不能为空");
    const merged: ProblemEntry = {
        pid: clean.pid,
        title: clean.title,
        difficulty: clean.difficulty ?? prev.difficulty,
        tags: clean.tags, // 编辑全量覆盖（可清空）
        categories: prev.categories,
        manual: clean.manual || Boolean(prev.manual),
        prompt: clean.prompt, // 编辑全量覆盖（留空即清空推荐提示词）
        content: clean.content, // 编辑全量覆盖（留空即清空题面）
        timeLimit: clean.timeLimit,
        memoryLimit: clean.memoryLimit,
        hasAttachments: clean.hasAttachments,
        fetchedAt: clean.fetchedAt || prev.fetchedAt,
    };
    await db.batch([saveProblemStmt(db, merged), ...bumpMetaStmts(db)]);
    return merged;
}

/** 批量补全题面（v3.11）：为缺失题面/限制的已发布题目重新抓取洛谷。
 *  每次最多 limit 题（Workers 请求时长 + 洛谷风控双约束），失败的题号原样返回、
 *  计入 remaining，管理员再次点击即可续跑。只补 content/限制/附件标记，不碰管理员改过的标题/标签。 */
export async function backfillProblemContent(
    db: D1Database,
    limit = 20,
): Promise<{ updated: number; remaining: number; failed: string[] }> {
    const { results } = await db.prepare(
        // 缺题面/限制，或题面里还没有「输入输出样例」节（v3.11 早期抓取的旧数据）都算待补；
        // 本身就没有样例的题会被每次重复抓取（有 20 题/次的批量上限，浪费可接受）
        "SELECT pid FROM problems WHERE content = '' OR time_limit IS NULL OR memory_limit IS NULL " +
        "OR content NOT LIKE '%输入样例%' ORDER BY pid",
    ).all<{ pid: string }>();
    const missing = results || [];
    if (!missing.length) return { updated: 0, remaining: 0, failed: [] };
    const targets = missing.slice(0, limit);
    const failed: string[] = [];
    let updated = 0;
    for (const { pid } of targets) {
        try {
            const f = await fetchLuoguProblem(pid);
            await db.prepare(
                "UPDATE problems SET content = ?2, time_limit = ?3, memory_limit = ?4, has_attachments = ?5, fetched_at = ?6 WHERE pid = ?1",
            ).bind(pid, f.content, f.timeLimit, f.memoryLimit, f.hasAttachments ? 1 : 0, f.fetchedAt).run();
            updated += 1;
        } catch {
            failed.push(pid);
        }
    }
    if (updated) await db.batch(bumpMetaStmts(db));
    return { updated, remaining: missing.length - targets.length + failed.length, failed };
}

// ---------------------------------------------------------------- AI 模型目录（收录制下即“已收录模型”）
export interface ModelView { id: number; name: string; vendor: string; note: string; createdAt: string }

export async function listModels(db: D1Database): Promise<ModelView[]> {
    const { results } = await db
        .prepare("SELECT id, name, vendor, note, created_at FROM models ORDER BY name COLLATE NOCASE")
        .all<any>();
    return (results || []).map((r) => ({
        id: r.id, name: r.name, vendor: r.vendor ?? "", note: r.note ?? "", createdAt: r.created_at,
    }));
}

function checkModelFields(name: string, vendor: string, note: string) {
    if (!name || name.length > MAX_MODEL) throw badRequest(`模型名需 1–${MAX_MODEL} 字`);
    if (vendor.length > MAX_MODEL) throw badRequest("厂商名过长");
    if (note.length > 300) throw badRequest("备注过长（上限 300 字）");
}

/** 新建/改名一律重写相关记录：目录只负责“收录”，历史记录不因改名丢失 */
export function renameRecordsModel(db: D1Database, from: string, to: string): D1PreparedStatement {
    return db.prepare("UPDATE records SET model = ?1, updated_at = ?2 WHERE model = ?3")
        .bind(to, nowIso(), from);
}

export async function createModel(db: D1Database, name: string, vendor: string, note: string): Promise<ModelView> {
    name = (name || "").trim(); vendor = (vendor || "").trim(); note = (note || "").trim();
    checkModelFields(name, vendor, note);
    const dup = await db.prepare("SELECT id FROM models WHERE name = ?1").bind(name).first();
    if (dup) throw badRequest(`模型 ${name} 已存在`);
    // 只登记目录：库中同名历史记录（如有）即刻满足“模型已收录”，无需改记录
    // 收录改变可见记录集 → 推进 revision/updatedAt
    await db.batch([
        db.prepare("INSERT INTO models(name, vendor, note, created_at) VALUES (?1, ?2, ?3, ?4)")
            .bind(name, vendor, note, new Date().toISOString()),
        ...bumpMetaStmts(db),
    ]);
    const row = await db.prepare("SELECT id, name, vendor, note, created_at FROM models WHERE name = ?1").bind(name).first<any>();
    return { id: row.id, name: row.name, vendor: row.vendor ?? "", note: row.note ?? "", createdAt: row.created_at };
}

async function findModelById(db: D1Database, id: number): Promise<ModelView | null> {
    const row = await db.prepare("SELECT id, name, vendor, note, created_at FROM models WHERE id = ?1").bind(id).first<any>();
    return row ? { id: row.id, name: row.name, vendor: row.vendor ?? "", note: row.note ?? "", createdAt: row.created_at } : null;
}

export async function updateModel(db: D1Database, id: number, name: string, vendor: string, note: string): Promise<ModelView> {
    const prev = await findModelById(db, id);
    if (!prev) throw notFound("模型不存在");
    name = (name || "").trim(); vendor = (vendor || "").trim(); note = (note || "").trim();
    checkModelFields(name, vendor, note);
    if (name !== prev.name) {
        const dup = await db.prepare("SELECT id FROM models WHERE name = ?1").bind(name).first();
        if (dup) throw badRequest(`模型 ${name} 已存在`);
        // 改名 = 换一个“收录名”，历史记录跟着改（数据跟随新名，可见性不受影响）
        await db.batch([
            db.prepare("UPDATE models SET name = ?1, vendor = ?2, note = ?3 WHERE id = ?4").bind(name, vendor, note, id),
            renameRecordsModel(db, prev.name, name),
            ...bumpMetaStmts(db),
        ]);
        return (await findModelById(db, id))!;
    }
    // 仅改厂商/备注：可见记录集不变，仍推进 updatedAt（展示层“最近更新”语义）
    await db.batch([
        db.prepare("UPDATE models SET name = ?1, vendor = ?2, note = ?3 WHERE id = ?4").bind(name, vendor, note, id),
        ...bumpMetaStmts(db),
    ]);
    return (await findModelById(db, id))!;
}

export async function deleteModel(db: D1Database, id: number): Promise<void> {
    const prev = await findModelById(db, id);
    if (!prev) throw notFound("模型不存在");
    // 不删 records —— 仅目录移除后，相关记录回到“隐藏（模型未收录）”，数据保留。
    // 移除改变可见记录集 → 推进 revision/updatedAt
    await db.batch([
        db.prepare("DELETE FROM models WHERE id = ?1").bind(id),
        ...bumpMetaStmts(db),
    ]);
}

/** 隐藏记录分组查询：approved 记录中 pid/model 未进目录的分组计数与样本（收录管理页用）
 *  problems/models 分组按各自维度聚合（同一记录可能双计），total 为去重后的隐藏记录数。 */
export interface HiddenGroup { key: string; kind: "problem" | "model"; name: string; count: number; sample: string }

export async function listHiddenGroups(db: D1Database): Promise<{ problems: HiddenGroup[]; models: HiddenGroup[]; total: number }> {
    const [recs, sets] = await Promise.all([
        db.prepare("SELECT pid, title, model, date, author FROM records WHERE status = 'approved' AND deleted_at IS NULL").all<any>(),
        loadVisibleSets(db),
    ]);
    const probSet = sets.problems;
    const modelSet = sets.models;
    const pCount = new Map<string, number>();
    const mCount = new Map<string, number>();
    const pSample = new Map<string, string>();
    const mSample = new Map<string, string>();
    let total = 0;
    for (const r of recs.results || []) {
        const missingP = !probSet.has(r.pid);
        const missingM = !modelSet.has(r.model);
        if (!missingP && !missingM) continue;
        total += 1;
        if (missingP) {
            pCount.set(r.pid, (pCount.get(r.pid) || 0) + 1);
            if (!pSample.has(r.pid)) pSample.set(r.pid, `${r.title || r.pid} · ${r.model} · ${r.date}`);
        }
        if (missingM) {
            mCount.set(r.model, (mCount.get(r.model) || 0) + 1);
            if (!mSample.has(r.model)) mSample.set(r.model, `${r.pid} · ${r.date}`);
        }
    }
    const problems: HiddenGroup[] = [...pCount.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([pid, n]) => ({ key: "p:" + pid, kind: "problem", name: pid, count: n, sample: pSample.get(pid) || "" }));
    const models: HiddenGroup[] = [...mCount.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, n]) => ({ key: "m:" + name, kind: "model", name, count: n, sample: mSample.get(name) || "" }));
    return { problems, models, total };
}

// ---------------------------------------------------------------- 批量写入预算（见 docs/BACKEND_REVIEW.md 第七节口径出处）
//
// D1 的限制不是「每批多少条语句」，而是：
//   · 每次 Worker 调用最多 50（免费档）/ 1000（付费档）条查询
//   · 每条语句最多 100 个绑定参数、SQL 文本 ≤ 100KB
//   · batch 整体受 30 秒查询时长限制
// 所以「一条记录一条语句」的写法在任何批量场景都会撞墙。统一改用
// `INSERT … SELECT … FROM json_each(?1)`：一条语句 + 一个绑定参数写任意多行。
/** 单条 json_each 批量语句的**字节**预算（不是字符数！中文 1 字符 = 3 字节）。
 *  D1 限制：单个字符串值 ≤ 2,000,000 字节 → 这里取 400KB，留出转义与 UTF-8 膨胀余量，
 *  同时让每批 D1 请求体保持在合理大小（20000 条约 40 条语句 / 2 批）。 */
const BULK_JSON_BUDGET_BYTES = 400_000;
/** 每批语句数（给 meta bump 留余量，并让免费档 50 条/调用够用） */
const BATCH_STATEMENTS = 20;
/** 每批最多带 bumpMetaStmts 的语句数（3 条） */
const META_STMTS = 3;
/** IN (…), 一次能带的 id 数（100 绑定参数上限，留 6 个余量） */
const IN_CHUNK = 94;

const REC_COLUMNS = "id, model, variant, agent, token_source, pid, title, thinking, difficulty, categories," +
    " submissions, minutes, memory, date, note, status, author, author_id, reviewer_id, reviewed_at," +
    " deleted_at, created_at, updated_at";

/** Rec → 与列顺序一一对应的 JSON 值（键名用 API 字段名，SQL 里按列取） */
function recToJsonValue(r: Rec): Record<string, unknown> {
    return {
        id: r.id, model: r.model, variant: r.variant, agent: r.agent, tokenSource: r.tokenSource,
        pid: r.pid, title: r.title, thinking: r.thinking, difficulty: r.difficulty,
        categories: JSON.stringify(r.categories ?? []), submissions: JSON.stringify(r.submissions ?? []),
        minutes: r.minutes, memory: r.memory, date: r.date, note: r.note, status: r.status,
        author: r.author, authorId: r.authorId, reviewerId: r.reviewerId, reviewedAt: r.reviewedAt,
        deletedAt: r.deletedAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    };
}

// 末尾的 `WHERE true` 不是冗余：SQLite 规定「INSERT … SELECT + upsert-clause」里 SELECT 必须带 WHERE，
// 否则解析器无法判断 ON 是 SELECT 的 join 条件还是 upsert 的 ON CONFLICT（sqlite.org/lang_insert.html）。
const recJsonSelect = "SELECT json_extract(j.value,'$.id'), json_extract(j.value,'$.model')," +
    " json_extract(j.value,'$.variant'), json_extract(j.value,'$.agent'), json_extract(j.value,'$.tokenSource')," +
    " json_extract(j.value,'$.pid'), json_extract(j.value,'$.title'), json_extract(j.value,'$.thinking')," +
    " json_extract(j.value,'$.difficulty'), json_extract(j.value,'$.categories'), json_extract(j.value,'$.submissions')," +
    " json_extract(j.value,'$.minutes'), json_extract(j.value,'$.memory'), json_extract(j.value,'$.date')," +
    " json_extract(j.value,'$.note'), json_extract(j.value,'$.status'), json_extract(j.value,'$.author')," +
    " json_extract(j.value,'$.authorId'), json_extract(j.value,'$.reviewerId'), json_extract(j.value,'$.reviewedAt')," +
    " json_extract(j.value,'$.deletedAt'), json_extract(j.value,'$.createdAt'), json_extract(j.value,'$.updatedAt')" +
    " FROM json_each(?1) AS j WHERE true";

/** 批量插入（纯 INSERT，id 冲突即失败 → 用于 replace 清空后的整体写入） */
function bulkInsertRecordsStmt(db: D1Database, json: string): D1PreparedStatement {
    return db.prepare(`INSERT INTO records(${REC_COLUMNS}) ${recJsonSelect}`).bind(json);
}

/** 批量 upsert（用于 merge）：仅当来件 updatedAt 更新，或原行在回收站（视为找回）时覆盖 */
function bulkMergeRecordsStmt(db: D1Database, json: string): D1PreparedStatement {
    const sets = ["model", "variant", "agent", "token_source", "pid", "title", "thinking", "difficulty",
        "categories", "submissions", "minutes", "memory", "date", "note", "status", "author", "author_id",
        "reviewer_id", "reviewed_at", "deleted_at", "created_at", "updated_at"]
        .map((c) => `${c} = excluded.${c}`).join(", ");
    return db.prepare(`INSERT INTO records(${REC_COLUMNS}) ${recJsonSelect}` +
        ` ON CONFLICT(id) DO UPDATE SET ${sets}` +
        ` WHERE excluded.updated_at > records.updated_at OR records.deleted_at IS NOT NULL`).bind(json);
}

/** 按**字节**预算把记录切成若干片（每片一条语句）。
 *  注意：切片元素是已 stringify 的 JSON 文本，拼数组时不能再走 String(obj)（会得到 [object Object]）。 */
function chunkByJsonBudget(recs: Rec[], budget = BULK_JSON_BUDGET_BYTES): string[] {
    const enc = new TextEncoder();
    const out: string[] = [];
    let parts: string[] = [];
    let size = 2;
    for (const r of recs) {
        const item = JSON.stringify(recToJsonValue(r));
        const bytes = enc.encode(item).length;
        if (size + bytes > budget && parts.length) {
            out.push(`[${parts.join(",")}]`);
            parts = [];
            size = 2;
        }
        parts.push(item);
        size += bytes + 1;
    }
    if (parts.length) out.push(`[${parts.join(",")}]`);
    return out;
}

/** 分块执行批量语句：每批 ≤BATCH_STATEMENTS 条（`tail` 只挂在最后一批上，避免 revision 抖动）。
 *  返回业务语句的 changes 合计。 */
async function runBulk(db: D1Database, stmts: D1PreparedStatement[], tail: D1PreparedStatement[] = []): Promise<number> {
    if (!stmts.length) {
        if (tail.length) await db.batch(tail);
        return 0;
    }
    const cap = Math.max(1, BATCH_STATEMENTS - tail.length);
    let changes = 0;
    for (let i = 0; i < stmts.length; i += cap) {
        const batch = stmts.slice(i, i + cap);
        const isLast = i + cap >= stmts.length;
        if (isLast) batch.push(...tail);
        const res = await db.batch(batch);
        const bizCount = batch.length - (isLast ? tail.length : 0);
        for (let j = 0; j < bizCount; j++) changes += res[j]?.meta?.changes ?? 0;
    }
    return changes;
}

// ---------------------------------------------------------------- 导入导出

export interface ImportResult {
    /** 实际写入的记录数 */
    imported: number;
    /** 被白名单拒绝（字段超限/格式不合法）而**静默丢弃**的条数 —— 必须回给管理员，否则丢数据无人知 */
    invalid: number;
    /** 同一份文件里 id 重复被跳过的条数 */
    duplicate: number;
    /** 本次实际发出的批量语句数（每条语句一个 json 分片） */
    statements: number;
}

/** 收录制导入：只导入记录本身；题目/模型目录一律由管理员重新「收录」后才显示对应旧数据 */
export async function importBundle(db: D1Database, raw: any, mode: string): Promise<ImportResult> {
    let root = raw && typeof raw === "object" ? raw : {};
    if (root.data && typeof root.data === "object") root = root.data;
    const { migrateRecord } = await import("./util");
    const seenIds = new Set<string>();
    const incomingRecords: Rec[] = [];
    const recs: any[] = Array.isArray(root.records) ? root.records.slice(0, MAX_RECORDS) : [];
    let invalid = 0;
    let duplicate = 0;
    for (const item of recs) {
        const rec = migrateRecord(item);
        if (!rec) { invalid += 1; continue; }
        if (seenIds.has(rec.id)) { duplicate += 1; continue; }
        seenIds.add(rec.id);
        incomingRecords.push(rec);
    }
    if (Array.isArray(root.records) && root.records.length > MAX_RECORDS) {
        invalid += root.records.length - MAX_RECORDS;  // 超出条数上限的部分同样被丢弃
    }
    const incomingRevision = Math.max(0, Math.floor(Number(root.revision) || 0));
    const replace = mode === "replace";
    if (!replace && mode !== "merge") throw badRequest("mode 只能是 replace 或 merge");

    let statements = 0;
    if (replace) {
        // 覆盖 = 清空 records + problems + models（题目/模型目录一并重建）。
        // 写入走 json_each 批量语句：一条语句写任意多行，不再产生「N 条记录 = N 条语句」的查询数爆炸。
        const clear: D1PreparedStatement[] = [
            db.prepare("DELETE FROM records"),
            db.prepare("DELETE FROM problems"),
            db.prepare("DELETE FROM models"),
        ];
        const chunks = chunkByJsonBudget(incomingRecords);
        statements = chunks.length;
        const inserts = chunks.map((j) => bulkInsertRecordsStmt(db, j));
        // 覆盖式导入后数据整体换了一批：revision 取 max(现值, 来件值) 后再自增，并换 cache_epoch
        const tail: D1PreparedStatement[] = [
            db.prepare("INSERT INTO meta(key, value) VALUES ('revision', ?1) ON CONFLICT(key) DO UPDATE" +
                " SET value = CAST(MAX(CAST(value AS INTEGER), ?1) + 1 AS TEXT)").bind(String(incomingRevision)),
            ...updatedAtStmts(db),
            bumpEpochStmt(db),
        ];
        await runBulk(db, [...clear, ...inserts], tail);
    } else {
        // merge：一条 json_each upsert 完成「按 id 合并、来件 updatedAt 较新者胜、命中回收站视为找回」，
        // 不再对每条记录做一次串行 SELECT（旧实现 = N 次 D1 往返）。目录不动。
        const incoming = incomingRecords.map((r) => ({ ...r, deletedAt: null })); // 合并写入一律视为“恢复/正常”
        const chunks = chunkByJsonBudget(incoming);
        statements = chunks.length;
        await runBulk(db, chunks.map((j) => bulkMergeRecordsStmt(db, j)), bumpMetaStmts(db));
    }
    return { imported: incomingRecords.length, invalid, duplicate, statements };
}

/** 管理员全量导出（含隐藏历史数据与完整 problems/models），供备份/迁移 */
export async function exportBundle(db: D1Database): Promise<Snapshot & { models: ModelView[] }> {
    const snap = await snapshot(db, null, true, { all: true });
    return { ...snap, models: await listModels(db) };
}

/** 全部隐藏（approved 但题目或模型未收录）记录的明细，收录管理页“查看隐藏记录”用 */
export async function listHiddenRecords(db: D1Database): Promise<Rec[]> {
    const [recs, sets] = await Promise.all([
        db.prepare("SELECT * FROM records WHERE status = 'approved' AND deleted_at IS NULL ORDER BY date DESC, created_at DESC").all<any>(),
        loadVisibleSets(db),
    ]);
    return (recs.results || [])
        .map(mapRec)
        .filter((r) => !isRecordVisible(r, sets.problems, sets.models));
}

/** 按模型把 approved 隐藏记录移入回收站（收录管理页“删除记录”用）；返回移入条数 */
export async function purgeRecordsByModel(db: D1Database, model: string): Promise<number> {
    const res = await db.batch([
        db.prepare("UPDATE records SET deleted_at = ?1, updated_at = ?2 WHERE model = ?3 AND status = 'approved' AND deleted_at IS NULL")
            .bind(nowIso(), nowIso(), model),
        ...bumpMetaStmts(db),
    ]);
    return res[0].meta?.changes ?? 0;
}

// ---------------------------------------------------------------- 回收站（软删除记录）

/** 回收站列表（deleted_at 非空），含删除时间；按删除时间倒序 */
export async function listTrash(db: D1Database): Promise<Rec[]> {
    const recs = await db
        .prepare("SELECT * FROM records WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id")
        .all<any>();
    return (recs.results || []).map(mapRec);
}

/** 恢复回收站记录：清除 deleted_at（状态保留原样；恢复后是否可见由收录制判定） */
export async function restoreTrash(db: D1Database, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let affected = 0;
    for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const placeholders = chunk.map(() => "?").join(",");
        const res = await db.batch([
            db.prepare(`UPDATE records SET deleted_at = NULL, updated_at = ?1 WHERE id IN (${placeholders})`)
                .bind(nowIso(), ...chunk),
            ...bumpMetaStmts(db),
        ]);
        affected += res[0]?.meta?.changes ?? 0;
    }
    return affected;
}

/** 永久删除回收站记录（物理 DELETE，不可恢复） */
export async function purgeTrash(db: D1Database, ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    let affected = 0;
    for (let i = 0; i < ids.length; i += 90) {
        const chunk = ids.slice(i, i + 90);
        const placeholders = chunk.map(() => "?").join(",");
        const res = await db.batch([
            db.prepare(`DELETE FROM records WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL`)
                .bind(...chunk),
            ...bumpMetaStmts(db),
        ]);
        affected += res[0]?.meta?.changes ?? 0;
    }
    return affected;
}

/** 清空回收站（永久删除全部软删除记录） */
export async function emptyTrash(db: D1Database): Promise<number> {
    const res = await db.batch([
        db.prepare("DELETE FROM records WHERE deleted_at IS NOT NULL"),
        ...bumpMetaStmts(db),
    ]);
    return res[0].meta?.changes ?? 0;
}

/** 一键清空收录目录（problems + models + records，含回收站），从头重新收录（仅站长，需二次确认）。
 *  revision 不回零（缓存校验器必须单调），改为换 cache_epoch：让所有持旧 ETag 的客户端必然 miss。 */
export async function resetCatalog(db: D1Database): Promise<void> {
    await db.batch([
        db.prepare("DELETE FROM records"),
        db.prepare("DELETE FROM problems"),
        db.prepare("DELETE FROM models"),
        bumpEpochStmt(db),
        db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('updatedAt', '')"),
        db.prepare("UPDATE meta SET value = ?1 WHERE key = 'updatedAt'").bind(nowIso()),
    ]);
}

// ---------------------------------------------------------------- 公开导出 CSV

function csvCell(value: unknown): string {
    const s = value === null || value === undefined ? "" : String(value);
    // CSV 公式注入防护（渗透报告 low-2）：= + - @ \t \r 开头一律前缀单引号（Excel/WPS 视为文本）
    const cell = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export function buildCsv(records: Rec[]): string {
    const header = ["record_id", "model", "variant", "agent", "token_source", "pid", "title", "thinking",
        "difficulty", "categories", "round", "score", "result", "round_note", "memory_mb", "minutes",
        "date", "note", "status", "author", "created_at", "updated_at"];
    const lines = [header.join(",")];
    for (const rec of records) {
        let round = 0;
        for (const sub of rec.submissions) {
            round++;
            lines.push([
                rec.id, rec.model, rec.variant, rec.agent, rec.tokenSource, rec.pid, rec.title, rec.thinking,
                rec.difficulty ?? "", rec.categories.join(";"), round, sub.score ?? "", sub.result, sub.note,
                rec.memory ?? "", rec.minutes ?? "", rec.date, rec.note, rec.status, rec.author,
                rec.createdAt, rec.updatedAt,
            ].map(csvCell).join(","));
        }
    }
    return lines.join("\r\n") + "\r\n";
}

// ---------------------------------------------------------------- 审计日志（v3.8）

export interface AuditEntry {
    id: number;
    actorId: number | null;
    actor: string;
    action: string;
    detail: string;
    createdAt: string;
}

/** 敏感操作留痕：只追加不修改。detail 截断 500 字防滥用；失败不抛出（审计不该拖垮主操作）。 */
export async function logAudit(
    db: D1Database,
    actor: { uid: number; username: string } | null,
    action: string,
    detail: string,
): Promise<void> {
    try {
        await db.prepare(
            "INSERT INTO audit_log(actor_id, actor, action, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).bind(actor?.uid ?? null, actor?.username ?? "", action, String(detail).slice(0, 500),
            new Date().toISOString()).run();
    } catch (e) {
        console.warn("[audit] 写入失败：", e instanceof Error ? e.message : e);
    }
}

/** 最近 limit 条审计（新→旧），管理端只读展示 */
export async function listAudit(db: D1Database, limit = 100): Promise<AuditEntry[]> {
    const { results } = await db.prepare(
        "SELECT id, actor_id, actor, action, detail, created_at FROM audit_log ORDER BY id DESC LIMIT ?1")
        .bind(limit).all<any>();
    return (results || []).map((r) => ({
        id: r.id, actorId: r.actor_id ?? null, actor: r.actor ?? "",
        action: r.action ?? "", detail: r.detail ?? "", createdAt: r.created_at ?? "",
    }));
}
