import { lazy, memo, startTransition, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { ListOrdered, Columns3, Table2, RefreshCw, ChevronLeft, ChevronRight } from 'lucide-react'
import { useApp } from '../state'
import {
  bestThinkingCell, difficultyName, isApproved, isPassed, matrixCell, metricScore, scoreTierClass,
  seriesColorMap, seriesKey, seriesList, filterByModels, filterByContributor, THINKING_LABELS,
} from '../aggregate'
import { useIncrementalRating } from '../hooks/useIncrementalRating'
import PidLink from '../components/PidLink'
import { useUrlState } from '../hooks/useUrlState'
import { useScrollEdges } from '../hooks/useScrollEdges'
import { DEFAULT_UI_PREFERENCES } from '../uiPreferences'
import MotionRegion from '../components/MotionRegion'
const ScoreLayouts = lazy(() => import('./ScoreLayouts'))

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

/**
 * decimal 可指定显示精度；true 兼容 5 位，false 保持旧整数显示。
 */
const fmtScore = (v, decimal) => (decimal ? Number(v).toFixed(typeof decimal === 'number' ? decimal : 5) : Math.round(v))
const fmtDisp = (v) => (v == null ? '' : Number(v) < 10 ? Number(v).toFixed(1) : String(Math.round(Number(v))))

export default function MatrixView({ onOpenDetail, onQuickAdd, canSubmit, decimal = false, blankEmpty = false, onlyWithScore = false, unitScore = false, rawScores = false, compactHeader = false, toolbarExtra }) {
  const { data, loaded, focusModels, focusContributor, theme, vendorOf, uiPreferences = DEFAULT_UI_PREFERENCES } = useApp()
  const url = useUrlState('mx')
  /** v2：算不出加权分的格子直接留空（不显示「—」占位、更不出现原始分）；老版 blankEmpty=false → 原样 */
  const emptyCell = blankEmpty ? '' : '—'
  const requestedMode = url.get('mode', 'bestLevel')
  const mode = MODES.some((item) => item.key === requestedMode) ? requestedMode : 'bestLevel'
  const tableRef = useRef(null)
  const [wrapRef, scrollEdges] = useScrollEdges()
  const hoverFrame = useRef(null)
  const hoverNodes = useRef([])
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.innerWidth <= 700)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 700px)')
    const change = () => setMobile(media.matches)
    change()
    media.addEventListener?.('change', change)
    return () => media.removeEventListener?.('change', change)
  }, [])
  const requestedLayout = url.get('layout', mobile ? 'ranking' : 'matrix')
  const layout = ['ranking', 'compare', 'matrix'].includes(requestedLayout) ? requestedLayout : 'matrix'
  const query = url.get('q', '')
  const [searchInput, setSearchInput] = useState(query)
  const pendingSearch = useRef(null)
  useEffect(() => {
    if (pendingSearch.current !== null && pendingSearch.current !== query) return
    pendingSearch.current = null
    setSearchInput(query)
  }, [query])
  const deferredQuery = useDeferredValue(searchInput)
  const clearSearch = () => {
    pendingSearch.current = null
    setSearchInput('')
    url.set('q', '')
  }

  const setMode = useCallback((m) => {
    url.set('mode', m)
  }, [url])

  const approved = useMemo(() => filterByContributor(filterByModels(
    (data.records || []).filter(isApproved), focusModels), focusContributor), [data.records, focusModels, focusContributor])

  const colorMap = useMemo(
    () => seriesColorMap(approved, { vendorOf, dark: theme === 'dark' }),
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

  /**
   * v2 首行「rating」= 连续准 Rasch / 1PL 项目反应理论（Quasi-Rasch IRT）：
   *   1) 每道有效可比题（同题 ≥2 模型有分）取该格多轮轨迹综合分 V ∈ [0, 140)，映射为掌握度 y ∈ (0, 1)；
   *   2) 联合估计模型潜能力 θ_m 与题目潜难度 β_p：E[y_{m,p}] = 1 ÷ (1 + e^(−(θ_m − β_p)))；
   *   3) 阻尼牛顿法求解高斯先验最大后验（MAP），全体模型算术均值精确锚定 1000 分；
   *   4) 随机化先验自举给 95% 区间；参评可比题 < 5 题标「样本少」。
   * 格子里的加权分不受影响。
   */
  const publicDefault = (!focusModels || focusModels.size === 0) && focusContributor == null && (data.scope || 'public') === 'public'
  const ratingScope = publicDefault ? 'public' : JSON.stringify([data.scope, [...(focusModels || [])].sort(), focusContributor])
  const incremental = useIncrementalRating({ records: approved, problems: data.problems, epoch: data.epoch || '0',
    scope: ratingScope, mode, enabled: unitScore && mode !== 'status', cachePublic: publicDefault })
  const ratings = incremental.ratings
  const baseMetric = unitScore ? 'trajectory' : 'avgscore'

  // —— 列（AI）：按“每条记录全轮均分再平均”从高到低排 ——
  const series = useMemo(() => {
    const perModel = new Map()
    for (const r of approved) {
      const v = metricScore(r, baseMetric)
      if (v === null) continue
      if (!perModel.has(seriesKey(r))) perModel.set(seriesKey(r), [])
      perModel.get(seriesKey(r)).push(v)
    }
    // v2：只显示「有可显示数据」（至少有一轮算出加权分）的模型列；老版列出口径不变
    const s = onlyWithScore ? [...perModel.keys()] : seriesList(approved)
    if (unitScore) {
      return [...s].sort((a, b) => ((ratings.get(b)?.rating ?? -1) - (ratings.get(a)?.rating ?? -1))
        || a.localeCompare(b, 'zh-Hans-CN'))
    }
    const avgOf = new Map()
    for (const name of s) {
      const arr = perModel.get(name)
      avgOf.set(name, arr?.length ? arr.reduce((a, c) => a + c, 0) / arr.length : -1)
    }
    return [...s].sort((a, b) => (avgOf.get(b) ?? -1) - (avgOf.get(a) ?? -1)
      || a.localeCompare(b, 'zh-Hans-CN'))
  }, [approved, unitScore, ratings, onlyWithScore, baseMetric])

  // —— 行（题目）：按每题整体均分从高到低排 ——
  const problems = useMemo(() => {
    const list = Object.values(data.problems || {})
    const byPid = new Map()
    for (const r of approved) {
      const v = metricScore(r, baseMetric)
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
  }, [approved, data.problems, baseMetric])

  // 只缩小可见行，不改变整体统计、题目排名或其他视图的数据。
  const visibleProblems = useMemo(() => {
    const keyword = deferredQuery.trim().toLocaleLowerCase()
    return problems.map((problem, index) => ({ problem, rank: index + 1 }))
      .filter(({ problem }) => !keyword || `${problem.pid} ${problem.title || ''}`.toLocaleLowerCase().includes(keyword))
  }, [problems, deferredQuery])

  const summary = useMemo(() => {
    const byModel = new Map()
    for (const r of approved) {
      const key = seriesKey(r)
      let b = byModel.get(key)
      if (!b) { b = { sum: 0, n: 0, passed: 0, total: 0 }; byModel.set(key, b) }
      b.total += 1
      if (isPassed(r)) b.passed += 1
      const v = metricScore(r, mode === 'final' ? 'final' : baseMetric)
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
  }, [approved, series, mode, baseMetric])

  /* 十字高亮：命中行/列的格子打上 data-*-hit，靠 CSS 上色（避免逐格 re-render） */
  const clearHits = (table) => {
    hoverNodes.current.forEach((el) => { el.removeAttribute('data-cx-hit'); el.removeAttribute('data-rx-hit'); el.classList.remove('on') })
    hoverNodes.current = []
    delete table.dataset.cx
    delete table.dataset.rx
  }

  const onMove = useCallback((e) => {
    const table = tableRef.current
    if (!table) return
    const cell = e.target.closest?.('td.mcell')
    if (!cell || !cell.dataset.c || !cell.dataset.r) { clearHits(table); return }
    if (table.dataset.cx === cell.dataset.c && table.dataset.rx === cell.dataset.r) return
    cancelAnimationFrame(hoverFrame.current)
    hoverFrame.current = requestAnimationFrame(() => {
      if (!table.isConnected || !cell.isConnected) return
      clearHits(table)
      table.dataset.cx = cell.dataset.c
      table.dataset.rx = cell.dataset.r
      const column = [...table.rows].map((item) => item.cells[cell.cellIndex]).filter(Boolean)
      const row = [...cell.parentElement.cells]
      column.forEach((el) => el.setAttribute('data-cx-hit', ''))
      row.forEach((el) => el.setAttribute('data-rx-hit', ''))
      const heads = [table.tHead?.rows[0]?.cells[cell.cellIndex], cell.parentElement.cells[0]].filter(Boolean)
      heads.forEach((el) => el.classList.add('on'))
      hoverNodes.current = [...column, ...row, ...heads]
    })
  }, [])

  const onLeave = useCallback(() => {
    cancelAnimationFrame(hoverFrame.current)
    if (tableRef.current) clearHits(tableRef.current)
  }, [])
  useEffect(() => () => cancelAnimationFrame(hoverFrame.current), [])

  const active = MODES.find((m) => m.key === mode) || MODES[0]
  const isBest = active.best === 'level' || active.best === 'score'

  return (
    <div className={'matrix-surface' + (compactHeader ? ' compact-summary' : '')} id="matrix-card">
      <div className={'card-head' + (compactHeader ? ' matrix-accessible-heading' : '')}>
        <div className="matrix-heading-copy"><h2>{layout === 'ranking' ? '模型排名' : layout === 'compare' ? '模型对比' : 'AI × 题目矩阵'}</h2>
          <p>{blankEmpty ? '点击成绩查看该轮明细' : '点击成绩查看原始测评'}</p></div>
        {!compactHeader && <span className="matrix-count">{visibleProblems.length} / {problems.length} 题 · {series.length} 个模型</span>}
      </div>
      <div className="matrix-toolbar">
        <div className="seg layout-seg" role="group" aria-label="展示布局">
          {[['ranking', '排名', ListOrdered], ['compare', '对比', Columns3], ['matrix', '矩阵', Table2]].map(([key, label, Icon]) =>
            <button key={key} aria-pressed={layout === key} className={layout === key ? 'active' : ''} onClick={() => url.set('layout', key)}><Icon size={15} />{label}</button>)}
        </div>
        {toolbarExtra}
        <label className="matrix-search">
          <span className={compactHeader ? 'control-label-hidden' : undefined}>查找题目</span>
          <input type="search" value={searchInput} placeholder="题号 / 题名" aria-label="查找题目"
            onChange={(event) => {
              const value = event.target.value
              pendingSearch.current = value
              setSearchInput(value)
              startTransition(() => url.set('q', value))
            }}
            onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); clearSearch() } }} />
        </label>
        {searchInput && <button className="btn small ghost" onClick={clearSearch}>清除查找</button>}
        <label className="matrix-mode-select"><span className={compactHeader ? 'control-label-hidden' : undefined}>成绩口径</span>
          <select aria-label="单元格口径" value={mode} onChange={(event) => setMode(event.target.value)}>
            {MODES.map((item) => <option key={item.key} value={item.key}>{unitScore && item.key === 'avg' ? '全等级综合' : item.label}</option>)}
          </select>
        </label>
        {compactHeader && <span className={'matrix-count' + (!deferredQuery && !focusModels?.size && focusContributor == null && uiPreferences.features.stats ? ' control-label-hidden' : '')}>
          {visibleProblems.length} / {problems.length} 题 · {series.length} 个模型</span>}
      </div>
      {unitScore && mode !== 'status' && ['computing', 'intervals', 'error'].includes(incremental.status) && <div className="rating-progress" role="status" aria-live="polite">
        {incremental.status === 'computing' ? '更新 rating...' : incremental.status === 'intervals' ? '更新置信区间...' : incremental.error}
        {incremental.status === 'error' && <button className="btn small" onClick={incremental.retry}><RefreshCw size={14} />重试</button>}
      </div>}
      <MotionRegion motionKey={layout} className="matrix-content">
      {!series.length ? <div className="empty" role="status">{loaded === false ? '正在加载评测数据…' : '当前范围内暂无已审核的测评数据，请尝试调整模型或贡献者筛选。'}</div>
        : !visibleProblems.length ? <div className="empty">没有匹配「{searchInput}」的题目。<button className="btn small ghost" onClick={clearSearch}>显示全部题目</button></div>
        : layout !== 'matrix' ? <Suspense fallback={<div className="empty" role="status">加载布局…</div>}><ScoreLayouts layout={layout} series={series} problems={visibleProblems} grouped={grouped}
          ratings={incremental.ratings} intervalsReady={incremental.status === 'ready'} summary={summary} mode={mode} unitScore={unitScore} decimal={decimal}
          url={url} onOpenDetail={onOpenDetail} onQuickAdd={canSubmit ? onQuickAdd : undefined} /></Suspense>
        : <div className={'matrix-frame' + (scrollEdges.left ? ' edge-left' : '') + (scrollEdges.right ? ' edge-right' : '')}>
        {(scrollEdges.left || scrollEdges.right) && <div className="matrix-scroll-hint" aria-hidden="true">
          <span>共 {series.length} 个模型 · Shift + 滚轮或拖动底部滚动条横向查看</span>
          <button type="button" className="icon-btn" tabIndex={-1} disabled={!scrollEdges.left} onClick={() => document.getElementById('matrix-wrap')?.scrollBy({ left: -480, behavior: 'smooth' })} aria-label="向左滚动"><ChevronLeft size={16} aria-hidden="true" /></button>
          <button type="button" className="icon-btn" tabIndex={-1} disabled={!scrollEdges.right} onClick={() => document.getElementById('matrix-wrap')?.scrollBy({ left: 480, behavior: 'smooth' })} aria-label="向右滚动"><ChevronRight size={16} aria-hidden="true" /></button>
        </div>}
        <div className="matrix-wrap" id="matrix-wrap" ref={wrapRef} tabIndex={0} role="region" aria-label="评测矩阵，可横向滚动">
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
          <MatrixBody series={series} summary={summary} ratings={ratings} ratingStatus={incremental.status}
          visibleProblems={visibleProblems} grouped={grouped} mode={mode} active={active} isBest={isBest}
          unitScore={unitScore} decimal={decimal} blankEmpty={blankEmpty} emptyCell={emptyCell}
          canSubmit={canSubmit} onQuickAdd={onQuickAdd} onOpenDetail={onOpenDetail} showThinking={uiPreferences.features.thinkingLabels} />
        </table>
      </div></div>}
      </MotionRegion>
      {uiPreferences.features.scoreLegend && <div className="matrix-guide">
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
          <span>· 未作答{blankEmpty ? '' : '　— 无有效分数'}</span>
        </div>}
      </div>}
      <details className="matrix-hint">
        <summary>评分口径</summary>
        <p>{unitScore ? '最佳等级在有有效加权分的记录中取最高思考等级；多轮提交按边际突破折现（首轮全额计入，第 k 轮刷新历史最佳的增量乘 0.85^(k-1)，尝试未提升不倒扣分）。' : '最佳等级取最高思考等级记录的有效轮次均分；最佳分数取成绩最高的记录。有分数轮次才参与均分。'}</p>
        {rawScores && <p>AI 分数包含全部历史记录，使用洛谷原始分。</p>}
        {unitScore && <p>单轮加权分综合三次正确性效用、经验贝叶斯多测试点时空校准与正确率门控效能；rating 基于连续准 Rasch（1PL IRT）模型联合剥离题目难度与模型能力（全体均值锚定 1000 分），并通过 200 次随机化先验自举给出估计方差、标准误（±SD）与 95% 区间。</p>}
      </details>
    </div>
  )
}

