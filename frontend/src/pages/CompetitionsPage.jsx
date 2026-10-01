/**
 * 比赛列表：同一站点承载多个比赛。
 * 每个比赛有自己的规则、参赛方、战绩与回放；点进去是 /arena/:slug。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useApp } from '../state'
import { api } from '../api/client'

const EMPTY = { slug: '', name: '', subtitle: '', rulesUrl: '', scoreModel: '1v1_cash', status: 'live', sort: '' }
const STATUS_TEXT = { live: '进行中', soon: '即将开始', archived: '已归档' }
const MODEL_TEXT = { '1v1_cash': '1v1 对战（终局现金）', weighted_rank: '多参赛方加权分排名', other: '其他' }
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,31}$/

export default function CompetitionsPage() {
  const { session, toast } = useApp()
  const [list, setList] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState(EMPTY)

  // 新建比赛只有站长可以（和战绩登记同一权限口径）
  const canWrite = session?.role === 'owner'

  const load = useCallback(() => {
    api('/api/competitions')
      .then((d) => { setList(d.competitions || []); setError('') })
      .catch((e) => setError(e.message))
  }, [])
  useEffect(() => { load() }, [load])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const create = async (e) => {
    e.preventDefault()
    setError('')
    const slug = form.slug.trim().toLowerCase()
    if (!SLUG_RE.test(slug)) { setError('短名只能用 2-32 位小写字母、数字与连字符，且以字母或数字开头'); return }
    if (!form.name.trim()) { setError('请填写比赛名称'); return }
    setBusy(true)
    try {
      await api('/api/competitions', {
        method: 'POST',
        body: { competition: { ...form, slug, sort: Number(form.sort) || 0 } },
      })
      toast('比赛已创建')
      setForm(EMPTY)
      setShowNew(false)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Topbar />
      <main className="layout">
        <div className="page-head">
          <h2>比赛</h2>
          <span className="desc">每个比赛有自己的规则、参赛方与战绩 · 点进去看积分榜、对战记录与回放</span>
          {canWrite && (
            <button className="btn small" style={{ marginLeft: 'auto' }} onClick={() => setShowNew((v) => !v)}>
              {showNew ? '收起' : '新建比赛'}
            </button>
          )}
        </div>

        {error && <div className="form-error">{error}</div>}

        {canWrite && showNew && (
          <div className="card">
            <div className="card-head"><h3>新建比赛</h3><span className="chain" style={{ marginLeft: 'auto' }}>先建比赛，再登记战绩与上传回放</span></div>
            <form onSubmit={create} style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
              <div className="filters" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 'var(--sp-3)' }}>
                <div className="field">
                  <label>短名（用于网址 /arena/短名）</label>
                  <input value={form.slug} onChange={set('slug')} placeholder="例：kaggriculture" maxLength={32} />
                </div>
                <div className="field">
                  <label>比赛名称</label>
                  <input value={form.name} onChange={set('name')} placeholder="例：农场对抗赛" maxLength={40} />
                </div>
                <div className="field">
                  <label>状态</label>
                  <select value={form.status} onChange={set('status')}>
                    <option value="live">进行中</option>
                    <option value="soon">即将开始</option>
                    <option value="archived">已归档</option>
                  </select>
                </div>
                <div className="field">
                  <label>评分模型</label>
                  <select value={form.scoreModel} onChange={set('scoreModel')}>
                    <option value="1v1_cash">1v1 对战（终局现金）</option>
                    <option value="weighted_rank">多参赛方加权分排名</option>
                    <option value="other">其他</option>
                  </select>
                </div>
                <div className="field">
                  <label>一句话说明</label>
                  <input value={form.subtitle} onChange={set('subtitle')} placeholder="例：两个 AI 各写一个农场 agent，1v1 对战" maxLength={200} />
                </div>
                <div className="field">
                  <label>规则文档地址（可留空）</label>
                  <input value={form.rulesUrl} onChange={set('rulesUrl')} placeholder="https://..." maxLength={300} />
                </div>
              </div>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <button className="btn primary" type="submit" disabled={busy}>{busy ? '创建中…' : '创建比赛'}</button>
              </div>
            </form>
          </div>
        )}

        {list.map((c) => (
          <div className="card" key={c.id}>
            <div className="card-head">
              <h3><Link to={'/arena/' + c.slug} style={{ textDecoration: 'none', color: 'inherit' }}>{c.name}</Link></h3>
              <span className="chain" style={{ marginLeft: 'auto' }}>
                {STATUS_TEXT[c.status] || c.status} · {MODEL_TEXT[c.scoreModel] || c.scoreModel}
              </span>
            </div>
            <div className="desc" style={{ padding: '0 var(--sp-4)' }}>{c.subtitle || '（暂无说明）'}</div>
            <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)', padding: '0 var(--sp-4)' }}>
              <div className="stat"><div className="s-label">已登记对局</div><div className="s-value">{c.matches}</div></div>
              <div className="stat"><div className="s-label">回放</div><div className="s-value">{c.replays}</div></div>
              <div className="stat"><div className="s-label">最近一场</div><div className="s-value" style={{ fontSize: 15 }}>{c.lastPlayedAt ? String(c.lastPlayedAt).slice(0, 10) : '—'}</div></div>
            </div>
            <div style={{ padding: 'var(--sp-3) var(--sp-4)', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
              <Link className="btn small primary" to={'/arena/' + c.slug}>看积分榜</Link>
              {c.engineSha && <span className="chain" title={c.engineSha}>引擎校验值 {c.engineSha.slice(0, 12)}…</span>}
            </div>
          </div>
        ))}

        {!list.length && !error && <div className="card"><div className="empty">还没有比赛</div></div>}
      </main>
    </>
  )
}
