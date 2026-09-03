import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api/client'
import { makeVendorOf } from './palette'

const LS_CACHE = 'radar.cache.v3'
const LS_THEME = 'radar.theme'
const LS_FOCUS = 'radar.focusModels'
const LS_WIDTH = 'radar.widthMode'
const LS_BARN = 'radar.bar.minSamples'
const LS_RADAR = 'radar.radarSize'

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

function readLS(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw
  } catch {
    return fallback
  }
}

/** 隐私模式 / 存储写满时不能把整个应用带崩 */
function writeLS(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 忽略 */
  }
}

const prefersDark = () => {
  try {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
  } catch {
    return true // 读不到系统偏好时保持本站传统：夜间优先
  }
}

export function AppProvider({ children }) {
  const [session, setSession] = useState({ loggedIn: false, username: '', role: '', admin: false, canSetup: false, configured: false })
  const [data, setData] = useState(() => loadCache() || { revision: 0, records: [], problems: {} })
  const [models, setModels] = useState([])
  const [nicknames, setNicknames] = useState({})
  const [offline, setOffline] = useState(false)
  const [loaded, setLoaded] = useState(false)
  /** 主题三态：'system' | 'light' | 'dark'（旧值 light/dark 直接兼容） */
  const [themeMode, setThemeMode] = useState(() => {
    const v = readLS(LS_THEME, 'dark')
    return v === 'system' || v === 'light' || v === 'dark' ? v : 'dark'
  })
  const [systemDark, setSystemDark] = useState(() => prefersDark())
  /** 版心：'full' 全宽铺满（默认） / 'narrow' 限宽居中 */
  const [widthMode, setWidthMode] = useState(() => (readLS(LS_WIDTH, 'full') === 'narrow' ? 'narrow' : 'full'))
  /** 柱状图最小样本量（原写死 n≥5，现可自定义） */
  const [barMinSamples, setBarMinSamples] = useState(() => {
    const n = Number(readLS(LS_BARN, '5'))
    return Number.isFinite(n) && n >= 1 && n <= 50 ? Math.round(n) : 5
  })
  /** 雷达图尺寸（0 = 自适应填满容器） */
  const [radarSize, setRadarSize] = useState(() => {
    const n = Number(readLS(LS_RADAR, '0'))
    return Number.isFinite(n) && n >= 0 && n <= 1600 ? Math.round(n) : 0
  })
  // 全局“只看这些模型”：Set（空/无 = 全部模型都看）
  const [focusModels, setFocusModels] = useState(() => {
    try {
      const raw = localStorage.getItem(LS_FOCUS)
      const arr = raw ? JSON.parse(raw) : []
      return Array.isArray(arr) && arr.length ? new Set(arr) : new Set()
    } catch {
      return new Set()
    }
  })
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

  /* ---------------- 主题（三态 + 跟随系统） ---------------- */
  const theme = themeMode === 'system' ? (systemDark ? 'dark' : 'light') : themeMode

  useEffect(() => {
    if (!window.matchMedia) return undefined
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const on = (e) => setSystemDark(e.matches)
    setSystemDark(Boolean(mq.matches))
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', on)
      return () => mq.removeEventListener('change', on)
    }
    if (typeof mq.addListener === 'function') {
      mq.addListener(on)
      return () => mq.removeListener(on)
    }
    return undefined
  }, [])

  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', theme)
    root.setAttribute('data-theme-mode', themeMode)
    writeLS(LS_THEME, themeMode)
  }, [theme, themeMode])

  useEffect(() => {
    document.documentElement.setAttribute('data-width', widthMode)
    try {
      writeLS(LS_WIDTH, widthMode)
    } catch { /* 忽略 */ }
  }, [widthMode])

  useEffect(() => {
    try {
      writeLS(LS_BARN, String(barMinSamples))
    } catch { /* 忽略 */ }
  }, [barMinSamples])

  useEffect(() => {
    try {
      writeLS(LS_RADAR, String(radarSize))
    } catch { /* 忽略 */ }
  }, [radarSize])

  const toggleTheme = useCallback(() => {
    setThemeMode((m) => (m === 'dark' ? 'light' : m === 'light' ? 'system' : 'dark'))
  }, [])

  /* ---------------- 模型筛选 ---------------- */
  /** 聚焦某模型（加入/移出选择集）；选择集为空 = 全部 */
  const toggleFocusModel = useCallback((name) => {
    setFocusModels((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }, [])

  /** 只看指定模型（空数组 = 全部） */
  const focusOnly = useCallback((names) => {
    setFocusModels(new Set(Array.isArray(names) ? names : []))
  }, [])

  useEffect(() => {
    writeLS(LS_FOCUS, JSON.stringify([...focusModels]))
  }, [focusModels])

  /* ---------------- 厂商解析（配色用） ---------------- */
  const vendorOf = useMemo(() => makeVendorOf(models), [models])

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
    themeMode,
    setThemeMode,
    toggleTheme,
    widthMode,
    setWidthMode,
    barMinSamples,
    setBarMinSamples,
    radarSize,
    setRadarSize,
    vendorOf,
    focusModels,
    toggleFocusModel,
    focusOnly,
    toasts,
    toast,
    refreshAll,
    refreshSession,
    refreshData,
    refreshModels,
    refreshNicknames,
    isOwner: session.role === 'owner',
    isAdmin: session.role === 'admin' || session.role === 'owner',
    isContributor: session.role === 'contributor' || session.role === 'admin' || session.role === 'owner',
  }), [session, data, models, nicknames, nicknameOf, nameByUid, offline, loaded, theme, themeMode, toggleTheme,
    widthMode, barMinSamples, radarSize, vendorOf, focusModels, toggleFocusModel, focusOnly, toasts, toast,
    refreshAll, refreshSession, refreshData, refreshModels, refreshNicknames])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  return useContext(AppContext)
}
