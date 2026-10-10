/**
 * 加权分（v2）—— 全站唯一实现在这里。
 *
 * 每轮得分 = 该轮洛谷测评分 × 原始分权重 × 时间权重 × 空间权重
 *   原始分权重 = (洛谷测评分 / 100)^e，e = 自然常数 Math.E ≈ 2.71828
 *     → 100 分 → 1、90 分 → 0.9^e ≈ 0.751、80 分 → 0.8^e ≈ 0.545、50 分 → 0.5^e ≈ 0.152
 *   基准 = 绝对尺子（与题目无关）：时间 1000ms、内存 125MB 处权重恰好 = 1
 *   比基准快 / 省 → 权重 > 1（奖励）；超出基准 → 权重 < 1（惩罚）
 *
 *   两条曲线都是 Hill 函数（对数尺度上的 logistic），在 (0, +∞) 上单调递减、
 *   把整个定义域一一映射到各自的**开区间**里（两端取不到），且各自在固定基准处恰好 = 1：
 *
 *     时间权重 wt(t) = 0.1  + 1.9  / (1 + (t / 948.68)^K)    → 值域 (0.1,  2)，t = 1000ms 时 = 1
 *     空间权重 ws(m) = 0.25 + 1.25 / (1 + (m / 153.09)^K)    → 值域 (0.25, 1.5)，m = 125MB 时 = 1
 *
 *   性质：单调递减；wt(1000ms)=1、ws(125MB)=1；t→0⁺ 趋近 2 / m→0⁺ 趋近 1.5，t→∞ 趋近 0.1 / m→∞ 趋近 0.25；
 *   对数对称（t 与 T0²/t 的权重之和恒为 0.1+2 = 2.1；内存恒为 1.75）。
 *   K = 2 → 中等陡度（K=1 平缓、K=3 陡峭）。
 *
 *   例（K=2，K 只影响陡度、不影响基准点）：
 *     时间 100ms→1.979、500ms→1.587、1000ms→1.000、2000ms→0.449、4000ms→0.201、8000ms→0.126
 *     内存 64MB→1.314、125MB→1.000、256MB→0.579、512MB→0.353、1024MB→0.277
 *
 * 因为权重可以 > 1，加权分可能超过该轮洛谷测评分（不封顶）；结果保留 5 位小数且非负。
 *
 * 整体分（v2 页面首行）用 Chatbot Arena 模式（含分差加权）：把同题两模型的加权分比较当作对局，
 * 用 Bradley-Terry / Elo 最大似然拟合出天梯分（详见文件末尾），格子里的加权分不受影响。
 *
 * 数据不全（缺时间/内存）时返回 null —— 页面留空，不当作 0 分。
 *
 * 列表 / 矩阵 / 详情 / 统计 / 排名一律 import 本文件，不要再写第二份算分逻辑，
 * 否则同一道题会在不同页面出现两个分数。
 */

/** v2 只使用这个时刻之后创建的数据（北京时间 2026-09-05 21:19 = 13:19Z） */
export const V2_CUTOFF_ISO = '2026-09-05T13:19:00Z'

/** 曲线陡度：1 平缓 / 2 中等 / 3 陡峭 */
export const WEIGHT_K = 2
/** 原始分权重的指数 = 自然常数 e（100 分 → 1，90 分 → 0.9^e） */
export const RAW_W_EXP = Math.E
/** 时间权重值域上下限（开区间，取不到） */
export const TIME_W_MAX = 2
export const TIME_W_MIN = 0.1
/** 空间权重值域上下限（开区间，取不到） */
export const MEM_W_MAX = 1.5
export const MEM_W_MIN = 0.25
/** 绝对基准（与题目无关）：时间 = 1000ms 时权重恰好 1 */
export const TIME_ANCHOR_MS = 1000
/** 绝对基准：内存 = 125MB 时权重恰好 1 */
export const MEM_ANCHOR_MB = 125

const toNum = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 时间权重：(0, +∞) → (0.1, 2) 的开区间单调递减曲线，题限处恰好 = 1。
 * wt(t) = 0.1 + 1.9 / (1 + (t / T0t)^K)，T0t = 题限 · 0.9^(1/K)。
 * 缺值或非正数返回 null（不当作 1）。
 */
export function timeWeight(timeMs) {
  const t = toNum(timeMs)
  if (t === null || t <= 0) return null
  // 由 wt(1000ms) = 1 反解出中心：T0 = 1000 · ((1 − 下限) / (上限 − 1))^(1/K) = 948.68ms
  const t0 = TIME_ANCHOR_MS * Math.pow((1 - TIME_W_MIN) / (TIME_W_MAX - 1), 1 / WEIGHT_K)
  return TIME_W_MIN + (TIME_W_MAX - TIME_W_MIN) / (1 + (t / t0) ** WEIGHT_K)
}

