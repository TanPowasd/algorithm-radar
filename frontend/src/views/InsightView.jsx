import { useMemo } from 'react'
import { useApp } from '../state'
import { filterByModels, filterByContributor, isApproved, modelStability, problemDiscrimination, THINKING_LABELS, thinkingYield } from '../aggregate'
import PidLink from '../components/PidLink'
import { levelSwatchStyle } from '../palette'

const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`)
const score = (x) => (x === null || x === undefined ? '—' : x.toFixed(1))

/** 「洞察」视图：模型稳定性 / 题目区分度 / 思考等级收益（同榜口径：已审核 + 模型筛选） */
export default function InsightView() {
  const { data, focusModels, focusContributor } = useApp()
  const approved = useMemo(
    () => filterByContributor(filterByModels((data.records || []).filter(isApproved), focusModels), focusContributor),
    [data.records, focusModels, focusContributor],
  )
  const stability = useMemo(
    () => modelStability(approved).sort((a, b) => (b.avgBest ?? -1) - (a.avgBest ?? -1) || b.ac - a.ac),
    [approved],
  )
  const discrimination = useMemo(() => problemDiscrimination(approved).slice(0, 15), [approved])
  const yieldRows = useMemo(() => thinkingYield(approved), [approved])

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>模型稳定性</h2>
          <span className="hint">标准差越小发挥越稳 · 最佳成绩 = 该记录有分数轮次的最高分</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr><th>模型</th><th>覆盖题数</th><th>作答记录</th><th>AC</th><th>AC 率</th><th>最佳成绩均分</th><th>成绩标准差</th></tr>
            </thead>
            <tbody>
              {stability.map((m) => (
                <tr key={m.model}>
                  <td style={{ fontWeight: 600 }}>{m.model}</td>
                  <td>{m.problems}</td>
                  <td>{m.answered}</td>
                  <td>{m.ac}</td>
                  <td>{pct(m.acRate)}</td>
                  <td>{score(m.avgBest)}</td>
                  <td>{score(m.stdBest)}</td>
                </tr>
              ))}
              {!stability.length && <tr><td colSpan={7}><div className="empty">暂无数据</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>题目区分度</h2>
          <span className="hint">极差 = 模型间最佳成绩均分的 max−min，越大越能拉开差距（Top 15）</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr><th>题目</th><th>参与模型</th><th>记录数</th><th>模型均分极差</th><th>模型间标准差</th></tr>
            </thead>
            <tbody>
              {discrimination.map((p) => (
                <tr key={p.pid}>
                  <td><PidLink pid={p.pid} /> {p.title && <span className="chain">{p.title}</span>}</td>
                  <td>{p.models}</td>
                  <td>{p.records}</td>
                  <td>{score(p.spread)}</td>
                  <td>{score(p.std)}</td>
                </tr>
              ))}
              {!discrimination.length && <tr><td colSpan={5}><div className="empty">暂无数据</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>思考等级收益</h2>
          <span className="hint">同模型跨题聚合：等级越高是否真的分更高 / AC 更多，用数据说话</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr><th>思考等级</th><th>作答记录</th><th>AC</th><th>AC 率</th><th>最佳成绩均分</th></tr>
            </thead>
            <tbody>
              {yieldRows.map((row) => (
                <tr key={row.thinking}>
                  <td>
                    <span className="sw" style={levelSwatchStyle('#8fa2bc', row.thinking)} />
                    {THINKING_LABELS[row.thinking] || row.thinking}
                  </td>
                  <td>{row.answered}</td>
                  <td>{row.ac}</td>
                  <td>{pct(row.acRate)}</td>
                  <td>{score(row.avgBest)}</td>
                </tr>
              ))}
              {!yieldRows.length && <tr><td colSpan={5}><div className="empty">暂无数据</div></td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}
