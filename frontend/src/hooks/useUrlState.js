import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * 把少量 UI 状态同步到 URL query：刷新不丢、链接可分享。
 * @param {string} prefix 命名空间（避免多组筛选互相污染），如 'rec'
 */
export function useUrlState(prefix = '') {
  const [params, setParams] = useSearchParams()

  const key = useCallback((k) => (prefix ? `${prefix}:${k}` : k), [prefix])

  const get = useCallback((k, fallback = '') => {
    const v = params.get(key(k))
    return v === null ? fallback : v
  }, [params, key])

  const getNum = useCallback((k, fallback) => {
    const v = params.get(key(k))
    const n = Number(v)
    return v === null || v === '' || !Number.isFinite(n) ? fallback : n
  }, [params, key])

  /** 一次写多个：值为 ''/null/undefined/false 的键会被删除，保持链接干净 */
  const setMany = useCallback((patch) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev)
      for (const [k, v] of Object.entries(patch)) {
        const name = key(k)
        if (v === null || v === undefined || v === '' || v === false) next.delete(name)
        else next.set(name, String(v))
      }
      return next
    }, { replace: true })
  }, [setParams, key])

  const set = useCallback((k, v) => setMany({ [k]: v }), [setMany])

  return { get, getNum, set, setMany, params }
}
