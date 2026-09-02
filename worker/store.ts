/**
 * 服务端权威存储（D1/SQLite）：记录与题目的读写、审核流程、题目发布制、
 * revision 单调递增、导入导出、AI 模型目录。写操作走 db.batch（原子事务）。
 */
import type { ProblemEntry, Rec, Sub } from "./util";
import {
    MAX_CATEGORIES, MAX_CATEGORY, MAX_MODEL, MAX_NOTE, MAX_PROBLEMS, MAX_RECORDS,
    MAX_SUBMISSIONS, MAX_TAGS, MAX_TITLE, MAX_VARIANT, MAX_AGENT, MAX_TOKEN_SOURCE,
    STATUSES, nowIso, sanitizeProblem, sanitizeRecord, badRequest, notFound, text,
    nameList, intOrNull,
} from "./util";

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
        prompt: row.prompt ?? "", fetchedAt: row.fetched_at ?? "",
    };
}

const recParams = (r: Rec): unknown[] => [
    r.id, r.model, r.variant, r.agent, r.tokenSource, r.pid, r.title, r.thinking,
    r.difficulty, JSON.stringify(r.categories), JSON.stringify(r.submissions),
    r.minutes, r.memory, r.date, r.note, r.status, r.author, r.authorId,
    r.reviewerId, r.reviewedAt, r.createdAt, r.updatedAt,
];

const insertRecStmt = (db: D1Database, r: Rec) => db.prepare(
    "INSERT INTO records(id, model, variant, agent, token_source, pid, title, thinking, difficulty, categories, submissions, minutes, memory, date, note, status, author, author_id, reviewer_id, reviewed_at, created_at, updated_at) " +
    "VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22)").bind(...recParams(r));

const updateRecStmt = (db: D1Database, r: Rec) => db.prepare(
    "UPDATE records SET model=?2, variant=?3, agent=?4, token_source=?5, pid=?6, title=?7, thinking=?8, " +
    "difficulty=?9, categories=?10, submissions=?11, minutes=?12, memory=?13, date=?14, note=?15, " +
    "status=?16, author=?17, author_id=?18, reviewer_id=?19, reviewed_at=?20, created_at=?21, updated_at=?22 WHERE id=?1").bind(...recParams(r));

const saveProblemStmt = (db: D1Database, p: ProblemEntry) => db.prepare(
    "INSERT INTO problems(pid, title, difficulty, tags, categories, manual, prompt, fetched_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8) " +
    "ON CONFLICT(pid) DO UPDATE SET title=excluded.title, difficulty=excluded.difficulty, tags=excluded.tags, " +
    "categories=excluded.categories, manual=excluded.manual, prompt=excluded.prompt, fetched_at=excluded.fetched_at")
    .bind(p.pid, p.title, p.difficulty, JSON.stringify(p.tags), JSON.stringify(p.categories), p.manual ? 1 : 0, p.prompt ?? "", p.fetchedAt);

const bumpMetaStmts = (db: D1Database): D1PreparedStatement[] => [
    db.prepare("UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'"),
    db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('updatedAt', '')"),
    db.prepare("UPDATE meta SET value = ?1 WHERE key = 'updatedAt'").bind(nowIso()),
];

async function getRevision(db: D1Database): Promise<number> {
    const row = await db.prepare("SELECT CAST(value AS INTEGER) AS n FROM meta WHERE key = 'revision'").first<{ n: number }>();
    return row?.n ?? 0;
}

async function getUpdatedAt(db: D1Database): Promise<string> {
    const row = await db.prepare("SELECT value FROM meta WHERE key = 'updatedAt'").first<{ value: string }>();
    return row?.value ?? "";
}

// ---------------------------------------------------------------- 快照

