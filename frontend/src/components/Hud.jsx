import { useEffect, useState } from 'react'

/**
 * 参考视觉里的 HUD：固定读数条。
 *  运行读数收纳在设置菜单中，不占用首屏数据空间。
 *  SAMPLES= 当前口径下的记录数（父组件传入）
 *  FPS    = 实测帧率（rAF 采样，1s 刷新一次）
 */
export default function Hud({ samples = 0, models = 0, view = '' }) {
  const [fps, setFps] = useState(60)

  useEffect(() => {
    let raf = 0
    let frames = 0
    let last = performance.now()
    const tick = (now) => {
      frames += 1
      if (now - last >= 1000) {
        setFps(Math.round((frames * 1000) / (now - last)))
        frames = 0
        last = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="hud" aria-label="运行状态">
      <span className="hud-cell">VIEW<b>{(view || '—').toUpperCase()}</b></span>
      <span className="hud-cell alt">SAMPLES<b>{samples}</b></span>
      <span className="hud-cell">MODELS<b>{models}</b></span>
      <span className={`hud-cell ${fps < 30 ? 'warn' : ''}`}>FPS<b>{fps}</b></span>
    </div>
  )
}
