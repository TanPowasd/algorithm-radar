import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Plus, RefreshCw, ArrowUpRight } from 'lucide-react'
import Topbar from '../components/Topbar'
import MatrixView from '../views/MatrixView'
import ModelFilter from '../components/ModelFilter'
import ContributorFilter from '../components/ContributorFilter'
import StatsBar from '../components/StatsBar'
import { AppContext, useApp } from '../state'
import { toV2Dataset } from '../v2data'
import { useUrlState } from '../hooks/useUrlState'
import { useHotkeys } from '../hooks/useHotkeys'

const RecordsTable = lazy(() => import('../views/RecordsTable'))
const ProblemDrawer = lazy(() => import('../components/ProblemDrawer'))
const RecordFormModal = lazy(() => import('../components/RecordFormModal'))
const PublishModal = lazy(() => import('../components/PublishModal'))
const ImportModal = lazy(() => import('../components/ImportModal'))
const ArenaView = lazy(() => import('../views/ArenaView'))
const TABS = [{ key: 'score', label: 'AI 分数' }, { key: 'rating', label: 'rating' },
  { key: 'table', label: '测评明细' }, { key: 'arena', label: '比赛' }]

export default function K4uV2Page() {
  const app = useApp()
  const url = useUrlState()
  const requested = url.get('v', 'rating')
  const view = TABS.some((tab) => tab.key === requested) ? requested : 'rating'
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
  const setView = useCallback((nextView) => url.set('v', nextView, { replace: false }), [url])
  const openDetail = useCallback((pid, model) => setDrawer({ pid, model, raw: view === 'score' }), [view])
  const openForm = (pid = null) => { setDrawer(null); setFormState({ edit: null, lockPid: pid }) }
  const editRecord = (record) => {
    setDrawer(null)
    setFormState({ edit: (source.records || []).find((r) => r.id === record.id) || record, lockPid: null })
  }
  useHotkeys({ 1: () => setView('score'), 2: () => setView('rating'), 3: () => setView('table'),
    4: () => setView('arena'), t: app.toggleTheme, r: app.retryNow,
    w: () => app.setWidthMode(app.widthMode === 'full' ? 'narrow' : 'full') }, [setView, app])

  return (
    <>
      <a className="skip-link" href="#benchmark-panel">跳到评测内容</a>
      <Topbar onOpenPublish={() => setPublishOpen(true)} onOpenImport={() => setImportOpen(true)}
        hud={{ samples: dataset.records.length, models: app.models.length, view }} />
      <main className="layout benchmark-layout">
        <div className="workbench-heading">
          <div><span className="eyebrow">K4U / BENCHMARK</span><h2>{view === 'arena' ? '模型对抗赛' : '模型解题评测'}</h2></div>
          <div className="heading-actions">
            <button className="icon-btn" onClick={app.retryNow} title="刷新数据" aria-label="刷新数据"><RefreshCw size={18} /></button>
            {app.isContributor && view !== 'arena' && <button className="btn primary" onClick={() => openForm()}><Plus size={16} />提交测评</button>}
          </div>
        </div>
        <div className="analysis-nav benchmark-tabs">
          <div className="view-tabs" role="tablist" aria-label="评测视图">
            {TABS.map((tab) => <button key={tab.key} id={'benchmark-tab-' + tab.key} role="tab"
              aria-selected={view === tab.key} aria-controls="benchmark-panel" tabIndex={view === tab.key ? 0 : -1}
              className={view === tab.key ? 'active' : ''} onClick={() => setView(tab.key)}
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
                event.preventDefault()
                const index = TABS.findIndex((item) => item.key === view)
                const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1
                  : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length
                setView(TABS[nextIndex].key)
                document.getElementById('benchmark-tab-' + TABS[nextIndex].key)?.focus()
              }}>{tab.label}</button>)}
          </div>
          {view === 'arena' && <a className="btn small ghost" href="/arena">比赛目录<ArrowUpRight size={15} /></a>}
        </div>
        {app.offline && <div className="notice offline-notice" role="alert"><span>连接暂时不可用，正在显示缓存数据。</span><button className="btn small" onClick={app.retryNow}>重试</button></div>}
        <AppContext.Provider value={activeApp}>
          {view !== 'arena' && <><StatsBar /><div className="analysis-filters"><ModelFilter /><ContributorFilter /></div></>}
          <section id="benchmark-panel" role="tabpanel" aria-labelledby={'benchmark-tab-' + view}>
            {!app.loaded && !(source.records || []).length && view !== 'arena'
              ? <div className="empty" role="status">加载评测数据...</div>
              : <Suspense fallback={<div className="empty" role="status">加载中...</div>}>
                {(view === 'score' || view === 'rating') && <MatrixView key={view}
                  onOpenDetail={openDetail} onQuickAdd={app.isContributor ? openForm : undefined}
                  canSubmit={app.isContributor} decimal={view === 'score' ? 2 : 5} blankEmpty onlyWithScore
                  unitScore={view === 'rating'} rawScores={view === 'score'} />}
                {view === 'table' && <RecordsTable onOpenDetail={openDetail} onEdit={editRecord}
                  isAdmin={app.isAdmin} blankEmpty defaultExpanded decimal />}
                {view === 'arena' && <ArenaView slug={url.get('competition', 'kaggriculture')}
                  onSelect={(slug) => url.set('competition', slug)} showAdmin={false} />}
              </Suspense>}
          </section>
        </AppContext.Provider>
        <footer className="foot">AI vs 洛谷 · <a href="/api/export/public?format=json">公开数据 JSON</a> · <a href="/contributors">贡献者</a></footer>
      </main>
      <Suspense fallback={null}>
        {drawer && <AppContext.Provider value={{ ...app, data: drawer.raw ? source : dataset }}>
          <ProblemDrawer pid={drawer.pid} highlightModel={drawer.model} onClose={() => setDrawer(null)}
            onSubmitClick={app.isContributor ? () => openForm(drawer.pid) : undefined}
            onEditRecord={editRecord} blankEmpty decimal={drawer.raw ? 2 : 5} />
        </AppContext.Provider>}
        {formState && <RecordFormModal perfFields editRecord={formState.edit} lockPid={formState.lockPid} onClose={() => setFormState(null)} />}
        {publishOpen && <PublishModal onClose={() => setPublishOpen(false)} />}
        {importOpen && <ImportModal onClose={() => setImportOpen(false)} />}
      </Suspense>
    </>
  )
}
