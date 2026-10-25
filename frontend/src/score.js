/**
 * 加权分与多轮轨迹评分模型（v2）—— 全站唯一算分实现。
 *
 * 三层正交数学模型：
 *
 * 1) 单轮基础正确性效用 Q(S)：
 *      x = clamp(S, 0, 100) / 100
 *      rawWeight(S) = x^2，Q(S) = S · x^2 = 100 · x^3
 *      → 100 分 → 100、90 分 → 72.9、80 分 → 51.2、60 分 → 21.6、0 分 → 0
 *      三次凸效用既拉开高分子任务难度梯度，又避免过陡幂律在低分段坍缩。
 *
 * 2) 题限自适应对称对数 Hill 因子 + 正确率门控效能 E(S, t, m | P)：
 *      参考时间 T_ref = problem.timeLimit > 0 ? problem.timeLimit : 1000ms
 *      参考内存 M_ref = problem.memoryLimit > 0 ? 0.25 · problem.memoryLimit : 125MB
 *      （缺省或标准 1000ms / 500MB 题目精确退化为 1000ms / 125MB 基准点）
 *
 *      wt(t | P) = 0.75 + 0.50 / (1 + (t / T_ref)^K)  ∈ (0.75, 1.25)，t = T_ref 时 = 1
 *      ws(m | P) = 0.88 + 0.24 / (1 + (m / M_ref)^K)  ∈ (0.88, 1.12)，m = M_ref 时 = 1
 *      其中 K = 1（对数尺度双曲正切 1 ± Δ·(1-r)/(1+r)，避免多测试点总耗时在尾部坍缩）。
 *
 *      合成原始效能 φ = wt · ws ∈ (0.66, 1.40)，按正确率门控速度/内存奖励（反「子任务快死」）：
 *        E(S, φ) = φ > 1 ? 1 + (φ - 1) · x^2 : φ
 *      单轮加权分 u_k = Q(S_k) · E(S_k, φ_k)（保留 5 位小数；缺分数/时间/内存返回 null）。
 *      严格保底定理：inf u(100, t, m) = 66.00 > sup u(80, t, m) = 64.31，
 *      任何合法 100 分 AC 数学上严格高于任何 ≤80 分的秒退部分分提交。
 *
 * 3) 多轮提交轨迹泛函 V(u_1, …, u_n) —— 随机交互预算期望最优解 / 边际突破折现模型：
 *      记截至第 k 轮的历史极值包络 B_k = max(B_{k-1}, u_k)（B_0 = 0；u_k 为 null 时 B_k = B_{k-1}，
 *      但真实轮次下标 k 照常递增，防止首轮留空规避轮次折现）。
 *      在几何交互耐心分布 K ~ Geom(1 - γ)（γ = ROUND_DECAY = 0.85）下，期望最优解等价于：
 *        V(u_1, …, u_n) = Σ_{k=1..n} γ^(k-1) · (B_k - B_{k-1})
 *      性质：
 *        · 单轮恒等：V([u_1]) = u_1；
 *        · 轮次与首轮部分分敏感：[100] > [90, 100] > [60, 100] > [0, 100] > [0, 0, 100]；
 *        · 无悔单调性（激励相容）：追加第 n+1 轮恒有 ΔV ≥ 0，修好 Bug 或二轮提速必不倒扣分。
 *
 * 4) 整体能力天梯分（rating 首行）—— 连续准 Rasch / 1PL 项目反应理论（Quasi-Rasch IRT）：
 *      将有界轨迹综合分 V_{m,p} ∈ [0, V_sup)（V_sup = 100 · TIME_W_MAX · MEM_W_MAX = 140）
 *      经边界拉普拉斯平滑映射为归一化掌握度：
 *        y_{m,p} = (clamp(V_{m,p}, 0, V_sup) + τ_y) / (V_sup + 2τ_y) ∈ (0, 1)，τ_y = 1
 *      对有效参评题目（至少 2 个模型有分，即存在跨模型可比性）联合估计模型潜能力 θ_m 与题目潜难度 β_p：
 *        E[y_{m,p}] = σ(θ_m - β_p) = 1 / (1 + e^{-(θ_m - β_p)})
 *      最小化严格凸惩罚负准对数后验（OI 多子任务实测等效伯努利精度 κ = 4.5，先验精度 τ_0 = 1.5 ⇒ λ_θ = τ_0 / κ = 1/3）：
 *        J(θ, β) = Σ_{(m,p)∈Ω} w_{m,p} [ln(1 + e^{θ_m - β_p}) - y_{m,p}(θ_m - β_p)] + (λ_θ / 2) Σ_m θ_m^2
 *      由一阶最优性条件自然导出 Σ_m θ_m* ≡ 0，全体模型算术均值精确锚定 1000 分：
 *        R_m = 1000 + (400 / ln 10) · θ_m，D_p = 1000 + (400 / ln 10) · β_p
 *      置信区间采用「随机化先验自举（Randomized-Prior Bootstrap）」：重采样单元格计数并同步抽样先验靶点
 *      θ_{m,0}^{(b)} ~ N(0, τ_0^{-1})，在小样本端精确退化为贝叶斯后验方差 (τ_0 + I_m)^{-1}，在大样本端渐近收敛于
 *      Huber-White 稳健三明治方差；参评可比题目数 < 5 题标记「样本少」。
 *
 * 列表 / 矩阵 / 详情 / 统计 / 排名一律 import 本文件，不要再写第二份算分逻辑。
 */

