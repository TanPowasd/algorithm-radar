import { Navigate, Route, Routes } from 'react-router-dom'
import AdminPage from './pages/AdminPage'
import UsersPage from './pages/UsersPage'
import RegisterPage from './pages/RegisterPage'
import ContributorsPage from './pages/ContributorsPage'
import PromptsPage from './pages/PromptsPage'
import K4uV2Page from './pages/K4uV2Page'
import ArenaPage from './pages/ArenaPage'
import ErrorBoundary from './components/ErrorBoundary'
import ToastHost from './components/ToastHost'
import BackTop from './components/BackTop'
import ShortcutHelp from './components/ShortcutHelp'

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<K4uV2Page />} />
        <Route path="/v2" element={<K4uV2Page />} />
        {/* 旧数据页（v1）已下线：老链接统一跳回首页（= v2） */}
        <Route path="/old" element={<Navigate to="/" replace />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/contributors" element={<ContributorsPage />} />
        <Route path="/arena" element={<ArenaPage />} />
        <Route path="/prompts" element={<PromptsPage />} />
        <Route path="*" element={<K4uV2Page />} />
      </Routes>
      <ToastHost />
      <BackTop />
      <ShortcutHelp />
    </ErrorBoundary>
  )
}
