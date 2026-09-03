/**
 * ACM 滚榜（纯前端派生，不改任何统计口径）。
 *
 * 语义映射：
 *   团队 = 模型（seriesKey = model）
 *   队员 = 该模型的思考等级（ultra/max/xhigh/high/medium/low/off）
 *   一次上机 = 一条测评记录（同队同题可由多名「队员」分别作答）
 *   题目解题 = 该队任一队员该题最终判定 AC；单元格分 = 该队该题的最好成绩
 *
 * 回放时间轴 = 记录的录入时间（createdAt，精确到分），逐条推进，
 * 因此同一天的多笔也能分出先后；只统计已审核记录。
 */
import { isApproved, isPassed, lastSub, recordTs, roundScores, seriesKey, thinkingRank } from './aggregate'

/** 记录 → 事件流（按录入时间升序） */
export function rollEvents(records) {
  return (records || [])
    .filter(isApproved)
    .map((r) => {
      const scores = roundScores(r)
      return {
        id: r.id,
        ts: recordTs(r),
        date: r.date,
        model: seriesKey(r),
        thinking: r.thinking || 'off',
        pid: r.pid,
        passed: isPassed(r),
        gaveUp: lastSub(r)?.result === '未解出',
        best: scores.length ? Math.max(...scores) : null,
        final: scores.length ? scores[scores.length - 1] : null,
        rounds: scores.length,
        minutes: r.minutes ?? null,
      }
    })
    .sort((a, b) => a.ts - b.ts || String(a.id).localeCompare(String(b.id)))
}

function newCell(ev) {
  return {
    attempts: 0, members: new Map(), firstTs: ev.ts, lastTs: ev.ts,
    passed: false, best: null, bestMember: null,
  }
}

function applyEvent(cell, ev) {
  cell.attempts += 1
  cell.lastTs = ev.ts
  let m = cell.members.get(ev.thinking)
  if (!m) {
    m = { thinking: ev.thinking, attempts: 0, ac: 0, best: null, final: null, lastTs: null }
    cell.members.set(ev.thinking, m)
  }
  m.attempts += 1
  m.lastTs = ev.ts
  if (ev.passed) m.ac += 1
  const v = ev.best !== null ? ev.best : ev.final
  if (v !== null && v !== undefined && (m.best === null || v > m.best)) m.best = v
  if (ev.final !== null && ev.final !== undefined) m.final = ev.final
  // 团队格：AC 优先，其次最高分
  const cellVal = ev.passed ? (ev.final ?? ev.best ?? 0) : (ev.best ?? ev.final)
  if (cellVal !== null && cellVal !== undefined && (cell.best === null || cellVal > cell.best)) {
    cell.best = cellVal
    cell.bestMember = ev.thinking
  }
  if (ev.passed) cell.passed = true
  else if (!cell.bestMember && (ev.best !== null || ev.final !== null)) {
    cell.bestMember = ev.thinking
  }
}

/**
 * 回放快照：暴露前 k 条事件后的榜面。
 * @returns {{teams: Array, pids: string[], solvedTotal: number, cursor: object|null, spanMs: number}}
 */
