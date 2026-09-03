import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state'
import { makeChart, themeColors } from '../components/charts'
import {
  isApproved, roundsAvg, seriesKey, seriesList, THINKING_LEVELS, THINKING_LABELS,
  filterByModels,
} from '../aggregate'

const BAR_MIN_SAMPLES = 5
const LS_EXCLUDE = 'radar.bar.excludedPids'

function loadExcluded() {
  try {
    const raw = localStorage.getItem(LS_EXCLUDE)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch {
    return new Set()
  }
}

/** 柱顶标注 n 的插件 */
const barTopLabel = {
  id: 'barTopLabel',
  afterDatasetsDraw(chart) {
    const { ctx } = chart
    const meta0 = chart.getDatasetMeta(0)
    if (!meta0) return
    ctx.save()
    ctx.font = '600 11px sans-serif'
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
  const { data, theme, focusModels } = useApp()
  const [excluded, setExcluded] = useState(loadExcluded)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 640)

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth <= 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const approved = useMemo(() => filterByModels(
    (data.records || []).filter(isApproved), focusModels), [data.records, focusModels])
  const combos = useMemo(() => {
    // 模型 × 思考等级，均分降序，n≥5 门槛（排除题后重算）
    const list = []
    for (const s of seriesList(approved)) {
      for (const t of THINKING_LEVELS) {
        const recs = approved.filter((r) => seriesKey(r) === s && r.thinking === t && !excluded.has(r.pid))
        const info = roundsAvg(recs)
        if (info && info.n >= BAR_MIN_SAMPLES) {
          list.push({ label: `${s} · ${THINKING_LABELS[t]}`, series: s, thinking: t, avg: info.avg, n: info.n })
        }
      }
    }
    list.sort((a, b) => b.avg - a.avg)
    return list
  }, [approved, excluded])

  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) chartRef.current.destroy()
    if (!combos.length) return
    const tc = themeColors()
    const horizontal = isMobile
    chartRef.current = makeChart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: combos.map((c) => c.label),
        datasets: [{
          label: '均分',
          data: combos.map((c) => Number(c.avg.toFixed(1))),
          backgroundColor: tc.accent + '22',
          borderColor: tc.accent,
          borderWidth: 1.5,
          borderRadius: 3,
          _ns: combos.map((c) => c.n),
        }],
      },
      options: {
        indexAxis: horizontal ? 'y' : 'x',
        scales: {
          x: horizontal
            ? { min: 0, max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } }
            : { grid: { display: false }, ticks: { color: tc.text, maxRotation: 60, minRotation: 30, font: { size: 10 } } },
          y: horizontal
            ? { grid: { display: false }, ticks: { color: tc.text, font: { size: 10 } } }
            : { min: 0, max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } },
        },
        layout: { padding: { top: 22, right: 30 } },
        plugins: { legend: { display: false } },
      },
      plugins: [barTopLabel],
    })
  }, [combos, theme, isMobile])

  const toggleExclude = (pid) => {
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(pid)) next.delete(pid)
      else next.add(pid)
      localStorage.setItem(LS_EXCLUDE, JSON.stringify([...next]))
      return next
    })
  }

  const usedPids = useMemo(() => {
    const set = new Set()
    approved.forEach((r) => set.add(r.pid))
    return [...set].sort()
  }, [approved])

  return (
    <div className="card" id="thinking-bar-card">
      <div className="card-head">
        <h2>模型 × 思考等级 均分</h2>
        <div className="card-tools"><span className="hint">仅显示样本量 n≥{BAR_MIN_SAMPLES} 的组合</span></div>
      </div>
      <div className="bar-chips" id="bar-exclude">
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
          : <div className="empty">没有满足 n≥{BAR_MIN_SAMPLES} 的「模型 × 思考等级」组合</div>}
      </div>
      <div className="tbar-hint">
        均分 = 该组合全部有分数轮次（0–100）；柱端标注样本量 n。点击上方题号 chip 可把该题从口径中排除（仅影响本图，本机记忆）。
      </div>
    </div>
  )
}
