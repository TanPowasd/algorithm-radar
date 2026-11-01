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
const snapshot = JSON.parse(readFileSync(fixturePath, 'utf8'))
snapshot.models = snapshot.models || []
snapshot.cacheSchema = 4
snapshot.scope = 'public'
const raw = JSON.stringify(snapshot)
console.log(`样本来源：${fixturePath.split(/[\\/]/).pop()}`)

const store = new Map([['radar.cache.v3', raw]])
// 明细表默认折叠（64dbabd）会让表格体不渲染；自检统一展开渲染旧断言，
// 默认折叠行为另有专项断言（见「明细表默认折叠」）
store.set('radar.records.collapsed', 'false')
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
  axisStats, bestThinkingCell, filterByModels, recordTs, recordLine, fmtDateTime, fmtClock, luoguUrl,
  seriesColorMap, seriesKey, seriesList, matrixCell, roundsAvg, THINKING_LEVELS, isApproved,
} = await import('../src/aggregate.js')
const { makeVendorOf, vendorColorMap, levelSwatchStyle } = await import('../src/palette.js')
const { rollEvents, rollSnapshot, rankTeams, nextAcIndex, nextDayIndex } = await import('../src/rollboard.js')
const { createRefreshCoordinator } = await import('../src/refreshCoordinator.js')
const { normalizeUiPreferences: normUiPrefs, scoreDigits } = await import('../src/uiPreferences.js')

const React = (await import('react')).default
const { renderToString } = await import('react-dom/server')
const { MemoryRouter } = await import('react-router-dom')
const { AppProvider, AppContext } = await import('../src/state.jsx')
const App = (await import('../src/App.jsx')).default
const HomePage = (await import('../src/pages/HomePage.jsx')).default
const K4uV2Page = (await import('../src/pages/K4uV2Page.jsx')).default
const AdminPage = (await import('../src/pages/AdminPage.jsx')).default
const RegisterPage = (await import('../src/pages/RegisterPage.jsx')).default
const ContributorsPage = (await import('../src/pages/ContributorsPage.jsx')).default
const UsersPage = (await import('../src/pages/UsersPage.jsx')).default
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

