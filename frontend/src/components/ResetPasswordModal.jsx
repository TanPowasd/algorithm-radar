import { useState } from 'react'
import { api } from '../api/client'
import { useApp } from '../state'
import { useDialog } from '../hooks/useDialog'

/**
 * 站长/管理员重置指定用户的密码（不需要旧密码）。
 * 后端会把该用户的 password_version +1 → 他在所有设备上的登录立即失效，必须用新密码重新登录。
 */
export default function ResetPasswordModal({ user, onClose, onDone }) {
  const dialogRef = useDialog(onClose)
  const { toast } = useApp()
  const [form, setForm] = useState({ newPassword: '', newPassword2: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (form.newPassword.length < 8 || form.newPassword.length > 64) return setError('新密码长度需在 8–64 位之间')
    if (form.newPassword !== form.newPassword2) return setError('两次输入的新密码不一致')
    setBusy(true)
    try {
      const res = await api(`/api/admin/users/${user.id}/password`, {
        method: 'POST',
        body: { newPassword: form.newPassword },
      })
      toast(res.message || '密码已重置')
      if (onDone) await onDone()
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div ref={dialogRef} className="modal narrow" role="dialog" aria-modal="true" aria-label="重置密码" tabIndex={-1}>
        <div className="modal-head">
          <h3>重置密码</h3>
          <button type="button" className="icon-btn close" onClick={onClose} aria-label="关闭重置密码">×</button>
        </div>
        <form onSubmit={submit} aria-label="重置用户密码">
          <div className="callout">
            正在为 <strong>{user.nickname || user.username}</strong>
            <span className="chain">（{user.username}#{user.id}）</span> 设置新密码：不需要旧密码，
            重置成功后<strong>该账号在所有设备上立即退出登录</strong>，请把新密码线下告知本人。
          </div>
          <div className="field">
            <label htmlFor="reset-new-password">新密码（8–64 位）</label>
            <input
              id="reset-new-password" type="password" autoFocus autoComplete="new-password"
              value={form.newPassword} onChange={(e) => set({ newPassword: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="reset-confirm-password">确认新密码</label>
            <input
              id="reset-confirm-password" type="password" autoComplete="new-password"
              value={form.newPassword2} onChange={(e) => set({ newPassword2: e.target.value })}
            />
          </div>
          {error && <div className="form-error">{error}</div>}
          <div className="modal-foot">
            <button type="button" className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
            <button type="submit" className="btn primary" disabled={busy}>{busy ? '提交中…' : '确认重置'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
