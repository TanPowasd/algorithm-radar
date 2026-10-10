import React from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { AppProvider } from './state'
import App from './App'

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

/* 首帧前就把主题/版心写到 <html> 上，避免明暗切换闪白 */
try {
  const saved = localStorage.getItem('radar.theme')
  const mode = ['light', 'dark', 'system'].includes(saved) ? saved : 'light'
  const dark = mode === 'dark'
    || (mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  const root = document.documentElement
  root.setAttribute('data-theme', dark ? 'dark' : 'light')
  root.setAttribute('data-theme-mode', mode)
  root.setAttribute('data-width', localStorage.getItem('radar.widthMode') === 'narrow' ? 'narrow' : 'full')
} catch {
  document.documentElement.setAttribute('data-theme', 'light')
  document.documentElement.setAttribute('data-theme-mode', 'light')
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