/** v2 只使用这个时刻之后创建的数据（北京时间 2026-09-05 21:19 = 13:19Z） */
export const V2_CUTOFF_ISO = '2026-09-05T13:19:00Z'

/** 对数 Hill 曲线陡度 K = 1：多测试点耗时跨两个数量级仍保持平滑梯度 */
export const WEIGHT_K = 1
/** 原始分权重的指数 = 2（即基础效用 Q(S) = S · (S/100)^2 = 100 · (S/100)^3） */
export const RAW_W_EXP = 2
/** 速度/内存加成（φ > 1）的正确率门控指数：按 (S/100)^2 缩放奖励，防止低分快死反超 */
export const EFF_GATE_EXP = 2
/** 时间权重值域上下限（开区间，关于 1.0 对称） */
export const TIME_W_MAX = 1.25
export const TIME_W_MIN = 0.75
/** 空间权重值域上下限（开区间，关于 1.0 对称） */
export const MEM_W_MAX = 1.12
export const MEM_W_MIN = 0.88
/** 缺省时间参考基准：1000ms 处权重恰好 1 */
export const TIME_ANCHOR_MS = 1000
/** 缺省内存参考基准：125MB 处权重恰好 1（对应标准 500MB 题限的 25%） */
export const MEM_ANCHOR_MB = 125
/** 有题目内存限制时的中性参考比例：使用题限 25% 内存时权重恰好 = 1 */
export const MEM_LIMIT_RATIO = 0.25
/** 多轮边际突破折现率 γ：第 k 轮刷新历史最佳的增量乘 γ^(k-1) */
export const ROUND_DECAY = 0.85
/** 对局胜势率平滑常数 τ：P(A > B) = (a + τ) / (a + b + 2τ)，保证零点光滑连续 */
export const ARENA_OUTCOME_TAU = 2

const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 题目时间参考锚点（ms）：优先取题目 timeLimit，缺失时回退 1000ms */
export function timeAnchorMs(problem) {
  const limit = toNum(problem && problem.timeLimit)
  return limit !== null && limit > 0 ? limit : TIME_ANCHOR_MS
}

/** 题目空间参考锚点（MB）：优先取题目 memoryLimit 的 25%，缺失时回退 125MB */
export function memoryAnchorMb(problem) {
  const limit = toNum(problem && problem.memoryLimit)
  return limit !== null && limit > 0 ? limit * MEM_LIMIT_RATIO : MEM_ANCHOR_MB
}

/**
 * 时间权重：(0, +∞) → (0.75, 1.25) 的开区间单调递减曲线，参考锚点处恰好 = 1。
 * 缺值或非正数返回 null（不当作 1）。
 */
export function timeWeight(timeMs, problem) {
  const t = toNum(timeMs)
  if (t === null || t <= 0) return null
  const anchor = timeAnchorMs(problem)
  const t0 = anchor * Math.pow((1 - TIME_W_MIN) / (TIME_W_MAX - 1), 1 / WEIGHT_K)
  return TIME_W_MIN + (TIME_W_MAX - TIME_W_MIN) / (1 + (t / t0) ** WEIGHT_K)
}

/**
 * 空间权重：(0, +∞) → (0.88, 1.12) 的开区间单调递减曲线，参考锚点处恰好 = 1。
 * 缺值或非正数返回 null。
 */
export function memoryWeight(memoryMb, problem) {
  const m = toNum(memoryMb)
  if (m === null || m <= 0) return null
  const anchor = memoryAnchorMb(problem)
  const m0 = anchor * Math.pow((1 - MEM_W_MIN) / (MEM_W_MAX - 1), 1 / WEIGHT_K)
  return MEM_W_MIN + (MEM_W_MAX - MEM_W_MIN) / (1 + (m / m0) ** WEIGHT_K)
}

/** 原始分权重 = (clamp(原始分, 0, 100) / 100)^2；100 分 → 1，0 分 → 0 */
export function rawWeight(rawScore) {
  const r = toNum(rawScore)
  if (r === null) return null
  const clamped = Math.max(0, Math.min(100, r))
  return Math.pow(clamped / 100, RAW_W_EXP)
}

/**
 * 正确率门控效能因子：超限惩罚（φ ≤ 1）原样保留，快/省加成（φ > 1）按 (S/100)^2 门控。
 * 缺时间/内存或分数时返回 null。
 */
export function efficiencyWeight(rawScore, sub, problem) {
  const r = toNum(rawScore)
  if (r === null) return null
  const wt = timeWeight(sub && sub.timeMs, problem)
  const ws = memoryWeight(sub && sub.memoryMb, problem)
  if (wt === null || ws === null) return null
  const phi = wt * ws
  const x = Math.max(0, Math.min(100, r)) / 100
  return phi > 1 ? 1 + (phi - 1) * Math.pow(x, EFF_GATE_EXP) : phi
}

