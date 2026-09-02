/** API 客户端：自动携带 CSRF 双提交头与 Cookie，错误统一 ApiError（中文消息直接展示） */

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

function csrfToken() {
  const m = document.cookie.match(/(?:^|;\s*)radar_csrf=([^;]+)/)
  return m ? m[1] : ''
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && method !== 'HEAD') headers['X-CSRF-Token'] = csrfToken()
  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new ApiError('无法连接服务器', 0)
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    /* 下载类响应无 JSON */
  }
  if (!res.ok) {
    throw new ApiError((data && data.error) || `请求失败（HTTP ${res.status}）`, res.status)
  }
  return data
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
