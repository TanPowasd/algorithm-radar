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
  // 注意：URL.pathname 赋值会把 "?" 转义成 %3F，所以带查询串时要拆开再分别赋值
  const qi = pathname.indexOf('?')
  if (qi >= 0) {
    u.pathname = pathname.slice(0, qi)
    u.search = pathname.slice(qi)
  } else {
    u.pathname = pathname
  }
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

async function localSql(command, { file, persist = PERSIST } = {}) {
  const args = [wranglerBin, 'd1', 'execute', 'DB', '--local', '--persist-to', persist, '--json',
    ...(file ? ['--file', file] : ['--command', command])]
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let output = '', errors = ''
    proc.stdout.on('data', (chunk) => { output += chunk })
    proc.stderr.on('data', (chunk) => { errors += chunk })
    proc.on('error', reject)
    proc.on('exit', (status) => {
      if (status !== 0) reject(new Error(`隔离 D1 SQL 失败：${errors || output}`))
      else {
        try { resolve(JSON.parse(output)) } catch { reject(new Error(`D1 返回不是 JSON：${output}`)) }
      }
    })
  })
}

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
  await localSql('', { file: path.join(root, 'db', 'schema.sql'), persist: path.join(PERSIST, 'schema-check') })
  ok('db/schema.sql 可独立执行', true)
  await localSql(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema_version', 'v3.16');
    CREATE TABLE arena_matches (
      id TEXT PRIMARY KEY, a_name TEXT NOT NULL, b_name TEXT NOT NULL, winner TEXT NOT NULL,
      a_cash REAL, b_cash REAL, margin REAL NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '', played_at TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
      author_id INTEGER, deleted_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE arena_replays (
      id TEXT PRIMARY KEY, a_name TEXT NOT NULL, b_name TEXT NOT NULL, seed INTEGER,
      winner TEXT NOT NULL DEFAULT '', end_reason TEXT NOT NULL DEFAULT '', steps INTEGER NOT NULL DEFAULT 0,
      frames INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0, sha256 TEXT NOT NULL DEFAULT '',
      engine_sha TEXT NOT NULL DEFAULT '', match_id TEXT, author TEXT NOT NULL DEFAULT '', author_id INTEGER,
      deleted_at TEXT, created_at TEXT NOT NULL
    );
    INSERT INTO arena_matches (id, a_name, b_name, winner, played_at, created_at)
      VALUES ('legacy-upgrade', 'legacy-a', 'legacy-b', 'A', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
  `)
  startServer()
  await waitReady()
  const migrated = await localSql("SELECT name FROM pragma_table_info('arena_matches') WHERE name IN ('competition_id', 'a_wins', 'b_wins', 'a_thinking', 'b_thinking', 'source_key')")
  ok('v3.16 旧比赛表升级补齐六列', migrated[0]?.results?.length === 6)
  const migrationIndexes = await localSql("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_records_owner', 'idx_arena_comp_played', 'idx_arena_comp_source', 'idx_replay_comp_created')")
  ok('补列后建立全部新索引', migrationIndexes[0]?.results?.length === 4)
  const migratedHistory = await call(await prime(new Jar()), 'GET', '/api/arena/matches')
  ok('升级保留旧战绩并归入默认比赛', migratedHistory.data?.matches?.some((m) => m.id === 'legacy-upgrade' && m.competitionId === 'kaggriculture'))
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
  ok('管理员发布题目', (await call(admin, 'POST', '/api/problems', { pid: 'B1001', problem: {
    title: 'Test Problem', difficulty: 2, categories: ['simulation'], content: 'Full problem statement', prompt: 'Custom test prompt',
  } })).data?.ok)
  const bobId = await idOf('bob')
  ok('bob 登录并提交测评（pending）', (await call(contrib, 'POST', '/api/login', user('bob', 'bobpass12345'))).data?.ok
    && (await call(contrib, 'POST', '/api/records', { record: { model: 'GPT-5', pid: 'B1001', thinking: 'max', difficulty: 2, submissions: [{ score: 100, result: 'AC' }], date: '2026-09-05', minutes: 10 } })).data?.record?.status === 'pending')
  const recId = ((await call(admin, 'GET', '/api/data')).data?.records ?? []).find((r) => r.author === 'bob')?.id
  ok('管理员审核通过 bob 的记录', (await call(admin, 'POST', `/api/records/${recId}/status`, { status: 'approved' })).data?.ok)
  const oldBobPending = (await call(contrib, 'POST', '/api/records', { record: {
    model: 'GPT-5', pid: 'B1001', thinking: 'low', difficulty: 2,
    submissions: [{ score: 40, result: 'WA' }], date: '2026-09-05', note: 'old-bob-private',
  } })).data?.record

  // 4. 权限矩阵：删除账号
  ok('管理员删除已激活贡献者 bob → 允许', (await call(admin, 'DELETE', `/api/admin/users/${bobId}`)).data?.ok)
  ok('bob 会话立即失效', (await call(contrib, 'GET', '/api/admin/users')).status === 401)
  ok('bob 的已审核记录保留（author 快照）',
    ((await call(tmp, 'GET', '/api/data')).data?.records ?? []).some((r) => r.author === 'bob' && r.status === 'approved'))
  // 不用重新注册验证 ID 释放（注册限流 6 次/小时会撞上限）：用户列表里查不到即视为已释放
  ok('被删用户名从用户列表消失（ID 已释放）', !(await listFor()).some((u) => u.username === 'bob'))
  await call(tmp, 'POST', '/api/auth/register', { username: 'bob', nickname: 'New Bob', password: 'newbobpass123' })
  await call(owner, 'POST', `/api/admin/users/${await idOf('bob')}/approve`)
  const replacementBob = await prime(new Jar())
  await call(replacementBob, 'POST', '/api/login', user('bob', 'newbobpass123'))
  const replacementView = await call(replacementBob, 'GET', '/api/data?view=compact')
  ok('同名重注册不能读取旧账号 pending', oldBobPending?.id && !replacementView.data?.records?.some((r) => r.id === oldBobPending.id))
  ok('管理员删站长 → 拒绝', (await call(admin, 'DELETE', `/api/admin/users/${await idOf('boss')}`)).data?.error === '不能删除站长账号')
  ok('管理员删自己 → 拒绝', (await call(admin, 'DELETE', `/api/admin/users/${await idOf('alice')}`)).data?.error === '不能删除自己的账号')
  ok('管理员删待审账号 dave → 拒绝', (await call(admin, 'DELETE', `/api/admin/users/${await idOf('dave')}`)).data?.error === '管理员只能删除已激活的贡献者账号')

  // 5. 贡献者权限
  ok('eve 登录', (await call(contrib, 'POST', '/api/login', user('eve', 'evepass12345'))).data?.role === 'contributor')
  ok('真实会话返回归属判断所需的用户ID', (await call(contrib, 'GET', '/api/session')).data?.uid === await idOf('eve'))
  ok('游客会话用户ID为空', (await call(tmp, 'GET', '/api/session')).data?.uid === null)
  ok('贡献者看用户列表 → 403', (await call(contrib, 'GET', '/api/admin/users')).status === 403)
  ok('贡献者看审计 → 403', (await call(contrib, 'GET', '/api/admin/audit')).status === 403)
  ok('贡献者删账号 → 403', (await call(contrib, 'DELETE', `/api/admin/users/${await idOf('carl')}`)).status === 403)

  const other = await prime(new Jar())
  await call(other, 'POST', '/api/login', user('carl', 'carlpass12345'))
  const pendingRecord = (note) => ({ model: 'GPT-5', pid: 'B1001', thinking: 'high', difficulty: 2,
    submissions: [{ score: 75, result: 'WA', timeMs: 1000, memoryMb: 125 }], date: '2026-09-05', note })
  const ownA = (await call(contrib, 'POST', '/api/records', { record: pendingRecord('eve-pending') })).data?.record
  const ownB = (await call(other, 'POST', '/api/records', { record: pendingRecord('carl-pending') })).data?.record
  const compactA = await call(contrib, 'GET', '/api/data?view=compact')
  const compactB = await call(other, 'GET', '/api/data?view=compact')
  const compactGuest = await call(tmp, 'GET', '/api/data?view=compact')
  ok('compact 明确源版本与身份范围', typeof compactA.data?.epoch === 'string' && typeof compactA.data?.revision === 'number'
    && compactA.data?.scope === `user:${await idOf('eve')}` && compactGuest.data?.scope === 'public')
  ok('compact 不带题面并保留模板标记', !('content' in (compactA.data?.problems?.B1001 || {}))
    && compactA.data?.problems?.B1001?.hasContent === true && compactA.data?.problems?.B1001?.hasPrompt === true)
  ok('两名贡献者仅可读自己的 pending', compactA.data?.records?.some((r) => r.id === ownA?.id)
    && !compactA.data?.records?.some((r) => r.id === ownB?.id)
    && compactB.data?.records?.some((r) => r.id === ownB?.id)
    && !compactB.data?.records?.some((r) => r.id === ownA?.id))
  ok('游客不含 pending', compactGuest.data?.records?.every((r) => r.status === 'approved'))
  ok('不同贡献者/游客 ETag 各自隔离', compactA.headers.get('etag') !== compactB.headers.get('etag')
    && compactA.headers.get('etag') !== compactGuest.headers.get('etag'))
  const scoped304 = await call(contrib, 'GET', '/api/data?view=compact', undefined, { 'If-None-Match': compactA.headers.get('etag') })
  const wrongUserTag = await call(other, 'GET', '/api/data?view=compact', undefined, { 'If-None-Match': compactA.headers.get('etag') })
  const wrongGuestTag = await call(tmp, 'GET', '/api/data?view=compact', undefined, { 'If-None-Match': compactA.headers.get('etag') })
  ok('同范围 ETag 返回304，跨身份强制200', scoped304.status === 304 && wrongUserTag.status === 200 && wrongGuestTag.status === 200)
  ok('压缩响应的弱ETag仍命中304', (await call(contrib, 'GET', '/api/data?view=compact', undefined,
    { 'If-None-Match': 'W/' + compactA.headers.get('etag') })).status === 304)
  const fullA = await call(contrib, 'GET', '/api/data', undefined, { 'If-None-Match': compactA.headers.get('etag') })
  ok('默认完整形状兼容，compact ETag 不混用', fullA.status === 200 && fullA.data?.problems?.B1001?.content === 'Full problem statement'
    && fullA.headers.get('etag') !== compactA.headers.get('etag'))
  ok('身份响应禁止共享缓存', compactA.headers.get('cache-control')?.includes('private') && compactA.headers.get('vary') === 'Cookie')
  const detail = await call(tmp, 'GET', '/api/problems/B1001')
  ok('公开详情含完整题面/定制模板', detail.data?.problem?.content === 'Full problem statement' && detail.data?.problem?.prompt === 'Custom test prompt')
  ok('未发布题目详情404', (await call(tmp, 'GET', '/api/problems/P999999')).status === 404)
  const invalidTitle = await call(owner, 'PUT', '/api/problems/B1001', { problem: { title: 'bad\uFFFDtitle' } })
  ok('拒绝包含编码替换字符的题名', invalidTitle.status === 400 && invalidTitle.data?.error?.includes('UTF-8'))
  ok('编码错误不覆盖已有题名', (await call(tmp, 'GET', '/api/problems/B1001')).data?.problem?.title === detail.data?.problem?.title)

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
  // 18. 比赛维度：默认比赛兼容 + 新建比赛 + 跨比赛隔离（v3.14）
  const cupReplay = {
    format: 'k4u-arena-replay/1',
    meta: { seed: 7, labels: ['p1', 'p2'], winner: 'A', end_reason: 'cash', steps_done: 1 },
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
  const compList = await call(owner, 'GET', '/api/competitions')
  ok('比赛列表含默认比赛（农场对抗赛）', (compList.data?.competitions || []).some((c) => c.slug === 'kaggriculture'),
    JSON.stringify(compList.data?.competitions?.[0] || null))
  const defMatches = await call(owner, 'GET', '/api/arena/matches')
  const kgMatches = await call(owner, 'GET', '/api/arena/matches?competition=kaggriculture')
  ok('缺省比赛 = kaggriculture（旧链接行为不变）',
    defMatches.data?.competitionId === 'kaggriculture'
    && (defMatches.data?.matches || []).length === (kgMatches.data?.matches || []).length,
    JSON.stringify({ def: defMatches.data?.matches?.length, kg: kgMatches.data?.matches?.length }))
  const compContrib = await call(gina, 'POST', '/api/competitions', { competition: { slug: 'test-cup', name: '测试杯' } })
  ok('贡献者新建比赛 → 403', compContrib.status === 403, 'HTTP ' + compContrib.status)
  const compNew = await call(owner, 'POST', '/api/competitions', {
    competition: { slug: 'test-cup', name: '测试杯', subtitle: 'e2e 专用', scoreModel: 'weighted_rank', sort: 9 },
  })
  ok('站长新建比赛 → ok', compNew.data?.ok === true && compNew.data?.competition?.slug === 'test-cup',
    'HTTP ' + compNew.status + ' ' + JSON.stringify(compNew.data))
  const compDup = await call(owner, 'POST', '/api/competitions', { competition: { slug: 'test-cup', name: '重名' } })
  ok('短名重复 → 400', compDup.status === 400, 'HTTP ' + compDup.status)
  const compBadSlug = await call(owner, 'POST', '/api/competitions', { competition: { slug: 'Bad Slug!', name: 'x' } })
  ok('短名非法 → 400', compBadSlug.status === 400, 'HTTP ' + compBadSlug.status)
  const compMatch = await call(owner, 'POST', '/api/arena/matches', {
    competition: 'test-cup', match: { aName: 'p1', bName: 'p2', winner: 'A', aCash: 100, bCash: 50 },
  })
  ok('往新比赛登记战绩 → ok 且归属正确', compMatch.data?.match?.competitionId === 'test-cup',
    JSON.stringify(compMatch.data?.match || null))
  const tcMatches = await call(owner, 'GET', '/api/arena/matches?competition=test-cup')
  const kgOnly = await call(owner, 'GET', '/api/arena/matches?competition=kaggriculture')
  ok('跨比赛隔离：各看各的',
    (tcMatches.data?.matches || []).length === 1
    && (tcMatches.data?.matches || []).every((m) => m.competitionId === 'test-cup')
    && !(kgOnly.data?.matches || []).some((m) => m.competitionId === 'test-cup'),
    JSON.stringify({ tcStatus: tcMatches.status, tc: tcMatches.data, kgStatus: kgOnly.status, kgLen: kgOnly.data?.matches?.length }).slice(0, 300))
  const compDetail = await call(owner, 'GET', '/api/competitions/test-cup')
  ok('比赛详情一次返回比赛 + 战绩 + 积分榜',
    compDetail.data?.competition?.name === '测试杯' && compDetail.data?.competition?.matches === 1
    && (compDetail.data?.matches || []).length === 1 && Array.isArray(compDetail.data?.standings),
    JSON.stringify(compDetail.data?.competition || null))
  const compMissing = await call(owner, 'GET', '/api/competitions/no-such-cup')
  ok('不存在的比赛 → 404', compMissing.status === 404, 'HTTP ' + compMissing.status)
  const compBadQuery = await call(owner, 'GET', '/api/arena/matches?competition=no-such-cup')
  ok('战绩查询指定不存在的比赛 → 404', compBadQuery.status === 404, 'HTTP ' + compBadQuery.status)
  const compRep = await call(owner, 'POST', '/api/arena/replays', { competition: 'test-cup', replay: cupReplay })
  ok('回放也能归属到指定比赛', compRep.data?.replay?.competitionId === 'test-cup', JSON.stringify(compRep.data?.replay || null))
  const compRepList = await call(owner, 'GET', '/api/arena/replays?competition=test-cup')
  ok('回放按比赛隔离', (compRepList.data?.replays || []).length === 1
    && compRepList.data.replays.every((r) => r.competitionId === 'test-cup'), JSON.stringify(compRepList.data?.replays?.length))
  // 19. 对抗赛回放：只有站长可上传/删除，GET 公开可读（blob 在 R2）
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
  ok('回放弱ETag命中304', (await fetch(apiUrl('/api/arena/replays/' + repId),
    { headers: { 'If-None-Match': 'W/' + repEtag } })).status === 304)
  const badRep = await call(owner, 'POST', '/api/arena/replays', { replay: { format: 'nope', frames: [] } })
  ok('非法回放格式 → 400', badRep.status === 400, 'HTTP ' + badRep.status)
  const delRepContrib = await call(gina, 'DELETE', '/api/arena/replays/' + repId)
  ok('贡献者删回放 → 403', delRepContrib.status === 403, 'HTTP ' + delRepContrib.status)
  const delRepOwner = await call(owner, 'DELETE', '/api/arena/replays/' + repId)
  ok('站长删回放 → ok', delRepOwner.data?.ok === true)
  const afterDel = await fetch(apiUrl('/api/arena/replays/' + repId))
  ok('删除后取回 → 404', afterDel.status === 404, 'HTTP ' + afterDel.status)
  // 20. 局级 ELO + 两两对比（v3.15）：用独立比赛做定量校验，互不污染
  const boardOf = async (slug) => (await call(owner, 'GET', '/api/competitions/' + slug)).data?.standings || []
  const rowIn = (board, name) => board.find((s) => s.name === name)
  const eloIn = (board, name) => rowIn(board, name)?.elo
  await call(owner, 'POST', '/api/competitions', { competition: { slug: 'elo-lab', name: 'ELO 试验场' } })
  await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab', match: {
    aName: 'A', bName: 'B', winner: 'A', games: 16, aWins: 16, bWins: 0, playedAt: '2026-01-01T00:00:01Z' } })
  const lab1 = await boardOf('elo-lab')
  const eloA16 = eloIn(lab1, 'A')
  ok('ELO：16:0 后 A 高于起分且不越过理论上限 1692', eloA16 > 1600 && eloA16 <= 1692, 'A=' + eloA16)
  ok('ELO：一局一更新，双方评分互补（和恒等于 3000）', Math.abs((eloA16 + eloIn(lab1, 'B')) - 3000) <= 1, 'A+B=' + (eloA16 + eloIn(lab1, 'B')))
  ok('ELO 榜按 ELO 降序', lab1[0]?.name === 'A' && lab1[0].elo >= lab1[1].elo)
  ok('局统计：A 局数 16、局胜 16、局胜率 100%',
    rowIn(lab1, 'A').games === 16 && rowIn(lab1, 'A').gameWins === 16 && rowIn(lab1, 'A').gameWinRate === 1,
    JSON.stringify(rowIn(lab1, 'A')))
  await call(owner, 'POST', '/api/competitions', { competition: { slug: 'elo-lab2', name: 'ELO 试验场2' } })
  await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab2', match: {
    aName: 'A', bName: 'B', winner: 'A', games: 16, aWins: 9, bWins: 7, playedAt: '2026-01-01T00:00:01Z' } })
  const eloA97 = eloIn(await boardOf('elo-lab2'), 'A')
  ok('ELO：同样 16 局，16:0 比 9:7 涨得多（局比分不再被压成 1 场）', eloA97 < eloA16, '16:0 → ' + eloA16 + '，9:7 → ' + eloA97)
  await call(owner, 'POST', '/api/competitions', { competition: { slug: 'elo-lab3', name: 'ELO 试验场3' } })
  await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab3', match: {
    aName: 'P', bName: 'Q', winner: 'A', games: 16, aWins: 16, bWins: 0, playedAt: '2026-01-01T00:00:01Z' } })
  await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab3', match: {
    aName: 'R', bName: 'P', winner: 'A', games: 16, aWins: 9, bWins: 7, playedAt: '2026-01-01T00:00:02Z' } })
  await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab3', match: {
    aName: 'S', bName: 'Q', winner: 'A', games: 16, aWins: 9, bWins: 7, playedAt: '2026-01-01T00:00:03Z' } })
  const lab3 = await boardOf('elo-lab3')
  ok('ELO：赢强对手比赢弱对手涨得多', (eloIn(lab3, 'R') - 1500) > (eloIn(lab3, 'S') - 1500),
    'R=' + eloIn(lab3, 'R') + ' S=' + eloIn(lab3, 'S'))
  const okScore = await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab', match: {
    aName: 'C', bName: 'D', winner: 'A', aWins: 5, bWins: 3 } })
  ok('只填局比分、不填局数 → 局数自动取 8', okScore.data?.match?.games === 8 && okScore.data?.match?.aWins === 5, JSON.stringify(okScore.data?.match || null))
  const badWinner = await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab', match: {
    aName: 'C', bName: 'D', winner: 'A', aWins: 3, bWins: 5 } })
  ok('局比分与胜者不一致 → 400', badWinner.status === 400, 'HTTP ' + badWinner.status)
  const badSum = await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab', match: {
    aName: 'C', bName: 'D', winner: 'A', games: 16, aWins: 16, bWins: 2 } })
  ok('局比分之和与局数不符 → 400', badSum.status === 400, 'HTTP ' + badSum.status)
  const halfScore = await call(owner, 'POST', '/api/arena/matches', { competition: 'elo-lab', match: {
    aName: 'C', bName: 'D', winner: 'A', aWins: 5 } })
  ok('只填一侧局比分 → 400', halfScore.status === 400, 'HTTP ' + halfScore.status)
  const h2h = await call(gina, 'GET', '/api/arena/h2h?competition=elo-lab&a=A&b=B')
  ok('两两对比公开可读，交手合计正确（A 16:0 B）',
    h2h.status === 200 && h2h.data?.a?.name === 'A' && h2h.data?.series?.length === 1
    && h2h.data?.a?.seriesWins === 1 && h2h.data?.a?.gameWins === 16 && h2h.data?.b?.gameWins === 0
    && h2h.data?.series?.[0]?.aWins === 16 && typeof h2h.data?.eloA === 'number',
    JSON.stringify(h2h.data?.a || null))
  const h2hSwap = await call(gina, 'GET', '/api/arena/h2h?competition=elo-lab&a=B&b=A')
  ok('两两对比对调 A/B：胜负与局比分互换',
    h2hSwap.data?.a?.seriesWins === 0 && h2hSwap.data?.a?.seriesLosses === 1
    && h2hSwap.data?.series?.[0]?.aWins === 0 && h2hSwap.data?.series?.[0]?.bWins === 16,
    JSON.stringify(h2hSwap.data?.a || null))
  const h2hSame = await call(gina, 'GET', '/api/arena/h2h?a=dsf&b=DSF')
  ok('两侧同一模型（忽略大小写）→ 400', h2hSame.status === 400, 'HTTP ' + h2hSame.status)
  const h2hMissing = await call(gina, 'GET', '/api/arena/h2h?a=dsf')
  ok('两两对比缺参数 → 400', h2hMissing.status === 400, 'HTTP ' + h2hMissing.status)
  const h2hNone = await call(gina, 'GET', '/api/arena/h2h?a=nobody-a&b=nobody-b')
  // 21. 登记自动化（来源键去重）+ 思考强度 + 批量改名（v3.16）
  await call(owner, 'POST', '/api/competitions', { competition: { slug: 'think-lab', name: '思考强度试验场' } })
  await call(owner, 'POST', '/api/arena/matches', { competition: 'think-lab', match: {
    aName: 'M', bName: 'N', winner: 'A', games: 16, aWins: 16, bWins: 0,
    aThinking: 'high', bThinking: 'low', playedAt: '2026-02-01T00:00:01Z' } })
  await call(owner, 'POST', '/api/arena/matches', { competition: 'think-lab', match: {
    aName: 'M', bName: 'N', winner: 'B', games: 16, aWins: 0, bWins: 16,
    aThinking: 'max', bThinking: 'low', playedAt: '2026-02-01T00:00:02Z' } })
  const thinkBoard = await boardOf('think-lab')
  ok('同一名字不同思考强度算两个选手',
    thinkBoard.filter((s) => s.name === 'M').length === 2
    && thinkBoard.some((s) => s.name === 'M' && s.thinking === 'high')
    && thinkBoard.some((s) => s.name === 'M' && s.thinking === 'max'),
    JSON.stringify(thinkBoard.map((s) => s.name + '/' + s.thinking)))
  const badThink = await call(owner, 'POST', '/api/arena/matches', { competition: 'think-lab', match: {
    aName: 'M', bName: 'N', winner: 'A', aThinking: 'ultra' } })
  ok('非法思考强度 → 400', badThink.status === 400, 'HTTP ' + badThink.status)
  const thinkH2h = await call(owner, 'GET', '/api/arena/h2h?competition=think-lab&a=M&b=N&aThinking=high&bThinking=low&strict=1')
  ok('两两对比可按思考强度精确匹配（只算 M·high）',
    thinkH2h.data?.a?.seriesWins === 1 && thinkH2h.data?.a?.thinking === 'high'
    && (thinkH2h.data?.series || []).length === 1, JSON.stringify(thinkH2h.data?.a || null))
  const thinkH2hLoose = await call(owner, 'GET', '/api/arena/h2h?competition=think-lab&a=M&b=N')
  ok('不带思考强度时汇总该名字的全部对局', (thinkH2hLoose.data?.series || []).length === 2,
    '实际 ' + (thinkH2hLoose.data?.series || []).length)
  const impBody = { competition: 'think-lab', match: {
    aName: 'M', bName: 'N', winner: 'A', games: 16, aWins: 16, bWins: 0,
    sourceKey: 'league:11-23:import-test', note: '导入测试', playedAt: '2026-02-01T00:00:03Z' } }
  const imp1 = await call(owner, 'POST', '/api/arena/matches', impBody)
  ok('导入登记 → ok 且带来源键', imp1.data?.match?.sourceKey === 'league:11-23:import-test',
    JSON.stringify(imp1.data?.match || null))
  const imp2 = await call(owner, 'POST', '/api/arena/matches', impBody)
  ok('同一来源重复导入 → 400（不会重复登记同一轮）', imp2.status === 400, 'HTTP ' + imp2.status)
  const impBad = await call(owner, 'POST', '/api/arena/matches', { competition: 'think-lab', match: {
    aName: 'M', bName: 'N', winner: 'A', aWins: 3, bWins: 5, sourceKey: 'league:bad' } })
  ok('导入数据自相矛盾（胜者与局比分不符）→ 400', impBad.status === 400, 'HTTP ' + impBad.status)
  const renContrib = await call(gina, 'POST', '/api/arena/agents/rename',
    { competition: 'think-lab', fromName: 'M', toName: 'MM' })
  ok('贡献者批量改名 → 403', renContrib.status === 403, 'HTTP ' + renContrib.status)
  const renDry = await call(owner, 'POST', '/api/arena/agents/rename',
    { competition: 'think-lab', fromName: 'M', fromThinking: 'high', toName: 'M', toThinking: 'xhigh', dryRun: true })
  ok('预览影响（dryRun）只统计不改数据',
    renDry.data?.dryRun === true && (renDry.data?.asA + renDry.data?.asB) === 1, JSON.stringify(renDry.data))
  const before = (await boardOf('think-lab')).find((s) => s.name === 'M' && s.thinking === 'high')
  const renDo = await call(owner, 'POST', '/api/arena/agents/rename',
    { competition: 'think-lab', fromName: 'M', fromThinking: 'high', toName: 'M', toThinking: 'xhigh' })
  const after = await boardOf('think-lab')
  const moved = after.find((s) => s.name === 'M' && s.thinking === 'xhigh')
  ok('批量改名后身份带着原有战绩（ELO/局数/胜负不变）',
    renDo.data?.ok === true && !!moved && moved.games === before.games && moved.elo === before.elo
    && moved.gameWins === before.gameWins, JSON.stringify({ before, moved }))
  ok('改名后旧身份消失', !after.some((s) => s.name === 'M' && s.thinking === 'high'))
  const renMissing = await call(owner, 'POST', '/api/arena/agents/rename',
    { competition: 'think-lab', fromName: 'M', fromThinking: 'low', toName: 'M', toThinking: 'medium' })
  ok('改一个没有记录的选手 → 404', renMissing.status === 404, 'HTTP ' + renMissing.status)
  const renSame = await call(owner, 'POST', '/api/arena/agents/rename',
    { competition: 'think-lab', fromName: 'M', fromThinking: 'high', toName: 'M', toThinking: 'high' })
  ok('新旧完全一样 → 400', renSame.status === 400, 'HTTP ' + renSame.status)
  const renBadThink = await call(owner, 'POST', '/api/arena/agents/rename',
    { competition: 'think-lab', fromName: 'M', toName: 'M', toThinking: 'ultra' })
  ok('改名的思考强度非法 → 400', renBadThink.status === 400, 'HTTP ' + renBadThink.status)
  const renMerge = await call(owner, 'POST', '/api/arena/agents/rename',
    { competition: 'think-lab', fromName: 'M', fromThinking: 'max', toName: 'M', toThinking: 'xhigh' })
  ok('把两个身份合并成一个（M·max → M·xhigh）→ 改到记录数 > 1',
    renMerge.data?.ok === true && (renMerge.data?.asA + renMerge.data?.asB) === 1, JSON.stringify(renMerge.data))
  // 22. 主界面排名板块依赖的公开数据（未登录也要能读）
  const homeList = await call(gina, 'GET', '/api/competitions')
  ok('主界面板块：比赛列表公开可读且带场次/回放/最近时间',
    (homeList.data?.competitions || []).length > 0
    && homeList.data.competitions.every((c) => typeof c.matches === 'number' && typeof c.replays === 'number' && 'lastPlayedAt' in c),
    JSON.stringify(homeList.data?.competitions?.[0] || null))
  const homeDetail = await call(gina, 'GET', '/api/competitions/elo-lab')
  const topStanding = (homeDetail.data?.standings || [])[0]
  ok('主界面板块：实力榜字段齐全（ELO/局数/局胜率/轮次/场均净胜/思考强度）',
    !!topStanding && typeof topStanding.elo === 'number' && typeof topStanding.games === 'number'
    && typeof topStanding.gameWinRate === 'number' && typeof topStanding.matches === 'number'
    && typeof topStanding.netAvg === 'number' && 'thinking' in topStanding,
    JSON.stringify(topStanding || null))
  const homePage = await fetch(apiUrl('/'))
  ok('主界面可打开', homePage.status === 200, 'HTTP ' + homePage.status)
  ok('没有交手的两个模型 → 200 且空列表', h2hNone.status === 200 && (h2hNone.data?.series || []).length === 0,
    'HTTP ' + h2hNone.status + ' ' + JSON.stringify(h2hNone.data?.series || null))

  // Full-history aggregation must remain independent of the returned match page.
  await call(owner, 'POST', '/api/competitions', { competition: { slug: 'history-lab', name: '完整历史测试' } })
  await localSql(`
    WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM seq WHERE n < 1101)
    INSERT INTO arena_matches (id, competition_id, a_name, b_name, winner, games, a_wins, b_wins, played_at, created_at)
      SELECT printf('history-%04d', n), 'history-lab',
        CASE WHEN n = 1 THEN 'old-a' ELSE 'current-a' END,
        CASE WHEN n = 1 THEN 'old-b' ELSE 'current-b' END,
        'A', 1, 1, 0, strftime('%Y-%m-%dT%H:%M:%SZ', '2026-01-01', '+' || n || ' minutes'),
        strftime('%Y-%m-%dT%H:%M:%SZ', '2026-01-01', '+' || n || ' minutes') FROM seq;
    UPDATE meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'arena_revision:history-lab';
  `)
  const bigHistory = await call(tmp, 'GET', '/api/competitions/history-lab')
  ok('旧默认仍返回300条，榜单使用全部1101条', bigHistory.data?.matches?.length === 300
    && bigHistory.data?.pagination?.total === 1101 && bigHistory.data?.standings?.some((s) => s.name === 'old-a')
    && bigHistory.data?.standings?.find((s) => s.name === 'current-a')?.matches === 1100)
  const historicalH2h = await call(tmp, 'GET', '/api/arena/h2h?competition=history-lab&a=old-a&b=old-b')
  ok('H2H 不再截断最近1000条之前的交锋', historicalH2h.data?.series?.length === 1 && historicalH2h.data?.a?.gameWins === 1)
  const page1 = await call(tmp, 'GET', '/api/arena/matches?competition=history-lab&limit=17')
  const page2 = await call(tmp, 'GET', '/api/arena/matches?competition=history-lab&limit=17&cursor=' + encodeURIComponent(page1.data?.pagination?.nextCursor || ''))
  ok('cursor 分页顺序稳定且无重复', page1.data?.matches?.length === 17 && page2.data?.matches?.length === 17
    && !page2.data.matches.some((m) => page1.data.matches.some((p) => p.id === m.id))
    && page1.data.matches[0]?.id === 'history-1101' && page2.data.matches[0]?.id === 'history-1084')
  ok('改变列表分页不改变全历史榜单', JSON.stringify(page1.data?.standings) === JSON.stringify(page2.data?.standings))
  ok('非法 cursor/limit 返回400', (await call(tmp, 'GET', '/api/arena/matches?competition=history-lab&cursor=bad')).status === 400
    && (await call(tmp, 'GET', '/api/arena/matches?competition=history-lab&limit=0')).status === 400)
  const unchangedCup = (await call(tmp, 'GET', '/api/competitions/test-cup')).data?.revision
  await call(owner, 'POST', '/api/arena/agents/rename', {
    competition: 'history-lab', fromName: 'current-a', toName: 'renamed-a', dryRun: true,
  })
  const afterPreview = (await call(tmp, 'GET', '/api/competitions/history-lab')).data?.revision
  ok('改名预览不推进比赛 revision', afterPreview === bigHistory.data?.revision)
  await call(owner, 'POST', '/api/arena/agents/rename', { competition: 'history-lab', fromName: 'current-a', toName: 'renamed-a' })
  const afterRename = (await call(tmp, 'GET', '/api/competitions/history-lab')).data?.revision
  ok('真实改名推进比赛 revision', afterRename > afterPreview)
  await call(owner, 'DELETE', '/api/arena/matches/history-0001')
  const afterDelete = (await call(tmp, 'GET', '/api/competitions/history-lab')).data?.revision
  ok('删除战绩推进比赛 revision', afterDelete > afterRename)
  await call(owner, 'POST', '/api/arena/matches', { competition: 'history-lab', match: { aName: 'fresh-a', bName: 'fresh-b', winner: 'A' } })
  const afterAdd = (await call(tmp, 'GET', '/api/competitions/history-lab')).data?.revision
  ok('新增战绩推进比赛 revision', afterAdd > afterDelete)
  const revisionReplay = await call(owner, 'POST', '/api/arena/replays', { competition: 'history-lab', replay: cupReplay })
  const afterReplay = (await call(tmp, 'GET', '/api/competitions/history-lab')).data?.revision
  await call(owner, 'DELETE', '/api/arena/replays/' + revisionReplay.data?.replay?.id)
  const afterReplayDelete = (await call(tmp, 'GET', '/api/competitions/history-lab')).data?.revision
  ok('回放增删原子推进比赛 revision', afterReplay > afterAdd && afterReplayDelete > afterReplay)
  ok('比赛 revision 跨比赛隔离', (await call(tmp, 'GET', '/api/competitions/test-cup')).data?.revision === unchangedCup)

  const conditionalPaths = ['/api/competitions', '/api/competitions/history-lab',
    '/api/arena/matches?competition=history-lab&limit=17',
    '/api/arena/h2h?competition=history-lab&a=renamed-a&b=current-b&strict=1&aThinking=&bThinking=']
  const validators = []
  for (const pathname of conditionalPaths) {
    const first = await call(tmp, 'GET', pathname)
    const tag = first.headers.get('etag')
    validators.push({ pathname, tag })
    const same = await call(tmp, 'GET', pathname, undefined, { 'If-None-Match': tag })
    ok(`赛事条件读取304 ${pathname}`, Boolean(tag) && same.status === 304 && same.data === null
      && same.headers.get('cache-control')?.includes('private') && same.headers.get('vary') === 'Cookie')
    ok(`赛事弱ETag命中304 ${pathname}`, (await call(tmp, 'GET', pathname, undefined,
      { 'If-None-Match': 'W/' + tag })).status === 304)
  }
  const matchesTag = validators[2].tag
  ok('比赛分页 limit 改变不混用ETag', (await call(tmp, 'GET', '/api/arena/matches?competition=history-lab&limit=18', undefined,
    { 'If-None-Match': matchesTag })).status === 200)
  ok('比赛分页 cursor 改变不混用ETag', (await call(tmp, 'GET', '/api/arena/matches?competition=history-lab&limit=17&cursor='
    + encodeURIComponent(page1.data.pagination.nextCursor), undefined, { 'If-None-Match': matchesTag })).status === 200)
  const h2hTag = validators[3].tag
  for (const query of [
    'a=current-b&b=renamed-a&strict=1&aThinking=&bThinking=',
    'a=renamed-a&b=current-b&strict=0&aThinking=&bThinking=',
    'a=renamed-a&b=current-b&strict=1&aThinking=max&bThinking=',
  ]) {
    ok(`H2H 查询形状不混用ETag ${query}`, (await call(tmp, 'GET', '/api/arena/h2h?competition=history-lab&' + query,
      undefined, { 'If-None-Match': h2hTag })).status === 200)
  }
  await call(owner, 'POST', '/api/arena/matches', { competition: 'history-lab', match: { aName: 'cache-a', bName: 'cache-b', winner: 'B' } })
  for (const { pathname, tag } of validators) {
    const changed = await call(tmp, 'GET', pathname, undefined, { 'If-None-Match': tag })
    ok(`比赛写入使旧ETag失效 ${pathname}`, changed.status === 200 && changed.headers.get('etag') !== tag)
  }
  const memoAfterWrite = (await call(tmp, 'GET', '/api/competitions/history-lab')).data
  ok('修订号改变后积分memo包含新选手', memoAfterWrite?.standings?.some((row) => row.name === 'cache-a')
    && memoAfterWrite?.standings?.some((row) => row.name === 'cache-b'))

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
