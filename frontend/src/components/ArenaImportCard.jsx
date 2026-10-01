/**
 * 登记自动化：把本地裁判产物粘进来，自动填好双方 / 胜者 / 现金 / 局比分，
 * 再选思考强度、按需改名字与备注，一键登记。sourceKey 保证同一轮不会被登记两次。
 *
 * 支持两种输入：
 *   1) 本仓库导出的 k4u-arena-import/1（带思考强度与来源键）
 *   2) 裁判仓库的 league-head2head/league.json（{rows:[{name,w,l,avg_cash,elo}], seeds:[...]}）
 */
import { useState } from 'react'
import { api } from '../api/client'
import { THINKING_LEVELS } from '../arenaMeta'

const numText = (v) => (v === null || v === undefined || v === '' ? '' : String(Math.round(Number(v) * 100) / 100))

function parsePayload(raw) {
  const d = JSON.parse(raw)
  if (d && d.format === 'k4u-arena-import/1') {
    const a = d.a || {}
    const b = d.b || {}
    return {
      sourceKey: String(d.sourceKey || ''), note: String(d.note || ''),
      playedAt: String(d.playedAt || '').slice(0, 19),
      aName: String(a.name || ''), bName: String(b.name || ''),
      winner: d.winner === 'B' ? 'B' : d.winner === 'draw' ? 'draw' : 'A',
      aCash: numText(a.cashAvg), bCash: numText(b.cashAvg),
      games: d.games ?? null, aWins: a.gamesWon ?? null, bWins: b.gamesWon ?? null,
      margin: numText(d.margin),
    }
  }
  const rows = Array.isArray(d?.rows) ? d.rows : null
  if (rows && rows.length >= 2) {
    const [x, y] = rows
    const xw = Number(x.w) || 0
    const yw = Number(y.w) || 0
    const seeds = Array.isArray(d.seeds) ? d.seeds : []
    return {
      sourceKey: 'league:' + (seeds.join('-') || 'noseeds') + ':' + String(x.name) + '-vs-' + String(y.name),
      note: seeds.length ? seeds.length + ' 个种子 · 导入自裁判产物' : '导入自裁判产物',
      playedAt: '',
      aName: String(x.name || ''), bName: String(y.name || ''),
      winner: xw === yw ? 'draw' : xw > yw ? 'A' : 'B',
      aCash: numText(x.avg_cash), bCash: numText(y.avg_cash),
      games: (xw + yw) || null, aWins: xw, bWins: yw, margin: '',
    }
  }
  throw new Error('无法识别：请粘贴联赛汇总 league.json（含 rows / seeds），或 k4u-arena-import/1 文件')
}