export async function snapshot(db: D1Database, username: string | null, adminLike: boolean): Promise<Snapshot> {
    let recStmt: D1PreparedStatement;
    if (adminLike) {
        recStmt = db.prepare("SELECT * FROM records ORDER BY created_at, id");
    } else if (username) {
        recStmt = db.prepare("SELECT * FROM records WHERE status = 'approved' OR author = ?1 ORDER BY created_at, id").bind(username);
    } else {
        recStmt = db.prepare("SELECT * FROM records WHERE status = 'approved' ORDER BY created_at, id");
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
    return { revision, updatedAt, records: (recs.results || []).map(mapRec), problems };
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

/** 保存记录时把题目信息并入已发布条目（不新建条目：题目目录由管理员发布维护） */
function mergedProblemFromRecord(prev: ProblemEntry, rec: Rec, raw: any): ProblemEntry {
    const src = raw && typeof raw === "object" ? raw.problem : null;
    const srcTags = src && typeof src === "object" ? src.tags : undefined;
    return {
        pid: rec.pid,
        title: rec.title || prev.title,
        difficulty: rec.difficulty ?? prev.difficulty,
        tags: Array.isArray(srcTags) && srcTags.length ? nameList(srcTags, MAX_TAGS, MAX_CATEGORY, "标签") : prev.tags,
        categories: rec.categories.length ? rec.categories : prev.categories,
        manual: true,
        // 保存记录不改动推荐提示词
        prompt: prev.prompt,
        fetchedAt: prev.fetchedAt || (src && typeof src === "object" ? String(src.fetchedAt ?? "") : ""),
    };
}

export interface AddRecordResult { rec: Rec; revision: number }

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
    const countRow = await db.prepare("SELECT COUNT(*) AS n FROM records").first<{ n: number }>();
    if ((countRow?.n ?? 0) >= MAX_RECORDS) throw badRequest(`记录数量已达上限（${MAX_RECORDS}）`);
    await requirePublished(db, rec.pid);
    const prev = await findProblem(db, rec.pid);
    const stmts: D1PreparedStatement[] = [insertRecStmt(db, rec)];
    if (prev) stmts.push(saveProblemStmt(db, mergedProblemFromRecord(prev, rec, raw)));
    stmts.push(...bumpMetaStmts(db));
    await db.batch(stmts);
    return { rec, revision: await getRevision(db) };
}

export async function updateRecord(db: D1Database, rid: string, raw: any): Promise<AddRecordResult> {
    const row = await db.prepare("SELECT * FROM records WHERE id = ?1").bind(rid).first();
    if (!row) throw notFound("记录不存在");
    const existing = mapRec(row);
    const rec = sanitizeRecord(raw, existing, existing.status);
    await requirePublished(db, rec.pid);
    const prev = await findProblem(db, rec.pid);
    const stmts: D1PreparedStatement[] = [updateRecStmt(db, rec)];
    if (prev) stmts.push(saveProblemStmt(db, mergedProblemFromRecord(prev, rec, raw)));
    stmts.push(...bumpMetaStmts(db));
    await db.batch(stmts);
    return { rec, revision: await getRevision(db) };
}

export async function deleteRecord(db: D1Database, rid: string): Promise<number> {
    const stmts: D1PreparedStatement[] = [
        db.prepare("DELETE FROM records WHERE id = ?1").bind(rid),
        ...bumpMetaStmts(db),
    ];
    await db.batch(stmts);
    return getRevision(db);
}

export async function setStatus(db: D1Database, rid: string, status: string, reviewerUid: number): Promise<Rec> {
    if (!(STATUSES as readonly string[]).includes(status)) throw badRequest("状态不合法");
    const row = await db.prepare("SELECT * FROM records WHERE id = ?1").bind(rid).first();
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

/** 批量审核：approve 置为通过（记录审核人）；reject 直接删除。返回实际影响条数 */
export async function bulkStatus(db: D1Database, ids: string[], action: string, reviewerUid: number): Promise<number> {
    let approve: boolean;
    if (action === "approve") approve = true;
    else if (action === "reject") approve = false;
    else throw badRequest("action 只能是 approve 或 reject");
    if (ids.length > MAX_RECORDS) throw badRequest("批量数量超出上限");
    const stmts: D1PreparedStatement[] = [];
    for (const id of new Set(ids)) {
        if (approve) {
            stmts.push(db.prepare("UPDATE records SET status = 'approved', reviewer_id = ?1, reviewed_at = ?2, updated_at = ?3 WHERE id = ?4 AND status != 'approved'")
                .bind(reviewerUid, nowIso(), nowIso(), id));
        } else {
            stmts.push(db.prepare("DELETE FROM records WHERE id = ?1").bind(id));
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
        fetchedAt: clean.fetchedAt || prev?.fetchedAt || "",
    };
    await db.batch([saveProblemStmt(db, merged), ...bumpMetaStmts(db)]);
    return merged;
}

export async function deleteProblem(db: D1Database, pid: string): Promise<number> {
    const key = String(pid ?? "").trim().toUpperCase();
    if (!(await findProblem(db, key))) throw badRequest(`题目 ${key} 不存在（可能已被删除）`);
    const used = await db.prepare("SELECT COUNT(*) AS n FROM records WHERE pid = ?1").bind(key).first<{ n: number }>();
    if ((used?.n ?? 0) > 0) {
        throw badRequest(`题目 ${key} 下仍有 ${used!.n} 条测试记录，请先删除这些记录再移除题目`);
    }
    await db.batch([db.prepare("DELETE FROM problems WHERE pid = ?1").bind(key), ...bumpMetaStmts(db)]);
    return getRevision(db);
}

// ---------------------------------------------------------------- AI 模型目录

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

export async function createModel(db: D1Database, name: string, vendor: string, note: string): Promise<ModelView> {
    name = (name || "").trim(); vendor = (vendor || "").trim(); note = (note || "").trim();
    checkModelFields(name, vendor, note);
    const dup = await db.prepare("SELECT id FROM models WHERE name = ?1").bind(name).first();
    if (dup) throw badRequest(`模型 ${name} 已存在`);
    await db.prepare("INSERT INTO models(name, vendor, note, created_at) VALUES (?1, ?2, ?3, ?4)")
        .bind(name, vendor, note, new Date().toISOString()).run();
    const row = await db.prepare("SELECT id, name, vendor, note FROM models WHERE name = ?1").bind(name).first<any>();
    return { id: row.id, name: row.name, vendor: row.vendor, note: row.note, createdAt: "" };
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
        const used = await db.prepare("SELECT COUNT(*) AS n FROM records WHERE model = ?1").bind(prev.name).first<{ n: number }>();
        if ((used?.n ?? 0) > 0) {
            throw badRequest(`模型 ${prev.name} 已有 ${used!.n} 条测评记录，不能改名`);
        }
    }
    await db.prepare("UPDATE models SET name = ?1, vendor = ?2, note = ?3 WHERE id = ?4").bind(name, vendor, note, id).run();
    return (await findModelById(db, id))!;
}

export async function deleteModel(db: D1Database, id: number): Promise<void> {
    const prev = await findModelById(db, id);
    if (!prev) throw notFound("模型不存在");
    const used = await db.prepare("SELECT COUNT(*) AS n FROM records WHERE model = ?1").bind(prev.name).first<{ n: number }>();
    if ((used?.n ?? 0) > 0) {
        throw badRequest(`模型 ${prev.name} 下仍有 ${used!.n} 条测评记录，无法删除`);
    }
    await db.prepare("DELETE FROM models WHERE id = ?1").bind(id).run();
}

/** 导入历史数据后，把出现过的模型名登记进模型目录（管理员可后续补全厂商/备注） */
async function seedModelsFromRecords(db: D1Database): Promise<void> {
    await db.prepare(
        "INSERT OR IGNORE INTO models(name, vendor, note, created_at) SELECT model, '', '', ?1 FROM records GROUP BY model")
        .bind(new Date().toISOString()).run();
}

// ---------------------------------------------------------------- 导入导出

export interface ImportResult { imported: number }

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
    const incomingProblems = new Map<string, ProblemEntry>();
    const probs = root.problems && typeof root.problems === "object" ? root.problems : {};
    let taken = 0;
    for (const [pid, info] of Object.entries(probs)) {
        if (taken++ >= MAX_PROBLEMS) break;
        const p = sanitizeProblem(pid, info);
        if (p) incomingProblems.set(p.pid, p);
    }
    // 兼容旧数据：记录引用了目录里没有的题号时，按记录自带信息补一个题目条目
    for (const rec of incomingRecords) {
        if (!incomingProblems.has(rec.pid)) {
            const p = sanitizeProblem(rec.pid, {
                title: rec.title ?? "", difficulty: rec.difficulty,
                categories: rec.categories ?? [], manual: true,
            });
            if (p) incomingProblems.set(p.pid, p);
        }
    }
    const incomingRevision = Math.max(0, Math.floor(Number(root.revision) || 0));
    const replace = mode === "replace";
    if (!replace && mode !== "merge") throw badRequest("mode 只能是 replace 或 merge");

    if (replace) {
        const clear: D1PreparedStatement[] = [
            db.prepare("DELETE FROM records"),
            db.prepare("DELETE FROM problems"),
        ];
        const inserts: D1PreparedStatement[] = incomingRecords.map((r) => insertRecStmt(db, r));
        for (const p of incomingProblems.values()) inserts.push(saveProblemStmt(db, p));
        // 分批（每批留出 bumpMeta 的位置），保证整体原子性由最后一并完成：
        // D1 batch 是事务，但单批有语句数上限，这里先清库再分批插入会破坏原子性，
        // 因此把全部语句合并为一个批次（数据量远低于 D1 批次上限）
        await db.batch([...clear, ...inserts,
            db.prepare("UPDATE meta SET value = ?1 WHERE key = 'revision'").bind(String(incomingRevision)),
            db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('updatedAt', '')"),
            db.prepare("UPDATE meta SET value = ?1 WHERE key = 'updatedAt'").bind(nowIso())]);
    } else {
        const stmts: D1PreparedStatement[] = [];
        let merged = 0;
        for (const rec of incomingRecords) {
            const row = await db.prepare("SELECT updated_at FROM records WHERE id = ?1").bind(rec.id).first<{ updated_at: string }>();
            if (!row || (rec.updatedAt ?? "") > (row.updated_at ?? "")) {
                stmts.push(row ? updateRecStmt(db, rec) : insertRecStmt(db, rec));
                merged++;
            }
        }
        for (const p of incomingProblems.values()) {
            if (!(await findProblem(db, p.pid))) stmts.push(saveProblemStmt(db, p));
        }
        for (let i = 0; i < stmts.length; i += 90) {
            await db.batch(stmts.slice(i, i + 90));
        }
        await db.batch(bumpMetaStmts(db));
    }
    await seedModelsFromRecords(db);
    return { imported: incomingRecords.length };
}

// ---------------------------------------------------------------- 公开导出 CSV

function csvCell(value: unknown): string {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
