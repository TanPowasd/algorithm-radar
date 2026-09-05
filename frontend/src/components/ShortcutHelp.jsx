import { useEffect, useState } from 'react'
import { useApp } from '../state'
import { copyText } from '../hooks/copyText'

/**
 * 右下角交互提示面板：列出全站快捷键，并带「复制当前链接」快捷（分享视图状态）。
 * 按 ? 或点击按钮开关。
 */
const KEYS = [
  { k: '1 – 5', d: '切换视图（矩阵 / 雷达 / 柱状 / 榜单 / 滚榜）' },
  { k: 'T', d: '循环主题：夜间 → 日间 → 跟随系统' },
  { k: 'W', d: '切换版心：全宽铺满 ⇄ 限宽居中' },
  { k: 'F', d: '聚焦明细搜索框' },
  { k: 'R', d: '重新拉取数据' },
  { k: '← →', d: '滚榜：单步回退 / 前进' },
  { k: '空格', d: '滚榜：播放 / 暂停' },
  { k: 'J', d: '滚榜：跳到下一个 AC' },
  { k: 'D', d: '滚榜：按测评日期批量推进' },
  { k: 'Esc', d: '关闭抽屉、弹窗与全屏' },
  { k: '?', d: '展开 / 收起本面板' },
]

export default function ShortcutHelp({ extra }) {
  const { toast } = useApp()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e) => {
      const t = e.target
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
      if (e.key === '?' && !typing) { setOpen((v) => !v); return }
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const copyLink = async () => {
    const ok = await copyText(window.location.href)
    toast(ok ? '当前视图链接已复制（含筛选与口径）' : '复制失败', ok ? 'ok' : 'err')
  }

  return (
    <>
      <button className="shortcut-btn" onClick={() => setOpen((v) => !v)} title="交互快捷键（?）" aria-label="快捷键说明">
        ?
      </button>
      {open && (
        <div className="shortcut-panel" role="dialog" aria-label="快捷键">
          <h4>
            操作面板
            <span className="close" onClick={() => setOpen(false)} role="button" tabIndex={0}>✕</span>
          </h4>
          <div className="shortcut-list">
            {KEYS.map((row) => (
              <div className="row" key={row.k}>
                <kbd>{row.k}</kbd>
                <span>{row.d}</span>
              </div>
            ))}
            {extra?.map((row) => (
              <div className="row" key={row.k}>
                <kbd>{row.k}</kbd>
                <span>{row.d}</span>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
            <button className="btn small ghost" onClick={copyLink}>⧉ 复制当前视图链接</button>
          </div>
        </div>
      )}
    </>
  )
}