check('厂商配色（平色模式/柱状图）：同厂商不同模型使用完全相同的颜色', () => {
  const vendorOf = makeVendorOf([])
  const names = ['deepseek-v4-flash', 'deepseek-v4-pro', 'qwen-3.8-max', 'kimi-k3']
  const colors = vendorColorMap(names, vendorOf, true, { shade: false })
  assert.equal(colors.get('deepseek-v4-flash'), colors.get('deepseek-v4-pro'), '平色模式下同厂商模型颜色必须完全一致')
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

check('雷达图轴统计：支持题目多算法标签（数组多轴归属）', () => {
  const dummyRecs = [
    { model: 'M1', pid: 'P1', status: 'approved', submissions: [{ score: 100, result: 'AC' }] },
    { model: 'M1', pid: 'P2', status: 'approved', submissions: [{ score: 0, result: 'WA' }] },
  ]
  const tagMap = {
    P1: ['数学', '树'],
    P2: ['数学'],
  }
  const stats = axisStats(dummyRecs, (r) => tagMap[r.pid], 'final')
  assert.equal(stats.get('数学').answered, 2)
  assert.equal(stats.get('数学').passed, 1)
  assert.equal(stats.get('数学').value, 50)
  assert.equal(stats.get('树').answered, 1)
  assert.equal(stats.get('树').passed, 1)
  assert.equal(stats.get('树').value, 100)
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
const renderComponentAt = (Component, href = '/') => {
  const html = renderToString(
    React.createElement(MemoryRouter, { initialEntries: [href] },
      React.createElement(AppProvider, null, React.createElement(Component))),
  )
  return html
}
// Legacy analysis components retain their contracts without restoring the old route.
const renderAt = (href) => renderComponentAt(HomePage, href)

check('渲染 /（矩阵默认视图）', () => {
  const html = renderAt('/?v=matrix')
  assert.ok(html.includes('AI × 题目矩阵'), '矩阵标题缺失')
  assert.ok(html.includes('最佳等级'), '缺「最佳等级」口径按钮')
  assert.ok(html.includes('最佳分数'), '缺「最佳分数」口径按钮')
  assert.ok(html.includes('id="model-filter"'), '缺模型筛选器')
  assert.ok(html.includes('<span>设置</span>'), '缺集中管理外观、功能与数据的设置入口')
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

check('明细表默认折叠：只留卡片头与展开按钮，表格体不渲染', () => {
  store.delete('radar.records.collapsed') // 恢复产品默认（折叠）
  try {
    const html = renderAt('/')
    assert.ok(html.includes('展开明细'), '折叠态缺「展开明细」按钮')
    assert.ok(html.includes('id="records-count"'), '折叠态缺记录数提示')
    assert.ok(!html.includes('tcell'), '折叠态不应渲染表格单元格（时间列/tcell）')
  } finally {
    store.set('radar.records.collapsed', 'false') // 还原自检展开态
  }
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

/* ---------- v3.11 推荐提示词模板：标准模板拼装 + 附件提醒 ---------- */
const { standardPrompt } = await import('../src/aggregate.js')

check('标准模板拼装：工作区指令 + 题面 + 限制 + 附件注意', () => {
  const p = {
    pid: 'P1001', title: 'A+B Problem', content: '## 题目描述\n\n输入两个整数。',
    timeLimit: 1000, memoryLimit: 512, hasAttachments: true,
  }
  const withModel = standardPrompt(p, 'gpt-5')
  assert.ok(withModel.startsWith('建立 gpt-5_P1001 文件夹'), '已知模型名应注入文件夹名')
  assert.ok(withModel.includes('禁止联网') && withModel.includes('禁止作弊背题'), '缺工作区隔离指令')
  assert.ok(withModel.includes('## 题目描述') && withModel.includes('输入两个整数。'), '题面 markdown 未嵌入')
  assert.ok(withModel.includes('时间限制：1000 ms'), '缺时间限制')
  assert.ok(withModel.includes('内存限制：512 MB'), '缺内存限制')
  assert.ok(withModel.includes('洛谷附有题目附件'), '附件题缺下载提醒')
  const noModel = standardPrompt(p)
  assert.ok(noModel.includes('{模型id}_P1001'), '未知模型名应保留 {模型id} 占位符')
  const bare = standardPrompt({ pid: 'P1002' })
  assert.ok(bare.includes('www.luogu.com.cn/problem/P1002'), '无题面时应降级为洛谷原题链接')
  assert.ok(!bare.includes('时间限制'), '无限制数据时不应输出限制行')
})

check('附件提醒弹窗：复制口统一走 PromptCopyButton（静态源码契约）', () => {
  const srcAt = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
  const btn = srcAt('components/PromptCopyButton.jsx')
  assert.ok(btn.includes('hasAttachments') && btn.includes('setShowNotice(true)'), '附件题复制后必须触发提醒')
  assert.ok(btn.includes('luoguUrl') && btn.includes('noopener noreferrer'), '提醒窗应给洛谷原题外链（新标签+noopener）')
  assert.ok(/useDialog\(/.test(btn), '提醒弹窗未接入焦点管理')
  // 复制时选择模型：无模型上下文的复制口先弹选择窗再注入 {模型id}；上次选择要记住
  assert.ok(btn.includes('选择本次测试的模型'), '缺复制前选模型小窗')
  assert.ok(btn.includes('radar.prompt.lastModel'), '上次选择的模型应持久化（下次预选）')
  assert.ok(btn.includes('!modelId'), '带模型上下文时应跳过选择窗直接复制')
  // 四处提示词复制口都必须走 PromptCopyButton，不能再裸用 CopyButton 复制题目提示词
  const spots = ['components/ProblemDrawer.jsx', 'components/RecordFormModal.jsx', 'pages/AdminPage.jsx', 'pages/PromptsPage.jsx']
  for (const f of spots) {
    const s = srcAt(f)
    assert.ok(s.includes('PromptCopyButton'), `${f} 未接入 PromptCopyButton`)
    assert.ok(!/CopyButton\s+text=\{[^}]*prompt/i.test(s), `${f} 仍在裸用 CopyButton 复制提示词`)
  }
})

check('渲染抽屉：无专属提示词时也展示标准模板（v3.11）', () => {
  const anyPid = Object.keys(snapshot.problems)[0]
  const seeded = {
    ...snapshot,
    problems: {
      ...snapshot.problems,
      [anyPid]: { ...snapshot.problems[anyPid], prompt: '' },
    },
  }
  store.set('radar.cache.v3', JSON.stringify(seeded))
  const html = renderToString(
    React.createElement(MemoryRouter, null,
      React.createElement(AppProvider, null,
        React.createElement(ProblemDrawer, { pid: anyPid, onClose() {} }))),
  )
  store.set('radar.cache.v3', raw)
  assert.ok(html.includes('标准统一模板'), '无专属提示词的题应标注标准统一模板')
  assert.ok(html.includes('建立 '), '标准模板正文未渲染（缺工作区指令）')
  assert.ok(html.includes('{模型id}'), '抽屉无模型上下文时应保留占位符')
})

check('题面补全：编辑模式可重抓 + 管理台批量补全端点（静态源码契约）', () => {
  const srcAt = (rel) => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8')
  const modal = srcAt('components/PublishModal.jsx')
  assert.ok(!/disabled=\{busy \|\| isEdit\}/.test(modal), '编辑模式不得再禁用抓取按钮（旧题无法补全题面）')
  assert.ok(modal.includes('重新抓取'), '编辑模式抓取按钮应改叫「重新抓取」')
  const router = readFileSync(new URL('../../worker/router.ts', import.meta.url), 'utf8')
  assert.ok(router.includes('/api/admin/backfill-content'), '缺批量补全题面端点')
  const luogu = readFileSync(new URL('../../worker/luogu.ts', import.meta.url), 'utf8')
  assert.ok(luogu.includes('输入输出样例') && luogu.includes('samples'), '题面拼装缺输入输出样例节')
  const storeSrc = readFileSync(new URL('../../worker/store.ts', import.meta.url), 'utf8')
  assert.ok(storeSrc.includes("content NOT LIKE '%输入样例%'"), '批量补全必须把缺样例的旧题纳入待补')
  const admin = srcAt('pages/AdminPage.jsx')
  assert.ok(admin.includes("api('/api/admin/backfill-content'"), '管理台缺补全题面入口')
})

check('渲染后台/注册/贡献者页（全站统一不崩）', () => {
  for (const [path, Component] of [['/admin', AdminPage], ['/users', UsersPage], ['/register', RegisterPage], ['/contributors', ContributorsPage]]) {
    const html = renderComponentAt(Component, path)
    assert.ok(html.length > 500, `${path} 渲染过短`)
  }
})

/* ---------- 用户管理页的角色门控（v3.8：管理员可删贡献者、站长可清任意非站长账号） ---------- */
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
const renderUsersAs = (role, href = '/users') => {
  const isAdmin = role === 'admin' || role === 'owner'
  const ctx = {
    ...usersCtxBase,
    session: { ...usersCtxBase.session, loggedIn: isAdmin || role === 'contributor', username: 'tester', role, admin: isAdmin },
    isOwner: role === 'owner', isAdmin, isContributor: isAdmin || role === 'contributor',
  }
  return renderToString(
    React.createElement(MemoryRouter, { initialEntries: [href] },
      React.createElement(AppContext.Provider, { value: ctx }, React.createElement(UsersPage))),
  )
}

check('/users 门控：游客只见访问门槛', () => {
  const html = renderUsersAs('guest')
  assert.ok(html.includes('用户管理') && !html.includes('mg-tabs'), '游客不应看到管理分区')
  assert.ok(html.includes('>登录<'), '未登录应提供登录入口')
  assert.ok(!html.includes('操作审计'), '游客不应看到审计卡片')
  const contrib = renderUsersAs('contributor')
  assert.ok(contrib.includes('当前账号权限不足'), '已登录的非管理员应看到权限不足提示')
})

check('/users 门控：管理员只见贡献者列表 + 删除（无待审/任免）', () => {
  const html = renderUsersAs('admin')
  assert.ok(html.includes('贡献者账号'), '管理员视角应只显示贡献者账号')
  assert.ok(html.includes('操作审计'), '管理员也应看到操作审计')
  assert.ok(!html.includes('待审核注册'), '管理员不应看到待审核注册卡片')
  assert.ok(!html.includes('任命管理员'), '管理员不应有任免按钮')
  assert.ok(!html.includes('全部用户'), '管理员不应看到全量用户表')
  assert.ok(!renderUsersAs('admin', '/users?users:tab=pending').includes('待审核注册'), '管理员不能通过 URL 切到注册审核分区')
})

check('/users 门控：站长有完整管理面 + 审计卡片', () => {
  const html = renderUsersAs('owner')
  assert.ok(html.includes('注册申请'), '站长应看到注册申请入口')
  assert.ok(html.includes('全部用户'), '站长应看到全量用户表')
  assert.ok(html.includes('注册审核与账号权限'), '站长视角应显示完整账号管理入口')
  assert.ok(html.includes('操作审计'), '站长应看到操作审计')
  assert.ok(renderUsersAs('owner', '/users?users:tab=pending').includes('待审核注册'), '站长注册审核分区未接通')
  assert.ok(renderUsersAs('owner', '/users?users:tab=audit').includes('最近 100 条'), '站长审计分区未接通')
})

check('/users 删除与审计接线（静态源码契约）', () => {
  const src = readFileSync(new URL('../src/pages/UsersPage.jsx', import.meta.url), 'utf8')
  // 删除走 DELETE /api/admin/users/:id（不是 POST role 端点）
  assert.ok(/method:\s*'DELETE'/.test(src), '删除账号必须用 DELETE 方法')
  assert.ok(src.includes('/api/admin/users/${r.id}`'), '删除端点路径不对')
  // 确认框必须写明不可恢复 + 记录保留（防误删口径）
  assert.ok(src.includes('不可恢复') && src.includes('测评记录会保留'), '删除确认框缺风险与保留说明')
  // 待审/已拒行也要有删除入口（站长清理注册垃圾）
  assert.ok(src.includes('deleteConfirm(r)') && src.includes("r.role !== 'owner'"), '所有非站长状态应共用受保护的删除入口')
  assert.ok(src.includes("isOwner && r.status === 'pending'"), '注册审核行缺站长角色门控')
  // 审计走管理端点且有中文动作映射
  assert.ok(src.includes('/api/admin/audit'), '审计卡片没接 /api/admin/audit')
  assert.ok(src.includes("ACTION_LABEL[r.action] || r.action"), '未知审计动作应原样展示')
})

/* ---------- 洞察口径（v3.9）：模型稳定性 / 题目区分度 / 思考等级收益 ---------- */
const { modelStability, problemDiscrimination, thinkingYield, bestScoreOf, stdDev } =
  await import('../src/aggregate.js')

check('洞察基础口径：bestScoreOf 与 stdDev', () => {
  assert.equal(bestScoreOf({ submissions: [{ score: 30 }, { score: null }, { score: 80 }] }), 80, '无分数轮次不计，取最高')
  assert.equal(bestScoreOf({ submissions: [{ score: null }] }), null, '全部无分 → null')
  assert.equal(bestScoreOf({ submissions: [] }), null, '空轮次 → null')
  assert.equal(stdDev([5, 5, 5]), 0, '常量序列标准差为 0')
  assert.equal(stdDev([1]), 0, '样本不足 2 → 0')
  assert.equal(stdDev([]), 0, '空序列 → 0')
  assert.ok(Math.abs(stdDev([0, 10]) - 5) < 1e-9, '两值标准差 = 差值一半')
})

check('洞察：模型稳定性（AC 率分母 = 作答记录数，无分记录不计入均分）', () => {
  const recs = [
    { model: 'A', pid: 'P1', thinking: 'max', status: 'approved', submissions: [{ score: 100, result: 'AC' }] },
    { model: 'A', pid: 'P2', thinking: 'max', status: 'approved', submissions: [{ score: null, result: 'TLE' }] },
    { model: 'A', pid: 'P3', thinking: 'max', status: 'approved', submissions: [{ score: 0, result: 'WA' }] },
    { model: 'B', pid: 'P1', thinking: 'low', status: 'approved', submissions: [{ score: 100, result: 'AC' }] },
  ]
  const rows = modelStability(recs)
  const a = rows.find((r) => r.model === 'A')
  const b = rows.find((r) => r.model === 'B')
  assert.equal(a.answered, 3, 'A 作答 3 条（含无分轮次记录）')
  assert.equal(a.ac, 1, 'A AC 1 条')
  assert.equal(a.problems, 3, 'A 覆盖 3 题')
  assert.ok(Math.abs(a.avgBest - (100 + 0) / 2) < 1e-9, '无分数记录不进均分：(100+0)/2')
  assert.ok(Math.abs(a.acRate - 1 / 3) < 1e-9, 'AC 率分母 = 作答记录数')
  assert.ok(Math.abs(a.stdBest - 50) < 1e-9, 'A 两样本 [100,0] 标准差 50')
  assert.equal(b.stdBest, 0, 'B 单样本标准差 0')
})

check('洞察：题目区分度（极差按模型均分算，降序）', () => {
  const recs = [
    { model: 'A', pid: 'P1', status: 'approved', submissions: [{ score: 100 }] },
    { model: 'B', pid: 'P1', status: 'approved', submissions: [{ score: 0 }] },
    { model: 'A', pid: 'P2', status: 'approved', submissions: [{ score: 50 }] },
    { model: 'B', pid: 'P2', status: 'approved', submissions: [{ score: 60 }] },
  ]
  const rows = problemDiscrimination(recs)
  assert.equal(rows[0].pid, 'P1', 'P1 极差 100 排第一')
  assert.ok(Math.abs(rows[0].spread - 100) < 1e-9, 'P1 极差 = 100−0')
  assert.ok(Math.abs(rows[1].spread - 10) < 1e-9, 'P2 极差 = 60−50')
  assert.equal(rows[0].models, 2, 'P1 参与模型数 2')
})

check('洞察：思考等级收益（未知等级归 max，按等级顺序输出）', () => {
  const recs = [
    { model: 'A', pid: 'P1', thinking: 'off', status: 'approved', submissions: [{ score: 0 }] },
    { model: 'A', pid: 'P2', thinking: 'ultra', status: 'approved', submissions: [{ score: 100, result: 'AC' }] },
    { model: 'A', pid: 'P3', thinking: ' alien ', status: 'approved', submissions: [{ score: 50 }] },
  ]
  const rows = thinkingYield(recs)
  assert.deepEqual(rows.map((r) => r.thinking), ['ultra', 'max', 'off'], '输出按等级强弱排序，未知等级并入 max')
  assert.equal(rows[1].answered, 1, 'max 桶只含归并的未知等级记录')
})

check('渲染 /?v=insight（三张洞察表）', () => {
  const html = renderAt('/?v=insight')
  assert.ok(html.includes('模型稳定性'), '缺模型稳定性卡片')
  assert.ok(html.includes('题目区分度'), '缺题目区分度卡片')
  assert.ok(html.includes('思考等级收益'), '缺思考等级收益卡片')
  assert.ok(html.includes('成绩标准差'), '稳定性表缺标准差列')
  assert.ok(html.includes('模型均分极差'), '区分度表缺极差列')
})

/* ---------- 贡献者视角（v3.10）：全站筛选器 ---------- */
const { filterByContributor } = await import('../src/aggregate.js')

check('贡献者视角口径：filterByContributor（uid / legacy / null）', () => {
  const recs = [
    { id: 'a', model: 'A', pid: 'P1', status: 'approved', authorId: 7 },
    { id: 'b', model: 'A', pid: 'P2', status: 'approved', authorId: 9 },
    { id: 'c', model: 'B', pid: 'P1', status: 'approved' }, // 历史导入：无 authorId
  ]
  assert.equal(filterByContributor(recs, null).length, 3, 'null = 不过滤')
  assert.deepEqual(filterByContributor(recs, 7).map((r) => r.id), ['a'], 'uid=7 只看 authorId 7')
  assert.deepEqual(filterByContributor(recs, 'legacy').map((r) => r.id), ['c'], 'legacy 只看无 authorId 的记录')
  assert.equal(filterByContributor(recs, 999).length, 0, '不存在的 uid → 空集（名册删除后自然失效）')
})

check('贡献者视角：全站接入契约（所有视图与统计都必须走同一过滤器）', () => {
  const files = [
    'views/MatrixView.jsx', 'views/RadarView.jsx', 'views/BarView.jsx', 'views/LeaderboardView.jsx',
    'views/RollBoardView.jsx', 'views/InsightView.jsx', 'views/RecordsTable.jsx',
    'components/StatsBar.jsx', 'pages/HomePage.jsx',
  ]
  for (const f of files) {
    const src = readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8')
    assert.ok(src.includes('filterByContributor'), `${f} 未接入贡献者视角过滤`)
  }
})

check('贡献者视角：名册页与筛选控件接线（静态源码契约）', () => {
  const page = readFileSync(new URL('../src/pages/ContributorsPage.jsx', import.meta.url), 'utf8')
  assert.ok(page.includes('setFocusContributor'), '名册页应能设置贡献者视角')
  assert.ok(page.includes('全站查看'), '名册页缺「全站查看」入口')
  assert.ok(page.includes("'legacy'"), '名册页应支持全民制作人视角')
  const filter = readFileSync(new URL('../src/components/ContributorFilter.jsx', import.meta.url), 'utf8')
  assert.ok(filter.includes('fc-select') && filter.includes('查看全部'), '筛选控件缺选择器与退出入口')
  const state = readFileSync(new URL('../src/state.jsx', import.meta.url), 'utf8')
  assert.ok(state.includes('radar.focusContributor'), '状态未持久化到 localStorage')
})

check('贡献者视角：选中后 StatsBar 统计同步收缩（真实渲染）', () => {
  const approved = (snapshot.records || []).filter((r) => r.status !== 'pending')
  const withUid = approved.find((r) => r.authorId !== null && r.authorId !== undefined)
  const assertCount = (expected) => {
    const html = renderAt('/')
    assert.ok(
      new RegExp(`class="s-value">${expected}<`).test(html),
      `StatsBar 记录数应为 ${expected}，实际渲染中找不到`,
    )
  }
  try {
    if (withUid) {
      const uid = withUid.authorId
      const expected = approved.filter((r) => r.authorId === uid).length
      store.set('radar.focusContributor', String(uid))
      assertCount(expected)
    }
    const legacyExpected = approved.filter((r) => r.authorId === null || r.authorId === undefined).length
    store.set('radar.focusContributor', 'legacy')
    assertCount(legacyExpected)
  } finally {
    store.delete('radar.focusContributor') // 还原为全部，避免影响后续渲染断言
  }
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
  assert.match(lightBlock.slice(0, 1200), /--accent:\s*#006b94/, '日间需要自己的高对比主色，不能直接套夜间值')
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

check('主题四态：暖色、跟随系统与系统切换监听', () => {
  assert.ok(stateText.includes("'system'"), '缺 system 态')
  assert.ok(stateText.includes("prefers-color-scheme: dark"), '未读取系统偏好')
  assert.ok(/addEventListener\('change'/.test(stateText), '系统主题切换时不会跟随')
  assert.ok(stateText.includes('toggleTheme'), '缺主题循环入口')
  assert.ok(stateText.includes("'warm'"), '缺暖色主题')
})

check('首次访问跟随系统，已有明暗和暖色选择继续保留', async () => {
  const { useApp } = await import('../src/state.jsx')
  // eslint-disable-next-line react/only-export-components -- Node SSR 自检探针，不是热更新入口。
  function ThemeProbe() {
    const { theme, themeMode } = useApp()
    return React.createElement('output', null, `${themeMode}/${theme}`)
  }
  const renderTheme = () => renderToString(React.createElement(AppProvider, null, React.createElement(ThemeProbe)))
  const previous = store.get('radar.theme')
  try {
    store.delete('radar.theme')
    assert.ok(renderTheme().includes('system/dark'), '新访客应跟随系统明暗')
    store.set('radar.theme', 'dark')
    assert.ok(renderTheme().includes('dark/dark'), '已有暗色选择不能被覆盖')
    store.set('radar.theme', 'light')
    assert.ok(renderTheme().includes('light/light'))
    store.set('radar.theme', 'invalid')
    assert.ok(renderTheme().includes('system/dark'), '损坏的偏好应回退跟随系统')
    store.set('radar.theme', 'warm')
    assert.ok(renderTheme().includes('warm/warm'), '暖色偏好不能被系统暗色覆盖')
    store.set('radar.theme', 'system')
    assert.ok(renderTheme().includes('system/dark'), '保留显式跟随系统的功能')
  } finally {
    if (previous === undefined) store.delete('radar.theme')
    else store.set('radar.theme', previous)
  }
})

check('首页直线标签保留六视图、当前状态与键盘接线', () => {
  const html = renderAt('/')
  assert.match(html, /role="tablist" aria-label="分析视图"/)
  assert.match(html, /id="view-tab-matrix" role="tab" aria-selected="true"/)
  assert.match(html, /role="tabpanel" aria-labelledby="view-tab-matrix"/)
  assert.ok(srcOf('components/ViewTabs.jsx').includes('ArrowRight'))
  assert.match(cssText, /--r-lg:\s*0px/)
  assert.match(cssText, /--r-pill:\s*2px/)
})

check('矩阵查找只缩小题目行，整体统计与模型列保持不变', () => {
  const all = renderAt('/')
  const pid = Object.keys(snapshot.problems)[0]
  const found = renderAt(`/?mx:q=${pid}`)
  const rows = (html) => [...html.matchAll(/<th[^>]*data-detail="([^"]+)"/g)].map((match) => match[1])
  assert.equal(rows(found).length, 1)
  assert.equal(rows(found)[0], pid)
  const sum = (html) => html.match(/<tr class="sum-row">.*?<\/tr>/)?.[0]
  assert.equal(sum(found), sum(all), '题目查找不能重算整体分数')
  assert.ok(renderAt('/?mx:q=__no_such_problem__').includes('显示全部题目'))
  assert.match(found, /tabindex="0".*?查看测评详情/)
})

check('账号设置为两个独立表单，改密不能误提交昵称', () => {
  const text = srcOf('components/ChangePasswordModal.jsx')
  assert.match(text, /<form onSubmit=\{submitNick\} aria-label="修改昵称">/)
  assert.match(text, /<form onSubmit=\{submit\} aria-label="修改密码">/)
  assert.ok(text.includes('/api/change-password'))
})

check('弹层保留焦点管理与 Esc；明细按钮支持自动展开搜索', () => {
  for (const name of ['AuthModal', 'RecordFormModal', 'PublishModal', 'ImportModal', 'ChangePasswordModal', 'ProblemDrawer']) {
    const text = srcOf(`components/${name}.jsx`)
    assert.ok(text.includes('useDialog(onClose)'), `${name} 未接入弹层键盘管理`)
    assert.ok(text.includes('aria-modal="true"'), `${name} 未声明模态`)
  }
  assert.ok(srcOf('pages/HomePage.jsx').includes('radar:focus-records'))
  assert.ok(srcOf('views/RecordsTable.jsx').includes("addEventListener('radar:focus-records'"))
  assert.ok(srcOf('hooks/useHotkeys.js').includes('[aria-modal="true"]'))
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

check('题名与难度对提交者只读，且提示写明题目目录锁定', () => {
  const pid = Object.keys(snapshot.problems).find((p) => Number(snapshot.problems[p].difficulty) > 0)
  const html = wrap(React.createElement(RecordFormModal, { lockPid: pid, onClose() {} }), 'contributor')
  assert.equal((html.match(/已按题目目录锁定/g) || []).length, 2, '题名与难度应各有一条目录锁定提示')
  assert.ok(/<input[^>]*disabled[^>]*readonly/i.test(html), '题名输入框必须 disabled + readonly')
  assert.ok(/<select[^>]*disabled/.test(html), '难度选择框必须 disabled')
  assert.ok(html.includes('题目目录锁定'), '缺少来自题目目录的说明')
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
const { weightedRoundScore, V2_CUTOFF_ISO } = await import('../src/score.js')
const { toV2Dataset } = await import('../src/v2data.js')
const currentSnapshot = {
  revision: 8, epoch: 'selftest-epoch', scope: 'public',
  problems: { P1001: { pid: 'P1001', title: 'Current benchmark', difficulty: 2, categories: ['simulation'] } },
  records: [
    { id: 'current-a', model: 'Current-A', pid: 'P1001', thinking: 'high', status: 'approved', createdAt: V2_CUTOFF_ISO,
      submissions: [{ score: 80, timeMs: 1000, memoryMb: 125, result: 'WA' }] },
    { id: 'current-b', model: 'Current-B', pid: 'P1001', thinking: 'high', status: 'approved', createdAt: '2026-09-06T00:00:00Z',
      submissions: [{ score: 100, timeMs: 1000, memoryMb: 125, result: 'AC' }] },
    { id: 'old', model: 'Old-only', pid: 'P1001', thinking: 'high', status: 'approved', createdAt: '2026-09-04T00:00:00Z',
      submissions: [{ score: 99, result: 'WA' }] },
    { id: 'no-perf', model: 'No-perf', pid: 'P1001', thinking: 'high', status: 'approved', createdAt: '2026-09-06T00:00:00Z',
      submissions: [{ score: 100, result: 'AC' }] },
  ],
}
const renderCurrent = (href = '/', Component = K4uV2Page) => renderToString(
  React.createElement(MemoryRouter, { initialEntries: [href] },
    React.createElement(AppContext.Provider, { value: {
      ...ctxValue('guest'), data: currentSnapshot, focusContributor: null,
      openAuth() {}, closeAuth() {}, retryNow() {},
    } }, React.createElement(Component))))

check('当前首页默认 rating，三个评测页签保留 URL 状态与键盘入口', () => {
  const html = renderCurrent()
  assert.match(html, /id="benchmark-tab-rating" role="tab" aria-selected="true"/)
  assert.match(html, /role="tabpanel" aria-labelledby="benchmark-tab-rating"/)
  for (const view of ['score', 'rating', 'table']) {
    assert.match(renderCurrent(`/?v=${view}`), new RegExp(`id="benchmark-tab-${view}" role="tab" aria-selected="true"`))
  }
  assert.match(renderCurrent('/?v=unknown'), /id="benchmark-tab-rating" role="tab" aria-selected="true"/)
  const source = srcOf('pages/K4uV2Page.jsx')
  assert.ok(source.includes('ArrowLeft') && source.includes('ArrowRight') && source.includes("event.key === 'End'"))
  assert.ok(source.includes("url.set('v', nextView"))
  assert.ok(!html.includes('benchmark-tab-arena'), '比赛统一由侧栏进入')
})

check('当前 rating 使用加权分与时间线；原始分页保留全部历史记录', () => {
  const rating = renderCurrent()
  const original = renderCurrent('/?v=score')
  assert.ok(rating.includes('<span class="mname">Current-A</span>'))
  assert.ok(!rating.includes('<span class="mname">Old-only</span>'))
  assert.ok(!rating.includes('<span class="mname">No-perf</span>'))
  assert.ok(original.includes('<span class="mname">Old-only</span>'))
  assert.ok(original.includes('<span class="mname">No-perf</span>'))
  // 默认“精简”精度：格内 1 位小数，悬停 title 保留 5 位完整值
  assert.ok(original.includes('>80.0<'))
  assert.ok(original.includes('80.00000 分'))
  assert.ok(!original.includes('>80.00<'))
  assert.ok(rating.includes(weightedRoundScore(80, { timeMs: 1000, memoryMb: 125 }).toFixed(5)))
  const weighted = toV2Dataset(currentSnapshot)
  assert.equal(weighted.records.length, 3)
  assert.equal(weighted.records.find((record) => record.id === 'no-perf').submissions[0].score, null)
  assert.equal(currentSnapshot.records[0].submissions[0].score, 80, '加权转换不能覆盖原始测评分')
})

check('当前 App 保留首页别名、旧链接重定向及全部辅助路由', () => {
  for (const path of ['/', '/v2', '/missing-route']) {
    assert.match(renderCurrent(path, App), /id="benchmark-tab-rating" role="tab" aria-selected="true"/)
  }
  const source = srcOf('App.jsx')
  for (const path of ['/admin', '/users', '/register', '/contributors', '/arena', '/arena/:slug', '/prompts']) {
    assert.ok(source.includes(`path="${path}"`), `${path} 路由丢失`)
  }
  assert.match(source, /path="\/old" element=\{<Navigate to="\/" replace \/>\}/)
  assert.ok(!source.includes('HomePage'), '旧分析页只做组件回归，不重新接回现行路由')
  assert.ok(source.includes('lazy(() => import(') && source.includes('<Suspense'))
})

check('数值精度偏好：默认精简 1 位，完整模式恢复原始分 2 位 / 加权分 5 位', () => {
  assert.equal(scoreDigits(normUiPrefs(null), 5), 1)
  assert.equal(scoreDigits(normUiPrefs({ precision: 'full' }), 2), 2)
  assert.equal(scoreDigits(normUiPrefs({ precision: 'full' }), 5), 5)
  assert.equal(normUiPrefs({ precision: 'weird' }).precision, 'compact')
  assert.ok(srcOf('components/SettingsDialog.jsx').includes('数值精度'))
})

check('当前评分页不重复拉数据，rating 只通过后台增量 hook 计算', () => {
  const page = srcOf('pages/K4uV2Page.jsx')
  const matrix = srcOf('views/MatrixView.jsx')
  assert.ok(page.includes('const source = app.data'))
  assert.ok(!page.includes("api('/api/data')"), '首页应共享全局数据与刷新协调器')
  assert.ok(matrix.includes('useIncrementalRating'))
  assert.ok(!matrix.includes('arenaRating('), 'BT/bootstrap 不能回到渲染线程')
  assert.ok(matrix.includes('cachePublic: publicDefault') && matrix.includes('epoch: data.epoch'))
  assert.ok(matrix.includes('requestAnimationFrame'))
  assert.ok(matrix.includes('visibleProblems.map') && !matrix.includes('VirtualRows'), '矩阵必须按所有可见题目自然展开')
})

check('公共离线缓存采用 schema 4，拒绝旧 schema', async () => {
  const { useApp } = await import('../src/state.jsx')
  // eslint-disable-next-line react/only-export-components -- Node SSR test probe.
  function CacheProbe() { return React.createElement('output', null, useApp().data.records.length) }
  const renderCache = () => renderToString(React.createElement(AppProvider, null, React.createElement(CacheProbe)))
  const previous = store.get('radar.cache.v3')
  try {
    store.set('radar.cache.v3', JSON.stringify({ ...snapshot, cacheSchema: undefined }))
    assert.equal(renderCache(), '<output>0</output>')
    assert.equal(store.has('radar.cache.v3'), false)
    store.set('radar.cache.v3', raw)
    assert.equal(renderCache(), `<output>${snapshot.records.length}</output>`)
  } finally { store.set('radar.cache.v3', previous) }
  assert.ok(stateText.includes('cacheSchema: 4') && stateText.includes("record.status === 'approved'"))
})

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
