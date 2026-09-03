import { useApp } from '../state'
import { seriesList } from '../aggregate'

/**
 * 模型多选查看器：勾选某些模型后，全站视图只显示这些模型的成绩。
 * - 点 chip 切换该模型的显示/隐藏
 * - 「全部」清空选择（显示所有模型）
 * 选择保存在 localStorage（radar.focusModels），下次访问自动恢复。
 */
export default function ModelFilter() {
  const { data, focusModels, toggleFocusModel, focusOnly } = useApp()

  // 可选模型 = 已审核记录里出现过的模型（与视图口径一致，避免出现无数据的 chip）
  const approvedModels = seriesList((data.records || []).filter((r) => r.status !== 'pending'))
  if (approvedModels.length < 2) return null // 少于 2 个模型时无需筛选

  // 只保留仍存在的模型（避免目录变动后残留无效选择）
  const validFocus = focusModels && focusModels.size > 0
    ? new Set([...focusModels].filter((m) => approvedModels.includes(m)))
    : focusModels
  const activeCount = validFocus?.size ?? 0

  const click = (m) => {
    // 当前为「全部」时点某模型 = 只看它；否则按 toggle 逻辑（至少一个时取消=回到全部）
    if ((validFocus?.size ?? 0) === 0) {
      focusOnly([m])
    } else if (validFocus.has(m) && validFocus.size === 1) {
      focusOnly([]) // 取消最后一个 = 回到全部
    } else {
      toggleFocusModel(m)
    }
  }

  return (
    <div className="card filter-card" id="model-filter">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>查看模型</h2>
        <span className="hint">
          {activeCount > 0
            ? `已选 ${activeCount} 个模型，仅显示这些模型的成绩`
            : '已选全部模型'}
        </span>
        <div className="card-tools">
          {activeCount > 0 && (
            <button className="btn small ghost" onClick={() => focusOnly([])}>查看全部</button>
          )}
        </div>
      </div>
      <div className="filter-chips">
        <button
          className={`fchip ${activeCount === 0 ? 'on' : ''}`}
          onClick={() => focusOnly([])}
          title="显示全部模型"
        >全部</button>
        {approvedModels.map((m) => {
          const on = activeCount > 0 && validFocus.has(m)
          return (
            <button
              key={m}
              className={`fchip ${on ? 'on' : ''}`}
              onClick={() => click(m)}
              title={on ? '隐藏该模型' : '选择该模型'}
            >
              {m}
            </button>
          )
        })}
      </div>
    </div>
  )
}