/**
 * 空间权重：(0, +∞) → (0.25, 1.5) 的开区间单调递减曲线，题限处恰好 = 1。
 * ws(m) = 0.25 + 1.25 / (1 + (m / M0m)^K)，M0m = 题限 · 1.5^(1/K)。
 * 缺值或非正数返回 null。
 */
export function memoryWeight(memoryMb) {
  const m = toNum(memoryMb)
  if (m === null || m <= 0) return null
  // 由 ws(125MB) = 1 反解出中心：M0 = 125 · ((1 − 下限) / (上限 − 1))^(1/K) = 153.09MB
  const m0 = MEM_ANCHOR_MB * Math.pow((1 - MEM_W_MIN) / (MEM_W_MAX - 1), 1 / WEIGHT_K)
  return MEM_W_MIN + (MEM_W_MAX - MEM_W_MIN) / (1 + (m / m0) ** WEIGHT_K)
}

/** 原始分权重 = (原始分 / 100)^e，e = 自然常数；100 分 → 1，0 分 → 0 */
export function rawWeight(rawScore) {
  const r = toNum(rawScore)
  if (r === null) return null
  return Math.pow(Math.max(0, r) / 100, RAW_W_EXP)
}

/**
 * 单轮加权分 = 洛谷测评分 × 原始分权重 × 时间权重 × 空间权重。
 * @param rawScore 该轮洛谷测评分；null/空 → 返回 null
 * @param sub      该轮提交 { timeMs, memoryMb }
 * @param problem  该题 { timeLimit, memoryLimit }
 * @returns number（≥ 0，5 位小数）或 null（数据不全 → 页面留空）
 */
export function weightedRoundScore(rawScore, sub) {
  const raw = toNum(rawScore)
  if (raw === null) return null
  const wt = timeWeight(sub && sub.timeMs)
  const ws = memoryWeight(sub && sub.memoryMb)
  if (wt === null || ws === null) return null
  return Math.round(Math.max(0, raw * rawWeight(raw) * wt * ws) * 1e5) / 1e5
}

/* ============ 整体分：Chatbot Arena 模式（Bradley-Terry / Elo 天梯） ============
 * 把「同一道题上两个模型的加权分」看成一场对局：默认**分差加权（Margin-of-Victory）**——
 * 单场胜势积分 = 自身加权分 ÷ (自身 + 对手)，大胜接近 1、险胜接近 0.5（可关掉退回硬胜负 1/0.5/0），
 * 再用 Bradley-Terry 模型做最大似然拟合，得到每个模型的 Elo 分 —— 与 Chatbot Arena 同源：
 *     P(i 胜 j) = 1 / (1 + 10^(-(R_i - R_j) / 400))
 * 求解用 MM 迭代（Hunter 2004），收敛后把全体几何均值锚定到 1000 分。
 * 数据稀疏时：每人加极弱的「虚拟对手」先验（0.3 局，各半胜）保证一定可解、且不会乱飞；
 * 最后自举重采样给出 95% 置信区间（Arena 的 ± 区间同一思路）。
 */
export const ARENA_ANCHOR = 1000
export const ARENA_SCALE = 400
export const ARENA_PRIOR_GAMES = 0.3
export const ARENA_BOOTSTRAP = 200
export const ARENA_MIN_GAMES = 10
/** 分差加权（Margin-of-Victory）：默认开启 —— 大胜比险胜拿更多天梯分 */
export const ARENA_MARGIN_OF_VICTORY = true

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
 *   分差加权模式 → 自身加权分 ÷ (自身 + 对手)，大胜接近 1、险胜接近 0.5；
 *   关闭时退回硬胜负 → 1 / 0.5 / 0。
 * 两种结果都直接当「赢的场数」喂进 Bradley-Terry，拟合过程不用改。
 */
export function arenaOutcome(scoreA, scoreB, margin = ARENA_MARGIN_OF_VICTORY) {
  const a = toNum(scoreA)
  const b = toNum(scoreB)
  if (a === null || b === null) return null
  if (!margin) return a > b ? 1 : a < b ? 0 : 0.5
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
        const s = arenaOutcome(a.score, b.score, opts.margin)
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

/** 有没有任意一轮算得出加权分（用于「这题有没有加权分」判断，缺数据不算 0 分） */
export function hasWeightedScore(record, problem) {
  return weightedRounds(record, problem).some((v) => v !== null)
}
