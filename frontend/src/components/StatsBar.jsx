import { useMemo } from 'react'
import { useApp } from '../state'
import { isApproved, isPassed, seriesKey } from '../aggregate'

export default function StatsBar() {
  const { data, models } = useApp()
  const stats = useMemo(() => {
    const recs = (data.records || []).filter(isApproved)
    const ac = recs.filter(isPassed).length
    const contributors = new Set(recs.map((r) => r.author).filter(Boolean)).size
    return {
      total: recs.length,
      models: new Set(recs.map(seriesKey)).size,
      registeredModels: models.length,
      problems: Object.keys(data.problems || {}).length,
      acRate: recs.length ? ((ac / recs.length) * 100).toFixed(1) : '0.0',
      contributors,
    }
  }, [data, models])

  const items = [
    { label: '测评记录', value: stats.total, tone: 'tone-accent' },
    { label: '参赛模型', value: stats.models, tone: 'tone-purple' },
    { label: '已发布题目', value: stats.problems, tone: 'tone-orange' },
    { label: '最终通过率', value: `${stats.acRate}%`, tone: 'tone-green' },
    { label: '贡献者', value: stats.contributors, tone: 'tone-red' },
  ]
  return (
    <div className="stats">
      {items.map((it) => (
        <div className="stat" key={it.label}>
          <div className="s-label"><span className={`tone-dot ${it.tone}`} />{it.label}</div>
          <div className="s-value">{it.value}</div>
        </div>
      ))}
    </div>
  )
}