// Keep the expensive cells stable while the search field receives urgent updates.
const MatrixBody = memo(function MatrixBody({ series, summary, ratings, ratingStatus, visibleProblems, grouped,
  mode, active, isBest, unitScore, decimal, blankEmpty, emptyCell, canSubmit, onQuickAdd, onOpenDetail, showThinking }) {
  return (<tbody>
            <tr className="sum-row">
              <th className="row-head" data-r="sum">{unitScore && mode !== 'status' ? <>天梯分<span className="sum-sub">±标准误</span></> : unitScore ? '天梯分' : '整体'}</th>
              {series.map((s, si) => {
                const info = summary.get(s)
                if (mode === 'status') {
                  return (
                    <td key={s} className="mcell" data-r="sum" data-c={`c${si}`} title={`${info.passRate?.toFixed(1)}%（${info.total} 条）`}>
                      {info.passRate === null ? '—' : `${Math.round(info.passRate)}%`}
                    </td>
                  )
                }
                if (unitScore) {
                  const ov = ratings.get(s)
                  if (!ov || ov.rating === null || ov.rating === undefined) {
                    return (
                      <td key={s} className="mcell score-na" data-r="sum" data-c={'c' + si} title={info.total + ' 条记录 · 暂无可比题目'}>
                        {emptyCell}<span className="sum-sub" aria-hidden="true" />
                      </td>
                    )
                  }
                  const tip = 'IRT 能力天梯分 ' + fmtScore(ov.rating, 5) + '（全体均值锚定 1000 分）'
                    + '\n参评 ' + (ov.problems ?? 0) + ' 题（同题比较 ' + ov.games + ' 次）· 基准胜率 ' + (ov.winShare === null ? '-' : (ov.winShare * 100).toFixed(1) + '%')
                    + '（平均掌握度 ' + (ov.avgMastery == null ? '-' : (ov.avgMastery * 100).toFixed(1) + '%') + '）'
                    + (ratingStatus !== 'ready' || ov.lo === null || ov.hi === null ? '' : '\n估计方差 ' + fmtScore(ov.variance, 5) + '（标准误 ±' + fmtScore(ov.sd, 5) + '）\n95% 区间 ' + fmtScore(ov.lo, 5) + ' ~ ' + fmtScore(ov.hi, 5))
                    + '\n' + ov.status
                  return (
                    <td key={s} className="mcell" data-r="sum" data-c={'c' + si} title={tip}>
                      {fmtScore(ov.rating, decimal)}{(ov.lowSample ?? (ov.status.indexOf('样本少') === 0 || ov.status.indexOf('对局少') === 0)) ? <span className="lv">样本少</span> : null}<span className="sum-sub">{ratingStatus === 'ready' && ov.sd != null ? `±${fmtDisp(ov.sd)}` : ''}</span>
                    </td>
                  )
                }
                return (
                  <td
                    key={s} className={`mcell ${info.avg === null ? 'score-na' : scoreTierClass(Math.round(info.avg))}`}
                    data-r="sum" data-c={`c${si}`} title={`n=${info.n}`}
                  >
                    {info.avg === null ? emptyCell : fmtScore(info.avg, decimal)}
                  </td>
                )
              })}
            </tr>
            {visibleProblems.map(({ problem, rank }, index) => <MatrixRow key={problem.pid} p={problem} rank={rank} pi={index}
              series={series} grouped={grouped} mode={mode} active={active} isBest={isBest} unitScore={unitScore}
              decimal={decimal} blankEmpty={blankEmpty} emptyCell={emptyCell} canSubmit={canSubmit}
              onQuickAdd={onQuickAdd} onOpenDetail={onOpenDetail} showThinking={showThinking} />)}
          </tbody>)
})

