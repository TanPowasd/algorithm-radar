/** 可点击的系列图例（点击隐藏/显示该系列；支持悬停单模高亮、双击单独查看）；传入 vendorOf 时按厂商分组展示 */
export default function SeriesLegend({
  seriesList,
  colorMap,
  visible,
  onToggle,
  vendorOf,
  hoveredSeries,
  onHover,
  onSelectAll,
  onClear,
  onSelectTop,
  onSolo,
}) {
  const allSelected = !visible || seriesList.every((s) => visible.has(s))
  const noneSelected = visible && visible.size === 0

  const toolbar = (
    <div className="legend-toolbar">
      <span style={{ fontWeight: 600, color: 'var(--text)' }}>对比模型：</span>
      <button
        type="button"
        className="btn tiny ghost"
        onClick={onSelectAll}
        disabled={allSelected}
        title="显示全部模型"
      >
        全选
      </button>
      <button
        type="button"
        className="btn tiny ghost"
        onClick={onClear}
        disabled={noneSelected}
        title="清空全部模型"
      >
        清空
      </button>
      {seriesList.length > 4 && (
        <button
          type="button"
          className="btn tiny ghost"
          onClick={() => onSelectTop?.(5)}
          title="仅保留前 5 个模型"
        >
          仅前 5
        </button>
      )}
      <span className="hint-text">（单击切换，双击单看，鼠标悬浮高亮）</span>
    </div>
  )

  if (!vendorOf) {
    return (
      <div>
        {toolbar}
        <div className="series-legend">
          {seriesList.map((s) => (
            <button
              type="button"
              key={s}
              aria-pressed={!visible || visible.has(s)}
              className={`series-chip ${visible && !visible.has(s) ? 'off' : ''} ${hoveredSeries === s ? 'active-hover' : ''}`}
              onClick={() => onToggle(s)}
              onDoubleClick={() => onSolo?.(s)}
              onMouseEnter={() => onHover?.(s)}
              onMouseLeave={() => onHover?.(null)}
              title={`${s}（单击切换显示，双击单独查看，悬浮高亮多边形）`}
            >
              <span className="dot" style={{ background: colorMap.get(s) || '#888' }} />
              {s}
            </button>
          ))}
        </div>
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
    <div>
      {toolbar}
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
                className={`series-chip ${visible && !visible.has(s) ? 'off' : ''} ${hoveredSeries === s ? 'active-hover' : ''}`}
                onClick={() => onToggle(s)}
                onDoubleClick={() => onSolo?.(s)}
                onMouseEnter={() => onHover?.(s)}
                onMouseLeave={() => onHover?.(null)}
                title={`${s} · 厂商 ${vendor}（单击切换显示，双击单独查看，悬浮高亮多边形）`}
              >
                <span className="dot" style={{ background: colorMap.get(s) || '#888' }} />
                {s}
              </button>
            ))}
          </span>
        ))}
      </div>
    </div>
  )
}
