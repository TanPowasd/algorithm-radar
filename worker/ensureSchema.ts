/**
 * 自动建表 + 增量迁移：**按 schema 版本门控**，同一份库里版本命中时只做一次廉价探测。
 * 旧库缺新列时按 PRAGMA 探测后 ALTER 补齐（ALTER 重复执行会报错，所以必须先探测）。
 * 建表语句来自 worker/schema.ts（Pages 项目不支持文本导入 .sql）。
 *
 * 为什么门控：旧实现每个冷 isolate 的首个请求都要跑 `batch(14 条建表) + 11 次 PRAGMA`
 * ≈ 25 次 D1 语句才轮到业务查询——D1 免费档「每次调用 ≤ 50 条查询」直接被吃掉一半。
 * 现在版本命中时只有 1 条 SELECT。
 *
 * ⚠️ 长期方案是官方 D1 migrations（wrangler d1 migrations apply）+ 部署脚本，
 * 这里保留运行时兜底是为了让"零迁移上云/手改库"仍然可用（详见 docs/BACKEND_REVIEW.md P2-1）。
 */
import { POST_MIGRATION_STATEMENTS, SCHEMA_STATEMENTS } from "./schema";

/** 与下方 MIGRATIONS 一一对应的版本号；改动迁移列表就必须 +1 */
export const SCHEMA_VERSION = "v3.17";

let ready: Promise<void> | null = null;

/** 新增列的增量迁移：[表, 列, ALTER 语句] */
const MIGRATIONS: Array<[string, string, string]> = [
    ["problems", "prompt", "ALTER TABLE problems ADD COLUMN prompt TEXT NOT NULL DEFAULT ''"],
    ["users", "nickname", "ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''"],
    ["records", "author_id", "ALTER TABLE records ADD COLUMN author_id INTEGER"],
    ["records", "reviewer_id", "ALTER TABLE records ADD COLUMN reviewer_id INTEGER"],
    ["records", "reviewed_at", "ALTER TABLE records ADD COLUMN reviewed_at TEXT"],
    ["users", "password_version", "ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0"],
    ["records", "deleted_at", "ALTER TABLE records ADD COLUMN deleted_at TEXT"],
    ["problems", "content", "ALTER TABLE problems ADD COLUMN content TEXT NOT NULL DEFAULT ''"],
    ["problems", "time_limit", "ALTER TABLE problems ADD COLUMN time_limit INTEGER"],
    ["problems", "memory_limit", "ALTER TABLE problems ADD COLUMN memory_limit INTEGER"],
    ["problems", "has_attachments", "ALTER TABLE problems ADD COLUMN has_attachments INTEGER NOT NULL DEFAULT 0"],
    // v3.14：把历史战绩与回放归入默认比赛（农场对抗赛）
    ["arena_matches", "competition_id", "ALTER TABLE arena_matches ADD COLUMN competition_id TEXT NOT NULL DEFAULT 'kaggriculture'"],
    ["arena_replays", "competition_id", "ALTER TABLE arena_replays ADD COLUMN competition_id TEXT NOT NULL DEFAULT 'kaggriculture'"],
    // v3.15：一轮（系列赛）的局比分，用于局级 ELO；空值表示"胜者全胜"（16:0）
    ["arena_matches", "a_wins", "ALTER TABLE arena_matches ADD COLUMN a_wins INTEGER"],
    ["arena_matches", "b_wins", "ALTER TABLE arena_matches ADD COLUMN b_wins INTEGER"],
    // v3.16：思考强度（模型档案的一部分）+ 导入来源键（去重用，避免同一轮重复登记）
    ["arena_matches", "a_thinking", "ALTER TABLE arena_matches ADD COLUMN a_thinking TEXT NOT NULL DEFAULT ''"],
    ["arena_matches", "b_thinking", "ALTER TABLE arena_matches ADD COLUMN b_thinking TEXT NOT NULL DEFAULT ''"],
    ["arena_matches", "source_key", "ALTER TABLE arena_matches ADD COLUMN source_key TEXT NOT NULL DEFAULT ''"],
];

async function migrate(db: D1Database): Promise<void> {
    await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
    // 一次 batch 拿回全部 PRAGMA 结果（结果顺序与语句顺序一致），避免 11 次串行往返
    const tables = [...new Set(MIGRATIONS.map(([table]) => table))];
    const probes = await db.batch(tables.map((table) => db.prepare(`PRAGMA table_info(${table})`)));
    const columns = new Map(tables.map((table, i) => [table, new Set((probes[i]?.results || []).map((c: any) => c.name))]));
    const missing = new Set<string>();
    for (const [table, column] of MIGRATIONS) {
        if (!columns.get(table)?.has(column)) missing.add(`${table}.${column}`);
    }
    const alters = MIGRATIONS
        .filter(([table, column]) => missing.has(`${table}.${column}`))
        .map(([, , ddl]) => db.prepare(ddl));
    if (alters.length) await db.batch(alters);
    await db.batch([
        ...POST_MIGRATION_STATEMENTS.map((s) => db.prepare(s)),
        db.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?1)").bind(SCHEMA_VERSION),
        db.prepare("UPDATE meta SET value = ?1 WHERE key = 'schema_version'").bind(SCHEMA_VERSION),
    ]);
}

/** 版本命中即跳过全部 DDL/探测（同库多 isolate、多部署共享同一结论） */
async function ensure(db: D1Database): Promise<void> {
    let version: string | null = null;
    try {
        const row = await db.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
            .first<{ value: string }>();
        version = row?.value ?? null;
    } catch {
        version = null; // 全新库连 meta 表都没有 → 走完整建表 + 迁移
    }
    if (version === SCHEMA_VERSION) return;
    await migrate(db);
}

export function ensureSchema(db: D1Database): Promise<void> {
    if (!ready) {
        ready = ensure(db).catch((e) => {
            ready = null; // 失败允许下次重试
            throw e;
        });
    }
    return ready;
}

/** 供测试/运维查看当前 isolate 是否已完成建表 */
export function schemaReady(): boolean {
    return ready !== null;
}
