import { useCallback, useMemo, useRef, useState } from 'react'
import { useApp } from '../state'
import {
  bestThinkingCell, difficultyName, isApproved, isPassed, matrixCell, metricScore, scoreTierClass,
  seriesColorMap, seriesKey, seriesList, filterByModels, filterByContributor, THINKING_LABELS,
} from '../aggregate'
import PidLink from '../components/PidLink'
import { useUrlState } from '../hooks/useUrlState'

/**
 * 单元格口径。默认「最佳思考等级」= 该题该模型只取思考等级最高那条记录的成绩（需求 10）；
 * 「分数最优」= 在所有思考等级里取分最高的那条；另外保留原有的均分/最终分/状态口径。
 */
const MODES = [
  { key: 'bestLevel', label: '最佳等级', metric: 'avgscore', best: 'level' },
  { key: 'bestScore', label: '最佳分数', metric: 'avgscore', best: 'score' },
  { key: 'avg', label: '全轮均分', metric: 'avgscore' },
  { key: 'final', label: '最终分', metric: 'final' },
  { key: 'status', label: '通过状态' },
]

function RankBadge({ rank }) {
  const cls = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : ''
  return <span className={`mrank ${cls}`}>{rank}</span>
}

export default function MatrixView({ onOpenDetail, onQuickAdd, canSubmit }) {
  const { data, loaded, focusModels, focusContributor, theme, vendorOf } = useApp()
  const url = useUrlState('mx')
  const [modeLocal, setModeLocal] = useState(() => {
    const fromUrl = url.get('mode', '')
    return MODES.some((m) => m.key === fromUrl) ? fromUrl : 'bestLevel'
  })
  const mode = modeLocal
  const tableRef = useRef(null)
  const query = url.get('q', '')

  const setMode = useCallback((m) => {
    setModeLocal(m)
    url.set('mode', m)
  }, [url])

  const approved = useMemo(() => filterByContributor(filterByModels(
    (data.records || []).filter(isApproved), focusModels), focusContributor), [data.records, focusModels, focusContributor])

  const colorMap = useMemo(
    () => seriesColorMap(approved, { vendorOf, dark: theme !== 'light' }),
    [approved, vendorOf, theme])

  /** (model,pid) 分组索引：避免每格全表 filter */
  const grouped = useMemo(() => {
    const map = new Map()
    for (const r of approved) {
      const k = `${seriesKey(r)}\u0000${r.pid}`
      let arr = map.get(k)
      if (!arr) { arr = []; map.set(k, arr) }
      arr.push(r)
    }
    return map
  }, [approved])

  // —— 列（AI）：按“每条记录全轮均分再平均”从高到低排 ——
  const series = useMemo(() => {
    const perModel = new Map()
    for (const r of approved) {
      const v = metricScore(r, 'avgscore')
      if (v === null) continue
      if (!perModel.has(seriesKey(r))) perModel.set(seriesKey(r), [])
      perModel.get(seriesKey(r)).push(v)
    }
    const s = seriesList(approved)
    const avgOf = new Map()
    for (const name of s) {
      const arr = perModel.get(name)
      avgOf.set(name, arr?.length ? arr.reduce((a, c) => a + c, 0) / arr.length : -1)
    }
    return [...s].sort((a, b) => (avgOf.get(b) ?? -1) - (avgOf.get(a) ?? -1)
      || a.localeCompare(b, 'zh-Hans-CN'))
  }, [approved])

  // —— 行（题目）：按每题整体均分从高到低排 ——
  const problems = useMemo(() => {
    const list = Object.values(data.problems || {})
    const byPid = new Map()
    for (const r of approved) {
      const v = metricScore(r, 'avgscore')
      if (v === null) continue
      if (!byPid.has(r.pid)) byPid.set(r.pid, [])
      byPid.get(r.pid).push(v)
    }
    const avgOf = new Map()
    for (const p of list) {
      const arr = byPid.get(p.pid)
      avgOf.set(p.pid, arr?.length ? arr.reduce((a, c) => a + c, 0) / arr.length : -1)
    }
    list.sort((a, b) => {
      const da = avgOf.get(a.pid)
      const db = avgOf.get(b.pid)
      if (db !== da) return db - da
      return (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.pid.localeCompare(b.pid)
    })
    return list
  }, [approved, data.problems])

  // 只缩小可见行，不改变整体统计、题目排名或其他视图的数据。
  const visibleProblems = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase()
    return problems.map((problem, index) => ({ problem, rank: index + 1 }))
      .filter(({ problem }) => !keyword || `${problem.pid} ${problem.title || ''}`.toLocaleLowerCase().includes(keyword))
  }, [problems, query])

  const summary = useMemo(() => {
    const byModel = new Map()
    for (const r of approved) {
      const key = seriesKey(r)
      let b = byModel.get(key)
      if (!b) { b = { sum: 0, n: 0, passed: 0, total: 0 }; byModel.set(key, b) }
      b.total += 1
      if (isPassed(r)) b.passed += 1
      const v = metricScore(r, mode === 'final' ? 'final' : 'avgscore')
      if (v !== null) { b.sum += v; b.n += 1 }
    }
    const map = new Map()
    for (const s of series) {
      const b = byModel.get(s)
      map.set(s, {
        avg: b && b.n ? b.sum / b.n : null,
        n: b?.n ?? 0,
        passRate: b?.total ? (b.passed / b.total) * 100 : null,
        total: b?.total ?? 0,
      })
    }
    return map
  }, [approved, series, mode])

  /* 十字高亮：命中行/列的格子打上 data-*-hit，靠 CSS 上色（避免逐格 re-render） */
  const clearHits = (table) => {
    table.querySelectorAll('[data-cx-hit]').forEach((el) => el.removeAttribute('data-cx-hit'))
    table.querySelectorAll('[data-rx-hit]').forEach((el) => el.removeAttribute('data-rx-hit'))
    table.querySelectorAll('.on').forEach((el) => el.classList.remove('on'))
    delete table.dataset.cx
    delete table.dataset.rx
  }

  const onMove = useCallback((e) => {
    const table = tableRef.current
    if (!table) return
    const cell = e.target.closest?.('td.mcell')
    if (!cell || !cell.dataset.c || !cell.dataset.r) { clearHits(table); return }
    if (table.dataset.cx === cell.dataset.c && table.dataset.rx === cell.dataset.r) return
    clearHits(table)
    table.dataset.cx = cell.dataset.c
    table.dataset.rx = cell.dataset.r
    const esc = (v) => (window.CSS && window.CSS.escape ? window.CSS.escape(v) : v)
    table.querySelectorAll(`[data-c="${esc(cell.dataset.c)}"]`).forEach((el) => el.setAttribute('data-cx-hit', ''))
    table.querySelectorAll(`[data-r="${esc(cell.dataset.r)}"]`).forEach((el) => el.setAttribute('data-rx-hit', ''))
    table.querySelector(`thead th[data-c="${esc(cell.dataset.c)}"]`)?.classList.add('on')
    table.querySelector(`tbody th[data-r="${esc(cell.dataset.r)}"]`)?.classList.add('on')
  }, [])

  const onLeave = useCallback(() => {
    if (tableRef.current) clearHits(tableRef.current)
  }, [])

  const cellKeyboard = (pid, model) => ({
    tabIndex: 0,
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        onOpenDetail?.(pid, model)
      }
    },
    'aria-description': `${pid} · ${model}，按回车查看测评详情`,
  })

  const active = MODES.find((m) => m.key === mode) || MODES[0]
  const isBest = active.best === 'level' || active.best === 'score'

  return (
    <div className="card" id="matrix-card">
      <div className="card-head">
        <h2>AI × 题目矩阵</h2>
        <span className="hint">点击成绩查看原始测评</span>
        <span className="matrix-count">{visibleProblems.length} / {problems.length} 题 · {series.length} 个模型</span>
      </div>
      <div className="matrix-toolbar">
        <label className="matrix-search">
          查找题目
          <input type="search" value={query} placeholder="题号 / 题名"
            onChange={(event) => url.set('q', event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); url.set('q', '') } }} />
        </label>
        {query && <button className="btn small ghost" onClick={() => url.set('q', '')}>清除查找</button>}
        <div className="seg" role="group" aria-label="单元格口径">
          {MODES.map((m) => (
            <button
              key={m.key}
              aria-pressed={mode === m.key}
              className={mode === m.key ? 'active' : ''}
              onClick={() => setMode(m.key)}
              title={m.key === 'bestLevel'
                ? '该题该模型取「思考等级最高」的记录成绩'
                : m.key === 'bestScore'
                  ? '该题该模型取「分数最高」的记录成绩'
                  : undefined}
            >{m.label}</button>
          ))}
        </div>
      </div>
          <p className="matrix-hint">
            {mode === 'status' ? '单元格 = 最终轮判定'
              : isBest ? `单元格 = ${active.best === 'level' ? '最佳思考等级' : '最高分'}记录的分数（右上标注等级）`
                : mode === 'final' ? '单元格 = 每条记录最后一个有分数轮次' : '单元格 = 全部有分数轮次均分'}
          </p>
      {!series.length ? <div className="empty" role="status">{loaded === false ? '正在加载评测数据…' : '当前范围内暂无已审核的测评数据，请尝试调整模型或贡献者筛选。'}</div>
        : !visibleProblems.length ? <div className="empty">没有匹配「{query}」的题目。<button className="btn small ghost" onClick={() => url.set('q', '')}>显示全部题目</button></div>
        : <div className="matrix-wrap" id="matrix-wrap" tabIndex={0} role="region" aria-label="评测矩阵，可横向和纵向滚动">
        <table className="matrix" ref={tableRef} onMouseMove={onMove} onMouseLeave={onLeave}>
          <thead>
            <tr>
              <th className="row-head" data-r="-1">题目（按整体均分 ↓）</th>
              {series.map((s, si) => (
                <th key={s} className="model-col" data-c={`c${si}`} title={`${s} · 厂商 ${vendorOf(s)} · 全站均分第 ${si + 1} 名`}>
                  <RankBadge rank={si + 1} />
                  <span className="mname">{s}</span>
                  <span className="vbar" style={{ background: colorMap.get(s) || 'var(--border)' }} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleProblems.map(({ problem: p, rank }, pi) => (
              <tr key={p.pid}>
                <th
                  className="row-head"
                  data-r={`r${pi}`}
                  data-detail={p.pid}
                  title={`${p.pid} ${p.title || ''} · 点击看详情`}
                >
                  <RankBadge rank={rank} />
                  <span className="r-title">
                    <button className="matrix-problem" onClick={() => onOpenDetail?.(p.pid)}>{p.title || '（未命名）'}</button>
                  </span>
                  <span className="matrix-row-meta"><PidLink pid={p.pid} /> · {difficultyName(p.difficulty)}</span>
                </th>
                {series.map((s, si) => {
                  const recs = grouped.get(`${s}\u0000${p.pid}`) || []
                  const cellProps = { 'data-r': `r${pi}`, 'data-c': `c${si}` }
                  if (!recs.length) {
                    return (
                      <td key={s} className="mcell none" {...cellProps} title="该模型尚未作答本题">
                        ·
                        {canSubmit && onQuickAdd && (
                          <button
                            className="quick-add"
                            onClick={(e) => { e.stopPropagation(); onQuickAdd(p.pid) }}
                            title="为该题提交测评"
                          >+</button>
                        )}
                      </td>
                    )
                  }
                  if (mode === 'status') {
                    const c = matrixCell(approved, s, p.pid)
                    const cls = c.kind === 'ac' ? 'ac' : c.kind === 'fail' ? 'fail' : 'giveup'
                    const label = c.kind === 'ac' ? 'AC' : c.kind === 'fail' ? '未过' : '放弃'
                    return (
                      <td
                        key={s} className={`mcell ${cls}`} {...cellProps} {...cellKeyboard(p.pid, s)}
                        title={`${c.passed}/${c.total} 条最终通过`}
                        onClick={() => onOpenDetail && onOpenDetail(p.pid, s)}
                      >{label}</td>
                    )
                  }
                  if (isBest) {
                    const c = bestThinkingCell(recs, active.best, 'avgscore')
                    if (c.value === null) {
                      const cls = c.kind === 'ac' ? 'ac' : c.kind === 'fail' ? 'fail' : 'giveup'
                      return (
                        <td
                          key={s} className={`mcell ${cls} score-na`} {...cellProps} {...cellKeyboard(p.pid, s)}
                          title={`${THINKING_LABELS[c.thinking] || c.thinking} 无有效分数`}
                          onClick={() => onOpenDetail && onOpenDetail(p.pid, s)}
                        >—</td>
                      )
                    }
                    const v = Math.round(c.value)
                    const lv = THINKING_LABELS[c.thinking] || c.thinking
                    return (
                      <td
                        key={s} className={`mcell ${scoreTierClass(v)}`} {...cellProps} {...cellKeyboard(p.pid, s)}
                        title={`${s} · ${p.pid}\n思考等级 ${lv}（${c.n} 条记录 / ${c.rounds} 个有分数轮次）\n同题同模型共 ${c.total} 条记录，本格只取${active.best === 'level' ? '等级最高' : '分数最高'}的那批`}
                        onClick={() => onOpenDetail && onOpenDetail(p.pid, s)}
                      >{v}<span className="lv">{lv}</span></td>
                    )
                  }
                  const c = matrixCell(approved, s, p.pid)
                  const info = mode === 'final' ? c.finalInfo : c.scoreInfo
                  if (!info) return <td key={s} className="mcell score-na" {...cellProps}>—</td>
                  const avg = Math.round(info.avg)
                  return (
                    <td
                      key={s} className={`mcell ${scoreTierClass(avg)}`} {...cellProps} {...cellKeyboard(p.pid, s)}
                      title={`n=${info.n}（有分数轮次）`}
                      onClick={() => onOpenDetail && onOpenDetail(p.pid, s)}
                    >{avg}</td>
                  )
                })}
              </tr>
            ))}
            <tr className="sum-row">
              <th className="row-head" data-r="sum">整体</th>
              {series.map((s, si) => {
                const info = summary.get(s)
                if (mode === 'status') {
                  return (
                    <td key={s} className="mcell" data-c={`c${si}`} title={`${info.passRate?.toFixed(1)}%（${info.total} 条）`}>
                      {info.passRate === null ? '—' : `${Math.round(info.passRate)}%`}
                    </td>
                  )
                }
                return (
                  <td
                    key={s} className={`mcell ${info.avg === null ? 'score-na' : scoreTierClass(Math.round(info.avg))}`}
                    data-c={`c${si}`} title={`n=${info.n}`}
                  >
                    {info.avg === null ? '—' : Math.round(info.avg)}
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>}
      <div className="matrix-guide">
        {mode === 'status' ? <div className="matrix-scale" aria-label="通过状态图例">
          <span style={{ color: 'var(--green)' }}><i />AC</span>
          <span style={{ color: 'var(--red)' }}><i />未过</span>
          <span style={{ color: 'var(--orange)' }}><i />放弃</span>
          <span>· 未作答</span>
        </div> :
        <div className="matrix-scale" aria-label="分数颜色图例">
          <span style={{ color: 'var(--purple)' }}><i />100</span>
          <span style={{ color: 'var(--green)' }}><i />80–99</span>
          <span style={{ color: 'var(--orange)' }}><i />60–79</span>
          <span style={{ color: 'var(--red)' }}><i />0–59</span>
          <span>· 未作答　— 无有效分数</span>
        </div>}
        <span>列按模型整体均分排序 · 滚动时题目列与表头固定</span>
      </div>
      <details className="matrix-hint">
        <summary>排序与统计口径</summary>
        列 = AI（<b>颜色按厂商归组</b>，同厂商同色系，列下色条即厂商色），行 = 题目（按整体均分 ↓）。
        默认口径「最佳等级」= 该题该模型只取<b>思考等级最高</b>（Ultra&gt;Max&gt;X-High&gt;High&gt;Medium&gt;Low&gt;关闭）的那条记录分数，
        可切到「最佳分数」改取分数最高的那批；悬停行/列有十字高亮，贡献者可在空格子上用「+」快捷提单。
        查找题目只缩小可见行，底部「整体」仍为当前模型与贡献者范围的整体统计。
      </details>
    </div>
  )
}
