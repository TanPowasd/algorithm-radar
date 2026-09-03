/**
 * 聚合口径（common.js/app.js 口径移植）。
 * 铁律：seriesKey = model（版本/策略仅展示不参与分组）；
 * 无分数轮次（score=null）一律跳过、不按 0 计。
 */

export const RESULTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE', '未解出']
export const THINKING_LEVELS = ['ultra', 'max', 'xhigh', 'high', 'medium', 'low', 'off']
export const DEFAULT_THINKING = 'max'
export const THINKING_LABELS = {
  ultra: 'Ultra', max: 'Max', xhigh: 'X-High', high: 'High', medium: 'Medium', low: 'Low', off: '关闭',
}
export const DIFFICULTY_NAMES = {
  0: '暂无评定', 1: '入门', 2: '普及−', 3: '普及/提高−',
  4: '普及+/提高', 5: '提高+/省选−', 6: '省选/NOI−', 7: 'NOI/NOI+/CTSC',
}
export const CATEGORY_ORDER = ['动态规划', '字符串', '图论', '搜索', '数据结构', '树', '二分/分治', '贪心', '模拟/枚举', '计算几何', '数学']
export const SERIES_COLORS = ['#4d9dff', '#34c778', '#a78bfa', '#f59e4b', '#f2555a', '#22c3d6', '#fbbf24', '#ec6ff1', '#8fd14f', '#7f8ea8']
export const PID_RE = /^[A-Z]{1,3}_?[A-Z0-9_]{2,20}$/

export const seriesKey = (r) => r.model
export const isApproved = (r) => r.status !== 'pending'
export const isPending = (r) => r.status === 'pending'
export const firstSub = (r) => (r.submissions && r.submissions[0]) || null
export const lastSub = (r) => (r.submissions && r.submissions[r.submissions.length - 1]) || null
export const isPassed = (r) => lastSub(r)?.result === 'AC'
export const isFirstPassed = (r) => firstSub(r)?.result === 'AC'
export const answered = (r) => (r.submissions && r.submissions.length > 0)

/** 按“已选模型集合”过滤记录；set 为空/undefined 表示不过滤（全部） */
export const filterByModels = (records, focus) =>
  (!focus || focus.size === 0) ? records : records.filter((r) => focus.has(seriesKey(r)))

export const roundScores = (r) =>
  (r.submissions || []).map((s) => s.score).filter((s) => s !== null && s !== undefined)

/** 首轮分数（首轮无分则为 null） */
export const firstRoundScore = (r) => {
  const s = firstSub(r)
  return s && s.score !== null && s.score !== undefined ? s.score : null
}
/** 最终轮分数：最后一个「有分数」轮次的分（全部无分则为 null） */
export const finalRoundScore = (r) => {
  const scores = roundScores(r)
  return scores.length ? scores[scores.length - 1] : null
}
/** 该记录全部有分数轮次的均分（无分轮次不计；全部无分为 null） */
export const avgRoundScore = (r) => {
  const scores = roundScores(r)
  if (!scores.length) return null
  return scores.reduce((a, b) => a + b, 0) / scores.length
}
/** 趋势/矩阵口径取值：first=首轮分 final=末轮有分数 avgscore=全轮均分 */
export function metricScore(r, metric) {
  if (metric === 'first') return firstRoundScore(r)
  if (metric === 'final') return finalRoundScore(r)
  return avgRoundScore(r)
}

export function seriesList(records) {
  const set = new Set()
  for (const r of records) set.add(seriesKey(r))
  return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
}

export function seriesColorMap(records) {
  const map = new Map()
  seriesList(records).forEach((s, i) => map.set(s, SERIES_COLORS[i % SERIES_COLORS.length]))
  return map
}

export function difficultyName(d) {
  return DIFFICULTY_NAMES[d] ?? `难度${d}`
}

export function scoreTierClass(score) {
  if (score === null || score === undefined) return 'score-na'
  if (score >= 100) return 'score-100'
  if (score >= 80) return 'score-hi'
  if (score >= 60) return 'score-mid'
  return 'score-lo'
}

export function subBadgeClass(score) {
  if (score === null || score === undefined) return 'b-na'
  if (score >= 100) return 'b-100'
  if (score >= 80) return 'b-hi'
  if (score >= 60) return 'b-mid'
  return 'b-lo'
}

/** 一组记录的「有分数轮次」均分与样本数 */
export function roundsAvg(records) {
  let sum = 0
  let n = 0
  for (const r of records) {
    for (const s of roundScores(r)) {
      sum += s
      n += 1
    }
  }
  return n ? { avg: sum / n, n } : null
}

/** 模型 × 思考等级组合统计（柱状图用） */
export function comboAvg(records, series, thinking) {
  return roundsAvg(records.filter((r) => seriesKey(r) === series && r.thinking === thinking))
}

