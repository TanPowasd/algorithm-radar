import { useMemo } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { bestThinkingCell, matrixCell, difficultyName } from '../aggregate'
import PidLink from '../components/PidLink'

const format = (value, decimal) => {
  const digits = typeof decimal === 'number' ? decimal : decimal ? 5 : 0
  return value == null ? '' : Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export default function ScoreLayouts({ layout, series, problems, grouped, ratings, intervalsReady, summary, mode, unitScore, decimal, url, onOpenDetail, onQuickAdd }) {
  const requested = url.get('compare', '')
  const selected = useMemo(() => {
    try {
      const list = requested ? JSON.parse(requested) : series.slice(0, 2)
      return [...new Set(list)].filter((name) => series.includes(name)).slice(0, 3)
    } catch { return series.slice(0, 2) }
  }, [requested, series])
  const choose = (index, value) => {
    const next = [...selected]
    next[index] = value
    url.set('compare', JSON.stringify([...new Set(next.filter(Boolean))]))
  }
  const score = (model, pid) => {
    const records = grouped.get(model + '\u0000' + pid) || []
    if (!records.length) return null
    if (mode === 'bestLevel' || mode === 'bestScore') return bestThinkingCell(records, mode === 'bestLevel' ? 'level' : 'score', 'avgscore').value
    const cell = matrixCell(records, model, pid)
    if (mode === 'status') return cell.kind === 'ac' ? 'AC' : cell.kind === 'fail' ? '未过' : '放弃'
    return (mode === 'final' ? cell.finalInfo : cell.scoreInfo)?.avg ?? null
  }
  if (layout === 'ranking') return <div className="ranking-list" aria-label="模型排名">
    <div className="ranking-list-head"><span>排名 / 模型</span><span>{mode === 'status' ? '通过率' : unitScore ? 'rating' : '平均分'}</span></div>
    {series.map((model, index) => {
      const info = ratings.get(model)
      const raw = summary.get(model)
      const value = mode === 'status' ? raw?.passRate : unitScore ? info?.rating : raw?.avg
      return <div key={model} className="ranking-row">
        <span className="ranking-position">{index + 1}</span>
        <div className="ranking-model"><strong>{model}</strong><span className="chain">{unitScore && mode !== 'status' ? (info ? info.games + ' 局' : '暂无可比对局') : (raw?.total || 0) + ' 条记录'}
          {intervalsReady && info?.lo != null && <span className="ranking-ci"> · 95% {format(info.lo, false)}–{format(info.hi, false)}</span>}</span></div>
        <span className="ranking-value num">{mode === 'status' && value != null ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 5 }) + '%' : format(value, decimal)}</span>
        <button className="icon-btn" aria-label={'比较 ' + model} title={'比较 ' + model}
          onClick={() => url.setMany({ layout: 'compare', compare: JSON.stringify([model, ...series.filter((name) => name !== model).slice(0, 1)]) })}><ChevronRight size={18} /></button>
      </div>
    })}
  </div>
  return <div className="comparison-surface">
    <div className="comparison-pickers">{[0, 1, 2].map((index) => <label key={index}>模型 {index + 1}
      <select aria-label={'对比模型 ' + (index + 1)} value={selected[index] || ''} onChange={(event) => choose(index, event.target.value)}>
        <option value="">未选择</option>{series.map((model) => <option key={model} value={model}>{model}</option>)}
      </select></label>)}</div>
    {!selected.length ? <div className="empty">选择模型</div> : <div className="comparison-table">
      <div className="comparison-columns" style={{ '--columns': selected.length }}>
        {selected.map((model) => <strong key={model}>{model}</strong>)}
      </div>
      {problems.map(({ problem }) => <div className="comparison-problem" key={problem.pid}>
        <div className="comparison-title"><PidLink pid={problem.pid} /><button className="pid-detail" onClick={() => onOpenDetail?.(problem.pid)}>{problem.title || problem.pid}</button><span className="chain">{difficultyName(problem.difficulty)}</span></div>
        <div className="comparison-values" style={{ '--columns': selected.length }}>
          {selected.map((model) => {
            const value = score(model, problem.pid)
            const records = grouped.get(model + '\u0000' + problem.pid)
            const disabled = unitScore && (value == null || (mode === 'status' && !(records || []).some((record) =>
              (record.submissions || []).some((sub) => typeof sub.score === 'number'))))
            return <div key={model}>{records?.length ? <button className="comparison-score num" title={model + ' · ' + problem.pid}
              disabled={disabled}
              onClick={() => onOpenDetail?.(problem.pid, model)}>{typeof value === 'string' ? value : format(value, decimal)}</button>
              : onQuickAdd ? <button className="icon-btn" title="为该题提交测评" aria-label={'为 ' + problem.pid + ' 提交测评'} onClick={() => onQuickAdd(problem.pid)}><Plus size={16} /></button> : <span className="chain">未作答</span>}</div>
          })}
        </div>
      </div>)}
    </div>}
  </div>
}
