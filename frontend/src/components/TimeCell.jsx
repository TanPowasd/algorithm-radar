import { fmtDateTime } from '../aggregate'

/**
 * 全站统一的时间单元格：一行两排
 * 上排 = 日期，下排 = 时分；两排取自同一个本地化时间串，保证日期与时分永远一致。
 * hover 出完整 YYYY-MM-DD HH:mm。
 */
export default function TimeCell({ value, fallback = '—', title }) {
  if (!value) return <span className="chain">{fallback}</span>
  const full = fmtDateTime(value)
  if (!full || full === '—') return <span className="chain">{String(value)}</span>
  const date = full.slice(0, 10)
  const clock = full.length > 11 ? full.slice(11) : ''
  return (
    <div className="tcell" title={title || full}>
      <span className="t-date">{date}</span>
      <span className="t-time">{clock || '—:—'}</span>
    </div>
  )
}
