import { useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { useApp } from '../state'
import Topbar from '../components/Topbar'
import AuthModal from '../components/AuthModal'

/** 独立注册页：开放注册，提交后进入「待站长审核」状态 */
export default function RegisterPage() {
  const { toast } = useApp()
  const [form, setForm] = useState({ userId: '', nickname: '', password: '', password2: '' })
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [authOpen, setAuthOpen] = useState(false)

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (form.password !== form.password2) return setError('两次输入的密码不一致')
    setBusy(true)
    try {
      await api('/api/auth/register', {
        method: 'POST',
        body: { username: form.userId, nickname: form.nickname, password: form.password },
      })
      setDone(true)
      toast('注册成功，请等待站长审核')
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Topbar onOpenAuth={() => setAuthOpen(true)} />
      <main className="layout auth-page">
        <div className="card login-gate">
          <h2 style={{ marginBottom: 8 }}>注册贡献者</h2>
          <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)', marginTop: 0 }}>
            注册成为贡献者后即可提交 AI 测评数据。提交后需<strong>站长审核</strong>，批准后才能登录。
          </p>

          <div className="callout" style={{ marginBottom: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div>
              👥 <strong>用户审核 QQ 群：1107535292</strong>
              <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--text-2)', marginTop: 2 }}>
                注册后请进群联系管理员加速审核并开通测评权限
              </div>
            </div>
            <button
              type="button"
              className="btn small ghost"
              onClick={() => {
                navigator.clipboard?.writeText('1107535292')
                toast('群号已复制：1107535292')
              }}
            >
              复制群号
            </button>
          </div>

          {done ? (
            <div className="callout" style={{ borderColor: 'var(--accent)' }}>
              <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: 6 }}>✅ 注册申请已提交！</div>
              <p style={{ margin: '4px 0 10px', fontSize: 'var(--fs-sm)', color: 'var(--text)' }}>
                账号当前处于「待审核」状态。请加入<strong>用户审核 QQ 群：1107535292</strong> 联系站长或管理员审核通过，批准后即可登录提交测评。
              </p>
              <div style={{ display: 'flex', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="btn small primary"
                  onClick={() => {
                    navigator.clipboard?.writeText('1107535292')
                    toast('审核群号已复制：1107535292')
                  }}
                >
                  复制审核群号 (1107535292)
                </button>
                <Link className="btn small ghost" to="/">回到总览</Link>
              </div>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="field">
                <label>用户 ID（登录用，2–24 位，中英文/数字/下划线/连字符，唯一）</label>
                <input value={form.userId} onChange={(e) => set({ userId: e.target.value })} autoComplete="username" />
              </div>
              <div className="field">
                <label>昵称（站内显示名，1–24 字，可与他人重复）</label>
                <input value={form.nickname} onChange={(e) => set({ nickname: e.target.value })} />
              </div>
              <div className="field">
                <label>密码（8–64 位，存储为 PBKDF2 哈希，明文不落库）</label>
                <input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} autoComplete="new-password" />
              </div>
              <div className="field">
                <label>确认密码</label>
                <input type="password" value={form.password2} onChange={(e) => set({ password2: e.target.value })} autoComplete="new-password" />
              </div>
              {error && <div className="form-error">{error}</div>}
              <button type="submit" className="btn primary block" disabled={busy}>
                {busy ? '提交中…' : '提交注册'}
              </button>
            </form>
          )}

          <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', fontSize: 'var(--fs-sm)' }}>
            <Link to="/">← 返回首页</Link>
            <a href="#login" onClick={(e) => { e.preventDefault(); setAuthOpen(true) }}>已有账号？登录</a>
          </div>
        </div>
      </main>
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
    </>
  )
}
