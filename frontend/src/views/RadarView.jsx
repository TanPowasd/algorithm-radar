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
  const [expanded, setExpanded] = useState(false)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)
  const boxRef = useRef(null)
  const [boxW, setBoxW] = useState(0)

  const approved = useMemo(() => filterByContributor(filterByModels(
    (data.records || []).filter(isApproved), focusModels), focusContributor), [data.records, focusModels, focusContributor])
  const series = useMemo(() => seriesList(approved), [approved])
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
        backgroundColor: `${tc.accent}22`,
        pointBackgroundColor: entries.map((e) => colorMap.get(e.s) || tc.accent),
        spanGaps: false,
        _stats: entries.map((e) => e.st),
        _models: entries.map((e) => e.s),
      }]
      chartRef.current = makeChart(canvasRef.current, {
        type: 'radar',
        data: { labels: labelsP, datasets },
        options: radarOptions(metric, tc, labelsP.length),
      })
      return undefined
    }

    if (!labels.length) {
      chartRef.current = null
      return undefined
    }

    const datasets = shown.map((s) => {
      const stats = statsBySeries.get(s)
      return {
        label: s,
        data: labels.map((l) => {
          const st = stats.get(l)
          return st ? Number(st.value.toFixed(1)) : null
        }),
        borderColor: colorMap.get(s),
        backgroundColor: `${colorMap.get(s)}22`,
        pointBackgroundColor: colorMap.get(s),
        spanGaps: false,
        _stats: labels.map((l) => stats.get(l) || null),
      }
    })
    chartRef.current = makeChart(canvasRef.current, {
      type: 'radar',
      data: { labels, datasets },
      options: radarOptions(metric, tc, labels.length),
    })
    return undefined
  }, [approved, series, visible, metric, dim, problem, theme, colorMap, stageStyle.width, problemOptions, candidateTags])

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
        onToggle={(s) => setVisible((v) => {
          const next = new Set(v)
          if (next.has(s)) next.delete(s)
          else next.add(s)
          return next
        })}
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
        {' '}<b>没有任何可见数据的轴已自动隐藏</b>（当前维度共 {candidateCount} 支候选轴），
        图例点击可显示/隐藏系列；尺寸滑杆与全屏按本机记忆。
      </div>
    </div>
  )
}

function radarOptions(metric, tc, labelCount) {
  const dense = labelCount > 9
  return {
    animation: { duration: 320 },
    scales: {
      r: {
        min: 0,
        max: 100,
        ticks: {
          stepSize: 20, color: tc.text, backdropColor: 'transparent',
          font: { size: 10 }, showLabelBackdrop: false,
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
        callbacks: {
          label: (item) => {
            const st = item.dataset._stats?.[item.dataIndex]
            const val = item.formatted.value
            if (!st) return `${item.dataset.label}: ${val}`
            if (metric === 'avgscore') return `${item.dataset.label}: ${val} 分（n=${st.answered}）`
            return `${item.dataset.label}: ${val}%（${st.passed}/${st.answered}）`
          },
        },
      },
    },
  }
}
