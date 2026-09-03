# AI vs 洛谷

多个 AI 模型在洛谷题目上的解题能力对比站。游客可浏览排名、下载数据；贡献者提交测评；管理员审核并发布题目；站长管理用户。

> v3.5 · 2026-09：「三区数据」——测评记录分为 **显示区 / 隐藏区 / 回收站** 三类管理：
> - **显示区**：题目与模型均已被收录、且审核通过的记录（访客可见、计入统计与公开导出）
> - **隐藏区**：已审核但题目或模型尚未被收录的记录（保留在库，暂不显示；收录后自动转显示区）
> - **回收站**：删除/拒绝的记录软删除暂存于此（`deleted_at`），支持恢复（回原区）或永久清除，防误删
> v3.4：「收录制」——旧数据（含历史导入）先以「全民制作人」身份挂在库中，管理员在审核台
> 「未收录历史数据」发布题目 / 收录模型后对应记录才会显示。v3.0 重构：React SPA + Cloudflare Pages/Workers Functions + D1（SQLite）。

---

## 一、四种身份

| 身份 | 权限 |
|---|---|
| 游客 | 浏览矩阵/雷达/柱状/趋势/榜单/明细六个视图（仅收录制可见数据）；查看贡献者名册（按注册时间排序）；导出 CSV / JSON（仅收录且已审核数据）；**不可提交** |
| 贡献者 | 提交测评记录（仅可选**已发布题目**与**已收录模型**，进入待审核队列）；可见自己的待审记录 |
| 管理员 | 审核测评（单条/批量通过、拒绝=移入回收站）；编辑记录；发布题目（收录：输题号自动抓洛谷，失败可手动补全；可配推荐提示词）；增删改 AI 模型（收录+改名）；**历史数据收录台**（未收录题目/模型的隐藏记录分组、一键收录、移入回收站）；**回收站管理**（恢复 / 永久删除 / 清空）；全量导出与导入 |
| 站长 | 管理员全部权限 + 审核注册（批准为贡献者）+ 任命/免除管理员 + **清空目录重新收录** |

- 注册：独立页面 `/register`，填写 **用户 ID + 昵称 + 密码**；登录使用 **用户 ID + 密码**，全站显示昵称。注册后为「待审核」，站长在 `/users` 批准后才能登录。密码一律 PBKDF2-SHA256（100k 迭代）哈希存储，明文不落库。
- 贡献者名册：`/contributors`（公开），按**注册时间**排序（与贡献量无关），展示用户 ID/昵称/贡献数等；历史导入数据对应的 `admin`/`guest` 账号排在末尾。
- 审计字段：每条测评记录带 `author_id`（提供者用户 ID）与 `reviewer_id`/`reviewed_at`（批准人用户 ID 与批准时间；管理员自己直接提交的记录自审自记）。**首次录入的历史数据没有这些 ID，提供者/审核人统一署名「全民制作人」**（名册中也合并为同一条目，按注册时间排在末尾）；待审核的记录审核人显示「待审核」。
- 推荐提示词：发布题目时填写（再次发布同题号可更新），展示在题目详情抽屉与提交表单中，一键复制，统一所有人的测试提示词。
- **三区数据（v3.5）**：显示区=已收录+已审核（访客可见）；隐藏区=已审核但未收录（保留待收录，管理员可在
  「未收录历史数据」查看、一键发布/收录或移入回收站）；回收站=删除/拒绝的记录（软删除 `deleted_at`，
  支持恢复/永久删除/清空）。待审核记录不因未收录而隐藏：管理员可见全部待审，提交者可见自己的待审。
- **收录制口径（v3.4）**：历史/导入数据统一署名「全民制作人」（记录里无提供者/审核人 ID 时）。任何记录只有在
  「题目已发布（收录）且模型已收录」时才计入统计/榜单/公开导出。管理员 `/api/export` 全量备份可见（不含回收站）。
- 站长产生：数据库无任何账号时，本地访问会显示「初始化站长」入口（仅一次）；公网部署时需配置 `SETUP_TOKEN`（见下文）。
- 数据口径：聚合主键 = 模型名（版本/策略仅展示）；**无分数轮次（score=null）不计入任何均分、不按 0 计**；柱状图仅显示样本量 n≥5 的「模型 × 思考等级」组合；雷达 AC 率按「作答记录数」为分母。

## 二、目录结构

```
├── frontend/            # React 19 + Vite SPA（构建产物部署到 Cloudflare Pages）
│   └── src/             #   api/ 客户端 · state/ 全局状态 · views/ 六视图 · pages/ 三页面
├── functions/           # Cloudflare Pages Functions：/api/* 全部路由（Workers）
│   └── api/[[route]].ts
├── worker/              # 共享后端逻辑（TypeScript）：auth（PBKDF2+HMAC 会话）、
│                        # store（D1 存取/审核/导入）、luogu（洛谷抓取+SSRF 防护）、router
├── db/schema.sql        # D1 表结构（幂等；Functions 首次请求自动建表）
├── scripts/seed.mjs     # 本地种子：初始化站长 + 导入历史数据 JSON
├── tags.json            # 洛谷标签 → 算法大类映射种子（后端打包引用）
├── wrangler.toml        # Pages/D1 绑定配置
└── start-website.bat    # Windows 双击启动
```

## 三、本地运行

前置：Node.js 18+（本机 24 已验证）。

**方式 A：双击 `start-website.bat`**（自动装依赖、构建、启动、打开浏览器）。

**方式 B：命令行**

```bash
npm install                      # 根目录：wrangler 等工具
npm run install:web              # 前端依赖
npm run build                    # 构建前端到 frontend/dist
npm run dev                      # 启动 http://127.0.0.1:8788（Workers + 本地 D1）
```

