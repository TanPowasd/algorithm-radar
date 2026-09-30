# 项目地图 · k4u.top（站点自称「AI vs 洛谷 / 算法雷达站」）

> 用途：下一轮开发**只看本文件**就能定位「要加某个功能该动哪个文件」，不必重新通读全库。
> 本轮为**只读通读**；唯一的写盘动作 = 生成本文件，仓库内既有文件全部保持原样（未修改/未创建/未删除/未重命名）。
> 路径约定：以下所有路径都相对站点根 `C:\Users\TanPowasd\Desktop\算法雷达站`，按 Windows 反斜杠原样书写；每条路径均已实测存在（见 §12）。
> 通行规则：凡未读到 / 读不懂 / 有多种解释的，一律标注「未确认」并附原文片段，不做合理补全（见 §13）。

---

## 0. 站点身份（先确认这是什么站）

| 项 | 结论 | 依据 |
|---|---|---|
| 线上主域 | k4u.top（Worker 自定义域，custom_domain = true） | `wrangler.toml` 第 14 行 |
| Worker 项目名 | ai-vs-luogu | `wrangler.toml` 第 6 行 |
| Pages 项目名（可选兼容入口） | ai-vs-luogu-pages | `pages\wrangler.toml` 第 4 行 |
| 站点标题 | 算法雷达站 · AI vs 洛谷 | `frontend\index.html` 第 13 行 |
| 根包名 / 版本 | ai-vs-luogu（3.0.0，private） | `package.json` 第 2-4 行 |
| 部署形态 | Cloudflare Workers 单部署：静态资产 + `\/api/*` Worker + D1 + R2 + Cron + 原生限流 | `wrangler.toml` 第 1-2 行注释 |
| Pages 形态 | 只做 `\/api/*` 同源转发到同一 Worker，不绑库、无 Cron | `pages\functions\api\[[path]].ts` |
| 站点一句话功能 | 多个 AI 模型在洛谷题目上的解题能力对比站 | `package.json` description / `README.md` 第 3 行 |

关键文件：`wrangler.toml` · `package.json` · `README.md`

---

## 1. 目录树（三层）

`
算法雷达站\                       ← 站点根 = Git 仓库根（本次通读根）
├── worker\                      (10 个 .ts)  API 后端：入口/路由/鉴权/D1 存取/快照/洛谷抓取/建表/工具
│   ├── index.ts                 入口：/api/* 分流 + scheduled 快照
│   ├── router.ts                824 行，42 条 API 路由 + CSRF/限流/错误归一
│   ├── auth.ts                  426 行，PBKDF2 + HMAC 会话、用户表操作
│   ├── store.ts                 999 行，D1 读写/审核/导入导出/审计/CSV
│   ├── schema.ts                100 行，内联建表语句（供 ensureSchema）
│   ├── ensureSchema.ts          82 行，版本门控 + 增量 ALTER 迁移
│   ├── snapshot.ts              60 行，全库 JSON → R2（90 天保留）
│   ├── luogu.ts                 282 行，洛谷抓题 + SSRF 白名单 + 标签归类
│   ├── util.ts                  274 行，共享类型与字段清洗白名单
│   └── types.d.ts               *.sql 文本导入的类型声明
├── pages\                       (3)  可选 Cloudflare Pages 入口
│   ├── functions\api\[[path]].ts  (1)  Pages Function：/api/* 转发到 Worker
│   ├── pages-env.d.ts           (1)  wrangler types 生成的绑定类型（API: Fetcher）
│   └── wrangler.toml            (1)  Pages 配置
├── frontend\                    (140 项)  Vite + React 19 SPA
│   ├── src\                     (50 个源文件)
│   │   ├── api\client.js        (1)  fetch 封装 + CSRF 头 + 下载
│   │   ├── components\          (24) 见 §5
│   │   ├── hooks\               (4)  copyText / useDialog / useHotkeys / useUrlState
│   │   ├── pages\               (6)  Home / Admin / Users / Register / Contributors / Prompts
│   │   ├── views\               (7)  Matrix / Radar / Bar / Leaderboard / RollBoard / Insight / RecordsTable
│   │   ├── App.jsx              路由表 + 全局挂件
│   │   ├── main.jsx             首帧主题/版心注入 + 字体与样式引入
│   │   ├── state.jsx            344 行全局状态（会话/数据/主题/筛选/缓存）
│   │   ├── styles.css           1173 行，唯一全局样式表（含主题变量与断点）
│   │   ├── aggregate.js         统计口径与业务计算
│   │   ├── palette.js           厂商色相/思考等级纹理
│   │   ├── rollboard.js         滚榜事件流与快照
│   │   └── refreshCoordinator.js 刷新单飞/节流
│   ├── public\                  (4)  _headers / _redirects / favicon.svg / icons.svg
│   ├── scripts\                 (2)  check-classes.mjs / make-fixture.mjs
│   ├── selftest\                (3)  entry.jsx / fixture.basic.json / fixture.json
│   ├── dist\                    (19) 构建产物（.gitignore 排除，wrangler assets 托管）
│   └── index.html / package.json / vite.config.js / vite.demo.config.mjs / vite.selftest.config.mjs / .oxlintrc.json / README.md / .gitignore
├── db\schema.sql                (1)  D1 表结构（104 行，须与 worker\schema.ts 同步）
├── docs\                        (2)  BACKEND_REVIEW.md（231 行）/ UI_REFACTOR.md（71 行）
├── scripts\                     (2)  e2e.mjs（409 行）/ seed.mjs（140 行）
├── functions\api\              (0)  ★空目录，无任何函数文件（遗留，见 §13-4）
├── tags.json                    (1)  洛谷标签映射种子 31.9KB，被 worker\luogu.ts 导入
├── 算法雷达站数据_20260902.json   (1)  历史导出快照 85.2KB / 200 行（.gitignore 排除）
└── package.json / package-lock.json / tsconfig.json / README.md（328 行）/ .gitignore / start-website.bat（35 行）/ wrangler.toml / wrangler.log / opencode.jsonc
`

### 被排除、未纳入地图的目录/文件

