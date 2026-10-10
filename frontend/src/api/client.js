/** API 客户端：自动携带 CSRF 双提交头与 Cookie，错误统一 ApiError（中文消息直接展示） */

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

const responseCache = new Map()
const inFlight = new Map()
let cacheGeneration = 0

export function clearApiCache() {
  cacheGeneration++
  responseCache.clear()
  inFlight.clear()
}

export function invalidateIdentity() {
  clearApiCache()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('radar:identity-change'))
}

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)radar_csrf=([^;]+)/)
  return m ? m[1] : ''
}

async function request(path, { method = 'GET', body, signal, force = false } = {}) {
  const generation = cacheGeneration
  const previous = method === 'GET' && !force ? responseCache.get(path) : null
  const headers = {}
  if (previous?.etag) headers['If-None-Match'] = previous.etag
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrfToken()
  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new ApiError('无法连接服务器', 0)
  }
  if (res.status === 304 && previous) return previous.data
  let data = null
  try {
    data = await res.json()
  } catch {
    /* 下载类响应无 JSON */
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `请求失败（HTTP ${res.status}）`, res.status)
  }
  if (method !== 'GET' && ['/api/login', '/api/logout', '/api/setup', '/api/change-password'].includes(path)) invalidateIdentity()
  const etag = res.headers.get('ETag')
  if (method === 'GET' && etag && generation === cacheGeneration) {
    if (previous?.etag === etag) return previous.data
    responseCache.delete(path)
    responseCache.set(path, { etag, data })
    if (responseCache.size > 64) responseCache.delete(responseCache.keys().next().value)
  }
  return data
}

export function api(path, options = {}) {
  if ((options.method || 'GET') !== 'GET' || options.signal || options.force) return request(path, options)
  if (inFlight.has(path)) return inFlight.get(path)
  const task = request(path, options)
  inFlight.set(path, task)
  task.finally(() => { if (inFlight.get(path) === task) inFlight.delete(path) }).catch(() => {})
  return task
}

/** 触发浏览器下载（导出接口带 Content-Disposition） */
export function download(path) {
  const a = document.createElement('a')
  a.href = path
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
