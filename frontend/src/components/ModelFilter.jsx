import { useMemo, useState } from 'react'
import { useApp } from '../state'
import { seriesList } from '../aggregate'
import { vendorColorMap } from '../palette'

/**
 * 模型多选查看器：勾选某些模型后，全站视图只显示这些模型的成绩。
 *  - 按厂商分组显示（与配色同源），chip 前圆点 = 厂商色
 *  - 支持搜索、全选/反选/清空；「全部」= 不过滤
 *  - 选择保存在 localStorage（radar.focusModels），下次访问自动恢复
 */
export default function ModelFilter() {
  const { data, focusModels, toggleFocusModel, focusOnly, vendorOf, theme } = useApp()
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState(() => {
    try {
      const v = localStorage.getItem('radar.filter.collapsed')
      return v === null ? true : v === 'true'
    } catch {
      return true
    }
  })

  const toggleCollapse = () => {
    setCollapsed((v) => {
      const next = !v
      try { localStorage.setItem('radar.filter.collapsed', String(next)) } catch {}
      return next
    })
  }

  const approvedModels = useMemo(
    () => seriesList((data.records || []).filter((r) => r.status !== 'pending')),
    [data.records])
  const colors = useMemo(
    () => vendorColorMap(approvedModels, vendorOf, theme === 'dark'),
    [approvedModels, vendorOf, theme])

  // 只保留仍存在的模型（避免目录变动后残留无效选择）
  const validFocus = focusModels && focusModels.size > 0
    ? new Set([...focusModels].filter((m) => approvedModels.includes(m)))
    : focusModels
  const activeCount = focusModels?.size ?? 0

  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const map = new Map()
    for (const m of approvedModels) {
      const v = vendorOf(m)
      if (kw && !m.toLowerCase().includes(kw) && !v.toLowerCase().includes(kw)) continue
      if (!map.has(v)) map.set(v, [])
      map.get(v).push(m)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
  }, [approvedModels, vendorOf, q])

  if (approvedModels.length < 2 && !activeCount) return null

  const click = (m) => {
    if ((validFocus?.size ?? 0) === 0) focusOnly([m])
    else if (validFocus.has(m) && validFocus.size === 1) focusOnly([])
    else toggleFocusModel(m)
  }

  const pickGroup = (list) => focusOnly([...new Set([...(validFocus || []), ...list])])
  const invert = () => focusOnly(approvedModels.filter((m) => !validFocus?.has(m)))

  if (collapsed) {
    return (
      <div className="filter-compact-bar" id="model-filter">
        <span className="fc-tag">模型</span>
        <span className="fc-desc">
          {activeCount > 0
            ? `已选 ${activeCount} / ${approvedModels.length} 个`
            : `全部 ${approvedModels.length} 个`}
        </span>
        <div className="fc-actions">
          {activeCount > 0 && (
            <button className="btn small ghost" onClick={() => focusOnly([])}>
              查看全部
            </button>
          )}
          <button className="btn small ghost" onClick={toggleCollapse} aria-expanded="false">
            筛选模型 ▾
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="card filter-card" id="model-filter">
      <div className="card-head" style={{ marginBottom: 0 }}>
        <h2>查看模型</h2>
        <span className="hint">
          {activeCount > 0 ? `已选 ${activeCount} / ${approvedModels.length} 个模型，全站视图只看这些成绩` : `已选全部 ${approvedModels.length} 个模型`}
        </span>
        <div className="card-tools">
          <input
            id="model-filter-search"
            className="filter-search"
            aria-label="搜索模型或厂商"
            placeholder="搜索模型 / 厂商…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQ('') }}
          />
          {activeCount > 0 && <button className="btn small ghost" onClick={() => focusOnly([])}>查看全部</button>}
          <button className="btn small ghost" onClick={invert} title="反选">反选</button>
          <button className="btn small ghost" onClick={toggleCollapse} title="收起模型面板" aria-expanded="true">收起 ▴</button>
        </div>
      </div>
      <div className="filter-groups">
        <div className="filter-chips">
          <button className={`fchip ${activeCount === 0 ? 'on' : ''}`} aria-pressed={activeCount === 0} style={{ '--vc': 'var(--accent)' }} onClick={() => focusOnly([])} title="显示全部模型">
            全部
          </button>
          {groups.map(([vendor, list]) => (
            <button
              key={vendor}
              className="fchip"
              style={{ '--vc': colors.get(list[0]) || 'var(--muted)' }}
              onClick={() => pickGroup(list)}
              title={`加入该厂商 ${list.length} 个模型`}
            >
              {vendor}
            </button>
          ))}
        </div>
        {groups.map(([vendor, list]) => (
          <div className="filter-group" key={vendor}>
            <span className="gname">
              <span className="sw" style={{ background: colors.get(list[0]) || 'var(--muted)' }} />
              {vendor}
            </span>
            {list.map((m) => {
              const on = activeCount > 0 && validFocus.has(m)
              return (
                <button
                  key={m}
                  className={`fchip ${on ? 'on' : ''} ${q && !on ? 'dim' : ''}`}
                  aria-pressed={on}
                  style={{ '--vc': colors.get(m) || 'var(--muted)' }}
                  onClick={() => click(m)}
                  title={`${on ? '取消选择' : '选择该模型'} · 厂商 ${vendor}`}
                >
                  {m}
                </button>
              )
            })}
          </div>
        ))}
        {!groups.length && <div className="chain">没有匹配「{q}」的模型</div>}
      </div>
    </div>
  )
}
