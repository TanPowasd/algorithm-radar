/* 生成前端自检样本，两种产物：

   1) selftest/fixture.basic.json —— **纯合成、可提交入库**的最小样本（不含任何真实测评数据），
      只依赖 Node，克隆仓库后无需任何导出文件即可跑 selftest。
   2) selftest/fixture.json —— 从本地导出快照裁剪的**真实**样本（再叠几条合成记录补齐
      思考等级/无分数轮次等口径），已在 .gitignore 里排除，只在本机存在导出快照时生成。

   用法：
     node scripts/make-fixture.mjs            # 生成 (1)，并在有导出快照时顺带生成 (2)
     node scripts/make-fixture.mjs --basic    # 只生成 (1)
     FIXTURE_MAX=40 node scripts/make-fixture.mjs   # 控制真实样本条数
*/
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const BASIC_ONLY = process.argv.includes('--basic')
const outDir = join(here, '..', 'selftest')

/* ---------------------------------------------------------------- *
 * 一、纯合成样本（确定性：固定种子 PRNG，重复运行结果一致）
 * ---------------------------------------------------------------- */

// mulberry32
const rng = (seed) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const rand = rng(20260903)
const pick = (arr) => arr[Math.floor(rand() * arr.length) % arr.length]

const LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
const RESULTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', '未解出']

/** 6 家厂商 × 12 个模型：刻意让同厂商有多个模型，用来验证「同厂商同色相」 */
const VENDOR_MODELS = [
  ['DeepSeek', ['deepseek-v4-flash', 'deepseek-v4-pro']],
  ['OpenAI', ['chatgpt-5.6luna', 'chatgpt-5.6sol']],
  ['Anthropic', ['opus-5']],
  ['Google', ['gemini-3.7-flash']],
  ['阿里云', ['qwen-3.8-max', 'qwen-3.8-27b']],
  ['智谱', ['glm-5.3', 'glm-5.3-flash']],
  ['月之暗面', ['kimi-k3']],
  ['字节跳动', ['doubao-fast-web']],
  ['xAI', ['grok4.6']],
  ['美团', ['longcat-2']],
]
const MODELS = VENDOR_MODELS.flatMap(([, ms]) => ms)
const PROBLEMS = [
  ['P1001', 'A+B Problem', 1, ['模拟']],
  ['P1046', '陶陶摘苹果', 2, ['模拟', '数组']],
  ['P2671', '求和', 3, ['前缀和', '字符串']],
  ['P1090', '合并果子', 4, ['贪心', '堆']],
  ['P1776', '宝物筛选', 5, ['DP', '背包']],
  ['P4779', '单源最短路', 6, ['图论', 'Dijkstra']],
]
const DATES = ['2026-07-02', '2026-07-09', '2026-07-16', '2026-07-23', '2026-08-06', '2026-08-20']

const basicRecords = []
let seq = 1
const pushRecord = (r) => {
  const id = `selftest-${String(seq++).padStart(3, '0')}`
  basicRecords.push({
    id,
    model: r.model,
    variant: '',
    agent: pick(['通用对话', 'Claude Code', '自建 Agent', 'CLI']),
    tokenSource: pick(['官方', 'API', '套餐']),
    pid: r.pid,
    title: r.title,
    thinking: r.thinking,
    difficulty: r.difficulty,
    categories: r.categories,
    submissions: r.submissions,
    minutes: 10 + Math.floor(rand() * 80),
    memory: [null, 64, 128, 256][Math.floor(rand() * 4)],
    date: r.date,
    note: '自检合成数据（非真实测评）',
    status: 'approved',
    author: 'selftest',
    authorId: null,
    reviewerId: null,
    reviewedAt: null,
    deletedAt: null,
    // 同一天的记录也给不同的录入时分，滚榜才有可分辨的时序
    createdAt: `${r.date}T${String(6 + (seq % 16)).padStart(2, '0')}:${String((seq * 7) % 60).padStart(2, '0')}:00.000Z`,
    updatedAt: `${r.date}T${String(6 + (seq % 16)).padStart(2, '0')}:${String((seq * 7) % 60).padStart(2, '0')}:00.000Z`,
  })
}

