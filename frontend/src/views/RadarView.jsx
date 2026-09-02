import { useEffect, useMemo, useRef, useState } from 'react'
import { useApp } from '../state'
import { makeChart, themeColors } from '../components/charts'
import SeriesLegend from '../components/SeriesLegend'
import {
  axisStats, CATEGORY_ORDER, difficultyName, isApproved, seriesColorMap, seriesKey, seriesList,
} from '../aggregate'

const METRICS = [
  { key: 'final', label: '最终 AC 率' },
  { key: 'first', label: '首轮 AC 率' },
  { key: 'avgscore', label: '平均得分' },
]
const DIMS = [
  { key: 'category', label: '按算法类别' },
  { key: 'difficulty', label: '按难度' },
  { key: 'problem', label: '单题对比' },
]

export default function RadarView() {
  const { data, theme } = useApp()
  const [metric, setMetric] = useState('final')
  const [dim, setDim] = useState('category')
  const [problem, setProblem] = useState('')
  const [visible, setVisible] = useState(null)
  const canvasRef = useRef(null)
  const chartRef = useRef(null)

  const approved = useMemo(() => (data.records || []).filter(isApproved), [data.records])
  const series = useMemo(() => seriesList(approved), [approved])
  const colorMap = useMemo(() => seriesColorMap(approved), [approved])
  const problemOptions = useMemo(() => {
    const pids = new Set(approved.map((r) => r.pid))
    return Object.values(data.problems || {}).filter((p) => pids.has(p.pid))
  }, [approved, data.problems])

  useEffect(() => {
    setVisible(new Set(series))
  }, [series.join('|')])

  useEffect(() => {
    if (!canvasRef.current || !visible) return
    if (chartRef.current) chartRef.current.destroy()
    if (dim === 'problem' && !problem && problemOptions.length) setProblem(problemOptions[0].pid)

    const axisOf = dim === 'category'
      ? (r) => { const c = (r.categories || []).find((x) => CATEGORY_ORDER.includes(x)); return c || null }
      : dim === 'difficulty'
        ? (r) => difficultyName(r.difficulty)
        : (r) => (r.pid === problem ? '该题' : null)

    let labels = []
    if (dim === 'category') labels = [...CATEGORY_ORDER]
    else if (dim === 'difficulty') labels = Object.values({ 0: 0, 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 }).map((d) => difficultyName(d))
    else labels = ['该题']

    const tc = themeColors()
    const statsBySeries = new Map()
    for (const s of series) {
      const recs = approved.filter((r) => seriesKey(r) === s)
      statsBySeries.set(s, axisStats(recs, axisOf, metric))
    }
    if (dim === 'problem') {
      // 单题模式：轴 = 各 AI 组合，单系列，按值降序
      const entries = []
      for (const s of series) {
        const st = statsBySeries.get(s).get('该题')
        if (st) entries.push({ s, st })
      }
      entries.sort((a, b) => b.st.value - a.st.value)
      const labelsP = entries.map((e) => e.s)
      const datasets = [{
        label: problemOptions.find((p) => p.pid === problem)?.title || problem,
        data: entries.map((e) => Number(e.st.value.toFixed(1))),
        borderColor: tc.accent,
        backgroundColor: tc.accent + '22',
        pointBackgroundColor: tc.accent,
        spanGaps: false,
        _stats: entries.map((e) => e.st),
      }]
      chartRef.current = makeChart(canvasRef.current, {
        type: 'radar',
        data: { labels: labelsP, datasets },
        options: radarOptions(metric, tc),
      })
      return
    }

    const shown = series.filter((s) => visible.has(s))
    const datasets = shown.map((s) => {
      const stats = statsBySeries.get(s)
      return {
        label: s,
        data: labels.map((l) => {
          const st = stats.get(l)
          return st ? Number(st.value.toFixed(1)) : null
        }),
        borderColor: colorMap.get(s),
        backgroundColor: colorMap.get(s) + '22',
        pointBackgroundColor: colorMap.get(s),
        spanGaps: false,
        _stats: labels.map((l) => stats.get(l) || null),
      }
    })
    chartRef.current = makeChart(canvasRef.current, {
      type: 'radar',
      data: { labels, datasets },
      options: radarOptions(metric, tc),
    })
  }, [approved, series, visible, metric, dim, problem, theme, colorMap])

  return (
    <div className="card" id="radar-card">
      <div className="card-head">
        <h2>能力雷达</h2>
        <div className="seg">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? 'active' : ''} onClick={() => setMetric(m.key)}>{m.label}</button>
          ))}
        </div>
        <div className="seg">
          {DIMS.map((m) => (
            <button key={m.key} className={dim === m.key ? 'active' : ''} onClick={() => setDim(m.key)}>{m.label}</button>
          ))}
        </div>
        {dim === 'problem' && (
          <select
            value={problem}
            onChange={(e) => setProblem(e.target.value)}
            style={{ background: 'var(--surface-2)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, padding: '4px 8px' }}
          >
            {problemOptions.map((p) => <option key={p.pid} value={p.pid}>{p.pid} · {p.title}</option>)}
          </select>
        )}
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
        <canvas ref={canvasRef} id="radar" />
      </div>
      <div className="radar-hint">
        {metric === 'avgscore'
          ? '轴值 = 该维度全部有分数轮次的均分（0–100）；未作答的维度空缺不连线。'
          : '轴值 = AC 率（%）；未作答的维度空缺不连线、不按 0% 计。点击图例可隐藏/显示系列。'}
      </div>
    </div>
  )
}

function radarOptions(metric, tc) {
  return {
    scales: {
      r: {
        min: 0,
        max: 100,
        ticks: { stepSize: 20, color: tc.text, backdropColor: 'transparent', callback: (v) => `${v}${metric === 'avgscore' ? '分' : '%'}` },
        grid: { color: tc.grid },
        angleLines: { color: tc.grid },
        pointLabels: { color: tc.text, font: { size: 11 } },
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
