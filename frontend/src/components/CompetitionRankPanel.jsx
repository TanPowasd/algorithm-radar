/**
 * 主界面的比赛排名板块：读 /api/competitions 与 /api/competitions/:slug，
 * 展示该比赛的局级 ELO 榜（前若干名）与最近一轮结果，并提供完整榜单入口。
 * 没有比赛或还没有战绩时整块不渲染，避免主界面出现空壳。
 */
import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api/client'
import { entityLabel } from '../arenaMeta'

const TOP_N = 6

function num(v, digits = 0) {
  if (v === null || v === undefined || v === '') return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

function pct(v) {
  const n = Number(v)
  return Number.isFinite(n) ? (n * 100).toFixed(0) + '%' : '—'
}

/** 一轮的局比分：登记了就用，没登记按胜者全胜推断（与服务端一致） */
function seriesScore(m) {
  const games = Math.max(1, Number(m.games) || 1)
  if (m.winner === 'draw') return { a: 0, b: 0 }
  if (m.aWins !== null && m.aWins !== undefined && m.bWins !== null && m.bWins !== undefined) {
    return { a: Number(m.aWins), b: Number(m.bWins) }
  }
  return m.winner === 'A' ? { a: games, b: 0 } : { a: 0, b: games }
}

export default function CompetitionRankPanel() {
  const [comps, setComps] = useState([])
  const [slug, setSlug] = useState('')
  const [detail, setDetail] = useState(null)

  useEffect(() => {
    api('/api/competitions')
      .then((d) => {
        const list = (d.competitions || []).filter((c) => c.status !== 'archived')
        setComps(list)
        const withGames = list.find((c) => (c.matches || 0) > 0)
        const pick = withGames || list[0]
        if (pick) setSlug((s) => s || pick.slug)
      })
      .catch(() => setComps([]))
  }, [])

  const load = useCallback(() => {
    if (!slug) return
    api('/api/competitions/' + encodeURIComponent(slug))
      .then((d) => setDetail(d))
      .catch(() => setDetail(null))
  }, [slug])
  useEffect(() => { load() }, [load])

  const comp = detail?.competition
  const standings = detail?.standings || []
  const latest = (detail?.matches || [])[0]
  if (!comps.length || !comp || !standings.length) return null

  return (
    <section className="card" style={{ marginBottom: 'var(--sp-4)' }}>
      <div className="card-head">
        <h3>比赛排名 · {comp.name}</h3>
        <span className="chain" style={{ marginLeft: 'auto' }}>局级 ELO · 每轮逐局计入 · 赢强对手涨得多</span>
      </div>

      {comps.length > 1 && (
        <div style={{ padding: '0 var(--sp-4) var(--sp-2)', display: 'flex', gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
          {comps.map((c) => (
            <button key={c.id} type="button"
              className={'btn small ' + (c.slug === slug ? 'primary' : 'ghost')}
              onClick={() => setSlug(c.slug)}>{c.name}</button>
          ))}
        </div>
      )}

      <div className="table-scroll">
        <table className="data lb-table">
          <thead>
            <tr>
              <th>#</th><th>选手</th><th>思考强度</th>
              <th className="num">ELO</th><th className="num">局数</th><th className="num">局胜率</th>
              <th className="num">轮次</th><th className="num">场均净胜</th>
            </tr>
          </thead>
          <tbody>
            {standings.slice(0, TOP_N).map((s, i) => (
              <tr key={s.name + '\u0000' + s.thinking}>
                <td className="lb-rank">{i + 1}</td>
                <td className="lb-model">{s.name}</td>
                <td>{s.thinking || '—'}</td>
                <td className="num" style={{ fontWeight: 700 }}>{num(s.elo)}</td>
                <td className="num">{s.games}</td>
                <td className="num">{pct(s.gameWinRate)}</td>
                <td className="num">{s.matches}</td>
                <td className="num">{num(s.netAvg)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ padding: 'var(--sp-3) var(--sp-4)', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <Link className="btn small primary" to={'/arena/' + comp.slug}>完整榜单与回放</Link>
        <span className="chain">
          {comp.matches} 轮 · {comp.replays} 份回放
          {comp.lastPlayedAt ? ' · 最近 ' + String(comp.lastPlayedAt).slice(0, 10) : ''}
        </span>
        {latest && (
          <span className="chain">
            最近一轮：{latest.aName} {seriesScore(latest).a} : {seriesScore(latest).b} {latest.bName}
          </span>
        )}
        {standings.length > TOP_N && <span className="chain">共 {standings.length} 位选手</span>}
      </div>
    </section>
  )
}