/** 雷达图轴统计：axisOf(r) 返回该记录所属轴名；metric=first/final 为 AC 率(%)，avgscore 为均分 */
export function axisStats(records, axisOf, metric) {
  const buckets = new Map()
  for (const r of records) {
    const axis = axisOf(r)
    if (axis === null || axis === undefined) continue
    if (!buckets.has(axis)) buckets.set(axis, { answered: 0, passed: 0, sum: 0, n: 0 })
    const b = buckets.get(axis)
    if (metric === 'avgscore') {
      const scores = roundScores(r)
      for (const s of scores) {
        b.sum += s
        b.n += 1
      }
    } else {
      b.answered += 1
      const pass = metric === 'first' ? isFirstPassed(r) : isPassed(r)
      if (pass) b.passed += 1
    }
  }
  const out = new Map()
  for (const [axis, b] of buckets) {
    if (metric === 'avgscore') {
      if (b.n > 0) out.set(axis, { value: b.sum / b.n, answered: b.n, passed: null })
    } else if (b.answered > 0) {
      out.set(axis, { value: (b.passed / b.answered) * 100, answered: b.answered, passed: b.passed })
    }
  }
  return out
}

/** 矩阵单元格：某模型在某题的记录 → {status, score} */
export function matrixCell(records, series, pid) {
  const recs = records.filter((r) => seriesKey(r) === series && r.pid === pid)
  if (!recs.length) return { kind: 'none' }
  const passed = recs.filter(isPassed).length
  const failed = recs.filter((r) => !isPassed(r) && answered(r) && lastSub(r)?.result !== '未解出').length
  const gaveUp = recs.filter((r) => lastSub(r)?.result === '未解出').length
  const kind = passed > 0 ? 'ac' : failed > 0 ? 'fail' : 'giveup'
  const scoreInfo = roundsAvg(recs)
  const finalInfo = (() => {
    let sum = 0
    let n = 0
    for (const r of recs) {
      const s = finalRoundScore(r)
      if (s !== null) {
        sum += s
        n += 1
      }
    }
    return n ? { avg: sum / n, n } : null
  })()
  return { kind, passed, failed, gaveUp, total: recs.length, scoreInfo, finalInfo, recs }
}

/** 明细表筛选 */
export function applyFilters(records, f) {
  const kw = (f.keyword || '').trim().toLowerCase()
  return records.filter((r) => {
    if (isPending(r)) return false
    if (f.series && seriesKey(r) !== f.series) return false
    if (f.difficulty !== '' && f.difficulty !== null && f.difficulty !== undefined && String(r.difficulty) !== String(f.difficulty)) return false
    if (f.category && !(r.categories || []).includes(f.category)) return false
    if (f.thinking && r.thinking !== f.thinking) return false
    if (f.result) {
      const ok = f.result === 'first' ? isFirstPassed(r) : f.result === 'final' ? isPassed(r) : !isPassed(r)
      if (!ok) return false
    }
    if (kw) {
      const hay = [r.pid, r.title, r.note, r.model, r.variant, r.agent, r.tokenSource, r.thinking,
        ...(r.submissions || []).flatMap((s) => [String(s.score ?? ''), s.result, s.note])].join(' ').toLowerCase()
      if (!hay.includes(kw)) return false
    }
    return true
  })
}

/** 榜单聚合（按模型） */
export function leaderboard(records) {
  const byModel = new Map()
  for (const r of records) {
    if (isPending(r)) continue
    const key = seriesKey(r)
    if (!byModel.has(key)) {
      byModel.set(key, { model: key, total: 0, ac: 0, firstAc: 0, scores: [], problems: new Set(), minutes: 0 })
    }
    const b = byModel.get(key)
    b.total += 1
    if (isPassed(r)) b.ac += 1
    if (isFirstPassed(r)) b.firstAc += 1
    for (const s of roundScores(r)) b.scores.push(s)
    b.problems.add(r.pid)
    b.minutes += r.minutes || 0
  }
  const rows = [...byModel.values()].map((b) => ({
    model: b.model,
    total: b.total,
    ac: b.ac,
    acRate: b.total ? (b.ac / b.total) * 100 : 0,
    firstAc: b.firstAc,
    firstAcRate: b.total ? (b.firstAc / b.total) * 100 : 0,
    avgScore: b.scores.length ? b.scores.reduce((a, c) => a + c, 0) / b.scores.length : null,
    scoreN: b.scores.length,
    problemCount: b.problems.size,
    minutes: b.minutes,
  }))
  return rows
}

/** 某模型 × 思考等级明细（榜单展开） */
export function leaderboardDetail(records, model) {
  const rows = leaderboard(records.filter((r) => seriesKey(r) === model))
  return rows
}

export const todayStr = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function normalizeSub(raw) {
  let score = raw.score
  if (score === '' || score === null || score === undefined) score = null
  else score = Math.max(0, Math.min(100, Math.round(Number(score) || 0)))
  const result = RESULTS.includes(raw.result) ? raw.result : '未解出'
  return { score, result, note: (raw.note || '').slice(0, 300) }
}

/** 首次录入的历史数据（无提供者/审核人 ID）统一署名 */
export const LEGACY_PRODUCER = '全民制作人'

/** 提供者显示：有 ID 走昵称解析（昵称 #ID）；无 ID（历史录入）统一署名全民制作人 */
export function providerLabel(r, nicknameOf) {
  return r.authorId ? `${nicknameOf(r.author)} #${r.authorId}` : LEGACY_PRODUCER
}

/** 审核人显示：已审核但无审核人 ID（历史录入）→ 全民制作人；待审核 → null */
export function reviewerLabel(r, nameByUid) {
  if (r.reviewerId) {
    const name = nameByUid(r.reviewerId)
    return name ? `${name} #${r.reviewerId}` : `#${r.reviewerId}`
  }
  return r.status === 'approved' ? LEGACY_PRODUCER : null
}
