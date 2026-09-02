import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state'
import { makeChart, themeColors } from '../components/charts'
import SeriesLegend from '../components/SeriesLegend'
import { isApproved, metricScore, seriesColorMap, seriesKey, seriesList } from '../aggregate'

const METRICS = [
  { key: 'first', label: '首轮分' },
  { key: 'final', label: '最终分' },
  { key: 'avgscore', label: '全轮均分' },
]

export default function TrendView() {
  const { data, theme } = useApp()
  const [metric, setMetric] = useState('avgscore')
  const [visible, setVisible] = useState(null)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)

  const approved = useMemo(() => (data.records || []).filter(isApproved), [data.records])
  const series = useMemo(() => seriesList(approved), [approved])
  const colorMap = useMemo(() => seriesColorMap(approved), [approved])

  useEffect(() => {
    setVisible(new Set(series))
  }, [series.join('|')])

  useEffect(() => {
    if (!canvasRef.current || !visible) return
    if (chartRef.current) chartRef.current.destroy()
    if (!series.length) return
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
        backgroundColor: colorMap.get(s) + '22',
        pointBackgroundColor: colorMap.get(s),
        tension: 0.3,
        spanGaps: false,
      }
    })
    chartRef.current = makeChart(canvasRef.current, {
      type: 'line',
      data: { labels: dates, datasets },
      options: {
        scales: {
          x: { grid: { color: tc.grid }, ticks: { color: tc.text, maxRotation: 0, font: { size: 10 } } },
          y: { min: 0, max: 100, grid: { color: tc.grid }, ticks: { color: tc.text } },
        },
        interaction: { mode: 'nearest', intersect: false },
        plugins: { legend: { display: false } },
      },
    })
  }, [approved, series, visible, metric, theme, colorMap])

  return (
    <div className="card" id="trend-card">
      <div className="card-head">
        <h2>成绩时间趋势</h2>
        <div className="seg">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? 'active' : ''} onClick={() => setMetric(m.key)}>{m.label}</button>
          ))}
        </div>
      </div>
      <SeriesLegend
        seriesList={series}
        colorMap={colorMap}
        visible={visible}
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
