/**
 * 自动建表 + 增量迁移：每个 isolate 生命周期内执行一次（语句全部幂等）。
 * 旧库缺新列时按 PRAGMA 探测后 ALTER 补齐（ALTER 重复执行会报错，所以必须先探测）。
 * 建表语句来自 worker/schema.ts（Pages 项目不支持文本导入 .sql）。
 */
import { SCHEMA_STATEMENTS } from "./schema";

let ready: Promise<void> | null = null;

async function ensureColumn(db: D1Database, table: string, column: string, ddl: string) {
    const cols = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
    if (!(cols.results || []).some((c) => c.name === column)) {
        await db.prepare(ddl).run();
    }
}

export function ensureSchema(db: D1Database): Promise<void> {
    if (!ready) {
        ready = (async () => {
            await db.batch(SCHEMA_STATEMENTS.map((s) => db.prepare(s)));
            // 迁移 v3.1：problems.prompt（推荐提示词，统一测试口径）
            await ensureColumn(db, "problems", "prompt",
                "ALTER TABLE problems ADD COLUMN prompt TEXT NOT NULL DEFAULT ''");
            // 迁移 v3.2：users.nickname + records 的提供者/审核人审计字段
            await ensureColumn(db, "users", "nickname",
                "ALTER TABLE users ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
            await ensureColumn(db, "records", "author_id",
                "ALTER TABLE records ADD COLUMN author_id INTEGER");
            await ensureColumn(db, "records", "reviewer_id",
                "ALTER TABLE records ADD COLUMN reviewer_id INTEGER");
            await ensureColumn(db, "records", "reviewed_at",
                "ALTER TABLE records ADD COLUMN reviewed_at TEXT");
            // 迁移 v3.3：users.password_version（改密后旧会话失效）
            await ensureColumn(db, "users", "password_version",
                "ALTER TABLE users ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0");
            // 迁移 v3.5：records.deleted_at（软删除回收站；非空 = 在回收站）
            await ensureColumn(db, "records", "deleted_at",
                "ALTER TABLE records ADD COLUMN deleted_at TEXT");
        })().catch((e) => {
            ready = null; // 失败允许下次重试
            throw e;
        });
    }
    return ready;
}
