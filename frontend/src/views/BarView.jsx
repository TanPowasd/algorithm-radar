import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state'
import { makeChart, themeColors } from '../components/charts'
import {
  isApproved, roundsAvg, seriesKey, seriesList, THINKING_LEVELS, THINKING_LABELS, filterByModels, filterByContributor,
} from '../aggregate'
import { fillLevelBar, hexRgba, levelSwatchStyle, vendorColorMap } from '../palette'
import { useUrlState } from '../hooks/useUrlState'

const LS_EXCLUDE = 'radar.bar.excludedPids'
const MAX_N = 50

function loadExcluded() {
  try {
    const raw = localStorage.getItem(LS_EXCLUDE)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

function barRect(el, horizontal) {
  const thick = (horizontal ? el.height : el.width) ?? 8
  if (horizontal) {
    const left = Math.min(el.x, el.base)
    return { x: left, y: el.y - thick / 2, w: Math.abs(el.x - el.base), h: thick }
  }
  return { x: el.x - thick / 2, y: Math.min(el.y, el.base), w: thick, h: Math.abs(el.base - el.y) }
}

/**
 * 柱体绘制插件：厂商主色 + 思考等级纹理（透明度/斜纹密度），
 * 并在柱端标注样本量 n。同厂商不同模型/不同等级因此「同色不同纹」。
 */
const barLevelPaint = {
  id: 'barLevelPaint',
  afterDatasetsDraw(chart) {
    const { ctx } = chart
    const horizontal = chart.options.indexAxis === 'y'
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di)
      if (meta.hidden) return
      meta.data.forEach((el, i) => {
        const color = ds._colors?.[i]
        const thinking = ds._levels?.[i]
        if (!color || !thinking) return
        fillLevelBar(ctx, barRect(el, horizontal), color, thinking)
      })
    })
  },
}

/** 柱顶标注 n 的插件 */
const barTopLabel = {
  id: 'barTopLabel',
  afterDatasetsDraw(chart) {
    const { ctx } = chart
    if (!chart.getDatasetMeta(0)) return
    ctx.save()
    ctx.font = '600 11px "JetBrains Mono", Consolas, monospace'
    ctx.fillStyle = themeColors().text
    const horizontal = chart.options.indexAxis === 'y'
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di)
      if (meta.hidden) return
      meta.data.forEach((bar, i) => {
        const n = ds._ns?.[i]
        if (n === undefined || n === null) return
        const label = `n=${n}`
        if (horizontal) {
          ctx.textAlign = 'left'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, bar.x + 6, bar.y)
        } else {
          ctx.textAlign = 'center'
          ctx.textBaseline = 'bottom'
          ctx.fillText(label, bar.x, bar.y - 4)
        }
      })
    })
    ctx.restore()
  },
}

