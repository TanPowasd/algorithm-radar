import { Fragment, useMemo, useState } from 'react'
import { useApp } from '../state'
import { isApproved, leaderboard, THINKING_LABELS, seriesKey, filterByModels } from '../aggregate'

const METRICS = [
  { key: 'ac', label: '最终 AC 数' },
  { key: 'acRate', label: '最终 AC 率' },
  { key: 'firstAcRate', label: '首轮 AC 率' },
  { key: 'avgScore', label: '全轮均分' },
  { key: 'problemCount', label: '覆盖题数' },
]

function fmt(metric, row) {
  if (metric === 'acRate' || metric === 'firstAcRate') return `${row[metric].toFixed(1)}%`
  if (metric === 'avgScore') return row.avgScore === null ? '—' : row.avgScore.toFixed(1)
  return row[metric]
}

export default function LeaderboardView({ onOpenDetail }) {
  const { data, focusModels } = useApp()
  const [metric, setMetric] = useState('ac')
  const [expanded, setExpanded] = useState(null)

  const rows = useMemo(() => {
    const list = leaderboard(filterByModels((data.records || []).filter(isApproved), focusModels))
    list.sort((a, b) => (b[metric] ?? -1) - (a[metric] ?? -1) || b.ac - a.ac)
    return list
  }, [data.records, metric, focusModels])

  const detail = useMemo(() => {
    if (!expanded) return null
    // 模型 × 思考等级明细
    const recs = filterByModels((data.records || []).filter((r) => isApproved(r) && seriesKey(r) === expanded), focusModels)
    const byThinking = new Map()
    for (const r of recs) {
      if (!byThinking.has(r.thinking)) byThinking.set(r.thinking, { total: 0, ac: 0 })
      const b = byThinking.get(r.thinking)
      b.total += 1
      if (r.submissions?.length && r.submissions[r.submissions.length - 1]?.result === 'AC') b.ac += 1
    }
    return [...byThinking.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([thinking, b]) => ({
        thinking,
        label: THINKING_LABELS[thinking] || thinking,
        total: b.total,
        ac: b.ac,
        rate: b.total ? ((b.ac / b.total) * 100).toFixed(0) : '0',
      }))
  }, [expanded, data.records])

  return (
    <div className="card" id="leaderboard-card">
      <div className="card-head">
        <h2>AI 排名榜</h2>
        <div className="seg">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? 'active' : ''} onClick={() => setMetric(m.key)}>{m.label}</button>
          ))}
        </div>
        <div className="card-tools"><span className="hint">仅统计已审核记录</span></div>
      </div>
      <div className="table-scroll">
        <table className="data lb-table">
          <thead>
            <tr>
              <th>#</th>
              <th>模型</th>
              <th className="num">测试数</th>
              <th className="num">最终 AC</th>
              <th className="num">最终 AC 率</th>
              <th className="num">首轮 AC 率</th>
              <th className="num">全轮均分</th>
              <th className="num">覆盖题数</th>
              <th>明细</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <Fragment key={row.model}>
                <tr>
                  <td className={`lb-rank ${i === 0 ? 'top1' : i === 1 ? 'top2' : i === 2 ? 'top3' : ''}`}>{i + 1}</td>
                  <td className="lb-model">{row.model}</td>
                  <td className="num">{row.total}</td>
                  <td className="num">{row.ac}</td>
                  <td className="num">{row.acRate.toFixed(1)}%</td>
                  <td className="num">{row.firstAcRate.toFixed(1)}%</td>
                  <td className="num">{row.avgScore === null ? '—' : row.avgScore.toFixed(1)}</td>
                  <td className="num">{row.problemCount}</td>
                  <td>
                    <button className="lb-detail-btn" onClick={() => setExpanded(expanded === row.model ? null : row.model)}>
                      {expanded === row.model ? '收起' : '思考等级'}
                    </button>
                  </td>
                </tr>
                {expanded === row.model && detail && (
                  <tr className="lb-detail-row">
                    <td colSpan={9}>
                      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '4px 2px' }}>
                        {detail.length === 0 && <span className="chain">暂无数据</span>}
                        {detail.map((d) => (
                          <span key={d.thinking} className="chain">
                            <span className="think-tag">{d.label}</span>
                            最终 AC {d.ac}/{d.total}（{d.rate}%）
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className="lb-hint">
        口径说明：最终 AC = 该记录最后一轮提交判定为 AC；全轮均分 = 全部有分数轮次的均分（无分数轮次不计）。
        点「思考等级」展开该模型按思考等级的通过情况。
      </div>
    </div>
  )
}
