import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state'
import Topbar from '../components/Topbar'
import AuthModal from '../components/AuthModal'
import PublishModal from '../components/PublishModal'
import { api } from '../api/client'
import { difficultyName, lastSub, seriesKey, isPending, isApproved, todayStr, providerLabel } from '../aggregate'

function ModelManager() {
  const { models, toast, refreshAll } = useApp()
  const [form, setForm] = useState({ name: '', vendor: '', note: '' })
  const [busy, setBusy] = useState(false)

  const add = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api('/api/models', { method: 'POST', body: form })
      toast(`模型 ${form.name} 已添加`)
      setForm({ name: '', vendor: '', note: '' })
      await refreshAll()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (m) => {
    if (!window.confirm(`删除模型「${m.name}」？`)) return
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' })
      toast(`已删除 ${m.name}`)
      await refreshAll()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  return (
    <div className="card" id="models-card">
      <div className="card-head">
        <h2>AI 模型管理</h2>
        <span className="hint">提交测评时从这里选择；已出现在测评记录中的模型不可删除</span>
      </div>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr><th>模型名</th><th>厂商</th><th>备注</th><th>操作</th></tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.id}>
                <td style={{ fontWeight: 600 }}>{m.name}</td>
                <td>{m.vendor || <span className="chain">—</span>}</td>
                <td>{m.note || <span className="chain">—</span>}</td>
                <td>
                  <button className="btn small danger" onClick={() => remove(m)}>删除</button>
                </td>
              </tr>
            ))}
            {!models.length && <tr><td colSpan={4}><div className="empty">还没有模型，用下方表单添加</div></td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={add} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr auto', gap: 10, marginTop: 12 }}>
        <input className="field" style={{ margin: 0 }} placeholder="模型名 *" value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input className="field" style={{ margin: 0 }} placeholder="厂商" value={form.vendor}
          onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))} />
        <input className="field" style={{ margin: 0 }} placeholder="备注" value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        <button className="btn primary" type="submit" disabled={busy}>+ 添加模型</button>
      </form>
    </div>
  )
}