| 路径 | 规模 | 排除原因 |
|---|---|---|
| `node_modules\` | 根依赖 | 第三方依赖 |
| `frontend\node_modules\` | 前端依赖 | 第三方依赖 |
| `.git\` | 版本库 | 版本历史，本轮不通读 |
| `frontend\dist\` | 19 文件 | 构建产物（清单见 §8） |
| `.wrangler\` | 本地状态 | wrangler dev / e2e 临时 bundle 与本地 D1/R2 状态 |
| `frontend\.selftest\` | 构建产物 | vite selftest 的 SSR bundle |
| `.pt-tmp\` | 11 文件 | 本地接口验证样本；含 Cookie 罐 `jar*.txt`（疑似凭据）→ **存在，已跳过**，未读内容 |
| `.mimosa\` / `frontend\.mimosa\` / `worker\.mimosa\` | 34 / 29 / 10 项 | AI 编码工具的会话与审计元数据，非项目文件 |
| `.workbuddy\` / `.zcode\` | 3 / 2 项 | 同上（AI 工具记忆与计划文件） |
| `wrangler.log` | 12.6KB | 本地运行日志（.gitignore 排除） |
| `frontend\selftest\fixture.json` | 1 | .gitignore 排除的「含真实数据」自检样本 |
| `data.json` / `credentials.json` / `.dev.vars` | 0 命中 | .gitignore 声明的运行时凭据；**实测不存在**，故地图不列 |

按文件名规则（`.env` / `.env.*` / `.dev.vars` / `credentials.json` / `*.pem` / `*.key`）递归查找：**0 命中**。
关键文件：`package.json` · `wrangler.toml` · `README.md` · `.gitignore`

---

## 2. 技术栈与构建

| 项 | 结论 | 依据 |
|---|---|---|
| 前端框架 | React 19.2.8 + react-dom 19.2.8 | `frontend\package.json` dependencies |
| 路由 | react-router-dom 7.9.0（BrowserRouter） | `frontend\src\main.jsx` 第 4 行 |
| 图表 | chart.js 4.5.0 | `frontend\package.json` dependencies |
| 字体包 | @fontsource/chakra-petch 5.3.0、@fontsource/jetbrains-mono 5.3.0 | `frontend\package.json` dependencies |
| 构建器 | Vite 8.2.2 + @vitejs/plugin-react 6.1.0 | `frontend\package.json` devDependencies |
| Lint | oxlint 1.79.0（配置 `frontend\.oxlintrc.json`） | `frontend\package.json` scripts.lint |
| 后端 | Cloudflare Workers（TypeScript 5.6，wrangler 4.127.1，@cloudflare/workers-types ^5.20260828.1） | `package.json` devDependencies |
| 数据存储 | D1（SQLite）+ R2（快照桶）+ Cron Trigger + 原生 Rate Limiting | `wrangler.toml` |
| 包管理器 | **npm**（根与前端各有一份 package-lock.json；无 pnpm-lock.yaml / yarn.lock） | `package-lock.json`、`frontend\package-lock.json` |
| 构建输出目录 | `frontend\dist\`（本机已存在，19 个文件；wrangler assets.directory = ./frontend/dist） | `wrangler.toml` [assets] |
| 前端构建命令 | vite build（无自定义 outDir） | `frontend\package.json` scripts.build |
| 后端「构建」 | 无独立编译步骤：`main = "worker/index.ts"` 由 wrangler 直接打包 TS | `wrangler.toml` 第 7 行 |
| Node 版本要求 | **未确认**：无 `.nvmrc`，`package.json` 无 `engines` 字段。可读到的旁证：`start-website.bat` 第 12 行「请先安装 Node 18+」，`frontend\vite.selftest.config.mjs` 第 12 行 target: 'node22' | — |

### 根 `package.json` scripts（原样抄）

`
install:web      npm --prefix frontend install
dev:web          npm --prefix frontend run dev
dev              wrangler dev --port 8788
dev:full         npm run build && concurrently -k "npm:dev:web" "npm:dev" 
build            npm --prefix frontend run build
typecheck        tsc --noEmit
lint:web         npm --prefix frontend run lint
selftest:web     npm --prefix frontend run selftest
seed             node scripts/seed.mjs
e2e              npm run build && node scripts/e2e.mjs
e2e:pages        npm run build && node scripts/e2e.mjs --pages
check            npm run typecheck && npm run e2e
deploy           npm run build && wrangler deploy
dev:pages        wrangler pages dev --cwd pages --port 8789
build:pages      npm run build && wrangler pages functions build pages/functions --outdir .wrangler/pages-build
deploy:pages     npm run build && wrangler pages deploy --cwd pages
types:pages      wrangler types pages/pages-env.d.ts --config pages/wrangler.toml --env-interface PagesEnv --include-runtime false
d1:init:local    wrangler d1 execute DB --local --file=db/schema.sql
d1:init:remote   wrangler d1 execute DB --remote --file=db/schema.sql
`

**已发现的脚本缺陷**：`dev:full` 调用 `concurrently`，但 `package.json` 未声明该依赖，根与前端 `node_modules` 下均不存在（实测 `node_modules\concurrently` = False）。该命令**大概率直接报错**（未实际运行，属静态核对）。

### frontend `package.json` scripts（原样抄）

`
dev              vite
demo             vite --config vite.demo.config.mjs
build            vite build
lint             oxlint
preview          vite preview
selftest         vite build --config vite.selftest.config.mjs && node .selftest/entry.mjs
selftest:fixture node scripts/make-fixture.mjs
check-classes    node scripts/check-classes.mjs
`

关键文件：`package.json` · `frontend\package.json` · `frontend\vite.config.js` · `tsconfig.json`

---

## 3. Cloudflare 相关

### 3.1 主配置 `wrangler.toml`（Workers，生产）

| 键 | 值 |
|---|---|
| name | ai-vs-luogu |
| main | worker/index.ts |
| compatibility_date | 2026-09-01 |
| workers_dev | true |
| routes | `{ pattern = "k4u.top", custom_domain = true }` |
| assets.directory | ./frontend/dist |
| assets.binding | ASSETS |
| assets.not_found_handling | single-page-application |
| d1_databases | binding **DB**，database_name ai-vs-luogu，database_id 709c23c0-9908-40d2-982b-94bcc5e4cfff |
| triggers.crons | `0 21 * * *`（UTC 21:00 = 北京 05:00，每日快照） |
| ratelimits #1 | name **WRITE_LIMIT**，namespace_id 1001，limit 200 / period 60 |
| ratelimits #2 | name **AUTH_LIMIT**，namespace_id 1002，limit 30 / period 60 |
| r2_buckets | binding **SNAPSHOT_BUCKET**，bucket_name ai-vs-luogu-backups |
| vars | 仅 `SETUP_TOKEN` 一行，且被注释（推荐改用 `wrangler secret put SETUP_TOKEN`） |

### 3.2 `pages\wrangler.toml`（可选 Pages 入口）

| 键 | 值 |
|---|---|
| name | ai-vs-luogu-pages |
| pages_build_output_dir | ../frontend/dist |
| compatibility_date | 2026-09-01 |
| services | binding **API** → service ai-vs-luogu（同一 Worker，不建第二套库） |

### 3.3 绑定变量名汇总（只记名，不记值）

| 绑定 | 类型 | 出现位置 |
|---|---|---|
| ASSETS | Fetcher（静态资产） | `wrangler.toml` / `worker\router.ts` Env 接口第 18 行 |
| DB | D1Database | `wrangler.toml` / Env 第 17 行 |
| SNAPSHOT_BUCKET | R2Bucket（可选） | `wrangler.toml` / Env 第 24 行 |
| WRITE_LIMIT / AUTH_LIMIT | RateLimit（可选） | `wrangler.toml` / Env 第 20-21 行 |
| SETUP_TOKEN | secret（可选，一次性站长初始化口令） | Env 第 26 行 |
| API | Fetcher（仅 Pages 侧） | `pages\pages-env.d.ts` 第 4 行 |

Cookie/头常量（值即名字本身，非机密）：`radar_session`、`radar_csrf`、`X-CSRF-Token` —— `worker\auth.ts` 第 25-27 行。
**KV：无**（全仓库无 `kv_namespaces` 配置）。

### 3.4 静态资源侧配置

| 文件 | 现状 | 关键内容 |
|---|---|---|
| `frontend\public\_headers` | 存在（6 行） | X-Content-Type-Options: nosniff / Referrer-Policy / X-Frame-Options: DENY / HSTS / CSP（default-src 'none'；connect-src 'self'） |
| `frontend\public\_redirects` | 存在（仅注释，无规则） | 明确写「SPA 回退交给 assets.not_found_handling，不要再写 /* /index.html 200（会被判无限循环，部署报 100324）」 |
| `_routes.json` | **无**（全仓库 0 命中） | — |
| 根 `functions\` 目录 | 存在但只有空目录 `functions\api\` | **无函数文件**，不产生任何路由 |
| `pages\functions\api\[[path]].ts` | Pages Function（9 行） | 路由 **/api/\***：`context.env.API.fetch(context.request)` 原样转发（含 Cookie/CSRF/流式响应） |

关键文件：`wrangler.toml` · `pages\wrangler.toml` · `frontend\public\_headers` · `frontend\public\_redirects` · `pages\functions\api\[[path]].ts`

---

## 4. 路由清单

### 4.1 页面路由（React SPA；构建后由 not_found_handling = single-page-application 回退到 index.html）

| 线上 URL | 源文件 | 说明 |
|---|---|---|
| `\/` | `frontend\src\pages\HomePage.jsx` | 总览：统计带 + 六个分析视图 + 测评明细 + 待审预览 |
| `\/admin` | `frontend\src\pages\AdminPage.jsx` | 审核台：待审/隐藏区/回收站/题目发布/模型目录/导入 |
| `\/users` | `frontend\src\pages\UsersPage.jsx` | 用户与审计（仅管理员/站长） |
| `\/register` | `frontend\src\pages\RegisterPage.jsx` | 独立注册页（提交后待站长审核） |
| `\/contributors` | `frontend\src\pages\ContributorsPage.jsx` | 贡献者名册（按注册时间排序，可切换全站视角） |
| `\/prompts` | `frontend\src\pages\PromptsPage.jsx` | 推荐提示词模板页（按题目查看/复制） |
| 其它任意路径 | `frontend\src\pages\HomePage.jsx` | `<Route path="*" element={<HomePage />} />`（`frontend\src\App.jsx` 第 25 行） |

**唯一 HTML 页面**：`frontend\index.html`（16 行，挂载 /src/main.jsx）。仓库内没有第二张 HTML 页面（`frontend\dist\index.html` 是同一张的构建产物）。

### 4.2 API 路由（`worker\router.ts`，共 42 条；role = 所需最低角色，null = 游客可访问）

| # | 方法 | 路径 | 最低角色 | 定义行 |
|---|---|---|---|---|
| 1 | GET | `\/api/ping` | 游客 | 248 |
| 2 | GET | `\/api/session` | 游客 | 255 |
| 3 | POST | `\/api/setup` | 游客（一次性口令） | 274 |
| 4 | POST | `\/api/login` | 游客 | 298 |
| 5 | POST | `\/api/logout` | 游客 | 309 |
| 6 | POST | `\/api/change-password` | contributor | 316 |
| 7 | POST | `\/api/profile/nickname` | contributor | 329 |
| 8 | POST | `\/api/auth/register` | 游客 | 335 |
| 9 | GET | `\/api/data` | 游客（ETag/304） | 348 |
| 10 | POST | `\/api/records` | contributor | 372 |
| 11 | PUT | `\/api/records/:id` | contributor（支持 baseUpdatedAt 乐观并发） | 383 |
| 12 | DELETE | `\/api/records/:id` | admin | 403 |
| 13 | GET | `\/api/trash` | admin | 411 |
| 14 | POST | `\/api/trash/restore` | admin | 416 |
| 15 | POST | `\/api/trash/purge` | admin | 424 |
| 16 | POST | `\/api/trash/empty` | admin | 432 |
| 17 | POST | `\/api/records/:id/status` | admin | 439 |
| 18 | POST | `\/api/records/bulk` | admin | 445 |
| 19 | POST | `\/api/problems` | admin | 455 |
| 20 | PUT | `\/api/problems/:pid` | admin | 466 |
| 21 | DELETE | `\/api/problems/:pid` | admin | 474 |
| 22 | GET | `\/api/models` | 游客 | 481 |
| 23 | GET | `\/api/contributors` | 游客 | 488 |
| 24 | POST | `\/api/models` | admin | 522 |
| 25 | PUT | `\/api/models/:id` | admin | 529 |
| 26 | DELETE | `\/api/models/:id` | admin | 540 |
| 27 | GET | `\/api/admin/users` | admin | 550 |
| 28 | POST | `\/api/admin/users/:id/approve` | owner | 559 |
| 29 | POST | `\/api/admin/users/:id/reject` | owner | 567 |
| 30 | POST | `\/api/admin/users/:id/role` | owner | 575 |
| 31 | DELETE | `\/api/admin/users/:id` | admin | 586 |
| 32 | GET | `\/api/admin/audit` | admin | 595 |
| 33 | GET | `\/api/luogu` | admin（抓洛谷题） | 600 |
| 34 | GET | `\/api/export` | admin（全量导出） | 611 |
| 35 | GET | `\/api/hidden-records` | admin | 622 |
| 36 | GET | `\/api/hidden-records/detail` | admin | 629 |
| 37 | POST | `\/api/admin/purge-records` | admin | 635 |
| 38 | POST | `\/api/catalog/reset` | owner | 644 |
| 39 | POST | `\/api/admin/snapshot` | owner | 652 |
| 40 | POST | `\/api/admin/backfill-content` | admin | 662 |
| 41 | GET | `\/api/export/public` | 游客（公开 CSV/JSON） | 672 |
| 42 | POST | `\/api/import` | admin | 698 |

入口分流规则：任意大小写形式的 /api 或 /api/... 交 `handleApi`；其余全部 `env.ASSETS.fetch(req)`（`worker\index.ts` 第 10-15 行）。
关键文件：`frontend\src\App.jsx` · `worker\router.ts` · `worker\index.ts` · `pages\functions\api\[[path]].ts`

---

## 5. 布局与组件

| 角色 | 文件 | 说明 |
|---|---|---|
| HTML 外壳 | `frontend\index.html` | lang=zh-CN、viewport、description、color-scheme、内联 SVG favicon、#root |
| 应用装配 | `frontend\src\main.jsx` | BrowserRouter + AppProvider + 6 个字体 CSS + styles.css；首帧写 html 的 data-theme/data-theme-mode/data-width |
| 路由与全局挂件 | `frontend\src\App.jsx` | 6 条 Route + ErrorBoundary + ToastHost + BackTop + ShortcutHelp |
| 全局状态 | `frontend\src\state.jsx` | 会话、数据与本地缓存、主题三态、版心、筛选、toast、刷新协调 |
| 公共顶栏 | `frontend\src\components\Topbar.jsx` | 品牌链接、/contributors /prompts /admin /users /register 导航、主题/版心切换、工具菜单、账号菜单、HUD |
| 页脚 | **无独立组件** | 各页内联 footer.foot：`frontend\src\pages\HomePage.jsx` 217、`AdminPage.jsx` 711、`ContributorsPage.jsx` 121、`UsersPage.jsx` 167 与 253 |
| 公共布局类 | `frontend\src\styles.css` | .layout / .home-layout；限宽见 `styles.css` 第 245 行 |

### 可复用组件（`frontend\src\components\`，24 个文件）

| 文件 | 用途 |
|---|---|
| AuthModal.jsx | 登录/初始化站长弹窗（登录失败锁定提示、跳注册） |
| BackTop.jsx | 回到顶部浮动按钮 |
| ChangePasswordModal.jsx | 账号设置：改密码 |
| ContributorFilter.jsx | 全站「贡献者视角」筛选条 |
| CopyButton.jsx | 通用复制按钮（基于 hooks/copyText） |
| DeleteRecordButton.jsx | 记录删除确认按钮 |
| ErrorBoundary.jsx | 全局错误边界 |
| Hud.jsx | 顶栏运行读数（FPS/样本数等），<=900px 隐藏 |
| ImportModal.jsx | 历史数据导入（merge / replace） |
| ModelFilter.jsx | 模型聚焦筛选 |
| Notice.jsx | 可展开/可关闭的数据说明（按天或按会话记忆） |
| PidLink.jsx | 题号链接（跳洛谷 + 站内详情） |
| ProblemDrawer.jsx | 题目详情抽屉（各模型作答对比） |
| PromptCopyButton.jsx | 提示词复制（可选模型，注入/保留 {模型id} 占位符） |
| PublishModal.jsx | 题目发布/编辑（抓洛谷、难度、附件标记、题面） |
| RecordFormModal.jsx | 提交/编辑测评记录 |
| SeriesLegend.jsx | 图表图例（厂商色相 + 思考等级纹理） |
| ShortcutHelp.jsx | 快捷键帮助，支持 extra 扩展 |
| StatsBar.jsx | 顶部连续统计数据带 |
| TimeCell.jsx | 统一时间显示（上日期下时分） |
| ToastHost.jsx | 全局 toast 宿主 |
| Topbar.jsx | 见上 |
| ViewTabs.jsx | 分析视图标签（方向键/Home/End 支持） |
| charts.jsx | chart.js 封装：cssVar() / makeChart() / themeColors() |

### Hooks（`frontend\src\hooks\`，4 个）

| 文件 | 用途 |
|---|---|
| copyText.js | 剪贴板复制（clipboard API → textarea 回退） |
| useDialog.js | 弹层焦点管理 + Esc + 滚动锁 |
| useHotkeys.js | 全局快捷键绑定（弹层打开时不触发） |
| useUrlState.js | 视图/筛选状态同步到 URL（前缀参数） |

### 分析视图（`frontend\src\views\`，7 个）

| 文件 | 用途 |
|---|---|
| MatrixView.jsx | 矩阵（多口径单元格、题目查找、十字高亮） |
| RadarView.jsx | 雷达图（按算法大类，chart.js） |
| BarView.jsx | 柱状图（思考等级分组，可排除题目，MAX_N = 50） |
| LeaderboardView.jsx | 榜单（多指标排行、模型明细） |
| RollBoardView.jsx | ACM 滚榜回放（团队=模型、队员=思考等级，速度 1/2/4/8/16） |
| InsightView.jsx | 洞察：模型稳定性 / 题目区分度 / 思考等级收益 |
| RecordsTable.jsx | 测评明细表（搜索、批量选择、编辑/删除入口） |

关键文件：`frontend\src\App.jsx` · `frontend\src\components\Topbar.jsx` · `frontend\src\state.jsx`

---

## 6. 样式

| 项 | 结论 | 依据 |
|---|---|---|
| 方案 | **单文件全局 CSS**：`frontend\src\styles.css`（1173 行，59 个 CSS 变量声明） | 无 Tailwind/CSS Modules/styled-components 依赖 |
| 引入点 | `frontend\src\main.jsx` 第 14 行 import './styles.css' | — |
| 变量命名 | .num/table.data td.num/td.mcell/.s-value/.mrank 等用数字等宽；类名是组件间公共契约（styles.css 第 5 行注释） | — |
| 主题开关 | html 的 data-theme="dark|light" + data-theme-mode="system|light|dark"；首帧由 `main.jsx` 第 18-30 行写入，运行期由 `state.jsx` 的 themeMode / toggleTheme 管理；持久化键 radar.theme | `frontend\src\main.jsx` |
| 亮暗色板 | 默认 :root 一套（注释写「色板：夜」），亮色覆盖在 `styles.css` 第 67-68 行 :root:not([data-theme="dark"]), :root[data-theme="light"] | — |
| 系统暗色 | `index.html` 第 8 行 meta color-scheme content="light dark"；state.jsx prefersDark() | — |
| 版心切换 | .layout 默认全宽；`styles.css` 第 245 行 :root[data-width="narrow"] .layout { max-width: 1400px }；键 radar.widthMode | — |
| 字体 | 自托管 6 个 latin 子集（Chakra Petch 500/600/700、JetBrains Mono 400/500/700），`main.jsx` 第 7-12 行引入；族变量 `styles.css` 第 60-62 行 --font-head/--font-body/--font-mono | — |
| 响应式断点 | 见下表（全部 @media 原文） | — |

| 断点/条件 | 行号 | 效果（原文片段） |
|---|---|---|
| max-width: 1180px | 628 | .roll-body { grid-template-columns: 1fr; } |
| max-width: 1100px | 1143 | 布局适配 |
| max-width: 1024px | 967 | 布局适配 |
| max-width: 900px | 187 | .hud { display: none; } |
| max-width: 860px | 971 | 布局适配 |
| max-width: 700px | 1148 | 布局适配 |
| max-width: 640px | 977 | 布局适配 |
| prefers-reduced-motion: reduce | 996 | 关闭动画 |
| print | 1003 / 1170 | 打印样式 |
| @keyframes | 186 led-pulse · 312 card-in · 646 rc-flash · 772 pop-in · 840 slide-in | — |

关键文件：`frontend\src\styles.css` · `frontend\src\main.jsx` · `frontend\src\components\charts.jsx`

---

## 7. 数据来源

| 类别 | 结论 | 路径/位置 |
|---|---|---|
| 前端唯一取数通道 | 同源 fetch(path)（自动带 Cookie 与 X-CSRF-Token） | `frontend\src\api\client.js` 第 19-37 行 |
| 运行时接口 | 42 条 /api/*（见 §4.2），全部由同一个 Worker 提供 | `worker\router.ts` |
| 外部接口（唯一） | https://www.luogu.com.cn（管理员触发 GET /api/luogu 抓题；前端 luoguUrl() 只生成跳转链接） | `worker\luogu.ts` 第 14 行 HOST/ORIGIN；`frontend\src\aggregate.js` 第 28 行 |
| 外链域名全量核对 | worker 侧命中：www.luogu.com.cn、127.0.0.1（本地 dev 注释）、k4u.top（注释）；frontend/src 侧只有 www.luogu.com.cn | grep 结果 |
| 写死的 JSON 数据 | tags.json（洛谷标签 → 算法大类映射种子，31.9KB，`worker\luogu.ts` 第 16 行 import） | `tags.json` |
| 本地历史数据 | 算法雷达站数据_20260902.json（85.2KB / 200 行，122 条记录的历史导出；仅 `scripts\seed.mjs` 读取；.gitignore 排除） | `算法雷达站数据_20260902.json` |
| 前端写死常量 | THINKING_LEVELS（7 档）、DIFFICULTY_NAMES、CATEGORY_ORDER（11 大类） | `frontend\src\aggregate.js` 第 10/15/19 行 |
| 服务端写死常量 | 算法大类归类正则 CATEGORY_RULES | `worker\luogu.ts` 第 22-35 行 |
| 数据库 | D1 7 张表：meta / users / problems / models / records / login_guard / audit_log（9 个索引） | `worker\schema.ts`；同步副本 `db\schema.sql` |
| 缓存 | 前端 localStorage（12 个 radar.* 键，数据缓存键 radar.cache.v3）；服务端 ETag = 分代 + revision，Cache-Control: no-cache | `frontend\src\state.jsx` 第 6-13 行；`worker\store.ts` readValidator |
| 快照 | 每日 Cron 全库 JSON → R2 snapshots/日期/rev-revision.json + snapshots/latest.json，保留 90 天 | `worker\snapshot.ts` |
| 离线兜底 | 断网时用最近缓存只读展示，每 18 秒自动重试 | `frontend\src\pages\HomePage.jsx` 第 122 行 · `frontend\src\refreshCoordinator.js` |

关键文件：`frontend\src\api\client.js` · `worker\luogu.ts` · `tags.json` · `worker\schema.ts` · `db\schema.sql`

---

## 8. 静态资源

| 类别 | 位置 | 引用方式 |
|---|---|---|
| Headers/Redirects | `frontend\public\_headers`、`frontend\public\_redirects` | Vite public 目录原样拷贝到 `frontend\dist\`，由 Cloudflare 资产层读取 |
| favicon（实际生效） | 内联 data: SVG，写死在 `frontend\index.html` 第 11 行 | link rel="icon" href="data:image/svg+xml,..." |
| favicon（文件版） | `frontend\public\favicon.svg`（9.3KB） | **源码中 0 处引用**（grep favicon 仅命中 dist 产物与文件自身）→ 未使用，见 §13-3 |
| 图标 | `frontend\public\icons.svg`（4.9KB，24 行） | **全仓库 0 处引用** → 未使用，见 §13-3 |
| 字体 | @fontsource/chakra-petch、@fontsource/jetbrains-mono（node_modules 内，构建进 `frontend\dist\assets`） | `frontend\src\main.jsx` 第 7-12 行 import |
| 图片目录 | **无**（仓库内没有 images/img/assets 源目录；图形由 chart.js canvas 与 CSS 绘制） | — |
| 构建产物 | `frontend\dist\`（19 个文件；顶层：assets, _headers, _redirects, favicon.svg, icons.svg, index.html） | `wrangler.toml` assets.directory |
| 图表主题 | 从 CSS 变量读色（cssVar() / themeColors()） | `frontend\src\components\charts.jsx` |

关键文件：`frontend\index.html` · `frontend\public\_headers` · `frontend\public\favicon.svg` · `frontend\src\components\charts.jsx`

---

## 9. 已有能力清单

| # | 能力 | 主要文件 |
|---|---|---|
| 1 | 六个分析视图：矩阵 / 雷达 / 柱状 / 榜单 / 滚榜 / 洞察 | `frontend\src\views\` 下 6 个视图文件 + `RecordsTable.jsx` |
| 2 | 矩阵多口径单元格（最佳思考等级/分数最优/均分/最终分/状态） | `frontend\src\views\MatrixView.jsx` · `frontend\src\aggregate.js` |
| 3 | 矩阵题目查找 + 十字高亮 | `frontend\src\views\MatrixView.jsx` |
| 4 | ACM 滚榜回放（逐条事件、实时名次、多倍速） | `frontend\src\views\RollBoardView.jsx` · `frontend\src\rollboard.js` |
| 5 | 洞察三表：模型稳定性 / 题目区分度 / 思考等级收益 | `frontend\src\views\InsightView.jsx` · `frontend\src\aggregate.js` |
| 6 | 厂商色相 + 思考等级纹理配色体系 | `frontend\src\palette.js` |
| 7 | 模型聚焦筛选 + 贡献者视角（全站生效、持久化） | `frontend\src\components\ModelFilter.jsx` · `ContributorFilter.jsx` · `frontend\src\state.jsx` |
| 8 | 视图状态同步 URL + 快捷键 + 快捷键帮助 | `frontend\src\hooks\useUrlState.js` · `useHotkeys.js` · `frontend\src\components\ShortcutHelp.jsx` |
| 9 | 三态主题（跟随系统/日/夜）+ 全宽/限宽版心 | `frontend\src\main.jsx` · `frontend\src\state.jsx` · `frontend\src\components\Topbar.jsx` |
| 10 | 测评明细表：搜索、排序、批量选择、编辑、删除 | `frontend\src\views\RecordsTable.jsx` |
| 11 | 提交/编辑测评记录（含 {模型id} 提示词注入、乐观并发 baseUpdatedAt） | `frontend\src\components\RecordFormModal.jsx` · `worker\store.ts` updateRecord |
| 12 | 题目发布/编辑（洛谷抓题、难度、题面 content、时间/内存限制、附件标记） | `frontend\src\components\PublishModal.jsx` · `worker\luogu.ts` · `worker\store.ts` putProblem/updateProblem |
| 13 | 推荐提示词模板（现场拼装：工作区隔离指令 + 题面 + 限制） | `frontend\src\pages\PromptsPage.jsx` · `frontend\src\aggregate.js` standardPrompt 第 40 行 · `PromptCopyButton.jsx` |
| 14 | 题目详情抽屉（各模型作答对比） | `frontend\src\components\ProblemDrawer.jsx` |
| 15 | 账号体系：注册/登录/登出/初始化站长/改密/改昵称/角色任免/审批/删号 | `worker\auth.ts` · `frontend\src\pages\RegisterPage.jsx` · `AuthModal.jsx` · `ChangePasswordModal.jsx` |
| 16 | 会话：HMAC 令牌 + Cookie（12h，1h 续签）+ Secure 按协议 | `worker\auth.ts` 第 28-29 行 |
| 17 | 登录失败锁定（5 次锁 15 分钟，D1 持久化） | `worker\auth.ts` 第 32-33 行 · `worker\schema.ts` login_guard 表 |
| 18 | CSRF 双提交校验（radar_csrf + X-CSRF-Token） | `worker\router.ts` · `frontend\src\api\client.js` |
| 19 | 原生限流（WRITE/AUTH）+ 进程内长窗叠加 | `wrangler.toml` ratelimits · `worker\router.ts` tryAcquire/burstLimit |
| 20 | 审计日志（删号/删记录/清空目录/导入/恢复等） | `worker\store.ts` logAudit 第 974 行 · `worker\schema.ts` audit_log · `frontend\src\pages\UsersPage.jsx` |
| 21 | 三区数据：显示区 / 隐藏区（未收录）/ 回收站（软删除） | `worker\store.ts` listHiddenGroups/restoreTrash/purgeTrash · `frontend\src\pages\AdminPage.jsx` |
| 22 | 收录制（题目、模型双收录才计入统计） | `worker\store.ts` 文件头注释 · isRecordVisible 第 137 行 |
| 23 | 待审/批量审核 | `worker\router.ts` /api/records/bulk · `frontend\src\pages\AdminPage.jsx` |
| 24 | 导入（merge / replace）与全量/公开导出 | `worker\store.ts` importBundle 第 786 行 / exportBundle 第 841 行 · `frontend\src\components\ImportModal.jsx` |
| 25 | CSV 导出（含公式注入前缀防护）+ JSON 导出 | `worker\store.ts` buildCsv 第 942 行 · `frontend\src\api\client.js` download |
| 26 | ETag / 304 增量拉取（分代 epoch + revision） | `worker\store.ts` readValidator 第 113 行 · `worker\router.ts` /api/data 第 348 行 |
| 27 | 每日 R2 快照 + 手动触发 + 90 天清理 | `worker\snapshot.ts` · `wrangler.toml` crons |
| 28 | 断网只读缓存 + 18 秒自动重连 | `frontend\src\state.jsx` · `refreshCoordinator.js` · `HomePage.jsx` 第 122 行 |
| 29 | 洛谷抓题缓存（6 小时 TTL + single-flight）+ SSRF 白名单 | `worker\luogu.ts` |
| 30 | 题面回填（backfill-content）用于补齐旧数据 | `worker\router.ts` 第 662 行 · `worker\store.ts` backfillProblemContent 第 518 行 |
| 31 | 贡献者名册 + 贡献统计 | `frontend\src\pages\ContributorsPage.jsx` · `worker\store.ts` contributorStats 第 223 行 |
| 32 | 前端无头自检（真实渲染 + 口径断言） | `frontend\selftest\entry.jsx`（1023 行）· `frontend\vite.selftest.config.mjs` |
| 33 | 后端权限矩阵端到端自检（隔离临时 D1/R2，README 记 91 项） | `scripts\e2e.mjs`（409 行） |
| 34 | 类名契约检查（JSX class ↔ styles.css） | `frontend\scripts\check-classes.mjs`（55 行） |
| 35 | 本地种子脚本（初始化站长 + 导入历史 JSON） | `scripts\seed.mjs`（140 行） |
| 36 | 只读演示模式（合成样本、拒绝写请求） | `frontend\vite.demo.config.mjs` · `frontend\selftest\fixture.basic.json` |
| 37 | Windows 一键本地启动 | `start-website.bat`（35 行） |
| 38 | 全局错误边界 + Toast + 回顶 + 焦点管理 | `frontend\src\components\ErrorBoundary.jsx` · `ToastHost.jsx` · `BackTop.jsx` · `frontend\src\hooks\useDialog.js` |
| 39 | 无障碍细节：skip-link、role=tabpanel、kbd、reduced-motion | `frontend\src\pages\HomePage.jsx` 第 99 行 · `styles.css` 第 996 行 |
| 40 | Pages 兼容入口（同一 Worker 服务绑定，不复制库/定时任务） | `pages\wrangler.toml` · `pages\functions\api\[[path]].ts` |

---

## 10. 占位 / TODO / 半成品 / 未使用物

**TODO/FIXME/XXX 关键字全仓命中数：0**（worker 与 frontend/src 分别 grep）。以下是「占位」「待补」「未使用」类实际命中：

| 文件:行 | 原文片段（节选） | 性质 |
|---|---|---|
| `worker\store.ts:523` | // 缺题面/限制，或题面里还没有「输入输出样例」节（v3.11 早期抓取的旧数据）都算待补； | 明确的「待补」判定逻辑 |
| `frontend\src\pages\AdminPage.jsx:395` | toast(已补全 ${r.updated} 题，剩余 ${r.remaining} 题待补（再点一次继续）) | 未补完数据的提示（可反复点） |
| `frontend\src\aggregate.js:36` | modelId：提供者正在测的模型名。已知时注入文件夹名；未知时保留 {模型id} 占位符 | 占位符设计（非缺陷） |
| `frontend\src\pages\PromptsPage.jsx:193` | （建立工作区文件夹后发送给待测 AI 模型；发送前把 {模型id} 占位符替换为实际模型名） | 同上 |
| `frontend\src\components\PromptCopyButton.jsx:21,22,103` | 没有模型上下文 → 点击先弹「选择模型」小窗… / （不填 — 保留 {模型id} 占位符） | 同上 |
| `frontend\src\components\PublishModal.jsx:8` | 难度选项：value = 实际难度值字符串（'' 为选择占位） | 表单占位项 |
| `frontend\src\components\RecordFormModal.jsx:96,256` | 编辑场景：若当前记录的模型不在目录…仍显示为占位以便识别 / 粘贴前把残留占位符替换掉 | 兼容历史数据的占位 |
| `frontend\src\refreshCoordinator.js:18` | 用 Promise.resolve().then 包住，保证 running 在任何 await 之前就被赋值（同步占位） | 代码技巧注释，非未完成 |
| `frontend\src\pages\HomePage.jsx:122` | ⚠ 服务器暂时无法连接，以下为最近缓存的只读数据。将每 18 秒自动重试连接。 | 降级路径（正常能力） |
| `frontend\public\icons.svg` | 24 行 SVG sprite，全仓 0 引用 | **未使用资源**（dist 中仍会被发布） |
| `frontend\public\favicon.svg` | 9.3KB 图标，源码 0 引用（index.html 用内联 data: SVG） | **未使用资源** |
| `functions\api\`（根） | 空目录，0 文件 | **遗留空壳**，Pages 时代的函数目录 |
| `package.json` scripts.dev:full | 依赖 concurrently 但未声明（实测两处 node_modules 均无） | **失效脚本**（静态核对，未运行） |
| `README.md` 第 110 行 | 写「pages/ 五页面」，实际 6 个页面文件、6 条路由 | **文档滞后** |

关键文件：`worker\store.ts` · `frontend\src\pages\AdminPage.jsx` · `frontend\public\icons.svg` · `README.md`

---

## 11. 速查：要加/改某个功能，动哪个文件

| 想做的事 | 主要改动点 |
|---|---|
| 新增一个分析视图（第 7 个图） | 新建 `frontend\src\views\XxxView.jsx` → 在 `frontend\src\pages\HomePage.jsx` 的 TABS/渲染分支登记 → 样式加进 `frontend\src\styles.css` |
| 改统计口径 / 榜单算法 | `frontend\src\aggregate.js`（+ `rollboard.js` 若涉及滚榜） |
| 新增 API 接口 | `worker\router.ts` 的路由表（{ method, path, role, handler }）→ 业务写进 `worker\store.ts` → 前端 `frontend\src\api\client.js` 调用 |
| 新增数据库表/列 | `worker\schema.ts`（建表）+ `worker\ensureSchema.ts` 的 MIGRATIONS 与 SCHEMA_VERSION + 同步 `db\schema.sql` |
| 改鉴权 / 会话 / CSRF | `worker\auth.ts` · `worker\router.ts`（Cookie 与头常量在此导入） |
| 改顶栏导航或菜单 | `frontend\src\components\Topbar.jsx`（+ 若新增页面：`frontend\src\App.jsx` 加 Route） |
| 改主题 / 配色 / 断点 / 字体 | `frontend\src\styles.css`（变量与 data-theme 规则）· `frontend\src\main.jsx`（首帧写入）· `frontend\src\components\charts.jsx`（图表取色） |
| 改模型/贡献者筛选行为 | `frontend\src\state.jsx` · `frontend\src\components\ModelFilter.jsx` · `ContributorFilter.jsx` |
| 改记录提交表单 | `frontend\src\components\RecordFormModal.jsx`（服务端校验在 `worker\store.ts` addRecord/updateRecord） |
| 改题目发布/洛谷抓取 | `frontend\src\components\PublishModal.jsx` · `worker\luogu.ts` · `worker\store.ts` putProblem/updateProblem |
| 改提示词模板 | `frontend\src\aggregate.js`（standardPrompt/promptOf）· `frontend\src\components\PromptCopyButton.jsx` |
| 改导入 / 导出 | `frontend\src\components\ImportModal.jsx` · `worker\store.ts` importBundle/exportBundle/buildCsv |
| 改回收站 / 隐藏区 / 审核台 | `frontend\src\pages\AdminPage.jsx` · `worker\store.ts` listTrash/restoreTrash/purgeTrash/listHiddenGroups |
| 改用户与权限 | `frontend\src\pages\UsersPage.jsx` · `worker\auth.ts` · `worker\router.ts` admin/users 段 |
| 改快照 / 定时任务 | `worker\snapshot.ts` · `wrangler.toml` [triggers] |
| 改部署目标 / 域名 / 绑定 | `wrangler.toml`（主）· `pages\wrangler.toml`（Pages 入口）· `frontend\public\_headers` |
| 补/改测试 | `scripts\e2e.mjs`（后端权限矩阵）· `frontend\selftest\entry.jsx`（前端口径）· `frontend\scripts\check-classes.mjs`（类名契约） |
| 改本地启动流程 | `start-website.bat` · `scripts\seed.mjs` · `frontend\vite.config.js`（5174 → 8788 代理） |

---

## 12. 验证

**手段**：写完本文件后，用一条 PowerShell 脚本回读本文件，抽出所有反引号包裹的路径样 token（形如 xxx\yyy.ext 或目录式 xxx\yyy\），逐个 Test-Path 断言；同时断言本文件小节齐全、以及「SPA 路由数 = 页面文件数」。
**结果**（实测日期 2026-09-25）：

- 从本文件抽出反引号 token **197** 个（以本文件最新内容重跑）：其中 **116** 个被识别为路径/文件引用并发起断言，**81** 个为非路径 token（/api/* 路由、绑定名、常量、示意占位 XxxView.jsx、模式串 "worker/index.ts" 等）已逐条跳过并计数。
- **路径存在断言 110 条，全部通过**：字面相对路径 **78** 条存在、根级文件 **12** 条存在（其中 `frontend\dist\index.html`、`frontend\dist\assets` 因 dist 被排除出清单而单独用 `Test-Path -LiteralPath` 复测 = True）、basename 简写（如 AdminPage.jsx / styles.css，共 **18** 条）在排除依赖与产物后于全仓**唯一命中**；失败 0、同名多解释 0。
- **预期不存在项 6 条，全部确认不存在**：data.json、credentials.json、.dev.vars、.nvmrc、_routes.json、node_modules\concurrently —— 与地图中「无 / 实测不存在 / 未声明依赖」的写法一致。
- **结构断言**：## 小节 **15** 个（§0–§14 齐全）；`frontend\src\App.jsx` 具名页面路由 **6** 条 = `frontend\src\pages\` 页面文件 **6** 个（另有 1 条通配回退路由）；`worker\router.ts` 中 method: 定义 **42** 条 = §4.2 表格 42 行。
- **实际读到的页面数**：页面文件 6 个 + 唯一 HTML 外壳 1 个（`frontend\index.html`）。
- **执行命令**：`pwsh Get-ChildItem -Recurse -Force`（排除 node_modules/.git/dist/.wrangler/.mimosa/.selftest 后得 112 文件 + 35 目录清单）+ `Test-Path -LiteralPath` 逐条判存在 + Node 侧集合断言；本文件由脚本回读解析（不是人工誊抄）。
- **口径说明**：断言的是「地图里出现的路径在磁盘上存在」，不含 dist 内部逐文件清单（`frontend\dist\index.html`、`frontend\dist\assets` 已单独复测存在）。
- **写盘边界核对**：`pwsh git status --porcelain` 显示本轮结束后工作区只有两项变化 —— 新增未跟踪文件 `PROJECT_MAP.md`（mtime 2026-09-25 20:59）与既有未跟踪目录 `.pt-tmp\`；另有一处**本轮之前就已存在**的已跟踪改动 `frontend\selftest\entry.jsx`（mtime 2026-09-06 22:50，diff 为新增 4 行「题面补全」断言，涉及 `worker\luogu.ts` 与 `worker\store.ts`），**不是本轮所改**（`git diff --stat` = 1 file changed, 4 insertions）。
**未做的验证**：不跑 build / dev / deploy / e2e（本轮禁止）；不联网核对线上 k4u.top 的实际部署状态；不读 .git 历史。

---

## 13. 未确认（原样保留，不补全）

1. **Node 版本要求**：无 .nvmrc，`package.json` 无 engines。原文旁证仅 `start-website.bat` 第 12 行「echo [错误] 未检测到 Node.js，请先安装 Node 18+：https://nodejs.org/」与 `frontend\vite.selftest.config.mjs` 第 12 行 target: 'node22'。
2. **.pt-tmp\ 的用途**：目录内为 app.js、data_anon.json、data_auth.json、data_final.json、pub.json、pub2.json、jar*.txt（Cookie 罐）。仅凭文件名判断是「本地接口验证临时样本」，**未读内容**（疑似凭据，按规则跳过）→ 用途未确认；其中 jar*.txt 必须视为凭据，不应入库。
3. **`frontend\public\favicon.svg` 与 `frontend\public\icons.svg`**：全仓库源码 0 处引用（index.html 用内联 data: SVG 作 favicon）。究竟是将来预留还是历史遗留 → 未确认。
4. **根 functions\api\ 空目录**：只有空目录，无文件、无 _routes.json。README 记「2026-09-05 从 Pages 迁移到 Workers」，故推测为 Pages 时代遗留 → 依据不足，标未确认。
5. **README 与代码的页面数不一致**：`README.md` 第 110 行写「pages/ 五页面」，实际 6 个页面文件、6 条路由 → 以代码为准，README 未更新。
6. **线上真实状态**：本轮禁止联网，k4u.top 当前实际部署的版本 / 是否已绑自定义域 / Pages 项目是否仍在 → 未验证。
7. **README 第 211 行的演示端口 5176**：`frontend\vite.demo.config.mjs` 我只读了前 25 行，未在配置中读到端口号 → 端口来源未确认（README 声称 5176）。
8. **.git\ 版本历史 / 分支 / 未提交改动**：本轮不涉及，未查看。

---

## 14. 本次跳过清单（按 §1 排除表）

`node_modules\`、`frontend\node_modules\`、`.git\`、`frontend\dist\`（仅统计 19 个文件与顶层清单）、`.wrangler\`、`frontend\.selftest\`、`.pt-tmp\`（含凭据，只记文件名）、`.mimosa\`、`frontend\.mimosa\`、`worker\.mimosa\`、`.workbuddy\`、`.zcode\`、`wrangler.log`。
原因：第三方依赖 / 版本历史 / 构建产物 / 本地运行状态 / 含疑似凭据的临时样本 / AI 工具元数据 / 本地日志；均不属于「站点源文件」。
其余源文件已逐个读取或由 grep 全覆盖（worker 10 个 .ts 全读头部与关键段；frontend/src 50 个源文件全部纳入清单，其中核心 20 余个逐行读）。
