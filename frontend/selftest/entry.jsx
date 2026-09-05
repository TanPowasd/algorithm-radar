/* 自检入口：在 Node 里做真实渲染 + 口径断言（vite 打包后用 node 跑）
   用法见 frontend/vite.selftest.config.mjs 与 npm run selftest */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/* ---------- 1. 浏览器环境垫片（必须在 import 业务代码之前） ---------- */
// 样本优先级：FIXTURE 环境变量 > fixture.json（本机真实裁剪样本，不入库）> fixture.basic.json（纯合成，入库）
// 注意：本文件会被 vite 编到 frontend/.selftest/entry.mjs 再运行，所以样本要往上跳一层找 selftest 目录。
const fromEnv = process.env.FIXTURE
const candidates = fromEnv
  ? [String(fromEnv)]
  : ['../selftest/fixture.json', '../selftest/fixture.basic.json'].map((p) => fileURLToPath(new URL(p, import.meta.url)))
const fixturePath = candidates.find((p) => existsSync(p))
if (!fixturePath) {
  console.error('找不到自检样本，请先执行：node scripts/make-fixture.mjs --basic')
  process.exit(1)
}
const raw = readFileSync(fixturePath, 'utf8')
const snapshot = JSON.parse(raw)
snapshot.models = snapshot.models || []
console.log(`样本来源：${fixturePath.split(/[\\/]/).pop()}`)

const store = new Map([['radar.cache.v3', raw]])
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
}
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.window = {
  innerWidth: 1680,
  innerHeight: 1000,
  location: { href: 'http://127.0.0.1:8788/', search: '' },
  matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  scrollTo() {},
  isSecureContext: true,
}
globalThis.document = {
  documentElement: { setAttribute() {}, style: {}, dataset: {} },
  body: { classList: { add() {}, remove() {} } },
  cookie: 'radar_csrf=x',
  createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {}, click() {} }),
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
}
if (!globalThis.navigator) globalThis.navigator = { clipboard: { writeText: async () => {} } }
globalThis.performance = globalThis.performance || { now: () => Date.now() }

/* ---------- 2. 逻辑口径断言 ---------- */
const {
  bestThinkingCell, filterByModels, recordTs, recordLine, fmtDateTime, fmtClock, luoguUrl,
  seriesColorMap, seriesKey, seriesList, matrixCell, roundsAvg, THINKING_LEVELS, isApproved,
} = await import('../src/aggregate.js')
const { makeVendorOf, vendorColorMap, levelSwatchStyle } = await import('../src/palette.js')
const { rollEvents, rollSnapshot, rankTeams, nextAcIndex, nextDayIndex } = await import('../src/rollboard.js')
const { createRefreshCoordinator } = await import('../src/refreshCoordinator.js')

const React = (await import('react')).default
const { renderToString } = await import('react-dom/server')
const { MemoryRouter } = await import('react-router-dom')
const { AppProvider, AppContext } = await import('../src/state.jsx')
const App = (await import('../src/App.jsx')).default
const ProblemDrawer = (await import('../src/components/ProblemDrawer.jsx')).default
const RecordsTable = (await import('../src/views/RecordsTable.jsx')).default
const RecordFormModal = (await import('../src/components/RecordFormModal.jsx')).default
const DeleteRecordButton = (await import('../src/components/DeleteRecordButton.jsx')).default

const results = []
const jobs = []
/** 支持同步与异步断言；同步断言仍在调用时立即执行，保持顺序确定 */
const check = (name, fn) => {
  jobs.push((async () => {
    try {
      await fn()
      results.push(['PASS', name])
    } catch (e) {
      results.push(['FAIL', `${name} → ${e.message}`])
    }
  })())
}

const records = snapshot.records.filter((r) => r.status === 'approved')
check('数据非空（用于断言的样本）', () => assert.ok(records.length > 30, `只有 ${records.length} 条`))

check('样本足够有代表性（同题同模型多等级 / 多日期 / 带提示词）', () => {
  assert.ok(snapshot.records.some((r) => !isApproved(r)), '样本应包含待审记录，才能验证统计只算已审核')
  const pairs = new Map()
  for (const r of records) {
    const k = `${r.model}|${r.pid}`
    if (!pairs.has(k)) pairs.set(k, new Set())
    pairs.get(k).add(r.thinking)
  }
  const multi = [...pairs.values()].filter((s) => s.size >= 2)
  assert.ok(multi.length >= 3, `同题同模型多思考等级的组合太少：${multi.length}（矩阵「最佳等级」口径测不出来）`)
  assert.ok(new Set(records.map((r) => r.date)).size >= 3, '日期跨度不足，滚榜按天推进会测不出来')
  assert.ok(Object.values(snapshot.problems).some((p) => p.prompt), '样本里没有带提示词的题目，复制功能测不出来')
  assert.ok(records.some((r) => r.submissions?.some((s) => s.score === null || s.score === undefined)), '样本缺无分数轮次，铁律测不出来')
})

