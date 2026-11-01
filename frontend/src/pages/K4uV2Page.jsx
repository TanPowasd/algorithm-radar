import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, SlidersHorizontal, ChevronDown } from 'lucide-react'
import { Navigate } from 'react-router-dom'
import Topbar from '../components/Topbar'
import MatrixView from '../views/MatrixView'
import StatsBar from '../components/StatsBar'
import { AppContext, useApp } from '../state'
import { toV2Dataset } from '../v2data'
import { useUrlState } from '../hooks/useUrlState'
import { useHotkeys } from '../hooks/useHotkeys'
import { DEFAULT_UI_PREFERENCES, scoreDigits } from '../uiPreferences'
import PageHeading from '../components/PageHeading'
import MotionRegion from '../components/MotionRegion'

const RecordsTable = lazy(() => import('../views/RecordsTable'))
const loadModelFilter = () => import('../components/ModelFilter')
const loadContributorFilter = () => import('../components/ContributorFilter')
const ModelFilter = lazy(loadModelFilter)
const ContributorFilter = lazy(loadContributorFilter)
const ProblemDrawer = lazy(() => import('../components/ProblemDrawer'))
const RecordFormModal = lazy(() => import('../components/RecordFormModal'))
const PublishModal = lazy(() => import('../components/PublishModal'))
const ImportModal = lazy(() => import('../components/ImportModal'))
const TABS = [{ key: 'score', label: 'AI 分数' }, { key: 'rating', label: '天梯分' },
  { key: 'table', label: '测评明细' }]

