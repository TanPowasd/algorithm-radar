# 「AI vs 洛谷」重构实施计划（React SPA + Spring Boot + SQLite）

## 已确认需求
- 在现有项目上重构：前端 React 18 + Vite（JS/JSX，路由 react-router），后端 Spring Boot 3（Java 21，Maven Wrapper），数据库 SQLite。
- 四身份权限：游客（看排名+导出数据，**不可提交**）；贡献者（提交测评→待审）；管理员（审核测评、发布题目、添加模型、洛谷抓取）；站长（审核注册、任命管理员，首次启动 setup 创建，仅一次）。
- 保留：思考等级 7 级维度、模型名聚合（seriesKey=model）、无分数轮次跳过、n≥5 柱状门槛、忽略题 chips、多轮 submissions、得分/部分分、Agent/Token 来源、公告栏、明暗主题、移动端适配。
- 新增：memory（内存 MB）可选字段；AI 模型管理表（名称+厂商+备注）；多榜单可切换视图（AC数/AC率/平均得分率等）；游客公开导出（CSV/JSON，仅已审核数据）。
- 洛谷：管理员输题号服务器自动抓取，失败可手动补全；SSRF 防护（固定 host 白名单 + DNS 解析拒绝私网/环回/保留 IP）。
- 数据：你有旧导出 JSON，实施后期提供文件，我通过导入功能灌入新库（兼容旧 bundle 格式）；本地 data.json 不存在已确认。
- 端口：新后端 8080，前端 dev 固定 5174（5173 被豆包占用）；旧 Python 站保留原位可并行（8471）做对比。
- 环境：本机 JDK 21 已装但 JAVA_HOME 末尾多 `\bin`，启动脚本内置修正（不改全局环境）；Maven 未装→项目内 mvnw；Node 24 就绪。
- git commit 由你在自己终端手动执行（Mimosa L3 门禁），我提供现成命令。

## 目录结构
```
算法雷达站/
├── backend/                    # Spring Boot 3 + SQLite（新）
│   ├── pom.xml  mvnw  mvnw.cmd  .mvn/
│   ├── start-backend.bat       # 内置 JAVA_HOME=JDK21 修正
│   └── src/main/
│       ├── java/com/radar/{config,auth,controller,service,repo,model}/
│       └── resources/{application.yml, schema.sql, tags.json}
├── frontend/                   # Vite + React（新）
│   ├── package.json  vite.config.js  start-frontend.bat
│   └── src/{api,pages,components,charts}/
├── server.py store.py auth.py luogu_fetch.py public/ ...  # 旧站原位保留
```

## 后端设计
- 依赖：spring-boot-starter-web/jdbc/validation + org.xerial:sqlite-jdbc。
- 表（schema.sql 自启建库，backend/data/radar.db，gitignored）：
  - `users`：username 唯一、password_hash（PBKDF2-SHA256 24万迭代，**格式兼容旧哈希**）、role(owner/admin/contributor)、status(active/pending/rejected)、审计字段
  - `records`：字段对齐旧 schema（model/variant/agent/token_source/pid/title/thinking 七级/difficulty 0-7/categories JSON/submissions JSON/memory/minutes/date/note/status/author/时间戳），id=16位hex
  - `problems`：pid 主键、title、difficulty、tags/categories JSON、manual、fetched_at
  - `models`：name 唯一、vendor、note
  - `meta`：revision（每次写事务 +1）、data_version
- 认证：HMAC 签名 token 存 HttpOnly Cookie（12h、1h 续签）；CSRF 双提交（radar_csrf Cookie + X-CSRF-Token 头，非 GET 强制）；限流（登录 6/10min、洛谷 30/min、写 60/min）；CSP/nosniff 等响应头对齐旧站。
- 权限拦截：Filter 按角色控制——数据接口游客可见但仅 approved（贡献者额外含本人 pending，管理员/站长含全部）；records 增改删、题目、模型、审核、洛谷抓取限 admin+；用户管理限 owner。
- API：沿用旧端点语义（ping/session/setup/login/logout/data/records CRUD/status/bulk/problems/luogu/export/import）+ 新增 `POST /api/auth/register`、`GET /api/admin/users`、`POST /api/admin/users/{id}/approve|reject|role`、`GET/POST/PUT/DELETE /api/models`、`GET /api/export/public`（JSON/CSV，游客可用）。错误消息保持中文。校验/清洗规则（白名单、长度、PID 正则、normalize 旧格式）从 store.py 移植。
- 洛谷服务：java.net.http，仅 https://www.luogu.com.cn，UA 伪装、__client_id Cookie、lentille-context 解析、tags.json 种子（复制现有文件进 resources）、11 条算法大类正则移植、内存缓存。
- 导入：兼容旧 data.json bundle（merge/replace、旧 result 字段→单轮 submissions、无 status→approved 等）；启动时若根目录存在 data.json 自动导入（兜底）。

## 前端设计
- Vite（固定端口 5174）+ React 18 + react-router；Chart.js 4 走 npm；Context 管 session+data，无其他重型依赖。
- `/` 主页：公告栏、统计带、滑动 pill 选项卡（矩阵/雷达/柱状/趋势/**榜单(新)**/明细表），全部移植且口径不变；提交表单（model 改为从模型表下拉+思考等级 7 级+agent/tokenSource datalist+已发布题目下拉+多轮编辑器）；题目详情抽屉；登录/注册弹窗；游客导出按钮。
- `/admin` 审核台（管理员）：统计卡、待审核表（单条/批量）、题目管理、**模型管理**、发布新题弹窗。
- `/users` 用户管理（站长）：注册审核（批准/拒绝）、用户列表（任命/免除管理员）。
- 样式：移植 style.css 设计令牌与组件类；动态颜色走 CSSOM（CSP 兼容）。

## 实施步骤
1. backend 骨架：pom.xml+wrapper、application.yml、schema.sql、start-backend.bat，验证能启动建库。
2. records/problems 存取层与 API（校验清洗、revision、审核、bulk、删题保护）。
3. 认证体系：setup/login/logout/session、CSRF、限流、角色拦截、注册+用户管理 API。
4. models CRUD、洛谷抓取服务、导入导出+游客公开导出。
5. frontend 骨架：vite 项目、api 客户端（含 CSRF）、主题、路由、登录/注册。
6. 移植五视图（矩阵/雷达/柱状/趋势/明细表）。
7. 榜单视图（多指标切换：最终 AC 数/最终 AC 率/首轮均分/全轮均分，按模型聚合+思考等级明细展开）、提交表单、题目抽屉、发布弹窗。
8. 审核台+站长用户管理+模型管理页。
9. 联调测试：curl 冒烟全部端点+权限矩阵（游客不可提交/不可见 pending 等）、浏览器 GUI 验证、你提供旧导出 JSON 后实测导入。
10. README 重写（新架构+运行说明）、交付 git 命令由你手动提交。

## 验收标准
- 完整流程走通：setup 建站长→注册→站长批准→贡献者提交→管理员审核→游客看榜单+导出。
- 游客不可提交、pending 不外泄不计入统计、题目发布制、有记录的题目/模型不可删。
- 五个旧视图口径与现状一致；洛谷抓取+手动补全可用。
- 旧导出 JSON 成功导入 SQLite。
