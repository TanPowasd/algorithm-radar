import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Radar, Settings2, ShieldCheck, UserRound, LogIn, PanelLeftClose, PanelLeftOpen,
  LayoutDashboard, Trophy, Library, ListOrdered, BookOpenText, Users, ChevronDown, Menu, X } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useApp } from '../state'
import { api } from '../api/client'
import { DEFAULT_UI_PREFERENCES } from '../uiPreferences'
const ChangePasswordModal = lazy(() => import('./ChangePasswordModal'))
const loadSettings = () => import('./SettingsDialog')
const SettingsDialog = lazy(loadSettings)
const PAGE_LOADERS = { '/arena': () => import('../pages/CompetitionsPage'), '/prompts': () => import('../pages/PromptsPage'),
  '/contributors': () => import('../pages/ContributorsPage'), '/roll': () => import('../pages/RollPage') }
const preloadPage = (path) => { PAGE_LOADERS[path]?.().catch(() => {}) }
const ROLE_LABELS = { owner: '站长', admin: '管理员', contributor: '贡献者' }

export default function AppShell({ onOpenAuth, onOpenPublish, onOpenImport, hud }) {
  const { session, offline, isAdmin, toast, refreshAll, openAuth,
    data, models, uiPreferences = DEFAULT_UI_PREFERENCES, updateUiPreferences } = useApp()
  const location = useLocation()
  const [pwOpen, setPwOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menu, setMenu] = useState(null)
  const [navigationPath, setNavigationPath] = useState(location.pathname)
  const shellRef = useRef(null)
  const mobileToggleRef = useRef(null)
  const collapsed = uiPreferences.sidebarCollapsed
  const features = uiPreferences.features
  const editorStyle = uiPreferences.style === 'vscode'
  const resources = [{key: 'rollboard', to: '/roll', label: '滚榜回放', Icon: ListOrdered},
    {key: 'prompts', to: '/prompts', label: '推荐提示词', Icon: BookOpenText},
    {key: 'contributors', to: '/contributors', label: '贡献者', Icon: Users}].filter((item) => features[item.key])
  const resourceActive = resources.some((item) => location.pathname.startsWith(item.to))
  const title = location.pathname.startsWith('/arena') ? '比赛' : location.pathname.startsWith('/roll') ? '滚榜回放'
    : location.pathname.startsWith('/prompts') ? '推荐提示词' : location.pathname.startsWith('/contributors') ? '贡献者'
      : location.pathname.startsWith('/admin') ? '审核台' : location.pathname.startsWith('/users') ? '用户管理'
        : location.pathname === '/register' ? '注册' : '模型评测'
  if (navigationPath !== location.pathname) {
    setNavigationPath(location.pathname)
    setMenu(null)
    setMobileOpen(false)
  }
  useEffect(() => {
    const click = (event) => {if (!shellRef.current?.contains(event.target)) setMenu(null)}
    const keydown = (event) => {
      if (event.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return
      const expanded = menu ? shellRef.current?.querySelector('.shell-account[aria-expanded="true"]') : mobileToggleRef.current
      if (menu || mobileOpen) {event.stopPropagation(); setMenu(null); setMobileOpen(false); expanded?.focus()}
    }
    document.addEventListener('click', click); document.addEventListener('keydown', keydown)
    return () => {document.removeEventListener('click', click); document.removeEventListener('keydown', keydown)}
  }, [menu, mobileOpen])
  const logout = async () => {
    try {await api('/api/logout', {method: 'POST'}); toast('已退出登录'); await refreshAll()}
    catch (error) {toast(error.message, 'err')}
  }
  const linkClass = (active) => 'shell-nav-link' + (active ? ' selected' : '')
  return <div className="workbench-shell" ref={shellRef}>
    {mobileOpen && <button type="button" className="sidebar-backdrop" aria-label="关闭导航" onClick={() => {setMobileOpen(false); mobileToggleRef.current?.focus()}} />}
    <aside className={'app-sidebar' + (mobileOpen ? ' mobile-open' : '')} aria-label="导航侧栏" id="app-sidebar">
      <Link className="shell-brand" to="/" aria-label="算法雷达首页"><Radar size={28} aria-hidden="true" /><span>算法雷达<small>ALGORITHM RADAR</small></span></Link>
      <nav className="sidebar-navigation" aria-label="主导航">
        <span className="sidebar-group-label">工作台</span>
        <Link className={linkClass(location.pathname === '/' || location.pathname === '/v2')} to="/" aria-current={location.pathname === '/' || location.pathname === '/v2' ? 'page' : undefined} title={collapsed ? '模型评测' : undefined}><LayoutDashboard size={19} aria-hidden="true" /><span>模型评测</span></Link>
        {features.competitions && <Link className={linkClass(location.pathname.startsWith('/arena'))} to="/arena" aria-current={location.pathname.startsWith('/arena') ? 'page' : undefined} onPointerEnter={() => preloadPage('/arena')} onFocus={() => preloadPage('/arena')} title={collapsed ? '比赛' : undefined}><Trophy size={19} aria-hidden="true" /><span>比赛</span></Link>}
        {resources.length > 0 && <details className="sidebar-group" key={resourceActive ? 'resource-active' : 'resource-rest'} open={resourceActive || collapsed}>
          <summary><Library size={19} aria-hidden="true" /><span>资料与回放</span><ChevronDown size={15} className="sidebar-chevron" aria-hidden="true" /></summary>
          <div className="sidebar-group-items">{resources.map(({key, to, label, Icon}) => <Link key={key} className={linkClass(location.pathname.startsWith(to))} to={to} aria-current={location.pathname.startsWith(to) ? 'page' : undefined} onPointerEnter={() => preloadPage(to)} onFocus={() => preloadPage(to)} title={collapsed ? label : undefined}><Icon size={18} aria-hidden="true" /><span>{label}</span></Link>)}</div>
        </details>}
        {isAdmin && <details className="sidebar-group" open={location.pathname === '/admin' || location.pathname === '/users' || collapsed}>
          <summary><ShieldCheck size={19} aria-hidden="true" /><span>管理</span><ChevronDown size={15} className="sidebar-chevron" aria-hidden="true" /></summary>
          <div className="sidebar-group-items">
            <Link className={linkClass(location.pathname === '/admin')} to="/admin" title={collapsed ? '审核台' : undefined}><ShieldCheck size={18} /><span>审核台</span></Link>
            <Link className={linkClass(location.pathname === '/users')} to="/users" title={collapsed ? '用户管理' : undefined}><Users size={18} /><span>用户管理</span></Link>
            {onOpenPublish && <button type="button" className="shell-nav-link" onClick={onOpenPublish}><BookOpenText size={18} /><span>发布新题</span></button>}
            {onOpenImport && <button type="button" className="shell-nav-link" onClick={onOpenImport}><Library size={18} /><span>导入历史数据</span></button>}
          </div>
        </details>}
      </nav>
      <div className="sidebar-bottom">
        <button type="button" className="shell-nav-link" onPointerEnter={() => loadSettings().catch(() => {})} onFocus={() => loadSettings().catch(() => {})} onClick={() => {
          if (mobileOpen) mobileToggleRef.current?.focus()
          setSettingsOpen(true); setMobileOpen(false)
        }} title={collapsed ? '设置' : undefined}><Settings2 size={19} aria-hidden="true" /><span>设置</span></button>
      </div>
    </aside>
    <header className="topbar shell-topbar">
      <button type="button" className="icon-btn desktop-navigation-toggle" onClick={() => updateUiPreferences({sidebarCollapsed: !collapsed})}
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'} title={collapsed ? '展开侧栏' : '收起侧栏'} aria-expanded={!collapsed} aria-controls="app-sidebar">
        {collapsed ? <PanelLeftOpen size={19} aria-hidden="true" /> : <PanelLeftClose size={19} aria-hidden="true" />}
      </button>
      <button ref={mobileToggleRef} type="button" className="icon-btn mobile-navigation-toggle" onClick={() => setMobileOpen(!mobileOpen)} aria-label={mobileOpen ? '收起导航' : '打开导航'} aria-expanded={mobileOpen} aria-controls="app-sidebar">{mobileOpen ? <X size={20} /> : <Menu size={20} />}</button>
      <div className={'shell-breadcrumb' + (editorStyle ? ' editor-current-page' : '')}><span>算法雷达</span><span aria-hidden="true">/</span><strong>{title}</strong></div>
      <div className="shell-header-actions">
        <span className={'shell-connection' + (offline ? ' offline' : '')}><i aria-hidden="true" />{offline ? '缓存数据' : '已连接'}</span>
        {session.demo ? <span className="demo-badge">合成数据 · 只读演示</span> : session.loggedIn ? <div className="dropdown-wrap">
          <button type="button" className="btn ghost shell-account" onClick={() => setMenu(menu === 'user' ? null : 'user')} aria-expanded={menu === 'user'}><UserRound size={17} aria-hidden="true" /><span>{session.nickname || session.username}</span><ChevronDown size={14} aria-hidden="true" /></button>
          {menu === 'user' && <div className="dropdown-menu"><span className="account-role">{ROLE_LABELS[session.role] || session.role}</span>
            <button type="button" className="dropdown-item" onClick={() => {setPwOpen(true); setMenu(null)}}>账号设置（昵称 / 密码）</button>
            <button type="button" className="dropdown-item" onClick={() => {logout(); setMenu(null)}}>退出登录</button>
          </div>}
        </div> : <button type="button" className="btn ghost shell-account" onClick={onOpenAuth || openAuth}><LogIn size={17} aria-hidden="true" />登录</button>}
      </div>
    </header>
    {editorStyle && <footer className="editor-statusbar" aria-label="工作区状态"><span><Radar size={14} />算法雷达<span className="editor-status-page"> / {title}</span></span>
      <span>{(data?.records || []).filter((record) => record.status === 'approved').length} 条测评 · {models?.length || 0} 个模型</span>
      <span>{session.demo ? '合成数据演示' : offline ? '缓存数据' : '已连接'}</span></footer>}
    <Suspense fallback={null}>{settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} hud={hud} />}
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}</Suspense>
  </div>
}
