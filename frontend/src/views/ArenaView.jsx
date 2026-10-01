import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApp } from '../state'
import { api } from '../api/client'
import ArenaImportCard from '../components/ArenaImportCard'
import ArenaRenameCard from '../components/ArenaRenameCard'
import { THINKING_LEVELS, thinkingLabel, entityLabel, packEntity, unpackEntity } from '../arenaMeta'

/** 数字展示：空值显示破折号，千分位 */
function num(v, digits = 0) {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function pct(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return (n * 100).toFixed(1) + '%'
}

function TimeCell({ iso }) {
  if (!iso) return <span className="chain">—</span>
  const s = String(iso)
  const d = s.slice(0, 10)
  const t = s.slice(11, 16)
  return (
    <div className="tcell" title={s}>
      <span className="t-date">{d}</span>
      <span className="t-time">{t || '—:—'}</span>
    </div>
  )
}

const WINNER_LABEL = { A: 'A 胜', B: 'B 胜', draw: '平局' }

const EMPTY_FORM = { aName: '', bName: '', winner: 'A', aCash: '', bCash: '', margin: '', games: '1', aWins: '', bWins: '', aThinking: '', bThinking: '', note: '' }

/**
 * 农场对抗赛战绩：登记"谁和谁打、谁赢了、赢了多少"，并自动聚合积分榜。
 * 只做登记与展示——对局本身在本地裁判引擎里跑，这里不执行代码。
 */
export default function ArenaView({ slug: slugProp = 'kaggriculture', onSelect = null }) {
  const { session, toast } = useApp()
  const slug = slugProp
  const navigate = useNavigate()
  const [comp, setComp] = useState(null)
  const [comps, setComps] = useState([])
  const [data, setData] = useState(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [replays, setReplays] = useState([])

  // 对抗赛数据只有站长可写（admin/contributor 均只读）
  const canWrite = session?.role === 'owner'
  const isAdmin = session?.role === 'owner' || session?.role === 'admin'

  // 一个比赛一个页面：数据按 URL 里的比赛短名取（缺省 = 农场对抗赛）
  const load = useCallback(() => {
    api('/api/competitions/' + encodeURIComponent(slug))
      .then((d) => {
        setComp(d.competition || null)
        setData({ matches: d.matches || [], standings: d.standings || [] })
        setReplays(d.replays || [])
        setError('')
      })
      .catch((e) => { setError(e.message); setComp(null); setData(null); setReplays([]) })
  }, [slug])

  useEffect(() => { load() }, [load])

  // 比赛列表：多于一个时才显示切换按钮（主界面页签里用它切比赛）
  useEffect(() => {
    api('/api/competitions')
      .then((d) => setComps(d.competitions || []))
      .catch(() => setComps([]))
  }, [])

  // 双方现金都填了就自动算"赢了多少"（净胜额）
  useEffect(() => {
    if (form.aCash === '' || form.bCash === '') return
    const a = Number(form.aCash)
    const b = Number(form.bCash)
    if (!Number.isFinite(a) || !Number.isFinite(b)) return
    const m = String(Math.abs(a - b))
    setForm((f) => (f.margin === m ? f : { ...f, margin: m }))
  }, [form.aCash, form.bCash])

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    setError('')
    if (!form.aName.trim() || !form.bName.trim()) { setError('请填写 A、B 双方名称'); return }
    if (form.winner !== 'draw' && form.margin === '' && form.aCash === '' && form.bCash === '') {
      setError('请填写"赢了多少"（净胜额），或填双方终局现金让它自动算')
      return
    }
    setBusy(true)
    try {
      await api('/api/arena/matches', {
        method: 'POST',
        body: {
          match: {
            competition: slug,
            aName: form.aName.trim(),
            bName: form.bName.trim(),
            winner: form.winner,
            aCash: form.aCash === '' ? null : Number(form.aCash),
            bCash: form.bCash === '' ? null : Number(form.bCash),
            margin: form.margin === '' ? null : Number(form.margin),
            games: form.games === '' ? null : Number(form.games),
            aWins: form.aWins === '' ? null : Number(form.aWins),
            bWins: form.bWins === '' ? null : Number(form.bWins),
            aThinking: form.aThinking,
            bThinking: form.bThinking,
            note: form.note,
          },
        },
      })
      toast('战绩已登记')
      setForm(EMPTY_FORM)
      load()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  // 上传回放：本地对局录出来的 JSON 直接推进 R2（只有站长能传）
  const uploadReplay = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError('')
    if (file.size > 8 * 1024 * 1024) { setError('回放文件超过 8 MB 上限'); return }
    setBusy(true)
    try {
      const replay = JSON.parse(await file.text())
      const d = await api('/api/arena/replays', { method: 'POST', body: { replay, competition: slug } })
      toast('回放已上传：' + (d.replay?.aName || '?') + ' vs ' + (d.replay?.bName || '?'))
      load()
    } catch (err) {
      setError(err instanceof SyntaxError ? '这个文件不是合法 JSON' : err.message)
    } finally {
      setBusy(false)
    }
  }

  const removeReplay = async (r) => {
    if (!window.confirm('删除这份回放？R2 里的文件也会一起删掉。')) return
    try {
      await api('/api/arena/replays/' + r.id, { method: 'DELETE' })
      toast('回放已删除')
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  const remove = async (m) => {
    if (!window.confirm('删除这条战绩？删掉后积分榜会立即重算。')) return
    try {
      await api('/api/arena/matches/' + m.id, { method: 'DELETE' })
      toast('已删除')
      load()
    } catch (err) {
      setError(err.message)
    }
  }

  const matches = data?.matches || []
  const standings = data?.standings || []
  const totalMargin = useMemo(() => matches.reduce((a, m) => a + (Number(m.margin) || 0), 0), [matches])

  // 两两对比：任选两个模型看历史交锋
  const [h2hA, setH2hA] = useState('')
  const [h2hB, setH2hB] = useState('')
  const [h2h, setH2h] = useState(null)
  const [h2hError, setH2hError] = useState('')

  // 默认选实力榜前两名
  useEffect(() => {
    const ents = standings.map((s) => packEntity(s.name, s.thinking))
    if (!h2hA && ents[0]) setH2hA(ents[0])
    if (!h2hB && ents[1]) setH2hB(ents[1])
  }, [standings, h2hA, h2hB])

  useEffect(() => {
    if (!h2hA || !h2hB || h2hA === h2hB) { setH2h(null); return }
    const ea = unpackEntity(h2hA)
    const eb = unpackEntity(h2hB)
    let alive = true
    api('/api/arena/h2h?competition=' + encodeURIComponent(slug)
      + '&a=' + encodeURIComponent(ea.name) + '&aThinking=' + encodeURIComponent(ea.thinking)
      + '&b=' + encodeURIComponent(eb.name) + '&bThinking=' + encodeURIComponent(eb.thinking)
      + '&strict=1')
      .then((d) => { if (alive) { setH2h(d); setH2hError('') } })
      .catch((e) => { if (alive) { setH2h(null); setH2hError(e.message) } })
    return () => { alive = false }
  }, [h2hA, h2hB, slug, matches])

  const h2hGames = (h2h?.series || []).reduce((acc, s) => ({ a: acc.a + s.aWins, b: acc.b + s.bWins }), { a: 0, b: 0 })

  return (
    <>
        <div className="page-head">
          <h2>{comp?.name || '比赛'} · 战绩</h2>
          {!onSelect && <Link className="btn small ghost" style={{ marginLeft: 'auto' }} to="/arena">← 全部比赛</Link>}
          <span className="desc">登记"谁和谁打、谁赢了、赢了多少" · 局级 ELO 实力榜自动聚合 · 仅站长可写</span>
        </div>

        {comps.length > 1 && (
          <div style={{ display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap', marginBottom: 'var(--sp-3)' }}>
            {comps.map((c) => (
              <button key={c.id} type="button"
                className={'btn small ' + (c.slug === slug ? 'primary' : 'ghost')}
                onClick={() => (onSelect ? onSelect(c.slug) : navigate('/arena/' + c.slug))}>{c.name}</button>
            ))}
          </div>
        )}

        <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-accent" />已登记对局</div><div className="s-value">{matches.length}</div></div>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-green" />参战 agent</div><div className="s-value">{standings.length}</div></div>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-purple" />战绩总净胜</div><div className="s-value">{num(totalMargin)}</div></div>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-orange" />登记人</div><div className="s-value" style={{ fontSize: 'var(--fs-lg)', paddingTop: 6 }}>{canWrite ? (session.nickname || session.username) : '未登录（只读）'}</div></div>
        </div>

        {error && <div className="form-error">{error}</div>}

        {canWrite ? (
          <div className="card">
            <div className="card-head"><h3>登记一场对战</h3></div>
            <form onSubmit={submit} style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
              <div className="filters" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 'var(--sp-3)' }}>
                <div className="field">
                  <label>A 方（先手 / 挑战者）</label>
                  <input value={form.aName} onChange={set('aName')} placeholder="例：dsf" maxLength={40} list="arena-agents" />
                </div>
                <div className="field">
                  <label>B 方（后手 / 对手）</label>
                  <input value={form.bName} onChange={set('bName')} placeholder="例：qwen" maxLength={40} list="arena-agents" />
                </div>
                <div className="field">
                  <label>谁赢了</label>
                  <select value={form.winner} onChange={set('winner')}>
                    <option value="A">A 胜</option>
                    <option value="B">B 胜</option>
                    <option value="draw">平局</option>
                  </select>
                </div>
                <div className="field">
                  <label>赢了多少（净胜额，可留空自动算）</label>
                  <input value={form.margin} onChange={set('margin')} inputMode="decimal" placeholder="例：20236" />
                </div>
                <div className="field">
                  <label>A 终局现金（可选）</label>
                  <input value={form.aCash} onChange={set('aCash')} inputMode="decimal" placeholder="例：24302" />
                </div>
                <div className="field">
                  <label>B 终局现金（可选）</label>
                  <input value={form.bCash} onChange={set('bCash')} inputMode="decimal" placeholder="例：2660" />
                </div>
                <div className="field">
                  <label>A 方思考强度</label>
                  <select value={form.aThinking} onChange={set('aThinking')}>
                    {THINKING_LEVELS.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>B 方思考强度</label>
                  <select value={form.bThinking} onChange={set('bThinking')}>
                    {THINKING_LEVELS.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                  </select>
                </div>
                <div className="field">
                  <label>局比分：A 胜局（可选）</label>
                  <input value={form.aWins} onChange={set('aWins')} inputMode="numeric" placeholder="例：16" />
                </div>
                <div className="field">
                  <label>局比分：B 胜局（可选）</label>
                  <input value={form.bWins} onChange={set('bWins')} inputMode="numeric" placeholder="例：0" />
                </div>
                <div className="field">
                  <label>局数（可选，填了局比分可留空）</label>
                  <input value={form.games} onChange={set('games')} inputMode="numeric" placeholder="1" />
                </div>
                <div className="field" style={{ gridColumn: 'span 2' }}>
                  <label>备注（可选，例：8 种子双座位 / 冠军对照组）</label>
                  <input value={form.note} onChange={set('note')} maxLength={200} placeholder="例：4 种子 × 双方座位，8:0" />
                </div>
              </div>
              <datalist id="arena-agents">
                {standings.map((s) => <option key={s.name} value={s.name} />)}
              </datalist>
              <div style={{ marginTop: 'var(--sp-3)', display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
                <button className="btn primary" type="submit" disabled={busy}>{busy ? '提交中…' : '登记战绩'}</button>
                <span className="chain">净胜额 = 赢家终局现金 − 输家终局现金；只填净胜额也可以。</span>
              </div>
            </form>
          </div>
        ) : (
          <div className="card"><div className="empty">对抗赛战绩只有站长可以登记与修改；其他账号为只读视图</div></div>
        )}

        <ArenaImportCard slug={slug} canWrite={canWrite} toast={toast} onDone={load} />

        <ArenaRenameCard slug={slug} standings={standings} canWrite={canWrite} toast={toast} onDone={load} />

        <div className="card">
          <div className="card-head"><h3>实力榜（局级 ELO）</h3><span className="chain" style={{ marginLeft: 'auto' }}>按局级 ELO 排序 · 每轮 16 局逐局计入，赢强对手涨得多</span></div>
          {!standings.length && <div className="empty">还没有战绩，先登记一场</div>}
          {!!standings.length && (
            <div className="table-scroll">
              <table className="data lb-table">
                <thead>
                  <tr>
                    <th>#</th><th>Agent</th><th>思考强度</th>
                    <th className="num">ELO</th><th className="num">局数</th><th className="num">局胜-负</th><th className="num">局胜率</th>
                    <th className="num">轮次</th><th className="num">轮胜率</th><th className="num">场均净胜</th><th className="num">累计净胜</th>
                  </tr>
                </thead>
                <tbody>
                  {standings.map((s, i) => (
                    <tr key={s.name}>
                      <td className="lb-rank">{i + 1}</td>
                      <td className="lb-model">{s.name}</td>
                      <td>{thinkingLabel(s.thinking)}</td>
                      <td className="num" style={{ fontWeight: 700 }}>{num(s.elo)}</td>
                      <td className="num">{s.games}</td>
                      <td className="num">{s.gameWins}-{s.gameLosses}</td>
                      <td className="num">{pct(s.gameWinRate)}</td>
                      <td className="num">{s.matches}</td>
                      <td className="num">{pct(s.winRate)}</td>
                      <td className="num">{num(s.netAvg)}</td>
                      <td className="num">{num(s.netTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head"><h3>两两对比（历史交锋）</h3><span className="chain" style={{ marginLeft: 'auto' }}>任选两个模型，看他们的全部交手记录</span></div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 'var(--sp-3)', padding: '0 var(--sp-4)' }}>
            <div className="field">
              <label>模型 A</label>
              <select value={h2hA} onChange={(e) => setH2hA(e.target.value)}>
                <option value="">（请选择）</option>
                {standings.map((s) => <option key={packEntity(s.name, s.thinking)} value={packEntity(s.name, s.thinking)}>{entityLabel(s.name, s.thinking)}（ELO {num(s.elo)}）</option>)}
              </select>
            </div>
            <div className="field">
              <label>模型 B</label>
              <select value={h2hB} onChange={(e) => setH2hB(e.target.value)}>
                <option value="">（请选择）</option>
                {standings.map((s) => <option key={packEntity(s.name, s.thinking)} value={packEntity(s.name, s.thinking)}>{entityLabel(s.name, s.thinking)}（ELO {num(s.elo)}）</option>)}
              </select>
            </div>
          </div>
          {h2hError && <div className="form-error">{h2hError}</div>}
          {h2h && (
            <>
              <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', padding: '0 var(--sp-4)' }}>
                <div className="stat"><div className="s-label">交手轮次</div><div className="s-value">{h2h.series.length}</div></div>
                <div className="stat"><div className="s-label">{entityLabel(h2h.a.name, h2h.a.thinking)} 轮次战绩</div><div className="s-value" style={{ fontSize: 16 }}>{h2h.a.seriesWins} 胜 {h2h.a.seriesLosses} 负</div></div>
                <div className="stat"><div className="s-label">局比分合计</div><div className="s-value">{h2hGames.a} : {h2hGames.b}</div></div>
                <div className="stat"><div className="s-label">场均现金（A / B）</div><div className="s-value" style={{ fontSize: 16 }}>{num(h2h.a.cashAvg)} / {num(h2h.b.cashAvg)}</div></div>
              </div>
              {!!h2h.series.length && (
                <div className="table-scroll">
                  <table className="data lb-table">
                    <thead>
                      <tr>
                        <th>时间</th><th>A 方</th><th className="num">A 现金</th><th>B 方</th><th className="num">B 现金</th>
                        <th>结果</th><th className="num">局比分</th><th className="num">净胜额</th><th>备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      {h2h.series.map((s, i) => (
                        <tr key={i}>
                          <td><TimeCell iso={s.playedAt} /></td>
                          <td className="lb-model">{s.aName}</td>
                          <td className="num">{num(s.aCash)}</td>
                          <td className="lb-model">{s.bName}</td>
                          <td className="num">{num(s.bCash)}</td>
                          <td>{s.winner === 'draw' ? '平局' : (s.winner === 'A' ? s.aName + ' 胜' : s.bName + ' 胜')}</td>
                          <td className="num">{s.aWins} : {s.bWins}</td>
                          <td className="num">{num(s.margin)}</td>
                          <td className="chain">{s.note || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!h2h.series.length && <div className="empty">这两个模型还没有交手记录</div>}
            </>
          )}
          {!h2h && !h2hError && <div className="empty">选择两个不同的模型后显示历史交锋</div>}
        </div>

        <div className="card">
          <div className="card-head"><h3>对战记录</h3><span className="chain" style={{ marginLeft: 'auto' }}>新 → 旧，最多 300 条</span></div>
          {!matches.length && <div className="empty">还没有记录</div>}
          {!!matches.length && (
            <div className="table-scroll">
              <table className="data lb-table">
                <thead>
                  <tr>
                    <th>时间</th><th>A 方</th><th className="num">A 现金</th><th>B 方</th><th className="num">B 现金</th>
                    <th>结果</th><th className="num">赢了多少</th><th className="num">局数</th><th>备注</th><th>登记人</th>
                    {isAdmin && <th>操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => (
                    <tr key={m.id}>
                      <td><TimeCell iso={m.playedAt} /></td>
                      <td className="lb-model">{m.aName}</td>
                      <td className="num">{num(m.aCash)}</td>
                      <td className="lb-model">{m.bName}</td>
                      <td className="num">{num(m.bCash)}</td>
                      <td>
                        <span className={'status-tag ' + (m.winner === 'draw' ? 'role-contributor' : 'role-admin')}>
                          {m.winner === 'draw' ? '平局' : (m.winner === 'A' ? m.aName + ' 胜' : m.bName + ' 胜')}
                        </span>
                      </td>
                      <td className="num" style={{ fontWeight: 700 }}>{num(m.margin)}</td>
                      <td className="num">{m.games}</td>
                      <td>{m.note || <span className="chain">—</span>}</td>
                      <td>{m.author || <span className="chain">—</span>}</td>
                      {isAdmin && <td className="actions"><button className="btn small ghost" onClick={() => remove(m)}>删除</button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>对局回放</h3>
            <span className="chain" style={{ marginLeft: 'auto' }}>棋盘动画 + 现金曲线 + 每步动作</span>
          </div>
          {canWrite && (
            <div className="filters">
              <label className="btn small">
                上传回放 JSON
                <input type="file" accept=".json,application/json" hidden onChange={uploadReplay} />
              </label>
              <span className="chain">把 scripts/record_replay.py 录出来的 replays/*.json 传上来（≤ 8 MB），全站可看</span>
            </div>
          )}
          {!replays.length && <div className="empty">还没有回放{canWrite ? '，先传一份试试' : ''}</div>}
          {!!replays.length && (
            <div className="table-scroll">
              <table className="data lb-table">
                <thead>
                  <tr>
                    <th>上传时间</th><th>A 方</th><th>B 方</th><th className="num">种子</th>
                    <th>结果</th><th className="num">步数</th><th className="num">大小</th>
                    <th>上传人</th><th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {replays.map((r) => (
                    <tr key={r.id}>
                      <td><TimeCell iso={r.createdAt} /></td>
                      <td className="lb-model">{r.aName}</td>
                      <td className="lb-model">{r.bName}</td>
                      <td className="num">{r.seed ?? '—'}</td>
                      <td>{r.winner === 'draw' ? '平局' : (r.winner ? r.winner + ' 胜' : (r.endReason || '—'))}</td>
                      <td className="num">{r.steps || r.frames}</td>
                      <td className="num">{Math.round((r.bytes || 0) / 1024)} KB</td>
                      <td>{r.author || <span className="chain">—</span>}</td>
                      <td className="actions">
                        <a className="btn small" href={'/replay#src=/api/arena/replays/' + r.id} target="_blank" rel="noreferrer">看回放</a>
                        {canWrite && <button className="btn small ghost" onClick={() => removeReplay(r)}>删除</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
    </>
  )
}
