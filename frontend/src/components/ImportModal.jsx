import { useRef, useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'

/** 导入旧站导出的 JSON（管理员） */
export default function ImportModal({ onClose }) {
  const { toast, refreshAll } = useApp()
  const fileRef = useRef(null)
  const [mode, setMode] = useState('merge')
  const [bundle, setBundle] = useState(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const pick = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setFileName(file.name)
    setError('')
    file.text().then((text) => {
      try {
        const json = JSON.parse(text)
        if (!json || (!Array.isArray(json.records) && !Array.isArray(json.data?.records))) {
          throw new Error('结构不对')
        }
        setBundle(json)
      } catch {
        setError('文件不是合法的导出 JSON（应包含 records 数组）')
        setBundle(null)
      }
    })
  }

  const submit = async (e) => {
    e.preventDefault()
    if (!bundle) return setError('请先选择导出 JSON 文件')
    setBusy(true)
    setError('')
    try {
      const res = await api('/api/import', { method: 'POST', body: { mode, data: bundle } })
      toast(`导入完成：合并/写入 ${res.imported} 条记录`)
      await refreshAll()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal" onSubmit={submit}>
        <div className="modal-head">
          <h3>导入数据</h3>
          <button type="button" className="icon-btn close" onClick={onClose}>✕</button>
        </div>
        <div className="callout">
          支持旧站「AI vs 洛谷 / 算法雷达站」导出的 JSON（含 records/problems）。历史记录里引用了但目录中不存在的题目会按记录自带信息自动补齐。
        </div>
        <div className="field">
          <label>导出 JSON 文件</label>
          <input ref={fileRef} type="file" accept=".json,application/json" onChange={pick} />
          {fileName && <span className="chain">已选择：{fileName}</span>}
        </div>
        <div className="field">
          <label>导入方式</label>
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="merge">合并：按 id 合并，updatedAt 较新者胜（推荐）</option>
            <option value="replace">覆盖：清空现有测评与题目后整体导入</option>
          </select>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={busy || !bundle}>{busy ? '导入中…' : '导入'}</button>
        </div>
      </form>
    </div>
  )
}
