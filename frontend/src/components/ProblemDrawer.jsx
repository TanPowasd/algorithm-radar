import { useMemo } from 'react'
import { useApp } from '../state'
import { difficultyName, isPassed, lastSub, subBadgeClass, seriesKey, providerLabel, reviewerLabel } from '../aggregate'

/** 题目详情抽屉：题目信息 + 推荐提示词 + 该题全部记录 + 三个统计 */
export default function ProblemDrawer({ pid, highlightModel, onClose, onSubmitClick }) {
  const { data, toast, nicknameOf, nameByUid } = useApp()
  const problem = data.problems?.[pid]
  const recs = useMemo(() =>
    (data.records || []).filter((r) => r.pid === pid && r.status !== 'pending')
      .sort((a, b) => b.date.localeCompare(a.date)), [data.records, pid])

  const stats = useMemo(() => {
    if (!recs.length) return null
    const firstScores = recs.map((r) => r.submissions?.[0]?.score).filter((s) => s !== null && s !== undefined)
    const passed = recs.filter(isPassed).length
    return {
      count: recs.length,
      firstAvg: firstScores.length ? Math.round(firstScores.reduce((a, b) => a + b, 0) / firstScores.length) : null,
      passRate: Math.round((passed / recs.length) * 100),
    }
  }, [recs])

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-label="题目详情">
        <div className="drawer-head">
          <div className="d-title">
            <h3>{pid} · {problem?.title || '题目详情'}</h3>
            <div className="meta">
              <span className={`diff-tag d-${problem?.difficulty ?? 0}`}>{difficultyName(problem?.difficulty)}</span>
              {(problem?.categories || []).map((c) => <span key={c} className="cat-tag">{c}</span>)}
              {problem?.fetchedAt && <span>抓取于 {problem.fetchedAt}</span>}
            </div>
          </div>
          <button className="icon-btn close" onClick={onClose}>✕</button>
        </div>
        <div className="drawer-body">
          {problem?.prompt && (
            <div className="callout" id="problem-prompt">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <strong style={{ color: 'var(--accent)' }}>推荐提示词（统一测试口径）</strong>
                <button
                  className="btn small"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => {
                    navigator.clipboard.writeText(problem.prompt)
                      .then(() => toast('推荐提示词已复制'))
                      .catch(() => toast('复制失败，请手动选择文本', 'err'))
                  }}
                >复制</button>
              </div>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>
                {problem.prompt}
              </pre>
            </div>
          )}
          {stats && (
            <div className="drawer-stats">
              <div className="stat"><div className="s-label">测试数</div><div className="s-value">{stats.count}</div></div>
              <div className="stat"><div className="s-label">首轮均分</div><div className="s-value">{stats.firstAvg ?? '—'}</div></div>
              <div className="stat"><div className="s-label">最终通过率</div><div className="s-value">{stats.passRate}%</div></div>
            </div>
          )}
          {!recs.length && <div className="empty">该题还没有测评记录</div>}
          {recs.map((r) => {
            const last = lastSub(r)
            return (
              <div key={r.id} className={`drawer-rec ${highlightModel && seriesKey(r) === highlightModel ? 'hl' : ''}`}>
                <div className="dr-head">
                  <span className="m">{seriesKey(r)}</span>
                  <span className="think-tag">{r.thinking}</span>
                  <span className={`sub-badge ${last ? subBadgeClass(last.score) : 'b-na'}`}>
                    {last ? `${last.result} ${last.score ?? ''}` : '无提交'}
                  </span>
                  <span className="meta">
                    {r.date} · 提供 {providerLabel(r, nicknameOf)}
                    {reviewerLabel(r, nameByUid) ? ` · 审核 ${reviewerLabel(r, nameByUid)}` : ''}
                  </span>
                </div>
                {(r.submissions || []).map((s, i) => (
                  <div key={i} className="chain">
                    第{i + 1}轮：{s.result} {s.score !== null && s.score !== undefined ? `· ${s.score} 分` : ''} {s.note ? `· ${s.note}` : ''}
                  </div>
                ))}
                {r.note && <div className="chain">备注：{r.note}</div>}
              </div>
            )
          })}
        </div>
        {onSubmitClick && (
          <div className="drawer-foot">
            <button className="btn primary block" onClick={onSubmitClick}>为该题提交测评</button>
          </div>
        )}
      </aside>
    </>
  )
}
