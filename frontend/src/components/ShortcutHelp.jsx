import { useEffect, useState } from 'react'
import { useApp } from '../state'
import { copyText } from '../hooks/copyText'
import { CircleHelp, Copy, X } from 'lucide-react'

/**
 * 右下角交互提示面板：列出全站快捷键，并带「复制当前链接」快捷（分享视图状态）。
 * 按 ? 或点击按钮开关。
 */
const KEYS = [
  { k: '1 – 4', d: 'AI 分数 / rating / 测评明细 / 比赛' },
  { k: 'T', d: '切换亮色 / 暗色（自动记住选择）' },
  { k: 'W', d: '切换版心：全宽铺满 ⇄ 限宽居中' },
  { k: 'F', d: '聚焦明细搜索框' },
  { k: 'R', d: '重新拉取数据' },
  { k: 'Esc', d: '关闭抽屉、弹窗与全屏' },
  { k: '?', d: '展开 / 收起本面板' },
]

export default function ShortcutHelp({ extra }) {
  const { toast } = useApp()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onKey = (e) => {
      if (document.querySelector('[aria-modal="true"]')) return
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
        <CircleHelp size={18} aria-hidden="true" />
      </button>
      {open && (
        <div className="shortcut-panel" role="dialog" aria-label="快捷键">
          <h4>
            操作面板
            <button className="icon-btn close" onClick={() => setOpen(false)} aria-label="关闭快捷键说明"><X size={16} /></button>
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
            <button className="btn small ghost" onClick={copyLink}><Copy size={15} />复制当前视图链接</button>
          </div>
        </div>
      )}
    </>
  )
}
