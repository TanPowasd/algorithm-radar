import { useState } from 'react'
import { api } from '../api/client'
import { useApp } from '../state'
import { recordLine } from '../aggregate'

/**
 * 删除测评记录（管理员 / 站长可见，其他人渲染为空）。
 * 走既有后端 DELETE /api/records/{id} = 软删除进回收站，可在审核台恢复，不是物理删除。
 */
export default function DeleteRecordButton({ record, label = '删除', title, onDeleted }) {
  const { isAdmin, toast, refreshAll } = useApp()
  const [busy, setBusy] = useState(false)

  if (!isAdmin) return null

  const click = async () => {
    const ok = window.confirm(
      `删除这条测评记录？\n\n${recordLine(record)}\n提供者 ${record.author || '全民制作人'}\n\n`
      + '删除 = 移入回收站（软删除）：统计、矩阵、榜单、滚榜立即不再计入。\n'
      + '如需找回，到「审核台 → 回收站」恢复；要彻底清除也在回收站里操作。')
    if (!ok) return
    setBusy(true)
    try {
      await api(`/api/records/${encodeURIComponent(record.id)}`, { method: 'DELETE' })
      await refreshAll()
      toast(`已移入回收站：${recordLine(record)}`)
      onDeleted?.(record)
    } catch (e) {
      toast(e.message || '删除失败', 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <button type="button" className="btn small danger" disabled={busy} onClick={click} title={title || '移入回收站（可在审核台恢复）'}>
      {busy ? '删除中…' : label}
    </button>
  )
}
