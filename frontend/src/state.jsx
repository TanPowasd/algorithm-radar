import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api/client'
import { makeVendorOf } from './palette'
import { createRefreshCoordinator } from './refreshCoordinator'

const LS_CACHE = 'radar.cache.v3'
const LS_THEME = 'radar.theme'
const LS_FOCUS = 'radar.focusModels'
const LS_CONTRIBUTOR = 'radar.focusContributor'
const LS_WIDTH = 'radar.widthMode'
const LS_BARN = 'radar.bar.minSamples'
const LS_RADAR = 'radar.radarSize'

const AppContext = createContext(null)
export { AppContext }

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
    return false
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
    const v = readLS(LS_THEME, 'light')
    return v === 'system' || v === 'light' || v === 'dark' ? v : 'light'
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
  // 全局「贡献者视角」：null = 全部；数字 uid = 某贡献者；'legacy' = 全民制作人（历史导入）
  const [focusContributor, setFocusContributor] = useState(() => {
    try {
      const v = localStorage.getItem(LS_CONTRIBUTOR)
      if (v === 'legacy') return 'legacy'
      if (v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v)
      return null
    } catch {
      return null
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
      return true
    } catch {
      return false
    }
  }, [])

  /**
   * 数据源：线上 D1 的 /api/data —— 唯一真源（记录、题目目录、修订号都来自这里）。
   * 旧数据页（v1，/old）与其冻结快照 frontend/public/data/old.json 已下线，
   * 不再做「冻结快照 + D1」合并：删除过的历史记录不再被快照复活。
   * 接口失败时保留现有数据（或本地缓存）只读展示，交由上层判定离线。
   */
  const refreshData = useCallback(async () => {
    try {
      const d = await api('/api/data')
      setData(d)
      saveCache(d)
      return true
    } catch {
      return false // 断网/失败：保留现有数据（或缓存）只读展示，交由上层判定离线
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

  /**
   * 一次全量拉取：session + data 并行，成功后再补 models + contributors。
   * 以「/api/data 成功」为在线判据（session 失败只影响登录态显示，不判离线）。
   */
  const runFullRefresh = useCallback(async () => {
    const [, dataOk] = await Promise.all([refreshSession(), refreshData()])
    setLoaded(true)
    if (dataOk) {
      setOffline(false)
      await Promise.all([
        refreshModels().catch(() => {}),
        refreshNicknames().catch(() => {}),
      ])
      return true
    }
    setOffline(true)
    return false
  }, [refreshSession, refreshData, refreshModels, refreshNicknames])

  // 协调器只建一次；任务体用 setTask 在 effect 里更新（渲染期不碰 ref）
  const [coordinator] = useState(() => createRefreshCoordinator(runFullRefresh))
  useEffect(() => { coordinator.setTask(runFullRefresh) }, [coordinator, runFullRefresh])

  /** 数据变更后的刷新（提交/编辑/删除/审核/发布/导入…）：一定拉到「变更之后」的状态 */
  const refreshAll = useCallback(() => coordinator.refresh(), [coordinator])
  /** 挂载与离线自动重试：已有刷新在飞就搭同一班车，不会白打一遍接口 */
  const syncData = useCallback(() => coordinator.sync(), [coordinator])

  /** 手动重试（横幅按钮/快捷键）：清掉 offline 状态强制立即刷新一次 */
  const retryNow = useCallback(async () => {
    setOffline(false)
    await refreshAll()
  }, [refreshAll])

  // 首次挂载即全量刷新（StrictMode 双调用也只会打一轮）
  useEffect(() => {
    syncData()
  }, [syncData])

  // 离线自动重试：每 18s 尝试一次；成功后 offline 变 false → 本 effect 自动清理定时器
  useEffect(() => {
    if (!offline) return undefined
    const timer = setInterval(() => {
      syncData()
    }, 18000)
    return () => clearInterval(timer)
  }, [offline, syncData])

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
    setThemeMode(theme === 'dark' ? 'light' : 'dark')
  }, [theme])

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

  useEffect(() => {
    try {
      writeLS(LS_CONTRIBUTOR, focusContributor === null ? '' : String(focusContributor))
    } catch { /* 忽略 */ }
  }, [focusContributor])

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
    focusContributor,
    setFocusContributor,
    toasts,
    toast,
    refreshAll,
    syncData,
    refreshSession,
    refreshData,
    refreshModels,
    refreshNicknames,
    retryNow,
    isOwner: session.role === 'owner',
    isAdmin: session.role === 'admin' || session.role === 'owner',
    isContributor: session.role === 'contributor' || session.role === 'admin' || session.role === 'owner',
  }), [session, data, models, nicknames, nicknameOf, nameByUid, offline, loaded, theme, themeMode, toggleTheme,
    widthMode, barMinSamples, radarSize, vendorOf, focusModels, toggleFocusModel, focusOnly,
    focusContributor, setFocusContributor, toasts, toast,
    refreshAll, syncData, refreshSession, refreshData, refreshModels, refreshNicknames, retryNow])

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>
}

export function useApp() {
  return useContext(AppContext)
}
