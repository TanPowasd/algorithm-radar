import { useLayoutEffect, useRef } from 'react'
import { useApp } from '../state'

/** Animate content without remounting controls, losing focus, or resetting scroll. */
export default function MotionRegion({ as: Element = 'div', motionKey, className = '', children, ...props }) {
  const ref = useRef(null)
  const { uiPreferences } = useApp()
  const motion = uiPreferences?.motion
  useLayoutEffect(() => {
    if (motion === 'off' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const animation = ref.current?.animate?.([
      { opacity: 0, transform: 'translateY(8px)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 220, easing: 'cubic-bezier(.22, 1, .36, 1)' })
    return () => animation?.cancel()
  }, [motionKey, motion])
  return <Element {...props} ref={ref} className={'motion-region ' + className}>{children}</Element>
}
