import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state'
import { api } from '../api/client'
import { useDialog } from '../hooks/useDialog'

/** 登录弹窗（用户 ID + 密码；含首次初始化站长）；注册走独立页面 /register */
export default function AuthModal({ onClose }) {
  const dialogRef = useDialog(onClose)
  const { session, refreshAll, toast } = useApp()
  const [tab, setTab] = useState(session.canSetup ? 'setup' : 'login')
  const [form, setForm] = useState({ userId: '', nickname: '', password: '', setupToken: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (tab === 'login') {
        const res = await api('/api/login', { method: 'POST', body: { username: form.userId, password: form.password } })
        toast(`欢迎回来，${res.nickname || res.username}${res.role === 'owner' ? '（站长）' : res.role === 'admin' ? '（管理员）' : ''}`)
      } else {
        await api('/api/setup', {
          method: 'POST',
          body: {
            username: form.userId,
            nickname: form.nickname || form.userId,
            password: form.password,
            setupToken: form.setupToken || undefined,
          },
        })
        toast('站长账号已创建')
      }
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
      <form ref={dialogRef} className="modal narrow" role="dialog" aria-modal="true" aria-label={tab === 'login' ? '登录' : '初始化站长账号'} tabIndex={-1} onSubmit={submit}>
        <div className="modal-head">
          <h3>{tab === 'login' ? '登录' : '初始化站长账号'}</h3>
          <button type="button" className="icon-btn close" onClick={onClose} aria-label="关闭登录">×</button>
        </div>

        {session.canSetup && (
          <div className="auth-tabs">
            <button type="button" className={`btn small ${tab === 'setup' ? 'active' : ''}`} onClick={() => setTab('setup')}>初始化站长</button>
            <button type="button" className={`btn small ${tab === 'login' ? 'active' : ''}`} onClick={() => setTab('login')}>登录</button>
          </div>
        )}

        {tab === 'setup' && (
          <div className="callout">
            数据库还没有任何账号。你创建的第一个账号将成为<strong>站长</strong>（可审核注册、任命管理员），此入口随后永久关闭。
            公网部署时需先配置 SETUP_TOKEN 环境变量。
          </div>
        )}

        <div className="field">
          <label htmlFor="auth-user">用户 ID（登录用）</label>
          <input id="auth-user" value={form.userId} onChange={(e) => set({ userId: e.target.value })} autoComplete="username" />
        </div>
        {tab === 'setup' && (
          <div className="field">
            <label>昵称（站内显示名，可留空默认同用户 ID）</label>
            <input value={form.nickname} onChange={(e) => set({ nickname: e.target.value })} />
          </div>
        )}
        <div className="field">
          <label htmlFor="auth-password">密码</label>
          <input id="auth-password" type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="current-password" />
        </div>
        {tab === 'setup' && (
          <div className="field">
            <label>SETUP_TOKEN（公网部署时必填；本地可留空）</label>
            <input value={form.setupToken} onChange={(e) => set({ setupToken: e.target.value })} />
          </div>
        )}

        {error && <div className="form-error">{error}</div>}
        <div className="modal-foot">
          <button type="button" className="btn ghost" onClick={onClose}>取消</button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? '提交中…' : tab === 'login' ? '登录' : '创建站长'}
          </button>
        </div>
        {tab === 'login' && (
          <div style={{ textAlign: 'center', marginTop: 12, fontSize: 'var(--fs-sm)' }}>
            <div>还没有账号？<Link to="/register" onClick={onClose}>去注册 →</Link>（需站长审核）</div>
            <div style={{ marginTop: 6, fontSize: 'var(--fs-xs)', color: 'var(--text-3)' }}>
              用户审核 QQ 群：<span style={{ color: 'var(--accent)', userSelect: 'all', fontWeight: 600 }}>1107535292</span>
            </div>
          </div>
        )}
      </form>
    </div>
  )
}
