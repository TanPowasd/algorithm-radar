# AI vs 洛谷

多个 AI 模型在洛谷题目上的解题能力对比站。游客可浏览排名、下载数据；贡献者提交测评；管理员审核并发布题目；站长管理用户。

> v3.6 · 2026-09：前端 UI 整体重构（**只动 `frontend/`，后端逻辑与接口零改动**）——
> 「软件渲染管线」视觉语言（Chakra Petch + JetBrains Mono / 40px 栅格底纹 / 青·蓝·柠檬配色 / 顶栏 HUD 读数），
> 版心默认全宽铺满并可切限宽；新增 **ACM 滚榜** 视图（团队=模型、队员=思考等级，逐条回放 + 实时名次）；
> 矩阵新增「最佳等级 / 最佳分数」两口径（默认取该题该模型**思考等级最高**的那条）；
> 柱状/雷达/趋势统一「同厂商同色相、模型降明度、思考等级用透明度+斜纹」；三态主题（跟随系统/日/夜）；
> URL 同步视图状态 + 快捷键 + 十字高亮 + 提示词一键复制全站统一。详见「九、前端 UI 约定」。
> v3.7 · 2026-09 安全补丁（渗透测试修复）：**后端唯一语义变化**——贡献者提交测评不再把记录里的
> 题名/难度回写题目目录（目录仍是管理员的权威维护面，渗透报告 medium-1）；登录连续失败 5 次
> 锁定 15 分钟（跨 isolate 持久化 `login_guard` 表，medium-2）；`/api/setup` 限速 + SETUP_TOKEN
> 恒定时间比较 + 原子单 owner 创建（medium-4 / low-3）；Cookie 增 `Secure`（按请求协议：
> 仅 HTTPS 下发，本地 http://127.0.0.1 开发环境不携带）、静态响应增 HSTS
> 与 CSP `style-src-attr 'unsafe-inline'`（low-1 / low-6）；CSV 导出公式注入前缀防护（low-2）；
> 根目录 `node_modules/` 补进 `.gitignore`（medium-3）。
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
| 游客 | 浏览矩阵/雷达/柱状/趋势/榜单/滚榜六个分析视图与测评明细（仅收录制可见数据）；查看贡献者名册（按注册时间排序）；导出 CSV / JSON（仅收录且已审核数据）；**不可提交** |
| 贡献者 | 提交测评记录（仅可选**已发布题目**与**已收录模型**，题名/难度由题目目录带入且不可改，见「题目信息单一来源」，进入待审核队列）；可见自己的待审记录 |
| 管理员 | 审核测评（单条/批量通过、拒绝=移入回收站）；**删除任意测评记录**（含已通过记录：明细表逐条删除、勾选批量删除、题目抽屉内删除，均为软删除进回收站）；编辑记录；发布题目（收录：输题号自动抓洛谷，失败可手动补全；可配推荐提示词）；增删改 AI 模型（收录+改名）；**历史数据收录台**（未收录题目/模型的隐藏记录分组、一键收录、移入回收站）；**回收站管理**（恢复 / 永久删除 / 清空）；全量导出与导入；**删除已激活贡献者账号**（用户管理页，仅见贡献者列表）；查看操作审计 |
| 站长 | 管理员全部权限 + 审核注册（批准为贡献者）+ 任命/免除/**删除**管理员 + **清理任意非站长账号**（含待审/已拒）+ **清空目录重新收录**。站长删不掉、也不能删自己；所有敏感操作（删账号/删记录/清空目录/导入等）自动留痕到**操作审计** |

- 注册：独立页面 `/register`，填写 **用户 ID + 昵称 + 密码**；登录使用 **用户 ID + 密码**，全站显示昵称。注册后为「待审核」，站长在 `/users` 批准后才能登录。密码一律 PBKDF2-SHA256（100k 迭代）哈希存储，明文不落库。
- **删除账号**：管理员可删除**已激活贡献者**账号，站长可删除**任意非站长账号**（含管理员、待审与已拒——用于清理注册垃圾；均为物理删除、不可恢复，见 `/users` 用户管理页）。
  被删账号立即失效（会话令牌回查用户表查不到人），用户 ID 随之释放可重新注册（视为全新账号）；
  **其已提交的测评记录保留**——`records.author` 是用户名字符串快照不依赖用户表，名册上这些记录并入「全民制作人」；
  站长不可被删除，也不能删除自己的账号；每次删账号都写入**操作审计**（谁、何时、删了谁）。
- **改昵称**：任何登录用户经顶栏「账号设置」自助改昵称（1–24 字），显示名即时生效（会话每请求回查用户表，无需重新登录）。
- **操作审计（v3.8）**：`audit_log` 表只追加记录敏感操作——删账号、任免角色、批准/拒绝注册、删记录（软删）、批量移回收站、永久删除/清空回收站、删题目、删模型、清空目录、导入数据；
  管理员及以上在 `/users` 页底部只读查看最近 100 条（新→旧），动作名有中文映射，未知动作原样展示。
- 贡献者名册：`/contributors`（公开），按**注册时间**排序（与贡献量无关），展示用户 ID/昵称/贡献数等；历史导入数据对应的 `admin`/`guest` 账号排在末尾。
- 审计字段：每条测评记录带 `author_id`（提供者用户 ID）与 `reviewer_id`/`reviewed_at`（批准人用户 ID 与批准时间；管理员自己直接提交的记录自审自记）。**首次录入的历史数据没有这些 ID，提供者/审核人统一署名「全民制作人」**（名册中也合并为同一条目，按注册时间排在末尾）；待审核的记录审核人显示「待审核」。
- 推荐提示词：发布题目时填写（再次发布同题号可更新；发布弹窗内置「统一模板」一键填入），
  展示在**题目详情抽屉 / 提交测评表单 / 审核台题目表**三处，均带统一的「⧉ 一键复制」按钮，统一所有人的测试口径。
- **题目信息单一来源**：提交/编辑测评时，**题名与难度由「题目目录」带入并锁死**（虚线只读框 + 🔒 提示），
  提交者与管理员都不能在测评表单里改——要更正请到「题目管理 → 编辑」。算法类别同样在切换题目时按目录重置
  （仍可在其后追加/删除）。仅当目录里确实没有难度（如新抓取的题）时才允许手动选择难度，并提示补全目录。
  从矩阵格子的「+」进入时，题号锁定且题名/难度**在弹窗打开的瞬间就已填好**（历史缺陷：需手动重选一次题目才填）。
- **三区数据（v3.5）**：显示区=已收录+已审核（访客可见）；隐藏区=已审核但未收录（保留待收录，管理员可在
  「未收录历史数据」查看、一键发布/收录或移入回收站）；回收站=删除/拒绝的记录（软删除 `deleted_at`，
  支持恢复/永久删除/清空）。待审核记录不因未收录而隐藏：管理员可见全部待审，提交者可见自己的待审。
- **收录制口径（v3.4）**：历史/导入数据统一署名「全民制作人」（记录里无提供者/审核人 ID 时）。任何记录只有在
  「题目已发布（收录）且模型已收录」时才计入统计/榜单/公开导出。管理员 `/api/export` 全量备份可见（不含回收站）。
- 站长产生：数据库无任何账号时，本地访问会显示「初始化站长」入口（仅一次）；公网部署时需配置 `SETUP_TOKEN`（见下文）。
- 数据口径：聚合主键 = 模型名（版本/策略仅展示）；**无分数轮次（score=null）不计入任何均分、不按 0 计**；柱状图「模型 × 思考等级」组合的最小样本量 **n 由用户在界面上调（1–50，默认 5，记忆在本地）**；雷达 AC 率按「作答记录数」为分母。

## 二、目录结构

```
├── frontend/            # React 19 + Vite SPA（构建产物部署到 Cloudflare Pages）
│   ├── src/             #   api/ 客户端 · state/ 全局状态 · views/ 六视图 · pages/ 五页面
│   │   ├── palette.js   #     厂商色相/思考等级纹理（同厂商同色相，等级用透明度+斜纹）
│   │   ├── rollboard.js #     滚榜事件流与快照（团队=模型、队员=思考等级）
│   │   ├── hooks/       #     useUrlState（视图状态同步 URL）· useHotkeys · copyText
│   │   └── components/  #     Hud · CopyButton · TimeCell · ShortcutHelp · ModelFilter …
│   ├── selftest/        #   Node 里跑的真实渲染 + 口径断言（fixture.json 为固定样本）
│   └── scripts/         #   make-fixture.mjs（裁剪样本）· check-classes.mjs（类名契约检查）
├── functions/           # Cloudflare Pages Functions：/api/* 全部路由（Workers）
│   └── api/[[route]].ts
├── worker/              # 共享后端逻辑（TypeScript）：auth（PBKDF2+HMAC 会话）、
│                        # store（D1 存取/审核/导入）、luogu（洛谷抓取+SSRF 防护）、router
├── db/schema.sql        # D1 表结构（幂等；Functions 首次请求自动建表）
├── scripts/seed.mjs     # 本地种子：初始化站长 + 导入历史数据 JSON
├── scripts/e2e.mjs      # 端到端权限矩阵自检（隔离临时 D1 + 8799 端口，跑完即清理）：npm run e2e
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
认证：`POST /api/setup` `POST /api/login` `POST /api/logout` `POST /api/auth/register` `POST /api/change-password`（登录用户改密；成功后其他设备全部下线） `POST /api/profile/nickname`（自助改昵称，即时生效）
贡献者：`POST /api/records`（模型须已收录）
管理员：`PUT/DELETE /api/records/{id}`（DELETE=软删除入回收站） `POST /api/records/{id}/status` `POST /api/records/bulk`（reject=入回收站） `POST /api/problems`（发布） `PUT /api/problems/{pid}`（编辑） `DELETE /api/problems/{pid}` `POST/PUT/DELETE /api/models*` `GET /api/luogu?pid=` `GET /api/hidden-records` `GET /api/hidden-records/detail` `POST /api/admin/purge-records`（隐藏记录入回收站） `GET /api/trash` `POST /api/trash/restore|purge|empty` `GET /api/export`（全量含 models） `POST /api/import` `DELETE /api/admin/users/{id}`（删账号：管理员删已激活贡献者，站长可删任意非站长） `GET /api/admin/audit`（操作审计，最近 100 条）
站长：`GET /api/admin/users`（管理员调用时仅返回已激活贡献者） `POST /api/admin/users/{id}/approve|reject|role` `POST /api/catalog/reset`

## 七、数据模型（records 表核心字段）

`id`(16hex) · `model`(聚合主键) · `variant` · `agent` · `tokenSource` · `pid`+`title` · `thinking`(ultra>max>xhigh>high>medium>low>off) · `difficulty`(0–7) · `categories[]` · `submissions[]`(每轮 `score` 0–100 可空 / `result` AC|WA|TLE|MLE|RE|CE|未解出 / `note`) · `minutes` · `memory`(MB，可空) · `date` · `note` · `status`(approved|pending) · `author`(提供者登录 ID) + `author_id`(提供者用户 ID) + `reviewer_id`/`reviewed_at`(审核人) · `deleted_at`(软删除/回收站标记) · 时间戳。

`users` 表：`username`(登录 ID)、`nickname`(显示昵称)、`password_hash`(PBKDF2，非明文)、角色/状态/审批信息。`problems` 表额外含 `prompt`（推荐提示词，≤4000 字，统一测试口径）。`audit_log` 表：`actor_id`/`actor`(操作人)、`action`(动作)、`detail`(详情，≤500 字)、`created_at`，只追加不修改。

## 八、日常开发

```bash
./node_modules/.bin/tsc --noEmit          # worker TS 类型检查
npm --prefix frontend run build           # 前端构建（wrangler pages dev 直接读 dist）
npm --prefix frontend run lint            # oxlint
npm --prefix frontend run selftest        # 口径断言 + 六视图真实渲染冒烟（Node 内跑，48 项）
npm --prefix frontend run check-classes   # JSX 类名 vs styles.css 契约检查（防漏样式）
npm run e2e                               # 构建 + 权限矩阵端到端自检（隔离临时环境，46 项）
npm --prefix frontend run selftest:fixture # 从根目录最新导出快照重裁自检样本
```

`selftest` 不依赖浏览器：把 `App` 连同 `AppProvider` 在 Node 里 `renderToString`，
用 `localStorage` 垫片喂入固定样本，逐视图断言 DOM 里确实出现了「最佳等级/最佳分数」口径、
十字高亮的 `data-r/data-c` 坐标、滚榜控制条与名次位移、明细两行时间、提示词与一键复制等。
后端口径（厂商同色、思考等级取法、无分数轮次不计、滚榜排名与单调性）也都在同一处断言。

样本有两份：`selftest/fixture.basic.json` 是**纯合成**样本（固定种子可复现，随仓库入库，克隆后即可跑）；
`selftest/fixture.json` 是从本地导出快照裁剪的**真实**样本（含真实数据，已在 `.gitignore` 里排除）。
存在后者时优先用它；想刷新就执行 `npm --prefix frontend run selftest:fixture`（需仓库根有 `算法雷达站数据_*.json`）。

## 九、前端 UI 约定（v3.6）

- **版心**：默认全宽铺满；顶栏 ⤢ 可切「限宽居中」（1400px），选择记在 `localStorage`，渲染前由 `main.jsx`
  预涂 `data-width`，不闪动。审核台/用户管理/注册/贡献者名册共用同一 `.layout`。
- **主题**：三态「跟随系统 / 夜 / 日」（顶栏 ◐☀☾ 或快捷键 `T`），`prefers-color-scheme` 变化实时跟随；
  预涂 `data-theme` 防首屏闪。图表取色统一走 `themeColors()` 读 CSS 变量，两套主题自动生效。
  旧值兼容：`localStorage.radar.theme` 里历史写入的 `dark|light` 仍可用（新增 `system`）。
- **配色语义**：厂商定色相（`palette.js`，目录里 `vendor` 字段优先，缺失时按模型名正则推断），
  同厂商不同模型降明度、思考等级用「透明度 + 斜纹密度」区分（柱状图由 Chart.js 插件在画布上直接铺斜纹，
  避免贴图接缝）。绿=通过 / 橙=中等 / 红=未过 的语义色保持不变。
- **雷达图**：自动隐藏无可见数据的轴；正方形舞台居中，尺寸滑杆（记忆 `radar.radarSize`）+ ⛶ 全屏。
- **柱状图**：最小样本量滑杆 1–50（默认 5，记忆 `radar.bar.minSamples`），旁边实时显示「满足 X / 共 Y」。
- **矩阵**：口径按钮 `最佳等级(默认) / 最佳分数 / 全轮均分 / 最终分 / 通过状态`；最佳口径的格子右上角标注该分数来自哪个思考等级。
- **滚榜**：时间轴 = 已审核记录的 `createdAt` 逐条推进；受全局模型筛选约束；
  排名口径 **解题数 → 各题最好成绩均值 → 达成时间**；空格播放/暂停，`← →` 单步，`J` 下一个 AC，`D` 推进一天。
- **明细时间**：一行两排——上=测评日期 `date`，下=录入时分 `createdAt`（`TimeCell` 组件，全站统一）。
- **题号外链（v3.7）**：全站题号统一由 `components/PidLink.jsx` 渲染为洛谷链接
  （`https://www.luogu.com.cn/problem/<PID>`，新标签页 + `rel="noopener noreferrer"`），
  点一下直接去洛谷看原题。地址拼装走 `aggregate.js` 的 `luoguUrl()`：题号统一大写、不合 `PID_RE` 时
  返回 `null` 并降级为纯文本，**不拼死链**。覆盖矩阵行头、明细表、滚榜列头、题目抽屉标题、
  审核台（待审 / 题目管理 / 未收录题目 / 隐藏记录 / 回收站）与首页待审预览。
  明细表的题号改为外链后，打开**本站详情抽屉**的入口移到题名（`.pid-detail`）上，两个能力都保留。
  嵌在可点击容器里（矩阵行头）时组件不自行阻止冒泡，由调用方 `stopPropagation()`。
- **交互**：视图与口径状态写进 URL（`?v=`、`mx:`、`rd:`、`br:`、`tr:`、`lb:`、`rec:` 命名空间），刷新/分享保现场；
  右下角 `?` 面板列出快捷键；矩阵悬停十字高亮，空格子在贡献者视角下就地「+ 快速提单」；
  表头行头 sticky；模型筛选器支持搜索、厂商分组多选、反选。
- **删除测评记录（管理员 / 站长）**：纯前端能力，复用既有 `DELETE /api/records/{id}` 与
  `POST /api/records/bulk {action:'reject'}`，**软删除进回收站**（不是物理删除，可在审核台回收站恢复或永久清除）。
  三个入口：测评明细逐条「删除」、明细勾选「删除所选（移入回收站）」（表头复选框 = 全选本页）、
  题目详情抽屉里每条记录的「删除」。按钮由 `DeleteRecordButton` 统一封装：非管理员直接不渲染，
  二次确认里列出模型·题号·思考等级·日期·提供者并写明可恢复，删除后 `refreshAll()` 立即刷新全站统计。
  后端 `requireRole(ctx,'admin')` 对站长（rank 3）与管理员（rank 2）同样放行，故两种身份都能删；贡献者与游客看不到入口。
- **本地存储键**（改名即破坏兼容，勿随意变更）：`radar.cache.v3` · `radar.theme` · `radar.focusModels` ·
  `radar.widthMode` · `radar.bar.minSamples` · `radar.radarSize` · `radar.bar.excludedPids` · `radar.notice.dismissedDay`。
- **字体**：Chakra Petch（标题）+ JetBrains Mono（正文）经 `@fontsource` 自托管打进 `dist/assets`，
  满足 CSP 的 `font-src 'self'`，不外链任何第三方资源。

---

注意：本机 Mimosa 安全钩子禁止通过 ZCode 的 Bash 执行 git commit/push——提交请在自己的终端手动执行。
