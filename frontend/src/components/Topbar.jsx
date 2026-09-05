import { useEffect, useRef, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useApp } from '../state'
import { api, download } from '../api/client'
import ChangePasswordModal from './ChangePasswordModal'
import Hud from './Hud'

const ROLE_LABELS = { owner: '站长', admin: '管理员', contributor: '贡献者' }
const THEME_LABEL = {
  dark: ['☾', '夜间模式（按 T 切到日间）'],
  light: ['☀', '日间模式（按 T 切到跟随系统）'],
  system: ['◐', '跟随系统（按 T 切到夜间）'],
}

export default function Topbar({ onOpenAuth, onOpenPublish, onOpenImport, hud }) {
  const { session, offline, isAdmin, theme, themeMode, toggleTheme,
    widthMode, setWidthMode, toast, refreshAll } = useApp()
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
      if (e.key === 'Escape') setMenu(null)
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

  const [icon, tip] = THEME_LABEL[themeMode] || THEME_LABEL.dark
  const isSubPage = ['/admin', '/users', '/contributors', '/prompts', '/register'].includes(location.pathname)

  return (
    <header className="topbar" ref={topbarRef}>
      <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="brand">
          <h1>AI vs 洛谷</h1>
          <span className="sub">解题能力对比</span>
        </div>
      </Link>
      <span className={`conn ${offline ? 'bad' : 'ok'}`} title={offline ? '服务器离线（展示缓存数据）' : '已连接'} />
      {hud && <Hud {...hud} />}
      <div className="spacer" />

      <nav style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        {/* 常驻基础导航 */}
        <Link className={`btn small ${location.pathname === '/contributors' ? 'primary' : 'ghost'}`} to="/contributors">
          贡献榜
        </Link>
        <Link className={`btn small ${location.pathname === '/prompts' ? 'primary' : 'ghost'}`} to="/prompts">
          推荐提示词
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
            工具 ▾
          </button>
          {menu === 'tools' && (
            <div className="dropdown-menu">
              <button
                type="button"
                className="dropdown-item"
                onClick={() => { download('/api/export/public?format=csv'); setMenu(null) }}
              >
                <span>📄</span> 导出数据 (CSV)
              </button>
              <button
                type="button"
                className="dropdown-item"
                onClick={() => { download('/api/export/public?format=json'); setMenu(null) }}
              >
                <span>📦</span> 导出数据 (JSON)
              </button>
              <div className="dropdown-divider" />
              <button
                type="button"
                className="dropdown-item"
                onClick={() => {
                  setWidthMode(widthMode === 'full' ? 'narrow' : 'full')
                  setMenu(null)
                }}
              >
                <span>{widthMode === 'full' ? '⤡' : '⤢'}</span>
                {widthMode === 'full' ? '切换为限宽居中' : '切换为全宽铺满'}
              </button>
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
              管理 ▾
            </button>
            {menu === 'admin' && (
              <div className="dropdown-menu">
                <Link className="dropdown-item" to="/admin">
                  <span>🛡</span> 审核台
                </Link>
                <Link className="dropdown-item" to="/users">
                  <span>👥</span> 用户管理
                </Link>
                {onOpenPublish && (
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { onOpenPublish(); setMenu(null) }}
                  >
                    <span>➕</span> 发布新题
                  </button>
                )}
                {onOpenImport && (
                  <button
                    type="button"
                    className="dropdown-item"
                    onClick={() => { onOpenImport(); setMenu(null) }}
                  >
                    <span>📥</span> 导入历史数据
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
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
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
                  <span>⚙</span> 账号设置（改密）
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => { logout(); setMenu(null) }}
                  style={{ color: 'var(--red)' }}
                >
                  <span>🚪</span> 退出登录
                </button>
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <Link className="btn small ghost" to="/register">注册</Link>
            <button className="btn small primary" onClick={onOpenAuth}>登录</button>
          </div>
        )}

        {/* 主题切换 */}
        <button
          className="icon-btn"
          onClick={toggleTheme}
          title={`${tip}（当前 ${themeMode} → 实际 ${theme}）`}
          style={{ width: 28, height: 28, fontSize: 13 }}
        >
          {icon}
        </button>
      </nav>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </header>
  )
}
