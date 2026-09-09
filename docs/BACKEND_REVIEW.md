# 后端评审意见（Cloudflare Worker + D1 + R2）

评审对象：`worker/`（index / router / auth / store / luogu / snapshot / schema / ensureSchema / util）、`db/schema.sql`、`wrangler.toml`、`pages/`、`scripts/e2e.mjs`
评审基线：README v3.11（Workers 单部署 + Pages 兼容入口）· 数据量参考根目录导出 `算法雷达站数据_20260902.json`（122 条记录）
结论：**安全底子是同类项目里偏上的（SSRF 白名单、CSRF 双提交、会话回查、审计留痕、软删除三区、恒定时间比较都做了）**；主要风险集中在 **D1 批量写入上限、读写放大（全表 dump 给每个访客）、限流覆盖面、以及若干"合并语义"造成的静默数据错误**。下面按优先级给出可执行意见。

---

## 一、P0：会直接出错 / 丢数据

### P0-1 `replace` 导入把 N+6 条语句塞进同一个 `db.batch()`，没有按查询数/时长预算分块
`worker/store.ts:603-614`：
```ts
const clear = [DELETE records, DELETE problems, DELETE models];        // 3
const inserts = incomingRecords.map(r => insertRecStmt(db, r));        // N
await db.batch([...clear, ...inserts, UPDATE revision, INSERT OR IGNORE updatedAt, UPDATE updatedAt]); // 3
```
先对齐口径（[D1 Limits](https://developers.cloudflare.com/d1/platform/limits/) 现版限制表）：**每次 Worker 调用最多 50（免费）/ 1000（付费）条查询**、**batch 整体同样受 30 秒查询时长限制**（该页脚注 4）、**每条语句 ≤ 100 个绑定参数**、**单条 SQL ≤ 100KB**。官方表里**没有**「每批 ≤ 100 条语句」这一项，所以阈值按「每次调用的查询数」算：
- **免费档：`N + 6 > 50` → N ≥ 45 条记录即失败**。当前根目录导出只有 122 条，正好在失败区间内。
- **付费档：N ≥ 995 失败**；而 `MAX_RECORDS = 20000`（`util.ts:87`）说明设计允许的单次导入是这个上限的 20 倍，30 秒也撑不住。

代码里其他批量路径（`bulkStatus:347`、`restoreTrash`/`purgeTrash`）按 **90** 分块——那个 90 是给「≤ 100 绑定参数」留余量（`IN(...)` 占位符个数），**不是**查询数预算。按免费档 50 条/调用的口径看，merge 分支（每块 90 语句 + 3 条 meta = 93）同样会撞线，`/api/import`、`/api/records/bulk`、`/api/trash/*` 一起中招。

- 影响面：README「导入只写入测评记录」「推荐先用 replace 模式导入」（`README.md:147`）+ 当前 122 条真实数据 = **正好在失败区间内**，主部署首次上云迁移就会翻车。
- 为什么没被发现：`scripts/e2e.mjs` **完全没有 import/export 用例**（只覆盖权限矩阵 + ETag + 快照）；本地 miniflare 模拟的 D1 与云端限制不必然一致，"本地能导入"不能当作"符合配额"——这条要么按常量分块写成不依赖上限的实现，要么补一次 `--remote` 冒烟。
- 建议改法：
  1. **给写入路径定一个显式的"每请求语句预算"**并全局共用一个 helper（例如 `runInChunks(stmts, {perBatch: 40, params: 90})`），replace 分支现在完全没走这个预算；
  2. 用**多值 INSERT**把语句数压一个数量级：`INSERT INTO records(...) VALUES (?,?,...),(?,?,...),...` —— 23 列 × 4 行 = 92 个绑定参数（≤100 上限），122 行只要 31 条语句，20000 行 5000 条 = 125 批；再进一步可考虑导出成 SQL 文本走 `d1 execute --file`（不受 Worker 每调用预算约束）；
  3. 大批量导入移出请求路径（见 P1-4）：Queue/Workflow 分片 + 进度端点，请求里只做「入队 + 返回 jobId」。
- 补测：`e2e` 增加「导出 → replace 导入 → 记录数一致」往返用例（含 >50 条的样本），并至少跑一次 `--remote`（本地 miniflare 与云端配额不必然一致，"本地能导入"不等于合规）。

### P0-2 `resetCatalog` 把 `revision` 归零，会让 ETag 命中错误的旧缓存
`worker/store.ts:717-727` 把 `revision` 置 `'0'`，而 ETag = `"r<revision>-g|a"`（`worker/router.ts:279`）。清库后新数据的第一个响应 ETag 又回到 `r0-g`，与清库前浏览器里缓存的 `r0-g` 正文**完全同名**：`Cache-Control: no-cache` + 客户端持 `If-None-Match: "r0-g"` → 服务端比对成功 → **304，前端继续展示已被清空的老数据**，且不会自愈。`importBundle` replace 分支（`store.ts:612`）把 revision 设成导出文件的 revision，同理可回退。

- 建议：把校验器做成**单调且分代**的 token，例如 `"<generation>:<revision>"`，`generation = meta.session_secret 前 8 位` 或 `建库时间戳`，清库/replace 导入时重新生成；退一步也应在这些破坏性操作里 `revision = max(旧值, 传入值) + 1`，并顺手 `DELETE FROM meta WHERE key='updatedAt'`。
- 顺带：`schema.sql:94` 注释说 revision 用于「乐观并发」，但写路径从不校验基线版本（见 P1-6），语义名不副实。

### P0-3 `merge` 导入对每条记录做一次串行 `SELECT`
`worker/store.ts:618-625`：循环体内 `await db.prepare("SELECT updated_at, deleted_at FROM records WHERE id=?1").first()` —— 一条记录一个 D1 往返。官方限制是**每次 Worker 调用最多 50（免费）/ 1000（付费）条查询**（见 [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)），所以：
- **免费档：导入超过 ~40 条必失败**；付费档超过 ~990 条必失败（还没算后面的写入）。这不是"慢"，是**硬错误**。
- 30 秒 batch/查询时长之外，Workers 单次请求墙钟也会先响。
- 建议：先分块 `SELECT id, updated_at, deleted_at FROM records WHERE id IN (...)`（每块 ≤ 100 个绑定参数）一次拿回 map，再按 P0-1 的多值 `INSERT ... ON CONFLICT(id) DO UPDATE SET ... WHERE excluded.updated_at > records.updated_at` 写入；或干脆一次 `SELECT id, updated_at, deleted_at FROM records`（读 20000 行换掉 20000 次往返，rows read 更划算）。

### P0-4 「布尔/可空字段 OR 合并」造成无法纠正的脏标记
`worker/store.ts:367-382`（`putProblem`）：
```ts
hasAttachments: clean.hasAttachments || Boolean(prev?.hasAttachments)
manual:        clean.manual        || Boolean(prev?.manual)
```
`has_attachments` 只能通过 `PUT /api/problems/:pid` 清除（`updateProblem` 全量覆盖），走「重新发布同题号」（README 明示的更新提示词入口）就会被 `maybeFetchLuogu`（`router.ts:160` 无条件 `info.hasAttachments = fetched.hasAttachments`）+ OR 合并再钉回 `true`；一旦洛谷删了附件，全站永久弹「去下载附件」提醒。同类问题：`prompt/content` 用 `||` 导致"发布口无法清空"（这个 README 里有说明，属于有意设计，但和 `hasAttachments` 混在同一段代码里，语义不一致，很容易改错）。
- 建议：显式区分「未提供」和「显式 false/null」——`raw` 里 key 不存在 → 保留 prev；存在 → 覆盖。例：`hasAttachments: "hasAttachments" in raw ? Boolean(clean.hasAttachments) : prev?.hasAttachments`。把 `putProblem`/`updateProblem` 两套合并规则合成一个 `mergeProblem(prev, clean, providedKeys)`，并加单测（清空提示词 / 取消附件 / 清空题面 三个用例）。

### P0-5 贡献者提交的 `title/difficulty` 仍由客户端说了算（"单一来源"只做了 UI 锁）
`README.md:82-84` 承诺「题名与难度由题目目录带入并锁死」。渗透修复（medium-1）只堵住了**回写目录**这条路（`store.ts:236-243`），但 `sanitizeRecord`（`util.ts:200-205`）依然接收客户端 `raw.title` / `raw.difficulty` 并原样入库、进公开导出、进矩阵行头。贡献者可以提交一条 `title="震惊！"` 的记录，过审后全站可见。
- 建议：非管理员写路径一律服务端覆盖：`rec.title = prev.title; rec.difficulty = prev.difficulty ?? rec.difficulty;`（`prev` 已由 `requirePublished` 保证存在）；管理员才允许带值。同时 `categories` 对贡献者建议也走「目录 + 白名单追加」而不是自由文本。

---

## 二、P1：性能、配额与安全面

### P1-1 `/api/data` 把整本目录（含 100KB 题面）发给每个访客，而且 ETag 判定在做完全部查询之后
- `worker/store.ts:148-153` `SELECT * FROM problems` → `mapProblem`（`store.ts:50-59`）带 `content`，`router.ts:284-292` 全量回给浏览器；前端把它整体塞进 `localStorage['radar.cache.v3']`（`frontend/src/state.jsx:26-32`）。`content` 上限 `MAX_CONTENT = 100_000`（`util.ts:90`）：300 道题 × 20KB ≈ 6MB JSON，**直接顶穿浏览器 ~5MB localStorage 配额**（现在被 `catch {}` 静默吞掉 → 离线缓存功能悄悄失效），首屏也很慢。
- `router.ts:277-283`：先 `store.snapshot()`（全表读）再算 ETag、再判 `If-None-Match`。304 省下的是**带宽**，D1 读行数和 CPU 一分没省。
- 建议（收益/成本最好的三条）：
  1. **先读 revision**（单行 `SELECT`）比对 `If-None-Match`，命中就立刻 304；未命中才走全量。
  2. `/api/data` 的 `problems` 只回**目录列**（pid/title/difficulty/tags/categories/prompt/limits/hasAttachments），`content` 拆到 `GET /api/problems/:pid`（或 `?include=content`）按需取，复制标准模板时才拉；前端 `aggregate.js:46-48` 的 `standardPrompt()` 改成异步补拉。
  3. 游客口径（`-g` ETag）改成**可边缘缓存**：`Cache-Control: public, s-maxage=30, stale-while-revalidate=300` + 以 revision 为 cache key（`?rev=` 或 `Cache-Key`），让匿名流量不打 D1。
- 配额测算值得写进 README：D1 免费档是 **rows read 5,000,000/天、rows written 100,000/天、单库 500MB**（[D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[Limits](https://developers.cloudflare.com/d1/platform/limits/)）；rows read 按**扫描行数**计（未走索引的过滤更亏）。当前一次首屏 = `/api/data`（records + 2×problems + models）+ `/api/contributors`（内部又跑一遍 `snapshot`）≈ `2N_records + 4N_problems + 2N_models` 行读 + 约 8 条语句。今天（122 记录）可忽略；到 `MAX_RECORDS=20000` + 2000 题时 ≈ 48000 行/次，**约 100 次访问/天就打满免费额度**（`MAX_RECORDS`/`MAX_PROBLEMS` 都取的是 20000/20000，见 `util.ts:87`，也就是说设计上限本身就超出免费档承受力）。

### P1-2 `snapshot()` 内部重复查询；`/api/contributors` 为算名册拉全库
- `store.ts:148-153` 已经 `SELECT * FROM problems`，`store.ts:162` 又 `loadVisibleSets()`（`store.ts:120-128`）把 `problems`、`models` 再查一遍（且是在 `Promise.all` **之后**串行加的往返）。pid 集合直接从已取回的 `probs.results` 构造即可，models 并入同一个 `Promise.all`。
- `router.ts:406-455`：贡献者名册只为算「每人多少条 / 多少题 / 多少模型」，却调 `store.snapshot(db, null, false)`（全记录 + 全目录）。这是**公开、无限流**端点 → 放大面很好用（一个 GET 打若干万行 D1）。
- 建议：名册改一条 SQL 聚合（收录制口径用 JOIN 表达）：
```sql
SELECT r.author, COUNT(*) AS n, COUNT(DISTINCT r.pid) AS pids, COUNT(DISTINCT r.model) AS models, MAX(r.date) AS last
FROM records r JOIN problems p ON p.pid = r.pid JOIN models m ON m.name = r.model
WHERE r.status='approved' AND r.deleted_at IS NULL
GROUP BY r.author;
```
  并加 `CREATE INDEX IF NOT EXISTS idx_records_visible ON records(deleted_at, status, pid, model)`（现有索引 `db/schema.sql:88-92` 只有单列 pid/status/model，覆盖不到 `deleted_at IS NULL ORDER BY created_at, id` 这条最热的查询）。

### P1-3 限流只覆盖 5 个端点，其余写接口是敞开的
有 `burstLimit` 的只有：`/api/setup`、`/api/login`、`/api/change-password`、`/api/auth/register`、`POST /api/records`、`/api/luogu`、`/api/admin/backfill-content`（`router.ts:207/230/248/267/296/533/590`）。
**没有**任何限流的写端点：`PUT /api/records/:id`（`:309`）、`DELETE /api/records/:id`、`/api/records/:id/status`、`/api/records/bulk`、`POST /api/problems`（内部还会同步抓洛谷！`:377-384`）、`PUT/DELETE /api/problems`、`POST/PUT/DELETE /api/models`、`/api/trash/*`、`POST /api/import`（16MB 体）、`/api/admin/purge-records`、`/api/catalog/reset`、`/api/admin/snapshot`。`[[ratelimits]]` 已配好 `WRITE_LIMIT`，只是没接。
另外三处实现细节：
- `burstLimit`（`router.ts:78-87`）**fail-open**：binding 抛异常 → `return true`，限流静默失效且无告警。至少 `console.warn` + 回退进程内窗口。
- 键只用 IP（`write:<ip>`）：校园/NAT 出口互相误伤，而多账号刷同一 IP 才会被合并在一个桶里。建议登录写操作键改为 `write:<uid>`（+ IP 兜底），并加一层 `uid` 配额（每人每天 N 条）。
- `tryAcquire`（`router.ts:60-71`）`buckets.size > 10000 → buckets.clear()`：**攻击者用随机 IP 撑到 1w 键即可清空所有人的计数**。改成按窗口过期删（`setInterval`/每次调用顺手删旧键），或干脆把这层挪到 KV/DO。
- 账号级锁定（`auth.ts:296-333`）按 username 计数 → 任何匿名访客可把站长账号锁 15 分钟（**锁定型 DoS**）。建议：锁定只针对「该 IP + 该账号」组合，跨 IP 只做延迟/`login_guard` 提高阈值；或接 **Turnstile**（开放注册 + 登录 + 初始化三个口都值得挂）。

### P1-4 长任务留在请求路径里（没有 `ctx.waitUntil`）
`worker/index.ts:12` 调 `handleApi(req, env)` 时把 `ExecutionContext` 丢了，所以：
- `POST /api/admin/snapshot`（`router.ts:580-585`）在请求内完成「全库导出 + 2 次 R2 put + 分页 list + **逐条 delete**」（`snapshot.ts:27-29`、`:34-51` `for` 循环里 `await bucket.delete(obj.key)`）；
- `POST /api/admin/backfill-content`（`:588-596`）在请求内串行 20 次洛谷抓取（日志里单题 762ms，见 `wrangler.log:35`）≈ 15s：除了墙钟，还直接顶到**每次请求 50 个子请求（免费档）**的预算——`/api/luogu` 每次是 1–2 个 fetch，20 题 = 20–40 个，加上这一路的 D1 读写，免费档几乎必然 500（付费档 1000 才够用）。
- `logAudit`（`store.ts:770-784`）每条审计一个串行往返，挂在业务响应后面。
- 建议：`handleApi(req, env, ctx)`；审计写、过期快照清理、`backfill` 用 `ctx.waitUntil`；`bucket.delete([...keys])` 批量删；`backfill`/大导入改 **Workers Workflow 或 Queue**（可续跑、可看进度，`remaining` 现在是靠客户端轮询点按钮）。
- `maybeFetchLuogu` 与 `/api/luogu` 建议加 **single-flight**（同一 pid 并发只发一次上游请求），并把 `luogu.ts:177-185` 的进程内 `Map` 换成 **带 TTL 的 KV/Cache API**（现在**永不过期**、`cache.size > 5000` 时整体 `clear()`：洛谷改标题/加附件后本站无限期返回旧数据，且清空后瞬时全量回源）。

### P1-5 会话链路每请求 2 次 D1 读
`verifyToken`（`auth.ts:132-169`）每次先 `sessionSecret(db)`（`:101-103` 一条 `SELECT`）**再**查用户表（`:149-152`）。`session_secret` 建库后基本不变，却每次请求都读。
- 建议：isolate 内缓存 secret（模块级 `let` + 一个 60s TTL 兜底）；用户状态可加 `uid → (role,status,pv)` 的 30–60s 进程内小缓存 + 改密/降权/删号时 bump 一个 `meta.session_epoch` 让缓存自然失效（现在只有 `password_version`，删号靠"查不到人"）。
- 顺带：会话密钥放在 D1 里，**能读 D1 的人（泄露的 API token / 误分享的库）即可伪造任意用户会话**。建议改成 Worker secret `SESSION_SECRET`（保留 D1 值作为回退以兼容存量），并支持 `kid` 双读轮换。
- 无法定向踢人：令牌里没有 `jti`，登出只是清 Cookie（`router.ts:238-241`）。加 `POST /api/auth/sessions/revoke`（本质就是 `session_epoch+1`），比现在「改密码才能下线全部设备」友好。

### P1-6 没有乐观并发控制（`revision` 只做缓存校验器）
`updateRecord`/`setStatus`/`bulkStatus` 都是无条件覆盖。两个管理员同时改同一条记录（或一人审核通过、一人同时编辑）→ 后写覆盖前写，且**不报错、无审计**。
- 建议：写接口接 `If-Match`/`baseRevision`（或记录级 `updated_at` 基线），不匹配返回 `409 { error: "数据已被他人更新，请刷新后重试" }`；`updateRecord` 至少改成 `UPDATE ... WHERE id=? AND updated_at=?` 并检查 `meta.changes`。这也让 `schema.sql:94` 的注释变成事实。

### P1-7 `DELETE /api/admin/users/:id` 是物理删除 + 释放用户名，配合 `updateRecord` 的作者匹配可越权改他人记录
- `auth.ts:389-406` 物理删用户并 `DELETE FROM login_guard`，README 明确「用户 ID 随之释放可重新注册」（`:66`）；
- `store.ts:271-272` 归属判定是 `authorId === uid || author === username`（字符串兜底）。
- 组合后果：A（无 `author_id` 的早期/导入记录）被删号 → B 注册同名 ID → B 能 PUT 修改 A 的历史记录。
- 建议：非管理员归属只认 `author_id`（`author` 仅展示快照）；同时把「删号」改成 **停用（`status='disabled'`）+ 保留 uid 与用户名占用**，物理删除留给站长显式二次确认，避免用户名回收带来的身份混叠与审计断链。

### P1-8 审计覆盖面与保留策略
`README.md:69` 宣称的留痕清单和代码有出入：
- `POST /api/admin/purge-records`（`router.ts:565-569`，按模型批量移回收站）**没有** `logAudit`；`/api/trash/restore`（`:339-344`）也没有；`POST/PUT /api/models`、`POST /api/problems`、`PUT /api/problems/:pid` 不记（创建/改名会影响全站统计口径，值得记）。
- `bulkStatus` 只在 `reject` 时记（`:371-373`），`approve` 不记（可接受，但和 `setStatus` 单条不记是一致的，建议在文案上写清「审核不记，破坏性操作记」）。
- `audit_log` 只追加、**无保留期**（`store.ts:786-795` 每次读 100 条没问题，但表会无上限增长）。建议随每日快照顺手裁剪（保留 180 天 / 10 万行），并把裁剪前的部分写进 R2。
- 建议 `logAudit` 传结构化 `detail`（`{targetId, before, after}` 截断后的 JSON），事后追责不用猜中文文案。

### P1-9 边界与错误码
- `router.ts:683-688`：路由匹配把 method 也当匹配条件，`POST /api/data` 这类返回 **404** 而不是 405；也没有 `OPTIONS` 处理（同源 + SameSite=Strict 可以接受，但文档里应写明"不提供跨域消费"）。
- `router.ts:122`：`decodeURIComponent(up[i])` 对 `%E0%A4%A` 之类抛 `URIError` → 落到最外层 catch → **500**（应为 400）。
- `router.ts:693-704`：限额用 `text.length`（UTF-16 码元）比对字节语义的 16MB，中文正文会低估；且 `req.text()` 已经先把整个 body 读进内存。建议 `const bytes = new TextEncoder().encode(text).length`，或对 import 直接走流式读 + 累计字节上限。
- `router.ts:724-730`：500 只有一个「服务器内部错误」，无 request id。建议回显 `cf.ray`（`req.headers.get('cf-ray')`）为 `X-Request-Id`，并把 D1 的 `ERR_QUERY_FAIL`/约束冲突映射成 400（现在 `records.status` CHECK 失败会 500）。
- `router.ts:674`：`secure = url.protocol === 'https:'`。Flexible SSL / 回源 http 时会退化成不带 `Secure`。建议同时看 `x-forwarded-proto` / `cf-visitor`。
- `worker/index.ts:11`（`/api` 前缀判定大小写敏感）：`/API/data` 会掉到静态资产 → SPA 回退返回 200 HTML。建议统一 `pathname.toLowerCase().startsWith('/api/')`。

---

## 三、P2：一致性与可维护性

1. **两份 schema 手工同步**：`db/schema.sql` ↔ `worker/schema.ts`（`schema.ts:3-5` 自己写了"注意保持同步"）+ `ensureSchema.ts` 的 11 条 `ensureColumn` 探测。更要紧的是**DDL 跑在请求路径上**（`router.ts:661`）：一个冷 isolate 的首个请求要先 `batch(14 条 CREATE/INSERT)` + 11 次 `PRAGMA table_info` = **25 次 D1 语句**，才轮到业务查询——在免费档「每次调用 ≤ 50 条查询」的口径下已经吃掉一半预算（付费档 1000 无感）。也就是说：免费额度下，冷启动的第一个访客请求离超限只差几个查询，而这类错误只在流量稀疏时出现，最难复现。建议：**改用官方 D1 migrations**（`wrangler d1 migrations apply DB --local/--remote`，写进 `npm run deploy`），`ensureSchema` 只保留一条 `SELECT 1` 冒烟；`db/schema.sql` 由 migrations 目录派生，单一事实源。
2. **`pid` 正则两处不一致**：`util.ts:82`（`^[A-Z]{1,3}_?[A-Z0-9_]{2,20}$`）vs `luogu.ts:16`（允许小写，无长度上限差异）。抽到 `util.ts` 导出一个 `PID_RE` + `normalizePid()`，两处引用。
3. **模型名大小写/空格造成"同模型两口径"**：`models.name TEXT NOT NULL UNIQUE`（`db/schema.sql:38`，区分大小写）而可见性靠**字符串精确匹配**（`store.ts:183` 的 `findProblem`、`store.ts:215` 的 `requirePublishedModel`、`loadVisibleSets`）。`"GPT-4"` 与 `"gpt-4"` 可同时存在，记录会被劈成两半，矩阵/雷达统计随之错乱。建议：`name COLLATE NOCASE UNIQUE` + 入库前 `trim()/统一展示名`，或加 `models.name_norm` 归一列并给 `records(model)` 建索引时同样归一。
4. **时间格式三套**：`nowIso()`（`util.ts:142`）、`nowLocal()`（`:146`，`"YYYY-MM-DD HH:MM:SS"` 无时区标记）混用于 `fetched_at`/`created_at`/审计；README 也提到"Workers 无本地时区"。建议一律 `ISO-8601 Z`，展示层再本地化；迁移时把无时区的旧值显式标注为 UTC。
5. **`currentRevision`（`router.ts:130-134`）与 `getRevision`（`store.ts:95-98`）重复**，且每个写响应都多一次 D1 读去拿刚写的 revision。建议写路径返回 `bumpMetaStmts` 的结果或从 `batch` 返回值推出，别回读。
6. **`addRecord` 的 `MAX_RECORDS` 检查在事务外**（`store.ts:231-232`）：并发可轻微超限。把 `SELECT COUNT` 放进同一 `batch()`，或改计数器（`meta.record_count` 增量维护）。
7. **无分页**：`/api/trash`（`store.ts:667-672`）、`/api/hidden-records/detail`（`:641-652`）、`/api/export`（`:635-638`）都是全表 JSON。回收站/隐藏记录页在几千条时会明显卡。建议统一 `?limit=&cursor=&q=`，管理端表格改服务端分页（配合 P1-1 的瘦身）。
8. **`submissions` 存 JSON 文本**（`records.submissions`）：写侧简单，读侧一切聚合（每轮 AC 率、区分度、CSV 展平）只能在 JS 里做。当前规模没问题；如果记录数上千且洞察视图要更复杂的口径，建议加一张 `record_rounds(record_id, round, score, result)` 派生表（写时同步维护），或上 **D1 的 `json_each()`** 在 SQL 里聚合，避免全量搬到浏览器算。
9. **类型/契约**：`tsconfig.json` 开了 `strict`（好），但 worker 里大量 `any`（`mapRec(row: any)`、`raw: any`、`JSON.parse` 结果直接用），入参校验靠手写 `sanitize*`。建议：① 用 `zod`（或 `typebox`）做入参 schema，`sanitizeRecord` 由 schema 派生，避免"加了列忘了清"；② 把 API 类型共享给前端（现在是 `.jsx` + 无类型的 `api()`），至少手维护一个 `shared/api.d.ts`，防前后端口径漂移；③ CI 里补 `tsc --noEmit`（README 只写成本地命令，`package.json:7-23` 没有 typecheck/lint 脚本）。
10. **仓库卫生**：`functions/api/` 是空目录（Pages 迁移遗留，README 已不提它，建议删）；根目录还留着 `wrangler.log`、`算法雷达站数据_20260902.json`（真实数据导出，`.gitignore:8` 已忽略但文件在盘上）、`tags.json`（后端运行时要读，属源码不是产物）；`pages/.wrangler/tmp/**`、`frontend/src/.mimosa/`、`worker/.mimosa/` 已被 `.gitignore:26/31`（无斜杠前缀 → 匹配任意深度）覆盖，不必额外处理，但工具元数据目录混在源码树里仍影响 glob/搜索噪音（本次 `glob **/*` 的结果一半是 `.mimosa` 基线副本）。`package.json:5` 的 description 还写着 "Cloudflare Pages + Workers Functions + D1"，与 v3.9 迁移到 Workers 的事实不符。
11. **两个部署目标共享一套数据（上线风险）**：`README.md:161-162` 说旧 Pages 项目"不再更新"。旧 Pages 仍绑定同一个 D1 时，**旧版本（缺 v3.7/v3.11 安全修复）的代码在线上仍然可达**，等于给渗透修复留了旁路。建议：删掉/暂停旧 Pages 项目，或至少摘掉它的 D1 绑定。同理 `wrangler.toml:10` `workers_dev = true` 与自定义域 `k4u.top` 并存 → 同一 Worker 两个可访问源，WAF/访问策略若只按域名写就会漏；不需要 workers.dev 就关掉，需要就给两个域名同等的规则。

---

## 四、值得肯定（建议保持的模式）

- **SSRF 防护到位**：`luogu.ts:12-13` 编译期常量 host、`:75-86` 初始 URL 与 302 `location` 同一白名单、`:89-93` 题号先正则后 `encodeURIComponent`。这块是同类小站最容易漏的，这里做得规范。
- **鉴权是声明式的**（`routes[].role` + `requireRole`，`router.ts:101-108/707-710`），权限矩阵有 `e2e` 兜底（57 项），改权限时回归成本低。
- **会话每请求回查用户表 + `password_version`**（`auth.ts:147-155`）：删号/降权/改密即时失效，比纯签名令牌强。
- **软删除 + 回收站 + 恢复**（`deleted_at` 三区模型）和 `logAudit` 的"审计不拖垮主操作"（`store.ts:769-784`）方向正确。
- **CSRF 双提交 + `constantTimeEqual`**（`router.ts:666-671`）、`SETUP_TOKEN` 恒定时间比较、`setupOwner` 用 `INSERT…SELECT WHERE NOT EXISTS` 消 TOCTOU（`auth.ts:280-293`）、CSV 公式注入前缀防护（`store.ts:731-736`）——这些细节说明安全清单是真跑过的。
- **幂等 schema + 增量 `ensureColumn`**（`ensureSchema.ts`）让"零迁移上云"成为可能（长期建议换成 migrations，见 P2-1）。

---

## 五、建议的落地顺序（一次 PR 一件事，都有回归可验证）

| 步骤 | 内容 | 验收 |
|---|---|---|
| 1 | P0-1 + P0-3 导入分块/多值 INSERT，merge 批量取基线 | e2e 新增「122 条 replace 往返」「20000 条上限」用例；`--remote` 冒烟一次 |
| 2 | P0-4 `mergeProblem` 显式三态合并 + P0-5 服务端覆盖 title/difficulty | 三个清空用例 + 「贡献者伪造题名 → 被目录值覆盖」用例 |
| 3 | P0-2/P1-1 revision 分代 + ETag 早退 + `content` 拆接口 | `/api/data` 游客正文体积对比（前后差值写进 README）；清库后不再 304 陈旧 |
| 4 | P1-2 contributors 改 SQL 聚合 + 补 `(deleted_at,status,...)` 复合索引 | D1 Analytics 里 rows read/请求 下降；`EXPLAIN QUERY PLAN` 无全表扫 |
| 5 | P1-3 全写端点接 `WRITE_LIMIT`（键含 uid）+ 锁定改「IP+账号」+ 限流 fail-closed | e2e 增加 429 用例（含 PUT 记录、发布题目、import） |
| 6 | P1-4 `handleApi(req, env, ctx)`：审计/清理/backfill/snapshot 走 `waitUntil`，上游加 TTL 缓存 + single-flight | 手动快照与 backfill 的响应时间不再随数据量增长 |
| 7 | P1-5/P1-6 secret 上移 + `session_epoch` + 写路径 `If-Match` | 双管理员并发改同一条 → 409 而非静默覆盖 |
| 8 | P1-8 审计补漏（purge-records / restore / models / problems）+ 保留期裁剪 | e2e 断言这些动作都有条目 |
| 9 | P2-1 D1 migrations 化 + 单一 schema 源；P2-3 模型名 NOCASE 归一 | 部署脚本 `d1 migrations apply`；建 `"GPT-4"`/`"gpt-4"` 冲突用例 |
| 10 | P2-11 下线旧 Pages / 收紧 workers.dev；README 与 `package.json` 描述对齐 | 线上只有一处可写的部署目标 |

## 六、建议补的观测（低成本、高回报）

1. `wrangler.toml` 开 `[observability] enabled = true`（持久化日志）+ 关键路径打点：`ensureSchema` 耗时、D1 语句数、`/api/data` 字节数与 304 命中率、洛谷抓取成功率/回源次数。
2. `/api/ping` 扩成 `/api/health`：`revision`、records/problems/models 计数、`luogu 最近一次失败原因`、`SNAPSHOT_BUCKET` 是否可用、最近一次快照 key。管理员面板显示，快照失败可当场看见（现在 Cron 失败只进 `console.error`，`index.ts:16-22`）。
3. D1 侧建议开 **Query Insights / D1 Analytics**，并在 `scripts/e2e.mjs` 里加一条「响应体字节数上限」断言（例如游客 `/api/data` < 300KB），防止以后又有人把大字段塞回公开接口。

---

## 六·补：本轮已落地的修复（2026-09-08）

> 验证口径：`npm run typecheck` 干净；`node scripts/e2e.mjs` **91 项全绿**（原 57 项，本轮新增 34 项回归）；
> `npm --prefix frontend run selftest` 69 项、`check-classes` 通过、`build` 成功。

| 编号 | 状态 | 改动 |
|---|---|---|
| P0-1 | ✅ 已修 | 新增批量写入层（`store.ts` 的 `chunkByJsonBudget` / `bulkInsertRecordsStmt` / `bulkMergeRecordsStmt` / `runBulk`）：导入改走 `INSERT … SELECT … FROM json_each(?1)`，**一条语句写任意多行**（1 个绑定参数），replace/merge 都按每批 ≤20 条语句分块，**分片预算按字节算**（D1 单个字符串值 ≤2MB，中文 1 字符=3 字节）。回归：`replace 导入 1000 条成功`、`大体积导入按字节分片成功`、`确实切成了多条批量语句` |
| P0-2 | ✅ 已修 | 新增 `meta.cache_epoch`；`readValidator()` 产出 `"<epoch>:<revision>"` 校验器；`resetCatalog` 与 replace 导入换 epoch 且 revision 不再回零（`bumpMetaStmts` 改为 upsert 自愈）。回归：`清库后旧 ETag 不再 304` + `清库后 revision 未回零` |
| P0-3 | ✅ 已修 | merge 不再逐条 `SELECT`：条件全部下推进 `ON CONFLICT(id) DO UPDATE … WHERE excluded.updated_at > records.updated_at OR records.deleted_at IS NOT NULL`，**零次预读**。回归：`merge 忽略更旧的来件`/`采纳更新的来件`/`命中回收站视为找回` |
| P0-4 | ✅ 已修 | `mergeProblem(prev, clean, provided)` 对 `manual` / `hasAttachments` 做**三态**合并（请求里没有该 key → 保留目录值；给了 false → 清掉）。回归：`再次发布传 hasAttachments:false 能清掉标记`、`未提供 prompt 字段 → 不覆盖既有提示词` |
| P0-5 | ✅ 已修 | 新增 `applyCatalogTruth(rec, problem)`，`addRecord`/`updateRecord` 在非管理员路径强制以目录为准（目录无难度时保留提交者所选）。回归：`贡献者提交的题名/难度被目录值覆盖` |
| P1-1（部分） | ✅ 已修 | `/api/data` **先读 meta 再判 `If-None-Match`**（命中 304 完全不扫 records/problems）；`cache_epoch` 进入校验器 |
| P1-1（剩余） | ⏸ 暂缓 | 把 `content` 从 `/api/data` 拆出去**本轮不做**：`PromptsPage` / `CopyButton` / `standardPrompt` 三处都在客户端就地拼装题面，拆分需要同步改前端与新增按题号补拉接口，属于「接口契约变更」，建议单独一轮 PR 做（含 selftest 断言）。同理游客边缘缓存需要「响应不带 Set-Cookie」的前置改造 |
| P1-2 | ✅ 已修 | `snapshot()` 不再二次查目录（题目集合复用已取回的 `probs`，模型并入同一个 `Promise.all`，meta 一次读三键）；`/api/contributors` 改成两条聚合 SQL（`contributorStats` + `legacyContributorStats`，用子查询排除活跃用户避免参数上限）；新增覆盖索引 `idx_records_visible` / `idx_records_author`。**索引实测**：游客热查询 `WHERE deleted_at IS NULL AND status='approved' ORDER BY created_at, id` 的 `EXPLAIN QUERY PLAN` 由「SCAN + USE TEMP B-TREE」变为 `SEARCH records USING INDEX idx_records_visible`（零排序）；坑点是 `records.id` 为 TEXT 主键（非 rowid），**不会**自动出现在二级索引里，必须显式把它列进索引才能消掉临时 B-tree |
| P1-3 | ✅ 已修 | **所有非安全方法**统一过 `WRITE_LIMIT`（`requireWriteBudget`，键 = 登录态 uid / 游客 IP，全部写操作合计而非每端点各刷一份）；`burstLimit` 由 fail-open 改为**退回进程内窗口并告警**；`buckets.clear()` 换成按窗口过期淘汰（`pruneBuckets`），杜绝"撑满键位再清空所有人的计数" |
| P1-4（部分） | ✅ 已修 | `handleApi(req, env, waitUntil)` + `ctx.defer(...)`；手动快照的 90 天清理挪到 `waitUntil`；R2 过期清理改**批量删**（≤1000 key/次）；`/api/luogu` 加 TTL 缓存（6h）+ **single-flight**（同 pid 并发只回源一次）+ 近似 LRU 淘汰 |
| P1-4（剩余） | ⏸ 暂缓 | `backfill-content` / 大导入挪进 Workflow/Queue：需要新增绑定与部署配置，建议单独一轮 |
| P1-5（部分） | ✅ 已修 | `session_secret` isolate 内缓存 5 分钟（每请求少一次 D1 读；会话回查用户表的安全语义保持不变） |
| P1-6 | ✅ 已修 | `PUT /api/records/:id` 支持可选 `baseUpdatedAt` 基线，不匹配返回 **409**（不带该字段的旧客户端行为不变，可渐进接入） |
| P1-7 | ✅ 已修 | 记录归属**只认 `author_id`**；历史数据（`author_id` 为 null）只有管理员能改，删号后同名重注册无法认领他人记录 |
| P1-8 | ✅ 已修 | 补审计：`problem.publish` / `problem.update` / `model.create` / `model.rename` / `records.purgeModel` / `trash.restore`；`audit_log` 保留期裁剪仍待办（见下） |
| P1-9 | ✅ 已修 | 非法转义 → **400**（`decodeSegment`）；路径存在但方法不符 → **405**（`matchRoutes`）；请求体上限按**字节**判定（`TextEncoder`）；`Secure` 参考 `X-Forwarded-Proto`；响应带 `X-Request-Id`（取 `CF-Ray`）；`/API/...` 大小写不再绕过 API 分支 |
| P2-1（部分） | ✅ 已修 | `ensureSchema` 加**版本门控**（`meta.schema_version`）：版本命中时首个请求只做 1 条 SELECT，冷启动从 ~25 次 D1 语句降到 1 次；迁移探测改为**一次 batch 拿回全部 PRAGMA**（含全新库无 meta 表的兜底）。DDL 彻底移出请求路径（官方 migrations）仍待办 |
| P2-5 | ✅ 已修 | 删掉死代码 `getUpdatedAt` / `retouchRecordStmt`；`loadVisibleSets` 反过来被 `listHiddenGroups`/`listHiddenRecords` 复用（收录制集合单处实现）；`deleteRecord` 对不存在/已删 id 返回 404；`bulkStatus` 改 `IN(…)` 分块（一批一语句） |
| 新发现 A | ✅ 已修 | **导入静默丢数据**：`migrateRecord` 返回 null 的记录过去既不报错也不计数，管理员以为导入完整。`ImportResult` 扩为 `{imported, invalid, duplicate, statements}`，响应 + 审计 + 前端 toast 三处都报出丢弃数。回归：`超限字段被白名单拦下，并在响应里报出丢弃数` |
| 新发现 B | ✅ 已修 | 写批量分片时先按「字符数」预算，中文场景会低估 3 倍、顶到 D1 单值 2MB 上限 → 预算单位统一改成 UTF-8 字节（`BULK_JSON_BUDGET_BYTES = 400_000`） |
| — | ✅ 附带 | `deleteRecord` 对不存在/已在回收站的 id 返回 **404**（旧实现静默成功并推进 revision）；`bulkStatus` 从"一 id 一语句"改为 `IN(…)` 分块（≤94 参数）；`schema.sql` 与 `schema.ts` 同步（索引 + meta 初始键） |

**仍未处理（按性价比排序，留给后续）**：`content` 拆分与游客边缘缓存（P1-1 剩余）、`audit_log` 保留期、`/api/data` 分页与 `?contributor=` 服务端筛选、模型名 `COLLATE NOCASE` 归一（需要一次性数据清洗）、时间列统一 ISO-8601、入参 schema 化（zod）与 API 类型共享、Turnstile 接入、D1 migrations 化、`[observability]` + `/api/health`。

**本轮踩到并写下来的两个平台细节**（都在代码注释里标了出处）：
1. `INSERT … SELECT … ON CONFLICT DO UPDATE` 里的 SELECT **必须带 WHERE**（哪怕是 `WHERE true`），否则 SQLite 把 `ON` 当成 join 条件解析、报 `near "DO": syntax error` — [sqlite.org/lang_insert.html](https://sqlite.org/lang_insert.html)。
2. 官方 D1 限制表里**没有**「每批 ≤100 条语句」这一项，真正的约束是「每次调用 50/1000 条查询」+「batch 整体 30 秒」，所以分块预算要按查询数算，而不是照抄别人代码里的 90。

---

如果只允许改三行代码：①`store.ts:611` 的 replace 分支（以及所有 `batch()`）改成按「每次调用查询数预算」分块——免费档每批留到 ≤ 40 条语句，别把 N 条 INSERT 一次交出去；②`router.ts:277` 把 revision 比对挪到 `store.snapshot()` 之前，让 304 真的省掉 D1 读；③`store.ts:162` 删掉重复的 `loadVisibleSets()`，改用已取回的 `probs.results` + 并入 `Promise.all` 的一条 `models` 查询。

---

## 七、口径出处（便于复核）

- D1 限制（本文所有数字来源）：<https://developers.cloudflare.com/d1/platform/limits/> —— 每次调用查询数 50(免费)/1000(付费)、单条语句绑定参数 ≤ 100、单条 SQL ≤ 100KB、查询/batch 时长 ≤ 30s、库大小 500MB(免费)。
- D1 计费口径（rows read / rows written / storage）：<https://developers.cloudflare.com/d1/platform/pricing/>
- Workers 子请求限制：<https://developers.cloudflare.com/workers/platform/limits/#subrequests>
- 批量写入实现要点（本轮踩坑，已写进 `store.ts` 注释）：SQLite 的 `INSERT … SELECT … ON CONFLICT DO UPDATE`
  要求 SELECT 自带 `WHERE`（哪怕 `WHERE true`），否则 `ON` 会被解析成 join 条件并报 `near "DO": syntax error` —
  <https://sqlite.org/lang_insert.html>；另外官方限制表里**没有**「每批 ≤ 100 条语句」这一项，
  真正要预算的是「每次调用 50/1000 条查询」与「batch 整体 30 秒」。
