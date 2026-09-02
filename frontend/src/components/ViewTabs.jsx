import { useLayoutEffect, useRef, useState } from 'react'

/** 滑动 pill 选项卡：pill 位置用 CSSOM 测量定位（与旧站一致） */
export default function ViewTabs({ tabs, active, onChange }) {
  const wrapRef = useRef(null)
  const [pill, setPill] = useState({ left: 0, width: 0 })

  useLayoutEffect(() => {
    const measure = () => {
      const wrap = wrapRef.current
      if (!wrap) return
      const el = wrap.querySelector(`[data-tab="${active}"]`)
      if (!el) return
      setPill({ left: el.offsetLeft, width: el.offsetWidth })
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [active, tabs])

  return (
    <nav className="view-tabs" ref={wrapRef}>
      <span className="view-tab-pill" style={{ transform: `translateX(${pill.left}px)`, width: pill.width }} />
      {tabs.map((t) => (
        <button
          key={t.key}
          data-tab={t.key}
          className={`view-tab ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </nav>
  )
}