/* 厂商同色：同厂商必须同色相 */
check('厂商配色：同厂商 → 同色相', () => {
  const vendorOf = makeVendorOf([])
  const names = ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen-3.8-max', 'kimi-k3']
  const colors = vendorColorMap(names, vendorOf, true)
  const hue = (hex) => {
    const r = parseInt(hex.slice(1, 3), 16) / 255
    const g = parseInt(hex.slice(3, 5), 16) / 255
    const b = parseInt(hex.slice(5, 7), 16) / 255
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    if (!d) return -1
    if (max === r) return (((g - b) / d) % 6) * 60
    if (max === g) return (((b - r) / d) + 2) * 60
    return (((r - g) / d) + 4) * 60
  }
  assert.equal(vendorOf('deepseek-v4-flash'), 'DeepSeek')
  assert.equal(vendorOf('qwen-3.8-max'), '阿里云')
  const h1 = hue(colors.get('deepseek-v4-flash'))
  const h2 = hue(colors.get('deepseek-v4-pro'))
  assert.ok(Math.abs(h1 - h2) < 3, `同厂商色相应一致：${h1} vs ${h2}`)
  assert.notEqual(colors.get('deepseek-v4-flash'), colors.get('deepseek-v4-pro'), '同厂商不同模型应靠明度区分')
  assert.notEqual(colors.get('deepseek-v4-flash'), colors.get('kimi-k3'), '不同厂商应不同色')
})

check('seriesColorMap 传入 vendorOf 时按厂商上色，不传时保持旧回环', () => {
  const vendorOf = makeVendorOf([])
  const a = seriesColorMap(records, { vendorOf, dark: true })
  const b = seriesColorMap(records)
  assert.ok(a.size > 0 && b.size > 0)
  const ds = [...a.keys()].filter((k) => k.startsWith('deepseek'))
  assert.ok(ds.length >= 2)
  const set = new Set(ds.map((k) => a.get(k)))
  assert.equal(set.size, ds.length, '同厂商不同模型颜色不同（明度阶梯）')
})

/* 矩阵：最佳思考等级口径 */
check('矩阵「最佳等级」= 只取思考等级最高的记录', () => {
  const mk = (thinking, score, id) => ({
    id, model: 'm', pid: 'P1', thinking, status: 'approved',
    submissions: [{ score, result: score === 100 ? 'AC' : 'WA' }],
  })
  const recs = [mk('low', 40, '1'), mk('max', 70, '2'), mk('high', 99, '3')]
  const byLevel = bestThinkingCell(recs, 'level')
  assert.equal(byLevel.thinking, 'max', '应取最高等级 max')
  assert.equal(Math.round(byLevel.value), 70, '分数应来自 max 那条')
  const byScore = bestThinkingCell(recs, 'score')
  assert.equal(byScore.thinking, 'high', '分数最优应取 high(99)')
  assert.equal(Math.round(byScore.value), 99)
  assert.deepEqual(bestThinkingCell([], 'level'), { kind: 'none' })
})

check('矩阵「最佳等级」并列时合并同等级记录', () => {
  const mk = (thinking, score, id) => ({
    id, model: 'm', pid: 'P1', thinking, status: 'approved',
    submissions: [{ score, result: 'WA' }],
  })
  const c = bestThinkingCell([mk('ultra', 60, '1'), mk('ultra', 80, '2'), mk('low', 100, '3')], 'level')
  assert.equal(Math.round(c.value), 70, '(60+80)/2 = 70')
  assert.equal(c.n, 2)
  assert.equal(c.total, 3)
})

check('无分数轮次不参与均分（口径铁律未被破坏）', () => {
  const recs = [{
    id: 'x', model: 'm', pid: 'P1', thinking: 'max', status: 'approved',
    submissions: [{ score: null, result: 'CE' }, { score: 50, result: 'WA' }],
  }]
  const info = roundsAvg(recs)
  assert.equal(info.n, 1)
  assert.equal(info.avg, 50)
  const c = bestThinkingCell(recs, 'level')
  assert.equal(Math.round(c.value), 50)
})

check('matrixCell 旧口径仍可用（向后兼容）', () => {
  const one = records[0]
  const c = matrixCell(records, seriesKey(one), one.pid)
  assert.ok(['ac', 'fail', 'giveup'].includes(c.kind))
  assert.ok(c.total >= 1)
})

check('矩阵：两口径在真实样本上确实会给出不同结果', () => {
  let diverge = 0
  let compared = 0
  const byPair = new Map()
  for (const r of records) {
    const k = `${r.model}\u0000${r.pid}`
    if (!byPair.has(k)) byPair.set(k, [])
    byPair.get(k).push(r)
  }
  for (const [, recs] of byPair) {
    if (new Set(recs.map((r) => r.thinking)).size < 2) continue
    compared += 1
    const a = bestThinkingCell(recs, 'level')
    const b = bestThinkingCell(recs, 'score')
    if (a.thinking !== b.thinking || Math.round(a.value) !== Math.round(b.value)) diverge += 1
  }
  assert.ok(compared >= 3, `多等级组合过少：${compared}`)
  assert.ok(diverge >= 1, `${compared} 组多等级记录里两口径结果全一样，切换按钮等于没效果`)
})