for (const [pid, title, difficulty, categories] of PROBLEMS) {
  for (const model of MODELS) {
    // 每个「模型 × 题目」出 0–2 个思考等级（覆盖最佳等级 / 最佳分数两口径的差异）
    const n = Math.floor(rand() * 3)
    if (n === 0) continue
    const levels = [...LEVELS].sort(() => rand() - 0.5).slice(0, n)
    for (const thinking of levels) {
      const rounds = []
      const total = 1 + Math.floor(rand() * 3)
      for (let i = 0; i < total; i += 1) {
        const nullRound = rand() < 0.14 // 无分数轮次：必须不参与均分、不按 0 计
        const ac = !nullRound && i === total - 1 && rand() < 0.42
        rounds.push({
          score: nullRound ? null : ac ? 100 : Math.floor(rand() * 92),
          result: nullRound ? 'CE' : ac ? 'AC' : pick(RESULTS.filter((x) => x !== 'AC')),
          ...(nullRound ? { note: '自检：编译错误，无分数' } : {}),
        })
      }
      pushRecord({ model, pid, title, difficulty, categories, thinking, submissions: rounds, date: pick(DATES) })
    }
  }
}
// 一条待审记录 + 一条未收录模型的记录，确认自检只统计已审核可见数据
pushRecord({
  model: MODELS[0], pid: PROBLEMS[0][0], title: PROBLEMS[0][1], difficulty: 1,
  categories: PROBLEMS[0][3], thinking: 'low', submissions: [{ score: 60, result: 'WA' }], date: DATES[0],
})
basicRecords[basicRecords.length - 1].status = 'pending'

const basicFixture = {
  problems: Object.fromEntries(PROBLEMS.map(([pid, title, difficulty, tags]) => [pid, {
    pid,
    title,
    difficulty,
    tags,
    prompt: `【自检合成】请独立作答 ${pid}：只输出一段完整可提交的 C++17 代码（\`\`\`cpp 代码块），不要解释、不要伪码。`,
    manual: true,
    fetchedAt: null,
  }])),
  records: basicRecords,
  models: MODELS.map((name, i) => ({
    id: `m-${i}`, name, vendor: VENDOR_MODELS.find(([, ms]) => ms.includes(name))[0], note: '', createdAt: '2026-07-01T00:00:00.000Z',
  })),
  updatedAt: '2026-09-03T00:00:00.000Z',
  _note: '纯合成样本：无真实测评数据，可提交入库。由 scripts/make-fixture.mjs 生成（固定种子，可复现）',
}

const writeJson = (name, obj) => {
  const dest = join(outDir, name)
  // 压成单行：样本体积减半，且 diff 时一眼看出是哪份文件变了
  writeFileSync(dest, JSON.stringify(obj), 'utf8')
  return dest
}

const basicPath = writeJson('fixture.basic.json', basicFixture)
console.log(`[基本样本] ${basicFixture.records.length} 条（含 1 条待审） · ${PROBLEMS.length} 题 · ${MODELS.length} 模型 · ${DATES.length} 日期`)
console.log(`→ ${basicPath}`)

if (BASIC_ONLY) process.exit(0)

/* ---------------------------------------------------------------- *
 * 二、真实样本（裁剪本地导出快照；产物不入库）
 * ---------------------------------------------------------------- */
const findSource = () => {
  const arg = process.argv[2]
  if (arg && existsSync(arg)) return arg
  const cand = readdirSync(root).filter((f) => /^算法雷达站数据_.*\.json$/.test(f)).sort()
  return cand.length ? join(root, cand[cand.length - 1]) : null
}

const src = findSource()
if (!src) {
  console.log('\n未找到仓库根的 算法雷达站数据_*.json，跳过真实样本生成（selftest 会用上面的基本样本）。')
  process.exit(0)
}

const snap = JSON.parse(readFileSync(src, 'utf8'))
const approved = (snap.records || []).filter((r) => r.status === 'approved')

/** 贪心覆盖：每次挑「补齐最多缺失维度」的一条记录 */
const seenModel = new Set()
const seenVendor = new Set()
const seenPid = new Set()
const seenPair = new Set()
const seenLevel = new Set()
const dates = new Set()
const chosen = []
const pool = [...approved]
const TARGET = Number(process.env.FIXTURE_MAX || 48)

const vendorKey = (m) => (String(m).split(/[-_.\s]/)[0] || '').toLowerCase()
const gain = (r) => {
  let g = 0
  if (!seenModel.has(r.model)) g += 8
  if (!seenPid.has(r.pid)) g += 6
  if (!seenPair.has(`${r.model}|${r.pid}`)) g += 5
  if (!seenLevel.has(`${r.model}|${r.thinking}`)) g += 4
  if (!dates.has(r.date)) g += 3
  if (!seenVendor.has(vendorKey(r.model))) g += 3
  if (r.submissions?.at(-1)?.result === 'AC') g += 2
  if ((r.submissions || []).some((s) => s.score === null || s.score === undefined)) g += 2
  return g
}

