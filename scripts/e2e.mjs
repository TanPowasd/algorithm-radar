/**
 * 端到端权限矩阵自检：在隔离的临时 D1/R2 环境里
 * 跑完整的账号生命周期与权限组合，防止改坏后端权限口径。
 *
 * 用法：npm run e2e   （等价于 npm run build && node scripts/e2e.mjs）
 * 前置：根目录已 npm install（需要 wrangler）。
 * 环境完全隔离：使用 .wrangler/e2e-redesign-* 新建存储目录与 8799 端口，结束即清理，
 * 不会碰本地开发数据库（8788/.wrangler/state）。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

if (!existsSync(path.join(root, 'frontend', 'dist', 'index.html'))) {
  console.error('缺少 frontend/dist，请先执行 npm run build（npm run e2e 会自动构建）')
  process.exit(1)
}
if (!existsSync(require.resolve('wrangler/package.json', { paths: [root] }))) {
  console.error('根目录未安装 wrangler，请先 npm install')
  process.exit(1)
}

const PORT = process.env.E2E_PORT ? Number(process.env.E2E_PORT) : 8799
const targetPages = process.argv.includes('--pages')
const BASE_URL = `http://127.0.0.1:${PORT}/`
// 每轮新建，不删除或复用已有本地数据库。
mkdirSync(path.join(root, '.wrangler'), { recursive: true })
const PERSIST = mkdtempSync(path.join(root, '.wrangler', 'e2e-redesign-'))
if (path.dirname(PERSIST) !== path.join(root, '.wrangler')) throw new Error('测试存储目录越界')

/* ---------- 极简会话罐：吸收 Set-Cookie、拼 Cookie 头、取 CSRF ---------- */
class Jar {
  constructor() { this.cookies = new Map() }
  absorb(res) {
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]
      const eq = pair.indexOf('=')
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
    }
  }
  header() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
  csrf() { return this.cookies.get('radar_csrf') || '' }
}

/** URL 统一走 new URL(常量基址) + pathname 赋值（不做字符串拼接进 fetch） */
function apiUrl(pathname) {
  const u = new URL(BASE_URL)
  u.pathname = pathname
  return u
}

async function call(jar, method, pathname, body, extraHeaders = {}) {
  const headers = { Cookie: jar.header(), ...extraHeaders }
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = jar.csrf()
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(apiUrl(pathname), {
    signal: AbortSignal.timeout(15_000),
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  jar.absorb(res)
  const data = await res.json().catch(() => null)
  return { status: res.status, data, headers: res.headers }
}

/* ---------- 断言收集 ---------- */
const failures = []
let passed = 0
function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) } else { failures.push(name); console.log(`  ✗ ${name}${extra ? ` → ${extra}` : ''}`) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 预热会话罐：先 GET /api/session 领 radar_csrf cookie（CSRF 双提交要求） */
async function prime(jar) {
  await call(jar, 'GET', '/api/session')
  return jar
}

/* ---------- 服务器生命周期 ---------- */
const wranglerBin = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js')
let child = null
let exited = false

function startServer() {
  // Workers 模式（wrangler.toml: main + assets）：静态资产 + /api + Cron/限流/R2 绑定全部本地模拟
  child = spawn(process.execPath, [
    wranglerBin, ...(targetPages
      ? ['pages', 'dev', '-c', 'wrangler.toml', '-c', '../wrangler.toml']
      : ['dev']),
    '--port', String(PORT), '--persist-to', PERSIST,
  ], { cwd: targetPages ? path.join(root, 'pages') : root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.stdout.on('data', (chunk) => { if (process.env.E2E_VERBOSE) process.stdout.write(chunk) })
  child.stderr.on('data', (chunk) => { if (process.env.E2E_VERBOSE) process.stderr.write(chunk) })
  child.on('exit', () => { exited = true })
}

async function stopServer() {
  if (child && !exited && process.platform === 'win32') {
    const status = await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('exit', resolve)
      killer.on('error', () => resolve(-1))
    })
    if (status !== 0) child.kill('SIGKILL')
  } else if (child && !exited) {
    child.kill('SIGKILL')
  }
  child = null
  // workerd 释放文件句柄略有延迟，重试清理临时库
  for (let i = 0; i < 10; i++) {
    try { rmSync(PERSIST, { recursive: true, force: true, maxRetries: 1, retryDelay: 200 }); return } catch { await sleep(400) }
  }
}

async function waitReady() {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (exited) throw new Error('wrangler 提前退出（端口被占或构建缓存损坏，可重跑或换 E2E_PORT）')
    try {
      const res = await fetch(apiUrl('/api/ping'), { signal: AbortSignal.timeout(2000) })
      if (res.ok) return
    } catch { /* 未就绪继续等 */ }
    await sleep(600)
  }
  throw new Error('服务器 90s 内未就绪')
}

