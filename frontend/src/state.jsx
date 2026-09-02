import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api/client'

const LS_CACHE = 'radar.cache.v3'
const LS_THEME = 'radar.theme'

const AppContext = createContext(null)

function loadCache() {
  try {
    const raw = localStorage.getItem(LS_CACHE)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function saveCache(data) {
  try {
    localStorage.setItem(LS_CACHE, JSON.stringify({ ...data, cachedAt: Date.now() }))
  } catch {
    /* 存储满则忽略 */
  }
}

export function AppProvider({ children }) {
  const [session, setSession] = useState({ loggedIn: false, username: '', role: '', admin: false, canSetup: false, configured: false })
  const [data, setData] = useState(() => loadCache() || { revision: 0, records: [], problems: {} })
  const [models, setModels] = useState([])
  const [nicknames, setNicknames] = useState({})
  const [offline, setOffline] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [theme, setTheme] = useState(() => localStorage.getItem(LS_THEME) || 'dark')
  const [toasts, setToasts] = useState([])
  const toastSeq = useRef(1)

  const toast = useCallback((text, kind = 'ok') => {
    const id = toastSeq.current++
    setToasts((list) => [...list, { id, text, kind }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), kind === 'err' ? 5000 : 3200)
  }, [])

  const refreshSession = useCallback(async () => {
    try {
      const s = await api('/api/session')
      setSession(s)
      setOffline(false)
    } catch {
      setOffline(true)
    }
  }, [])

  const refreshData = useCallback(async () => {
    try {
      const d = await api('/api/data')
      setData(d)
      saveCache(d)
      setOffline(false)
    } catch {
      setOffline(true) // 断网时保留缓存数据只读展示
    } finally {
      setLoaded(true)
    }
  }, [])

  const refreshModels = useCallback(async () => {
    try {
      const m = await api('/api/models')
      setModels(m.models || [])
    } catch {
      /* 断网保留现状 */
    }
  }, [])

  const refreshNicknames = useCallback(async () => {
    try {
      const d = await api('/api/contributors')
      const map = {}
      for (const c of d.contributors || []) {
        map[c.username] = { nickname: c.nickname || '', uid: c.uid ?? null, role: c.role || '' }
      }
      setNicknames(map)
    } catch {
      /* 断网保留现状 */
    }
  }, [])

  /** 显示名：昵称优先，无则回退登录 ID */
  const nicknameOf = useCallback((username) => {
    const entry = nicknames[username]
    return (entry && entry.nickname) || username || '—'
  }, [nicknames])

  /** 按用户 id 反查显示名（审核人列用） */
  const nameByUid = useCallback((uid) => {
    if (uid === null || uid === undefined) return null
    const entry = Object.values(nicknames).find((e) => e.uid === uid)
    return entry ? (entry.nickname || null) : null
  }, [nicknames])

  const refreshAll = useCallback(async () => {
    await Promise.all([refreshSession(), refreshData(), refreshModels(), refreshNicknames()])
  }, [refreshSession, refreshData, refreshModels, refreshNicknames])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(LS_THEME, theme)
  }, [theme])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'))
  }, [])

  const value = useMemo(() => ({
    session,
    data,
    models,
    nicknames,
    nicknameOf,
    nameByUid,
    offline,
    loaded,
    theme,
    toasts,
    toast,
    toggleTheme,
    refreshAll,
    refreshSession,
    refreshData,
    refreshModels,
    refreshNicknames,
    isOwner: session.role === 'owner',
    isAdmin: session.role === 'admin' || session.role === 'owner',
    isContributor: session.role === 'contributor' || session.role === 'admin' || session.role === 'owner',
  }), [session, data, models, nicknames, nicknameOf, nameByUid, offline, loaded, theme, toasts, toast, toggleTheme, refreshAll, refreshSession, refreshData, refreshModels, refreshNicknames])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  return useContext(AppContext)
}
