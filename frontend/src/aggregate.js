/**
 * 聚合口径（common.js/app.js 口径移植）。
 * 铁律：seriesKey = model（版本/策略仅展示不参与分组）；
 * 无分数轮次（score=null）一律跳过、不按 0 计。
 */

import { vendorColorMap } from './palette'

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

/**
 * 洛谷题目页地址。题号不合洛谷格式时返回 null —— 不拼死链，调用方降级为纯文本。
 * 洛谷题号一律大写，故先 toUpperCase 再校验。
 */
export const LUOGU_ORIGIN = 'https://www.luogu.com.cn'
export function luoguUrl(pid) {
  const key = String(pid ?? '').trim().toUpperCase()
  return PID_RE.test(key) ? `${LUOGU_ORIGIN}/problem/${key}` : null
}

/**
 * 统一测试口径模板：纯前端文案。
 * 某题没配推荐提示词时的兜底（替它带上题号）；管理员发布题目时可在此基础上再改。
 * 发布弹窗与公开的「推荐提示词」页共用这一份，避免两处文案走偏。
 */
export const PROMPT_TEMPLATE = (pid) => `请独立完成这道洛谷题${pid ? `（${pid}）` : ''}。要求：
1）只输出一段完整、可直接提交的 C++17 代码（用 \`\`\`cpp 代码块包裹），不要解释、不要伪码、不要多份实现；
2）自己构造边界样例并在脑内逐条验证后再给最终版本；
3）不使用任何在线评测反馈，一次性给出终版。`

/** 题目实际使用的提示词：配过就用配的，没配就退到统一模板（带题号） */
export const promptOf = (p) => (p?.prompt ? p.prompt : PROMPT_TEMPLATE(p?.pid || ''))

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

/**
 * 系列（模型）→ 颜色。
 * 传入 opts.vendorOf 时按「厂商同色」方案上色（见 palette.js）；
 * 不传时保留旧的回环调色板（向后兼容）。
 */
export function seriesColorMap(records, opts) {
  const map = new Map()
  const list = seriesList(records)
  if (opts && typeof opts.vendorOf === 'function') {
    const colors = vendorColorMap(list, opts.vendorOf, opts.dark !== false)
    for (const s of list) map.set(s, colors.get(s))
    return map
  }
  list.forEach((s, i) => map.set(s, SERIES_COLORS[i % SERIES_COLORS.length]))
  return map
}

/** 思考等级强弱（ultra 最强）。未知等级按中等（3）处理。 */
export const THINKING_RANK = { ultra: 6, max: 5, xhigh: 4, high: 3, medium: 2, low: 1, off: 0 }
export const thinkingRank = (t) => (THINKING_RANK[t] ?? 3)

/**
 * 「该题该模型的最佳思考等级」：同一模型在同一题上只留思考等级最高的那批记录。
 * 并列时（同等级多条）合并取分数。
 */
export function bestLevelRecords(recs) {
  if (!recs.length) return []
  const top = Math.max(...recs.map((r) => thinkingRank(r.thinking)))
  return recs.filter((r) => thinkingRank(r.thinking) === top)
}

/**
 * 矩阵单元格（最佳思考等级口径）：
 *  mode = 'level' → 取该题该模型「思考等级最高」的记录打分
 *  mode = 'score' → 取该题该模型「分数最高」的记录打分
 * 返回 { kind, value, thinking, n, recs }；无记录时 { kind: 'none' }
 */
export function bestThinkingCell(recs, mode = 'level', metric = 'avgscore') {
  if (!recs.length) return { kind: 'none' }
  let pick
  if (mode === 'score') {
    const scored = recs.map((r) => ({ r, v: metricScore(r, metric === 'final' ? 'final' : metric) }))
    const withVal = scored.filter((x) => x.v !== null)
    if (withVal.length) {
      withVal.sort((a, b) => b.v - a.v || thinkingRank(b.r.thinking) - thinkingRank(a.r.thinking))
      const best = withVal[0].v
      pick = withVal.filter((x) => Math.abs(x.v - best) < 1e-9).map((x) => x.r)
    } else {
      pick = bestLevelRecords(recs)
    }
  } else {
    pick = bestLevelRecords(recs)
  }
  const passed = pick.filter(isPassed).length
  const gaveUp = pick.filter((r) => lastSub(r)?.result === '未解出').length
  const failed = pick.length - passed - gaveUp
  const kind = passed > 0 ? 'ac' : failed > 0 ? 'fail' : 'giveup'
  const info = roundsAvg(pick)
  const useFinal = metric === 'final' || metric === 'first'
  let value = null
  if (useFinal) {
    const vals = pick.map((r) => metricScore(r, metric)).filter((v) => v !== null)
    if (vals.length) value = vals.reduce((a, c) => a + c, 0) / vals.length
  } else {
    value = info ? info.avg : null
  }
  const levels = [...new Set(pick.map((r) => r.thinking))].sort((a, b) => thinkingRank(b) - thinkingRank(a))
  return {
    kind, value, thinking: levels[0] || null, levels,
    n: pick.length, rounds: info ? info.n : 0, total: recs.length, recs: pick,
    allRecs: recs,
  }
}

/* ---------------- 时间（明细/滚榜展示与排序用） ---------------- */

/** 记录的精确时间戳（毫秒）：录入时间优先，退化为测评日期 00:00 */
export function recordTs(r) {
  const iso = r.createdAt || r.updatedAt
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isNaN(t)) return t
  const d = Date.parse(`${r.date || ''}T00:00:00Z`)
  return Number.isNaN(d) ? 0 : d
}

const pad2 = (n) => String(n).padStart(2, '0')

/** YYYY-MM-DD HH:mm（本地时区） */
export function fmtDateTime(isoOrTs) {
  if (!isoOrTs) return '—'
  const d = new Date(typeof isoOrTs === 'number' ? isoOrTs : isoOrTs)
  if (Number.isNaN(d.getTime())) return String(isoOrTs)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** HH:mm（明细表第二行用） */
export function fmtClock(isoOrTs) {
  if (!isoOrTs) return ''
  const d = new Date(typeof isoOrTs === 'number' ? isoOrTs : isoOrTs)
  if (Number.isNaN(d.getTime())) return ''
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** 相对时间（滚榜 HUD 用） */
export function fmtSpan(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${pad2(s % 60)} 秒`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时 ${pad2(m % 60)} 分`
  return `${Math.floor(h / 24)} 天 ${pad2(h % 24)} 小时`
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
    if (isPending(r) && !f.includePending) return false
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

/** 记录的一行定位摘要：删除/批量删除的二次确认里用，保证各处口径一致 */
export function recordLine(r) {
  return `${seriesKey(r)} · ${r.pid}${r.title ? ` ${r.title}` : ''} · ${THINKING_LABELS[r.thinking] || r.thinking} · ${r.date}`
}

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
