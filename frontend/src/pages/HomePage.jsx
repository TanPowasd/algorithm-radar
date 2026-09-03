import { useState } from 'react'
import { useApp } from '../state'
import Topbar from '../components/Topbar'
import Notice from '../components/Notice'
import StatsBar from '../components/StatsBar'
import ModelFilter from '../components/ModelFilter'
import ViewTabs from '../components/ViewTabs'
import MatrixView from '../views/MatrixView'
import RadarView from '../views/RadarView'
import BarView from '../views/BarView'
import TrendView from '../views/TrendView'
import LeaderboardView from '../views/LeaderboardView'
import RecordsTable from '../views/RecordsTable'
import RecordFormModal from '../components/RecordFormModal'
import ProblemDrawer from '../components/ProblemDrawer'
import PublishModal from '../components/PublishModal'
import AuthModal from '../components/AuthModal'
import ImportModal from '../components/ImportModal'
import { isPending, lastSub, providerLabel } from '../aggregate'

const TABS = [
  { key: 'matrix', label: '矩阵' },
  { key: 'radar', label: '雷达图' },
  { key: 'bar', label: '柱状图' },
  { key: 'trend', label: '趋势图' },
  { key: 'leaderboard', label: '榜单' },
]

export default function HomePage() {
  const { data, loaded, offline, isContributor, isAdmin, nicknameOf } = useApp()
  const providerCell = (r) => providerLabel(r, nicknameOf)
  const [view, setView] = useState('matrix')
  const [drawer, setDrawer] = useState(null) // {pid, model}
  const [recordModal, setRecordModal] = useState(null) // {edit, lockPid}
  const [publishOpen, setPublishOpen] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const pending = (data.records || []).filter(isPending)

  const openDetail = (pid, model) => setDrawer({ pid, model: model || null })

  const openSubmitFor = (pid) => {
    setDrawer(null)
    setRecordModal({ edit: null, lockPid: pid })
  }

  return (
    <>
      <Topbar
        onOpenAuth={() => setAuthOpen(true)}
        onOpenPublish={() => setPublishOpen(true)}
        onOpenImport={() => setImportOpen(true)}
      />
      <main className="layout">
        <Notice />
        <StatsBar />
        <ModelFilter />

        <div className="card">
          <div className="card-head" style={{ marginBottom: 0 }}>
            <ViewTabs tabs={TABS} active={view} onChange={setView} />
            <div className="card-tools">
              {isContributor && (
                <button className="btn primary" onClick={() => setRecordModal({ edit: null, lockPid: null })}>
                  + 提交测评
                </button>
              )}
            </div>
          </div>
        </div>

        {offline && loaded && (
          <div className="notice">
            <div className="n-body">⚠ 服务器暂时无法连接，以下为最近缓存的只读数据。</div>
          </div>
        )}

        {view === 'matrix' && <MatrixView onOpenDetail={openDetail} />}
        {view === 'radar' && <RadarView />}
        {view === 'bar' && <BarView />}
        {view === 'trend' && <TrendView />}
        {view === 'leaderboard' && <LeaderboardView onOpenDetail={openDetail} />}

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
                  <tr><th>模型</th><th>题目</th><th>思考</th><th>末轮</th><th>提供者</th><th>日期</th></tr>
                </thead>
                <tbody>
                  {pending.slice(0, 8).map((r) => (
                    <tr key={r.id}>
                      <td>{r.model}</td>
                      <td>{r.pid} {r.title && <span className="chain">{r.title}</span>}</td>
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