export default function AdminPage() {
  const { session, data, isAdmin, toast, refreshAll, loaded, nicknameOf } = useApp()
  const providerCell = (r) => providerLabel(r, nicknameOf)
  const [authOpen, setAuthOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [filter, setFilter] = useState('')

  const pending = useMemo(() => (data.records || []).filter(isPending), [data.records])
  const problems = useMemo(() => {
    const list = Object.values(data.problems || {})
    list.sort((a, b) => (a.difficulty ?? 9) - (b.difficulty ?? 9) || a.pid.localeCompare(b.pid))
    return list
  }, [data.problems])
  const recordCountByPid = useMemo(() => {
    const map = new Map()
    for (const r of data.records || []) map.set(r.pid, (map.get(r.pid) || 0) + 1)
    return map
  }, [data.records])

  const shownPending = useMemo(() => {
    const kw = filter.trim().toLowerCase()
    if (!kw) return pending
    return pending.filter((r) => [r.model, r.pid, r.title, r.author, r.agent].join(' ').toLowerCase().includes(kw))
  }, [pending, filter])

  const stats = useMemo(() => ({
    pending: pending.length,
    today: (data.records || []).filter((r) => r.date === todayStr()).length,
    guest: (data.records || []).filter((r) => r.author === 'guest' || r.author === '').length,
    approved: (data.records || []).filter(isApproved).length,
  }), [data.records, pending])

  const setStatus = async (r, status) => {
    try {
      await api(`/api/records/${r.id}/status`, { method: 'POST', body: { status } })
      toast(status === 'approved' ? '已通过' : '已退回待审')
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const removeRecord = async (r) => {
    if (!window.confirm(`拒绝并删除该记录？\n${r.model} · ${r.pid} · ${r.author || '—'}`)) return
    try {
      await api(`/api/records/${r.id}`, { method: 'DELETE' })
      toast('已删除')
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const bulk = async (action) => {
    if (!shownPending.length) return
    const label = action === 'approve' ? '通过' : '拒绝并删除'
    if (!window.confirm(`批量${label}当前筛选出的 ${shownPending.length} 条待审记录？`)) return
    try {
      const res = await api('/api/records/bulk', {
        method: 'POST',
        body: { ids: shownPending.map((r) => r.id), action },
      })
      toast(`批量${label}完成（${res.affected} 条）`)
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const deleteProblem = async (p) => {
    if (!window.confirm(`删除题目 ${p.pid}？`)) return
    try {
      await api(`/api/problems/${encodeURIComponent(p.pid)}`, { method: 'DELETE' })
      toast(`已删除 ${p.pid}`)
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  if (!isAdmin) {
    return (
      <>
        <Topbar onOpenAuth={() => setAuthOpen(true)} />
        <main className="layout">
          <div className="card login-gate" id="login-gate">
            <h2 style={{ marginBottom: 10 }}>审核台</h2>
            <p style={{ color: 'var(--text-2)', fontSize: 'var(--fs-sm)' }}>
              需要管理员或站长权限。登录后可审核测评记录、发布题目、管理模型。
            </p>
            {session.loggedIn
              ? <div className="callout">当前账号角色「{session.role}」无审核权限，请联系站长。</div>
              : <button className="btn primary block" onClick={() => setAuthOpen(true)}>登录</button>}
          </div>
        </main>
        {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      </>
    )
  }

  return (
    <>
      <Topbar onOpenPublish={() => setPublishOpen(true)} />
      <main className="layout">
        <div className="page-head">
          <h2>审核台</h2>
          <span className="desc">审核测评记录 · 发布题目 · 管理模型</span>
        </div>

        <div className="stat-cards">
          <div className="stat"><div className="s-label">待审核</div><div className="s-value">{stats.pending}</div></div>
          <div className="stat"><div className="s-label">今日新增</div><div className="s-value">{stats.today}</div></div>
          <div className="stat"><div className="s-label">已通过</div><div className="s-value">{stats.approved}</div></div>
          <div className="stat"><div className="s-label">已发布题目</div><div className="s-value">{problems.length}</div></div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>待审核记录</h2>
            <input className="filters" style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: '6px 10px' }}
              placeholder="筛选 模型/题号/提交人…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <div className="card-tools">
              <button className="btn small" onClick={() => bulk('approve')} disabled={!shownPending.length}>全部通过</button>
              <button className="btn small danger" onClick={() => bulk('reject')} disabled={!shownPending.length}>全部拒绝</button>
            </div>
          </div>
          <div className="table-scroll" id="pending-wrap">
            <table className="data review-table">
              <thead>
                <tr>
                  <th>模型</th><th>题目</th><th>思考</th><th>Agent / Token</th><th>提交轨迹</th><th>提供者</th><th>日期</th><th>操作</th>
                </tr>
              </thead>
              <tbody>
                {shownPending.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{seriesKey(r)}{r.variant ? <div className="chain">{r.variant}</div> : null}</td>
                    <td>{r.pid}<div className="chain">{r.title}</div></td>
                    <td>{r.thinking}</td>
                    <td>{r.agent || '—'} / {r.tokenSource || '—'}</td>
                    <td>{(r.submissions || []).map((s, i) => <span key={i} className="chain">{i + 1}:{s.result} {s.score ?? ''} </span>)}</td>
                    <td>{providerCell(r)}</td>
                    <td>{r.date}</td>
                    <td className="actions">
                      <button className="btn small" onClick={() => setStatus(r, 'approved')}>通过</button>
                      <button className="btn small ghost" onClick={() => setStatus(r, 'pending')} disabled={r.status === 'pending'}>退回</button>
                      <button className="btn small danger" onClick={() => removeRecord(r)}>拒绝</button>
                    </td>
                  </tr>
                ))}
                {!shownPending.length && (
                  <tr><td colSpan={8}><div className="empty">{loaded ? '没有待审核记录，去喝口水吧' : '加载中…'}</div></td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>题目管理</h2>
            <div className="card-tools">
              <button className="btn small primary" onClick={() => setPublishOpen(true)}>+ 发布新题</button>
            </div>
          </div>
          <div className="table-scroll" id="problems-wrap">
            <table className="data">
              <thead>
                <tr><th>题号</th><th>题名</th><th>难度</th><th>标签</th><th>推荐提示词</th><th>记录数</th><th>操作</th></tr>
              </thead>
              <tbody>
                {problems.map((p) => (
                  <tr key={p.pid}>
                    <td className="pid-link">{p.pid}</td>
                    <td>{p.title}</td>
                    <td><span className={`diff-tag d-${p.difficulty ?? 0}`}>{difficultyName(p.difficulty)}</span></td>
                    <td style={{ maxWidth: 280, whiteSpace: 'normal' }}>
                      {(p.tags || []).slice(0, 8).map((t) => <span key={t} className="cat-tag">{t}</span>)}
                      {(p.tags || []).length > 8 && <span className="chain">…</span>}
                    </td>
                    <td>
                      {p.prompt
                        ? <span className="status-tag approved" title={p.prompt}>已配置</span>
                        : <span className="chain" title="再次发布该题号并填写提示词即可补充">未配置</span>}
                    </td>
                    <td className="num">{recordCountByPid.get(p.pid) || 0}</td>
                    <td>
                      <button className="btn small danger" onClick={() => deleteProblem(p)} disabled={(recordCountByPid.get(p.pid) || 0) > 0}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
                {!problems.length && <tr><td colSpan={7}><div className="empty">还没有发布题目</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <ModelManager />

        <footer className="foot">
          <Link to="/">← 返回总览</Link>
        </footer>
      </main>
      {publishOpen && <PublishModal onClose={() => setPublishOpen(false)} />}
    </>
  )
}
