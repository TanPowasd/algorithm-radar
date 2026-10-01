import { useCallback, useEffect, useMemo, useState } from 'react'
import Topbar from '../components/Topbar'
import AuthModal from '../components/AuthModal'
import PublishModal from '../components/PublishModal'
import ImportModal from '../components/ImportModal'
import MatrixView from '../views/MatrixView'
import RecordsTable from '../views/RecordsTable'
import ProblemDrawer from '../components/ProblemDrawer'
import RecordFormModal from '../components/RecordFormModal'
import CompetitionRankPanel from '../components/CompetitionRankPanel'
import { AppContext, useApp } from '../state'
import { api } from '../api/client'
import { toV2Dataset, V2_EMPTY } from '../v2data'
import { V2_CUTOFF_ISO } from './../score'

/**
 * k4u-V2：站点唯一的页面（旧数据页 /old 已下线并重定向到首页）。
 * - 数据存在 Cloudflare（D1，经 Worker 的 /api/data）：提交后重新打开仍然在，和原来一样；
 * - 三个页签：
 *     AI 分数 —— 全部历史记录（含 2026-09-05 21:19 之前的旧数据），格子是洛谷原始分，首行是平均分；
 *     rating  —— 只用 createdAt ≥ V2_CUTOFF_ISO 的记录，格子是加权分，首行是 Chatbot Arena 天梯分；
 *     测评明细 —— v2 时间线内的记录，可编辑 / 可开详情。
 */
