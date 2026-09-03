import { useEffect, useRef, useState } from 'react'
import { copyText } from '../hooks/copyText'

/**
 * 一键复制按钮（提示词等长文本统一入口）。
 * 复制成功后按钮自身反馈 1.6s，同时抛 toast。
 */
export default function CopyButton({
  text, label = '一键复制', okLabel = '已复制', toast, size = 'small', kind = '', title, stop = true,
}) {
  const [done, setDone] = useState(false)
  const timer = useRef(null)
  useEffect(() => () => clearTimeout(timer.current), [])

  const click = async (e) => {
    if (stop) e.stopPropagation()
    const ok = await copyText(text)
    if (ok) {
      setDone(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setDone(false), 1600)
      toast?.('已复制到剪贴板')
    } else {
      toast?.('复制失败，请手动选择文本', 'err')
    }
  }

  if (!text) return null
  return (
    <button
      type="button"
      className={`btn copy-btn ${size === 'small' ? 'small' : ''} ${done ? 'copied' : ''} ${kind}`}
      onClick={click}
      title={title || '复制到剪贴板'}
    >
      {done ? '✓' : '⧉'} {done ? okLabel : label}
    </button>
  )
}
