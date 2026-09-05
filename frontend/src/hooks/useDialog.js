import { useEffect, useRef } from 'react'

/** 弹层独占键盘与滚动；关闭后把焦点交回打开它的控件。 */
export function useDialog(onClose) {
  const ref = useRef(null)
  const closeRef = useRef(onClose)
  useEffect(() => { closeRef.current = onClose }, [onClose])
  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return undefined
    const previous = document.activeElement
    const wasLocked = document.body.classList.contains('modal-open')
    document.body.classList.add('modal-open')
    const focusables = () => [...dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')]
      .filter((el) => !el.disabled && el.tabIndex >= 0 && el.getClientRects().length)
    ;(focusables()[0] || dialog).focus()
    const onKey = (event) => {
      // 捕获阶段隔离背后的快捷键，防止在表单内按 1 / T 切换页面。
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current?.()
      } else if (event.key === 'Tab') {
        const items = focusables()
        const first = items[0]
        const last = items.at(-1)
        if (!first) { event.preventDefault(); dialog.focus() }
        else if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
          event.preventDefault(); last.focus()
        } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
          event.preventDefault(); first.focus()
        }
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      if (!wasLocked) document.body.classList.remove('modal-open')
      if (previous?.isConnected) previous.focus?.()
    }
  }, [])
  return ref
}
