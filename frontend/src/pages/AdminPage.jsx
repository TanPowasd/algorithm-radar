import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useApp } from '../state'
import Topbar from '../components/Topbar'
import AuthModal from '../components/AuthModal'
import PublishModal from '../components/PublishModal'
import { api } from '../api/client'
import { difficultyName, lastSub, seriesKey, isPending, isApproved, providerLabel } from '../aggregate'

/**
 * 回收站：软删除的记录（deleted_at 非空）统一在这里管理。
 * 支持 恢复（回原区：可见与否由收录制判定）/ 永久删除 / 清空回收站。
 */
function TrashManager({ onChanged }) {
  const { toast, refreshAll, nicknameOf } = useApp()
  const [records, setRecords] = useState(null) // null=加载中
  const [sel, setSel] = useState(new Set())
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      const res = await api('/api/trash')
      setRecords(res.records || [])
    } catch (e) {
      toast(e.message, 'err')
    }
  }
  useEffect(() => { load() }, [])

  const toggle = (id) => {
    setSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const toggleAll = () => {
    setSel((prev) => prev.size === records.length ? new Set() : new Set((records || []).map((r) => r.id)))
  }

  const restore = async (ids) => {
    if (!ids.length) return
    setBusy(true)
    try {
      const res = await api('/api/trash/restore', { method: 'POST', body: { ids } })
      toast(`已恢复 ${res.restored} 条记录（恢复后按收录制判定是否显示）`)
      setSel(new Set())
      await load()
      await refreshAll()
      onChanged && onChanged()
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const purge = async (ids) => {
    if (!ids.length) return
    if (!window.confirm(`永久删除 ${ids.length} 条记录？此操作不可恢复。`)) return
    setBusy(true)
    try {
      const res = await api('/api/trash/purge', { method: 'POST', body: { ids } })
      toast(`已永久删除 ${res.purged} 条`)
      setSel(new Set())
      await load()
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const empty = async () => {
    if (!records?.length) return
    if (!window.confirm(`清空回收站（${records.length} 条）？全部永久删除，不可恢复。`)) return
    setBusy(true)
    try {
      const res = await api('/api/trash/empty', { method: 'POST' })
      toast(`回收站已清空（${res.purged} 条）`)
      setSel(new Set())
      setRecords([])
      await refreshAll()
      onChanged && onChanged()
    } catch (e) {
      toast(e.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card" id="trash-card">
      <div className="card-head">
        <h2>回收站</h2>
        <span className="hint">被删除/拒绝的记录暂存于此，可恢复或永久清除（防止误删）</span>
        <div className="card-tools">
          <button className="btn small ghost" onClick={toggleAll} disabled={!records?.length}>
            {sel.size === records?.length && records?.length ? '取消全选' : '全选'}
          </button>
          <button className="btn small" onClick={() => restore([...sel])} disabled={!sel.size || busy}>恢复所选</button>
          <button className="btn small danger" onClick={() => purge([...sel])} disabled={!sel.size || busy}>永久删除所选</button>
          <button className="btn small danger" onClick={empty} disabled={!records?.length || busy}>清空回收站</button>
        </div>
      </div>
      <div className="table-scroll">
        <table className="data">
          <thead>
            <tr>
              <th><input type="checkbox" checked={!!records?.length && sel.size === records.length} onChange={toggleAll} /></th>
              <th>模型</th><th>题目</th><th>日期</th><th>提供者</th><th>删除时间</th><th>原因</th>
            </tr>
          </thead>
          <tbody>
            {(records || []).map((r) => (
              <tr key={r.id}>
                <td><input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} /></td>
                <td style={{ fontWeight: 600 }}>{r.model}</td>
                <td>{r.pid}<span className="chain"> {r.title}</span></td>
                <td>{r.date}</td>
                <td>{providerLabel(r, nicknameOf)}</td>
                <td className="chain">{(r.deletedAt || '').slice(0, 19).replace('T', ' ')}</td>
                <td className="chain">{r.status === 'pending' ? '审核拒绝' : '管理员删除'}</td>
              </tr>
            ))}
            {records !== null && records.length === 0 && (
              <tr><td colSpan={7}><div className="empty">回收站是空的</div></td></tr>
            )}
            {records === null && (
              <tr><td colSpan={7}><div className="empty">加载中…</div></td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ModelManager({ onChanged }) {
  const { models, data, toast, refreshAll } = useApp()
  const [form, setForm] = useState({ name: '', vendor: '', note: '' })
  const [editing, setEditing] = useState(null) // 正在编辑的模型 id（null=新增模式）
  const [busy, setBusy] = useState(false)

  const startEdit = (m) => {
    setEditing(m.id)
    setForm({ name: m.name, vendor: m.vendor || '', note: m.note || '' })
  }

  const cancelEdit = () => {
    setEditing(null)
    setForm({ name: '', vendor: '', note: '' })
  }

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      if (editing) {
        // 改名会同步重写历史记录：数据跟随新名（deepseek → deepsleep 时原记录全部跟随）
        const isRename = form.name.trim() !== (models.find((m) => m.id === editing)?.name || '')
        await api(`/api/models/${editing}`, { method: 'PUT', body: form })
        toast(isRename ? `模型已改为「${form.name.trim()}」，相关记录同步更新` : '模型信息已更新')
        cancelEdit()
      } else {
        await api('/api/models', { method: 'POST', body: form })
        toast(`模型 ${form.name} 已添加`)
        cancelEdit()
      }
      await refreshAll()
      onChanged && onChanged()
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (m) => {
    const used = (data.records || []).some((r) => r.model === m.name)
    if (!window.confirm(used
      ? `从目录删除模型「${m.name}」？\n该模型下的历史记录将隐藏（保留在库，重新收录模型后恢复显示）。`
      : `从目录删除模型「${m.name}」？`)) return
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' })
      toast(`已删除 ${m.name}`)
      await refreshAll()
      onChanged && onChanged()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  const editingLabel = editing ? (models.find((m) => m.id === editing)?.name || '') : ''

  return (
    <div className="card" id="models-card">
      <div className="card-head">
        <h2>AI 模型管理</h2>
        <span className="hint">可改名（历史记录同步跟随新名）· 可编辑厂商/备注 · 删除只移出目录不删记录</span>
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
                <td className="actions">
                  <button className="btn small ghost" onClick={() => startEdit(m)}>编辑</button>
                  <button className="btn small danger" onClick={() => remove(m)}>删除</button>
                </td>
              </tr>
            ))}
            {!models.length && <tr><td colSpan={4}><div className="empty">还没有模型，用下方表单添加</div></td></tr>}
          </tbody>
        </table>
      </div>
      <form onSubmit={submit} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1.4fr auto', gap: 10, marginTop: 12 }}>
        <input className="field" style={{ margin: 0 }} placeholder={editing ? `改名（当前：${editingLabel}）` : '模型名 *'} value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        <input className="field" style={{ margin: 0 }} placeholder="厂商" value={form.vendor}
          onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))} />
        <input className="field" style={{ margin: 0 }} placeholder="备注" value={form.note}
          onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} />
        {editing ? (
          <>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn primary" type="submit" disabled={busy || !form.name.trim()}>{busy ? '保存中…' : '保存修改'}</button>
              <button className="btn ghost" type="button" onClick={cancelEdit} disabled={busy}>取消</button>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <span className="chain">改名后「{editingLabel}」名下的全部测评记录将同步改为新名，榜单/统计不受影响。</span>
            </div>
          </>
        ) : (
          <button className="btn primary" type="submit" disabled={busy || !form.name.trim()}>+ 添加模型</button>
        )}
      </form>
    </div>
  )
}

export default function AdminPage() {
  const { session, data, models, isAdmin, isOwner, toast, refreshAll, loaded, nicknameOf } = useApp()
  const providerCell = (r) => providerLabel(r, nicknameOf)
  const [authOpen, setAuthOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [hidden, setHidden] = useState(null) // {problems:[],models:[],total} 未收录分组
  const [collectPid, setCollectPid] = useState('') // 预填发布弹窗的题号
  const [hiddenDetail, setHiddenDetail] = useState(null) // 隐藏记录明细列表（null=未展开）
  const [trashCount, setTrashCount] = useState(0) // 回收站条数（stat 卡用）

  // 加载未收录历史数据分组（管理员视角）
  const loadHidden = async () => {
    if (!isAdmin) return
    try {
      const [h, t] = await Promise.all([
        api('/api/hidden-records'),
        api('/api/trash').catch(() => null),
      ])
      setHidden(h)
      if (t) setTrashCount((t.records || []).length)
    } catch { /* 静默 */ }
  }

  /** 刷新分组 +（若展开）同步明细 */
  const reloadHidden = async () => {
    await loadHidden()
    if (hiddenDetail) {
      try {
        const d = await api('/api/hidden-records/detail')
        setHiddenDetail(d.records || [])
      } catch { /* 静默 */ }
    }
  }

  const toggleHiddenDetail = async () => {
    if (hiddenDetail) { setHiddenDetail(null); return }
    try {
      const res = await api('/api/hidden-records/detail')
      setHiddenDetail(res.records || [])
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  useEffect(() => { if (isAdmin) loadHidden() }, [isAdmin])
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
    if (!window.confirm(`删除该记录（移入回收站）？\n${r.model} · ${r.pid} · ${r.author || '—'}\n可在回收站恢复。`)) return
    try {
      await api(`/api/records/${r.id}`, { method: 'DELETE' })
      toast('已移入回收站')
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const bulk = async (action) => {
    if (!shownPending.length) return
    const label = action === 'approve' ? '通过' : '拒绝并移入回收站'
    if (!window.confirm(`批量${label}当前筛选出的 ${shownPending.length} 条待审记录？\n（回收站内可恢复）`)) return
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
    if (!window.confirm(`从目录移除题目 ${p.pid}？\n该题下的测评记录将隐藏（保留在库，可重新发布该题恢复）。`)) return
    try {
      await api(`/api/problems/${encodeURIComponent(p.pid)}`, { method: 'DELETE' })
      toast(`已从目录移除 ${p.pid}，记录已隐藏`)
      await refreshAll()
      reloadHidden()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  /** 一键收录：发布弹窗预填（题目） / 直接 POST models（模型） */
  const collectProblem = (pid) => {
    setCollectPid(pid)
    setPublishOpen(true)
  }

  const collectModel = async (name) => {
    try {
      await api('/api/models', { method: 'POST', body: { name, vendor: '', note: '' } })
      toast(`模型「${name}」已收录`)
      await refreshAll()
      reloadHidden()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  /** 把“未收录”模型对应的隐藏历史记录移入回收站 */
  const purgeHiddenModel = async (name) => {
    const grp = hidden?.models?.find((m) => m.name === name)
    if (!window.confirm(`将模型「${name}」名下 ${grp?.count ?? ''} 条隐藏历史记录移入回收站？\n（可在回收站恢复）`)) return
    try {
      const res = await api('/api/admin/purge-records', {
        method: 'POST',
        body: { model: name },
      })
      toast(`已移入回收站 ${res.moved} 条`)
      await refreshAll()
      reloadHidden()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  /** 单条隐藏历史记录移入回收站 */
  const removeHiddenRecord = async (r) => {
    if (!window.confirm(`将该隐藏记录移入回收站？\n${r.model} · ${r.pid} · ${r.date}\n（可在回收站恢复）`)) return
    try {
      await api(`/api/records/${r.id}`, { method: 'DELETE' })
      toast('已移入回收站')
      setHiddenDetail((list) => (list || []).filter((x) => x.id !== r.id))
      await refreshAll()
      reloadHidden()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  /** 站长：一键清空目录 + 记录，重新收录 */
  const resetCatalog = async () => {
    if (!window.confirm('⚠️ 清空全部记录、题目目录与模型目录？\n（建议先使用「导出 JSON」备份全量数据。此操作不可恢复）')) return
    try {
      await api('/api/catalog/reset', { method: 'POST' })
      toast('已清空，从零重新收录')
      setHiddenDetail(null)
      await refreshAll()
      reloadHidden()
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
          <div className="stat"><div className="s-label">显示区（已收录·已审核）</div><div className="s-value">{stats.approved}</div></div>
          <div className="stat"><div className="s-label">隐藏区（未收录）</div><div className="s-value">{hidden?.total ?? '…'}</div></div>
          <div className="stat"><div className="s-label">回收站</div><div className="s-value">{trashCount ?? '…'}</div></div>
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
                      <button className="btn small danger" onClick={() => deleteProblem(p)}>
                        移除
                      </button>
                    </td>
                  </tr>
                ))}
                {!problems.length && <tr><td colSpan={7}><div className="empty">还没有发布题目</div></td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card" id="history-card">
          <div className="card-head">
            <h2>未收录历史数据</h2>
            <span className="hint">导入的旧数据统一署名「全民制作人」；收录题目与模型后对应记录才显示</span>
          </div>
          {!hidden ? (
            <div className="empty">加载中…</div>
          ) : (
            <>
              <div className="callout" style={{ marginBottom: 'var(--sp-3)' }}>
                当前有 <strong>{hidden.problems.length}</strong> 道未收录题目、<strong>{hidden.models.length}</strong> 个未收录模型，
                <strong> {hidden.total ?? 0}</strong> 条记录暂不显示（游客/贡献者不可见）。
                发布该题 / 收录该模型后，其下的记录即刻可见。
              </div>
              <div className="grid2" style={{ gap: 'var(--sp-4)', alignItems: 'start' }}>
                <div>
                  <div className="hint" style={{ marginBottom: 6 }}>未收录题目（点击发布收录）</div>
                  <div className="table-scroll">
                    <table className="data">
                      <thead><tr><th>题号</th><th className="num">隐藏记录</th><th>操作</th></tr></thead>
                      <tbody>
                        {hidden.problems.map((g) => (
                          <tr key={g.key} title={g.sample}>
                            <td className="pid-link">{g.name}</td>
                            <td className="num">{g.count}</td>
                            <td><button className="btn small" onClick={() => collectProblem(g.name)}>发布该题</button></td>
                          </tr>
                        ))}
                        {!hidden.problems.length && <tr><td colSpan={3}><div className="empty">全部题目已收录</div></td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <div className="hint" style={{ marginBottom: 6 }}>未收录模型（点击一键收录）</div>
                  <div className="table-scroll">
                    <table className="data">
                      <thead><tr><th>模型</th><th className="num">隐藏记录</th><th>操作</th></tr></thead>
                      <tbody>
                        {hidden.models.map((g) => (
                          <tr key={g.key}>
                            <td style={{ fontWeight: 600 }}>{g.name}</td>
                            <td className="num">{g.count}</td>
                            <td>
                              <button className="btn small" onClick={() => collectModel(g.name)}>收录</button>
                              <button className="btn small danger" style={{ marginLeft: 6 }} onClick={() => purgeHiddenModel(g.name)}>移入回收站</button>
                            </td>
                          </tr>
                        ))}
                        {!hidden.models.length && <tr><td colSpan={3}><div className="empty">全部模型已收录</div></td></tr>}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
              {isOwner && (
                <div style={{ marginTop: 'var(--sp-4)', display: 'flex', justifyContent: 'flex-end', gap: 'var(--sp-2)' }}>
                  <button className="btn small" onClick={toggleHiddenDetail}>
                    {hiddenDetail ? '收起隐藏记录' : `查看 ${hidden.total ?? 0} 条隐藏记录明细`}
                  </button>
                  <button className="btn small danger" onClick={resetCatalog}>⚠ 清空并重新收录（站长）</button>
                </div>
              )}
              {!isOwner && (hidden.total ?? 0) > 0 && (
                <div style={{ marginTop: 'var(--sp-3)', display: 'flex', justifyContent: 'flex-end' }}>
                  <button className="btn small" onClick={toggleHiddenDetail}>
                    {hiddenDetail ? '收起隐藏记录' : `查看 ${hidden.total} 条隐藏记录明细`}
                  </button>
                </div>
              )}
              {hiddenDetail && (
                <div className="table-scroll" style={{ marginTop: 'var(--sp-3)' }}>
                  <table className="data">
                    <thead>
                      <tr><th>模型</th><th>题目</th><th>日期</th><th>提供者</th><th>原因</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {hiddenDetail.map((r) => (
                        <tr key={r.id}>
                          <td style={{ fontWeight: 600 }}>{r.model}</td>
                          <td>{r.pid}<span className="chain"> {r.title}</span></td>
                          <td>{r.date}</td>
                          <td>{providerCell(r)}</td>
                          <td className="chain">
                            {!data.problems?.[r.pid] ? '题目未收录' : ''}
                            {!data.problems?.[r.pid] && !models.some((m) => m.name === r.model) ? ' + ' : ''}
                            {!models.some((m) => m.name === r.model) ? '模型未收录' : ''}
                          </td>
                          <td className="actions">
                            <button className="btn small danger" onClick={() => removeHiddenRecord(r)}>移入回收站</button>
                          </td>
                        </tr>
                      ))}
                      {!hiddenDetail.length && <tr><td colSpan={6}><div className="empty">没有隐藏记录</div></td></tr>}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>

        <TrashManager onChanged={reloadHidden} />

        <ModelManager onChanged={reloadHidden} />

        <footer className="foot">
          <Link to="/">← 返回总览</Link>
        </footer>
      </main>
      {publishOpen && (
        <PublishModal
          initialPid={collectPid}
          onClose={() => { setPublishOpen(false); setCollectPid('') }}
          onPublished={() => { reloadHidden(); refreshAll() }}
        />
      )}
    </>
  )
}
