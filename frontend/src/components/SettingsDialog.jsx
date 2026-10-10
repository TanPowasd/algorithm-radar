import { useState } from 'react'
import { Check, Monitor, Sun, Moon, Coffee, X, Palette, PanelsTopLeft, Download } from 'lucide-react'
import { useApp } from '../state'
import { useDialog } from '../hooks/useDialog'
import { download } from '../api/client'
import { DEFAULT_UI_PREFERENCES, FEATURE_OPTIONS } from '../uiPreferences'
import Hud from './Hud'
import MotionRegion from './MotionRegion'

const THEMES = [
  { key: 'system', label: '跟随系统', description: '自动切换明暗', Icon: Monitor },
  { key: 'light', label: '白天', description: '清爽白底', Icon: Sun },
  { key: 'dark', label: '黑夜', description: '纯黑底色', Icon: Moon },
  { key: 'warm', label: '暖色', description: '米白纸感', Icon: Coffee },
]
const SECTIONS = [{ key: 'appearance', label: '外观', Icon: Palette },
  { key: 'features', label: '功能显示', Icon: PanelsTopLeft }, { key: 'data', label: '数据', Icon: Download }]

export default function SettingsDialog({ onClose, hud }) {
  const { themeMode, setThemeMode, widthMode, setWidthMode,
    uiPreferences = DEFAULT_UI_PREFERENCES, updateUiPreferences, resetUiPreferences } = useApp()
  const dialogRef = useDialog(onClose)
  const [section, setSection] = useState('appearance')
  const [restored, setRestored] = useState(false)
  const changePreferences = (patch) => {updateUiPreferences(patch); setRestored(false)}
  return <div className="modal-overlay settings-overlay" onMouseDown={(event) => {if (event.target === event.currentTarget) onClose()}}>
    <section ref={dialogRef} className="settings-dialog" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1}>
      <header className="settings-header"><h2>设置</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="关闭设置"><X size={20} /></button></header>
      <div className="settings-layout">
        <nav className="settings-categories" role="tablist" aria-label="设置分类">
          {SECTIONS.map(({ key, label, Icon }, index) => <button key={key} type="button" role="tab"
            id={'settings-tab-' + key} aria-selected={section === key} aria-controls="settings-content"
            tabIndex={section === key ? 0 : -1} onClick={() => setSection(key)} onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const next = event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1
                : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + SECTIONS.length) % SECTIONS.length
              setSection(SECTIONS[next].key)
              document.getElementById('settings-tab-' + SECTIONS[next].key)?.focus()
            }}><Icon size={17} aria-hidden="true" />{label}</button>)}
        </nav>
        <MotionRegion motionKey={section} id="settings-content" className="settings-content" role="tabpanel" aria-labelledby={'settings-tab-' + section}>
          {section === 'appearance' && <>
            <h3>让界面适合你的习惯</h3><p className="settings-description">主题、字号和布局会自动保存在这台设备上。</p>
            <div className="settings-theme-grid" role="group" aria-label="主题模式">
              {THEMES.map(({ key, label, description, Icon }) => <button key={key} type="button" className="settings-theme"
                data-preview-theme={key} aria-pressed={themeMode === key} onClick={() => {setThemeMode(key); setRestored(false)}}>
                <span className="theme-preview" aria-hidden="true"><span /><i /><b /></span>
                <span className="theme-option-label"><Icon size={16} aria-hidden="true" />{label}{themeMode === key && <Check size={16} className="theme-option-check" aria-hidden="true" />}</span>
                <small>{description}</small>
              </button>)}
            </div>
            <label className="settings-row"><span>界面风格<small>清爽留白、紧凑数据，或 VS Code 的目录布局</small></span>
              <select value={uiPreferences.style} onChange={(event) => changePreferences({style: event.target.value})}><option value="clean">清爽</option><option value="compact">紧凑</option><option value="vscode">VS Code</option></select>
            </label>
            <label className="settings-row"><span>文字大小<small>说明文字也保持清晰可读</small></span>
              <select value={uiPreferences.fontSize} onChange={(event) => changePreferences({fontSize: Number(event.target.value)})}><option value="16">标准 · 16px</option><option value="18">加大 · 18px</option><option value="20">更大 · 20px</option></select>
            </label>
            <label className="settings-row"><span>内容宽度<small>矩阵的横向滚动保留在表格内部</small></span>
              <select value={widthMode} onChange={(event) => {setWidthMode(event.target.value); setRestored(false)}}><option value="full">全宽</option><option value="narrow">居中</option></select>
            </label>
            <label className="settings-row"><span>切换动画<small>页面与视图轻柔过渡，跟随系统的动态效果偏好</small></span>
              <select value={uiPreferences.motion || 'system'} onChange={(event) => changePreferences({motion: event.target.value})}><option value="system">跟随系统</option><option value="off">关闭动画</option></select>
            </label>
          </>}
          {section === 'features' && <>
            <h3>只显示你需要的功能</h3><p className="settings-description">关闭会收起入口或面板，已有数据保留。随时可以在这里重新打开。</p>
            <div className="feature-options">{FEATURE_OPTIONS.map(({ key, label, description }) => <label className="settings-row feature-option" key={key}>
              <span>{label}<small>{description}</small></span><input type="checkbox" role="switch" aria-label={label} checked={uiPreferences.features[key]}
                onChange={(event) => changePreferences({features: {[key]: event.target.checked}})} />
            </label>)}</div>
          </>}
          {section === 'data' && <>
            <h3>数据与帮助</h3><p className="settings-description">下载当前可公开访问的数据。</p>
            <div className="settings-data-actions"><button type="button" className="btn" onClick={() => download('/api/export/public?format=csv')}><Download size={16} />导出 CSV</button>
              <button type="button" className="btn" onClick={() => download('/api/export/public?format=json')}><Download size={16} />导出 JSON</button></div>
            <div className="settings-contact"><span>账号审核 QQ 群</span><strong>1107535292</strong></div>
            {hud && <details className="settings-runtime"><summary>运行读数</summary><Hud {...hud} /></details>}
          </>}
        </MotionRegion>
      </div>
      <footer className="settings-footer"><button type="button" className="btn ghost" onClick={() => {resetUiPreferences(); setRestored(true)}}>恢复默认</button>
        <span role="status" aria-live="polite">{restored ? '已恢复默认设置' : '修改自动保存'}</span><button type="button" className="btn primary" onClick={onClose}>完成</button></footer>
    </section>
  </div>
}