export default function ArenaImportCard({ slug, canWrite, toast, onDone }) {
  const [text, setText] = useState('')
  const [parsed, setParsed] = useState(null)
  const [aName, setAName] = useState('')
  const [bName, setBName] = useState('')
  const [aThinking, setAThinking] = useState('')
  const [bThinking, setBThinking] = useState('')
  const [note, setNote] = useState('')
  const [playedAt, setPlayedAt] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const doParse = () => {
    setErr('')
    try {
      const p = parsePayload(text)
      setParsed(p)
      setAName(p.aName); setBName(p.bName)
      setNote(p.note); setPlayedAt(p.playedAt)
    } catch (e) {
      setParsed(null)
      setErr(e instanceof SyntaxError ? '这段内容不是合法 JSON' : e.message)
    }
  }

  const doImport = async (e) => {
    e.preventDefault()
    if (!parsed) { setErr('先解析一次'); return }
    if (!aName.trim() || !bName.trim()) { setErr('双方名字不能为空'); return }
    setBusy(true); setErr('')
    try {
      const d = await api('/api/arena/matches', { method: 'POST', body: { competition: slug, match: {
        aName: aName.trim(), bName: bName.trim(), winner: parsed.winner,
        aCash: parsed.aCash === '' ? null : Number(parsed.aCash),
        bCash: parsed.bCash === '' ? null : Number(parsed.bCash),
        margin: parsed.margin === '' ? null : Number(parsed.margin),
        games: parsed.games, aWins: parsed.aWins, bWins: parsed.bWins,
        aThinking, bThinking, sourceKey: parsed.sourceKey, note, playedAt,
      } } })
      toast('已登记：' + d.match.aName + ' vs ' + d.match.bName + (d.match.sourceKey ? '（来源 ' + d.match.sourceKey + '）' : ''))
      setParsed(null); setText('')
      onDone && onDone()
    } catch (err2) {
      setErr(err2.message)
    } finally {
      setBusy(false)
    }
  }

  if (!canWrite) return null
  return (
    <div className="card">
      <div className="card-head"><h3>登记自动化 · 粘贴裁判产物</h3>
        <span className="chain" style={{ marginLeft: 'auto' }}>支持 league.json 与 k4u-arena-import/1 · 同一来源不会登记两次</span>
      </div>
      <form onSubmit={doImport} style={{ padding: '0 var(--sp-4) var(--sp-4)' }}>
        <div className="field" style={{ marginBottom: 'var(--sp-3)' }}>
          <label>粘贴内容</label>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={4}
            placeholder='{"rows":[{"name":"gptsol6.1xhigh","w":16,...}],"seeds":[11,23,...]}'
            style={{ width: '100%', fontFamily: 'monospace', fontSize: 12 }} />
        </div>
        <button className="btn small" type="button" onClick={doParse}>解析</button>
        {err && <div className="form-error" style={{ marginTop: 'var(--sp-2)' }}>{err}</div>}
        {parsed && (
          <>
            <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 'var(--sp-3)' }}>
              <div className="stat"><div className="s-label">胜者</div><div className="s-value" style={{ fontSize: 16 }}>{parsed.winner === 'draw' ? '平局' : parsed.winner + ' 胜'}</div></div>
              <div className="stat"><div className="s-label">局比分</div><div className="s-value">{parsed.aWins ?? '—'} : {parsed.bWins ?? '—'}</div></div>
              <div className="stat"><div className="s-label">局数</div><div className="s-value">{parsed.games ?? '—'}</div></div>
              <div className="stat"><div className="s-label">来源键</div><div className="s-value" style={{ fontSize: 12, wordBreak: 'break-all' }}>{parsed.sourceKey || '—'}</div></div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 'var(--sp-3)', marginTop: 'var(--sp-3)' }}>
              <div className="field"><label>A 方名字</label><input value={aName} onChange={(e) => setAName(e.target.value)} maxLength={40} /></div>
              <div className="field"><label>A 方思考强度</label>
                <select value={aThinking} onChange={(e) => setAThinking(e.target.value)}>
                  {THINKING_LEVELS.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
              </div>
              <div className="field"><label>A 终局现金（场均）</label><input value={parsed.aCash} readOnly /></div>
              <div className="field"><label>B 方名字</label><input value={bName} onChange={(e) => setBName(e.target.value)} maxLength={40} /></div>
              <div className="field"><label>B 方思考强度</label>
                <select value={bThinking} onChange={(e) => setBThinking(e.target.value)}>
                  {THINKING_LEVELS.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
                </select>
              </div>
              <div className="field"><label>B 终局现金（场均）</label><input value={parsed.bCash} readOnly /></div>
              <div className="field" style={{ gridColumn: 'span 2' }}><label>备注</label><input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} /></div>
              <div className="field"><label>比赛时间（可留空用当前）</label><input value={playedAt} onChange={(e) => setPlayedAt(e.target.value)} placeholder="2026-10-01T00:30:00" /></div>
            </div>
            <div style={{ marginTop: 'var(--sp-3)', display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
              <button className="btn primary" type="submit" disabled={busy}>{busy ? '登记中…' : '确认登记'}</button>
              <span className="chain">净胜额会按双方现金自动算；局比分用于局级 ELO。</span>
            </div>
          </>
        )}
      </form>
    </div>
  )
}