前端热更新开发（可选）：

```bash
npm run dev:web                  # Vite 开发服务器 http://localhost:5174（/api 代理到 8788）
npm run dev                      # 另开一个终端
```

**导入历史数据**（把旧站导出的 JSON 放在根目录，文件名含「算法雷达站数据」或叫 `data.json`）：

```bash
npm run seed                     # 已有站长时需 SEED_OWNER_PASSWORD=*** npm run seed
```

导入只写入测评记录；**题目与模型目录不自动填充**——登录站长后到审核台「未收录历史数据」里发布题目、
收录模型，旧数据才会逐步显示（推荐先用 replace 模式导入 → 再重新收录，保证干净起点）。

首次使用：打开 http://127.0.0.1:8788 → 「登录 / 注册」→「初始化站长」。

## 四、部署到 Cloudflare（Pages + D1）

```bash
npx wrangler login                                  # 1. 登录 Cloudflare
npx wrangler d1 create ai-vs-luogu                  # 2. 创建 D1 数据库
#    把返回的 database_id 填入 wrangler.toml
npm run deploy                                      # 3. 构建并部署（Pages 自动识别 functions/ 与 D1 绑定）
npx wrangler d1 execute DB --remote --file=db/schema.sql   # 4.（可选）远程建表；不执行也会在首个请求时自动建表
```

公网初始化站长（防止被抢注）：

```bash
npx wrangler pages secret put SETUP_TOKEN --project-name ai-vs-luogu   # 设置一个一次性口令
#    打开网站 → 登录/注册 → 初始化站长 → 填入该口令与站长账密
npx wrangler pages secret delete SETUP_TOKEN --project-name ai-vs-luogu  # 用完即删
```

- 数据导入：登录站长 → 顶栏「导入」→ 选择旧站导出 JSON（合并 / 覆盖两种模式）。
- 自定义域名、Git 集成部署均在 Cloudflare 控制台按 Pages 项目常规操作即可。

## 五、安全设计

- PBKDF2-SHA256（100k 迭代）口令哈希（WebCrypto；迭代次数是 Workers CPU 限额与安全的平衡点）。
- 会话 = HMAC-SHA256 签名令牌存 HttpOnly Cookie（12h，1h 自动续签）；密钥首次启动自动生成存 D1。**会话每次请求回查用户表**：改密（`password_version` 递增）、封禁、降权后旧令牌立即失效；登录用户可在顶栏「改密码」。
- CSRF 双提交（`radar_csrf` Cookie + `X-CSRF-Token` 头）；登录限流 6 次/10 分钟；洛谷抓取 30 次/分；写操作 60 次/分。
- 洛谷抓取：目标 host 编译期白名单（www.luogu.com.cn）+ 仅 https + 题号正则白名单 + 302 location 同样校验。
- 请求体限额：导入 16MB / 测评记录 2MB / 其他 64KB；所有写入经白名单清洗（长度/枚举/正则）。
- 待审核记录对游客与贡献者不可见；游客导出只含已审核数据。
- Pages 静态资源带 CSP（`_headers`）：`default-src 'none'; script-src 'self'; …`。

## 六、API 一览

公开：`GET /api/ping` `GET /api/session` `GET /api/data` `GET /api/models` `GET /api/contributors` `GET /api/export/public?format=csv|json`
认证：`POST /api/setup` `POST /api/login` `POST /api/logout` `POST /api/auth/register` `POST /api/change-password`（登录用户改密；成功后其他设备全部下线）
贡献者：`POST /api/records`（模型须已收录）
管理员：`PUT/DELETE /api/records/{id}`（DELETE=软删除入回收站） `POST /api/records/{id}/status` `POST /api/records/bulk`（reject=入回收站） `POST /api/problems`（发布） `PUT /api/problems/{pid}`（编辑） `DELETE /api/problems/{pid}` `POST/PUT/DELETE /api/models*` `GET /api/luogu?pid=` `GET /api/hidden-records` `GET /api/hidden-records/detail` `POST /api/admin/purge-records`（隐藏记录入回收站） `GET /api/trash` `POST /api/trash/restore|purge|empty` `GET /api/export`（全量含 models） `POST /api/import`
站长：`GET /api/admin/users` `POST /api/admin/users/{id}/approve|reject|role` `POST /api/catalog/reset`

## 七、数据模型（records 表核心字段）

`id`(16hex) · `model`(聚合主键) · `variant` · `agent` · `tokenSource` · `pid`+`title` · `thinking`(ultra>max>xhigh>high>medium>low>off) · `difficulty`(0–7) · `categories[]` · `submissions[]`(每轮 `score` 0–100 可空 / `result` AC|WA|TLE|MLE|RE|CE|未解出 / `note`) · `minutes` · `memory`(MB，可空) · `date` · `note` · `status`(approved|pending) · `author`(提供者登录 ID) + `author_id`(提供者用户 ID) + `reviewer_id`/`reviewed_at`(审核人) · `deleted_at`(软删除/回收站标记) · 时间戳。

`users` 表：`username`(登录 ID)、`nickname`(显示昵称)、`password_hash`(PBKDF2，非明文)、角色/状态/审批信息。`problems` 表额外含 `prompt`（推荐提示词，≤4000 字，统一测试口径）。

## 八、日常开发

```bash
./node_modules/.bin/tsc --noEmit     # worker TS 类型检查
npm --prefix frontend run build      # 前端构建（wrangler pages dev 直接读 dist）
```

注意：本机 Mimosa 安全钩子禁止通过 ZCode 的 Bash 执行 git commit/push——提交请在自己的终端手动执行。
