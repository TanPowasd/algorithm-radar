import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { chromium, expect } from '@playwright/test'

const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const root = path.dirname(frontend)
const output = path.join(root, '.verify', 'browser')
mkdirSync(output, { recursive: true })
const scrollOnly = process.env.BROWSER_CHECKS === 'scroll'
const matrixOnly = process.env.BROWSER_CHECKS === 'matrix'
const refinementOnly = process.env.BROWSER_CHECKS === 'refinement'
const report = { synthetic: true, startedAt: new Date().toISOString(), checks: [], screenshots: [], errors: [], performance: [], largeDatasets: [] }
report.selection = scrollOnly ? 'scroll' : matrixOnly ? 'matrix' : refinementOnly ? 'refinement' : 'all'
let preview, browser, baseUrl
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : null

async function check(name, task) {
  const start = performance.now()
  try {
    const detail = await task()
    report.checks.push({ name, passed: true, durationMs: performance.now() - start, detail })
    console.log(`[pass] ${name}`)
    return true
  } catch (error) {
    report.checks.push({ name, passed: false, durationMs: performance.now() - start, error: error.message, stack: error.stack })
    console.error(`[fail] ${name}: ${error.message}`)
    return false
  }
}

async function findPort() {
  const wanted = Number(process.env.BROWSER_PORT || 5180)
  for (let port = wanted; port < wanted + 20; port++) {
    const free = await new Promise((resolve) => {
      const server = net.createServer()
      server.once('error', () => resolve(false))
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
    })
    if (free) return port
  }
  throw new Error('No isolated preview port is available')
}

async function startPreview() {
  assert.ok(existsSync(path.join(frontend, 'dist', 'index.html')), 'Run the production build before browser verification')
  const port = await findPort()
  baseUrl = `http://127.0.0.1:${port}`
  report.previewUrl = baseUrl
  preview = spawn(process.execPath, [path.join(frontend, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { cwd: frontend, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let exited = false, logs = ''
  preview.stdout.on('data', (chunk) => { logs = (logs + chunk).slice(-4000) })
  preview.stderr.on('data', (chunk) => { logs = (logs + chunk).slice(-4000) })
  preview.on('exit', () => { exited = true })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (exited) throw new Error(`Preview exited: ${logs}`)
    try { if ((await fetch(baseUrl)).ok) return } catch { /* preview is starting */ }
    await delay(250)
  }
  throw new Error(`Preview did not become ready: ${logs}`)
}

async function stopPreview() {
  if (!preview) return
  if (process.platform === 'win32') await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', resolve)
    killer.once('exit', resolve)
  })
  else preview.kill('SIGTERM')
  preview = null
}

function fixture(recordCount = 374) {
  const vendors = ['OpenAI', 'Anthropic', 'Google', 'DeepSeek', 'Alibaba', 'Mistral']
  const stems = ['GPT-5.4', 'Claude Opus 4.8', 'Gemini 3.5 Pro', 'DeepSeek V4', 'Qwen 4', 'Mistral Large 3']
  const models = Array.from({ length: 34 }, (_, i) => ({ id: i + 1, name: `${stems[i % 6]}${i < 6 ? '' : ` ${Math.floor(i / 6) + 1}`}`,
    vendor: vendors[i % 6], note: 'Synthetic browser fixture', createdAt: '2026-10-01T03:00:00Z' }))
  const problemCount = recordCount >= 1000 ? Math.max(250, Math.ceil(recordCount / 10)) : 11
  const titles = ['区间动态规划', '字典树与字符串', '最短路网络', '组合计数', '森林路径查询', '二维计算几何', '贪心调度', '二分答案', '状态搜索', '数据结构维护', '模拟与枚举']
  const problems = Object.fromEntries(Array.from({ length: problemCount }, (_, i) => {
    const pid = `P${1001 + i}`
    return [pid, { pid, title: `${titles[i % titles.length]}${i >= 11 ? ` ${i + 1}` : ''}`, difficulty: i % 7 + 1,
      tags: ['合成标签'], categories: [titles[i % titles.length]], manual: true, prompt: '', timeLimit: 1000,
      memoryLimit: 125, hasAttachments: false, fetchedAt: '2026-10-01T03:00:00Z',
      content: `# ${pid}\n\nFULL_DETAIL_${pid}\n\n给定一组整数，计算所要求的结果。\n\n输入样例\n3 1 2 3\n\n输出样例\n6` }]
  }))
  const pids = Object.keys(problems)
  const records = Array.from({ length: recordCount }, (_, i) => {
    const model = models[i % models.length].name
    const pid = pids[Math.floor(i / models.length) % pids.length]
    // Large samples cover every problem while retaining a connected comparison graph.
    const largePid = recordCount >= 1000 ? pids[Math.floor(i / 10) % pids.length] : pid
    const score = 58 + (i * 17 % 43)
    const authorId = i % 3 + 1
    return { id: `r${String(i).padStart(15, '0')}`, model, pid: largePid, title: problems[largePid].title,
      thinking: ['max', 'high', 'medium'][i % 3], variant: '', agent: 'Browser fixture', tokenSource: '官方',
      difficulty: problems[largePid].difficulty, categories: problems[largePid].categories,
      submissions: [{ score, result: score === 100 ? 'AC' : 'WA', note: '', timeMs: 300 + i % 1300, memoryMb: 32 + i % 160 }],
      minutes: i % 15 + 1, memory: 125, date: '2026-10-01', note: `Synthetic record ${i}`,
      status: 'approved', author: ['owner', 'admin', 'contributor'][authorId - 1], authorId,
      reviewerId: 1, reviewedAt: '2026-10-01T03:00:00Z', deletedAt: null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 3, 0, i)).toISOString(), updatedAt: '2026-10-01T06:00:00Z' }
  })
  const pending = [2, 3].map((uid) => ({ ...records[uid], id: `private-pending-${uid}`, status: 'pending',
    authorId: uid, author: uid === 2 ? 'admin' : 'contributor', note: `PRIVATE_PENDING_${uid}` }))
  return { models, problems, records: [...records, ...pending], revision: 1, role: 'guest', requests: [], mutations: [], detailRequests: [],
    expectedFailurePaths: new Set(), failDetails: new Map(), sequence: 0 }
}

const users = [
  { id: 1, username: 'owner', nickname: '站长测试', role: 'owner', status: 'active' },
  { id: 2, username: 'admin', nickname: '管理员测试', role: 'admin', status: 'active' },
  { id: 3, username: 'contributor', nickname: '贡献者测试', role: 'contributor', status: 'active' },
  { id: 4, username: 'applicant', nickname: '注册测试', role: 'contributor', status: 'pending' },
].map((u) => ({ ...u, createdAt: '2026-10-01T03:00:00Z', approvedAt: '2026-10-01T03:00:00Z', approvedBy: 'owner' }))

function syntheticReplay() {
  return { format: 'k4u-arena-replay/1', meta: { seed: 7, labels: ['GPT-5.4', 'Claude Opus 4.8'], winner: 'A', end_reason: 'cash',
    engine_sha256: 'a'.repeat(64), final_cash: [4800, 3500], cfg: { turnsPerDay: 24 }, sample_every: 3 },
  legend: { crops: { 1: 'WHEAT' }, animals: {}, items: [] },
  frames: Array.from({ length: 80 }, (_, i) => ({ t: i * 3, town: [], mkt: { prices: [], inv: [] },
    p: [0, 1].map((player) => ({ pos: [i % 10, player + 3], hands: [], money: 3000 + i * (player ? 13 : 41),
      tiles: Array.from({ length: 100 }, (_, cell) => cell % 10 === i % 10 ? '1' : '0').join(''), extra: {}, shed: {}, seeds: {}, inv: [] })),
    act: { a: ['PASS'], b: ['PASS'] } })) }
}

