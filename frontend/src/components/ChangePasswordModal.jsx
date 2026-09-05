import { useState } from 'react'
import { useApp } from '../state'
import { api } from '../api/client'
import { useDialog } from '../hooks/useDialog'

/** 账号设置弹窗：昵称即时生效；改密码成功后其他设备全部下线，当前设备自动续签 */
export default function ChangePasswordModal({ onClose }) {
  const dialogRef = useDialog(onClose)
  const { toast, refreshSession, refreshNicknames, session } = useApp()
  const [nick, setNick] = useState(session.nickname || '')
  const [nickBusy, setNickBusy] = useState(false)
  const [nickError, setNickError] = useState('')
  const [form, setForm] = useState({ oldPassword: '', newPassword: '', newPassword2: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const submitNick = async (e) => {
    e.preventDefault()
    setNickError('')
    setNickBusy(true)
    try {
      const res = await api('/api/profile/nickname', { method: 'POST', body: { nickname: nick } })
      toast(res.message || '昵称已更新')
      await Promise.all([refreshSession(), refreshNicknames()])
      onClose()
    } catch (err) {
      setNickError(err.message)
    } finally {
      setNickBusy(false)
    }
  }

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
      <div ref={dialogRef} className="modal narrow" role="dialog" aria-modal="true" aria-label="账号设置" tabIndex={-1}>
        <div className="modal-head">
          <h3>账号设置</h3>
          <button type="button" className="icon-btn close" onClick={onClose} aria-label="关闭账号设置">×</button>
        </div>

        <form onSubmit={submitNick} aria-label="修改昵称">
        <div className="field">
          <label htmlFor="account-nickname">昵称（全站显示名，1–24 字）</label>
          <input
            id="account-nickname"
            value={nick}
            maxLength={24}
            onChange={(e) => setNick(e.target.value)}
            placeholder={session.username}
          />
        </div>
        {nickError && <div className="form-error">{nickError}</div>}
        <div className="modal-foot" style={{ marginTop: 0 }}>
          <button type="submit" className="btn primary" disabled={nickBusy}>{nickBusy ? '保存中…' : '保存昵称'}</button>
        </div>
        </form>

        <hr className="modal-divider" />

        <form onSubmit={submit} aria-label="修改密码">
        <div className="callout">
          新密码 8–64 位，存储为 PBKDF2 哈希。修改成功后<strong>其他设备会全部退出登录</strong>，本设备保持在线。
        </div>
        <div className="field">
          <label htmlFor="account-old-password">旧密码</label>
          <input id="account-old-password" type="password" value={form.oldPassword} onChange={(e) => set({ oldPassword: e.target.value })} autoComplete="current-password" />
        </div>
        <div className="field">
          <label htmlFor="account-new-password">新密码（8–64 位）</label>
          <input id="account-new-password" type="password" value={form.newPassword} onChange={(e) => set({ newPassword: e.target.value })} autoComplete="new-password" />
        </div>
        <div className="field">
          <label htmlFor="account-confirm-password">确认新密码</label>
          <input id="account-confirm-password" type="password" value={form.newPassword2} onChange={(e) => set({ newPassword2: e.target.value })} autoComplete="new-password" />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? '提交中…' : '修改密码'}</button>
        </div>
        </form>
      </div>
    </div>
  )
}
