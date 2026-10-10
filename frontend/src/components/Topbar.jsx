import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Radar, Settings2, ShieldCheck, Sun, Moon, UserRound, LogIn } from 'lucide-react'
import { Link, useLocation } from 'react-router-dom'
import { useApp } from '../state'
import { api, download } from '../api/client'
const ChangePasswordModal = lazy(() => import('./ChangePasswordModal'))
import Hud from './Hud'

const ROLE_LABELS = { owner: '站长', admin: '管理员', contributor: '贡献者' }

export default function Topbar({ onOpenAuth, onOpenPublish, onOpenImport, hud }) {
  const { session, offline, isAdmin, theme, themeMode, setThemeMode, toggleTheme,
    widthMode, setWidthMode, toast, refreshAll, openAuth } = useApp()
  const location = useLocation()
  const [pwOpen, setPwOpen] = useState(false)
  const [menu, setMenu] = useState(null) // 'tools' | 'admin' | 'user' | null
  const topbarRef = useRef(null)

  // 点击外部或 ESC 关闭下拉菜单
  useEffect(() => {
    const onDocClick = (e) => {
      if (topbarRef.current && !topbarRef.current.contains(e.target)) {
        setMenu(null)
      }
    }
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        const expanded = topbarRef.current?.querySelector('[aria-expanded="true"]')
        if (expanded) { e.stopPropagation(); expanded.focus() }
        setMenu(null)
      }
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  // 路由变化时自动收起菜单
  useEffect(() => {
    setMenu(null)
  }, [location.pathname])

  const logout = async () => {
    try {
      await api('/api/logout', { method: 'POST' })
      toast('已退出登录')
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const toggleMenu = (name) => {
    setMenu((m) => (m === name ? null : name))
  }

  const nextThemeLabel = theme === 'light' ? '切换到暗色' : '切换到亮色'
  const isSubPage = ['/admin', '/users', '/contributors', '/prompts', '/register', '/v2', '/roll'].includes(location.pathname)

  return (
    <header className="topbar" ref={topbarRef}>
      <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="brand">
          <Radar className="brand-mark" size={28} aria-hidden="true" />
          <h1>AI vs 洛谷</h1>
          <span className="sub">解题能力对比</span>
        </div>
      </Link>
      <span className={`conn ${offline ? 'bad' : 'ok'}`} title={offline ? '服务器离线（展示缓存数据）' : '已连接'} />
      <div className="spacer" />

      <nav className="topbar-nav" aria-label="主导航">
        <Link className={`btn small ${location.pathname === '/' || location.pathname === '/v2' ? 'primary' : 'ghost'}`} to="/">评测</Link>
        {/* 常驻基础导航 */}
        <Link className={`btn small ${location.pathname === '/contributors' ? 'primary' : 'ghost'}`} to="/contributors">
          贡献者
        </Link>
        <Link className={`btn small ${location.pathname === '/prompts' ? 'primary' : 'ghost'}`} to="/prompts">
          推荐提示词
        </Link>
        <Link className={`btn small ${location.pathname.startsWith('/arena') ? 'primary' : 'ghost'}`} to="/arena">
          比赛
        </Link>
        <Link className={`btn small ${location.pathname.startsWith('/roll') ? 'primary' : 'ghost'}`} to="/roll">
          滚榜
        </Link>
        {isSubPage && location.pathname !== '/' && (
          <Link className="btn small ghost" to="/">返回总览</Link>
        )}

        {/* 工具下拉菜单 */}
        <div className="dropdown-wrap">
          <button
            type="button"
            className={`btn small ghost ${menu === 'tools' ? 'on' : ''}`}
            onClick={() => toggleMenu('tools')}
            aria-expanded={menu === 'tools'}
            title="数据导出与显示布局设置"
          >
            <Settings2 size={15} aria-hidden="true" /><span>数据与设置</span>
          </button>
          {menu === 'tools' && (
            <div className="dropdown-menu">
              <button
                type="button"
                className="dropdown-item"
                onClick={() => { download('/api/export/public?format=csv'); setMenu(null) }}
              >
                导出数据 (CSV)
              </button>
              <button
                type="button"
                className="dropdown-item"
                onClick={() => { download('/api/export/public?format=json'); setMenu(null) }}
              >
                导出数据 (JSON)
              </button>
              <div className="dropdown-divider" />
              <label className="dropdown-setting">
                外观
                <select value={themeMode} onChange={(event) => setThemeMode(event.target.value)}>
                  <option value="light">亮色</option>
                  <option value="dark">暗色</option>
                  <option value="system">跟随系统</option>
                </select>
              </label>
              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  setWidthMode(widthMode === 'full' ? 'narrow' : 'full')
                  setMenu(null)
                }}
              >
                {widthMode === 'full' ? '切换为限宽居中' : '切换为全宽铺满'}
              </button>
              <div className="dropdown-divider" />
              <div style={{ padding: '6px 12px', fontSize: '11px', color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                用户审核 QQ 群：<strong style={{ color: 'var(--text)', userSelect: 'all' }}>1107535292</strong>
              </div>
              {hud && <details className="runtime-details"><summary>运行读数</summary><Hud {...hud} /></details>}
            </div>
          )}
        </div>

        {/* 管理员专享下拉菜单 */}
        {isAdmin && (
          <div className="dropdown-wrap">
            <button
              type="button"
              className={`btn small ghost ${menu === 'admin' ? 'on' : ''}`}
              onClick={() => toggleMenu('admin')}
              aria-expanded={menu === 'admin'}
              style={{ color: 'var(--accent)' }}
            >
              <ShieldCheck size={15} aria-hidden="true" />管理
            </button>
            {menu === 'admin' && (
              <div className="dropdown-menu">
                <Link className="dropdown-item" to="/admin">
                  审核台
                </Link>
                <Link className="dropdown-item" to="/users">
                  用户管理
                </Link>
                {onOpenPublish && (
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { onOpenPublish(); setMenu(null) }}
                  >
                    发布新题
                  </button>
                )}
                {onOpenImport && (
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { onOpenImport(); setMenu(null) }}
                  >
                    导入历史数据
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* 用户登录 / 个人中心 */}
        {session.loggedIn ? (
          <div className="dropdown-wrap">
            <button
              type="button"
              className="btn small ghost"
              onClick={() => toggleMenu('user')}
              aria-expanded={menu === 'user'}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              <UserRound size={15} aria-hidden="true" />
              <span className="role-tag" style={{ fontSize: 11 }}>{ROLE_LABELS[session.role] || session.role}</span>
              <span>{session.nickname || session.username}</span>
              <span style={{ fontSize: 10, opacity: 0.7 }}>▾</span>
            </button>
            {menu === 'user' && (
              <div className="dropdown-menu">
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => { setPwOpen(true); setMenu(null) }}
                >
                  账号设置（昵称 / 密码）
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => { logout(); setMenu(null) }}
                  style={{ color: 'var(--red)' }}
                >
                  退出登录
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Link className="btn small ghost" to="/register">注册</Link>
            <button className="btn small primary" onClick={onOpenAuth || openAuth}><LogIn size={15} aria-hidden="true" />登录</button>
          </div>
        )}

        {/* 主题切换 */}
        <button
          className="btn small ghost theme-toggle"
          onClick={toggleTheme}
          title={`${nextThemeLabel}（T）· 自动记住选择`}
          aria-label={nextThemeLabel}
        >
          {theme === 'light' ? <Moon size={17} aria-hidden="true" /> : <Sun size={17} aria-hidden="true" />}
        </button>
      </nav>
      {pwOpen && <Suspense fallback={null}><ChangePasswordModal onClose={() => setPwOpen(false)} /></Suspense>}
    </header>
  )
}
