import { useEffect, useRef } from 'react'

/**
 * 全局快捷键。
 *  - 输入框/文本域/select 内的按键一律不劫持；
 *  - 带 Ctrl/Cmd/Alt 的组合一律不劫持（不抢浏览器快捷键）；
 *  - keymap: { key: handler }，key 用 e.key 原样（'1' 't' '?' 'Escape' ' ' 等），
 *    另有 '__any' 兜底钩子（供滚榜等场景自行判断）。
 */
export function useHotkeys(keymap, deps = []) {
  const ref = useRef(keymap)
  ref.current = keymap

  useEffect(() => {
    const onKey = (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]')) return
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        // 输入态只放行 Escape（由组件自己处理）
        if (e.key !== 'Escape') return
      }
      const map = ref.current || {}
      const fn = map[e.key] || map[e.key.toLowerCase?.()]
      if (!fn) return
      e.preventDefault()
      fn(e)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