/**
 * 单轮加权分 = clamp(洛谷测评分, 0, 100) × 原始分权重 × 门控效能因子。
 * @param rawScore 该轮洛谷测评分；null/空 → 返回 null
 * @param sub      该轮提交 { timeMs, memoryMb }
 * @param problem  该题 { timeLimit, memoryLimit }（可选，缺失时回退 1000ms / 125MB）
 * @returns number（≥ 0，5 位小数）或 null（数据不全 → 页面留空）
 */
export function weightedRoundScore(rawScore, sub, problem) {
  const r = toNum(rawScore)
  if (r === null) return null
  const s = Math.max(0, Math.min(100, r))
  const rw = rawWeight(s)
  const eff = efficiencyWeight(s, sub, problem)
  if (rw === null || eff === null) return null
  return Math.round(Math.max(0, s * rw * eff) * 1e5) / 1e5
}

/** 第 k 轮（0-based 下标 roundIndex = k - 1）的边际突破折现系数 γ^(k-1) */
export function roundDiscount(roundIndex, decay = ROUND_DECAY) {
  const idx = Math.max(0, Math.trunc(toNum(roundIndex) ?? 0))
  const d = toNum(decay) ?? ROUND_DECAY
  return Math.pow(Math.max(0, Math.min(1, d)), idx)
}

/**
 * 多轮提交轨迹综合分（边际突破折现 / 随机预算期望 Pass@k）：
 *   V(u_1, …, u_n) = Σ_{k=1..n} γ^(k-1) · max(0, u_k - B_{k-1})
 * - 全部轮次都无有效分（null/undefined）时返回 null（严守空分留空铁律）；
 * - 中间空分轮次不破坏前序最高分 B_{k-1}，但真实轮次下标照常递增（防止首轮留空套取 γ^0=1）。
 */
export function trajectoryScore(roundValues, opts = {}) {
  const arr = Array.isArray(roundValues) ? roundValues : []
  const decay = toNum(opts && opts.decay) ?? ROUND_DECAY
  let hasValid = false
  let best = 0
  let total = 0
  for (let i = 0; i < arr.length; i++) {
    const u = toNum(arr[i])
    if (u === null || u < 0) continue
    hasValid = true
    if (u > best) {
      total += roundDiscount(i, decay) * (u - best)
      best = u
    }
  }
  return hasValid ? Math.round(total * 1e5) / 1e5 : null
}

/* ============ 整体分：连续准 Rasch / 1PL 项目反应理论（Quasi-Rasch IRT） ============
 * 将每道有效可比题（同题 ≥2 个模型有分）的轨迹综合分 V_{m,p} ∈ [0, 140) 映射为有界掌握度 y_{m,p} ∈ (0, 1)，
 * 联合估计模型潜能力 θ_m 与题目潜难度 β_p：E[y_{m,p}] = 1 / (1 + e^{-(θ_m - β_p)})。
 * 相比旧版两两比值 Bradley-Terry：
 *   1) 消除简单题天花板压缩（P1335 等高分题 134 vs 107 在对数几率空间保持真实差距，不再倒扣强模型）；
 *   2) 消除缺测与只测难题的幸存者偏差（显式剥离题目难度 β_p）；
 *   3) 消除热门题 O(n_p - 1) 权重膨胀，每题每模型等权贡献准似然信息；
 *   4) 采用随机化先验自举（Randomized-Prior Bootstrap），小样本模型置信区间真实反映先验不确定性。
 */
export const RATING_ANCHOR = 1000
export const RATING_SCALE = 400
/** 理论单格分数上确界 V_sup = 100 · TIME_W_MAX · MEM_W_MAX = 140 */
export const RATING_SCORE_CAP = Math.round(100 * TIME_W_MAX * MEM_W_MAX * 1e6) / 1e6
/** 归一化掌握度边界平滑常数 τ_y = 1（分）：y = (clamp(V, 0, 140) + 1) / 142 ∈ (0, 1) */
export const RATING_SCORE_TAU = 1
/** OI 多子任务实测准伯努利精度乘子 κ（k4u.top 实测 Pearson/Deviance 等效 4.33~4.75） */
export const RATING_QUASI_KAPPA = 4.5
/** 模型潜能力高斯先验精度 τ_0（nats^-2，对应先验标准差 ≈ 141.8 Elo） */
export const RATING_PRIOR_TAU = 1.5
/** 归一化单题目标函数中的等效先验惩罚系数 λ_θ = τ_0 / κ = 1/3 */
export const RATING_PRIOR_LAMBDA = RATING_PRIOR_TAU / RATING_QUASI_KAPPA
export const RATING_BOOTSTRAP = 200
/** 正式榜最低有效可比题数门槛：少于 5 题标记「样本少」 */
export const RATING_MIN_PROBLEMS = 5

export const ARENA_ANCHOR = RATING_ANCHOR
export const ARENA_SCALE = RATING_SCALE
export const ARENA_PRIOR_GAMES = 0.3
export const ARENA_BOOTSTRAP = RATING_BOOTSTRAP
export const ARENA_MIN_GAMES = 10
/** 分差加权（Margin-of-Victory）：兼容保留旧对局辅助接口 */
export const ARENA_MARGIN_OF_VICTORY = true