async function mockApi(context, state) {
  await context.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), method = request.method(), pathname = url.pathname
    state.requests.push({ method, path: pathname + url.search, at: Date.now() })
    const user = users.find((u) => u.username === state.role)
    const admin = user?.role === 'admin' || user?.role === 'owner'
    const scope = admin ? 'admin' : user ? `user:${user.id}` : 'public'
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-cache', Vary: 'Cookie' }
    const send = (body, status = 200, extra = {}) => route.fulfill({ status, headers: { ...headers, ...extra }, body: JSON.stringify(body) })
    const body = method === 'GET' ? {} : request.postDataJSON() || {}
    if (state.failReads && ['/api/session', '/api/data'].includes(pathname)) {
      state.expectedFailurePaths.add(pathname)
      return send({ error: 'Injected identity refresh failure' }, 503)
    }
    if (pathname === '/api/session' && state.delayNextSession) {
      state.delayNextSession = false
      state.deferredSessionRole = user?.role || 'guest'
      await new Promise((resolve) => { state.releaseSession = resolve })
      state.releaseSession = null
    }
    if (pathname === '/api/session') return send({ loggedIn: !!user, uid: user?.id ?? null, username: user?.username || '',
      nickname: user?.nickname || '', role: user?.role || '', admin, canSetup: false, configured: true, csrfToken: 'fixture-csrf' }, 200,
    { 'Set-Cookie': 'radar_csrf=fixture-csrf; Path=/; SameSite=Strict' })
    if (pathname === '/api/login') {
      assert.ok(users.some((u) => u.username === body.username), `Unknown synthetic login: ${body.username}`)
      state.role = body.username
      return send({ ok: true, ...users.find((u) => u.username === body.username) })
    }
    if (pathname === '/api/logout') { state.role = 'guest'; if (state.failAfterLogout) state.failReads = true; return send({ ok: true }) }
    if (pathname === '/api/data') {
      const view = url.searchParams.get('view') === 'compact' ? 'compact' : 'full'
      const etag = `"fixture:${state.revision}-${scope}:${view}"`
      if (request.headers()['if-none-match'] === etag) return route.fulfill({ status: 304, headers: { ...headers, ETag: etag } })
      const problems = Object.fromEntries(Object.entries(state.problems).map(([pid, problem]) => {
        if (view === 'full') return [pid, problem]
        const { content, ...summary } = problem
        return [pid, { ...summary, hasContent: !!content, hasPrompt: !!problem.prompt }]
      }))
      return send({ epoch: 'fixture', revision: state.revision, scope, updatedAt: '2026-10-01T06:00:00Z', problems,
        records: state.records.filter((r) => !r.deletedAt && (r.status === 'approved' || (user && (admin || r.authorId === user.id)))) }, 200, { ETag: etag })
    }
    if (pathname.startsWith('/api/problems/') && method === 'GET') {
      const pid = decodeURIComponent(pathname.split('/').at(-1))
      state.detailRequests.push(pid)
      const failures = state.failDetails.get(pid) || 0
      if (failures > 0) {
        state.failDetails.set(pid, failures - 1)
        state.expectedFailurePaths.add(pathname)
        return send({ error: 'Injected detail failure' }, 503)
      }
      return send({ ok: true, problem: state.problems[pid] }, state.problems[pid] ? 200 : 404)
    }
    if (pathname === '/api/models' && method === 'GET') return send({ models: state.models })
    if (pathname === '/api/contributors') return send({ contributors: users.filter((u) => u.status === 'active').map((u) => ({
      uid: u.id, username: u.username, nickname: u.nickname, role: u.role, joinedAt: u.createdAt,
      contributions: state.records.filter((r) => r.authorId === u.id && r.status === 'approved' && !r.deletedAt).length,
      problems: 11, models: 34, lastDate: '2026-10-01',
    })) })
    const competition = { id: 'kaggriculture', slug: 'kaggriculture', name: '农场对抗赛', subtitle: '合成对局', scoreModel: '1v1_cash',
      status: 'live', sort: 1, matches: 2, replays: 1, rulesUrl: '', engineSha: 'a'.repeat(64), createdAt: '2026-10-01T03:00:00Z', lastPlayedAt: '2026-10-01T06:00:00Z' }
    const matches = [0, 1].map((i) => ({ id: `match-${i}`, competitionId: 'kaggriculture', aName: state.models[0].name, bName: state.models[1].name,
      aThinking: 'max', bThinking: 'high', winner: i ? 'B' : 'A', aCash: 4300, bCash: 3500, margin: 800, games: 16,
      aWins: i ? 7 : 9, bWins: i ? 9 : 7, note: '合成战绩', author: 'owner', authorId: 1, playedAt: '2026-10-01T06:00:00Z', createdAt: '2026-10-01T06:00:00Z' }))
    const standings = [0, 1].map((i) => ({ name: state.models[i].name, thinking: i ? 'high' : 'max', matches: 2, wins: 1, losses: 1, draws: 0,
      winRate: 0.5, netAvg: 0, netTotal: 0, bestWin: 800, games: 32, gameWins: 16, gameLosses: 16, gameWinRate: 0.5, elo: i ? 1498 : 1502 }))
    const replays = [{ id: 'demo', competitionId: 'kaggriculture', aName: state.models[0].name, bName: state.models[1].name,
      seed: 7, winner: 'A', frames: 40, steps: 117, bytes: 9000, author: 'owner', createdAt: '2026-10-01T06:00:00Z' }]
    if (pathname === '/api/competitions') return send({ ok: true, revision: 1, competitions: [competition] })
    if (pathname.startsWith('/api/competitions/') || pathname === '/api/arena/matches') return send({ ok: true, revision: 1, competition,
      competitionId: 'kaggriculture', matches, standings, replays, pagination: { total: 2, hasMore: false, nextCursor: null, limit: 300 } })
    if (pathname === '/api/arena/h2h') {
      const side = (name) => ({ name, seriesWins: 1, seriesLosses: 1, seriesDraws: 0, gameWins: 16, gameLosses: 16, cashAvg: 4000, netAvg: 0, bestWin: 800 })
      return send({ ok: true, a: side(url.searchParams.get('a')), b: side(url.searchParams.get('b')), series: matches, eloA: 1502, eloB: 1498 })
    }
    if (pathname === '/api/arena/replays/demo') return send(syntheticReplay())
    if (pathname === '/api/arena/replays') return send({ ok: true, replays })
    if (pathname === '/api/admin/users' && method === 'GET') return send({ users: admin ? users : [] })
    if (pathname === '/api/admin/audit') return send({ entries: [{ id: 1, actor: 'owner', action: 'record.delete', detail: 'Synthetic audit', createdAt: '2026-10-01T06:00:00Z' }] })
    if (pathname === '/api/hidden-records') return send({ total: 0, problems: [], models: [] })
    if (pathname === '/api/hidden-records/detail') return send({ records: [] })
    if (pathname === '/api/trash') return send({ records: state.records.filter((r) => r.deletedAt) })
    if (pathname === '/api/records' && method === 'POST') {
      const record = { ...body.record, id: `browser-${++state.sequence}`, status: admin ? 'approved' : 'pending', author: user.username,
        authorId: user.id, title: state.problems[body.record.pid].title, createdAt: '2026-10-01T07:00:00Z', updatedAt: '2026-10-01T07:00:00Z', deletedAt: null }
      state.records.push(record); state.revision++; state.mutations.push({ method, pathname, id: record.id })
      return send({ ok: true, record, revision: state.revision, message: '合成测评已保存' })
    }
    if (pathname.startsWith('/api/records/') && pathname.endsWith('/status') && method === 'POST') {
      const record = state.records.find((r) => r.id === decodeURIComponent(pathname.split('/')[3]))
      if (!record) return send({ error: 'Synthetic record missing' }, 404)
      record.status = body.status; state.revision++; state.mutations.push({ method, pathname, id: record.id })
      return send({ ok: true, record, revision: state.revision })
    }
    if (pathname.startsWith('/api/records/') && ['PUT', 'DELETE'].includes(method)) {
      const record = state.records.find((r) => r.id === decodeURIComponent(pathname.split('/').at(-1)))
      if (!record) return send({ error: 'Synthetic record missing' }, 404)
      if (method === 'PUT') Object.assign(record, body.record, { status: admin ? record.status : 'pending' })
      else record.deletedAt = '2026-10-01T07:01:00Z'
      state.revision++; state.mutations.push({ method, pathname, id: record.id })
      return send({ ok: true, record, revision: state.revision })
    }
    if (pathname.startsWith('/api/admin/users/') && method === 'POST') {
      const target = users.find((u) => u.id === Number(pathname.split('/')[4]))
      if (pathname.endsWith('/role')) target.role = body.role
      else target.status = pathname.endsWith('/approve') ? 'active' : 'rejected'
      state.mutations.push({ method, pathname }); return send({ ok: true })
    }
    if (method !== 'GET') { state.mutations.push({ method, pathname }); return send({ ok: true, affected: 1, updated: 0 }) }
    report.errors.push({ kind: 'unexpected-mock-request', path: pathname + url.search })
    return send({ error: `Unhandled synthetic endpoint: ${pathname}` }, 500)
  })
}

