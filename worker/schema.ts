/**
 * D1 建表语句（ensureSchema 每实例执行一次，全部幂等）。
 * 注意：与 db/schema.sql 保持同步（后者供 `wrangler d1 execute --file` 使用）；
 * Pages 项目不支持 wrangler.toml [[rules]]，无法以文本导入 .sql，故内联于此。
 */
export const SCHEMA_STATEMENTS: string[] = [
    `CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS users (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    username         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    nickname         TEXT NOT NULL DEFAULT '',
    password_hash    TEXT NOT NULL,
    password_version INTEGER NOT NULL DEFAULT 0,
    role             TEXT NOT NULL CHECK(role IN ('owner','admin','contributor')),
    status           TEXT NOT NULL CHECK(status IN ('active','pending','rejected')),
    created_at       TEXT NOT NULL,
    approved_at      TEXT,
    approved_by      TEXT
)`,
    `CREATE TABLE IF NOT EXISTS problems (
    pid         TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    difficulty  INTEGER,
    tags        TEXT NOT NULL DEFAULT '[]',
    categories  TEXT NOT NULL DEFAULT '[]',
    manual      INTEGER NOT NULL DEFAULT 0,
    prompt      TEXT NOT NULL DEFAULT '',
    fetched_at  TEXT
)`,
    `CREATE TABLE IF NOT EXISTS models (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    vendor     TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
)`,
    `CREATE TABLE IF NOT EXISTS records (
    id           TEXT PRIMARY KEY,
    model        TEXT NOT NULL,
    variant      TEXT NOT NULL DEFAULT '',
    agent        TEXT NOT NULL DEFAULT '',
    token_source TEXT NOT NULL DEFAULT '',
    pid          TEXT NOT NULL,
    title        TEXT NOT NULL DEFAULT '',
    thinking     TEXT NOT NULL DEFAULT 'max',
    difficulty   INTEGER NOT NULL,
    categories   TEXT NOT NULL DEFAULT '[]',
    submissions  TEXT NOT NULL DEFAULT '[]',
    memory       INTEGER,
    minutes      INTEGER,
    date         TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL CHECK(status IN ('approved','pending')),
    author       TEXT NOT NULL DEFAULT '',
    author_id    INTEGER,
    reviewer_id  INTEGER,
    reviewed_at  TEXT,
    deleted_at   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
)`,
    // v3.7：登录失败防护（账号级锁定计数，跨 isolate 持久化；渗透报告 medium-2）
    `CREATE TABLE IF NOT EXISTS login_guard (
    username     TEXT PRIMARY KEY COLLATE NOCASE,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    updated_at   TEXT
)`,
    `CREATE INDEX IF NOT EXISTS idx_records_pid    ON records(pid)`,
    `CREATE INDEX IF NOT EXISTS idx_records_status ON records(status)`,
    `CREATE INDEX IF NOT EXISTS idx_records_model  ON records(model)`,
    `CREATE INDEX IF NOT EXISTS idx_login_guard_until ON login_guard(locked_until)`,
    // revision 单调递增（乐观并发）；data_version 对齐旧 data.json 的版本号
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('revision', '0')`,
    `INSERT OR IGNORE INTO meta(key, value) VALUES ('data_version', '3')`,
];