process.on('exit', () => { if (child && !exited) { try { child.kill('SIGKILL') } catch { /* 尽力而为 */ } } })
process.on('SIGINT', async () => { await stopServer(); process.exit(130) })

/* ---------- 主流程 ---------- */
let code = 0
try {
  console.log(`[e2e] 启动隔离环境：端口 ${PORT}，存储 ${PERSIST}`)
  startServer()
  await waitReady()
  console.log('[e2e] 服务器就绪，开始权限矩阵')

  for (const pathname of ['/', '/contributors', '/prompts', '/register']) {
    const res = await fetch(apiUrl(pathname), { headers: { 'Sec-Fetch-Mode': 'navigate' } })
    ok(`SPA 深链接 ${pathname}`, res.ok && (await res.text()).includes('id="root"'))
  }
  const apiNavigation = await fetch(apiUrl('/api/ping'), { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } })
  ok('直接访问 API 不被 SPA 吞掉', apiNavigation.headers.get('content-type')?.includes('application/json'))

  const owner = await prime(new Jar()), admin = await prime(new Jar()),
    contrib = await prime(new Jar()), tmp = await prime(new Jar())
  const user = (name, pass) => ({ username: name, password: pass })

  // 1. 初始化站长 + 五个注册账号（alice=管理员候选，bob=删号样本，carl/eve=贡献者，dave=待审，frank=管理员删号样本）
  const setupRes = await call(owner, 'POST', '/api/setup', { username: 'boss', password: 'ownerpass123', nickname: 'Owner' })
  ok('初始化站长', setupRes.data?.ok, `HTTP ${setupRes.status} ${JSON.stringify(setupRes.data)}`)
  for (const u of ['alice', 'bob', 'carl', 'dave', 'eve', 'frank']) {
    const res = await call(tmp, 'POST', '/api/auth/register', { username: u, nickname: u.toUpperCase(), password: `${u}pass12345` })
    ok(`注册 ${u}`, res.data?.ok, `HTTP ${res.status} ${JSON.stringify(res.data)}`)
  }
  const listFor = async () => (await call(owner, 'GET', '/api/admin/users')).data?.users ?? []
  const idOf = async (name) => (await listFor()).find((u) => u.username === name)?.id
  for (const u of ['alice', 'bob', 'carl', 'eve', 'frank']) {
    ok(`站长批准 ${u}`, (await call(owner, 'POST', `/api/admin/users/${await idOf(u)}/approve`)).data?.ok)
  }
  ok('站长拒绝 dave（保留待清理）', (await call(owner, 'POST', `/api/admin/users/${await idOf('dave')}/reject`)).data?.ok)
  ok('站长任命 alice 为管理员', (await call(owner, 'POST', `/api/admin/users/${await idOf('alice')}/role`, { role: 'admin' })).data?.ok)

  // 2. 管理员视角：用户列表只含已激活贡献者
  ok('alice 登录', (await call(admin, 'POST', '/api/login', user('alice', 'alicepass12345'))).data?.role === 'admin')
  const adminList = (await call(admin, 'GET', '/api/admin/users')).data?.users ?? []
  ok('管理员用户列表只含已激活贡献者（不含待审/管理员/站长）',
    adminList.every((u) => u.role === 'contributor' && u.status === 'active') && adminList.length === 4,
    `实际：${adminList.map((u) => u.username).join(',')}`)

  // 3. 管理员建目录，bob 提交并过审（造一条删号后应保留的记录）
  ok('管理员建模型', (await call(admin, 'POST', '/api/models', { name: 'GPT-5', vendor: 'OpenAI' })).data?.ok)
  ok('管理员发布题目', (await call(admin, 'POST', '/api/problems', { pid: 'B1001', title: 'Test Problem', difficulty: 2, categories: ['simulation'] })).data?.ok)
  const bobId = await idOf('bob')
  ok('bob 登录并提交测评（pending）', (await call(contrib, 'POST', '/api/login', user('bob', 'bobpass12345'))).data?.ok
    && (await call(contrib, 'POST', '/api/records', { record: { model: 'GPT-5', pid: 'B1001', thinking: 'max', difficulty: 2, submissions: [{ score: 100, result: 'AC' }], date: '2026-09-05', minutes: 10 } })).data?.record?.status === 'pending')
  const recId = ((await call(admin, 'GET', '/api/data')).data?.records ?? []).find((r) => r.author === 'bob')?.id
  ok('管理员审核通过 bob 的记录', (await call(admin, 'POST', `/api/records/${recId}/status`, { status: 'approved' })).data?.ok)

  // 4. 权限矩阵：删除账号
  ok('管理员删除已激活贡献者 bob → 允许', (await call(admin, 'DELETE', `/api/admin/users/${bobId}`)).data?.ok)
  ok('bob 会话立即失效', (await call(contrib, 'GET', '/api/admin/users')).status === 401)
  ok('bob 的已审核记录保留（author 快照）',
    ((await call(tmp, 'GET', '/api/data')).data?.records ?? []).some((r) => r.author === 'bob' && r.status === 'approved'))
  // 不用重新注册验证 ID 释放（注册限流 6 次/小时会撞上限）：用户列表里查不到即视为已释放
  ok('被删用户名从用户列表消失（ID 已释放）', !(await listFor()).some((u) => u.username === 'bob'))
  ok('管理员删站长 → 拒绝', (await call(admin, 'DELETE', `/api/admin/users/${await idOf('boss')}`)).data?.error === '不能删除站长账号')
  ok('管理员删自己 → 拒绝', (await call(admin, 'DELETE', `/api/admin/users/${await idOf('alice')}`)).data?.error === '不能删除自己的账号')
  ok('管理员删待审账号 dave → 拒绝', (await call(admin, 'DELETE', `/api/admin/users/${await idOf('dave')}`)).data?.error === '管理员只能删除已激活的贡献者账号')

  // 5. 贡献者权限
  ok('eve 登录', (await call(contrib, 'POST', '/api/login', user('eve', 'evepass12345'))).data?.role === 'contributor')
  ok('贡献者看用户列表 → 403', (await call(contrib, 'GET', '/api/admin/users')).status === 403)
  ok('贡献者看审计 → 403', (await call(contrib, 'GET', '/api/admin/audit')).status === 403)
  ok('贡献者删账号 → 403', (await call(contrib, 'DELETE', `/api/admin/users/${await idOf('carl')}`)).status === 403)

  // 6. 改昵称
  ok('自助改昵称生效', (await call(admin, 'POST', '/api/profile/nickname', { nickname: 'Alice II' })).data?.ok
    && (await call(admin, 'GET', '/api/session')).data?.nickname === 'Alice II')
  ok('空昵称 → 400', (await call(admin, 'POST', '/api/profile/nickname', { nickname: '' })).status === 400)

  // 7. 站长清理任意状态账号 + 删管理员
  ok('站长删待审账号 dave → 允许', (await call(owner, 'DELETE', `/api/admin/users/${await idOf('dave')}`)).data?.ok)
  ok('站长删已激活贡献者 carl → 允许', (await call(owner, 'DELETE', `/api/admin/users/${await idOf('carl')}`)).data?.ok)
  ok('站长删贡献者 eve → 允许', (await call(owner, 'DELETE', `/api/admin/users/${await idOf('eve')}`)).data?.ok)
  ok('站长任命 frank 为管理员', (await call(owner, 'POST', `/api/admin/users/${await idOf('frank')}/role`, { role: 'admin' })).data?.ok)
  ok('站长删管理员 frank → 允许', (await call(owner, 'DELETE', `/api/admin/users/${await idOf('frank')}`)).data?.ok)
  ok('站长删自己 → 拒绝（站长账号受保护）', (await call(owner, 'DELETE', `/api/admin/users/${await idOf('boss')}`)).data?.error === '不能删除站长账号')

  // 7.5 数据删除类操作留痕（软删记录、删模型、删题目）
  ok('管理员删除记录（软删入回收站）', (await call(admin, 'DELETE', `/api/records/${recId}`)).data?.ok)
  const modelId = ((await call(admin, 'GET', '/api/models')).data?.models ?? []).find((m) => m.name === 'GPT-5')?.id
  ok('管理员删除模型', (await call(admin, 'DELETE', `/api/models/${modelId}`)).data?.ok)
  ok('管理员删除题目', (await call(admin, 'DELETE', '/api/problems/B1001')).data?.ok)

  // 7.6 ETag/304：revision 单调，无变更刷新应 304；数据变更后应 200 新 ETag
  const d1 = await call(tmp, 'GET', '/api/data')
  const etag = d1.headers?.get('etag')
  ok('/api/data 带 ETag 头', Boolean(etag), `实际 ${etag}`)
  const revalidate = await call(tmp, 'GET', '/api/data', undefined, etag ? { 'If-None-Match': etag } : {})
  ok('无变更重复请求 → 304', revalidate.status === 304, `实际 ${revalidate.status}`)
  ok('304 不带正文', (await revalidate.headers?.get('content-type')) === null || revalidate.data === null)
  await call(owner, 'POST', '/api/models', { name: 'ETAG-PROBE', vendor: 'test' })
  const afterWrite = await call(tmp, 'GET', '/api/data', undefined, etag ? { 'If-None-Match': etag } : {})
  ok('数据变更后旧 ETag → 200 且 ETag 更新', afterWrite.status === 200 && afterWrite.headers?.get('etag') !== etag)

  // 7.7 数据快照：与每日 Cron 同一实现，写入本地模拟 R2
  const snap = await call(owner, 'POST', '/api/admin/snapshot')
  ok('站长手动快照成功（写 R2）', snap.data?.ok === true && String(snap.data?.key || '').startsWith('snapshots/'), JSON.stringify(snap.data))
  ok('管理员触发快照 → 403（仅站长）', (await call(admin, 'POST', '/api/admin/snapshot')).status === 403)

  // 7.8 导入往返（回归 docs/BACKEND_REVIEW.md P0-1 / P0-3：
  //     「N 条记录 = N+6 条语句」在 D1 每次调用 50(免费)/1000(付费) 条查询的预算下必然失败）
  const synth = (n, tag) => Array.from({ length: n }, (_, i) => ({
    id: `${tag}${String(i).padStart(6, '0')}`,
    model: 'IMP-M1', pid: `P${90000 + i}`, title: `导入题 ${i}`, difficulty: 3, thinking: 'max',
    categories: [], submissions: [{ score: 100, result: 'AC', note: '' }],
    minutes: 5, memory: 64, date: '2026-09-01', note: '', author: 'ghost',
    createdAt: '2026-09-01T00:00:00Z', updatedAt: `2026-09-01T00:${String(i % 60).padStart(2, '0')}:00Z`,
  }))
  const bundleOf = (recs, revision = 7) => ({ app: 'AI vs 洛谷', version: 3, revision, records: recs, problems: {}, models: [] })
  const big = synth(1000, 'imp')
  const imp = await call(owner, 'POST', '/api/import', { mode: 'replace', data: bundleOf(big) })
  ok('replace 导入 1000 条成功（旧实现 45/995 条即炸查询预算）', imp.data?.ok === true && imp.data?.imported === 1000, JSON.stringify(imp.data))
  ok('replace 后目录被清空（题目/模型不再收录）',
    (await call(owner, 'GET', '/api/models')).data?.models?.length === 0)
  const guestAfter = await call(tmp, 'GET', '/api/data')
  ok('导入的历史记录未收录 → 游客不可见', (guestAfter.data?.records ?? []).length === 0,
    `实际 ${guestAfter.data?.records?.length} 条`)
  ok('管理员全量导出可见 1000 条',
    ((await call(owner, 'GET', '/api/export')).data?.records ?? []).length === 1000)

  // 大体积记录：按**字节**预算切成多条 json_each 语句（单条绑定值受 D1「字符串 ≤ 2MB」约束，
  // 中文 1 字符 = 3 字节，所以预算绝不能按字符数算）。
  // 体积走合法字段组合：40 轮 × 300 字轮次说明（MAX_SUBMISSIONS / MAX_SUB_NOTE 之内）≈ 38KB/条。
  const roundNote = '轮次说明中文示例'.slice(0, 8).repeat(37)          // 296 字（MAX_SUB_NOTE = 300 之内）
  const fatSubs = Array.from({ length: 40 }, (_, k) => ({ score: k, result: 'AC', note: roundNote }))
  const fat = Array.from({ length: 60 }, (_, i) => ({
    ...synth(1, 'fat')[0], id: `fat${String(i).padStart(6, '0')}`, submissions: fatSubs,
    updatedAt: `2026-09-02T00:00:${String(i % 60).padStart(2, '0')}Z`,
  }))
  const fatImp = await call(owner, 'POST', '/api/import', { mode: 'merge', data: bundleOf(fat) })
  ok('大体积导入按字节分片成功（60 条 × ~38KB）', fatImp.data?.ok === true && fatImp.data?.imported === 60,
    JSON.stringify(fatImp.data))
  ok('确实切成了多条批量语句（而非 1 条巨语句 / 60 条单行语句）',
    fatImp.data?.statements > 1 && fatImp.data.statements < 60, `statements=${fatImp.data?.statements}`)
  const afterFat = ((await call(owner, 'GET', '/api/export')).data?.records ?? [])
  ok('分片后条数完整落库', afterFat.length === 1060, `实际 ${afterFat.length}`)
  const fat0 = afterFat.find((r) => r.id === 'fat000000')
  ok('分片后内容未被截断', fat0?.submissions?.length === 40 && fat0?.submissions?.[39]?.note === roundNote,
    `实际轮次 ${fat0?.submissions?.length}`)
  const overImp = await call(owner, 'POST', '/api/import', {
    mode: 'merge',
    data: bundleOf([{ ...synth(1, 'over')[0], id: 'over000000', note: '超'.repeat(5000) }]),
  })
  ok('超限字段被白名单拦下，并在响应里报出丢弃数（不再静默少写）',
    overImp.data?.imported === 0 && overImp.data?.invalid === 1, JSON.stringify(overImp.data))

  // merge：来件 updatedAt 较新者胜 + 命中回收站视为找回（一条 upsert 完成，不再逐条 SELECT）
  const older = bundleOf([{ ...big[0], updatedAt: '2020-01-01T00:00:00Z', note: '不该覆盖' }])
  ok('merge 忽略更旧的来件', (await call(owner, 'POST', '/api/import', { mode: 'merge', data: older })).data?.ok)
  const stillClean = ((await call(owner, 'GET', '/api/export')).data?.records ?? [])
    .find((r) => r.id === 'imp000000')
  ok('旧数据未被 merge 覆盖', stillClean?.note !== '不该覆盖', `note=${stillClean?.note}`)
  const newer = bundleOf([{ ...big[0], updatedAt: '2099-01-01T00:00:00Z', note: '较新来件' }])
  await call(owner, 'POST', '/api/import', { mode: 'merge', data: newer })
  ok('merge 采纳更新的来件',
    ((await call(owner, 'GET', '/api/export')).data?.records ?? []).find((r) => r.id === 'imp000000')?.note === '较新来件')
  await call(owner, 'DELETE', '/api/records/imp000001')
  ok('记录已进回收站', ((await call(owner, 'GET', '/api/trash')).data?.records ?? []).some((r) => r.id === 'imp000001'))
  await call(owner, 'POST', '/api/import', { mode: 'merge', data: bundleOf([{ ...big[1], updatedAt: '1999-01-01T00:00:00Z' }]) })
  ok('merge 命中回收站记录视为找回（即使来件更旧也清 deleted_at）',
    ((await call(owner, 'GET', '/api/trash')).data?.records ?? []).every((r) => r.id !== 'imp000001'))
  ok('找回后记录回到全量导出',
    ((await call(owner, 'GET', '/api/export')).data?.records ?? []).some((r) => r.id === 'imp000001'))
  ok('删不存在的记录 → 404（不再静默成功）', (await call(owner, 'DELETE', '/api/records/nope000')).status === 404)

  // 7.9 请求边界（回归 P1-9：非法转义冒 500、方法不匹配冒 404）
  ok('路径含非法转义 → 400（不是 500）', (await call(tmp, 'GET', '/api/records/%E0%A4%A')).status === 400)
  ok('对 GET 端点发 POST → 405（不是 404）', (await call(tmp, 'POST', '/api/ping', {})).status === 405)
  const noCsrf = await fetch(apiUrl('/api/models'), {
    method: 'POST', headers: { Cookie: (await prime(new Jar())).header(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'X' }),
  })
  ok('缺 X-CSRF-Token 的写请求 → 403', noCsrf.status === 403, `实际 ${noCsrf.status}`)

  // 7.10 题目信息单一来源（服务端权威，回归 P0-5）+ 布尔三态合并（回归 P0-4）
  // 注意：contrib 罐里的 eve 已在第 7 步被站长删除，这里另建一个在册贡献者
  await call(tmp, 'POST', '/api/auth/register', { username: 'gina', nickname: 'Gina', password: 'ginapass12345' })
  const ginaId = await idOf('gina')
  ok('站长批准 gina（本题用在册贡献者）', (await call(owner, 'POST', `/api/admin/users/${ginaId}/approve`)).data?.ok)
  const gina = await prime(new Jar())
  ok('gina 登录', (await call(gina, 'POST', '/api/login', user('gina', 'ginapass12345'))).data?.role === 'contributor')
  await call(owner, 'POST', '/api/models', { name: 'CAT-M1', vendor: 'T' })
  await call(owner, 'POST', '/api/problems', {
    pid: 'P1001', problem: { title: '目录权威题名', difficulty: 5, tags: [], categories: [], prompt: '', content: '', hasAttachments: true, manual: false },
  })
  const forged = await call(gina, 'POST', '/api/records', {
    record: { model: 'CAT-M1', pid: 'P1001', title: '客户端伪造题名', difficulty: 1, thinking: 'max', submissions: [{ score: 100, result: 'AC' }], date: '2026-09-06' },
  })
  ok('贡献者提交的题名/难度被目录值覆盖', forged.data?.record?.title === '目录权威题名' && forged.data?.record?.difficulty === 5,
    `HTTP ${forged.status} ${JSON.stringify(forged.data?.record ?? forged.data)}`)
  const forgedId = forged.data?.record?.id
  const conflict = await call(owner, 'PUT', `/api/records/${forgedId}`, {
    record: { model: 'CAT-M1', pid: 'P1001', thinking: 'max', difficulty: 5, submissions: [{ score: 100, result: 'AC' }], date: '2026-09-06' },
    baseUpdatedAt: '1999-01-01T00:00:00Z',
  })
  ok('乐观并发：baseUpdatedAt 不符 → 409（不再静默覆盖）', conflict.status === 409, `HTTP ${conflict.status}`)
  const freshRec = ((await call(owner, 'GET', '/api/data')).data?.records ?? []).find((r) => r.id === forgedId)
  ok('409 时库里数据未被改写', freshRec?.date === '2026-09-06' && freshRec?.submissions?.[0]?.score === 100,
    JSON.stringify(freshRec?.date))
  const okWrite = await call(owner, 'PUT', `/api/records/${forgedId}`, {
    record: { model: 'CAT-M1', pid: 'P1001', thinking: 'max', difficulty: 5, submissions: [{ score: 80, result: 'WA' }], date: '2026-09-07' },
    baseUpdatedAt: freshRec?.updatedAt,
  })
  ok('乐观并发：基线一致时正常写入', okWrite.data?.ok === true && okWrite.data?.record?.date === '2026-09-07',
    `HTTP ${okWrite.status} ${JSON.stringify(okWrite.data)}`)
  // 回归 P1-7：归属只认 author_id。历史导入数据（author_id 为 null）即使 author 用户名与某人相同，
  // 那个人也不能认领修改——旧实现按 author === username 兜底，删号后同名重注册即可认领他人记录。
  await call(owner, 'POST', '/api/import', {
    mode: 'merge',
    data: bundleOf([{
      id: 'legacy1', model: 'CAT-M1', pid: 'P1001', title: '历史数据', difficulty: 5, thinking: 'max',
      submissions: [{ score: 100, result: 'AC', note: '' }], date: '2026-08-01',
      author: 'gina', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z',
    }]),
  })
  const squat = await call(gina, 'PUT', '/api/records/legacy1', {
    record: { model: 'CAT-M1', pid: 'P1001', thinking: 'max', difficulty: 5, submissions: [{ score: 0, result: 'WA' }], date: '2026-08-01' },
  })
  ok('同名贡献者不能认领 author_id 为空的历史记录（403）', squat.status === 403, `HTTP ${squat.status}`)
  ok('站长可以修改该历史记录', (await call(owner, 'PUT', '/api/records/legacy1', {
    record: { model: 'CAT-M1', pid: 'P1001', thinking: 'max', difficulty: 5, submissions: [{ score: 100, result: 'AC' }], date: '2026-08-02' },
  })).data?.ok === true)
  const otherUser = await call(gina, 'PUT', `/api/records/${forgedId}`, {
    record: { model: 'CAT-M1', pid: 'P1001', thinking: 'max', difficulty: 5, submissions: [{ score: 1, result: 'WA' }], date: '2026-09-09' },
  })
  ok('gina 仍可改自己提交的记录（author_id 匹配）', otherUser.data?.ok === true, `HTTP ${otherUser.status}`)
  await call(owner, 'POST', '/api/problems', {
    pid: 'P1001', problem: { title: '', difficulty: null, tags: [], categories: [], prompt: '', content: '', hasAttachments: false, manual: false },
  })
  const republished = ((await call(owner, 'GET', '/api/data')).data?.problems?.P1001) ?? {}
  ok('再次发布传 hasAttachments:false 能清掉标记', republished.hasAttachments === false,
    `实际 ${JSON.stringify(republished.hasAttachments)}`)
  await call(owner, 'PUT', '/api/problems/P1001', {
    problem: { title: '目录权威题名', difficulty: 5, tags: [], categories: [], prompt: '统一口径提示词', content: '题面', hasAttachments: false, manual: false },
  })
  await call(owner, 'POST', '/api/problems', {
    pid: 'P1001', problem: { title: '', difficulty: null, tags: [], categories: [], content: '', hasAttachments: false, manual: false },
  })
  const kept = ((await call(owner, 'GET', '/api/data')).data?.problems?.P1001) ?? {}
  ok('发布请求未提供 prompt 字段 → 不覆盖既有提示词', kept.prompt === '统一口径提示词', `实际 ${JSON.stringify(kept.prompt)}`)

  // 7.11 cache_epoch（回归 P0-2：破坏性操作后旧 ETag 不得再命中 304）
  const beforeReset = await call(tmp, 'GET', '/api/data')
  const oldEtag = beforeReset.headers?.get('etag')
  ok('站长清空收录目录', (await call(owner, 'POST', '/api/catalog/reset')).data?.ok)
  const afterReset = await call(tmp, 'GET', '/api/data', undefined, oldEtag ? { 'If-None-Match': oldEtag } : {})
  ok('清库后旧 ETag 不再 304（校验器已换分代）', afterReset.status === 200 && afterReset.headers?.get('etag') !== oldEtag,
    `实际 ${afterReset.status}`)
  ok('清库后 revision 未回零', Number(afterReset.data?.revision ?? 0) > 0, `实际 ${afterReset.data?.revision}`)
  ok('清库后数据确实为空', (afterReset.data?.records ?? []).length === 0)

  // 8. 审计日志：破坏性与权限操作全部留痕
  const audit = (await call(admin, 'GET', '/api/admin/audit')).data?.entries ?? []
  const actions = new Set(audit.map((a) => a.action))
  ok('审计含 删账号/任免/批准/拒绝', ['user.delete', 'user.role', 'user.approve', 'user.reject'].every((a) => actions.has(a)))
  ok('审计含 删记录/删题目/删模型', ['record.delete', 'problem.delete', 'model.delete'].every((a) => actions.has(a)))
  ok('审计 user.delete 条目详情含被删用户名', audit.some((a) => a.action === 'user.delete' && a.detail.includes('bob')))
  ok('审计条目带操作人', audit.every((a) => a.actor && a.createdAt))

  // 17. 农场对抗赛战绩：只有站长可写（admin/contributor 只读）
  const arenaContrib = gina   // gina 是在册贡献者（eve/carl 已在中途被删号，不能复用）
  const arenaBad = await call(arenaContrib, 'POST', '/api/arena/matches', { match: { aName: 'a1', bName: 'b1', winner: 'A', margin: 1 } })
  ok('贡献者登记战绩 → 403', arenaBad.status === 403, `HTTP ${arenaBad.status} ${JSON.stringify(arenaBad.data)}`)
  const arenaAdmin = await prime(new Jar())
  await call(arenaAdmin, 'POST', '/api/login', user('alice', 'alicepass12345'))
  const arenaAdminPost = await call(arenaAdmin, 'POST', '/api/arena/matches', { match: { aName: 'a1', bName: 'b1', winner: 'A', margin: 1 } })
  ok('管理员登记战绩 → 403（只有站长可写）', arenaAdminPost.status === 403, `HTTP ${arenaAdminPost.status}`)
  const arenaOwner = await call(owner, 'POST', '/api/arena/matches', { match: { aName: 'dsf', bName: 'qwen', winner: 'A', aCash: 24302, bCash: 2660, note: 'e2e' } })
  ok('站长登记战绩 → ok 且自动算净胜 21642', arenaOwner.data?.ok === true && arenaOwner.data?.match?.margin === 21642, JSON.stringify(arenaOwner.data))
  const arenaSelf = await call(owner, 'POST', '/api/arena/matches', { match: { aName: 'dsf', bName: 'DSF', winner: 'A', margin: 1 } })
  ok('A/B 同名被拒 → 400', arenaSelf.status === 400, `HTTP ${arenaSelf.status}`)
  const arenaBadWinner = await call(owner, 'POST', '/api/arena/matches', { match: { aName: 'a1', bName: 'b1', winner: 'C', margin: 1 } })
  ok('胜者字段非法被拒 → 400', arenaBadWinner.status === 400, `HTTP ${arenaBadWinner.status}`)
  const arenaList = await call(arenaContrib, 'GET', '/api/arena/matches')
  ok('榜单公开可读且 dsf 记 1 胜', (arenaList.data?.ok === true) && (arenaList.data?.standings || []).some((s) => s.name === 'dsf' && s.wins === 1 && s.netTotal === 21642), JSON.stringify(arenaList.data?.standings))
  const arenaId = arenaOwner.data?.match?.id
  const arenaDelContrib = await call(arenaContrib, 'DELETE', `/api/arena/matches/${arenaId}`)
  ok('贡献者删战绩 → 403', arenaDelContrib.status === 403, `HTTP ${arenaDelContrib.status}`)
  const arenaDelOwner = await call(owner, 'DELETE', `/api/arena/matches/${arenaId}`)
  ok('站长删战绩 → ok', arenaDelOwner.data?.ok === true)
  const arenaAfter = await call(owner, 'GET', '/api/arena/matches')
  ok('软删除后榜单重算（dsf 消失）', !(arenaAfter.data?.standings || []).some((s) => s.name === 'dsf'), JSON.stringify(arenaAfter.data?.standings))
  // 18. 对抗赛回放：只有站长可上传/删除，GET 公开可读（blob 在 R2）
  const tinyReplay = {
    format: 'k4u-arena-replay/1',
    meta: { seed: 11, labels: ['dsf4.1', 'qwen4'], winner: 'A', end_reason: 'cash', steps_done: 1 },
    legend: { crops: {}, animals: {}, items: [] },
    frames: [{
      t: 1,
      p: [
        { pos: [4, 4], hands: [], money: 3000, tiles: '0'.repeat(100), extra: {}, shed: {}, seeds: {}, inv: [] },
        { pos: [4, 5], hands: [], money: 3000, tiles: '0'.repeat(100), extra: {}, shed: {}, seeds: {}, inv: [] },
      ],
      act: [{ farmer: ['PASS'] }, { farmer: ['PASS'] }],
    }],
  }
  const upOwner = await call(owner, 'POST', '/api/arena/replays', { replay: tinyReplay })
  ok('站长上传回放 → ok', upOwner.data?.ok === true, 'HTTP ' + upOwner.status + ' ' + JSON.stringify(upOwner.data && upOwner.data.replay))
  const repId = upOwner.data?.replay?.id
  ok('回放元数据记录了字节/步数/种子', upOwner.data?.replay?.bytes > 0 && upOwner.data?.replay?.steps === 1 && upOwner.data?.replay?.seed === 11, JSON.stringify(upOwner.data?.replay))
  const upContrib = await call(gina, 'POST', '/api/arena/replays', { replay: tinyReplay })
  ok('贡献者上传回放 → 403', upContrib.status === 403, 'HTTP ' + upContrib.status)
  const upAdmin = await call(admin, 'POST', '/api/arena/replays', { replay: tinyReplay })
  ok('管理员上传回放 → 403（只有站长可写）', upAdmin.status === 403, 'HTTP ' + upAdmin.status)
  const listRep = await call(gina, 'GET', '/api/arena/replays')
  ok('回放列表公开可读且不含 blob', (listRep.data?.replays || []).some((r) => r.id === repId)
    && listRep.data.replays.every((r) => !('legend' in r) && typeof r.frames === 'number')
    && JSON.stringify(listRep.data).length < 20000, JSON.stringify(listRep.data?.replays))
  const getRep = await fetch(apiUrl('/api/arena/replays/' + repId))
  const repText = await getRep.text()
  const repEtag = getRep.headers.get('etag')
  const repParsed = JSON.parse(repText)
  ok('回放文件可从 R2 取回且内容一致', getRep.ok && repParsed.frames.length === 1 && repParsed.meta.seed === 11, 'HTTP ' + getRep.status)
  ok('回放带 ETag 与不可变缓存', !!repEtag && (getRep.headers.get('cache-control') || '').includes('immutable'), String(repEtag))
  const notMod = await fetch(apiUrl('/api/arena/replays/' + repId), { headers: { 'If-None-Match': repEtag } })
  ok('If-None-Match 命中 → 304', notMod.status === 304, 'HTTP ' + notMod.status)
  const badRep = await call(owner, 'POST', '/api/arena/replays', { replay: { format: 'nope', frames: [] } })
  ok('非法回放格式 → 400', badRep.status === 400, 'HTTP ' + badRep.status)
  const delRepContrib = await call(gina, 'DELETE', '/api/arena/replays/' + repId)
  ok('贡献者删回放 → 403', delRepContrib.status === 403, 'HTTP ' + delRepContrib.status)
  const delRepOwner = await call(owner, 'DELETE', '/api/arena/replays/' + repId)
  ok('站长删回放 → ok', delRepOwner.data?.ok === true)
  const afterDel = await fetch(apiUrl('/api/arena/replays/' + repId))
  ok('删除后取回 → 404', afterDel.status === 404, 'HTTP ' + afterDel.status)

} catch (e) {
  failures.push(`流程异常：${e.message}`)
  console.error('[e2e] 异常：', e)
} finally {
  await stopServer()
}

console.log(`\n[e2e] 通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过 ✓'}`)
for (const f of failures) console.log(`  ✗ ${f}`)
code = failures.length ? 1 : 0
process.exit(code)
