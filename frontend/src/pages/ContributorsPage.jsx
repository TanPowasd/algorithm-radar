import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useApp } from '../state'
import { api } from '../api/client'
import { fmtClock, fmtDateTime } from '../aggregate'

const ROLE_LABEL = { owner: '站长', admin: '管理员', contributor: '贡献者', legacy: '历史数据' }

/** 一行两排：上=日期，下=时分（全站统一时间显示口径） */
function TimeCell({ iso, fallback = '—' }) {
  if (!iso) return <span className="chain">{fallback}</span>
  const date = String(iso).slice(0, 10)
  return (
    <div className="tcell" title={fmtDateTime(iso)}>
      <span className="t-date">{date}</span>
      <span className="t-time">{fmtClock(iso) || '—:—'}</span>
    </div>
  )
}

/**
 * 贡献者名册：按注册时间排序（与贡献量无关），展示每人的贡献统计。
 * 统计口径 = 已审核记录（游客视角一致）；历史导入数据（admin/guest）排在末尾。
 */
export default function ContributorsPage() {
  const { session, focusContributor, setFocusContributor, toast } = useApp()
  const navigate = useNavigate()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')

  /** 选中某贡献者 → 全站视图与统计只看 TA 的已审核记录（回总览生效） */
  const viewAs = (r) => {
    setFocusContributor(r.uid ?? 'legacy')
    toast(`已切换为「${r.nickname || r.username}」视角`)
    navigate('/')
  }

  useEffect(() => {
    api('/api/contributors')
      .then((d) => setRows(d.contributors || []))
      .catch((e) => setError(e.message))
  }, [])

  // 服务端已按注册时间升序返回（legacy 无注册时间，天然在末尾）
  const ordered = useMemo(() => rows || [], [rows])
  const totalContributions = useMemo(() => (rows || []).reduce((a, r) => a + (r.contributions || 0), 0), [rows])

  return (
    <>
      <Topbar />
      <main className="layout">
        <div className="page-head">
          <h2>贡献者名册</h2>
          <span className="desc">按注册时间排序 · 展示每人已审核的贡献数据</span>
        </div>

        <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-accent" />贡献者人数</div><div className="s-value">{ordered.length}</div></div>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-green" />贡献总数（已收录）</div><div className="s-value">{totalContributions}</div></div>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-purple" />统计口径</div><div className="s-value" style={{ fontSize: 'var(--fs-lg)', paddingTop: 6 }}>题目与模型均已收录的记录</div></div>
        </div>

        <div className="card">
          {error && <div className="form-error">{error}</div>}
          {!error && !rows && <div className="empty">加载中…</div>}
          {rows && (
            <div className="table-scroll" id="contributors-wrap">
              <table className="data lb-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>用户 ID</th>
                    <th>昵称</th>
                    <th>身份</th>
                    <th className="num">贡献数</th>
                    <th className="num">覆盖题目</th>
                    <th className="num">测试模型数</th>
                    <th>最近贡献</th>
                    <th>注册时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {ordered.map((r, i) => (
                    <tr key={r.username} className={session.username === r.username ? 'lb-detail-row' : ''}>
                      <td className="lb-rank">{i + 1}</td>
                      <td className="lb-model">
                        {r.username}{r.uid ? <span className="chain"> #{r.uid}</span> : null}
                        {session.username === r.username && <span className="chain">（我）</span>}
                      </td>
                      <td>{r.nickname || <span className="chain">—</span>}</td>
                      <td><span className={`status-tag role-${r.role}`}>{ROLE_LABEL[r.role] || r.role}</span></td>
                      <td className="num" style={{ fontWeight: 700 }}>{r.contributions}</td>
                      <td className="num">{r.problems}</td>
                      <td className="num">{r.models}</td>
                      <td>{r.lastDate || '—'}</td>
                      <td><TimeCell iso={r.joinedAt} /></td>
                      <td className="actions">
                        {(() => {
                          const active = focusContributor !== null && (focusContributor === 'legacy' ? !r.uid : focusContributor === r.uid)
                          return active
                            ? <button className="btn small ghost" onClick={() => setFocusContributor(null)}>退出视角</button>
                            : <button className="btn small" onClick={() => viewAs(r)} title="回总览，全站只看 TA 的已审核记录">全站查看</button>
                        })()}
                      </td>
                    </tr>
                  ))}
                  {!ordered.length && <tr><td colSpan={10}><div className="empty">还没有贡献者</div></td></tr>}
                </tbody>
              </table>
            </div>
          )}
          <div className="lb-hint">
            名册按注册时间先后排序（历史导入数据对应的历史账号排在末尾）。贡献数 = 该账号名下已审核的测评记录数；
            待审核记录不计入。点「全站查看」可切换到该贡献者的视角（总览页顶部可退出）。
            想上榜？<Link to="/register">注册成为贡献者</Link>，进审核 QQ 群（<strong>1107535292</strong>）加速审核，提交测评并通过审核即可。
          </div>
        </div>

        <footer className="foot"><Link to="/">← 返回总览</Link></footer>
      </main>
    </>
  )
}
