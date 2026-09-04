import { useCallback, useEffect, useMemo, useRef, useState, Fragment } from 'react'
import { useApp } from '../state'
import {
  filterByModels, isApproved, seriesColorMap, THINKING_LABELS,
} from '../aggregate'
import { cursorLabel, nextAcIndex, nextDayIndex, rollEvents, rollSnapshot } from '../rollboard'
import PidLink from '../components/PidLink'
import { hexRgba, levelSwatchStyle } from '../palette'
import { useHotkeys } from '../hooks/useHotkeys'

const SPEEDS = [1, 2, 4, 8, 16]
const ROW_H = 34 // 侧栏名次行动画用

/**
 * ACM 滚榜：团队 = 模型，队员 = 思考等级。
 * 时间轴 = 记录录入时间，逐条把「上机结果」刷进榜单；左侧题目网格 + 右侧实时名次，
 * 名次行用 transform 位移做滚榜动画。
 */
export default function RollBoardView({ onOpenDetail }) {
  const { data, focusModels, vendorOf, theme } = useApp()
  const approved = useMemo(() => filterByModels(
    (data.records || []).filter(isApproved), focusModels), [data.records, focusModels])
  const events = useMemo(() => rollEvents(approved), [approved])
  const colorMap = useMemo(
    () => seriesColorMap(approved, { vendorOf, dark: theme !== 'light' }),
    [approved, vendorOf, theme])

  const total = events.length
  const [k, setK] = useState(total)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(4)
  const [openTeam, setOpenTeam] = useState(null)
  const prevSolved = useRef(new Map())
  const [flash, setFlash] = useState(() => new Set())
  const boardRef = useRef(null)

  // 数据刷新后收敛游标
  useEffect(() => {
    setK((v) => Math.min(v === total ? total : v, total))
  }, [total])

  const snap = useMemo(() => rollSnapshot(events, k), [events, k])

  // 名次行动画：只在解题数变化时闪烁
  useEffect(() => {
    const next = new Set()
    for (const t of snap.teams) {
      const before = prevSolved.current.get(t.model)
      if (before !== undefined && t.solved > before) next.add(t.model)
      prevSolved.current.set(t.model, t.solved)
    }
    for (const model of [...prevSolved.current.keys()]) {
      if (!snap.teams.some((t) => t.model === model)) prevSolved.current.delete(model)
    }
    if (next.size) {
      setFlash(next)
      const id = setTimeout(() => setFlash(new Set()), 1200)
      return () => clearTimeout(id)
    }
    return undefined
  }, [snap])

  useEffect(() => {
    if (!playing) return undefined
    if (k >= total) { setPlaying(false); return undefined }
    const stepN = speed <= 2 ? 1 : speed <= 4 ? 2 : speed <= 8 ? 4 : 8
    const id = setTimeout(() => setK((v) => Math.min(total, v + stepN)), 520 / Math.max(1, speed / 2))
    return () => clearTimeout(id)
  }, [playing, k, speed, total])

  const jumpAc = useCallback(() => setK((v) => nextAcIndex(events, v)), [events])
  const jumpDay = useCallback(() => setK((v) => nextDayIndex(events, v)), [events])
  const restart = useCallback(() => { setK(0); setPlaying(true) }, [])

  useHotkeys({
    ' ': () => { if (total) setPlaying((p) => !p) },
    ArrowRight: () => setK((v) => Math.min(total, v + 1)),
    ArrowLeft: () => setK((v) => Math.max(0, v - 1)),
    j: jumpAc,
    d: jumpDay,
  }, [total, jumpAc, jumpDay])

  const maxAttempts = useMemo(() => {
    let m = 1
    for (const t of snap.teams) for (const c of t.cells.values()) m = Math.max(m, c.attempts)
    return m
  }, [snap])

  if (!total) {
    return (
      <div className="card" id="roll-card">
        <div className="card-head"><h2>滚榜 · ACM Board</h2></div>
        <div className="empty">当前口径下没有可回放的已审核记录</div>
      </div>
    )
  }

  return (
    <div className="card" id="roll-card">
      <div className="card-head">
        <h2>滚榜 · ACM Board</h2>
        <span className="hint">团队 = 模型 · 队员 = 思考等级 · 时间轴 = 记录录入时间</span>
        <div className="card-tools">
          <span className="hint">{k} / {total} 笔已揭晓</span>
        </div>
      </div>

      <div className="roll-controls">
        <button className="btn small" onClick={restart} title="从 0 开始回放">⏮ 重播</button>
        <button className="btn small" disabled={k === 0} onClick={() => setK((v) => Math.max(0, v - 1))} title="上一笔（←）">◀</button>
        <button className="btn small primary" onClick={() => setPlaying((p) => !p)} title="播放/暂停（空格）">
          {playing ? '❚❚ 暂停' : '▶ 播放'}
        </button>
        <button className="btn small" disabled={k >= total} onClick={() => setK((v) => Math.min(total, v + 1))} title="下一笔（→）">▶</button>
        <button className="btn small ghost" onClick={() => setK(total)} title="直接跳到终盘">⏭ 终盘</button>
        <button className="btn small ghost" onClick={jumpAc} title="跳到下一次解题（J）">⚑ 下一个 AC</button>
        <button className="btn small ghost" onClick={jumpDay} title="按测评日期批量推进（D）">📅 推进一天</button>
        <div className="seg" role="group" aria-label="倍速">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'active' : ''} onClick={() => setSpeed(s)}>{s}×</button>
          ))}
        </div>
        <span className="roll-clock">{cursorLabel(events, k)}</span>
        <div className="roll-scrub">
          <input
            type="range" min="0" max={total} step="1" value={k}
            style={{ '--fill': `${Math.round((k / total) * 100)}%` }}
            onChange={(e) => { setPlaying(false); setK(Number(e.target.value)) }}
            aria-label="回放进度"
          />
        </div>
      </div>

      <div className="roll-body">
        <div>
          <div className="roll-board" ref={boardRef}>
            <table className="roll">
              <thead>
                <tr>
                  <th className="rc-team"># / 团队</th>
                  {snap.pids.map((pid) => {
                    const solvedBy = snap.teams.filter((t) => t.cells.get(pid)?.passed).length
                    return (
                      <th key={pid} className={`rc-pid ${solvedBy ? 'solved' : ''}`}>
                        <PidLink
                          pid={pid}
                          label={pid.replace(/^(P|B|CF|U|AT)/, '')}
                          icon={false}
                          title={`${pid} · ${solvedBy} 队解出 · 点击在洛谷打开`}
                        />
                      </th>
                    )
                  })}
                  <th className="rc-pid" title="解题数">解</th>
                  <th className="rc-pid" title="各题最好成绩之和">分</th>
                  <th className="rc-pid" title="有成绩题目的均分">均</th>
                </tr>
              </thead>
              <tbody>
                {snap.teams.map((t) => {
                  const color = colorMap.get(t.model) || 'var(--accent)'
                  return (
                    <Fragment key={t.model}>
                      <tr className={`rc-row ${flash.has(t.model) ? 'flash' : ''}`}>
                        <th className="rc-team">
                          <div className="team-line">
                            <span className="vendor-dot" style={{ background: color }} />
                            <span className="mrank">{t.rank}</span>
                            <span className="tname" title={`${t.model} · 厂商 ${vendorOf(t.model)}`}>{t.model}</span>
                            <button
                              className="lb-detail-btn"
                              onClick={() => setOpenTeam(openTeam === t.model ? null : t.model)}
                            >{openTeam === t.model ? '收起' : `${t.members.length} 队员`}</button>
                          </div>
                          <div className="rc-metrics">
                            <span>{vendorOf(t.model)}</span>
                            <span>笔数 <b>{t.events}</b></span>
                            <span>题目 <b>{t.attempted}</b></span>
                          </div>
                        </th>
                        {snap.pids.map((pid) => {
                          const cell = t.cells.get(pid)
                          if (!cell) return <td key={pid} className="rc-cell" />
                          const members = [...cell.members.values()].sort((a, b) => (b.best ?? -1) - (a.best ?? -1))
                          return (
                            <td
                              key={pid}
                              className={`rc-cell ${cell.passed ? 'solved' : 'tried'}`}
                              title={[
                                `${t.model} · ${pid}`,
                                `${cell.passed ? '已解出' : '未解出'} · 共 ${cell.attempts} 人次尝试`,
                                `最好成绩 ${cell.best ?? '—'}（队员 ${THINKING_LABELS[cell.bestMember] || cell.bestMember || '—'}）`,
                                ...members.map((m) => `  · ${THINKING_LABELS[m.thinking] || m.thinking}：${m.attempts} 次 / AC ${m.ac} 次 / 最佳 ${m.best ?? '—'}`),
                                '点击查看题目详情',
                              ].join('\n')}
                              onClick={() => onOpenDetail && onOpenDetail(pid, t.model)}
                            >
                              <div>{cell.best ?? (cell.passed ? 'AC' : '·')}</div>
                              <div className="members">
                                {members.slice(0, maxAttempts > 4 ? 4 : 5).map((m) => (
                                  <span
                                    key={m.thinking}
                                    className="mb"
                                    style={{
                                      ...levelSwatchStyle(color, m.thinking),
                                      outline: cell.bestMember === m.thinking ? `1px solid ${hexRgba(color, 1)}` : 'none',
                                    }}
                                    title={`${THINKING_LABELS[m.thinking] || m.thinking}：${m.attempts} 次 / 最佳 ${m.best ?? '—'}`}
                                  />
                                ))}
                              </div>
                            </td>
                          )
                        })}
                        <td className="rc-cell solved" title="解题数">{t.solved}</td>
                        <td className="rc-cell" title="各题最好成绩之和">{Math.round(t.scoreSum)}</td>
                        <td className="rc-cell" title="有成绩题目均分">{t.avgBest === null ? '—' : Math.round(t.avgBest)}</td>
                      </tr>
                      {openTeam === t.model && (
                        <tr className="rc-members" key={`${t.model}-m`}>
                          <td colSpan={snap.pids.length + 4}>
                            <div className="rc-member-list">
                              {t.members.map((m) => (
                                <span className="rc-member" key={m.thinking}>
                                  <span className="sw" style={levelSwatchStyle(color, m.thinking)} />
                                  <b>{THINKING_LABELS[m.thinking] || m.thinking}</b>
                                  <span className="chain">上机 {m.attempts} 次</span>
                                  <span className="chain">AC {m.acEvents} 次</span>
                                  <span className="chain">拿下 {m.solved} 题</span>
                                  <span className="chain">最佳 {m.best ?? '—'}</span>
                                  <span className="chain">均分 {m.avg === null ? '—' : m.avg.toFixed(1)}</span>
                                </span>
                              ))}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
                {!snap.teams.length && (
                  <tr><td className="roll-empty" colSpan={snap.pids.length + 4}>还没揭晓任何一笔作答</td></tr>
                )}
              </tbody>
            </table>
          </div>
          <div className="lb-hint">
            格子 = 该团队在该题的<b>最好成绩</b>（绿=已解出，红=尝试未过），格下色条是各<b>队员（思考等级）</b>的参与情况，
            带描边的是拿下该题的最佳队员。列按「首次被解出」的时间先后生长，点列头悬停可看题号，点格子看题目详情。
            排名口径：解题数 → 各题最好成绩均值 → 达成时间。
          </div>
        </div>

        <aside className="roll-side">
          <div className="card-head" style={{ marginBottom: 4 }}>
            <h2>实时名次</h2>
            <span className="hint">{snap.solvedTotal} 次解题</span>
          </div>
          <div className="roll-rank-list" style={{ position: 'relative', height: Math.max(1, snap.teams.length) * ROW_H }}>
            {snap.teams.map((t) => (
              <div
                key={t.model}
                className={`roll-rank ${t.rank <= 3 ? `r${t.rank}` : ''} ${flash.has(t.model) ? 'up' : ''}`}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${(t.rank - 1) * ROW_H}px)`, height: ROW_H - 4 }}
              >
                <span className="rk">{t.rank}</span>
                <span className="nm" title={t.model}>
                  <span className="vendor-dot" style={{ background: colorMap.get(t.model) || 'var(--accent)', display: 'inline-block', width: 8, height: 8, borderRadius: 2, marginRight: 6 }} />
                  {t.model}
                </span>
                <span className="sc">解 {t.solved} · 均 {t.avgBest === null ? '—' : Math.round(t.avgBest)}</span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </div>
  )
}
