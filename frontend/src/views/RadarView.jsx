import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state'
import { makeChart, themeColors } from '../components/charts'
import SeriesLegend from '../components/SeriesLegend'
import {
  axisStats, CATEGORY_ORDER, difficultyName, isApproved, seriesColorMap, seriesKey, seriesList,
  filterByModels, filterByContributor,
} from '../aggregate'
import { useUrlState } from '../hooks/useUrlState'

const METRICS = [
  { key: 'final', label: '最终 AC 率' },
  { key: 'first', label: '首轮 AC 率' },
  { key: 'avgscore', label: '平均得分' },
]
const DIMS = [
  { key: 'category', label: '按算法标签' },
  { key: 'difficulty', label: '按难度' },
  { key: 'problem', label: '单题对比' },
]
const DIFF_LEVELS = [0, 1, 2, 3, 4, 5, 6, 7]

export default function RadarView() {
  const { data, theme, focusModels, focusContributor, vendorOf, radarSize, setRadarSize } = useApp()
  const url = useUrlState('rd')
  const [metric, setMetric] = useState(() => (METRICS.some((m) => m.key === url.get('metric', '')) ? url.get('metric') : 'final'))
  const [dim, setDim] = useState(() => (DIMS.some((m) => m.key === url.get('dim', '')) ? url.get('dim') : 'category'))
  const [problem, setProblem] = useState(() => url.get('pid', ''))
  const [visible, setVisible] = useState(null)
  const [hoveredSeries, setHoveredSeries] = useState(null)
  const [expanded, setExpanded] = useState(false)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)
  const boxRef = useRef(null)
  const [boxW, setBoxW] = useState(0)

  const approved = useMemo(() => filterByContributor(filterByModels(
    (data.records || []).filter(isApproved), focusModels), focusContributor), [data.records, focusModels, focusContributor])
  const series = useMemo(() => seriesList(approved), [approved])
  const selectAll = useCallback(() => setVisible(new Set(series)), [series])
  const selectNone = useCallback(() => setVisible(new Set()), [])
  const selectTop5 = useCallback((n = 5) => setVisible(new Set(series.slice(0, n))), [series])
  const soloSeries = useCallback((s) => setVisible(new Set([s])), [])
  const colorMap = useMemo(
    () => seriesColorMap(approved, { vendorOf, dark: theme !== 'light' }),
    [approved, vendorOf, theme])
  const problemOptions = useMemo(() => {
    const pids = new Set(approved.map((r) => r.pid))
    return Object.values(data.problems || {}).filter((p) => pids.has(p.pid))
  }, [approved, data.problems])

  const candidateTags = useMemo(() => {
    const tagSet = new Set()
    for (const p of Object.values(data.problems || {})) {
      for (const t of (p.tags || [])) {
        const trimmed = typeof t === 'string' ? t.trim() : String(t || '').trim()
        if (trimmed) tagSet.add(trimmed)
      }
    }
    for (const r of approved) {
      const pTags = data.problems?.[r.pid]?.tags
      if (Array.isArray(pTags) && pTags.length) {
        for (const t of pTags) {
          const trimmed = typeof t === 'string' ? t.trim() : String(t || '').trim()
          if (trimmed) tagSet.add(trimmed)
        }
      } else if (Array.isArray(r.categories) && r.categories.length) {
        for (const t of r.categories) {
          const trimmed = typeof t === 'string' ? t.trim() : String(t || '').trim()
          if (trimmed) tagSet.add(trimmed)
        }
      }
    }
    const list = [...tagSet]
    const catIndex = (t) => {
      const idx = CATEGORY_ORDER.indexOf(t)
      return idx >= 0 ? idx : 9999
    }
    return list.sort((a, b) => {
      const ia = catIndex(a)
      const ib = catIndex(b)
      if (ia !== ib) return ia - ib
      return a.localeCompare(b, 'zh-Hans-CN')
    })
  }, [data.problems, approved])

  useEffect(() => {
    setVisible(new Set(series))
  }, [series.join('|')])

  /* 尺寸：0 = 自适应容器；否则用户指定边长（正方形舞台） */
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setBoxW(Math.round(e.contentRect.width))
    })
    ro.observe(el)
    setBoxW(Math.round(el.clientWidth))
    return () => ro.disconnect()
  }, [expanded])

  const stageStyle = useMemo(() => {
    const avail = boxW || (expanded ? Math.min(window.innerWidth - 80, window.innerHeight - 240) : Math.min(window.innerWidth - 120, 900))
    const auto = Math.max(280, Math.min(avail, expanded ? avail : Math.min(avail, 820)))
    const side = radarSize > 0 ? radarSize : auto
    return { width: `${side}px`, height: `${side}px`, maxWidth: '100%' }
  }, [radarSize, boxW, expanded])

  const pick = useCallback((key, patch) => {
    if (key === 'metric') setMetric(patch)
    if (key === 'dim') setDim(patch)
    if (key === 'pid') setProblem(patch)
    url.set(key === 'pid' ? 'pid' : key, patch)
  }, [url])

  useEffect(() => {
    if (!canvasRef.current || !visible) return undefined
    if (chartRef.current) chartRef.current.destroy()
    if (dim === 'problem' && !problem && problemOptions.length) {
      setProblem(problemOptions[0].pid)
      return undefined
    }

    const axisOf = dim === 'category'
      ? (r) => {
          const p = data.problems?.[r.pid]
          if (p && Array.isArray(p.tags) && p.tags.length > 0) {
            return p.tags.map((t) => (typeof t === 'string' ? t.trim() : String(t || '').trim())).filter(Boolean)
          }
          if (Array.isArray(r.categories) && r.categories.length > 0) {
            return r.categories.map((t) => (typeof t === 'string' ? t.trim() : String(t || '').trim())).filter(Boolean)
          }
          return null
        }
      : dim === 'difficulty'
        ? (r) => difficultyName(r.difficulty)
        : (r) => (r.pid === problem ? '该题' : null)

    let candidates = []
    if (dim === 'category') candidates = candidateTags.length ? candidateTags : [...CATEGORY_ORDER]
    else if (dim === 'difficulty') candidates = DIFF_LEVELS.map((d) => difficultyName(d))
    else candidates = ['该题']

    const shown = series.filter((s) => visible.has(s))
    const statsBySeries = new Map()
    for (const s of series) {
      statsBySeries.set(s, axisStats(approved.filter((r) => seriesKey(r) === s), axisOf, metric))
    }
    /* 需求 5：没有任何可见数据的轴直接隐藏（不留空角） */
    const labels = dim === 'problem'
      ? candidates
      : candidates.filter((l) => shown.some((s) => statsBySeries.get(s)?.has(l)))

    const tc = themeColors()

    if (dim === 'problem') {
      // 单题模式：轴 = 各 AI 组合，单系列，按值降序
      const entries = []
      for (const s of shown.length ? shown : series) {
        const st = statsBySeries.get(s).get('该题')
        if (st) entries.push({ s, st })
      }
      entries.sort((a, b) => b.st.value - a.st.value)
      const labelsP = entries.map((e) => e.s)
      const datasets = [{
        label: problemOptions.find((p) => p.pid === problem)?.title || problem,
        data: entries.map((e) => Number(e.st.value.toFixed(1))),
        borderColor: tc.accent,
        borderWidth: 2,
        backgroundColor: `${tc.accent}22`,
        pointBackgroundColor: entries.map((e) => colorMap.get(e.s) || tc.accent),
        pointBorderColor: '#ffffff',
        pointBorderWidth: 1.5,
        pointRadius: 4,
        pointHoverRadius: 7,
        pointHitRadius: 16,
        spanGaps: false,
        _stats: entries.map((e) => e.st),
        _models: entries.map((e) => e.s),
      }]
      chartRef.current = makeChart(canvasRef.current, {
        type: 'radar',
        data: { labels: labelsP, datasets },
        options: radarOptions(metric, tc, labelsP.length, 'problem'),
      })
      return undefined
    }

    if (!labels.length) {
      chartRef.current = null
      return undefined
    }

    const datasets = shown.map((s) => {
      const stats = statsBySeries.get(s)
      const isHovered = hoveredSeries === s
      const hasHover = Boolean(hoveredSeries)
      const baseColor = colorMap.get(s) || tc.accent
      const alphaFill = hasHover ? (isHovered ? '35' : '04') : '10'

      return {
        label: s,
        data: labels.map((l) => {
          const st = stats.get(l)
          return st ? Number(st.value.toFixed(1)) : null
        }),
        borderColor: hasHover && !isHovered ? `${baseColor}30` : baseColor,
        borderWidth: isHovered ? 3.5 : (hasHover ? 1 : 1.8),
        backgroundColor: `${baseColor}${alphaFill}`,
        pointBackgroundColor: hasHover && !isHovered ? `${baseColor}40` : baseColor,
        pointBorderColor: '#ffffff',
        pointBorderWidth: isHovered ? 2 : 1.5,
        pointRadius: isHovered ? 5.5 : (hasHover ? 2.5 : 4),
        pointHoverRadius: 7,
        pointHitRadius: 16,
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: baseColor,
        pointHoverBorderWidth: 2.5,
        order: isHovered ? -1 : 1,
        spanGaps: false,
        _stats: labels.map((l) => stats.get(l) || null),
      }
    })
    chartRef.current = makeChart(canvasRef.current, {
      type: 'radar',
      data: { labels, datasets },
      options: radarOptions(metric, tc, labels.length, dim),
    })
    return undefined
  }, [approved, series, visible, metric, dim, problem, theme, colorMap, stageStyle.width, problemOptions, candidateTags])

  /* 悬停单模高亮：直接以 0ms 动画热更新样式，不触发图表销毁重绘 */
  useEffect(() => {
    const chart = chartRef.current
    if (!chart || dim === 'problem') return
    const hasHover = Boolean(hoveredSeries)
    chart.data.datasets.forEach((ds) => {
      const isHovered = hoveredSeries === ds.label
      const baseColor = colorMap.get(ds.label) || '#5ad9ff'
      const alphaFill = hasHover ? (isHovered ? '35' : '04') : '10'
      ds.borderColor = hasHover && !isHovered ? `${baseColor}30` : baseColor
      ds.borderWidth = isHovered ? 3.5 : (hasHover ? 1 : 1.8)
      ds.backgroundColor = `${baseColor}${alphaFill}`
      ds.pointRadius = isHovered ? 5.5 : (hasHover ? 2.5 : 4)
      ds.pointBackgroundColor = hasHover && !isHovered ? `${baseColor}40` : baseColor
      ds.pointBorderWidth = isHovered ? 2 : 1.5
      ds.order = isHovered ? -1 : 1
    })
    chart.update('none')
  }, [hoveredSeries, colorMap, dim])

  useEffect(() => () => { chartRef.current?.destroy() }, [])

  useEffect(() => {
    if (!expanded) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', onKey)
    document.body.classList.add('modal-open')
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.classList.remove('modal-open')
    }
  }, [expanded])

  const candidateCount = (
    dim === 'category'
      ? (candidateTags.length || CATEGORY_ORDER.length)
      : dim === 'difficulty'
        ? DIFF_LEVELS.length
        : 1
  )

  return (
    <div className={`card ${expanded ? 'expanded' : ''}`} id="radar-card">
      <div className="card-head">
        <h2>能力雷达</h2>
        <div className="seg">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? 'active' : ''} onClick={() => pick('metric', m.key)}>{m.label}</button>
          ))}
        </div>
        <div className="seg">
          {DIMS.map((m) => (
            <button key={m.key} className={dim === m.key ? 'active' : ''} onClick={() => pick('dim', m.key)}>{m.label}</button>
          ))}
        </div>
        {dim === 'problem' && (
          <select className="mini-select" value={problem} onChange={(e) => pick('pid', e.target.value)} aria-label="选择题目">
            {problemOptions.map((p) => <option key={p.pid} value={p.pid}>{p.pid} · {p.title}</option>)}
          </select>
        )}
        <div className="card-tools">
          <label className="slider" title="雷达图尺寸（0 = 自适应铺满）">
            尺寸
            <input
              type="range" min="0" max="1200" step="40" value={radarSize}
              style={{ '--rw': '120px', '--fill': `${Math.round((radarSize / 1200) * 100)}%` }}
              onChange={(e) => setRadarSize(Number(e.target.value))}
            />
            <output>{radarSize === 0 ? '自适应' : `${radarSize}px`}</output>
            {radarSize !== 0 && (
              <button className="btn small ghost" onClick={() => setRadarSize(0)} title="恢复自适应">重置</button>
            )}
          </label>
          <button className="btn small ghost" onClick={() => setExpanded((v) => !v)} title="全屏放大（Esc 退出）">
            {expanded ? '✕ 退出全屏' : '⛶ 全屏'}
          </button>
        </div>
      </div>
      <SeriesLegend
        seriesList={series}
        colorMap={colorMap}
        visible={visible}
        vendorOf={vendorOf}
        hoveredSeries={hoveredSeries}
        onToggle={(s) => setVisible((v) => {
          const next = new Set(v)
          if (next.has(s)) next.delete(s)
          else next.add(s)
          return next
        })}
        onHover={setHoveredSeries}
        onSelectAll={selectAll}
        onClear={selectNone}
        onSelectTop={selectTop5}
        onSolo={soloSeries}
      />
      <div className="chart-wrap radar-box" ref={boxRef}>
        <div className="radar-stage" style={stageStyle}>
          <canvas ref={canvasRef} id="radar" />
        </div>
      </div>
      <div className="radar-hint">
        {metric === 'avgscore'
          ? '轴值 = 该维度全部有分数轮次的均分（0–100）；未作答的维度空缺不连线。'
          : '轴值 = AC 率（%）；未作答的维度空缺不连线、不按 0% 计。'}
        {' '}<b>没有任何可见数据的轴已自动隐藏</b>（当前维度共 {candidateCount} 支候选轴）。
        鼠标悬停任意角点可查看<b>各模型得分与作答明细</b>；
        图例支持<b>全选/清空/前5</b>与<b>悬停高亮单模型</b>（双击可单看）。
      </div>
    </div>
  )
}

