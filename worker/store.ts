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
    nameList, intOrNull, forbidden,
} from "./util";
import { fetchLuoguProblem } from "./luogu";

export interface Snapshot {
    revision: number;
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

const bumpMetaStmts = (db: D1Database): D1PreparedStatement[] => [
    db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'"),
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('updatedAt', '')"),
    db.prepare("UPDATE meta SET value = ?1 WHERE key = 'updatedAt'").bind(nowIso()),
];

export async function getRevision(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'").first<{ n: number }>();
    return row?.n ?? 0;
}

async function getUpdatedAt(db: D1Database): Promise<string> {
    const row = await db.prepare("SELECT value FROM meta WHERE key = 'updatedAt'").first<{ value: string }>();
    return row?.value ?? "";
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
    const [visible, mods] = await Promise.all([
        loadVisibleSets(db),
        db.prepare("SELECT name FROM models").all<{ name: string }>(),
    ]);
    return { problemPids: [...visible.problems], modelNames: (mods.results || []).map((r) => r.name) };
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
    const [recs, probs, revision, updatedAt] = await Promise.all([
        recStmt.all<any>(),
        db.prepare("SELECT * FROM problems").all<any>(),
        getRevision(db),
        getUpdatedAt(db),
    ]);
    const problems: Record<string, ProblemEntry> = {};
    for (const row of probs.results || []) {
        const p = mapProblem(row);
        problems[p.pid] = p;
    }
    let records = (recs.results || []).map(mapRec);
    if (!opts.all) {
        // 收录制过滤（只对 approved 生效）：pending 走审核流程可见性
        const { problems: pset, models: mset } = await loadVisibleSets(db);
        records = records.filter((r) => {
            if (r.status === "pending") {
                return adminLike || (username !== null && r.author === username);
            }
            return isRecordVisible(r, pset, mset);
        });
    }
    return { revision, updatedAt, records, problems };
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
}

export async function updateRecord(
    db: D1Database,
    rid: string,
    raw: any,
    userOrAdminLike: UpdateUserCtx | boolean = false,
): Promise<AddRecordResult> {
    const isAdminLike = typeof userOrAdminLike === "object" ? userOrAdminLike.isAdminLike : Boolean(userOrAdminLike);
    const row = await db.prepare("SELECT * FROM records WHERE id = ?1 AND deleted_at IS NULL").bind(rid).first();
    if (!row) throw notFound("记录不存在（可能已在回收站）");
    const existing = mapRec(row);

    // 鉴权校验：非管理员只能修改自己提交的记录
    if (!isAdminLike) {
        if (typeof userOrAdminLike !== "object") {
            throw forbidden("权限不足，无法修改此记录");
        }
        const isOwner = (existing.authorId !== null && existing.authorId === userOrAdminLike.uid)
            || (Boolean(existing.author) && existing.author === userOrAdminLike.username);
        if (!isOwner) {
            throw forbidden("只能修改自己提交的记录");
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
    const stmts: D1PreparedStatement[] = [updateRecStmt(db, rec)];
    if (prev && isAdminLike) {
        const merged = await mergeProblemFromRecord(prev, rec, raw);
        stmts.push(saveProblemStmt(db, merged));
    }
    stmts.push(...bumpMetaStmts(db));
    await db.batch(stmts);
    return { rec, revision: await getRevision(db) };
}

/** 软删除：记录移入回收站（deleted_at 置时间），不物理删除 */
export async function deleteRecord(db: D1Database, rid: string): Promise<number> {
    await db.batch([
        db.prepare("UPDATE records SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL")
            .bind(nowIso(), nowIso(), rid),
        ...bumpMetaStmts(db),
    ]);
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

/** 批量审核：approve 置为通过（记录审核人）；reject 移入回收站（软删除）。返回实际影响条数 */
export async function bulkStatus(db: D1Database, ids: string[], action: string, reviewerUid: number): Promise<number> {
    let approve: boolean;
    if (action === "approve") approve = true;
    else if (action === "reject") approve = false;
    else throw badRequest("action 只能是 approve 或 reject");
    if (ids.length > MAX_RECORDS) throw badRequest("批量数量超出上限");
    const stmts: D1PreparedStatement[] = [];
    for (const id of new Set(ids)) {
        if (approve) {
            stmts.push(db.prepare("UPDATE records SET status = 'approved', reviewer_id = ?1, reviewed_at = ?2, updated_at = ?3 WHERE id = ?4 AND status != 'approved' AND deleted_at IS NULL")
                .bind(reviewerUid, nowIso(), nowIso(), id));
        } else {
            stmts.push(db.prepare("UPDATE records SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL")
                .bind(nowIso(), nowIso(), id));
        }
    }
    let affected = 0;
    for (let i = 0; i < stmts.length; i += 90) {
        const chunk = stmts.slice(i, i + 90);
        const results = await db.batch([...chunk, ...bumpMetaStmts(db)]);
        for (let j = 0; j < chunk.length; j++) {
            affected += results[j]?.meta?.changes ?? 0;
        }
    }
    return affected;
}

// ---------------------------------------------------------------- 题目操作

export async function putProblem(db: D1Database, pid: string, info: any): Promise<ProblemEntry> {
    const clean = sanitizeProblem(pid, info);
    if (!clean) throw badRequest("题号格式不正确");
    const prev = await findProblem(db, clean.pid);
    if (!prev) {
        const row = await db.prepare("SELECT COUNT(*) AS n FROM problems").first<{ n: number }>();
        if ((row?.n ?? 0) >= MAX_PROBLEMS) throw badRequest("题目缓存已达上限");
    }
    const merged: ProblemEntry = {
        pid: clean.pid,
        title: clean.title || prev?.title || "",
        difficulty: clean.difficulty ?? prev?.difficulty ?? null,
        tags: clean.tags.length ? clean.tags : (prev?.tags ?? []),
        categories: clean.categories.length ? clean.categories : (prev?.categories ?? []),
        manual: clean.manual || Boolean(prev?.manual),
        // 推荐提示词：新值非空才覆盖（再次发布同题号即可更新提示词）
        prompt: clean.prompt || prev?.prompt || "",
        // 题面/限制：新值非空才覆盖（发布时洛谷抓取会带全；手动发布可后续编辑补）
        content: clean.content || prev?.content || "",
        timeLimit: clean.timeLimit ?? prev?.timeLimit ?? null,
        memoryLimit: clean.memoryLimit ?? prev?.memoryLimit ?? null,
        hasAttachments: clean.hasAttachments || Boolean(prev?.hasAttachments),
        fetchedAt: clean.fetchedAt || prev?.fetchedAt || "",
    };
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
        "SELECT pid FROM problems WHERE content = '' OR time_limit IS NULL OR memory_limit IS NULL ORDER BY pid",
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

/** 重写一条历史记录（收录题目/改名模型时保持“已收录”且带最新 author/审计字段） */
function retouchRecordStmt(db: D1Database, r: Rec): D1PreparedStatement {
    return updateRecStmt(db, { ...r, updatedAt: nowIso() });
}

/** 隐藏记录分组查询：approved 记录中 pid/model 未进目录的分组计数与样本（收录管理页用）
 *  problems/models 分组按各自维度聚合（同一记录可能双计），total 为去重后的隐藏记录数。 */
export interface HiddenGroup { key: string; kind: "problem" | "model"; name: string; count: number; sample: string }

export async function listHiddenGroups(db: D1Database): Promise<{ problems: HiddenGroup[]; models: HiddenGroup[]; total: number }> {
    const [recs, probs, mods] = await Promise.all([
        db.prepare("SELECT pid, title, model, date, author FROM records WHERE status = 'approved' AND deleted_at IS NULL").all<any>(),
        db.prepare("SELECT pid FROM problems").all<{ pid: string }>(),
        db.prepare("SELECT name FROM models").all<{ name: string }>(),
    ]);
    const probSet = new Set((probs.results || []).map((r) => r.pid));
    const modelSet = new Set((mods.results || []).map((r) => r.name));
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

// ---------------------------------------------------------------- 导入导出

export interface ImportResult { imported: number }

/** 收录制导入：只导入记录本身；题目/模型目录一律由管理员重新「收录」后才显示对应旧数据 */
export async function importBundle(db: D1Database, raw: any, mode: string): Promise<ImportResult> {
    let root = raw && typeof raw === "object" ? raw : {};
    if (root.data && typeof root.data === "object") root = root.data;
    const { migrateRecord } = await import("./util");
    const seenIds = new Set<string>();
    const incomingRecords: Rec[] = [];
    const recs: any[] = Array.isArray(root.records) ? root.records.slice(0, MAX_RECORDS) : [];
    for (const item of recs) {
        const rec = migrateRecord(item);
        if (rec && !seenIds.has(rec.id)) {
            seenIds.add(rec.id);
            incomingRecords.push(rec);
        }
    }
    const incomingRevision = Math.max(0, Math.floor(Number(root.revision) || 0));
    const replace = mode === "replace";
    if (!replace && mode !== "merge") throw badRequest("mode 只能是 replace 或 merge");

    if (replace) {
        // 覆盖 = 清空 records + problems + models（题目/模型目录一并重建）
        const clear: D1PreparedStatement[] = [
            db.prepare("DELETE FROM records"),
            db.prepare("DELETE FROM problems"),
            db.prepare("DELETE FROM models"),
        ];
        const inserts: D1PreparedStatement[] = incomingRecords.map((r) => insertRecStmt(db, r));
        await db.batch([...clear, ...inserts,
            db.prepare("UPDATE meta SET value = ?1 WHERE key = 'revision'").bind(String(incomingRevision)),
            db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('updatedAt', '')"),
            db.prepare("UPDATE meta SET value = ?1 WHERE key = 'updatedAt'").bind(nowIso())]);
    } else {
        // merge：按 id 合并记录；命中回收站记录视为“找回”（清除 deleted_at）。
        // 目录不动（已收录的继续收录，未收录的历史数据依然隐藏）
        const stmts: D1PreparedStatement[] = [];
        for (const rec of incomingRecords) {
            const row = await db.prepare("SELECT updated_at, deleted_at FROM records WHERE id = ?1").bind(rec.id).first<{ updated_at: string; deleted_at: string | null }>();
            const incoming = { ...rec, deletedAt: null }; // 合并写入一律视为“恢复/正常”，不进回收站
            if (!row || row.deleted_at !== null || (incoming.updatedAt ?? "") > (row.updated_at ?? "")) {
                stmts.push(row ? updateRecStmt(db, incoming) : insertRecStmt(db, incoming));
            }
        }
        for (let i = 0; i < stmts.length; i += 90) {
            await db.batch(stmts.slice(i, i + 90));
        }
        await db.batch(bumpMetaStmts(db));
    }
    return { imported: incomingRecords.length };
}

/** 管理员全量导出（含隐藏历史数据与完整 problems/models），供备份/迁移 */
export async function exportBundle(db: D1Database): Promise<Snapshot & { models: ModelView[] }> {
    const snap = await snapshot(db, null, true, { all: true });
    return { ...snap, models: await listModels(db) };
}

/** 全部隐藏（approved 但题目或模型未收录）记录的明细，收录管理页“查看隐藏记录”用 */
export async function listHiddenRecords(db: D1Database): Promise<Rec[]> {
    const [recs, probs, mods] = await Promise.all([
        db.prepare("SELECT * FROM records WHERE status = 'approved' AND deleted_at IS NULL ORDER BY date DESC, created_at DESC").all<any>(),
        db.prepare("SELECT pid FROM problems").all<{ pid: string }>(),
        db.prepare("SELECT name FROM models").all<{ name: string }>(),
    ]);
    const probSet = new Set((probs.results || []).map((r) => r.pid));
    const modelSet = new Set((mods.results || []).map((r) => r.name));
    return (recs.results || [])
        .map(mapRec)
        .filter((r) => !isRecordVisible(r, probSet, modelSet));
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

/** 一键清空收录目录（problems + models + records，含回收站），从头重新收录（仅站长，需二次确认） */
export async function resetCatalog(db: D1Database): Promise<void> {
    await db.batch([
        db.prepare("DELETE FROM records"),
        db.prepare("DELETE FROM problems"),
        db.prepare("DELETE FROM models"),
        db.prepare("UPDATE meta SET value = '0' WHERE key = 'revision'"),
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