export function rollSnapshot(events, k) {
  const board = new Map() // model -> {stats}
  const pidFirstTs = new Map()
  const pidFirstAcTs = new Map()
  let solvedTotal = 0

  for (let i = 0; i < Math.min(k, events.length); i++) {
    const ev = events[i]
    let team = board.get(ev.model)
    if (!team) {
      team = {
        model: ev.model, cells: new Map(), solved: 0, attempted: 0,
        acEvents: 0, events: 0, members: new Map(), firstTs: ev.ts, lastTs: ev.ts,
      }
      board.set(ev.model, team)
    }
    team.events += 1
    team.lastTs = ev.ts
    if (!pidFirstTs.has(ev.pid)) pidFirstTs.set(ev.pid, ev.ts)
    let cell = team.cells.get(ev.pid)
    if (!cell) {
      cell = newCell(ev)
      team.cells.set(ev.pid, cell)
      team.attempted += 1
    }
    const wasPassed = cell.passed
    applyEvent(cell, ev)
    if (cell.passed && !wasPassed) {
      team.solved += 1
      solvedTotal += 1
      team.acEvents += 1
      if (!pidFirstAcTs.has(ev.pid) || pidFirstAcTs.get(ev.pid) > ev.ts) pidFirstAcTs.set(ev.pid, ev.ts)
    }
    let m = team.members.get(ev.thinking)
    if (!m) {
      m = { thinking: ev.thinking, attempts: 0, acEvents: 0, solved: 0, best: null, scoreSum: 0, scored: 0 }
      team.members.set(ev.thinking, m)
    }
    m.attempts += 1
    if (ev.passed) m.acEvents += 1
    const v = ev.best ?? ev.final
    if (v !== null && v !== undefined) {
      m.scoreSum += v
      m.scored += 1
      if (m.best === null || v > m.best) m.best = v
    }
  }

  const teams = [...board.values()].map((t) => {
    let bestSum = 0
    let bestN = 0
    for (const cell of t.cells.values()) {
      if (cell.best !== null && cell.best !== undefined) {
        bestSum += cell.best
        bestN += 1
      }
    }
    const members = [...t.members.values()].map((m) => ({
      ...m,
      label: m.thinking,
      avg: m.scored ? m.scoreSum / m.scored : null,
    })).sort((a, b) => thinkingRank(b.thinking) - thinkingRank(a.thinking))
    // 队员解题数：该思考等级作为最佳成员拿下的题目数
    for (const m of members) {
      let solved = 0
      for (const cell of t.cells.values()) if (cell.passed && cell.bestMember === m.thinking) solved += 1
      m.solved = solved
    }
    return {
      model: t.model,
      cells: t.cells,
      solved: t.solved,
      attempted: t.attempted,
      events: t.events,
      acEvents: t.acEvents,
      scoreSum: bestSum,
      avgBest: bestN ? bestSum / bestN : null,
      lastTs: t.lastTs,
      firstTs: t.firstTs,
      members,
    }
  })

  rankTeams(teams)

  // 题目列：先按「首次被解开」的时间，其次按「首次被尝试」的时间，最后按题号
  const pids = [...new Set(pidFirstTs.keys())]
  pids.sort((a, b) => {
    const aa = pidFirstAcTs.has(a) ? pidFirstAcTs.get(a) : Infinity
    const bb = pidFirstAcTs.has(b) ? pidFirstAcTs.get(b) : Infinity
    if (aa !== bb) return aa - bb
    const ta = pidFirstTs.get(a)
    const tb = pidFirstTs.get(b)
    if (ta !== tb) return ta - tb
    return String(a).localeCompare(String(b), 'zh-Hans-CN')
  })

  const cursor = k > 0 ? events[Math.min(k, events.length) - 1] : null
  return {
    teams, pids, solvedTotal, cursor,
    spanMs: cursor && teams.length ? cursor.ts - teams[0].firstTs : 0,
  }
}

/** 排名：AC 题数 → 总均分（各题最好成绩均值）→ 达成时间（越早越前）→ 名称 */
export function rankTeams(teams) {
  teams.sort((a, b) => (
    b.solved - a.solved
    || (b.avgBest ?? -1) - (a.avgBest ?? -1)
    || (a.lastTs || Infinity) - (b.lastTs || Infinity)
    || a.model.localeCompare(b.model, 'zh-Hans-CN')
  ))
  teams.forEach((t, i) => { t.rank = i + 1 })
  return teams
}

/** 下一个「有解题进展」的事件下标（跳过纯尝试），无则返回 events.length */
export function nextAcIndex(events, k) {
  for (let i = k; i < events.length; i++) if (events[i].passed) return i + 1
  return events.length
}

/** 下一条不同日期的事件下标（按测评日期批量推进） */
export function nextDayIndex(events, k) {
  if (k >= events.length) return events.length
  const d = events[k].date
  let i = k
  while (i < events.length && events[i].date === d) i += 1
  return i
}

/** 时间轴标签：当前游标所在记录的日期 + 时分 */
export function cursorLabel(events, k) {
  if (!events.length) return '—'
  const ev = events[Math.max(0, Math.min(k, events.length) - 1)]
  if (k <= 0) {
    const first = events[0]
    return `${first.date} 之前`
  }
  const d = new Date(ev.ts)
  const p = (n) => String(n).padStart(2, '0')
  return Number.isNaN(d.getTime())
    ? ev.date
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
