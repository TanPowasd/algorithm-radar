/** 可点击的系列图例（点击隐藏/显示该系列） */
export default function SeriesLegend({ seriesList, colorMap, visible, onToggle }) {
  return (
    <div className="series-legend">
      {seriesList.map((s) => (
        <span
          key={s}
          className={`series-chip ${visible && !visible.has(s) ? 'off' : ''}`}
          onClick={() => onToggle(s)}
        >
          <span className="dot" style={{ background: colorMap.get(s) || '#888' }} />
          {s}
        </span>
      ))}
    </div>
  )
}
