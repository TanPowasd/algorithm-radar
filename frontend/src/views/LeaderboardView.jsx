import { Fragment, useMemo, useState } from 'react'
import { useApp } from '../state'
import { isApproved, leaderboard, seriesColorMap, seriesKey, filterByModels, filterByContributor, THINKING_LABELS, fmtDateTime } from '../aggregate'
import { levelSwatchStyle } from '../palette'
import { useUrlState } from '../hooks/useUrlState'

const METRICS = [
  { key: 'ac', label: '最终 AC 数' },
  { key: 'acRate', label: '最终 AC 率' },
  { key: 'firstAcRate', label: '首轮 AC 率' },
  { key: 'avgScore', label: '全轮均分' },
  { key: 'problemCount', label: '覆盖题数' },
]

export default function LeaderboardView({ onOpenDetail }) {
  const { data, focusModels, focusContributor, vendorOf, theme } = useApp()
  const url = useUrlState('lb')
  const [metric, setMetric] = useState(() => (METRICS.some((m) => m.key === url.get('metric', '')) ? url.get('metric') : 'ac'))
  const [expanded, setExpanded] = useState(null)

  const approved = useMemo(() => filterByContributor(filterByModels(
    (data.records || []).filter(isApproved), focusModels), focusContributor), [data.records, focusModels, focusContributor])
  const colorMap = useMemo(
    () => seriesColorMap(approved, { vendorOf, dark: theme === 'dark' }),
    [approved, vendorOf, theme])

  const rows = useMemo(() => {
    const list = leaderboard(approved)
    list.sort((a, b) => (b[metric] ?? -1) - (a[metric] ?? -1) || b.ac - a.ac)
    return list
  }, [approved, metric])

  const detail = useMemo(() => {
    if (!expanded) return null
    const recs = approved.filter((r) => seriesKey(r) === expanded)
    const byThinking = new Map()
    for (const r of recs) {
      if (!byThinking.has(r.thinking)) byThinking.set(r.thinking, { total: 0, ac: 0, problems: new Set() })
      const b = byThinking.get(r.thinking)
      b.total += 1
      b.problems.add(r.pid)
      if (r.submissions?.length && r.submissions[r.submissions.length - 1]?.result === 'AC') b.ac += 1
    }
    return [...byThinking.entries()]
      .sort((a, b) => (b[1].ac / Math.max(1, b[1].total)) - (a[1].ac / Math.max(1, a[1].total)) || b[1].total - a[1].total)
      .map(([thinking, b]) => ({
        thinking,
        label: THINKING_LABELS[thinking] || thinking,
        total: b.total,
        problems: b.problems.size,
        ac: b.ac,
        rate: b.total ? ((b.ac / b.total) * 100) : 0,
      }))
  }, [expanded, approved])

  const pick = (m) => { setMetric(m); url.set('metric', m) }

  return (
    <div className="card" id="leaderboard-card">
      <div className="card-head">
        <h2>AI 排名榜</h2>
        <div className="seg">
          {METRICS.map((m) => (
            <button key={m.key} className={metric === m.key ? 'active' : ''} onClick={() => pick(m.key)}>{m.label}</button>
          ))}
        </div>
        <div className="card-tools"><span className="hint">仅统计已审核记录 · 色点 = 厂商</span></div>
      </div>
      <div className="table-scroll">
        <table className="data lb-table">
          <thead>
            <tr>
              <th>#</th>
              <th>模型</th>
              <th>厂商</th>
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
                  <td className="lb-model">
                    <span
                      className="vendor-dot"
                      style={{ background: colorMap.get(row.model) || 'var(--accent)', display: 'inline-block', width: 9, height: 9, borderRadius: 2, marginRight: 8 }}
                    />
                    {onOpenDetail ? (
                      <a
                        href={`#${row.model}`}
                        title="点开该模型最近一次作答的题目详情"
                        style={{ color: 'inherit', textDecoration: 'none', borderBottom: '1px dashed var(--border)' }}
                        onClick={(e) => {
                          e.preventDefault()
                          const last = approved.filter((r) => seriesKey(r) === row.model).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]
                          if (last) onOpenDetail(last.pid, row.model)
                        }}
                      >{row.model}</a>
                    ) : row.model}
                  </td>
                  <td><span className="chain">{vendorOf(row.model)}</span></td>
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
                    <td colSpan={10}>
                      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', padding: '4px 2px' }}>
                        {detail.length === 0 && <span className="chain">暂无数据</span>}
                        {detail.map((d) => (
                          <span key={d.thinking} className="rc-member">
                            <span className="sw" style={levelSwatchStyle(colorMap.get(row.model) || '#8fa2bc', d.thinking)} />
                            <b>{d.label}</b>
                            <span className="chain">最终 AC {d.ac}/{d.total}（{d.rate.toFixed(0)}%）</span>
                            <span className="chain">覆盖 {d.problems} 题</span>
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
        点「思考等级」展开该模型各队员（思考等级）的通过情况；要看逐条时间轴请用顶部「滚榜」。
        {rows[0] && <span className="chain">　数据截至 {fmtDateTime(rows[0].latestAt || data.updatedAt)}</span>}
      </div>
    </div>
  )
}