const sigmoid = (z) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))

/** Deterministic bootstrap draws; callers can keep the same sample across edits. */
export function arenaRandom(seed = 1) {
  let state = 2166136261
  for (const c of String(seed)) state = Math.imul(state ^ c.charCodeAt(0), 16777619)
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic Box-Muller standard normal draw N(0, 1) for randomized-prior bootstrap. */
export function arenaGaussian(random = Math.random) {
  const u1 = Math.max(1e-12, Math.min(1 - 1e-12, random()))
  const u2 = random()
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
}

/** 将单元格综合分 V ∈ [0, cap] 平滑映射为开区间归一化掌握度 y ∈ (0, 1) */
export function ratingNormalizedScore(score, cap = RATING_SCORE_CAP, tau = RATING_SCORE_TAU) {
  const s = toNum(score)
  if (s === null) return null
  const upper = Math.max(1e-6, toNum(cap) ?? RATING_SCORE_CAP)
  const smooth = Math.max(0, toNum(tau) ?? RATING_SCORE_TAU)
  const clamped = Math.max(0, Math.min(upper, s))
  if (smooth > 0) return (clamped + smooth) / (upper + 2 * smooth)
  return Math.max(1e-6, Math.min(1 - 1e-6, clamped / upper))
}

export function emptyIrtStats() {
  return { problems: new Map(), models: new Map(), cells: 0 }
}

/**
 * 幂等设置单个 (pid, model) 观测格的权重与归一化掌握度（零浮点累减漂移）。
 * weight <= 0 或 cell 为空时自动移除该格并清理空键。
 */
export function setIrtCell(stats, cell, weight = 1) {
  if (!cell) return
  const { pid, model } = cell
  const byModel = stats.problems.get(pid)
  const prev = byModel?.get(model)
  if (prev) {
    const mStat = stats.models.get(model)
    if (mStat) {
      mStat.problems -= 1
      mStat.weight -= prev.w
      mStat.wy -= prev.w * prev.y
      if (mStat.problems <= 0) stats.models.delete(model)
    }
    byModel.delete(model)
    stats.cells -= 1
    if (!byModel.size) stats.problems.delete(pid)
  }
  const w = toNum(weight) ?? 0
  const y = toNum(cell.y) ?? ratingNormalizedScore(cell.score)
  if (w > 0 && y !== null) {
    let nextByModel = stats.problems.get(pid)
    if (!nextByModel) { nextByModel = new Map(); stats.problems.set(pid, nextByModel) }
    nextByModel.set(model, { w, y })
    stats.cells += 1
    let mStat = stats.models.get(model)
    if (!mStat) { mStat = { problems: 0, weight: 0, wy: 0 }; stats.models.set(model, mStat) }
    mStat.problems += 1
    mStat.weight += w
    mStat.wy += w * y
  }
}

/** 由观测单元格列表构建有效可比题（同题 ≥2 模型）的 IRT 充分统计量 */
export function irtStats(cells, opts = {}) {
  const grouped = new Map()
  for (const item of cells || []) {
    if (!item || !item.model || !item.pid) continue
    const w = toNum(item.weight) ?? 1
    if (!(w > 0)) continue
    const y = toNum(item.y) ?? ratingNormalizedScore(item.score, opts.cap, opts.tau)
    if (y === null) continue
    let byModel = grouped.get(item.pid)
    if (!byModel) { byModel = new Map(); grouped.set(item.pid, byModel) }
    const prev = byModel.get(item.model)
    if (prev) {
      const nextW = prev.w + w
      prev.y = (prev.y * prev.w + y * w) / nextW
      prev.w = nextW
    } else {
      byModel.set(item.model, { w, y })
    }
  }
  const stats = emptyIrtStats()
  for (const [pid, byModel] of grouped) {
    if (byModel.size < 2) continue
    for (const [model, entry] of byModel) setIrtCell(stats, { pid, model, y: entry.y }, entry.w)
  }
  return stats
}

/**
 * 可中断分批推进的连续准 Rasch / 1PL IRT 阻尼牛顿求解器。
 * 严格凸目标函数保证任意初值（含极端热启动与非连通子图）收敛至唯一全局最优解，且全体算术均值精确等于 anchor。
 */
export function createIrtSolver(players, stats, opts = {}) {
  const list = [...new Set(players || [])].sort()
  const M = list.length
  const mIndex = new Map(list.map((model, i) => [model, i]))
  const anchor = toNum(opts.anchor) ?? RATING_ANCHOR
  const scale = toNum(opts.scale) ?? RATING_SCALE
  const eloPerNat = scale / Math.LN10
  const kappa = Math.max(1e-6, toNum(opts.kappa) ?? RATING_QUASI_KAPPA)
  const priorTau = Math.max(1e-6, toNum(opts.priorTau) ?? RATING_PRIOR_TAU)
  const prior = Math.max(1e-6, toNum(opts.prior) ?? (priorTau / kappa))
  const tolerance = toNum(opts.tolerance) ?? 0.0001
  const stableRounds = toNum(opts.stableRounds) ?? 3
  const maxIterations = toNum(opts.maxIterations) ?? 10000

  const pids = []
  const pCells = []
  const mCells = Array.from({ length: M }, () => [])
  for (const pid of [...(stats?.problems?.keys() || [])].sort()) {
    const arr = []
    for (const [model, entry] of stats.problems.get(pid)) {
      const mi = mIndex.get(model)
      if (mi === undefined || !(entry?.w > 0) || !Number.isFinite(entry.y)) continue
      arr.push(mi, Math.max(1e-6, Math.min(1 - 1e-6, entry.y)), entry.w)
    }
    if (arr.length < 6) continue
    const pi = pids.length
    pids.push(pid)
    pCells.push(arr)
    for (let k = 0; k < arr.length; k += 3) mCells[arr[k]].push(pi, arr[k + 1], arr[k + 2])
  }
  const P = pids.length

  const targets = new Float64Array(M)
  if (opts.priorTargets && M > 0) {
    let sumP = 0
    for (let i = 0; i < M; i++) {
      const raw = opts.priorTargets instanceof Map ? opts.priorTargets.get(list[i]) : opts.priorTargets[i]
      const val = toNum(raw) ?? 0
      targets[i] = val
      sumP += val
    }
    const meanP = sumP / M
    for (let i = 0; i < M; i++) targets[i] -= meanP
  }

  const theta = Float64Array.from(list, (model) => {
    const value = opts.initialStrengths?.get(model)
    return Number.isFinite(value) && value > 0 ? Math.max(-15, Math.min(15, Math.log(value))) : 0
  })
  let initShift = 0
  if (M > 0) {
    for (let i = 0; i < M; i++) initShift += theta[i]
    initShift /= M
    for (let i = 0; i < M; i++) theta[i] -= initShift
  }

  const beta = new Float64Array(P)
  for (let pi = 0; pi < P; pi++) {
    const initD = opts.initialDifficulties?.get(pids[pi])
    if (Number.isFinite(initD)) {
      beta[pi] = Math.max(-15, Math.min(15, (initD - anchor) / eloPerNat - initShift))
      continue
    }
    const arr = pCells[pi]
    let wy = 0, ws = 0, wt = 0
    for (let k = 0; k < arr.length; k += 3) {
      wt += arr[k + 2] * theta[arr[k]]
      wy += arr[k + 2] * arr[k + 1]
      ws += arr[k + 2]
    }
    const yb = Math.max(1e-6, Math.min(1 - 1e-6, wy / (ws || 1)))
    beta[pi] = wt / (ws || 1) - Math.log(yb / (1 - yb))
  }

  let iterations = 0, stable = 0, maxDelta = Infinity
  return {
    advance(batch = 32) {
      for (let step = 0; step < batch && iterations < maxIterations && stable < stableRounds; step++) {
        maxDelta = 0
        for (let pi = 0; pi < P; pi++) {
          const arr = pCells[pi]
          const b = beta[pi]
          let g = 0, h = 1e-12
          for (let k = 0; k < arr.length; k += 3) {
            const pr = sigmoid(theta[arr[k]] - b)
            const w = arr[k + 2]
            g += w * (pr - arr[k + 1])
            h += w * pr * (1 - pr)
          }
          const delta = Math.max(-4, Math.min(4, g / h))
          let nb = b + delta
          if (Math.abs(delta) > 0.25) {
            let g2 = 0
            for (let k = 0; k < arr.length; k += 3) g2 += arr[k + 2] * (sigmoid(theta[arr[k]] - nb) - arr[k + 1])
            if (g * g2 < 0 && Math.abs(g2) > Math.abs(g)) nb = 0.5 * (b + nb)
          }
          maxDelta = Math.max(maxDelta, Math.abs(nb - b) * eloPerNat)
          beta[pi] = nb
        }
        let sumT = 0
        for (let mi = 0; mi < M; mi++) {
          const arr = mCells[mi]
          const t = theta[mi]
          let g = -prior * (t - targets[mi]), h = prior
          for (let k = 0; k < arr.length; k += 3) {
            const pr = sigmoid(t - beta[arr[k]])
            const w = arr[k + 2]
            g += w * (arr[k + 1] - pr)
            h += w * pr * (1 - pr)
          }
          const delta = Math.max(-4, Math.min(4, g / h))
          let nt = t + delta
          if (Math.abs(delta) > 0.25) {
            let g2 = -prior * (nt - targets[mi])
            for (let k = 0; k < arr.length; k += 3) g2 += arr[k + 2] * (arr[k + 1] - sigmoid(nt - beta[arr[k]]))
            if (g * g2 < 0 && Math.abs(g2) > Math.abs(g)) nt = 0.5 * (t + nt)
          }
          maxDelta = Math.max(maxDelta, Math.abs(nt - t) * eloPerNat)
          theta[mi] = nt
          sumT += nt
        }
        const meanT = M ? sumT / M : 0
        if (meanT !== 0) {
          for (let mi = 0; mi < M; mi++) theta[mi] -= meanT
          for (let pi = 0; pi < P; pi++) beta[pi] -= meanT
          maxDelta = Math.max(maxDelta, Math.abs(meanT) * eloPerNat)
        }
        iterations++
        stable = maxDelta < tolerance ? stable + 1 : 0
      }
      return this.done
    },
    get done() { return !M || stable >= stableRounds || iterations >= maxIterations },
    get converged() { return !M || stable >= stableRounds },
    get iterations() { return iterations },
    get maxDelta() { return maxDelta },
    strengths() { return new Map(list.map((model, i) => [model, Math.exp(theta[i])])) },
    ratings() { return new Map(list.map((model, i) => [model, anchor + eloPerNat * theta[i]])) },
    difficulties() { return new Map(pids.map((pid, i) => [pid, anchor + eloPerNat * beta[i]])) },
  }
}

/** 同步求解连续准 Rasch IRT 模型，返回各模型天梯分 Map（均值锚定 RATING_ANCHOR） */
export function irtFit(players, statsOrCells, opts = {}) {
  const stats = statsOrCells?.problems instanceof Map ? statsOrCells : irtStats(statsOrCells, opts)
  const solver = createIrtSolver(players, stats, opts)
  while (!solver.done) solver.advance(128)
  if (opts.converge !== false && !solver.converged) {
    throw new Error('Quasi-Rasch IRT did not converge within the iteration limit')
  }
  return solver.ratings()
}

/** 同步完整 IRT 评估（含随机化先验自举 95% 区间与低样本状态），供离线分析与对照测试使用 */
export function irtRating(byProblem, opts = {}) {
  const entries = byProblem instanceof Map ? [...byProblem.entries()] : Object.entries(byProblem || {})
  const cells = []
  for (const [pid, list] of entries) {
    const valid = []
    for (const item of Array.isArray(list) ? list : []) {
      if (!item || !item.model) continue
      const y = ratingNormalizedScore(item.score, opts.cap, opts.tau)
      if (y !== null) valid.push({ pid, model: item.model, score: item.score, y })
    }
    if (valid.length >= 2) cells.push(...valid)
  }
  cells.sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : a.pid < b.pid ? -1 : a.pid > b.pid ? 1 : 0))
  const stats = irtStats(cells, opts)
  const players = [...stats.models.keys()].sort()
  const out = new Map()
  if (!players.length) return out
  const solver = createIrtSolver(players, stats, opts)
  while (!solver.done) solver.advance(128)
  const fit = solver.ratings()
  const initStrengths = solver.strengths()
  const initDiffs = solver.difficulties()
  const boots = toNum(opts.bootstrap) ?? RATING_BOOTSTRAP
  const priorTau = Math.max(1e-6, toNum(opts.priorTau) ?? RATING_PRIOR_TAU)
  const priorStd = 1 / Math.sqrt(priorTau)
  const samples = new Map(players.map((m) => [m, []]))
  const seedBase = opts.seed === undefined ? null : String(opts.seed)
  for (let b = 0; b < boots && cells.length; b++) {
    const random = seedBase === null ? Math.random : arenaRandom(`${seedBase}:${b}`)
    const sampleStats = emptyIrtStats()
    const counts = new Uint32Array(cells.length)
    for (let i = 0; i < cells.length; i++) counts[Math.floor(random() * cells.length)]++
    for (let i = 0; i < cells.length; i++) {
      if (counts[i] > 0) setIrtCell(sampleStats, cells[i], counts[i])
    }
    const priorTargets = Float64Array.from(players, () => arenaGaussian(random) * priorStd)
    const bootSolver = createIrtSolver(players, sampleStats, {
      ...opts, priorTargets, initialStrengths: initStrengths, initialDifficulties: initDiffs,
    })
    while (!bootSolver.done) bootSolver.advance(128)
    const r = bootSolver.ratings()
    for (const m of players) samples.get(m).push(r.get(m))
  }
  const anchor = toNum(opts.anchor) ?? RATING_ANCHOR
  const scale = toNum(opts.scale) ?? RATING_SCALE
  const minProblems = toNum(opts.minProblems) ?? RATING_MIN_PROBLEMS
  for (const m of players) {
    const arr = samples.get(m).slice().sort((x, y) => x - y)
    const lo = arr.length ? arr[Math.floor(arr.length * 0.025)] : null
    const hi = arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.975))] : null
    const mStat = stats.models.get(m)
    const problems = mStat?.problems || 0
    let games = 0
    for (const byModel of stats.problems.values()) {
      if (byModel.has(m)) games += byModel.size - 1
    }
    const share = mStat?.wy || 0
    const rating = fit.get(m)
    const winShare = 1 / (1 + Math.pow(10, -(rating - anchor) / scale))
    const lowSample = problems < minProblems
    out.set(m, {
      rating,
      problems,
      games,
      share,
      avgMastery: problems ? share / problems : null,
      winShare,
      lowSample,
      lo,
      hi,
      status: lowSample ? `样本少(${problems} 题)` : '正式榜',
    })
  }
  return out
}

