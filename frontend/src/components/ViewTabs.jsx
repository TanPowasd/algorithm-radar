/** 标准标签页：方向键 / Home / End 切换，选中项由底线标识。 */
export default function ViewTabs({ tabs, active, onChange }) {
  const onKeyDown = (event, index) => {
    let next
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = tabs.length - 1
    else return
    event.preventDefault()
    onChange(tabs[next].key)
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next]?.focus()
  }

  return (
    <nav className="view-tabs" role="tablist" aria-label="分析视图">
      {tabs.map((t, index) => (
        <button
          type="button"
          key={t.key}
          id={`view-tab-${t.key}`}
          role="tab"
          aria-selected={active === t.key}
          aria-controls="analysis-panel"
          tabIndex={active === t.key ? 0 : -1}
          className={`view-tab ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          <span className="view-index" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
          {t.label}
        </button>
      ))}
    </nav>
  )
}