export default function K4uV2Page() {
  const app = useApp()
  const [source, setSource] = useState(null) // null = 尚未加载完
  const [failed, setFailed] = useState(false)
  const [authOpen, setAuthOpen] = useState(false)
  const [publishOpen, setPublishOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [drawer, setDrawer] = useState(null)
  const [formState, setFormState] = useState(null) // { edit, lockPid }
  // 'score' = AI 分数（老版矩阵图口径：每格洛谷原始分、含之前的历史数据，首行平均分）
  // 'rating' = rating（只用 v2 时间线，每格加权分，首行 Chatbot Arena 天梯分）
  // 'table' = 测评明细
  const [view, setView] = useState('rating') // 默认打开 rating

  const load = useCallback(async () => {
    try {
      const raw = await api('/api/data')
      setSource(raw && typeof raw === 'object' ? raw : V2_EMPTY)
      setFailed(false)
    } catch {
      setSource(V2_EMPTY)
      setFailed(true)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const dataset = useMemo(() => (source ? toV2Dataset(source) : V2_EMPTY), [source])
  /** rating 页签：至少一轮能算出加权分，否则矩阵没有可显示的模型列 */
  const hasScoreable = useMemo(
    () => dataset.records.some((r) => (r.submissions || []).some((s) => typeof s.score === 'number')),
    [dataset],
  )
  /** AI 分数页签：不看时间线，直接用 D1 的原始记录（洛谷原始分，含之前的历史数据） */
  const rawRecords = useMemo(() => (source && Array.isArray(source.records) ? source.records : []), [source])
  /** AI 分数页签有没有可显示的数据：至少一轮有洛谷原始分 */
  const rawScoreable = useMemo(
    () => rawRecords.some((r) => (r.submissions || []).some((s) => typeof (s && s.score) === 'number')),
    [rawRecords],
  )
  /** 表单/顶栏/AI 分数用实时原始数据；rating / 明细 / 详情用加权 + 时间线过滤后的数据 */
  const liveApp = useMemo(() => ({ ...app, data: source || V2_EMPTY }), [app, source])
  const v2App = useMemo(() => ({ ...app, data: dataset }), [app, dataset])
  const loaded = source !== null
  const count = dataset.records.length
  const openDetail = useCallback((pid, model) => setDrawer({ pid, model: model || null }), [])

  return (
    <AppContext.Provider value={liveApp}>
      <Topbar
        onOpenAuth={() => setAuthOpen(true)}
        onOpenPublish={() => setPublishOpen(true)}
        onOpenImport={() => setImportOpen(true)}
        hud={{ samples: count, models: 0, view: 'v2' }}
      />
      <main className="layout v2-layout">
        <div className="v2-head">
          <span className="v2-badge">k4u-V2 升级版</span>
          <h2>新数据落点</h2>
          <span className="v2-sub">
            {view === 'score'
              ? '全部历史数据（含 2026-09-05 之前）· 分数为洛谷原始分'
              : '2026-09-05 21:19 之后的数据 · 分数为加权分'}
          </span>
        </div>
        <CompetitionRankPanel />

        <div className="v2-toolbar">
          <div className="v2-seg" role="tablist" aria-label="v2 视图">
            <button
              type="button" role="tab" aria-selected={view === 'score'}
              className={'btn small ' + (view === 'score' ? 'primary' : 'ghost')}
              onClick={() => setView('score')}
            >AI 分数</button>
            <button
              type="button" role="tab" aria-selected={view === 'rating'}
              className={'btn small ' + (view === 'rating' ? 'primary' : 'ghost')}
              onClick={() => setView('rating')}
            >rating</button>
            <button
              type="button" role="tab" aria-selected={view === 'table'}
              className={'btn small ' + (view === 'table' ? 'primary' : 'ghost')}
              onClick={() => setView('table')}
            >测评明细{loaded && count > 0 ? '（' + count + '）' : ''}</button>
          </div>
          {app.isContributor && (
            <button type="button" className="btn primary" onClick={() => setFormState({ edit: null, lockPid: null })}>
              + 提交测评
            </button>
          )}
          {app.isContributor && <span className="v2-hint">每轮必填：时间消耗（ms）与 内存使用量（MB），都须大于 0</span>}
        </div>

        {!loaded && (
          <section className="v2-panel" aria-live="polite">
            <p className="v2-empty-title">加载中…</p>
          </section>
        )}

        {loaded && ((view === 'score' && rawRecords.length === 0) || (view !== 'score' && count === 0)) && (
          <section className="v2-panel" aria-live="polite">
            <div className="v2-empty" role="status">
              <p className="v2-empty-title">{failed ? '数据加载失败' : '暂无数据'}</p>
              <p className="v2-empty-sub">
                {failed
                  ? '无法连接服务器，请稍后重试。'
                  : view === 'score'
                    ? '还没有任何测评记录。'
                    : '当前没有 createdAt ≥ ' + V2_CUTOFF_ISO + ' 的测评记录。'}
              </p>
            </div>
          </section>
        )}

        {loaded && view === 'rating' && count > 0 && !hasScoreable && (
          <section className="v2-panel" aria-live="polite">
            <div className="v2-empty" role="status">
              <p className="v2-empty-title">暂无可用数据</p>
              <p className="v2-empty-sub">
                {'现有 ' + count + ' 条记录都缺「每轮时间消耗(ms)／内存使用量(MB)」，算不出加权分，矩阵里没有可显示的模型。用「+ 提交测评」提交时会强制填写这两项。'}
              </p>
            </div>
          </section>
        )}

        {/* AI 分数：实时原始数据 + 洛谷原始分，首行是平均分 */}
        {loaded && view === 'score' && rawScoreable && (
          <AppContext.Provider value={liveApp}>
            <MatrixView
              onOpenDetail={openDetail}
              onQuickAdd={app.isContributor ? (pid) => setFormState({ edit: null, lockPid: pid }) : undefined}
              canSubmit={app.isContributor}
              decimal
              blankEmpty
              onlyWithScore
              rawScores
            />
          </AppContext.Provider>
        )}

        {/* rating：加权数据，首行是 Chatbot Arena 天梯分 */}
        {loaded && view === 'rating' && count > 0 && hasScoreable && (
          <AppContext.Provider value={v2App}>
            <MatrixView
              onOpenDetail={openDetail}
              onQuickAdd={app.isContributor ? (pid) => setFormState({ edit: null, lockPid: pid }) : undefined}
              canSubmit={app.isContributor}
              decimal
              blankEmpty
              onlyWithScore
              unitScore
            />
          </AppContext.Provider>
        )}

        {loaded && count > 0 && view === 'table' && (
          <AppContext.Provider value={v2App}>
            <RecordsTable
              onOpenDetail={openDetail}
              onEdit={(r) => {
                // 编辑必须拿原始记录（表单里填的是洛谷评分 + 每轮时间/内存），不能把加权分写回去
                const rawList = source && Array.isArray(source.records) ? source.records : []
                const raw = rawList.find((x) => x.id === r.id) || r
                setFormState({ edit: raw, lockPid: null })
              }}
              isAdmin={app.isAdmin}
              blankEmpty
              defaultExpanded
              decimal
            />
          </AppContext.Provider>
        )}
      </main>

      {drawer && (
        <AppContext.Provider value={v2App}>
          <ProblemDrawer pid={drawer.pid} highlightModel={drawer.model} onClose={() => setDrawer(null)} blankEmpty decimal />
        </AppContext.Provider>
      )}

      {formState && (
        <RecordFormModal
          perfFields
          editRecord={formState.edit}
          lockPid={formState.lockPid}
          onClose={() => { setFormState(null); load() }}
        />
      )}

      {authOpen && <AuthModal onClose={() => setAuthOpen(false)} />}
      {publishOpen && <PublishModal onClose={() => setPublishOpen(false)} onPublished={load} />}
      {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
    </AppContext.Provider>
  )
}
