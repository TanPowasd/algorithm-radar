/** 批量改选手名 / 思考强度：把某个选手的所有登记记录一次改掉（含把名字里的 high/max 拆成思考强度） */
import { useMemo, useState } from 'react'
import { api } from '../api/client'
import { THINKING_LEVELS, entityLabel, packEntity, unpackEntity } from '../arenaMeta'

export default function ArenaRenameCard({ slug, standings, canWrite, toast, onDone }) {
  const options = useMemo(
    () => standings.map((s) => ({ value: packEntity(s.name, s.thinking), label: entityLabel(s.name, s.thinking) + '（' + s.matches + ' 轮）' })),
    [standings])
  const [from, setFrom] = useState('')
  const [toName, setToName] = useState('')
  const [toThinking, setToThinking] = useState('')
  const [scope, setScope] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  if (!canWrite) return null

  const pickFrom = (v) => {
    setFrom(v); setScope(null); setErr('')
    const { name, thinking } = unpackEntity(v)
    setToName(name); setToThinking(thinking)
  }
  const changeTarget = (setter, value) => { setter(value); setScope(null) }

  const submit = async (dryRun) => {
    setErr('')
    const src = unpackEntity(from)
    if (!src.name) { setErr('先选择要改的选手'); return }
    setBusy(true)
    try {
      const d = await api('/api/arena/agents/rename', { method: 'POST', body: {
        competition: slug, dryRun,
        fromName: src.name, fromThinking: src.thinking,
        toName: toName.trim(), toThinking,
      } })
      if (dryRun) {
        setScope(d)
        if ((d.asA + d.asB) === 0) setErr('这个选手还没有登记记录')
      } else {
        toast(d.message || '已改名')
        setScope(null); setFrom('')
        if (onDone) onDone()
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="mg-section">
      <div className="card-head"><h3>批量改选手名 / 思考强度</h3>
        <span className="chain" style={{ marginLeft: 'auto' }}>一次改掉这个选手的全部登记记录（A、B 两侧都改）</span>
      </div>
      <fieldset className="mg-fieldset" disabled={busy}>
        <div className="mg-form-grid">
          <div className="field"><label>要改的选手</label>
            <select value={from} onChange={(e) => pickFrom(e.target.value)}>
              <option value="">（请选择）</option>
              {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="field"><label>新名字</label><input value={toName} onChange={(e) => changeTarget(setToName, e.target.value)} maxLength={40} placeholder="例：deepseek v4.1flash" /></div>
          <div className="field"><label>新思考强度</label>
            <select value={toThinking} onChange={(e) => changeTarget(setToThinking, e.target.value)}>
              {THINKING_LEVELS.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
            </select>
          </div>
        </div>
        {err && <div className="form-error" style={{ marginTop: 'var(--sp-2)' }}>{err}</div>}
        {scope && (
          <div className="chain" style={{ marginTop: 'var(--sp-2)' }}>
            会影响 {scope.asA + scope.asB} 条记录（A 侧 {scope.asA} 条、B 侧 {scope.asB} 条）
          </div>
        )}
        <div style={{ marginTop: 'var(--sp-3)', display: 'flex', gap: 'var(--sp-2)', alignItems: 'center' }}>
          <button className="btn small" type="button" disabled={busy} onClick={() => submit(true)}>预览影响</button>
          <button className="btn primary" type="button" disabled={busy || !scope || scope.asA + scope.asB === 0} onClick={() => submit(false)}>
            {busy ? '处理中…' : '确认改名'}
          </button>
          <span className="chain">先把名字里的 high / max 拆成思考强度，再按「模型 + 思考强度」看榜会更清楚。</span>
        </div>
      </fieldset>
    </section>
  )
}
