import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state'
import Topbar from '../components/Topbar'
import AuthModal from '../components/AuthModal'
import { api } from '../api/client'
import TimeCell from '../components/TimeCell'

const ROLE_LABEL = { owner: '站长', admin: '管理员', contributor: '贡献者' }
const STATUS_LABEL = { active: '已激活', pending: '待审核', rejected: '已拒绝' }

export default function UsersPage() {
  const { session, isOwner, isAdmin, toast, loaded } = useApp()
  const [authOpen, setAuthOpen] = useState(false)
  const [users, setUsers] = useState(null)

  const load = async () => {
    try {
      const res = await api('/api/admin/users')
      setUsers(res.users || [])
    } catch (e) {
      toast(e.message, 'err')
      setUsers([])
    }
  }

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin])

  const pending = useMemo(() => (users || []).filter((u) => u.status === 'pending'), [users])
  const others = useMemo(() => (users || []).filter((u) => u.status !== 'pending'), [users])
  // 管理员视角：后端已过滤，这里兜底只显示可删除的已激活贡献者
  const deletable = useMemo(
    () => (users || []).filter((u) => u.role === 'contributor' && u.status === 'active'),
    [users],
  )

  const act = async (path, confirmMsg, { method = 'POST', body = {} } = {}) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return
    try {
      await api(path, { method, body })
      toast('操作成功')
      await load()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const deleteConfirm = (u) =>
    `永久删除账号 ${u.username}？\n· 该账号将立即退出登录，此操作不可恢复\n· TA 已提交的测评记录会保留（署名保留原用户名）`

  if (!isAdmin) {
    return (
      <>
        <Topbar onOpenAuth={() => setAuthOpen(true)} />
        <main className="layout">
          <div className="card login-gate">
            <h2 style={{ marginBottom: 10 }}>用户管理</h2>
            <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>
              仅管理员及以上可访问：管理员删除贡献者账号；站长审核注册、任命/免除/删除管理员。
            </p>
            {session.loggedIn
              ? <div className="callout">当前账号权限不足。</div>
              : <button className="btn primary block" onClick={() => setAuthOpen(true)}>登录</button>}
          </div>
        </main>
        {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      </>
    )
  }

  if (!isOwner) {
    return (
      <>
        <Topbar />
        <main className="layout">
          <div className="page-head">
            <h2>用户管理</h2>
            <span className="desc">删除贡献者账号（仅管理员）</span>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>贡献者</h2>
              <span className="hint">{deletable.length} 个已激活账号 · 审核注册与任免仅站长可见</span>
            </div>
            <div className="table-scroll" id="users-wrap">
              <table className="data">
                <thead>
                  <tr><th>用户 ID</th><th>昵称</th><th>角色</th><th>状态</th><th>注册时间</th><th>批准人</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {deletable.map((u) => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 600 }}>{u.username}<span className="chain"> #{u.id}</span></td>
                      <td>{u.nickname || <span className="chain">—</span>}</td>
                      <td><span className={`status-tag role-${u.role}`}>{ROLE_LABEL[u.role] || u.role}</span></td>
                      <td><span className={`status-tag st-${u.status}`}>{STATUS_LABEL[u.status] || u.status}</span></td>
                      <td><TimeCell value={u.createdAt} /></td>
                      <td>{u.approvedBy || '—'}</td>
                      <td className="actions">
                        <button className="btn small danger" onClick={() => act(`/api/admin/users/${u.id}`, deleteConfirm(u), { method: 'DELETE' })}>删除账号</button>
                      </td>
                    </tr>
                  ))}
                  {!deletable.length && <tr><td colSpan={7}><div className="empty">{loaded || users ? '暂无已激活的贡献者' : '加载中…'}</div></td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          <footer className="foot"><Link to="/">← 返回总览</Link></footer>
        </main>
      </>
    )
  }

  return (
    <>
      <Topbar />
      <main className="layout">
        <div className="page-head">
          <h2>用户管理</h2>
          <span className="desc">审核注册 · 任命/免除/删除管理员 · 删除贡献者（仅站长）</span>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>待审核注册</h2>
            <span className="hint">{pending.length} 个申请</span>
          </div>
          <div className="table-scroll" id="registrations-wrap">
            <table className="data review-table">
              <thead>
                <tr><th>用户名</th><th>申请时间</th><th>操作</th></tr>
              </thead>
              <tbody>
                {(pending || []).map((u) => (
                  <tr key={u.id}>
                    <td style={{ fontWeight: 600 }}>{u.username}</td>
                    <td><TimeCell value={u.createdAt} /></td>
                    <td className="actions">
                      <button className="btn small" onClick={() => act(`/api/admin/users/${u.id}/approve`)}>批准为贡献者</button>
                      <button className="btn small danger" onClick={() => act(`/api/admin/users/${u.id}/reject`, `拒绝 ${u.username} 的注册申请？`)}>拒绝</button>
                    </td>
                  </tr>
                ))}
                {!pending.length && <tr><td colSpan={3}><div className="empty">{loaded || users ? '没有待审核的注册申请' : '加载中…'}</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>全部用户</h2>
            <span className="hint">站长账号不可被改动 · 删除账号后其测评记录保留</span>
          </div>
          <div className="table-scroll" id="users-wrap">
              <table className="data">
                <thead>
                  <tr><th>用户 ID</th><th>昵称</th><th>角色</th><th>状态</th><th>注册时间</th><th>批准人</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {(others || []).map((u) => (
                    <tr key={u.id}>
                      <td style={{ fontWeight: 600 }}>{u.username}<span className="chain"> #{u.id}</span></td>
                      <td>{u.nickname || <span className="chain">—</span>}</td>
                      <td><span className={`status-tag role-${u.role}`}>{ROLE_LABEL[u.role] || u.role}</span></td>
                      <td><span className={`status-tag st-${u.status}`}>{STATUS_LABEL[u.status] || u.status}</span></td>
                      <td><TimeCell value={u.createdAt} /></td>
                      <td>{u.approvedBy || '—'}</td>
                    <td className="actions">
                      {u.role !== 'owner' && u.status === 'active' && (
                        <>
                          {u.role === 'contributor'
                            ? <button className="btn small" onClick={() => act(`/api/admin/users/${u.id}/role`, `将 ${u.username} 任命为管理员？`, { role: 'admin' })}>任命管理员</button>
                            : <button className="btn small ghost" onClick={() => act(`/api/admin/users/${u.id}/role`, `免除 ${u.username} 的管理员？`, { role: 'contributor' })}>免除管理员</button>}
                          <button className="btn small danger" onClick={() => act(`/api/admin/users/${u.id}`, deleteConfirm(u), { method: 'DELETE' })}>删除账号</button>
                        </>
                      )}
                      {u.status === 'rejected' && <span className="chain">已拒绝，无法操作</span>}
                    </td>
                  </tr>
                ))}
                {!others.length && <tr><td colSpan={7}><div className="empty">{loaded || users ? '暂无用户' : '加载中…'}</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <footer className="foot"><Link to="/">← 返回总览</Link></footer>
      </main>
    </>
  )
}
