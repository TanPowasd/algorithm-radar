/** 可点击的系列图例（点击隐藏/显示该系列）；传入 vendorOf 时按厂商分组展示 */
export default function SeriesLegend({ seriesList, colorMap, visible, onToggle, vendorOf }) {
  if (!vendorOf) {
    return (
      <div className="series-legend">
        {seriesList.map((s) => (
          <button type="button" key={s} aria-pressed={!visible || visible.has(s)} className={`series-chip ${visible && !visible.has(s) ? 'off' : ''}`} onClick={() => onToggle(s)}>
            <span className="dot" style={{ background: colorMap.get(s) || '#888' }} />
            {s}
          </button>
        ))}
      </div>
    )
  }
  const groups = new Map()
  for (const s of seriesList) {
    const v = vendorOf(s)
    if (!groups.has(v)) groups.set(v, [])
    groups.get(v).push(s)
  }
  const ordered = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-Hans-CN'))
  return (
    <div className="series-legend">
      {ordered.map(([vendor, list]) => (
        <span className="legend-vendor" key={vendor} style={{ padding: '3px 8px' }}>
          <span className="sw" style={{ background: colorMap.get(list[0]) || '#888' }} />
          <b>{vendor}</b>
          {list.map((s) => (
            <button
              type="button"
              aria-pressed={!visible || visible.has(s)}
              key={s}
              className={`series-chip ${visible && !visible.has(s) ? 'off' : ''}`}
              onClick={() => onToggle(s)}
              title={`${s} · 厂商 ${vendor}（点击${visible && !visible.has(s) ? '显示' : '隐藏'}）`}
            >
              <span className="dot" style={{ background: colorMap.get(s) || '#888' }} />
              {s}
            </button>
          ))}
        </span>
      ))}
    </div>
  )
}
