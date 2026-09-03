import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppProvider } from './state'
import App from './App'

/* 自托管字体（CSP: font-src 'self'）：Chakra Petch 管标题，JetBrains Mono 管正文与数据 */
import '@fontsource/chakra-petch/latin-500.css'
import '@fontsource/chakra-petch/latin-600.css'
import '@fontsource/chakra-petch/latin-700.css'
import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/jetbrains-mono/latin-700.css'

import './styles.css'

/* 首帧前就把主题/版心写到 <html> 上，避免明暗切换闪白 */
try {
  const mode = localStorage.getItem('radar.theme') || 'dark'
  const dark = mode === 'dark'
    || (mode === 'system' && (!window.matchMedia || window.matchMedia('(prefers-color-scheme: dark)').matches))
  const root = document.documentElement
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
  root.setAttribute('data-theme-mode', mode)
  root.setAttribute('data-width', localStorage.getItem('radar.widthMode') === 'narrow' ? 'narrow' : 'full')
} catch {
  /* 读不到 localStorage（隐私模式等）时保持 CSS 默认的夜间主题 */
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
