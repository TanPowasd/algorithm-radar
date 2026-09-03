import { useMemo, useState } from 'react'
import { useApp } from '../state'
import {
  difficultyName, isApproved, isPassed, matrixCell, metricScore, seriesKey, seriesList,
  scoreTierClass, filterByModels,
} from '../aggregate'

const MODES = [
  { key: 'score', label: '均分' },
  { key: 'finalscore', label: '最终分' },
  { key: 'status', label: '通过状态' },
]

export default function MatrixView({ onOpenDetail }) {
  const { data, focusModels } = useApp()
  const [mode, setMode] = useState('score')

  const approved = useMemo(() => filterByModels(
    (data.records || []).filter(isApproved), focusModels), [data.records, focusModels])
  const series = useMemo(() => seriesList(approved), [approved])
  const problems = useMemo(() => {
    const list = Object.values(data.problems || {})
    list.sort((a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.pid.localeCompare(b.pid))
    return list
  }, [data.problems])

  const summary = useMemo(() => {
    const map = new Map()
    for (const s of series) {
      const recs = approved.filter((r) => seriesKey(r) === s)
      let sum = 0
      let n = 0
      for (const r of recs) {
        const v = metricScore(r, mode === 'finalscore' ? 'final' : 'avgscore')
        if (v !== null) {
          sum += v
          n += 1
        }
      }
      const passRate = recs.length
        ? (recs.filter(isPassed).length / recs.length) * 100
        : null
      map.set(s, { avg: n ? sum / n : null, n, passRate, total: recs.length })
    }
    return map
  }, [approved, series, mode])

  if (!series.length) return <div className="empty">暂无已审核的测评数据</div>

  return (
    <div className="card" id="matrix-card">
      <div className="card-head">
        <h2>AI × 题目矩阵</h2>
        <div className="seg">
          {MODES.map((m) => (
            <button key={m.key} className={mode === m.key ? 'active' : ''} onClick={() => setMode(m.key)}>{m.label}</button>
          ))}
        </div>
        <div className="card-tools">
          <span className="hint">{mode === 'status' ? '单元格 = 最终轮判定' : '单元格 = 均分（0–100）'}</span>
        </div>
      </div>
      <div className="matrix-wrap" id="matrix-wrap">
        <table className="matrix">
          <thead>
            <tr>
              <th className="row-head">题目</th>
              {series.map((s) => <th key={s} title={s}>{s}</th>)}
            </tr>
          </thead>
          <tbody>
            {problems.map((p) => (
              <tr key={p.pid}>
                <th className="row-head" data-detail={p.pid} onClick={() => onOpenDetail && onOpenDetail(p.pid)} title={`${p.pid} ${p.title || ''}`}>
                  {p.pid} · {p.title || '（未命名）'}
                  <span className="chain">　{difficultyName(p.difficulty)}</span>
                </th>
                {series.map((s) => {
                  const cell = matrixCell(approved, s, p.pid)
                  if (cell.kind === 'none') {
                    return <td key={s} className="mcell none">·</td>
                  }
                  if (mode === 'status') {
                    const cls = cell.kind === 'ac' ? 'ac' : cell.kind === 'fail' ? 'fail' : 'giveup'
                    const label = cell.kind === 'ac' ? 'AC' : cell.kind === 'fail' ? '未过' : '放弃'
                    return <td key={s} className={`mcell ${cls}`} title={`${cell.passed}/${cell.total} 条最终通过`}>{label}</td>
                  }
                  const info = mode === 'finalscore' ? cell.finalInfo : cell.scoreInfo
                  if (!info) return <td key={s} className="mcell score-na">—</td>
                  const avg = Math.round(info.avg)
                  return <td key={s} className={`mcell ${scoreTierClass(avg)}`} title={`n=${info.n}（有分数轮次）`}>{avg}</td>
                })}
              </tr>
            ))}
            <tr className="sum-row">
              <th className="row-head">整体</th>
              {series.map((s) => {
                const info = summary.get(s)
                if (mode === 'status') {
                  return <td key={s} className="mcell" title={`${info.passRate?.toFixed(1)}%（${info.total} 条）`}>
                    {info.passRate === null ? '—' : `${Math.round(info.passRate)}%`}
                  </td>
                }
                return (
                  <td key={s} className={`mcell ${info.avg === null ? 'score-na' : scoreTierClass(Math.round(info.avg))}`} title={`n=${info.n}`}>
                    {info.avg === null ? '—' : Math.round(info.avg)}
                  </td>
                )
              })}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="matrix-hint">
        行 = 已发布题目（按难度升序），列 = 模型；点击行头或单元格查看题目详情与该模型记录。
        {mode === 'status' ? ' 状态口径：最终轮 AC / 未过 / 放弃（未解出）。' : ' 均分 = 该组合全部有分数轮次；最终分 = 每条记录最后一个有分数轮次。'}
      </div>
    </div>
  )
}