async function openContext(state, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport, reducedMotion: 'reduce' })
  await context.addInitScript(() => {
    window.__copied = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text) => { window.__copied.push({ text, at: performance.now() }) }, readText: async () => window.__copied.at(-1)?.text || '',
    } })
    window.__metrics = { lcp: 0, cls: 0, shifts: [], events: [], longTasks: [] }
    for (const [type, handler] of [
      ['largest-contentful-paint', (entry) => { window.__metrics.lcp = entry.startTime }],
      ['layout-shift', (entry) => { if (!entry.hadRecentInput) {
        window.__metrics.cls += entry.value
        window.__metrics.shifts.push({ value: entry.value, at: entry.startTime, sources: (entry.sources || []).map((source) => ({
          tag: source.node?.tagName, className: source.node?.className, text: source.node?.textContent?.slice(0, 80),
          previous: source.previousRect.toJSON(), current: source.currentRect.toJSON(),
        })) })
      } }],
      ['event', (entry) => { if (entry.interactionId) window.__metrics.events.push(entry.duration) }],
      ['longtask', (entry) => { window.__metrics.longTasks.push(entry.duration) }],
    ]) {
      try { new PerformanceObserver((list) => list.getEntries().forEach(handler)).observe({ type, buffered: true, durationThreshold: 16 }) } catch { /* optional browser metric */ }
    }
  })
  await mockApi(context, state)
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on('pageerror', (error) => report.errors.push({ kind: 'pageerror', role: state.role, url: page.url(), message: error.message }))
  page.on('console', (message) => {
    if (message.type() !== 'error') return
    const resource = message.location().url
    const expected = resource && state.expectedFailurePaths.has(new URL(resource).pathname) && message.text().includes('503')
    const entry = { kind: 'console', role: state.role, url: page.url(), resource, message: message.text() }
    if (expected) (report.injectedFailureLogs ||= []).push(entry)
    else report.errors.push(entry)
  })
  page.on('dialog', (dialog) => dialog.accept())
  return { context, page, state }
}

async function goto(page, pathname) {
  await page.goto(baseUrl + pathname, { waitUntil: 'networkidle' })
  await expect(page.locator('.workbench-shell')).toBeAttached()
  await expect(page.locator('main.layout')).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
}

