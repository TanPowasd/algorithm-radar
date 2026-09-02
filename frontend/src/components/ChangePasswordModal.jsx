import { useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'

/** 修改密码弹窗：成功后其他设备全部下线，当前设备自动续签 */
export default function ChangePasswordModal({ onClose }) {
  const { toast, refreshSession } = useApp()
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', newPassword2: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (form.newPassword !== form.newPassword2) return setError('两次输入的新密码不一致')
    if (form.newPassword === form.oldPassword) return setError('新密码不能与旧密码相同')
    setBusy(true)
    try {
      const res = await api('/api/change-password', {
        method: 'POST',
        body: { oldPassword: form.oldPassword, newPassword: form.newPassword },
      })
      toast(res.message || '密码已修改')
      await refreshSession()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <form className="modal narrow" onSubmit={submit}>
        <div className="modal-head">
          <h3>修改密码</h3>
          <button type="button" className="icon-btn close" onClick={onClose}>✕</button>
        </div>
        <div className="callout">
          新密码 8–64 位，存储为 PBKDF2 哈希。修改成功后<strong>其他设备会全部退出登录</strong>，本设备保持在线。
        </div>
        <div className="field">
          <label>旧密码</label>
          <input type="password" value={form.oldPassword} onChange={(e) => set({ oldPassword: e.target.value })} autoComplete="current-password" />
        </div>
        <div className="field">
          <label>新密码（8–64 位）</label>
          <input type="password" value={form.newPassword} onChange={(e) => set({ newPassword: e.target.value })} autoComplete="new-password" />
        </div>
        <div className="field">
          <label>确认新密码</label>
          <input type="password" value={form.newPassword2} onChange={(e) => set({ newPassword2: e.target.value })} autoComplete="new-password" />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? '提交中…' : '修改密码'}</button>
        </div>
      </form>
    </div>
  )
}
