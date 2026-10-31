/**
 * 比赛列表：同一站点承载多个比赛。
 * 每个比赛有自己的规则、参赛方、战绩与回放；点进去是 /arena/:slug。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useApp } from '../state'
import { api } from '../api/client'
import { ArrowUpRight, Plus, RefreshCw, Trophy } from 'lucide-react'
import PageHeading from '../components/PageHeading'

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
  const [loading, setLoading] = useState(true)

  // 新建比赛只有站长可以（和战绩登记同一权限口径）
  const canWrite = session?.role === 'owner'

  const load = useCallback(() => {
    setLoading(true)
    return api('/api/competitions')
      .then((d) => { setList(d.competitions || []); setError('') })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
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
      <main className="layout management-layout competitions-layout">
        <PageHeading title="比赛" description="进入赛场，查看模型的实力榜、历史交锋与对局回放。" eyebrow="ALGORITHM RADAR / COMPETITIONS">
          <span className="page-meta">{loading ? '正在读取比赛' : `${list.length} 场比赛`}</span>
          {canWrite && (
            <button className="btn small" onClick={() => setShowNew((v) => !v)}>
              <Plus size={16} />{showNew ? '收起' : '新建比赛'}
            </button>
          )}
        </PageHeading>

        {error && <div className="form-error" role="alert">{error}<button className="icon-btn" aria-label="重试比赛列表" title="重试" onClick={load}><RefreshCw size={16} /></button></div>}

        {canWrite && showNew && (
          <section className="mg-section">
            <div className="card-head"><h3>新建比赛</h3><span className="chain" style={{ marginLeft: 'auto' }}>先建比赛，再登记战绩与上传回放</span></div>
            <form onSubmit={create}>
              <div className="mg-form-grid">
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
                <div className="field"><label>显示顺序</label><input type="number" value={form.sort} onChange={set('sort')} placeholder="0" /></div>
              </div>
              <div style={{ marginTop: 'var(--sp-3)' }}>
                <button className="btn primary" type="submit" disabled={busy}>{busy ? '创建中…' : '创建比赛'}</button>
              </div>
            </form>
          </section>
        )}

        <div className="competition-list">
        {list.map((c) => (
          <article className="card competition-item" key={c.id}>
            <div className="competition-heading">
              <span className="competition-symbol" aria-hidden="true"><Trophy size={23} /></span>
              <span className={'competition-status status-' + c.status}>{STATUS_TEXT[c.status] || c.status}</span>
              <h2>{c.name}</h2>
              <p>{c.subtitle || '查看参赛模型的对局成绩与表现。'}</p>
              <span className="competition-format">{MODEL_TEXT[c.scoreModel] || c.scoreModel}</span>
            </div>
            <div className="stats mg-stats mg-stats-three">
              <div className="stat"><div className="s-label">已登记对局</div><div className="s-value">{c.matches}</div></div>
              <div className="stat"><div className="s-label">回放</div><div className="s-value">{c.replays}</div></div>
              <div className="stat"><div className="s-label">最近一场</div><div className="s-value" style={{ fontSize: 15 }}>{c.lastPlayedAt ? String(c.lastPlayedAt).slice(0, 10) : '—'}</div></div>
            </div>
            <div className="competition-actions">
              <Link className="btn primary" to={'/arena/' + c.slug} aria-label={'进入' + c.name}>进入比赛<ArrowUpRight size={16} aria-hidden="true" /></Link>
              {/^https?:\/\//i.test(c.rulesUrl || '') && <a className="btn small ghost" href={c.rulesUrl} target="_blank" rel="noopener noreferrer">比赛规则</a>}
              {c.engineSha && <details className="competition-engine"><summary>引擎版本</summary><code>{c.engineSha}</code></details>}
            </div>
          </article>
        ))}
        </div>

        {!list.length && !error && <div className="empty">{loading ? '加载中…' : '还没有比赛'}</div>}
      </main>
    </>
  )
}
