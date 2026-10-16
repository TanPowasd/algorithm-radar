import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react'
import { useApp } from '../state'
import Topbar from '../components/Topbar'
import AuthModal from '../components/AuthModal'
import { api } from '../api/client'
import TimeCell from '../components/TimeCell'
import ResetPasswordModal from '../components/ResetPasswordModal'
import { useUrlState } from '../hooks/useUrlState'

const ROLE_LABEL = { owner: '站长', admin: '管理员', contributor: '贡献者' }
const STATUS_LABEL = { active: '已激活', pending: '待审核', rejected: '已拒绝' }
const ACTION_LABEL = {
  'user.delete': '删除账号', 'user.role': '任免角色', 'user.approve': '批准注册', 'user.password': '重置密码',
  'user.reject': '拒绝注册', 'record.delete': '删除记录', 'records.bulk': '批量审核',
  'trash.purge': '永久删除', 'trash.empty': '清空回收站', 'problem.delete': '删除题目',
  'model.delete': '删除模型', 'catalog.reset': '清空目录', import: '导入数据',
}
const PAGE_SIZE = 30

export default function UsersPage() {
  const { session, isOwner, isAdmin, toast } = useApp()
  const url = useUrlState('users')
  const [authOpen, setAuthOpen] = useState(false)
  const [users, setUsers] = useState(null)
  const [audit, setAudit] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [pwUser, setPwUser] = useState(null) // 正在重置密码的目标用户
  const [tab, setTab] = useState(() => ['pending', 'people', 'audit'].includes(url.get('tab')) ? url.get('tab') : 'people')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const activeTab = !isOwner && tab === 'pending' ? 'people' : tab
  const identity = `${session.uid ?? session.username}:${session.role}`
  const activeIdentity = useRef('')
  const loadVersion = useRef(0)

  const load = useCallback(async () => {
    if (activeIdentity.current !== identity) return
    const version = ++loadVersion.current
    try {
      const [u, a] = await Promise.all([api('/api/admin/users'), api('/api/admin/audit')])
      if (version !== loadVersion.current || activeIdentity.current !== identity) return
      setUsers(u.users || [])
      setAudit(a.entries || [])
      setError('')
    } catch (e) { if (version === loadVersion.current && activeIdentity.current === identity) setError(e.message) }
  }, [identity])
  useEffect(() => {
    activeIdentity.current = identity
    if (isAdmin) load()
    return () => { activeIdentity.current = ''; loadVersion.current++ }
  }, [isAdmin, load, identity])

  const pending = useMemo(() => (users || []).filter((u) => u.status === 'pending'), [users])
  const people = useMemo(() => (users || []).filter((u) => isOwner
    ? u.status !== 'pending'
    : u.role === 'contributor' && u.status === 'active'), [users, isOwner])
  const source = activeTab === 'audit' ? audit || [] : activeTab === 'pending' ? pending : people
  const keyword = query.trim().toLowerCase()
  const rows = source.filter((r) => (activeTab === 'audit'
    ? [r.actor, r.action, ACTION_LABEL[r.action], r.detail]
    : [r.username, r.nickname, ROLE_LABEL[r.role], STATUS_LABEL[r.status]]).join(' ').toLowerCase().includes(keyword))
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE))
  const safePage = Math.min(page, pages - 1)
  const shown = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
  const selectTab = (next) => { setTab(next); setQuery(''); setPage(0); url.set('tab', next) }

  const act = async (path, confirmMsg, { method = 'POST', body = {} } = {}) => {
    if (busy || (confirmMsg && !window.confirm(confirmMsg))) return
    setBusy(true)
    try {
      await api(path, { method, body })
      toast('操作成功')
      await load()
    } catch (e) { toast(e.message, 'err') }
    finally { setBusy(false) }
  }
  const deleteConfirm = (u) => `永久删除账号 ${u.username}？\n该账号立即失效，此操作不可恢复。已提交的测评记录会保留。`

  if (!isAdmin) return <>
    <Topbar onOpenAuth={() => setAuthOpen(true)} />
    <main className="layout management-layout">
      <section className="mg-section login-gate"><h2>用户管理</h2>
        {session.loggedIn ? <div className="callout">当前账号权限不足。</div>
          : <button className="btn primary" onClick={() => setAuthOpen(true)}>登录</button>}
      </section>
    </main>
    {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
  </>

  return <>
    <Topbar />
    <main className="layout management-layout">
      <div className="page-head"><h2>用户管理</h2><span className="desc">{isOwner ? '注册审核与账号权限' : '贡献者账号'}</span>
        <button className="icon-btn" title="刷新用户与审计" aria-label="刷新用户与审计" disabled={busy} onClick={load}><RefreshCw size={16} /></button>
      </div>
      <nav className="mg-tabs" aria-label="用户管理分区">
        {isOwner && <button className={activeTab === 'pending' ? 'active' : ''} aria-current={activeTab === 'pending' ? 'page' : undefined} onClick={() => selectTab('pending')}>注册申请<span>{pending.length}</span></button>}
        <button className={activeTab === 'people' ? 'active' : ''} aria-current={activeTab === 'people' ? 'page' : undefined} onClick={() => selectTab('people')}>{isOwner ? '全部用户' : '贡献者'}<span>{people.length}</span></button>
        <button className={activeTab === 'audit' ? 'active' : ''} aria-current={activeTab === 'audit' ? 'page' : undefined} onClick={() => selectTab('audit')}>操作审计<span>{audit?.length ?? '…'}</span></button>
      </nav>
      {error && <div className="form-error" role="alert">{error}</div>}
      <section className="mg-section" aria-busy={busy}>
        <div className="card-head">
          <h3>{activeTab === 'audit' ? '操作审计' : activeTab === 'pending' ? '待审核注册' : isOwner ? '全部用户' : '贡献者'}</h3>
          <input aria-label="查找用户或审计" className="filter-search" placeholder={activeTab === 'audit' ? '操作人、动作、详情' : '用户名、昵称、身份'} value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} />
          <span className="hint">{activeTab === 'audit' ? '最近 100 条' : activeTab === 'pending' ? '审核群 1107535292' : '站长账号受保护'}</span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>{activeTab === 'audit'
              ? <tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th></tr>
              : <tr><th>用户 ID</th><th>昵称</th><th>角色</th><th>状态</th><th>注册时间</th><th>批准人</th><th>操作</th></tr>}</thead>
            <tbody>{shown.map((r) => activeTab === 'audit'
              ? <tr key={r.id}><td><TimeCell value={r.createdAt} /></td><td>{r.actor || '—'}</td><td><span className="status-tag">{ACTION_LABEL[r.action] || r.action}</span></td><td className="mg-wrap-cell">{r.detail || '—'}</td></tr>
              : <tr key={r.id}>
                <td><strong>{r.username}</strong><span className="chain"> #{r.id}</span></td>
                <td>{r.nickname || '—'}</td>
                <td><span className={`status-tag role-${r.role}`}>{ROLE_LABEL[r.role] || r.role}</span></td>
                <td><span className={`status-tag st-${r.status}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                <td><TimeCell value={r.createdAt} /></td><td>{r.approvedBy || '—'}</td>
                <td className="actions">
                  {isOwner && r.status === 'pending' && <>
                    <button className="btn small" disabled={busy} onClick={() => act(`/api/admin/users/${r.id}/approve`)}>批准为贡献者</button>
                    <button className="btn small danger" disabled={busy} onClick={() => act(`/api/admin/users/${r.id}/reject`, `拒绝 ${r.username} 的注册申请？`)}>拒绝</button>
                  </>}
                  {isOwner && r.role !== 'owner' && r.status === 'active' && <button className="btn small ghost" disabled={busy} onClick={() => act(
                    `/api/admin/users/${r.id}/role`,
                    `${r.role === 'contributor' ? '任命' : '免除'} ${r.username} 的管理员权限？`,
                    { body: { role: r.role === 'contributor' ? 'admin' : 'contributor' } },
                  )}>{r.role === 'contributor' ? '任命管理员' : '免除管理员'}</button>}
                  {r.role !== 'owner' && <button className="btn small danger" disabled={busy} onClick={() => act(`/api/admin/users/${r.id}`, deleteConfirm(r), { method: 'DELETE' })}>删除账号</button>}
                  {r.role !== 'owner' && (isOwner || r.role === 'contributor') && <button className="btn small ghost" disabled={busy} onClick={() => setPwUser(r)}>重置密码</button>}
                  {r.role === 'owner' && <span className="chain">站长账号受保护</span>}
                </td>
              </tr>)}
              {!shown.length && <tr><td colSpan={activeTab === 'audit' ? 4 : 7}><div className="empty">{users === null && !error ? '加载中…' : query ? '没有匹配结果' : '暂无记录'}</div></td></tr>}
            </tbody>
          </table>
        </div>
        <div className="mg-pager"><span>{rows.length} 条 · {safePage + 1} / {pages}</span>
          <button className="icon-btn" title="上一页" aria-label="上一页" disabled={!safePage} onClick={() => setPage(safePage - 1)}><ChevronLeft size={16} /></button>
          <button className="icon-btn" title="下一页" aria-label="下一页" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}><ChevronRight size={16} /></button>
        </div>
      </section>
      <footer className="foot"><Link to="/">返回评测</Link></footer>
    </main>
    {pwUser && <ResetPasswordModal user={pwUser} onClose={() => setPwUser(null)} onDone={load} />}
  </>
}