async function layout(page, name, screenshot = false) {
  // Capture the final geometry, not an intermediate frame of a sidebar transition.
  await page.evaluate(async () => {
    const finite = document.getAnimations().filter((animation) => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)
    await Promise.all(finite.map((animation) => animation.finished.catch(() => {})))
  })
  const size = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }))
  assert.ok(size.body <= size.width + 1 && size.document <= size.width + 1, `Body overflow at ${name}: ${JSON.stringify(size)}`)
  if (screenshot) {
    const file = path.join(output, `${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    report.screenshots.push({ name, file, ...size })
  }
  return size
}

async function clickTab(page, name, key) {
  await page.getByRole('tab', { name, exact: true }).click()
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => new URL(page.url()).searchParams.get('v')).toBe(key)
}

async function performanceSamples() {
  for (let run = 0; run < 5; run++) {
    const { context, page } = await openContext(fixture())
    try {
      const started = performance.now()
      await goto(page, '/')
      await expect(page.locator('.sum-row td').first()).not.toHaveText('')
      await delay(200)
      const initialReadyMs = performance.now() - started
      const metrics = await page.evaluate(() => ({ ...window.__metrics, resources: performance.getEntriesByType('resource')
        .filter((entry) => entry.name.endsWith('.js')).map((entry) => ({ name: entry.name, transferSize: entry.transferSize })) }))
      const interactions = []
      for (const [name, key] of [['AI 分数', 'score'], ['天梯分', 'rating'], ['测评明细', 'table']]) {
        const start = performance.now(); await clickTab(page, name, key); interactions.push(performance.now() - start)
      }
      const initialScripts = metrics.resources.map((entry) => path.basename(new URL(entry.name).pathname))
      const initialGzipBytes = report.scriptGzip.filter((asset) => initialScripts.includes(asset.file) && !asset.file.startsWith('rating.worker-'))
        .reduce((sum, asset) => sum + asset.gzipBytes, 0)
      report.performance.push({ run: run + 1, readyMs: initialReadyMs, lcpMs: metrics.lcp, cls: metrics.cls, initialGzipBytes,
        shifts: metrics.shifts,
        interactionMs: interactions, interactionP95Ms: percentile(interactions, 0.95), browserEventP95Ms: percentile(metrics.events, 0.95),
        longTasksMs: metrics.longTasks, scripts: metrics.resources })
      await check(`performance sample ${run + 1}: no layout overflow`, () => layout(page, `sample-${run + 1}`))
    } finally { await context.close() }
  }
}

async function refinementChecks() {
  const { context, page } = await openContext(fixture())
  try {
    await check('persistent shell, single competition entry and legacy competition URLs', async () => {
      await goto(page, '/?v=score')
      const shell = await page.locator('.workbench-shell').elementHandle()
      await expect(page.getByRole('tab', { name: '比赛', exact: true })).toHaveCount(0)
      await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '比赛', exact: true }).click()
      await expect(page.getByRole('heading', { name: '比赛', exact: true })).toBeVisible()
      assert.equal(await shell.evaluate((element) => element.isConnected), true, 'Navigation must remain mounted')
      await page.goBack()
      await expect(page.getByRole('tab', { name: 'AI 分数', exact: true })).toHaveAttribute('aria-selected', 'true')
      await goto(page, '/?v=arena')
      await expect.poll(() => new URL(page.url()).pathname).toBe('/arena')
      await goto(page, '/?v=arena&competition=kaggriculture')
      await expect.poll(() => new URL(page.url()).pathname).toBe('/arena/kaggriculture')
      await expect(page.getByRole('heading', { name: '农场对抗赛', exact: true })).toBeVisible()
    })
    await check('all styles can collapse, reload and expand from a persistent header button', async () => {
      await goto(page, '/')
      for (const style of ['clean', 'compact', 'vscode']) {
        await page.getByRole('button', { name: '设置', exact: true }).click()
        await page.getByLabel(/^界面风格/).selectOption(style)
        await page.getByRole('button', { name: '完成', exact: true }).click()
        await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
        await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed')
        await page.reload({ waitUntil: 'networkidle' })
        await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible()
        await expect(page.locator('.app-sidebar')).toBeVisible()
        await expect(page.locator('.editor-tabs, .editor-activitybar')).toHaveCount(0)
        await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
        await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'expanded')
      }
    })
    await check('VS Code status bar follows light, warm and dark surfaces', async () => {
      for (const theme of ['light', 'warm', 'dark']) {
        await page.getByRole('button', { name: '设置', exact: true }).click()
        await page.locator(`[data-preview-theme="${theme}"]`).click()
        await page.getByRole('button', { name: '完成', exact: true }).click()
        const colors = await page.locator('.editor-statusbar').evaluate((element) => ({
          status: getComputedStyle(element).backgroundColor,
          header: getComputedStyle(document.querySelector('.shell-topbar')).backgroundColor,
        }))
        assert.equal(colors.status, colors.header)
      }
    })
    await check('view animations retain controls; disabling motion persists and respects reduced motion', async () => {
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      await page.evaluate(() => {
        window.__motionCalls = []
        const animate = Element.prototype.animate
        Element.prototype.animate = function (...args) {
          window.__motionCalls.push({ id: this.id, duration: args[1]?.duration })
          return animate.apply(this, args)
        }
      })
      await clickTab(page, 'AI 分数', 'score')
      assert.ok(await page.evaluate(() => window.__motionCalls.some((item) => item.id === 'benchmark-panel' && item.duration === 220)))
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByLabel(/^切换动画/).selectOption('off')
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
      await page.evaluate(() => { window.__motionCalls.length = 0 })
      await clickTab(page, '天梯分', 'rating')
      assert.deepEqual(await page.evaluate(() => window.__motionCalls), [])
      assert.equal(await page.locator('main.layout').evaluate((element) => getComputedStyle(element).animationName), 'none')
      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.locator('html')).toHaveAttribute('data-motion', 'off')
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByLabel(/^切换动画/).selectOption('system')
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await clickTab(page, 'AI 分数', 'score')
      assert.equal(await page.locator('main.layout').evaluate((element) => getComputedStyle(element).animationName), 'none')
      assert.equal(await page.locator('#benchmark-panel').evaluate((element) => element.getAnimations().length), 0)
    })
    await check('320px layout with 20px text retains settings, navigation and contained tables', async () => {
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByLabel(/^文字大小/).selectOption('20')
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await page.setViewportSize({ width: 320, height: 720 })
      for (const pathname of ['/', '/arena', '/arena/kaggriculture', '/contributors', '/prompts']) {
        await goto(page, pathname)
        await layout(page, `refinement-20px-${pathname.replaceAll('/', '-') || 'home'}`, true)
        await page.getByRole('button', { name: '打开导航', exact: true }).click()
        await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible()
        await page.getByRole('button', { name: '设置', exact: true }).click()
        await expect(page.getByRole('button', { name: '完成', exact: true })).toBeInViewport({ ratio: 1 })
        await page.getByRole('button', { name: '完成', exact: true }).click()
      }
    })
  } finally { await context.close() }
}

async function websiteChecks() {
  const { context, page, state } = await openContext(fixture())
  try {
    await check('three assessment tabs, one competition entry and browser back preserve the previous view', async () => {
      await goto(page, '/?v=score')
      await clickTab(page, '天梯分', 'rating')
      await clickTab(page, '测评明细', 'table')
      await page.getByRole('navigation', { name: '主导航', exact: true }).getByRole('link', { name: '比赛', exact: true }).click()
      await expect(page.getByRole('heading', { name: '比赛', exact: true })).toBeVisible()
      await page.goBack()
      await expect(page.getByRole('tab', { name: '测评明细', exact: true })).toHaveAttribute('aria-selected', 'true')
    })
    await check('global login modal opens from all public routes', async () => {
      for (const pathname of ['/contributors', '/prompts', '/arena', '/register']) {
        await goto(page, pathname)
        await page.getByRole('button', { name: '登录', exact: true }).first().click()
        await expect(page.getByRole('dialog', { name: '登录', exact: true })).toBeVisible()
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog', { name: '登录', exact: true })).toHaveCount(0)
      }
    })
    await check('copy loads the complete problem before clipboard text is written', async () => {
      await goto(page, '/prompts')
      state.detailRequests.length = 0
      const row = page.locator('tbody tr').filter({ hasText: 'P1002' })
      await row.getByRole('button', { name: '复制', exact: true }).click()
      const chooser = page.getByRole('dialog', { name: '选择测试模型', exact: true })
      await expect(chooser).toBeVisible()
      await chooser.locator('select').selectOption(state.models[0].name)
      await chooser.getByRole('button', { name: '复制提示词', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.__copied.at(-1)?.text || '')).toContain('FULL_DETAIL_P1002')
      assert.ok(state.detailRequests.includes('P1002'), 'Copy must fetch the compact problem detail')
      await expect(chooser).toHaveCount(0)
    })
    await check('problem drawer reports failed details and retries successfully', async () => {
      await goto(page, '/?v=score&mx%3Alayout=compare')
      state.failDetails.set('P1003', 1)
      const title = page.locator('.comparison-title').filter({ hasText: 'P1003' }).locator('button.pid-detail')
      await title.click()
      const drawer = page.getByRole('dialog', { name: '题目详情', exact: true })
      await expect(drawer.getByRole('alert')).toContainText('Injected detail failure')
      await drawer.getByRole('button', { name: '重试', exact: true }).click()
      await expect(drawer.locator('pre')).toContainText('FULL_DETAIL_P1003')
      await expect(drawer.getByRole('alert')).toHaveCount(0)
      await drawer.getByRole('button', { name: '关闭', exact: true }).click()
    })
    await check('explicit model and contributor URL filters override saved selections and can reset', async () => {
      const selectedModel = state.models[0].name
      const selectedContributor = users.find((user) => user.username === 'contributor').id
      const expected = state.records.filter((record) => record.status === 'approved' && record.model === selectedModel && record.authorId === selectedContributor)
      await page.evaluate(({ model, contributor }) => {
        localStorage.setItem('radar.focusModels', JSON.stringify([model]))
        localStorage.setItem('radar.focusContributor', String(contributor))
      }, { model: state.models[1].name, contributor: users[0].id })
      const params = new URLSearchParams({ v: 'score', models: JSON.stringify([selectedModel]), contributor: String(selectedContributor) })
      await goto(page, '/?' + params)
      await page.locator('.benchmark-filters > summary').click()
      await expect(page.locator('.matrix thead .model-col')).toHaveCount(1)
      await expect(page.locator('.matrix thead .model-col')).toContainText(selectedModel)
      await expect(page.getByLabel('选择贡献者', { exact: true })).toHaveValue(String(selectedContributor))
      await clickTab(page, '测评明细', 'table')
      await expect(page.locator('#records-wrap tbody tr')).toHaveCount(expected.length)
      for (const record of expected) await expect(page.locator('#records-wrap tbody')).toContainText(record.note)
      await expect.poll(() => new URL(page.url()).searchParams.get('models')).toBe(JSON.stringify([selectedModel]))
      await expect.poll(() => new URL(page.url()).searchParams.get('contributor')).toBe(String(selectedContributor))
      await page.locator('#model-filter').getByRole('button', { name: '查看全部', exact: true }).click()
      await page.locator('#contributor-filter').getByRole('button', { name: '查看全部', exact: true }).click()
      await expect.poll(() => new URL(page.url()).searchParams.get('models')).toBe('[]')
      await expect.poll(() => new URL(page.url()).searchParams.get('contributor')).toBe('all')
      await expect(page.locator('#records-wrap tbody tr')).toHaveCount(50)
      return { model: selectedModel, contributorId: selectedContributor, recordsInCombinedScope: expected.length }
    })
    await check('obsolete saved model and contributor filters remain visible and clearable', async () => {
      const ghost = await openContext(fixture(), { width: 390, height: 844 })
      try {
        await ghost.context.addInitScript(() => {
          localStorage.setItem('radar.focusModels', JSON.stringify(['OBSOLETE_SYNTHETIC_MODEL']))
          localStorage.setItem('radar.focusContributor', '987654')
        })
        await goto(ghost.page, '/?v=rating')
        await ghost.page.locator('.benchmark-filters > summary').click()
        await expect(ghost.page.locator('#matrix-card .empty')).toContainText('暂无已审核')
        await expect(ghost.page.locator('#model-filter').getByRole('button', { name: '查看全部', exact: true })).toBeVisible()
        await expect(ghost.page.locator('#contributor-filter')).toContainText('#987654')
        await layout(ghost.page, 'obsolete-filters-mobile', true)
        await ghost.page.locator('#model-filter').getByRole('button', { name: '查看全部', exact: true }).click()
        await ghost.page.locator('#contributor-filter').getByRole('button', { name: '查看全部', exact: true }).click()
        await expect(ghost.page.locator('.ranking-row')).toHaveCount(34)
        await expect.poll(() => new URL(ghost.page.url()).searchParams.get('models')).toBe('[]')
        await expect.poll(() => new URL(ghost.page.url()).searchParams.get('contributor')).toBe('all')
        await expect.poll(() => ghost.page.evaluate(() => localStorage.getItem('radar.focusModels'))).toBe('[]')
        await expect.poll(() => ghost.page.evaluate(() => localStorage.getItem('radar.focusContributor'))).toBe('')
      } finally { await ghost.context.close() }
    })
    await check('mobile defaults to ranking and caps comparison at three models', async () => {
      await page.setViewportSize({ width: 390, height: 844 })
      await goto(page, '/?v=rating')
      await expect(page.locator('.ranking-list')).toBeVisible()
      await expect(page.locator('.ranking-row')).toHaveCount(34)
      await layout(page, 'mobile-ranking', true)
      await page.getByRole('group', { name: '展示布局' }).getByRole('button', { name: '对比', exact: true }).click()
      for (let i = 0; i < 3; i++) await page.getByLabel(`对比模型 ${i + 1}`, { exact: true }).selectOption(state.models[i].name)
      await expect(page.locator('.comparison-columns strong')).toHaveCount(3)
      await layout(page, 'mobile-compare', true)
      await page.getByRole('group', { name: '展示布局' }).getByRole('button', { name: '矩阵', exact: true }).click()
      await expect(page.locator('.matrix thead .model-col')).toHaveCount(34)
      assert.ok(await page.locator('#matrix-wrap').evaluate((element) => element.scrollWidth > element.clientWidth), 'Matrix needs an internal horizontal scroll area')
      await layout(page, 'mobile-matrix', true)
    })
    for (const width of [390, 768, 1440, 1920]) await check(`light and dark layout screenshots at ${width}px`, async () => {
      await page.setViewportSize({ width, height: width < 500 ? 844 : 1080 })
      await goto(page, '/?v=rating')
      if (width <= 760) await page.getByRole('button', { name: '打开导航', exact: true }).click()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.locator('[data-preview-theme="light"]').click()
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await layout(page, `home-light-${width}`, true)
      if (width <= 760) await page.getByRole('button', { name: '打开导航', exact: true }).click()
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.locator('[data-preview-theme="dark"]').click()
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
      await layout(page, `home-dark-${width}`, true)
    })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await check('VS Code layout: themes, persisted style, animated sidebar and reduced motion', async () => {
      await goto(page, '/prompts')
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByLabel(/^界面风格/).selectOption('vscode')
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await expect(page.getByRole('navigation', { name: '主导航', exact: true })).toBeVisible()
      await expect(page.locator('.editor-tabs, .editor-activitybar')).toHaveCount(0)
      await page.reload({ waitUntil: 'networkidle' })
      await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'vscode')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const duration = await page.locator('.app-sidebar').evaluate((element) => getComputedStyle(element).transitionDuration)
      assert.ok(duration.includes('0.18s'), 'The sidebar must animate over 180ms')
      await page.getByRole('button', { name: '收起侧栏', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-sidebar', 'collapsed')
      await expect(page.locator('.app-sidebar')).toBeVisible()
      await expect(page.getByRole('button', { name: '展开侧栏', exact: true })).toBeVisible()
      await layout(page, 'vscode-collapsed', true)
      await page.getByRole('button', { name: '展开侧栏', exact: true }).click()
      await expect(page.locator('.app-sidebar')).toBeVisible()
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 })
        for (const theme of ['light', 'warm', 'dark']) {
          if (width <= 760) await page.getByRole('button', { name: '打开导航', exact: true }).click()
          await page.getByRole('button', { name: '设置', exact: true }).click()
          await page.locator(`[data-preview-theme="${theme}"]`).click()
          await page.getByRole('button', { name: '完成', exact: true }).click()
          await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
          if (theme === 'dark') assert.equal(await page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(0, 0, 0)')
          const statusColors = await page.locator('.editor-statusbar').evaluate((element) => ({
            background: getComputedStyle(element).backgroundColor,
            surface: getComputedStyle(document.querySelector('.shell-topbar')).backgroundColor,
          }))
          assert.equal(statusColors.background, statusColors.surface, 'Status bar must follow the page theme')
          await layout(page, `vscode-${theme}-${width}`, true)
        }
      }
      await page.emulateMedia({ reducedMotion: 'reduce' })
      assert.equal(await page.locator('.app-sidebar').evaluate((element) => getComputedStyle(element).transitionProperty), 'none')
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.getByRole('button', { name: '设置', exact: true }).click()
      await page.getByRole('button', { name: '恢复默认', exact: true }).click()
      await page.getByRole('button', { name: '完成', exact: true }).click()
      await expect(page.locator('html')).toHaveAttribute('data-ui-style', 'clean')
    })
    await check('prompt index: default disclosures, bounded rows, pagination, search and explicit expansion', async () => {
      const large = await openContext(fixture(1000))
      try {
        await goto(large.page, '/prompts')
        await expect(large.page.locator('.prompt-workspace details')).not.toHaveAttribute('open')
        await expect(large.page.locator('.prompt-guide')).not.toHaveAttribute('open')
        await expect(large.page.locator('tbody tr')).toHaveCount(20)
        const firstPage = await large.page.locator('tbody tr').first().innerText()
        await large.page.getByRole('button', { name: '下一页题目', exact: true }).click()
        await expect(large.page.locator('tbody tr')).toHaveCount(20)
        assert.notEqual(await large.page.locator('tbody tr').first().innerText(), firstPage)
        await large.page.getByLabel('搜索提示词题目', { exact: true }).fill('P1250')
        await expect(large.page.locator('tbody tr')).toHaveCount(1)
        await large.page.getByRole('button', { name: '查看 P1250 提示词', exact: true }).click()
        await expect(large.page.locator('.prompt-workspace details')).toHaveAttribute('open', '')
        await expect(large.page.locator('.prompt-workspace pre')).toContainText('FULL_DETAIL_P1250')
        await layout(large.page, 'prompts-filtered-expanded', true)
      } finally { await large.context.close() }
    })
    for (const role of ['guest', 'contributor', 'admin', 'owner']) await check(`${role}: main routes and permission views`, async () => {
      state.role = role
      for (const pathname of ['/?v=score', '/?v=rating', '/?v=table', '/?v=arena', '/contributors', '/prompts', '/arena', '/arena/kaggriculture', '/register', '/admin', '/users']) {
        await goto(page, pathname)
        await layout(page, `${role}-${pathname.replace(/[^a-z]/gi, '-')}`, pathname === '/admin' || pathname === '/users')
      }
      if (['admin', 'owner'].includes(role)) await expect(page.getByRole('navigation', { name: '用户管理分区' })).toBeVisible()
      else await expect(page.getByRole('navigation', { name: '用户管理分区' })).toHaveCount(0)
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.cache.v3') || 'null'))
      assert.ok(saved && saved.scope === 'public' && saved.records.every((r) => r.status === 'approved'), 'Persistent public cache must exclude pending records')
      await page.setViewportSize({ width: 390, height: 844 })
      for (const pathname of ['/prompts', '/contributors', '/arena', '/admin', '/users']) {
        await goto(page, pathname)
        await layout(page, `${role}-mobile-${pathname.slice(1)}`, true)
      }
      await page.setViewportSize({ width: 1440, height: 1000 })
    })
    await check('submit, edit, delete and authentication refresh keep the visible source current', async () => {
      state.role = 'contributor'
      await goto(page, '/?v=table')
      await page.getByRole('button', { name: '提交测评', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '提交测评', exact: true })
      await dialog.locator('input[list="dl-models"]').fill(state.models[0].name)
      await dialog.locator('select').filter({ has: page.locator('option[value="P1001"]') }).selectOption('P1001')
      await dialog.getByLabel('第 1 轮原始分数', { exact: true }).fill('95')
      await dialog.getByLabel('内存使用量（MB，可填小数）', { exact: true }).fill('125')
      await dialog.getByLabel('时间消耗（ms）', { exact: true }).fill('1000')
      await dialog.locator('.field').filter({ hasText: /^备注$/ }).locator('input').fill('BROWSER_CREATED_RECORD')
      await dialog.getByRole('button', { name: '保存测评', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      const row = page.locator('#records-wrap tbody tr').filter({ hasText: 'BROWSER_CREATED_RECORD' })
      await expect(row).toHaveCount(1)
      await row.getByRole('button', { name: '编辑', exact: true }).click()
      const editor = page.getByRole('dialog', { name: '编辑测评', exact: true })
      await editor.locator('.field').filter({ hasText: /^备注$/ }).locator('input').fill('BROWSER_EDITED_RECORD')
      await editor.getByRole('button', { name: '保存测评', exact: true }).click()
      await expect(editor).toHaveCount(0)
      await expect(page.locator('#records-wrap tbody tr').filter({ hasText: 'BROWSER_EDITED_RECORD' })).toHaveCount(1)
      state.role = 'admin'
      await page.getByRole('button', { name: '刷新数据', exact: true }).click()
      await expect(page.getByRole('button', { name: /管理员测试/ })).toBeVisible()
      await goto(page, '/admin')
      const pendingRow = page.locator('#pending-wrap tbody tr').filter({ hasText: state.models[0].name })
      await pendingRow.getByRole('button', { name: '通过', exact: true }).click()
      await expect(pendingRow).toHaveCount(0)
      await goto(page, '/?v=table')
      const edited = page.locator('#records-wrap tbody tr').filter({ hasText: 'BROWSER_EDITED_RECORD' })
      await edited.getByRole('button', { name: '删除', exact: true }).click()
      await expect(edited).toHaveCount(0)
      assert.ok(['POST', 'PUT', 'DELETE'].every((method) => state.mutations.some((event) => event.method === method && event.pathname.startsWith('/api/records'))))
      await page.getByRole('button', { name: /管理员测试/ }).click()
      await page.getByRole('button', { name: '退出登录', exact: true }).click()
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
      await page.getByRole('button', { name: '登录', exact: true }).click()
      const auth = page.getByRole('dialog', { name: '登录', exact: true })
      await auth.locator('#auth-user').fill('owner')
      await auth.locator('#auth-password').fill('synthetic-password')
      await auth.getByRole('button', { name: '登录', exact: true }).click()
      await expect(auth).toHaveCount(0)
      await expect(page.getByRole('button', { name: /站长测试/ })).toBeVisible()
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.cache.v3')))
      assert.ok(saved.records.every((r) => r.status === 'approved'))
    })
  } finally { await context.close() }
}

async function recordFormScrollChecks() {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1440, height: 600 },
    { width: 390, height: 844 }, { width: 390, height: 600 }]) {
    const state = fixture()
    state.role = 'contributor'
    const { context, page } = await openContext(state, viewport)
    try {
      const wheelPassed = await check(`record form scroll ${viewport.width}x${viewport.height}: wheel, fields, fixed actions and Escape`, async () => {
        await goto(page, '/?v=score')
        const opener = page.getByRole('button', { name: '提交测评', exact: true })
        await opener.scrollIntoViewIfNeeded()
        const backgroundBefore = await page.evaluate(() => ({ scrollY, locked: document.body.classList.contains('modal-open'),
          overflow: getComputedStyle(document.body).overflow }))
        await opener.click()
        const dialog = page.getByRole('dialog', { name: '提交测评', exact: true })
        const body = dialog.locator('.record-form-body')
        const modelInput = dialog.locator('input[list="dl-models"]')
        const actions = dialog.locator('.record-actions')
        await expect(dialog).toBeVisible()
        await expect(page.locator('body')).toHaveClass(/modal-open/)
        const metrics = () => body.evaluate((element) => ({ scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
          overflowY: getComputedStyle(element).overflowY }))
        const initial = await metrics()
        assert.ok(initial.scrollHeight > initial.clientHeight, `Fixture must overflow its form body: ${JSON.stringify(initial)}`)
        const actionsBefore = await actions.boundingBox()
        const visibleActions = async () => {
          for (const name of ['取消', '保存测评']) {
            const button = dialog.getByRole('button', { name, exact: true })
            await expect(button).toBeInViewport({ ratio: 1 })
          }
          const current = await actions.boundingBox()
          assert.ok(current && actionsBefore && Math.abs(current.y - actionsBefore.y) <= 1,
            `Form actions moved while body scrolled: ${JSON.stringify({ before: actionsBefore, current })}`)
        }
        await visibleActions()
        await modelInput.hover()
        await page.mouse.wheel(0, 1400)
        await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(0)
        const wheelOverInput = await metrics()
        await visibleActions()
        assert.equal(await page.evaluate(() => scrollY), backgroundBefore.scrollY, 'Input wheel must leave the background locked')
        await body.evaluate((element) => { element.scrollTop = 0 })
        await expect.poll(async () => (await metrics()).scrollTop).toBe(0)
        await dialog.locator('#record-config-title').hover()
        await page.mouse.wheel(0, 1400)
        await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(0)
        const wheelOverSection = await metrics()
        await visibleActions()
        const wheelBody = async (amount) => {
          const bounds = await body.boundingBox()
          assert.ok(bounds, 'Scrollable form body must be visible')
          await page.mouse.move(bounds.x + Math.min(20, bounds.width / 2), bounds.y + bounds.height / 2)
          await page.mouse.wheel(0, amount)
        }
        await wheelBody(6000)
        await expect.poll(async () => {
          const value = await metrics()
          return value.scrollHeight - value.clientHeight - value.scrollTop
        }).toBeLessThanOrEqual(2)
        await expect(dialog.locator('#record-extra-title')).toBeInViewport({ ratio: 1 })
        await expect(dialog.locator('#record-extra-title').locator('..')).toContainText('03')
        const note = dialog.locator('.field').filter({ hasText: /^备注$/ }).locator('input')
        await expect(note).toBeInViewport({ ratio: 1 })
        await visibleActions()
        await layout(page, `record-form-bottom-${viewport.width}x${viewport.height}`, true)
        await wheelBody(-6000)
        await expect.poll(async () => (await metrics()).scrollTop).toBe(0)
        await modelInput.fill(state.models[0].name)
        await expect(modelInput).toHaveValue(state.models[0].name)
        const addRound = dialog.getByRole('button', { name: '添加一轮', exact: true })
        await addRound.scrollIntoViewIfNeeded()
        await addRound.click()
        await addRound.click()
        await expect(dialog.locator('.sub-row')).toHaveCount(3)
        const afterAdding = await metrics()
        assert.ok(afterAdding.scrollHeight > initial.scrollHeight, 'Added rounds must increase scrollable content')
        await body.evaluate((element) => { element.scrollTop = 0 })
        await modelInput.hover()
        await page.mouse.wheel(0, 1400)
        await expect.poll(async () => (await metrics()).scrollTop).toBeGreaterThan(0)
        await wheelBody(6000)
        await expect.poll(async () => {
          const value = await metrics()
          return value.scrollHeight - value.clientHeight - value.scrollTop
        }).toBeLessThanOrEqual(2)
        await expect(dialog.locator('#record-extra-title')).toBeInViewport({ ratio: 1 })
        await expect(note).toBeInViewport({ ratio: 1 })
        await visibleActions()
        await layout(page, `record-form-three-rounds-${viewport.width}x${viewport.height}`, true)
        await note.focus()
        await page.keyboard.press('Escape')
        await expect(dialog).toHaveCount(0)
        await expect(opener).toBeFocused()
        const backgroundAfter = await page.evaluate(() => ({ scrollY, locked: document.body.classList.contains('modal-open'),
          overflow: getComputedStyle(document.body).overflow }))
        assert.equal(backgroundAfter.locked, backgroundBefore.locked, 'Escape must restore the background scroll lock')
        assert.equal(backgroundAfter.overflow, backgroundBefore.overflow, 'Escape must restore background overflow')
        assert.equal(backgroundAfter.scrollY, backgroundBefore.scrollY, 'Closing the form must preserve background scroll position')
        await page.mouse.move(viewport.width - 24, viewport.height / 2)
        const backgroundWheelTarget = await page.evaluate(({ x, y }) => ({
          target: document.elementFromPoint(x, y)?.outerHTML.slice(0, 500),
          scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight,
          bodyHeight: document.body.scrollHeight, bodyOverflow: getComputedStyle(document.body).overflow,
        }), { x: viewport.width - 24, y: viewport.height / 2 })
        report.scrollDiagnostics ||= []
        report.scrollDiagnostics.push({ viewport, backgroundBefore, backgroundAfter, backgroundWheelTarget })
        await page.mouse.wheel(0, 500)
        await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(backgroundAfter.scrollY)
        assert.equal(state.mutations.length, 0, 'Scroll verification must not submit or mutate synthetic records')
        return { viewport, initial, wheelOverInput, wheelOverSection, afterAdding, backgroundBefore, backgroundAfter }
      })
      if (wheelPassed && viewport.width < 500) await check(`record form touch ${viewport.width}x${viewport.height}: swipe, fixed actions and Escape`, async () => {
        const opener = page.getByRole('button', { name: '提交测评', exact: true })
        await opener.scrollIntoViewIfNeeded()
        const backgroundY = await page.evaluate(() => scrollY)
        await opener.click()
        const dialog = page.getByRole('dialog', { name: '提交测评', exact: true })
        const body = dialog.locator('.record-form-body')
        const session = await context.newCDPSession(page)
        try {
          await expect(dialog).toBeVisible()
          const bounds = await body.boundingBox()
          assert.ok(bounds, 'Form body must be visible for touch scrolling')
          await session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
          const x = bounds.x + 20
          const startY = bounds.y + bounds.height * 0.8
          const travel = bounds.height * 0.6
          const touchPoint = (y) => ({ x, y, radiusX: 1, radiusY: 1, force: 1, id: 1 })
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(startY)] })
          for (let step = 1; step <= 10; step++) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(startY - travel * step / 10)] })
            await page.waitForTimeout(20)
          }
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
          await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
          const touchScroll = await body.evaluate((element) => ({ scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }))
          for (const name of ['取消', '保存测评']) await expect(dialog.getByRole('button', { name, exact: true })).toBeInViewport({ ratio: 1 })
          assert.equal(await page.evaluate(() => scrollY), backgroundY, 'Touch swipe must leave the background locked')
          await layout(page, `record-form-touch-${viewport.width}x${viewport.height}`, true)
          await page.keyboard.press('Escape')
          await expect(dialog).toHaveCount(0)
          await expect(opener).toBeFocused()
          await expect(page.locator('body')).not.toHaveClass(/modal-open/)
          assert.equal(state.mutations.length, 0)
          return { viewport, touchScroll, backgroundY }
        } finally {
          await session.send('Emulation.setTouchEmulationEnabled', { enabled: false })
          await session.detach()
        }
      })
    } finally { await context.close() }
  }
}

async function expandedMatrixGeometry(page, problemCount) {
  const body = page.locator('#matrix-wrap')
  await expect(page.locator('.matrix tbody tr')).toHaveCount(problemCount + 1)
  await expect(page.locator('.matrix tbody th .mrank').last()).toHaveText(String(problemCount))
  const dimensions = await body.evaluate((element) => {
    const style = getComputedStyle(element)
    return { scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight, overflowX: style.overflowX, overflowY: style.overflowY, maxHeight: style.maxHeight }
  })
  assert.ok(dimensions.scrollHeight - dimensions.clientHeight <= 1, `Matrix must expand to all rows: ${JSON.stringify(dimensions)}`)
  assert.ok(dimensions.scrollWidth > dimensions.clientWidth, 'Full matrix needs an internal horizontal scroll area')
  await body.evaluate((element) => { element.scrollTop = 500 })
  assert.equal(await body.evaluate((element) => element.scrollTop), 0, 'Matrix must not scroll internally on the vertical axis')
  const bodyRect = await body.boundingBox()
  const viewport = page.viewportSize()
  await page.mouse.move(viewport.width / 2, Math.min(bodyRect.y + 80, viewport.height - 60))
  const beforeWheel = await page.evaluate(() => scrollY)
  await page.mouse.wheel(0, 700)
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(beforeWheel)
  assert.equal(await body.evaluate((element) => element.scrollTop), 0, 'Vertical wheel must scroll the page, not the matrix')
  const lastTitle = page.locator('.matrix tbody tr').last().locator('.row-head')
  await lastTitle.scrollIntoViewIfNeeded()
  await expect(lastTitle).toBeInViewport()
  const windowScrollY = await page.evaluate(() => scrollY)
  assert.ok(windowScrollY > 0, 'The final problem must be reached by scrolling the page')
  const beforeHorizontal = await lastTitle.boundingBox()
  await body.evaluate((element) => { element.scrollLeft = Math.min(700, element.scrollWidth - element.clientWidth) })
  await expect.poll(() => body.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0)
  const afterHorizontal = await lastTitle.boundingBox()
  assert.ok(Math.abs(beforeHorizontal.x - afterHorizontal.x) <= 1,
    `Problem column must remain sticky during horizontal scrolling: ${JSON.stringify({ beforeHorizontal, afterHorizontal })}`)
  assert.equal(await lastTitle.evaluate((element) => getComputedStyle(element).position), 'sticky')
  return { dimensions, windowScrollY, scrollLeft: await body.evaluate((element) => element.scrollLeft),
    finalProblem: await lastTitle.innerText() }
}

async function matrixLayoutChecks() {
  for (const width of [1440, 390]) {
    const { context, page } = await openContext(fixture(), { width, height: width === 390 ? 844 : 900 })
    try {
      for (const view of ['score', 'rating']) await check(`matrix ${width}px ${view}: all rows, page scroll and sticky horizontal column`, async () => {
        await goto(page, `/?v=${view}&mx%3Alayout=matrix`)
        await expect(page.locator('.matrix thead .model-col')).toHaveCount(34)
        const geometry = await expandedMatrixGeometry(page, 11)
        await layout(page, `expanded-matrix-${view}-${width}`, true)
        return geometry
      })
    } finally { await context.close() }
  }
}

async function largeDataChecks() {
  for (const count of [1000, 10000]) {
    const { context, page, state } = await openContext(fixture(count))
    try {
      await check(`${count} records: all problem rows mounted and usable input during background rating`, async () => {
        const start = performance.now()
        await goto(page, '/?v=rating&mx%3Alayout=matrix')
        await expect(page.locator('.matrix')).toBeVisible()
        await page.getByRole('combobox', { name: '单元格口径', exact: true }).selectOption('bestScore')
        const computing = (await page.locator('.rating-progress').allTextContents()).join('')
        const input = page.getByPlaceholder('题号 / 题名', { exact: true })
        const interactions = []
        const progressDuringInput = []
        for (const text of ['P', 'P1', 'P10', 'P100', 'P1001']) {
          progressDuringInput.push((await page.locator('.rating-progress').allTextContents()).join(''))
          const at = performance.now(); await input.fill(text); await expect(input).toHaveValue(text); interactions.push(performance.now() - at)
        }
        await input.fill('')
        await input.fill('P1001')
        await input.press('Escape')
        await expect(input).toHaveValue('')
        await expect.poll(() => new URL(page.url()).searchParams.get('mx:q')).toBe(null)
        await expect.poll(() => new URL(page.url()).searchParams.get('mx:mode')).toBe('bestScore')
        const total = await page.locator('.matrix-count').innerText()
        const problemCount = Object.keys(state.problems).length
        await expect(page.locator('.matrix tbody tr')).toHaveCount(problemCount + 1)
        const rows = await page.locator('.matrix tbody tr').count()
        assert.ok(percentile(interactions, 0.95) < 3000, `Input stalled with all matrix rows mounted: ${JSON.stringify(interactions)}`)
        await expect.poll(async () => (await page.locator('.sum-row td').allTextContents()).some((value) => /\d/.test(value)), { timeout: 45_000 }).toBe(true)
        const geometry = await expandedMatrixGeometry(page, problemCount)
        const result = { records: count, readyMs: performance.now() - start, renderedRows: rows, total, computing,
          inputP95Ms: percentile(interactions, 0.95), inputsMs: interactions, progressDuringInput, geometry }
        report.largeDatasets.push(result)
        await layout(page, `expanded-large-${count}`)
        const file = path.join(output, `expanded-large-${count}-last-problem.png`)
        await page.screenshot({ path: file })
        report.screenshots.push({ name: `expanded-large-${count}-last-problem`, file })
        return result
      })
    } finally { await context.close() }
  }
}

async function identityFailureChecks() {
  const state = fixture()
  state.role = 'admin'
  const { context, page } = await openContext(state)
  try {
    await check('logout clears private data even when subsequent session and data refresh fail', async () => {
      await goto(page, '/?v=table')
      await page.locator('#f-keyword').fill('PRIVATE_PENDING_2')
      await expect(page.locator('#records-wrap tbody tr.row-pending')).toHaveCount(1)
      state.failAfterLogout = true
      await page.getByRole('button', { name: /管理员测试/ }).click()
      await page.getByRole('button', { name: '退出登录', exact: true }).click()
      await expect(page.locator('#records-wrap tbody tr.row-pending')).toHaveCount(0)
      await expect(page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
      await expect(page.getByRole('alert')).toContainText('缓存数据')
      assert.ok(state.requests.some((request) => request.path === '/api/session'))
      const cache = await page.evaluate(() => JSON.parse(localStorage.getItem('radar.cache.v3')))
      assert.ok(cache.scope === 'public' && cache.records.every((record) => record.status === 'approved'))
      await page.getByRole('button', { name: '登录', exact: true }).click()
      const auth = page.getByRole('dialog', { name: '登录', exact: true })
      await auth.locator('#auth-user').fill('contributor')
      await auth.locator('#auth-password').fill('synthetic-password')
      await auth.getByRole('button', { name: '登录', exact: true }).click()
      await expect(auth).toHaveCount(0)
      await expect(page.locator('#records-wrap tbody tr.row-pending')).toHaveCount(0)
      assert.ok((await page.evaluate(() => JSON.parse(localStorage.getItem('radar.cache.v3')))).records.every((record) => record.status === 'approved'))
      await layout(page, 'logout-refresh-failure', true)
    })
  } finally { await context.close() }

  const delayedState = fixture()
  delayedState.role = 'admin'
  const delayed = await openContext(delayedState)
  try {
    await check('a late session response cannot restore privileges after logout', async () => {
      await goto(delayed.page, '/?v=table')
      delayedState.delayNextSession = true
      await delayed.page.getByRole('button', { name: '刷新数据', exact: true }).click()
      await expect.poll(() => typeof delayedState.releaseSession === 'function').toBe(true)
      assert.equal(delayedState.deferredSessionRole, 'admin')
      await delayed.page.getByRole('button', { name: /管理员测试/ }).click()
      await delayed.page.getByRole('button', { name: '退出登录', exact: true }).click()
      await expect(delayed.page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
      const release = delayedState.releaseSession
      release()
      await expect.poll(() => delayedState.releaseSession === null).toBe(true)
      await delayed.page.waitForTimeout(250)
      await expect(delayed.page.getByRole('button', { name: /管理员测试/ })).toHaveCount(0)
      await expect(delayed.page.getByRole('button', { name: '登录', exact: true })).toBeVisible()
      await expect(delayed.page.locator('#records-wrap tbody tr.row-pending')).toHaveCount(0)
      await layout(delayed.page, 'late-session-after-logout', true)
    })
  } finally {
    delayedState.releaseSession?.()
    await delayed.context.close()
  }
}

async function replayChecks() {
  for (const width of [390, 1440]) {
    const { context, page } = await openContext(fixture(), { width, height: width < 500 ? 844 : 1000 })
    try {
      await check(`replay ${width}px: source links, step seek, canvas and playback`, async () => {
        await page.goto(`${baseUrl}/replay.html#src=%2Fapi%2Farena%2Freplays%2Fdemo&t=24`, { waitUntil: 'networkidle' })
        await expect(page.locator('#main')).toBeVisible()
        await expect(page.locator('#tStep')).toContainText('step 24')
        let params = new URLSearchParams(new URL(page.url()).hash.slice(1))
        assert.equal(params.get('src'), '/api/arena/replays/demo')
        assert.equal(params.get('t'), '24')
        const pixels = await page.locator('#cvMoney').evaluate((canvas) => {
          const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data
          let colored = 0
          for (let i = 0; i < data.length; i += 4) if (data[i + 3] && data[i] + data[i + 1] + data[i + 2] > 0) colored++
          return colored
        })
        assert.ok(pixels > 1000, `Replay canvas is blank (${pixels} colored pixels)`)
        const before = await page.locator('#cvMoney').evaluate((canvas) => canvas.toDataURL())
        await page.locator('#spd').selectOption('16')
        await page.getByRole('button', { name: '播放', exact: true }).click()
        await expect.poll(() => page.locator('#tStep').innerText()).not.toContain('step 24 /')
        if (await page.getByRole('button', { name: '暂停', exact: true }).count()) await page.getByRole('button', { name: '暂停', exact: true }).click()
        const after = await page.locator('#cvMoney').evaluate((canvas) => canvas.toDataURL())
        assert.notEqual(after, before, 'Playback must change canvas pixels')
        await page.locator('#seek').fill('3')
        await expect(page.locator('#tStep')).toContainText('step 9')
        params = new URLSearchParams(new URL(page.url()).hash.slice(1))
        assert.equal(params.get('src'), '/api/arena/replays/demo')
        assert.equal(params.get('t'), '9')
        await page.getByRole('button', { name: '后一天', exact: true }).click()
        await expect(page.locator('#tStep')).toContainText('step 33')
        await page.reload({ waitUntil: 'networkidle' })
        await expect(page.locator('#tStep')).toContainText('step 33')
        assert.equal(new URLSearchParams(new URL(page.url()).hash.slice(1)).get('src'), '/api/arena/replays/demo')
        const renderPerformance = await page.evaluate(async (full) => {
          loadReplay(full, { src: '/api/arena/replays/demo', t: 24 })
          const fullState = JSON.stringify(S.frames[8].p)
          const delta = JSON.parse(JSON.stringify(full))
          delta.meta.delta = true
          delta.frames.forEach((frame, index) => {
            if (!index) return
            frame.patch = frame.p.map((player, side) => {
              const patch = {}
              for (let cell = 0; cell < player.tiles.length; cell++) if (player.tiles[cell] !== full.frames[index - 1].p[side].tiles[cell]) patch[cell] = player.tiles[cell]
              delete player.tiles; delete player.extra
              return patch
            })
            frame.xpatch = [{}, {}]
          })
          loadReplay(delta, { src: '/api/arena/replays/demo', t: 24 })
          const deltaMatchesFull = JSON.stringify(S.frames[8].p) === fullState
          const durations = []
          for (let index = 0; index < 60; index++) {
            S.idx = index
            const start = performance.now()
            render()
            durations.push(performance.now() - start)
            await new Promise(requestAnimationFrame)
          }
          return { deltaMatchesFull, durations, p95Ms: durations.slice().sort((a, b) => a - b)[Math.ceil(durations.length * 0.95) - 1] }
        }, syntheticReplay())
        assert.ok(renderPerformance.deltaMatchesFull, 'Full and delta files must decode to the same sampled frame')
        assert.ok(renderPerformance.p95Ms <= 16.7, `Replay JS render p95 exceeds one 60Hz frame: ${renderPerformance.p95Ms}ms`)
        await layout(page, `replay-light-${width}`, true)
        await page.locator('#theme').selectOption('dark')
        await layout(page, `replay-dark-${width}`, true)
        return { coloredCanvasPixels: pixels, renderPerformance, renderTimingScope: 'Synchronous JavaScript render only; excludes browser painting and GPU work' }
      })
    } finally { await context.close() }
  }
}