function radarOptions(metric, tc, labelCount, dim) {
  const dense = labelCount > 9
  return {
    animation: { duration: 320 },
    interaction: {
      mode: 'index',
      intersect: false,
    },
    onHover: (event, elements, chart) => {
      if (chart?.canvas) {
        chart.canvas.style.cursor = elements && elements.length > 0 ? 'pointer' : 'default'
      }
    },
    scales: {
      r: {
        min: 0,
        max: 100,
        ticks: {
          stepSize: 20,
          color: tc.text,
          backdropColor: 'transparent',
          font: { size: 10 },
          showLabelBackdrop: false,
          callback: (v) => `${v}${metric === 'avgscore' ? '分' : '%'}`,
        },
        grid: { color: tc.grid },
        angleLines: { color: tc.grid },
        pointLabels: {
          color: tc.text,
          font: { size: dense ? 10 : 12, family: '"Chakra Petch", "Microsoft YaHei", sans-serif' },
        },
      },
    },
    plugins: {
      legend: { display: false },
      tooltip: {
        enabled: true,
        usePointStyle: true,
        boxPadding: 4,
        padding: 10,
        backgroundColor: 'rgba(15, 23, 42, 0.94)',
        borderColor: tc.grid || 'rgba(143,162,188,0.25)',
        borderWidth: 1,
        titleColor: tc.accent || '#5ad9ff',
        titleFont: { size: 12, weight: 'bold' },
        bodyFont: { size: 11, family: '"Chakra Petch", "Microsoft YaHei", sans-serif' },
        itemSort: (a, b) => (b.raw ?? 0) - (a.raw ?? 0),
        filter: (item) => item.raw !== null && item.raw !== undefined && !Number.isNaN(item.raw),
        callbacks: {
          title: (items) => {
            if (!items.length) return ''
            const l = items[0].label
            if (dim === 'problem') return `模型：${l}`
            const dimName = dim === 'category' ? '算法标签' : dim === 'difficulty' ? '难度' : '维度'
            return `【${dimName}】${l}`
          },
          label: (item) => {
            const val = item.formatted.value
            if (val === null || val === undefined || item.raw === null) return null
            const st = item.dataset._stats?.[item.dataIndex]
            const name = item.dataset.label
            if (!st) return ` ${name}: ${val}`
            if (metric === 'avgscore') {
              return ` ${name}: ${val} 分（作答 ${st.answered} 轮）`
            }
            return ` ${name}: ${val}%（通过 ${st.passed}/${st.answered} 题）`
          },
        },
      },
    },
  }
}
