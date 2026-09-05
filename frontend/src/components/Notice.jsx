import { useState } from 'react'

const LS_DISMISS_DAY = 'radar.notice.dismissedDay'
const SS_DISMISS_SESSION = 'radar.notice.dismissedSession'

function todayStr() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function Notice() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      if (sessionStorage.getItem(SS_DISMISS_SESSION)) return true
      return localStorage.getItem(LS_DISMISS_DAY) === todayStr()
    } catch { return false }
  })
  if (dismissed) return null
  const dismissDay = () => {
    try { localStorage.setItem(LS_DISMISS_DAY, todayStr()) } catch { /* 仍可在本次关闭 */ }
    setDismissed(true)
  }
  return (
    <div className="notice">
      <div className="n-body">
        <details>
          <summary><span className="n-title">数据说明</span>仅展示已收录、已审核的测评；游客可自由浏览与下载。</summary>
          <p>题目与模型均被管理员收录后，已审核记录才计入统计。历史数据统一署名「全民制作人」，
            收录对应题目与模型后自动显示。提交测评请选择<strong>已发布题目</strong>与<strong>已收录模型</strong>，
            并如实填写 Agent 与 Token 来源（官方 API / 套餐填「官方」）。</p>
        </details>
      </div>
      <div className="n-actions">
        <button className="btn small ghost" onClick={dismissDay} title="今日不再提示" aria-label="今日关闭数据说明">关闭 ×</button>
      </div>
    </div>
  )
}
