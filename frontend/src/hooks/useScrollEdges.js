import { useCallback, useEffect, useState } from 'react'

/**
 * 跟踪横向滚动容器两侧是否还有隐藏内容，用来显示边缘渐隐提示。
 * 返回 [callbackRef, { left, right }]；容器挂载/卸载、尺寸变化与滚动时都会刷新。
 */
export function useScrollEdges() {
  const [node, setNode] = useState(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const ref = useCallback((el) => setNode(el), [])
  useEffect(() => {
    if (!node) { setEdges({ left: false, right: false }); return undefined }
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const max = node.scrollWidth - node.clientWidth
        const next = { left: node.scrollLeft > 2, right: max - node.scrollLeft > 2 }
        setEdges((prev) => (prev.left === next.left && prev.right === next.right ? prev : next))
      })
    }
    measure()
    node.addEventListener('scroll', measure, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    if (node.firstElementChild) observer?.observe(node.firstElementChild)
    return () => { cancelAnimationFrame(frame); node.removeEventListener('scroll', measure); observer?.disconnect() }
  }, [node])
  return [ref, edges]
}