export function emptyArenaStats() {
  return { wins: new Map(), opponents: new Map(), totals: new Map() }
}

/** Fractional wins and pair counts are sufficient for the existing MM update. */
export function applyArenaGame(stats, game, weight = 1) {
  if (!weight) return
  for (const [model, other, share] of [[game.a, game.b, game.s], [game.b, game.a, 1 - game.s]]) {
    const total = (stats.totals.get(model) || 0) + weight
    stats.totals.set(model, total)
    stats.wins.set(model, (stats.wins.get(model) || 0) + weight * share)
    let opponents = stats.opponents.get(model)
    if (!opponents) { opponents = new Map(); stats.opponents.set(model, opponents) }
    const count = (opponents.get(other) || 0) + weight
    if (count) opponents.set(other, count)
    else opponents.delete(other)
    if (!total) {
      stats.totals.delete(model)
      stats.wins.delete(model)
      stats.opponents.delete(model)
    }
  }
}

export function arenaStats(games) {
  const stats = emptyArenaStats()
  for (const game of games) applyArenaGame(stats, game)
  return stats
}

/** A resumable solver lets the worker yield for cancellation between batches. */
export function createBradleyTerrySolver(players, stats, opts = {}) {
  const list = [...new Set(players)].sort()
  const index = new Map(list.map((model, i) => [model, i]))
  const anchor = toNum(opts.anchor) ?? ARENA_ANCHOR
  const scale = toNum(opts.scale) ?? ARENA_SCALE
  const prior = toNum(opts.prior) ?? ARENA_PRIOR_GAMES
  const tolerance = toNum(opts.tolerance) ?? 0.0001
  const stableRounds = toNum(opts.stableRounds) ?? 3
  const maxIterations = toNum(opts.maxIterations) ?? 10000
  let strength = Float64Array.from(list, (model) => {
    const value = opts.initialStrengths?.get(model)
    return Number.isFinite(value) && value > 0 ? value : 1
  })
  let next = new Float64Array(list.length)
  const wins = Float64Array.from(list, (model) => (stats.wins.get(model) || 0) + prior * 0.5)
  const neighbors = list.map((model) => [...(stats.opponents.get(model) || [])]
    .filter(([other]) => index.has(other)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([other, count]) => [index.get(other), count]))
  const mean = Math.exp(strength.reduce((sum, value) => sum + Math.log(value), 0) / (list.length || 1))
  for (let i = 0; i < strength.length; i++) strength[i] /= mean
  let iterations = 0, stable = 0, maxDelta = Infinity
  return {
    advance(batch = 32) {
      for (let step = 0; step < batch && iterations < maxIterations && stable < stableRounds; step++) {
        let logSum = 0
        for (let i = 0; i < list.length; i++) {
          let denominator = prior / (strength[i] + 1)
          for (const [j, count] of neighbors[i]) denominator += count / (strength[i] + strength[j])
          next[i] = Math.max(1e-12, denominator > 0 ? wins[i] / denominator : strength[i])
          logSum += Math.log(next[i])
        }
        const geometricMean = Math.exp(logSum / (list.length || 1)) || 1
        maxDelta = 0
        for (let i = 0; i < list.length; i++) {
          next[i] /= geometricMean
          maxDelta = Math.max(maxDelta, Math.abs(scale * Math.log10(next[i] / strength[i])))
        }
        const previous = strength; strength = next; next = previous
        iterations++
        stable = maxDelta < tolerance ? stable + 1 : 0
      }
      return this.done
    },
    get done() { return !list.length || stable >= stableRounds || iterations >= maxIterations },
    get converged() { return !list.length || stable >= stableRounds },
    get iterations() { return iterations },
    get maxDelta() { return maxDelta },
    strengths() { return new Map(list.map((model, i) => [model, strength[i]])) },
    ratings() { return new Map(list.map((model, i) => [model, anchor + scale * Math.log10(strength[i])])) },
  }
}