try {
  await startPreview()
  browser = await chromium.launch({ channel: 'msedge', headless: true })
  report.browserVersion = browser.version()
  const assetDir = path.join(frontend, 'dist', 'assets')
  report.scriptGzip = readdirSync(assetDir).filter((file) => file.endsWith('.js')).map((file) => {
    const bytes = readFileSync(path.join(assetDir, file)); return { file, bytes: bytes.length, gzipBytes: gzipSync(bytes).length }
  })
  if (!scrollOnly && !matrixOnly && !refinementOnly) {
  await performanceSamples()
  await check('synthetic first-screen performance budgets', async () => {
    assert.ok(report.performance.every((sample) => sample.lcpMs > 0 && sample.lcpMs < 2500), 'Synthetic LCP must be below 2.5 seconds')
    assert.ok(report.performance.every((sample) => sample.cls <= 0.1), `CLS exceeds 0.1: ${report.performance.map((sample) => sample.cls)}`)
    assert.ok(report.performance.every((sample) => sample.initialGzipBytes < 100_000), `Initial UI exceeds 100 KB gzip: ${report.performance.map((sample) => sample.initialGzipBytes)}`)
  })
  await websiteChecks()
  await identityFailureChecks()
  await replayChecks()
  }
  if (!scrollOnly && !matrixOnly) await refinementChecks()
  if (!scrollOnly && !refinementOnly) {
    await matrixLayoutChecks()
    await largeDataChecks()
  }
  if (!matrixOnly && !refinementOnly) await recordFormScrollChecks()
  await check('no browser console errors or uncaught exceptions', async () => assert.deepEqual(report.errors, []))
} catch (error) {
  report.checks.push({ name: 'verification runner', passed: false, error: error.stack })
  console.error(error)
} finally {
  await browser?.close()
  await stopPreview()
  report.finishedAt = new Date().toISOString()
  report.summary = { passed: report.checks.filter((item) => item.passed).length, failed: report.checks.filter((item) => !item.passed).length,
    lcpMedianMs: percentile(report.performance.map((sample) => sample.lcpMs), 0.5), clsMax: Math.max(0, ...report.performance.map((sample) => sample.cls)),
    automatedInteractionP95Ms: percentile(report.performance.flatMap((sample) => sample.interactionMs), 0.95),
    initialUiScriptGzipBytes: report.performance[0]?.initialGzipBytes ?? null,
    ratingWorkerGzipBytes: report.scriptGzip?.find((asset) => asset.file.startsWith('rating.worker-'))?.gzipBytes ?? null,
    allProductionScriptsGzipBytes: (report.scriptGzip || []).reduce((sum, file) => sum + file.gzipBytes, 0) }
  report.notes = ['All API data is synthetic and no real database is contacted.',
    'Gzip sizes are computed from production assets; preview HTTP transfer is not representative of Cloudflare compression.',
    'Automated interaction latency measures click to URL/selected-tab update, including Playwright overhead; it is not a field INP measurement.']
  const reportName = scrollOnly ? 'report-scroll' : matrixOnly ? 'report-matrix' : refinementOnly ? 'report-refinement' : 'report'
  writeFileSync(path.join(output, reportName + '.json'), JSON.stringify(report, null, 2))
  writeFileSync(path.join(output, reportName + '.md'), `# Browser Verification\n\n${JSON.stringify(report.summary, null, 2)}\n\n` +
    report.checks.map((item) => `- ${item.passed ? 'PASS' : 'FAIL'} ${item.name}${item.error ? `: ${item.error.split('\n')[0]}` : ''}`).join('\n') +
    '\n\n' + report.notes.join('\n\n') + '\n')
  console.log(JSON.stringify(report.summary))
  console.log(`Report: ${path.join(output, reportName + '.json')}`)
  process.exitCode = report.summary.failed ? 1 : 0
}
