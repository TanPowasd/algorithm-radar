import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import Topbar from '../components/Topbar'
import { useApp } from '../state'
import { api } from '../api/client'

const ROLE_LABEL = { owner: '站长', admin: '管理员', contributor: '贡献者', legacy: '历史数据' }

function fmtJoined(iso) {
  if (!iso) return '—'
  return String(iso).slice(0, 10)
}

/**
 * 贡献者名册：按注册时间排序（与贡献量无关），展示每人的贡献统计。
 * 统计口径 = 已审核记录（游客视角一致）；历史导入数据（admin/guest）排在末尾。
 */
export default function ContributorsPage() {
  const { session } = useApp()
  const [rows, setRows] = useState(null)
  const [error, setError] = useState('')

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
          <div className="stat"><div className="s-label"><span className="tone-dot tone-green" />贡献总数（已审核）</div><div className="s-value">{totalContributions}</div></div>
          <div className="stat"><div className="s-label"><span className="tone-dot tone-purple" />统计口径</div><div className="s-value" style={{ fontSize: 'var(--fs-lg)', paddingTop: 6 }}>已审核测评记录</div></div>
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
                      <td>{fmtJoined(r.joinedAt)}</td>
                    </tr>
                  ))}
                  {!ordered.length && <tr><td colSpan={9}><div className="empty">还没有贡献者</div></td></tr>}
                </tbody>
              </table>
            </div>
          )}
          <div className="lb-hint">
            名册按注册时间先后排序（历史导入数据对应的历史账号排在末尾）。贡献数 = 该账号名下已审核的测评记录数；
            待审核记录不计入。想上榜？<Link to="/register">注册成为贡献者</Link>，提交测评并通过审核即可。
          </div>
        </div>

        <footer className="foot"><Link to="/">← 返回总览</Link></footer>
      </main>
    </>
  )
}