/**
 * 单场胜势积分（∈ [0,1]）：
 *   分差加权模式 → (自身加权分 + τ) ÷ (自身 + 对手 + 2τ)，在 [0,+∞)² 上全局光滑，消除零点跳变与极低分噪声爆炸；
 *   关闭时退回硬胜负 → 1 / 0.5 / 0。
 * 两种结果都直接当「赢的场数」喂进 Bradley-Terry，拟合过程不用改。
 */
export function arenaOutcome(scoreA, scoreB, margin = ARENA_MARGIN_OF_VICTORY, tau = ARENA_OUTCOME_TAU) {
  const a = toNum(scoreA)
  const b = toNum(scoreB)
  if (a === null || b === null) return null
  if (!margin) return a > b ? 1 : a < b ? 0 : 0.5
  const smooth = Math.max(0, toNum(tau) ?? ARENA_OUTCOME_TAU)
  if (smooth > 0) {
    const denom = Math.max(0, a) + Math.max(0, b) + 2 * smooth
    return denom > 0 ? (Math.max(0, a) + smooth) / denom : 0.5
  }
  const total = a + b
  if (!(total > 0)) return 0.5
  return a / total
}

/** 由「每题 [{model, score}]」生成两两对局（默认分差加权）；同模型不比 */
export function arenaGames(byProblem, opts = {}) {
  const groups = byProblem instanceof Map ? [...byProblem.values()] : Object.values(byProblem || {})
  const games = []
  for (const list of groups) {
    const arr = Array.isArray(list) ? list : []
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]
        const b = arr[j]
        if (!a || !b || a.model === b.model) continue
        const s = arenaOutcome(a.score, b.score, opts.margin, opts.tau)
        if (s === null) continue
        games.push({ a: a.model, b: b.model, s })
      }
    }
  }
  return games
}