/* 时间显示 */
check('时间格式化：年月日 + 时分', () => {
  assert.equal(fmtDateTime('2026-08-29T11:18:32.698Z').length, 16)
  assert.match(fmtDateTime('2026-08-29T11:18:32.698Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.match(fmtClock('2026-08-29T11:18:32.698Z'), /^\d{2}:\d{2}$/)
  assert.equal(fmtDateTime(null), '—')
  assert.ok(recordTs({ date: '2026-08-29', createdAt: '2026-08-29T11:18:32.698Z' }) > 0)
  assert.equal(recordTs({ date: '2026-08-29' }), Date.parse('2026-08-29T00:00:00Z'), '无录入时间时退化为测评日期 00:00')
  assert.equal(recordTs({}), 0, '既无日期也无录入时间应为 0')
})

check('同一天的记录可按录入时间分先后（滚榜需要）', () => {
  const sameDay = records.filter((r) => r.date === records[0].date)
  const ts = sameDay.map(recordTs)
  assert.ok(new Set(ts).size > 1 || sameDay.length === 1, '同日多笔应有不同时序')
})

/* 滚榜 */
check('滚榜：只统计已审核、事件流按录入时间升序', () => {
  const ev = rollEvents(snapshot.records) // 传全量：待审记录必须被挡在外面
  assert.equal(ev.length, records.length, '滚榜事件数应等于已审核记录数（待审不计）')
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].ts >= ev[i - 1].ts, '时间轴必须单调递增')
})

check('滚榜：团队=模型、队员=思考等级、解题=任一队员 AC', () => {
  const ev = rollEvents(records)
  const full = rollSnapshot(ev, ev.length)
  const models = new Set(records.map(seriesKey))
  assert.equal(full.teams.length, models.size, '团队数应等于模型数')
  for (const t of full.teams) {
    assert.ok(t.members.length >= 1, `${t.model} 应有至少一名队员`)
    assert.ok(t.solved <= t.attempted)
    for (const m of t.members) assert.ok(THINKING_LEVELS.includes(m.thinking), `非法队员等级 ${m.thinking}`)
  }
  // 交叉验证：某队某题的 solved 与直接统计一致
  const t0 = full.teams[0]
  let manualSolved = 0
  const best = new Map()
  for (const r of records.filter((r) => seriesKey(r) === t0.model)) {
    const passed = r.submissions?.at(-1)?.result === 'AC'
    best.set(r.pid, (best.get(r.pid) || false) || passed)
  }
  for (const v of best.values()) if (v) manualSolved += 1
  assert.equal(t0.solved, manualSolved, `${t0.model} 解题数应等于有 AC 的题数`)
})

check('滚榜：排名口径 AC 题数 → 均分 → 时间', () => {
  const teams = [
    { model: 'b', solved: 5, avgBest: 90, lastTs: 300 },
    { model: 'a', solved: 6, avgBest: 40, lastTs: 900 },
    { model: 'c', solved: 5, avgBest: 90, lastTs: 100 },
    { model: 'd', solved: 5, avgBest: 80, lastTs: 1 },
  ]
  rankTeams(teams)
  assert.deepEqual(teams.map((t) => t.model), ['a', 'c', 'b', 'd'])
  assert.deepEqual(teams.map((t) => t.rank), [1, 2, 3, 4])
})

check('滚榜：回放中途快照单调（解题数不会倒退）', () => {
  const ev = rollEvents(records)
  let prev = 0
  for (const k of [0, 1, 5, 10, Math.floor(ev.length / 2), ev.length]) {
    const s = rollSnapshot(ev, k)
    assert.ok(s.solvedTotal >= prev, `游标 ${k} 处解题总数倒退：${s.solvedTotal} < ${prev}`)
    prev = s.solvedTotal
  }
})

check('滚榜：跳转工具（下一个 AC / 推进一天）', () => {
  const ev = rollEvents(records)
  const jump = nextAcIndex(ev, 0)
  assert.ok(jump >= 1 && jump <= ev.length)
  assert.ok(ev.slice(0, jump).some((e) => e.passed), '跳到的位置应包含一次 AC')
  const day = nextDayIndex(ev, 0)
  assert.ok(day >= 1)
  assert.notEqual(ev[Math.min(day, ev.length - 1)].date, ev[0].date, '推进一天后日期应前移')
})

check('滚榜：受全局模型筛选约束', () => {
  const one = new Set([seriesKey(records[0])])
  const ev = rollEvents(filterByModels(records, one))
  const s = rollSnapshot(ev, ev.length)
  assert.equal(s.teams.length, 1)
  assert.equal(s.teams[0].model, records[0].model)
})

check('思考等级纹理：等级越高越实、纹理越密', () => {
  const order = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'off']
  for (let i = 1; i < order.length; i++) {
    const a = levelSwatchStyle('#5ad9ff', order[i - 1]).background
    const b = levelSwatchStyle('#5ad9ff', order[i]).background
    assert.notEqual(a, b, `${order[i - 1]} 与 ${order[i]} 纹理应不同`)
  }
})

/* ---------- 3. 真实渲染冒烟（SSR，导入已在第 2 节顶部完成） ---------- */
const renderAt = (href) => {
  const html = renderToString(
    React.createElement(MemoryRouter, { initialEntries: [href] },
      React.createElement(AppProvider, null, React.createElement(App))),
  )
  return html
}