export default function BarView() {
  const { data, theme, focusModels, focusContributor, vendorOf, barMinSamples, setBarMinSamples } = useApp()
  const url = useUrlState('br')
  const [excluded, setExcluded] = useState(loadExcluded)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 640)
  const [minOverride] = useState(() => url.getNum('min', NaN))

  useEffect(() => {
    if (Number.isFinite(minOverride) && minOverride >= 1) setBarMinSamples(Math.min(MAX_N, Math.round(minOverride)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const approved = useMemo(() => filterByContributor(filterByModels(
    (data.records || []).filter(isApproved), focusModels), focusContributor), [data.records, focusModels, focusContributor])

  const seriesColors = useMemo(
    () => vendorColorMap(seriesList(approved), vendorOf, theme !== 'light'),
    [approved, vendorOf, theme])

  /** 全部组合（不筛阈值）：用于「满足 X / 共 Y」实时计数 */
  const allCombos = useMemo(() => {
    const list = []
    for (const s of seriesList(approved)) {
      const color = seriesColors.get(s) || '#8fa2bc'
      for (const t of THINKING_LEVELS) {
        const recs = approved.filter((r) => seriesKey(r) === s && r.thinking === t && !excluded.has(r.pid))
        const info = roundsAvg(recs)
        if (info) list.push({
          series: s, thinking: t, avg: info.avg, n: info.n, color,
          label: `${s} · ${THINKING_LABELS[t]}`,
        })
      }
    }
    return list
  }, [approved, excluded, seriesColors])

  const combos = useMemo(() => {
    const list = allCombos.filter((c) => c.n >= barMinSamples)
    list.sort((a, b) => b.avg - a.avg)
    return list
  }, [allCombos, barMinSamples])

  useEffect(() => {
    if (!canvasRef.current) return undefined
    if (chartRef.current) chartRef.current.destroy()
    if (!combos.length) return undefined
    const tc = themeColors()
    const horizontal = isMobile
    const colors = combos.map((c) => c.color || tc.accent)
    chartRef.current = makeChart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: combos.map((c) => c.label),
        datasets: [{
          label: '均分',
          data: combos.map((c) => Number(c.avg.toFixed(1))),
          backgroundColor: colors.map((col) => hexRgba(col, 0.16)),
          hoverBackgroundColor: colors.map((col) => hexRgba(col, 0.3)),
          borderWidth: 0,
          borderRadius: 0,
          _ns: combos.map((c) => c.n),
          _colors: colors,
          _levels: combos.map((c) => c.thinking),
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: horizontal ? 'y' : 'x',
        animation: { duration: 260 },
        scales: {
          x: horizontal
            ? { min: 0, max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } }
            : { grid: { display: false }, ticks: { color: tc.text, maxRotation: 62, minRotation: 34, font: { size: 10 } } },
          y: horizontal
            ? { grid: { display: false }, ticks: { color: tc.text, font: { size: 10 } } }
            : { min: 0, max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } },
        },
        layout: { padding: { top: 22, right: 34, bottom: 12, left: 6 } },
        plugins: { legend: { display: false } },
      },
      plugins: [barLevelPaint, barTopLabel],
    })
    return undefined
  }, [combos, theme, isMobile])

  useEffect(() => () => { chartRef.current?.destroy() }, [])

  const toggleExclude = (pid) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      try { localStorage.setItem(LS_EXCLUDE, JSON.stringify([...next])) } catch { /* 忽略 */ }
      return next
    })
  }

  const usedPids = useMemo(() => {
    const set = new Set()
    approved.forEach((r) => set.add(r.pid))
    return [...set].sort()
  }, [approved])

  const maxN = useMemo(() => allCombos.reduce((a, c) => Math.max(a, c.n), 1), [allCombos])
  const setMin = (n) => {
    const v = Math.max(1, Math.min(MAX_N, Math.round(n)))
    setBarMinSamples(v)
    url.set('min', v === 5 ? '' : v)
  }

  return (
    <div className="card" id="thinking-bar-card">
      <div className="card-head">
        <h2>模型 × 思考等级 均分</h2>
        <div className="card-tools">
          <label className="slider" title="最小样本量：低于该值的组合不显示">
            最小样本 n≥
            <input
              type="range" min="1" max={Math.max(MAX_N, Math.min(maxN, MAX_N))} step="1" value={barMinSamples}
              style={{ '--rw': '150px', '--fill': `${Math.round(((barMinSamples - 1) / (MAX_N - 1)) * 100)}%` }}
              onChange={(e) => setMin(Number(e.target.value))}
            />
            <output>{barMinSamples}</output>
          </label>
          <span className="hint">
            满足 <b style={{ color: 'var(--accent)' }}>{combos.length}</b> / 共 {allCombos.length} 个组合
          </span>
        </div>
      </div>

      <div className="legend-group" aria-label="配色说明">
        <span className="legend-note">同厂商同色：</span>
        {[...new Set(combos.map((c) => vendorOf(c.series)))].map((v) => {
          const first = combos.find((c) => vendorOf(c.series) === v)
          return (
            <span className="legend-vendor" key={v}>
              <span className="sw" style={{ background: first?.color || 'var(--border)' }} />
              <b>{v}</b>
              <span className="chain">{combos.filter((c) => vendorOf(c.series) === v).length} 柱</span>
            </span>
          )
        })}
        <span className="legend-note">｜思考等级纹理：</span>
        {THINKING_LEVELS.map((t) => (
          <span className="legend-vendor" key={t}>
            <span className="sw" style={levelSwatchStyle('#8fa2bc', t)} />
            {THINKING_LABELS[t]}
          </span>
        ))}
      </div>

      <div className="bar-chips chips-scroll" id="bar-exclude">
        <span className="chips-label">忽略题目：</span>
        {usedPids.map((pid) => (
          <button key={pid} className={`bar-chip ${excluded.has(pid) ? 'off' : ''}`} onClick={() => toggleExclude(pid)}>
            {pid}
          </button>
        ))}
        {excluded.size > 0 && (
          <button className="bar-chip" onClick={() => {
            setExcluded(new Set())
            localStorage.removeItem(LS_EXCLUDE)
          }}>全部包含</button>
        )}
      </div>

      <div className="chart-wrap bar">
        {combos.length
          ? <canvas ref={canvasRef} id="tbar" />
          : <div className="empty">没有满足 n≥{barMinSamples} 的「模型 × 思考等级」组合，把左上的阈值滑杆拉低试试</div>}
      </div>
      <div className="tbar-hint">
        均分 = 该组合全部有分数轮次（0–100）；柱端标注样本量 n。<b>颜色 = 厂商</b>（同厂商不同模型走同一色系的明度阶梯），
        <b>纹理密度 = 思考等级</b>（Ultra 最实、越往低越虚，关闭思考为点阵）。点击上方题号 chip 可把该题从口径中排除（仅影响本图，本机记忆）。
      </div>
    </div>
  )
}