export default function K4uV2Page() {
  const app = useApp()
  const url = useUrlState()
  const prefs = app.uiPreferences || DEFAULT_UI_PREFERENCES
  const features = prefs.features
  const visibleTabs = TABS.filter((tab) => tab.key !== 'table' || features.records)
  const requested = url.get('v', 'rating')
  const view = visibleTabs.some((tab) => tab.key === requested) ? requested : 'rating'
  const setUrlView = url.set
  useEffect(() => {if (TABS.some((tab) => tab.key === requested) && requested !== view) setUrlView('v', view)}, [requested, view, setUrlView])
  const source = app.data
  const dataset = useMemo(() => toV2Dataset(source), [source])
  const encodedModels = url.get('models', '')
  const encodedContributor = url.get('contributor', '')
  const focusModels = useMemo(() => {
    if (!encodedModels) return app.focusModels
    try {
      const names = JSON.parse(encodedModels)
      return Array.isArray(names) ? new Set(names.filter((name) => typeof name === 'string')) : app.focusModels
    } catch { return app.focusModels }
  }, [encodedModels, app.focusModels])
  const focusContributor = encodedContributor === 'all' ? null : encodedContributor === 'legacy' ? 'legacy'
    : encodedContributor && /^\d+$/.test(encodedContributor) ? Number(encodedContributor) : app.focusContributor
  const [filtersOpen, setFiltersOpen] = useState(() => {
    try {return localStorage.getItem('radar.analysisFiltersExpanded') === 'true'} catch {return false}
  })
  useEffect(() => {
    const patch = {}
    if (!encodedModels && app.focusModels.size) patch.models = JSON.stringify([...app.focusModels])
    if (!encodedContributor && app.focusContributor != null) patch.contributor = app.focusContributor
    if (Object.keys(patch).length) url.setMany(patch)
    if (encodedModels && JSON.stringify([...focusModels].sort()) !== JSON.stringify([...app.focusModels].sort())) app.focusOnly([...focusModels])
    if (encodedContributor && focusContributor !== app.focusContributor) app.setFocusContributor(focusContributor)
  }, [encodedModels, encodedContributor, focusModels, focusContributor, app.focusModels, app.focusContributor, app.focusOnly, app.setFocusContributor, url])
  const activeApp = useMemo(() => ({ ...app, data: view === 'score' ? source : dataset, focusModels, focusContributor,
    focusOnly: (names) => { app.focusOnly(names); url.set('models', JSON.stringify(names)) },
    toggleFocusModel: (name) => {
      const next = new Set(focusModels)
      if (next.has(name)) next.delete(name); else next.add(name)
      app.focusOnly([...next]); url.set('models', JSON.stringify([...next]))
    },
    setFocusContributor: (value) => { app.setFocusContributor(value); url.set('contributor', value == null ? 'all' : value) },
  }), [app, view, source, dataset, focusModels, focusContributor, url])
  const [publishOpen, setPublishOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [drawer, setDrawer] = useState(null)
  const [formState, setFormState] = useState(null)
  const setView = useCallback((nextView) => {
    if (nextView === 'table' && !features.records) return
    url.set('v', nextView, { replace: false })
  }, [url, features.records])
  const openDetail = useCallback((pid, model) => setDrawer({ pid, model, raw: view === 'score' }), [view])
  const openForm = (pid = null) => { setDrawer(null); setFormState({ edit: null, lockPid: pid }) }
  const editRecord = (record) => {
    setDrawer(null)
    setFormState({ edit: (source.records || []).find((r) => r.id === record.id) || record, lockPid: null })
  }
  useHotkeys({ 1: () => setView('score'), 2: () => setView('rating'), 3: () => setView('table'),
    t: app.toggleTheme, r: app.retryNow,
    w: () => app.setWidthMode(app.widthMode === 'full' ? 'narrow' : 'full') }, [setView, app])

  const filters = <details className="benchmark-filters" open={filtersOpen} onToggle={(event) => {
    const open = event.currentTarget.open
    setFiltersOpen(open)
    try {localStorage.setItem('radar.analysisFiltersExpanded', String(open))} catch { /* Optional UI storage. */ }
  }}>
    <summary onPointerEnter={() => {loadModelFilter().catch(() => {}); loadContributorFilter().catch(() => {})}}
      onFocus={() => {loadModelFilter().catch(() => {}); loadContributorFilter().catch(() => {})}}>
      <SlidersHorizontal size={16} aria-hidden="true" />筛选<ChevronDown size={14} className="filter-chevron" aria-hidden="true" />
      {(focusModels.size > 0 || focusContributor != null) && <span>{focusModels.size ? `已选 ${focusModels.size} 个模型` : '全部模型'} · {focusContributor == null ? '全部贡献者' : '已选择贡献者'}</span>}
    </summary>
    {filtersOpen && <Suspense fallback={<div className="hint">加载筛选…</div>}><div className="analysis-filters"><ModelFilter /><ContributorFilter /></div></Suspense>}
  </details>

  // Preserve links to the former embedded competition view without a duplicate tab.
  if (requested === 'arena' && features.competitions) {
    const competition = url.get('competition', '')
    return <Navigate to={competition ? '/arena/' + encodeURIComponent(competition) : '/arena'} replace />
  }

  return (
    <>
      <a className="skip-link" href="#benchmark-panel">跳到评测内容</a>
      <Topbar onOpenPublish={() => setPublishOpen(true)} onOpenImport={() => setImportOpen(true)}
        hud={{ samples: dataset.records.length, models: app.models.length, view }} />
      <main className="layout benchmark-layout">
        <PageHeading title="模型解题评测" description="从真实作答记录出发，比较模型的分数与解题能力。" eyebrow="ALGORITHM RADAR / BENCHMARK">
            <button className="icon-btn" onClick={app.retryNow} title="刷新数据" aria-label="刷新数据"><RefreshCw size={18} /></button>
            {app.isContributor && <button className="btn primary" onClick={() => openForm()}><Plus size={16} />提交测评</button>}
        </PageHeading>
        <div className="analysis-nav benchmark-tabs">
          <div className="view-tabs" role="tablist" aria-label="评测视图">
            {visibleTabs.map((tab) => <button key={tab.key} id={'benchmark-tab-' + tab.key} role="tab"
              aria-selected={view === tab.key} aria-controls="benchmark-panel" tabIndex={view === tab.key ? 0 : -1}
              className={view === tab.key ? 'active' : ''} onClick={() => setView(tab.key)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const index = visibleTabs.findIndex((item) => item.key === view)
                const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length
                setView(visibleTabs[nextIndex].key)
                document.getElementById('benchmark-tab-' + visibleTabs[nextIndex].key)?.focus()
              }}>{tab.label}</button>)}
          </div>
        </div>
        {app.offline && <div className="notice offline-notice" role="alert"><span>连接暂时不可用，正在显示缓存数据。</span><button className="btn small" onClick={app.retryNow}>重试</button></div>}
        <AppContext.Provider value={activeApp}>
          {features.stats && <StatsBar />}
          {view === 'table' && filters}
          <MotionRegion as="section" motionKey={view} id="benchmark-panel" role="tabpanel" aria-labelledby={'benchmark-tab-' + view} tabIndex={0}>
            {!app.loaded && !(source.records || []).length
              ? <div className="empty" role="status">加载评测数据...</div>
              : <Suspense fallback={<div className="empty" role="status">加载中...</div>}>
                {(view === 'score' || view === 'rating') && <MatrixView key={view}
                  onOpenDetail={openDetail} onQuickAdd={app.isContributor ? openForm : undefined}
                  canSubmit={app.isContributor} decimal={scoreDigits(prefs, view === 'score' ? 2 : 5)} blankEmpty onlyWithScore
                  unitScore={view === 'rating'} rawScores={view === 'score'} compactHeader toolbarExtra={filters} />}
                {view === 'table' && <RecordsTable onOpenDetail={openDetail} onEdit={editRecord}
                  isAdmin={app.isAdmin} blankEmpty defaultExpanded decimal={scoreDigits(prefs, 5)} />}
              </Suspense>}
          </MotionRegion>
        </AppContext.Provider>
        <footer className="foot">算法雷达 · AI vs 洛谷</footer>
      </main>
      <Suspense fallback={null}>
        {drawer && <AppContext.Provider value={{ ...app, data: drawer.raw ? source : dataset }}>
          <ProblemDrawer pid={drawer.pid} highlightModel={drawer.model} onClose={() => setDrawer(null)}
            onSubmitClick={app.isContributor ? () => openForm(drawer.pid) : undefined}
            onEditRecord={editRecord} blankEmpty decimal={scoreDigits(prefs, drawer.raw ? 2 : 5)} />
        </AppContext.Provider>}
        {formState && <RecordFormModal perfFields editRecord={formState.edit} lockPid={formState.lockPid} onClose={() => setFormState(null)} />}
        {publishOpen && <PublishModal onClose={() => setPublishOpen(false)} />}
        {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      </Suspense>
    </>
  )
}