check('渲染 /（矩阵默认视图）', () => {
  const html = renderAt('/?v=matrix')
  assert.ok(html.includes('AI × 题目矩阵'), '矩阵标题缺失')
  assert.ok(html.includes('最佳等级'), '缺「最佳等级」口径按钮')
  assert.ok(html.includes('最佳分数'), '缺「最佳分数」口径按钮')
  assert.ok(html.includes('id="model-filter"'), '缺模型筛选器')
  assert.ok(html.includes('class="hud"'), '缺 HUD')
  // 十字高亮依赖的坐标属性必须落在 DOM 上
  assert.ok(/data-c="c0"/.test(html), '单元格缺 data-c 列坐标')
  assert.ok(/data-r="r0"/.test(html), '单元格缺 data-r 行坐标')
  assert.ok(/<th class="model-col" data-c="c0"/.test(html), '列头缺 data-c（高亮不到列头）')
  assert.ok(/<th class="row-head" data-r="r0"/.test(html), '行头缺 data-r（高亮不到行头）')
  const cells = (html.match(/class="mcell/g) || []).length
  assert.ok(cells > 50, `矩阵单元格过少：${cells}`)
  // 厂商色条 + 等级标注
  assert.ok(/class="vbar"/.test(html), '列头缺厂商色条')
  assert.ok(/class="lv">/.test(html), '最佳等级口径缺等级标注')
})

check('题号可跳转洛谷（外链口径 + 安全属性）', () => {
  // 地址拼装：只认洛谷官方 host，题号统一大写，非法题号不拼死链
  assert.equal(luoguUrl('p1001'), 'https://www.luogu.com.cn/problem/P1001', '题号应统一大写')
  assert.equal(luoguUrl('  CF10A  '), 'https://www.luogu.com.cn/problem/CF10A', '应容忍首尾空格')
  assert.equal(luoguUrl(''), null, '空题号不应拼出链接')
  assert.equal(luoguUrl('不是题号'), null, '非法题号不应拼出链接')
  assert.equal(luoguUrl('../../evil'), null, '非洛谷题号不应拼出链接')

  const grab = (h) => [...h.matchAll(/<a class="pid-link" href="([^"]+)"/g)].map((m) => m[1])
  for (const [view, html] of [['矩阵', renderAt('/?v=matrix')], ['滚榜', renderAt('/?v=roll')]]) {
    const links = grab(html)
    assert.ok(links.length > 0, `${view}视图的题号没有渲染成外链`)
    for (const href of links) {
      assert.ok(
        /^https:\/\/www\.luogu\.com\.cn\/problem\/[A-Z0-9_]+$/.test(href),
        `${view}视图出现不合法外链：${href}`,
      )
    }
    assert.ok(html.includes('target="_blank"'), `${view}视图外链缺 target=_blank（会顶掉本站页面）`)
    assert.ok(html.includes('rel="noopener noreferrer"'), `${view}视图外链缺 rel=noopener`)
  }
  // 明细表常驻首页，题号跳洛谷后打开本站详情的入口改挂到题名上
  const homeHtml = renderAt('/?v=matrix')
  assert.ok(/class="chain pid-detail"/.test(homeHtml), '明细表题名缺打开本站详情的入口')
})

check('渲染 /?v=radar（雷达：尺寸滑杆 + 全屏）', () => {
  const html = renderAt('/?v=radar')
  assert.ok(html.includes('能力雷达'))
  assert.ok(html.includes('radar-stage'), '缺居中舞台容器')
  assert.ok(html.includes('⛶ 全屏') || html.includes('退出全屏'))
  assert.ok(html.includes('没有任何可见数据的轴已自动隐藏'))
})

check('渲染 /?v=bar（柱状：最小样本滑杆 + 厂商图例）', () => {
  const html = renderAt('/?v=bar')
  assert.ok(html.includes('模型 × 思考等级 均分'))
  assert.ok(html.includes('最小样本 n≥'))
  assert.ok(html.includes('满足'), '缺实时计数')
  assert.ok(html.includes('思考等级纹理'))
})

check('渲染 /?v=leaderboard', () => {
  const l = renderAt('/?v=leaderboard')
  assert.ok(l.includes('AI 排名榜'))
  assert.ok(l.includes('厂商'), '榜单缺厂商列')
})

check('渲染 /?v=roll（滚榜：控制条 + 实时名次）', () => {
  const html = renderAt('/?v=roll')
  assert.ok(html.includes('滚榜 · ACM Board'))
  assert.ok(html.includes('播放') && html.includes('重播'))
  assert.ok(html.includes('实时名次'))
  assert.ok(html.includes('团队 = 模型'))
  assert.ok(/class="roll-clock/.test(html), '缺时间轴读数')
  assert.ok(/type="range"/.test(html), '缺进度条')
  assert.ok(/class="rc-cell/.test(html), '缺滚榜格子')
  assert.ok(/class="mb"/.test(html), '格子缺队员（思考等级）色条')
  const rows = (html.match(/class="roll-rank/g) || []).length
  assert.ok(rows >= 2, `名次行过少：${rows}`)
  assert.ok(/transform:translateY\(\d+px\)/.test(html), '名次行未做位移动画')
})

check('渲染明细表：时间列两行（日期 + 时分）', () => {
  const html = renderAt('/')
  assert.ok(html.includes('tcell'), '缺时间单元格结构')
  assert.ok(html.includes('t-date') && html.includes('t-time'))
  assert.ok(html.includes('录入时分'), '缺口径说明')
})

check('渲染抽屉 + 一键复制（提示词出现在抽屉里）', () => {
  const anyPid = Object.keys(snapshot.problems)[0]
  const withPrompt = Object.keys(snapshot.problems).find((p) => snapshot.problems[p].prompt) || anyPid
  // 注入一段提示词（样本库里可能没有），走真实渲染路径
  const seeded = {
    ...snapshot,
    problems: {
      ...snapshot.problems,
      [withPrompt]: { ...snapshot.problems[withPrompt], prompt: '统一测试口径：请独立写出完整可提交的 C++17 代码，只输出代码块。' },
    },
  }
  store.set('radar.cache.v3', JSON.stringify(seeded))
  const html = renderToString(
    React.createElement(MemoryRouter, null,
      React.createElement(AppProvider, null,
        React.createElement(ProblemDrawer, { pid: withPrompt, onClose() {}, onSubmitClick() {} }))),
  )
  store.set('radar.cache.v3', raw)
  assert.ok(html.includes('推荐提示词'), '抽屉缺提示词块')
  assert.ok(html.includes('copy-btn'), '缺一键复制按钮')
  assert.ok(html.includes('一键复制'), '复制按钮文案缺失')
  assert.ok(html.includes('统一测试口径'), '提示词正文未渲染')
})

check('渲染后台/注册/贡献者页（全站统一不崩）', () => {
  for (const path of ['/admin', '/users', '/register', '/contributors']) {
    const html = renderAt(path)
    assert.ok(html.length > 500, `${path} 渲染过短`)
  }
})

/* ---------- 用户管理页的角色门控（v3.8：管理员可删贡献者、站长可清任意非站长账号） ---------- */
const UsersPage = (await import('../src/pages/UsersPage.jsx')).default
const usersCtxBase = {
  session: { loggedIn: false, username: '', nickname: '', role: '', admin: false, canSetup: false, configured: true },
  data: snapshot, models: snapshot.models || [], nicknames: {},
  nicknameOf: (u) => u, nameByUid: () => null,
  offline: false, loaded: true, theme: 'dark', themeMode: 'dark', setThemeMode() {}, toggleTheme() {},
  widthMode: 'full', setWidthMode() {}, barMinSamples: 5, setBarMinSamples() {}, radarSize: 0, setRadarSize() {},
  vendorOf: makeVendorOf(snapshot.models || []), focusModels: new Set(), toggleFocusModel() {}, focusOnly() {},
  toasts: [], toast() {}, refreshAll: async () => true, syncData: async () => true,
  refreshSession: async () => true, refreshData: async () => true,
  refreshModels: async () => {}, refreshNicknames: async () => {}, retryNow: async () => true,
  isOwner: false, isAdmin: false, isContributor: false,
}
const renderUsersAs = (role) => {
  const isAdmin = role === 'admin' || role === 'owner'
  const ctx = {
    ...usersCtxBase,
    session: { ...usersCtxBase.session, loggedIn: isAdmin || role === 'contributor', username: 'tester', role, admin: isAdmin },
    isOwner: role === 'owner', isAdmin, isContributor: isAdmin || role === 'contributor',
  }
  return renderToString(
    React.createElement(MemoryRouter, null,
      React.createElement(AppContext.Provider, { value: ctx }, React.createElement(UsersPage))),
  )
}

check('/users 门控：游客只见访问门槛', () => {
  const html = renderUsersAs('guest')
  assert.ok(html.includes('仅管理员及以上可访问'), '游客应看到访问门槛文案')
  assert.ok(html.includes('>登录<'), '未登录应提供登录入口')
  assert.ok(!html.includes('操作审计'), '游客不应看到审计卡片')
  const contrib = renderUsersAs('contributor')
  assert.ok(contrib.includes('当前账号权限不足'), '已登录的非管理员应看到权限不足提示')
})

check('/users 门控：管理员只见贡献者列表 + 删除（无待审/任免）', () => {
  const html = renderUsersAs('admin')
  assert.ok(html.includes('删除贡献者账号'), '管理员视角应标注能力范围')
  assert.ok(html.includes('审核注册与任免仅站长可见'), '贡献者卡片应标注权限边界')
  assert.ok(html.includes('操作审计'), '管理员也应看到操作审计')
  assert.ok(!html.includes('待审核注册'), '管理员不应看到待审核注册卡片')
  assert.ok(!html.includes('任命管理员'), '管理员不应有任免按钮')
  assert.ok(!html.includes('全部用户'), '管理员不应看到全量用户表')
})

check('/users 门控：站长有完整管理面 + 审计卡片', () => {
  const html = renderUsersAs('owner')
  assert.ok(html.includes('待审核注册'), '站长应看到待审核注册')
  assert.ok(html.includes('全部用户'), '站长应看到全量用户表')
  assert.ok(html.includes('清理任意非站长账号'), '站长视角应标注可清理任意状态账号')
  assert.ok(html.includes('操作审计'), '站长应看到操作审计')
})

check('/users 删除与审计接线（静态源码契约）', () => {
  const src = readFileSync(new URL('../src/pages/UsersPage.jsx', import.meta.url), 'utf8')
  // 删除走 DELETE /api/admin/users/:id（不是 POST role 端点）
  assert.ok(/method:\s*'DELETE'/.test(src), '删除账号必须用 DELETE 方法')
  assert.ok(src.includes('/api/admin/users/${u.id}`'), '删除端点路径不对')
  // 确认框必须写明不可恢复 + 记录保留（防误删口径）
  assert.ok(src.includes('不可恢复') && src.includes('测评记录会保留'), '删除确认框缺风险与保留说明')
  // 待审/已拒行也要有删除入口（站长清理注册垃圾）
  assert.ok((src.match(/deleteConfirm\(u\)/g) || []).length >= 4, '待审/已拒行缺删除入口')
  // 审计走管理端点且有中文动作映射
  assert.ok(src.includes('/api/admin/audit'), '审计卡片没接 /api/admin/audit')
  assert.ok(src.includes("ACTION_LABEL[a.action] || a.action"), '未知审计动作应原样展示')
})

/* ---------- 3.5 日夜主题与全宽版心的落地检查（静态读源码/样式） ---------- */
const srcOf = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
const cssText = srcOf('styles.css')
const mainText = srcOf('main.jsx')
const stateText = srcOf('state.jsx')

check('夜间/日间两套令牌都在，且日间是同构冷白版', () => {
  assert.ok(/:root\[data-theme="light"\]/.test(cssText), '缺日间主题块')
  assert.match(cssText, /--accent:\s*#5ad9ff/, '夜间主色应为参考稿的青 #5ad9ff')
  assert.match(cssText, /--accent-3:\s*#b8ff5c/, '缺柠檬点缀色')
  const lightBlock = cssText.slice(cssText.indexOf(':root[data-theme="light"]'))
  assert.match(lightBlock.slice(0, 1200), /--accent:\s*#0b87b8/, '日间需要自己的（更深的）主色，不能直接套夜间值')
  assert.ok(/--green:/.test(cssText) && /--red:/.test(cssText), '通过/未过语义色必须保留')
})

check('全宽铺满为默认，限宽是显式选项', () => {
  assert.match(cssText, /\.layout\s*\{[^}]*width:\s*100%/s, '.layout 必须 width:100%')
  assert.match(cssText, /\.layout\s*\{[^}]*max-width:\s*none/s, '.layout 默认不能限宽')
  assert.ok(cssText.includes('[data-width="narrow"]'), '缺限宽切换样式')
})

check('首屏预涂主题/版心，避免刷新闪一下', () => {
  assert.ok(mainText.includes('data-theme'), 'main.jsx 未预涂 data-theme')
  assert.ok(mainText.includes('data-width'), 'main.jsx 未预涂 data-width')
  assert.ok(mainText.includes('radar.theme') && mainText.includes('radar.widthMode'), '预涂逻辑没读本地存储')
  assert.ok(/@fontsource\/(chakra-petch|jetbrains-mono)/.test(mainText), '字体未自托管导入（CSP font-src 会拦）')
})

check('主题三态：跟随系统 + 监听系统切换', () => {
  assert.ok(stateText.includes("'system'"), '缺 system 态')
  assert.ok(stateText.includes("prefers-color-scheme: dark"), '未读取系统偏好')
  assert.ok(/addEventListener\('change'/.test(stateText), '系统主题切换时不会跟随')
  assert.ok(stateText.includes('toggleTheme'), '缺主题循环入口')
})

/* ---------- 3.6 删除记录（管理员 / 站长）---------- */
// 用受控的 context 值渲染，才能真的走到「管理员视角」这条分支
const ctxValue = (role) => ({
  data: snapshot,
  models: snapshot.models || [],
  nicknames: {},
  session: { loggedIn: role !== 'guest', username: 'selftest', role: role === 'guest' ? '' : role, admin: role !== 'guest' },
  isAdmin: role === 'admin' || role === 'owner',
  isOwner: role === 'owner',
  isContributor: role !== 'guest',
  theme: 'dark', themeMode: 'dark', widthMode: 'full', barMinSamples: 5, radarSize: 0,
  focusModels: new Set(), toasts: [], offline: false, loaded: true,
  vendorOf: makeVendorOf(snapshot.models || []),
  nicknameOf: (n) => n, nameByUid: () => '',
  toast() {}, refreshAll() {}, syncData() {}, refreshData() {}, refreshModels() {}, refreshNicknames() {}, refreshSession() {},
  toggleTheme() {}, setThemeMode() {}, setWidthMode() {}, setBarMinSamples() {}, setRadarSize() {},
  toggleFocusModel() {}, focusOnly() {},
})
const wrap = (node, role = 'guest') => renderToString(
  React.createElement(MemoryRouter, null,
    React.createElement(AppContext.Provider, { value: ctxValue(role) }, node)))

check('删除入口默认隐藏：游客 / 贡献者拿不到按钮', () => {
  assert.equal(wrap(React.createElement(DeleteRecordButton, { record: records[0] })), '', '游客不应看到删除入口')
  assert.equal(wrap(React.createElement(DeleteRecordButton, { record: records[0] }), 'contributor'), '', '贡献者不应看到删除入口')
  const adminHtml = wrap(React.createElement(DeleteRecordButton, { record: records[0] }), 'admin')
  assert.match(adminHtml, /删除/, '管理员应看到删除按钮')
  assert.match(wrap(React.createElement(DeleteRecordButton, { record: records[0] }), 'owner'), /删除/, '站长应看到删除按钮')
})

check('明细表：管理员出现勾选列与逐行删除，游客没有', () => {
  const asAdmin = wrap(React.createElement(RecordsTable, { isAdmin: true }), 'admin')
  assert.ok(asAdmin.includes('has-check'), '管理员表格缺勾选列标记')
  assert.ok(/aria-label="全选本页"/.test(asAdmin), '缺整页全选')
  assert.ok(/移入回收站/.test(asAdmin), '缺逐行删除入口')
  assert.ok(/编辑/.test(asAdmin), '原有编辑入口丢失')
  const asOwner = wrap(React.createElement(RecordsTable, { isAdmin: true }), 'owner')
  assert.ok(/移入回收站/.test(asOwner), '站长视角缺删除入口')
  const asGuest = wrap(React.createElement(RecordsTable, { isAdmin: false }))
  assert.ok(!asGuest.includes('has-check'), '游客不该有勾选列')
  assert.ok(!/移入回收站/.test(asGuest), '游客不该有删除入口')
  const asContrib = wrap(React.createElement(RecordsTable, { isAdmin: false }), 'contributor')
  assert.ok(!/移入回收站/.test(asContrib), '贡献者不该有删除入口')
})

check('删除确认文案含关键信息（模型·题号·等级·日期）', () => {
  const r = records[0]
  const line = recordLine(r)
  assert.ok(line.includes(r.model) && line.includes(r.pid), `确认文案缺定位信息：${line}`)
  assert.match(line, /\d{4}-\d{2}-\d{2}/, '确认文案缺日期')
  const src = srcOf('components/DeleteRecordButton.jsx')
  assert.ok(src.includes('回收站'), '删除文案必须说明是软删除可恢复')
  assert.ok(src.includes("method: 'DELETE'"), '必须走既有 DELETE /api/records/{id}')
  const tableSrc = srcOf('views/RecordsTable.jsx')
  assert.ok(tableSrc.includes("action: 'reject'"), '批量删除必须复用既有 bulk 接口')
  assert.ok(!/fetch\(|axios/.test(src + tableSrc), '不应绕过统一 api 客户端')
})

check('抽屉：管理员才看得到逐条删除', () => {
  const pid = Object.keys(snapshot.problems)[0]
  const drawer = (role) => wrap(React.createElement(ProblemDrawer, { pid, onClose() {} }), role)
  assert.ok(/移入回收站/.test(drawer('admin')), '管理员抽屉里缺删除入口')
  assert.ok(/移入回收站/.test(drawer('owner')), '站长抽屉里缺删除入口')
  const guestHtml = drawer('guest')
  assert.ok(guestHtml.includes('推荐提示词'), '抽屉主体没渲染出来')
  assert.ok(!/移入回收站/.test(guestHtml), '游客视角出现了管理员删除入口')
  assert.ok(!/移入回收站/.test(drawer('contributor')), '贡献者视角出现了管理员删除入口')
})

/* ---------- 3.7 提交表单：题名/难度由题目目录定死 ---------- */
check('矩阵点「+ 提交测评」打开时，题名与难度就已带入（回归：曾需手动切一次题目）', () => {
  const pid = Object.keys(snapshot.problems).find((p) => snapshot.problems[p].title && Number(snapshot.problems[p].difficulty) > 0)
  assert.ok(pid, '样本里没有带题名+难度的题目')
  const prob = snapshot.problems[pid]
  const html = wrap(React.createElement(RecordFormModal, { lockPid: pid, onClose() {} }), 'contributor')
  assert.ok(html.includes(prob.title), `题名没自动带入（${prob.title}）`)
  assert.ok(html.includes(`value="${prob.difficulty}" selected`), `难度没按目录选中（应为 ${prob.difficulty}）`)
  assert.ok(html.includes('已按你点击的格子锁定题目'), '从格子进入时题目下拉未锁定/未提示')
})

check('题名与难度对提交者只读，且提示写明不可修改', () => {
  const pid = Object.keys(snapshot.problems).find((p) => Number(snapshot.problems[p].difficulty) > 0)
  const html = wrap(React.createElement(RecordFormModal, { lockPid: pid, onClose() {} }), 'contributor')
  assert.equal((html.match(/不可修改/g) || []).length, 2, '题名与难度应各有一条「不可修改」提示')
  assert.ok(/<input[^>]*disabled[^>]*readonly/i.test(html), '题名输入框必须 disabled + readonly')
  assert.ok(/<select[^>]*disabled/.test(html), '难度选择框必须 disabled')
  assert.ok(html.includes('题目目录带入'), '缺少「来自题目目录」的说明')
})

check('表单里题目/目录字段不可被手改绕过（提交值以目录为准）', () => {
  const src = srcOf('components/RecordFormModal.jsx')
  assert.ok(src.includes('selectedProblem.title'), 'payload 必须回读目录题名')
  assert.ok(src.includes('Number(selectedProblem.difficulty)'), 'payload 必须回读目录难度')
  assert.ok(!/title:\s*form\.title,/.test(src), 'payload 不应再把可手改的 form.title 直接发给后端')
  assert.ok(src.includes('applyProblem'), '切换题目需整体重取目录字段')
  assert.ok(/categories:\s*\[\.\.\.\(p\?\.categories \|\| \[\]\)\]/.test(src) || src.includes('p?.categories || []'), '切换题目应重置类别，避免残留上一题')
})

/* ---------- 3.8 刷新协调器（挂载一次拉全 / 变更后必补拉） ---------- */
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

check('sync：并发只跑一轮（StrictMode 双挂载不会重复打接口）', async () => {
  let n = 0
  const c = createRefreshCoordinator(async () => { n += 1; await delay(20); return true })
  const [a, b] = await Promise.all([c.sync(), c.sync()])
  assert.equal(n, 1, `并发 sync 打了 ${n} 轮，应为 1 轮`)
  assert.ok(a && b, '两个调用者都应拿到刷新结果')
})

check('refresh：变更撞上进行中的刷新时一定补拉一轮（老实现会直接丢弃）', async () => {
  const at = []
  let release
  const gate = new Promise((r) => { release = r })
  const c = createRefreshCoordinator(async () => {
    at.push(Date.now())
    if (at.length === 1) await gate // 第一轮卡在飞行中
    return true
  })
  const first = c.refresh()
  await delay(5)
  const second = c.refresh() // 模拟 DELETE/审核 完成后调用：此刻第一轮还没落地
  release()
  await Promise.all([first, second])
  assert.equal(at.length, 2, '变更后的刷新被丢弃 → 界面会停在变更前的数据')
  assert.ok(at[1] >= at[0], '补拉必须在第一轮之后，才能拿到变更后的数据')
})

check('refresh：并发 5 个调用最多两轮，不会滚雪球', async () => {
  let n = 0
  const c = createRefreshCoordinator(async () => { n += 1; await delay(10); return true })
  await Promise.all(Array.from({ length: 5 }, () => c.refresh()))
  assert.ok(n >= 1 && n <= 2, `轮数失控：${n}（应 ≤2）`)
})

check('任务抛错不会把协调器卡死', async () => {
  let n = 0
  let boom = true
  const c = createRefreshCoordinator(async () => { n += 1; if (boom) throw new Error('boom'); return true })
  await assert.rejects(() => c.refresh())
  boom = false
  assert.equal(await c.refresh(), true, '出错后应能继续刷新')
  assert.equal(n, 2)
})

check('setTask：任务体可热替换，替换后跑的是新任务', async () => {
  const seen = []
  const c = createRefreshCoordinator(async () => { seen.push('v1'); return true })
  await c.sync()
  c.setTask(async () => { seen.push('v2'); return true })
  await c.refresh()
  assert.deepEqual(seen, ['v1', 'v2'])
})

check('挂载 effect 用 sync、变更后用 refreshAll（接线正确）', () => {
  const st = srcOf('state.jsx')
  assert.ok(/useEffect\(\(\) => \{\s*syncData\(\)/.test(st), '挂载 effect 应走 syncData（搭车，不重复请求）')
  assert.ok(st.includes('createRefreshCoordinator(runFullRefresh)'), '必须经协调器包装全量刷新')
  assert.ok(st.includes('coordinator.setTask(runFullRefresh)'), '任务体需在 effect 里热更新（渲染期不碰 ref）')
  assert.ok(/setInterval\(\(\) => \{\s*syncData\(\)/.test(st), '离线自动重试应走 syncData')
  assert.ok(!/if \(refreshingRef\.current\) return true/.test(st), '旧的「直接丢弃并发刷新」写法必须移除')
  assert.ok(srcOf('components/DeleteRecordButton.jsx').includes('await refreshAll()'), '删除后必须等刷新落地')
})

/* ---------- 4. 汇报 ---------- */
await Promise.all(jobs)
const fails = results.filter((r) => r[0] === 'FAIL')
for (const [k, name] of results) console.log(`${k === 'PASS' ? '✓' : k === 'SKIP' ? '-' : '✗'} ${name}`)
console.log(`\n${results.length - fails.length}/${results.length} 通过，样本：${records.length} 条记录 / ${Object.keys(snapshot.problems).length} 题 / ${seriesList(records).length} 个模型`)
if (fails.length) {
  console.log('\n失败项：')
  for (const f of fails) console.log(' - ' + f[1])
  process.exitCode = 1
}
