import { useEffect, useRef, useState } from 'react'

/**
 * 放在横向滚动容器上方的同步滚动条：宽表格不用滚到页面底部才能横移。
 * target 为被同步的滚动容器（DOM 节点）；双向同步 scrollLeft，尺寸变化时更新轨道宽度。
 */
export default function TopScrollbar({ target, label = '横向滚动' }) {
  const barRef = useRef(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const bar = barRef.current
    if (!bar || !target) return undefined
    let syncing = null
    const measure = () => setWidth(target.scrollWidth)
    const fromTarget = () => { if (syncing === 'bar') { syncing = null; return } syncing = 'target'; bar.scrollLeft = target.scrollLeft }
    const fromBar = () => { if (syncing === 'target') { syncing = null; return } syncing = 'bar'; target.scrollLeft = bar.scrollLeft }
    measure(); bar.scrollLeft = target.scrollLeft
    target.addEventListener('scroll', fromTarget, { passive: true })
    bar.addEventListener('scroll', fromBar, { passive: true })
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(target)
    if (target.firstElementChild) observer?.observe(target.firstElementChild)
    return () => { target.removeEventListener('scroll', fromTarget); bar.removeEventListener('scroll', fromBar); observer?.disconnect() }
  }, [target])
  return <div className="top-scrollbar" ref={barRef} aria-label={label} tabIndex={-1}><div style={{ width }} /></div>
}
