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
    if (sessionStorage.getItem(SS_DISMISS_SESSION)) return true
    return localStorage.getItem(LS_DISMISS_DAY) === todayStr()
  })
  if (dismissed) return null
  const dismissDay = () => {
    localStorage.setItem(LS_DISMISS_DAY, todayStr())
    setDismissed(true)
  }
  const dismissSession = () => {
    sessionStorage.setItem(SS_DISMISS_SESSION, '1')
    setDismissed(true)
  }
  return (
    <div className="notice">
      <div className="n-body">
        <span className="n-title">公告</span>
        欢迎来到 AI vs 洛谷！本站按「收录制」展示：只有题目与模型均被管理员收录的测评数据才计入统计；
        历史数据统一署名「全民制作人」，收录对应题目/模型后自动显示。提交测评请选择<strong>已发布题目</strong>与<strong>已收录模型</strong>，
        并如实填写 Agent 与 Token 来源（官方 API/套餐填「官方」）；游客可浏览全部榜单并下载数据。
      </div>
      <div className="n-actions">
        <button className="btn small ghost" onClick={dismissSession}>本次关闭</button>
        <button className="btn small ghost" onClick={dismissDay}>今天关闭</button>
      </div>
    </div>
  )
}
