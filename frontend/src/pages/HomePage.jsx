import { useCallback, useMemo, useState } from 'react'
import { useApp } from '../state'
import Topbar from '../components/Topbar'
import Notice from '../components/Notice'
import StatsBar from '../components/StatsBar'
import ModelFilter from '../components/ModelFilter'
import ViewTabs from '../components/ViewTabs'
import MatrixView from '../views/MatrixView'
import RadarView from '../views/RadarView'
import BarView from '../views/BarView'
import LeaderboardView from '../views/LeaderboardView'
import RollBoardView from '../views/RollBoardView'
import RecordsTable from '../views/RecordsTable'
import RecordFormModal from '../components/RecordFormModal'
import ProblemDrawer from '../components/ProblemDrawer'
import PublishModal from '../components/PublishModal'
import AuthModal from '../components/AuthModal'
import ImportModal from '../components/ImportModal'
import PidLink from '../components/PidLink'
import { isApproved, isPending, lastSub, providerLabel, seriesList, filterByModels } from '../aggregate'
import { useUrlState } from '../hooks/useUrlState'
import { useHotkeys } from '../hooks/useHotkeys'

const TABS = [
  { key: 'matrix', label: '矩阵' },
  { key: 'radar', label: '雷达图' },
  { key: 'bar', label: '柱状图' },
  { key: 'leaderboard', label: '榜单' },
  { key: 'roll', label: '滚榜' },
]

