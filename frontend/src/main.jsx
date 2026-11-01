import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppProvider } from './state'
import App from './App'
import { applyUiPreferences, readUiPreferences } from './uiPreferences'

/* 自托管字体：科技感标题与等宽数值；中文正文使用系统无衬线字体。 */
import '@fontsource/chakra-petch/latin-500.css'
import '@fontsource/chakra-petch/latin-600.css'
import '@fontsource/chakra-petch/latin-700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-700.css'

import './styles.css'
import './workbench.css'
import './management.css'
import './reading-ui.css'
import './interaction-ui.css'
import './refinement-ui.css'
import './polish-ui.css'

/* 首帧前就把主题/版心写到 <html> 上，避免明暗切换闪白 */
try {
  const saved = localStorage.getItem('radar.theme')
  const mode = ['light', 'dark', 'warm', 'system'].includes(saved) ? saved : 'system'
  const resolved = mode === 'system' ? (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode
  const root = document.documentElement
  root.setAttribute('data-theme', resolved)
  root.setAttribute('data-theme-mode', mode)
  root.setAttribute('data-width', localStorage.getItem('radar.widthMode') === 'narrow' ? 'narrow' : 'full')
  applyUiPreferences(root, readUiPreferences())
} catch {
  document.documentElement.setAttribute('data-theme', 'light')
  document.documentElement.setAttribute('data-theme-mode', 'system')
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </React.StrictMode>,
)
