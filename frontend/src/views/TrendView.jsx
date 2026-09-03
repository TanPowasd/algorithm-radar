import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state'
import { makeChart, themeColors } from '../components/charts'
import SeriesLegend from '../components/SeriesLegend'
import { isApproved, metricScore, seriesColorMap, seriesKey, seriesList, filterByModels } from '../aggregate'
import { useUrlState } from '../hooks/useUrlState'

const METRICS = [
  { key: 'first', label: '首轮分' },
  { key: 'final', label: '最终分' },
  { key: 'avgscore', label: '全轮均分' },
]

export default function TrendView() {
  const { data, theme, focusModels, vendorOf } = useApp()
  const url = useUrlState('tr')
  const [metric, setMetric] = useState(() => (METRICS.some((m) => m.key === url.get('metric', '')) ? url.get('metric') : 'avgscore'))
  const [visible, setVisible] = useState(null)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)

  const approved = useMemo(() => filterByModels(
    (data.records || []).filter(isApproved), focusModels), [data.records, focusModels])
  const series = useMemo(() => seriesList(approved), [approved])
  const colorMap = useMemo(
    () => seriesColorMap(approved, { vendorOf, dark: theme !== 'light' }),
    [approved, vendorOf, theme])

  useEffect(() => {
    setVisible(new Set(series))
  }, [series.join('|')])

  useEffect(() => {
    if (!canvasRef.current || !visible) return undefined
    if (chartRef.current) chartRef.current.destroy()
    if (!series.length) return undefined
    const tc = themeColors()
    const dates = [...new Set(approved.map((r) => r.date))].sort()
    const shown = series.filter((s) => visible.has(s))
    const datasets = shown.map((s) => {
      const recs = approved.filter((r) => seriesKey(r) === s)
      return {
        label: s,
        data: dates.map((d) => {
          const day = recs.filter((r) => r.date === d)
          if (!day.length) return null
          const vals = day.map((r) => metricScore(r, metric)).filter((v) => v !== null)
          if (!vals.length) return null
          return Number((vals.reduce((a, c) => a + c, 0) / vals.length).toFixed(1))
        }),
        borderColor: colorMap.get(s),
        backgroundColor: `${colorMap.get(s)}22`,
        pointBackgroundColor: colorMap.get(s),
        borderWidth: 2,
        pointRadius: 3,
        pointHoverRadius: 5,
        tension: 0.3,
        spanGaps: false,
      }
    })
    chartRef.current = makeChart(canvasRef.current, {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        animation: { duration: 260 },
        scales: {
          x: { grid: { color: tc.grid }, ticks: { color: tc.text, maxRotation: 0, font: { size: 10, family: '"JetBrains Mono", monospace' } } },
          y: { min: 0, max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } },
        },
        interaction: { mode: 'nearest', intersect: false },
        plugins: { legend: { display: false } },
      },
    })
    return undefined
  }, [approved, series, visible, metric, theme, colorMap])

  useEffect(() => () => { chartRef.current?.destroy() }, [])

  const pick = (m) => { setMetric(m); url.set('metric', m) }

  return (
    <div className="card" id="trend-card">
      <div className="card-head">
        <h2>成绩时间趋势</h2>
        <div className="seg">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? 'active' : ''} onClick={() => pick(m.key)}>{m.label}</button>
          ))}
        </div>
        <div className="card-tools"><span className="hint">折线颜色 = 厂商（同厂商同色）</span></div>
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
      <div className="chart-wrap">
        <canvas ref={canvasRef} id="trend" />
      </div>
      <div className="trend-hint">
        横轴 = 出现过测评的日期；每个点 = 该模型当日测评口径均值；当日无数据则断线（spanGaps）。点击图例可隐藏/显示系列。
      </div>
    </div>
  )
}