export default function HomePage() {
  const { data, loaded, offline, isContributor, isAdmin, nicknameOf, toggleTheme, widthMode, setWidthMode, refreshData, retryNow } = useApp()
  const providerCell = (r) => providerLabel(r, nicknameOf)
  const url = useUrlState()
  const [view, setViewRaw] = useState(() => {
    const v = url.get('v', 'matrix')
    return TABS.some((t) => t.key === v) ? v : 'matrix'
  })
  const [drawer, setDrawer] = useState(null) // {pid, model}
  const [recordModal, setRecordModal] = useState(null) // {edit, lockPid}
  const [publishOpen, setPublishOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const setView = useCallback((v) => {
    setViewRaw(v)
    url.set('v', v)
  }, [url])

  const pending = (data.records || []).filter(isPending)
  const hud = useMemo(() => {
    const approved = filterByModels((data.records || []).filter(isApproved))
    return { samples: approved.length, models: seriesList(approved).length, view }
  }, [data.records, view])

  const openDetail = (pid, model) => setDrawer({ pid, model: model || null })

  const openSubmitFor = (pid) => {
    setDrawer(null)
    setRecordModal({ edit: null, lockPid: pid })
  }

  const focusSearch = () => {
    const el = document.getElementById('f-keyword')
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus(); el.select?.() }
  }

  useHotkeys({
    1: () => setView('matrix'),
    2: () => setView('radar'),
    3: () => setView('bar'),
    4: () => setView('leaderboard'),
    5: () => setView('roll'),
    t: toggleTheme,
    w: () => setWidthMode(widthMode === 'full' ? 'narrow' : 'full'),
    f: focusSearch,
    r: () => { refreshData() },
    Escape: () => { setDrawer(null) },
  }, [setView, toggleTheme, widthMode, setWidthMode, refreshData])

  return (
    <>
      <Topbar
        onOpenAuth={() => setAuthOpen(true)}
        onOpenPublish={() => setPublishOpen(true)}
        onOpenImport={() => setImportOpen(true)}
        hud={hud}
      />
      <main className="layout">
        <Notice />
        <StatsBar />
        <ModelFilter />

        <div className="card">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <ViewTabs tabs={TABS} active={view} onChange={setView} />
            <div className="card-tools">
              <span className="hint">按 1–5 切视图 · ? 看快捷键</span>
              {isContributor && (
                <button className="btn primary" onClick={() => setRecordModal({ edit: null, lockPid: null })}>
                  + 提交测评
                </button>
              )}
            </div>
          </div>
        </div>

        {offline && loaded && (
          <div className="notice" role="alert">
            <div className="n-body">⚠ 服务器暂时无法连接，以下为最近缓存的只读数据。将每 18 秒自动重试连接。</div>
            <div className="n-actions">
              <button className="btn small primary" onClick={() => retryNow()}>立即重试</button>
            </div>
          </div>
        )}

        {view === 'matrix' && (
          <MatrixView
            onOpenDetail={openDetail}
            onQuickAdd={isContributor ? openSubmitFor : undefined}
            canSubmit={isContributor}
          />
        )}
        {view === 'radar' && <RadarView />}
        {view === 'bar' && <BarView />}
        {view === 'leaderboard' && <LeaderboardView onOpenDetail={openDetail} />}
        {view === 'roll' && <RollBoardView onOpenDetail={openDetail} />}

        <RecordsTable
          onOpenDetail={openDetail}
          onEdit={(r) => setRecordModal({ edit: r, lockPid: null })}
          isAdmin={isAdmin}
        />

        {isAdmin && pending.length > 0 && (
          <div className="card" id="pending-card">
            <div className="card-head">
              <h2>待审核预览</h2>
              <span className="hint" id="pending-count">{pending.length} 条待审</span>
              <div className="card-tools">
                <a className="btn small" href="/admin">去审核台处理 →</a>
              </div>
            </div>
            <div className="table-scroll" id="pending-wrap">
              <table className="data review-table">
                <thead>
                  <tr><th>模型</th><th>题目</th><th>思考</th><th>末轮</th><th>提供者</th><th>时间</th></tr>
                </thead>
                <tbody>
                  {pending.slice(0, 8).map((r) => (
                    <tr key={r.id}>
                      <td>{r.model}</td>
                      <td><PidLink pid={r.pid} /> {r.title && <span className="chain">{r.title}</span>}</td>
                      <td>{r.thinking}</td>
                      <td>{lastSub(r)?.result ?? '—'}</td>
                      <td>{providerCell(r)}</td>
                      <td>{r.date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!isAdmin && pending.length > 0 && (
          <div className="card" id="my-pending-card">
            <div className="card-head">
              <h2>我提交的待审核记录</h2>
              <span className="hint">{pending.length} 条等待审核</span>
              <span className="chain">修改后将重新进入待审，需管理员审核通过后计入统计</span>
            </div>
            <div className="table-scroll">
              <table className="data review-table">
                <thead>
                  <tr><th>模型</th><th>题目</th><th>思考</th><th>末轮</th><th>提交日期</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {pending.map((r) => (
                    <tr key={r.id}>
                      <td>{r.model}</td>
                      <td><PidLink pid={r.pid} /> {r.title && <span className="chain">{r.title}</span>}</td>
                      <td>{r.thinking}</td>
                      <td>{lastSub(r)?.result ?? '—'}</td>
                      <td>{r.date}</td>
                      <td className="actions">
                        <button
                          className="btn small ghost"
                          onClick={() => setRecordModal({ edit: r, lockPid: null })}
                        >
                          修改
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <footer className="foot">
          AI vs 洛谷 · 数据仅供参考 · 游客可自由浏览与下载数据
          {' '}·{' '}
          <a href="/api/export/public?format=json">公开数据（JSON）</a>
        </footer>
      </main>

      {drawer && (
        <ProblemDrawer
          pid={drawer.pid}
          highlightModel={drawer.model}
          onClose={() => setDrawer(null)}
          onSubmitClick={isContributor ? () => openSubmitFor(drawer.pid) : undefined}
          onEditRecord={(r) => {
            setDrawer(null)
            setRecordModal({ edit: r, lockPid: null })
          }}
        />
      )}
      {recordModal && (
        <RecordFormModal
          editRecord={recordModal.edit}
          lockPid={recordModal.lockPid}
          onClose={() => setRecordModal(null)}
        />
      )}
      {publishOpen && <PublishModal onClose={() => setPublishOpen(false)} />}
      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
    </>
  )
}
