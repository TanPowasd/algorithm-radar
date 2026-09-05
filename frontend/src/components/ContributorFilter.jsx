import { useMemo } from 'react'
import { useApp } from '../state'

/**
 * 贡献者视角筛选（全站）：选定某贡献者后，所有分析视图与统计只计 TA 名下的已审核记录。
 *  - 选项来自 /api/contributors（state.nicknames 缓存）：全部 / 各注册账号 / 全民制作人（历史导入）
 *  - 与「模型聚焦」叠加生效；选择持久化在 localStorage（radar.focusContributor）
 */
export default function ContributorFilter() {
  const { nicknames, focusContributor, setFocusContributor } = useApp()

  const people = useMemo(() => {
    // nicknames: username -> { nickname, uid, role }；legacy 条目 uid 为 null
    const list = []
    for (const [username, info] of Object.entries(nicknames || {})) {
      if (!info || !info.uid) continue
      list.push({ key: info.uid, label: info.nickname || username, role: info.role || '' })
    }
    list.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
    return list
  }, [nicknames])

  const hasLegacy = useMemo(
    () => Object.values(nicknames || {}).some((i) => i && !i.uid && i.role === 'legacy'),
    [nicknames],
  )
  const active = focusContributor !== null && focusContributor !== undefined
  const activeLabel = !active
    ? null
    : focusContributor === 'legacy'
      ? '全民制作人（历史导入）'
      : (people.find((p) => p.key === focusContributor)?.label || `#${focusContributor}`)

  if (!people.length && !hasLegacy) return null // 名册还没加载 / 站上没有贡献者

  return (
    <div className="filter-compact-bar" id="contributor-filter">
      <span className="fc-tag">贡献者</span>
      {active ? (
        <>
          <span className="fc-desc"><strong>{activeLabel}</strong></span>
          <div className="fc-actions">
            <button className="btn small ghost" onClick={() => setFocusContributor(null)}>查看全部</button>
            <select
              className="fc-select"
              value={String(focusContributor)}
              onChange={(e) => setFocusContributor(e.target.value === '' ? null : e.target.value === 'legacy' ? 'legacy' : Number(e.target.value))}
              title="切换贡献者"
              aria-label="选择贡献者"
            >
              <option value="">全部贡献者</option>
              {people.map((p) => <option key={p.key} value={String(p.key)}>{p.label}</option>)}
              {hasLegacy && <option value="legacy">全民制作人（历史导入）</option>}
            </select>
          </div>
        </>
      ) : (
        <>
          <div className="fc-actions">
            <select
              className="fc-select"
              value=""
              onChange={(e) => {
                if (e.target.value === '') return
                setFocusContributor(e.target.value === 'legacy' ? 'legacy' : Number(e.target.value))
              }}
              title="选择要查看的贡献者"
              aria-label="选择贡献者"
            >
              <option value="">全部贡献者</option>
              {people.map((p) => <option key={p.key} value={String(p.key)}>{p.label}</option>)}
              {hasLegacy && <option value="legacy">全民制作人（历史导入）</option>}
            </select>
          </div>
        </>
      )}
    </div>
  )
}