/** MM 迭代拟合 Bradley-Terry，返回 Elo 分（均值锚定 ARENA_ANCHOR） */
export function bradleyTerry(players, games, opts = {}) {
  if (opts.converge) {
    const solver = createBradleyTerrySolver(players, arenaStats(games), opts)
    while (!solver.done) solver.advance(128)
    if (!solver.converged) throw new Error('Bradley-Terry did not converge within the iteration limit')
    return solver.ratings()
  }
  const anchor = toNum(opts.anchor) ?? ARENA_ANCHOR
  const scale = toNum(opts.scale) ?? ARENA_SCALE
  const prior = toNum(opts.prior) ?? ARENA_PRIOR_GAMES
  const rounds = toNum(opts.iterations) ?? 200
  const list = [...new Set(players || [])]
  if (!list.length) return new Map()
  const p = new Map(list.map((m) => [m, 1]))
  const wins = new Map(list.map((m) => [m, (prior * 0.5)]))
  const opp = new Map(list.map((m) => [m, new Map()]))
  for (const g of games || []) {
    if (!p.has(g.a) || !p.has(g.b)) continue
    wins.set(g.a, wins.get(g.a) + g.s)
    wins.set(g.b, wins.get(g.b) + (1 - g.s))
    const oa = opp.get(g.a)
    const ob = opp.get(g.b)
    oa.set(g.b, (oa.get(g.b) || 0) + 1)
    ob.set(g.a, (ob.get(g.a) || 0) + 1)
  }
  for (let it = 0; it < rounds; it++) {
    const next = new Map()
    for (const m of list) {
      let den = prior / (p.get(m) + 1) // 虚拟对手强度 = 1（= 1000 分）
      for (const [o, n] of opp.get(m)) den += n / (p.get(m) + p.get(o))
      next.set(m, den > 0 ? wins.get(m) / den : p.get(m))
    }
    let logSum = 0
    for (const m of list) logSum += Math.log(next.get(m) || 1e-12)
    const gm = Math.exp(logSum / list.length) || 1
    for (const m of list) p.set(m, (next.get(m) || 1e-12) / gm)
  }
  const out = new Map()
  for (const m of list) out.set(m, anchor + scale * Math.log10(p.get(m)))
  return out
}

