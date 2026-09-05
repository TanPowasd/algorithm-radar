/**
 * 端到端权限矩阵自检：在隔离的临时 D1 环境（wrangler pages dev --persist-to）里
 * 跑完整的账号生命周期与权限组合，防止改坏后端权限口径。
 *
 * 用法：npm run e2e   （等价于 npm run build && node scripts/e2e.mjs）
 * 前置：根目录已 npm install（需要 wrangler）。
 * 环境完全隔离：使用 .wrangler/tmp-e2e 存储目录与 8799 端口，结束即清理，
 * 不会碰本地开发数据库（8788/.wrangler/state）。
 */
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
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
const BASE_URL = `http://127.0.0.1:${PORT}/`
const PERSIST = path.join(root, '.wrangler', 'tmp-e2e')

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

async function call(jar, method, pathname, body) {
  const headers = { Cookie: jar.header() }
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = jar.csrf()
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(apiUrl(pathname), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  jar.absorb(res)
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
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
  rmSync(PERSIST, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  child = spawn(process.execPath, [
    wranglerBin, 'pages', 'dev', 'frontend/dist',
    '--port', String(PORT), '--persist-to', PERSIST,
  ], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  child.on('exit', () => { exited = true })
}

async function stopServer() {
  if (!child || exited) return
  if (process.platform === 'win32') {
    const { status } = await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('exit', resolve)
      killer.on('error', () => resolve(-1))
    })
    if (status !== 0) child.kill('SIGKILL')
  } else {
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
      const res = await fetch(apiUrl('/api/ping'))
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

  const owner = await prime(new Jar()), admin = await prime(new Jar()),
    contrib = await prime(new Jar()), tmp = await prime(new Jar())
  const user = (name, pass) => ({ username: name, password: pass })

  // 1. 初始化站长 + 五个注册账号（alice=管理员候选，bob=删号样本，carl/eve=贡献者，dave=待审，frank=管理员删号样本）
  ok('初始化站长', (await call(owner, 'POST', '/api/setup', { username: 'boss', password: 'ownerpass123', nickname: 'Owner' })).data?.ok)
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

  // 8. 审计日志：破坏性与权限操作全部留痕
  const audit = (await call(admin, 'GET', '/api/admin/audit')).data?.entries ?? []
  const actions = new Set(audit.map((a) => a.action))
  ok('审计含 删账号/任免/批准/拒绝', ['user.delete', 'user.role', 'user.approve', 'user.reject'].every((a) => actions.has(a)))
  ok('审计含 删记录/删题目/删模型', ['record.delete', 'problem.delete', 'model.delete'].every((a) => actions.has(a)))
  ok('审计 user.delete 条目详情含被删用户名', audit.some((a) => a.action === 'user.delete' && a.detail.includes('bob')))
  ok('审计条目带操作人', audit.every((a) => a.actor && a.createdAt))
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
