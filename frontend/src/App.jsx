import { Route, Routes } from 'react-router-dom'
import HomePage from './pages/HomePage'
import AdminPage from './pages/AdminPage'
import UsersPage from './pages/UsersPage'
import RegisterPage from './pages/RegisterPage'
import ContributorsPage from './pages/ContributorsPage'
import ToastHost from './components/ToastHost'
import BackTop from './components/BackTop'
import ShortcutHelp from './components/ShortcutHelp'

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/contributors" element={<ContributorsPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
      <ToastHost />
      <BackTop />
      <ShortcutHelp />
    </>
  )
}