// Individual rows let React yield between rows, and rating-only updates reuse unchanged cells.
const MatrixRow = memo(function MatrixRow({ p, rank, pi, series, grouped, mode, active, isBest,
  unitScore, decimal, blankEmpty, emptyCell, canSubmit, onQuickAdd, onOpenDetail, showThinking }) {
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

  return (<tr>
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
                    const c = matrixCell(recs, s, p.pid)
                    const disabled = unitScore && !c.trajectoryInfo;
                    const cls = c.kind === 'ac' ? 'ac' : c.kind === 'fail' ? 'fail' : 'giveup'
                    const label = c.kind === 'ac' ? 'AC' : c.kind === 'fail' ? '未过' : '放弃'
                    return (
                      <td
                        key={s} className={`mcell ${cls}`} {...cellProps} {...(disabled ? {} : cellKeyboard(p.pid, s))}
                        aria-disabled={disabled || undefined}
                        title={`${c.passed}/${c.total} 条最终通过`}
                        onClick={disabled ? undefined : () => onOpenDetail && onOpenDetail(p.pid, s)}
                      >{label}</td>
                    )
                  }
                  if (isBest) {
                    const c = bestThinkingCell(recs, active.best, unitScore ? 'trajectory' : 'avgscore')
                    if (c.value === null) {
                      const cls = c.kind === 'ac' ? 'ac' : c.kind === 'fail' ? 'fail' : 'giveup'
                      return (
                        <td
                          key={s} className={`mcell ${blankEmpty ? '' : cls} score-na`} {...cellProps} {...(unitScore ? {} : cellKeyboard(p.pid, s))}
                          aria-disabled={unitScore || undefined}
                          title={blankEmpty ? '缺该轮时间/内存，算不出加权分（不显示原始分）' : `${THINKING_LABELS[c.thinking] || c.thinking} 无有效分数`}
                          onClick={unitScore ? undefined : () => onOpenDetail && onOpenDetail(p.pid, s)}
                        >{emptyCell}</td>
                      )
                    }
                    const v = fmtScore(c.value, decimal)
                    const lv = THINKING_LABELS[c.thinking] || c.thinking
                    return (
                      <td
                        key={s} className={`mcell ${scoreTierClass(Math.round(c.value))}`} {...cellProps} {...cellKeyboard(p.pid, s)}
                        title={`${s} · ${p.pid}　${Number(c.value).toFixed(5)} 分\n思考等级 ${lv}（${c.n} 条记录 / ${c.rounds} 个有分数轮次）\n同题同模型共 ${c.total} 条记录，本格只取${active.best === 'level' ? '等级最高' : '分数最高'}的那批`}
                        onClick={() => onOpenDetail && onOpenDetail(p.pid, s)}
                      >{v}{showThinking && <span className="lv">{lv}</span>}</td>
                    )
                  }
                  const c = matrixCell(recs, s, p.pid)
                  const info = mode === 'final' ? c.finalInfo : (unitScore ? c.trajectoryInfo : c.scoreInfo)
                  if (!info) return <td key={s} className="mcell score-na" {...cellProps} aria-disabled={unitScore || undefined}>{emptyCell}</td>
                  const avg = fmtScore(info.avg, decimal)
                  return (
                    <td
                      key={s} className={`mcell ${scoreTierClass(Math.round(info.avg))}`} {...cellProps} {...cellKeyboard(p.pid, s)}
                      title={`${s} · ${p.pid}　${Number(info.avg).toFixed(5)} 分\n` + (unitScore && mode !== 'final' ? `n=${info.n}（有效加权记录）` : `n=${info.n}（有分数轮次）`)}
                      onClick={() => onOpenDetail && onOpenDetail(p.pid, s)}
                    >{avg}</td>
                  )
                })}
              </tr>)
}, (previous, next) => Object.keys(next).every((key) => key === 'series'
  ? previous.series.length === next.series.length && previous.series.every((value, index) => value === next.series[index])
  : Object.is(previous[key], next[key])))
