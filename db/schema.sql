-- 「AI vs 洛谷」D1/SQLite 表结构（幂等，重复执行安全）

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
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
);

CREATE TABLE IF NOT EXISTS problems (
    pid         TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    difficulty  INTEGER,
    tags        TEXT NOT NULL DEFAULT '[]',
    categories  TEXT NOT NULL DEFAULT '[]',
    manual      INTEGER NOT NULL DEFAULT 0,
    prompt      TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    time_limit  INTEGER,
    memory_limit INTEGER,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    fetched_at  TEXT
);

CREATE TABLE IF NOT EXISTS models (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    vendor     TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
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
);

-- v3.7：登录失败防护（账号级锁定计数，跨 isolate 持久化；渗透报告 medium-2）
CREATE TABLE IF NOT EXISTS login_guard (
    username     TEXT PRIMARY KEY COLLATE NOCASE,
    fail_count   INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    updated_at   TEXT
);

-- v3.8：敏感操作审计（删账号/删记录/清空目录/导入等破坏性与权限操作留痕）
CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id   INTEGER,
    actor      TEXT NOT NULL DEFAULT '',
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_records_pid    ON records(pid);
CREATE INDEX IF NOT EXISTS idx_records_status ON records(status);
CREATE INDEX IF NOT EXISTS idx_records_model  ON records(model);
-- 收录制热查询覆盖索引：id 必须显式入列——records.id 是 TEXT 主键（不是 rowid），
-- 不会自动出现在二级索引里，缺它 ORDER BY created_at, id 仍要建临时 B-tree
CREATE INDEX IF NOT EXISTS idx_records_visible ON records(deleted_at, status, created_at, id, pid, model);
-- 贡献者名册聚合（GROUP BY author）
CREATE INDEX IF NOT EXISTS idx_records_author  ON records(author, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_login_guard_until ON login_guard(locked_until);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(id);

-- v3.12：农场对抗赛战绩（只登记谁和谁打、谁赢了、赢了多少）
CREATE TABLE IF NOT EXISTS arena_matches (
    id         TEXT PRIMARY KEY,
    a_name     TEXT NOT NULL,
    b_name     TEXT NOT NULL,
    winner     TEXT NOT NULL CHECK(winner IN ('A','B','draw')),
    a_cash     REAL,
    b_cash     REAL,
    margin     REAL NOT NULL DEFAULT 0,
    games      INTEGER NOT NULL DEFAULT 1,
    note       TEXT NOT NULL DEFAULT '',
    played_at  TEXT NOT NULL,
    author     TEXT NOT NULL DEFAULT '',
    author_id  INTEGER,
    deleted_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_arena_played ON arena_matches(deleted_at, played_at DESC);


-- v3.13：对抗赛回放（D1 存元数据，blob 存 R2 的 replays/<id>.json）
CREATE TABLE IF NOT EXISTS arena_replays (
    id          TEXT PRIMARY KEY,
    a_name      TEXT NOT NULL,
    b_name      TEXT NOT NULL,
    seed        INTEGER,
    winner      TEXT NOT NULL DEFAULT '',
    end_reason  TEXT NOT NULL DEFAULT '',
    steps       INTEGER NOT NULL DEFAULT 0,
    frames      INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL DEFAULT 0,
    sha256      TEXT NOT NULL DEFAULT '',
    engine_sha  TEXT NOT NULL DEFAULT '',
    match_id    TEXT,
    author      TEXT NOT NULL DEFAULT '',
    author_id   INTEGER,
    deleted_at  TEXT,
    created_at  TEXT NOT NULL
)
CREATE INDEX IF NOT EXISTS idx_arena_replay_created ON arena_replays(deleted_at, created_at DESC)
CREATE INDEX IF NOT EXISTS idx_arena_replay_created ON arena_replays(deleted_at, created_at DESC);

-- v3.14：比赛维度（同一站点承载多个比赛；历史数据默认归入农场对抗赛）
CREATE TABLE IF NOT EXISTS competitions (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    subtitle    TEXT NOT NULL DEFAULT '',
    rules_url   TEXT NOT NULL DEFAULT '',
    engine_sha  TEXT NOT NULL DEFAULT '',
    score_model TEXT NOT NULL DEFAULT '1v1_cash',
    status      TEXT NOT NULL DEFAULT 'live',
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    deleted_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comp_slug ON competitions(slug);
INSERT OR IGNORE INTO competitions (id, slug, name, subtitle, rules_url, engine_sha, score_model, status, sort, created_at) VALUES ('kaggriculture', 'kaggriculture', '农场对抗赛', '两个 AI 各自写一个农场经营 agent，1v1 对战，终局现金高者胜', '', '62371bb7fb83f256af801864ac24e08003c63756fbd97b538ad7c15f7c8cea79', '1v1_cash', 'live', 1, '2026-10-01T00:00:00Z');

-- revision 单调递增（缓存校验器的一部分）；cache_epoch 在清库/覆盖导入时更换，两者一起构成 ETag 校验器
-- ⚠️ 不要在这里写 schema_version：它由 worker/ensureSchema.ts 在「建表 + 增量 ALTER 探测」成功后写入。
--    若把它写进本文件，对**缺列的旧库**执行此文件会把版本标成最新，导致 ensureSchema 跳过补列 → 运行期报"无此列"。
INSERT OR IGNORE INTO meta(key, value) VALUES ('revision', '0');
INSERT OR IGNORE INTO meta(key, value) VALUES ('cache_epoch', '0');
INSERT OR IGNORE INTO meta(key, value) VALUES ('data_version', '3');
