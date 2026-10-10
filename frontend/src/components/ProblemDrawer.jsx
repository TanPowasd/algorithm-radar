import { useCallback, useMemo } from 'react'
import { useApp } from '../state'
import PromptCopyButton from './PromptCopyButton'
import DeleteRecordButton from './DeleteRecordButton'
import PidLink from './PidLink'
import { difficultyName, isPassed, lastSub, subBadgeClass, seriesKey, providerLabel, reviewerLabel, fmtClock, fmtDateTime, promptOf } from '../aggregate'
import { THINKING_LABELS } from '../aggregate'
import { useDialog } from '../hooks/useDialog'
import { useProblem } from '../hooks/useProblem'

/** decimal 可指定显示精度；true 兼容原有 5 位显示。 */
const scoreText = (score, decimal) => (score === null || score === undefined ? '' : (decimal ? Number(score).toFixed(typeof decimal === 'number' ? decimal : 5) : String(score)))

/** 题目详情抽屉：题目信息 + 推荐提示词（一键复制）+ 该题全部记录 + 三个统计 */
export default function ProblemDrawer({ pid, highlightModel, onClose, onSubmitClick, onEditRecord, blankEmpty = false, decimal = false }) {
  const dialogRef = useDialog(onClose)
  const { data, toast, nicknameOf, nameByUid, isAdmin, session } = useApp()
  const { problem, loading, error, retry } = useProblem(pid)
  const isMyRecord = useCallback((r) => Boolean(
    session.loggedIn && (
      (session.uid && r.authorId === session.uid)
    )
  ), [session.loggedIn, session.uid])
  const recs = useMemo(() =>
    (data.records || []).filter((r) => {
      if (r.pid !== pid) return false
      if (r.status !== 'pending') return true
      return isMyRecord(r)
    }).sort((a, b) => b.date.localeCompare(a.date)), [data.records, pid, isMyRecord])

  const stats = useMemo(() => {
    if (!recs.length) return null
    const firstScores = recs.map((r) => r.submissions?.[0]?.score).filter((s) => s !== null && s !== undefined)
    const passed = recs.filter(isPassed).length
    return {
      count: recs.length,
      firstAvg: firstScores.length
        ? (decimal
          ? Math.round((firstScores.reduce((a, b) => a + b, 0) / firstScores.length) * 1e5) / 1e5
          : Math.round(firstScores.reduce((a, b) => a + b, 0) / firstScores.length))
        : null,
      passRate: Math.round((passed / recs.length) * 100),
    }
  }, [recs, decimal])

  return (
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside ref={dialogRef} className="drawer" role="dialog" aria-modal="true" aria-label="题目详情" tabIndex={-1}>
        <div className="drawer-head">
          <div className="d-title">
            <h3><PidLink pid={pid} className="d-pid" /> · {problem?.title || '题目详情'}</h3>
            <div className="meta">
              <span className={`diff-tag d-${problem?.difficulty ?? 0}`}>{difficultyName(problem?.difficulty)}</span>
              {(problem?.categories || []).map((c) => <span key={c} className="cat-tag">{c}</span>)}
              {problem?.fetchedAt && <span>抓取于 {fmtDateTime(problem.fetchedAt) || problem.fetchedAt}</span>}
            </div>
          </div>
          <button className="icon-btn close" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <div className="drawer-body">
          {loading && <div className="chain" role="status">加载题面...</div>}
          {error && <div className="form-error" role="alert">{error} <button className="btn small" onClick={retry}>重试</button></div>}
          {problem && (
            <div className="callout prompt-box" id="problem-prompt">
              <div className="prompt-head">
                <span className="prompt-title">推荐提示词 · {problem.prompt ? '专属定制口径' : '标准统一模板'}</span>
                <PromptCopyButton problem={problem} modelId={highlightModel || undefined} toast={toast} />
              </div>
              {!loading && !error && <pre style={{ maxHeight: 320, overflowY: 'auto' }}>{promptOf(problem, highlightModel || undefined)}</pre>}
            </div>
          )}
          {stats && (
            <div className="drawer-stats">
              <div className="stat"><div className="s-label">测试数</div><div className="s-value">{stats.count}</div></div>
              <div className="stat"><div className="s-label">首轮均分</div><div className="s-value">{stats.firstAvg === null || stats.firstAvg === undefined ? (blankEmpty ? '' : '—') : scoreText(stats.firstAvg, decimal)}</div></div>
              <div className="stat"><div className="s-label">最终通过率</div><div className="s-value">{stats.passRate}%</div></div>
            </div>
          )}
          {!recs.length && <div className="empty">该题还没有测评记录</div>}
          {recs.map((r) => {
            const last = lastSub(r)
            const isMy = isMyRecord(r)
            const canEdit = isAdmin || isMy
            return (
              <div key={r.id} className={`drawer-rec ${highlightModel && seriesKey(r) === highlightModel ? 'hl' : ''}`}>
                <div className="dr-head">
                  <span className="m">{seriesKey(r)}</span>
                  <span className={`think-tag lv-${r.thinking}`}>{THINKING_LABELS[r.thinking] || r.thinking}</span>
                  <span className={`sub-badge ${last ? subBadgeClass(last.score) : 'b-na'}`}>
                    {last ? `${last.result} ${scoreText(last.score, decimal)}` : '无提交'}
                  </span>
                  {r.status === 'pending' && <span className="status-tag pending">待审</span>}
                  <span className="meta" title={`录入 ${fmtDateTime(r.createdAt)} · 更新 ${fmtDateTime(r.updatedAt)}`}>
                    {r.date} {fmtClock(r.createdAt)} · 提供 {providerLabel(r, nicknameOf)}
                    {reviewerLabel(r, nameByUid) ? ` · 审核 ${reviewerLabel(r, nameByUid)}` : ''}
                  </span>
                  {onEditRecord && canEdit && (
                    <button
                      className="btn small ghost"
                      onClick={() => onEditRecord(r)}
                      title={isMy && !isAdmin ? '修改我提交的记录（保存后需再次审核）' : '编辑记录'}
                      style={{ padding: '2px 8px', fontSize: 'var(--fs-xs)' }}
                    >
                      编辑
                    </button>
                  )}
                  {isAdmin && <DeleteRecordButton record={r} />}
                </div>
                {(r.submissions || []).map((s, i) => (
                  <div key={i} className="chain">
                    第{i + 1}轮：{s.result} {s.score !== null && s.score !== undefined ? `· ${scoreText(s.score, decimal)} 分` : ''} {s.note ? `· ${s.note}` : ''}
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