/** 整体分（Arena 模式）：Elo 分 + 对局数 + 胜/负/平 + 95% 自举区间 + 状态 */
export function arenaRating(byProblem, opts = {}) {
  const games = arenaGames(byProblem, opts)
  const players = [...new Set(games.flatMap((g) => [g.a, g.b]))].sort()
  const out = new Map()
  if (!players.length) return out
  const fit = bradleyTerry(players, games, opts)
  const boots = toNum(opts.bootstrap) ?? ARENA_BOOTSTRAP
  const samples = new Map(players.map((m) => [m, []]))
  const random = opts.seed === undefined ? Math.random : arenaRandom(opts.seed)
  for (let b = 0; b < boots && games.length; b++) {
    const resample = new Array(games.length)
    for (let i = 0; i < games.length; i++) resample[i] = games[Math.floor(random() * games.length)]
    const r = bradleyTerry(players, resample, opts)
    for (const m of players) samples.get(m).push(r.get(m))
  }
  const minGames = toNum(opts.minGames) ?? ARENA_MIN_GAMES
  for (const m of players) {
    const arr = samples.get(m).slice().sort((x, y) => x - y)
    const lo = arr.length ? arr[Math.floor(arr.length * 0.025)] : null
    const hi = arr.length ? arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.975))] : null
    const mine = games.filter((g) => g.a === m || g.b === m)
    // 胜势积分合计：每场「自身加权分 ÷ (自身 + 对手)」；平分/无分算 0.5
    let share = 0
    for (const g of mine) share += g.a === m ? g.s : 1 - g.s
    const winShare = mine.length ? share / mine.length : null
    out.set(m, {
      rating: fit.get(m),
      games: mine.length,
      share,
      winShare,
      lo,
      hi,
      status: mine.length >= minGames ? '正式榜' : `对局少(${mine.length} 局)`,
    })
  }
  return out
}


/** 一条记录的各轮加权分（与 submissions 等长；算不出的位置为 null） */
export function weightedRounds(record, problem) {
  const subs = Array.isArray(record && record.submissions) ? record.submissions : []
  return subs.map((s) => weightedRoundScore(s && s.score, s, problem))
}

/** 一条原始记录经过「单轮加权 + 多轮边际突破折现」后的轨迹综合分（全部无有效分返回 null） */
export function weightedRecordScore(record, problem, opts) {
  return trajectoryScore(weightedRounds(record, problem), opts)
}

/** 有没有任意一轮算得出加权分（用于「这题有没有加权分」判断，缺数据不算 0 分） */
export function hasWeightedScore(record, problem) {
  return weightedRounds(record, problem).some((v) => v !== null)
}
