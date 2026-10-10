import { Navigate, Route, Routes } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import K4uV2Page from './pages/K4uV2Page'
import { useApp } from './state'
import ErrorBoundary from './components/ErrorBoundary'
import ToastHost from './components/ToastHost'
import BackTop from './components/BackTop'
import ShortcutHelp from './components/ShortcutHelp'

const AdminPage = lazy(() => import('./pages/AdminPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))
const RegisterPage = lazy(() => import('./pages/RegisterPage'))
const ContributorsPage = lazy(() => import('./pages/ContributorsPage'))
const PromptsPage = lazy(() => import('./pages/PromptsPage'))
const ArenaPage = lazy(() => import('./pages/ArenaPage'))
const CompetitionsPage = lazy(() => import('./pages/CompetitionsPage'))
const RollPage = lazy(() => import('./pages/RollPage'))
const AuthModal = lazy(() => import('./components/AuthModal'))

export default function App() {
  const { authOpen, closeAuth } = useApp()
  return (
    <ErrorBoundary>
      <Suspense fallback={<main className="layout route-loading" role="status">加载中...</main>}>
      <Routes>
        <Route path="/" element={<K4uV2Page />} />
        <Route path="/v2" element={<K4uV2Page />} />
        {/* 旧数据页（v1）已下线：老链接统一跳回首页（= v2） */}
        <Route path="/old" element={<Navigate to="/" replace />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/contributors" element={<ContributorsPage />} />
        <Route path="/arena" element={<CompetitionsPage />} />
        <Route path="/arena/:slug" element={<ArenaPage />} />
        <Route path="/roll" element={<RollPage />} />
        <Route path="/prompts" element={<PromptsPage />} />
        <Route path="*" element={<K4uV2Page />} />
      </Routes>
      </Suspense>
      {authOpen && <Suspense fallback={null}><AuthModal onClose={closeAuth} /></Suspense>}
      <ToastHost />
      <BackTop />
      <ShortcutHelp />
    </ErrorBoundary>
  )
}