while (pool.length && chosen.length < TARGET) {
  let bi = 0
  let bg = -1
  for (let i = 0; i < pool.length; i += 1) {
    const g = gain(pool[i])
    if (g > bg) { bg = g; bi = i }
  }
  if (bg <= 0) break
  const r = pool.splice(bi, 1)[0]
  chosen.push(r)
  seenModel.add(r.model)
  seenPid.add(r.pid)
  seenPair.add(`${r.model}|${r.pid}`)
  seenLevel.add(`${r.model}|${r.thinking}`)
  dates.add(r.date)
  seenVendor.add(vendorKey(r.model))
}

/**
 * 本地快照里思考等级几乎全是 max，两口径与等级纹理都测不出来 → 追加几条明确标注的合成记录。
 * 只进 fixture.json（不入库），不改任何真实数据。
 */
const syntheticCoverage = (real) => {
  const models = [...new Set(real.map((r) => r.model))].sort()
  const pids = [...new Set(real.map((r) => r.pid))].sort()
  const [m1, m2] = [models[0], models[1] || models[0]]
  const [p1, p2] = [pids[0], pids[1] || pids[0]]
  const mk = (id, model, pid, thinking, subs, date) => ({
    id, model, variant: '', agent: 'selftest', tokenSource: '官方',
    pid, title: snap.problems?.[pid]?.title || '', thinking,
    difficulty: snap.problems?.[pid]?.difficulty ?? 3, categories: ['自检合成'],
    submissions: subs, minutes: 30, memory: 128, date,
    note: '自检合成数据（非真实测评）',
    status: 'approved', author: 'selftest', authorId: null,
    reviewerId: null, reviewedAt: null, deletedAt: null,
    createdAt: `${date}T07:${String(parseInt(id.slice(-1), 10) * 7 % 60).padStart(2, '0')}:00.000Z`,
    updatedAt: `${date}T07:30:00.000Z`,
  })
  return [
    // 同题同模型、最高等级反而分更低 → 「最佳等级」与「最佳分数」必然不同
    mk('selftest-r1', m1, p1, 'low', [{ score: 40, result: 'WA' }], '2026-06-01'),
    mk('selftest-r2', m1, p1, 'medium', [{ score: 65, result: 'WA' }], '2026-06-02'),
    mk('selftest-r3', m1, p1, 'high', [{ score: 88, result: 'WA' }], '2026-06-03'),
    mk('selftest-r4', m1, p1, 'max', [{ score: 70, result: 'WA' }], '2026-06-04'),
    // 无分数轮次 + 最终 AC
    mk('selftest-r5', m2, p2, 'ultra', [{ score: null, result: 'CE' }, { score: 100, result: 'AC' }], '2026-06-05'),
    mk('selftest-r6', m2, p2, 'xhigh', [{ score: 55, result: 'TLE' }], '2026-06-06'),
    mk('selftest-r7', m2, p1, 'off', [{ score: 0, result: '放弃' }], '2026-06-07'),
  ]
}

const all = [...chosen, ...syntheticCoverage(chosen)]

/** 再补几条「待审核」记录：自检要能验证统计/滚榜把未审核数据挡在外面 */
const pendingSource = (snap.records || []).filter((r) => r.status === 'pending')
const pendings = (pendingSource.length ? pendingSource.slice(0, 3) : chosen.slice(0, 2).map((r, i) => r)).map((r, i) => ({
  ...r,
  id: pendingSource.length ? r.id : `selftest-p${i + 1}`,
  status: 'pending',
  ...(pendingSource.length ? {} : { note: '自检合成：待审核记录' }),
}))

all.sort((a, b) => String(a.createdAt || a.date).localeCompare(String(b.createdAt || b.date)))

const usedPids = new Set([...all, ...pendings].map((r) => r.pid))
const problems = {}
for (const pid of usedPids) {
  const p = snap.problems?.[pid]
  if (p) problems[pid] = { ...p, prompt: p.prompt || `【自检样本】请独立作答 ${pid}，只输出一个完整可提交的 C++17 代码块。` }
}

const realPath = writeJson('fixture.json', {
  problems,
  records: [...all, ...pendings],
  models: (snap.models || []).filter((m) => chosen.some((r) => r.model === m.name)),
  updatedAt: snap.updatedAt,
  _note: '真实记录（裁剪）+ 标注为合成的补充/待审记录；由本地导出快照生成，含真实数据，故不入库',
})
console.log(`\n[真实样本] 源 ${src}`)
console.log(`真实 ${chosen.length}/${approved.length} + 合成 ${all.length - chosen.length} + 待审 ${pendings.length} = ${all.length + pendings.length} 条 · ${usedPids.size} 题 · ${seenModel.size} 模型 · ${dates.size} 日期`)
console.log(`→ ${realPath}（.gitignore 已排除，勿提交）`)
