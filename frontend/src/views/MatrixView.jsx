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

/** 名次徽章（#1 #2 #3…；前三名特殊色） */
function RankBadge({ rank }) {
  const cls = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : ''
  return <span className={`mrank ${cls}`}>{rank}</span>
}

export default function MatrixView({ onOpenDetail }) {
  const { data, focusModels } = useApp()
  const [mode, setMode] = useState('score')

  const approved = useMemo(() => filterByModels(
    (data.records || []).filter(isApproved), focusModels), [data.records, focusModels])

  // —— 列（AI）：按“每条记录全轮均分再平均”从高到低排，同分按名称；未作答沉底 ——
  const series = useMemo(() => {
    // 预聚合：每个模型的每条记录均分（记录级均分，非轮次级）
    const perModel = new Map() // model -> number[]（该模型每条记录的全轮均分）
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

  // —— 行（题目）：按每题整体均分从高到低排，同分按难度+题号；无分记录题沉底 ——
  const problems = useMemo(() => {
    const list = Object.values(data.problems || {})
    const byPid = new Map() // pid -> number[]（该题每条记录的全轮均分）
    for (const r of approved) {
      const v = metricScore(r, 'avgscore')
      if (v === null) continue
      if (!byPid.has(r.pid)) byPid.set(r.pid, [])
      byPid.get(r.pid).push(v)
    }
    const avgOf = new Map()
    for (const p of list) {
      const arr = byPid.get(p.pid)
      avgOf.set(p.pid, { avg: arr?.length ? arr.reduce((a, c) => a + c, 0) / arr.length : -1 })
    }
    list.sort((a, b) => {
      const da = avgOf.get(a.pid).avg, db = avgOf.get(b.pid).avg
      // 无数据（-1）永远沉底；有数据按均分降序
      if (db !== da) return db - da
      // 均分相同（或都无数据）：按难度升序+题号
      return (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.pid.localeCompare(b.pid)
    })
    return list
  }, [approved, data.problems])

  const summary = useMemo(() => {
    // 一次遍历按模型聚合：mode 决定每条记录取哪个值（avgscore=全轮均分 / final=最终分）
    const byModel = new Map() // model -> { sum, n, passed, total }
    for (const r of approved) {
      const key = seriesKey(r)
      let b = byModel.get(key)
      if (!b) { b = { sum: 0, n: 0, passed: 0, total: 0 }; byModel.set(key, b) }
      b.total += 1
      if (isPassed(r)) b.passed += 1
      const v = metricScore(r, mode === 'finalscore' ? 'final' : 'avgscore')
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
              <th className="row-head">题目（按均分 ↓）</th>
              {series.map((s, si) => (
                <th key={s} title={`${s}\n全站均分第 ${si + 1} 名`}>
                  <RankBadge rank={si + 1} />{s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {problems.map((p, pi) => (
              <tr key={p.pid}>
                <th className="row-head" data-detail={p.pid} onClick={() => onOpenDetail && onOpenDetail(p.pid)} title={`${p.pid} ${p.title || ''}`}>
                  <RankBadge rank={pi + 1} />
                  <span className="r-title">{p.pid} · {p.title || '（未命名）'}</span>
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
        列 = AI（按“每条记录全轮均分再平均”从高到低，带名次）；行 = 题目（按该题所有记录的整体均分从高到低）。
        点击行头或单元格查看题目详情与该模型记录。
        {mode === 'status' ? ' 状态口径：最终轮 AC / 未过 / 放弃（未解出）。' : ' 单元格均分 = 该组合全部有分数轮次；最终分 = 每条记录最后一个有分数轮次。'}
      </div>
    </div>
  )
}
