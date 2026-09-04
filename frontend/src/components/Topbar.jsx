import { useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useApp } from '../state'
import { api, download } from '../api/client'
import ChangePasswordModal from './ChangePasswordModal'
import Hud from './Hud'

const ROLE_LABELS = { owner: '站长', admin: '管理员', contributor: '贡献者' }
const THEME_LABEL = { dark: ['☾', '夜间模式（按 T 切到日间）'], light: ['☀', '日间模式（按 T 切到跟随系统）'], system: ['◐', '跟随系统（按 T 切到夜间）'] }

export default function Topbar({ onOpenAuth, onOpenPublish, onOpenImport, hud }) {
  const { session, offline, isAdmin, isOwner, theme, themeMode, toggleTheme,
    widthMode, setWidthMode, toast, refreshAll } = useApp()
  const location = useLocation()
  const [pwOpen, setPwOpen] = useState(false)

  const logout = async () => {
    try {
      await api('/api/logout', { method: 'POST' })
      toast('已退出登录')
      await refreshAll()
    } catch (e) {
      toast(e.message, 'err')
    }
  }

  const [icon, tip] = THEME_LABEL[themeMode] || THEME_LABEL.dark

  return (
    <header className="topbar">
      <Link to="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="brand">
          <h1>AI vs 洛谷</h1>
          <span className="sub">解题能力对比</span>
        </div>
      </Link>
      <span className={`conn ${offline ? 'bad' : 'ok'}`} title={offline ? '服务器离线（展示缓存数据）' : '已连接'} />
      {hud && <Hud {...hud} />}
      <div className="spacer" />
      <nav style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {isAdmin && <Link className="btn small ghost" to="/admin">审核台</Link>}
        {isOwner && <Link className="btn small ghost" to="/users">用户管理</Link>}
        <Link className="btn small ghost" to="/contributors">贡献榜</Link>
        <Link className="btn small ghost" to="/prompts">推荐提示词</Link>
        {(location.pathname === '/admin' || location.pathname === '/users' || location.pathname === '/contributors' || location.pathname === '/prompts') && (
          <Link className="btn small ghost" to="/">返回总览</Link>
        )}
        <button className="btn small ghost" onClick={() => download('/api/export/public?format=csv')} title="游客可下载（仅已审核数据）">导出 CSV</button>
        <button className="btn small ghost" onClick={() => download('/api/export/public?format=json')} title="游客可下载（仅已审核数据）">导出 JSON</button>
        {isAdmin && onOpenImport && <button className="btn small ghost" onClick={onOpenImport}>导入</button>}
        {isAdmin && onOpenPublish && <button className="btn small" onClick={onOpenPublish}>发布新题</button>}
        {session.loggedIn ? (
          <>
            <span className="who">
              <span className="role-tag">{ROLE_LABELS[session.role] || session.role}</span>
              {session.nickname || session.username}
            </span>
            <button className="btn small ghost" onClick={() => setPwOpen(true)}>改密码</button>
            <button className="btn small ghost" onClick={logout}>退出</button>
          </>
        ) : (
          <>
            <Link className="btn small ghost" to="/register">注册</Link>
            <button className="btn small primary" onClick={onOpenAuth}>登录</button>
          </>
        )}
        <button
          className="icon-btn"
          onClick={() => setWidthMode(widthMode === 'full' ? 'narrow' : 'full')}
          title={widthMode === 'full' ? '当前：全宽铺满（按 W 切到限宽居中）' : '当前：限宽居中（按 W 切到全宽铺满）'}
        >
          {widthMode === 'full' ? '⤢' : '⤡'}
        </button>
        <button className="icon-btn" onClick={toggleTheme} title={`${tip}（当前 ${themeMode} → 实际 ${theme}）`}>{icon}</button>
      </nav>
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </header>
  )
}
