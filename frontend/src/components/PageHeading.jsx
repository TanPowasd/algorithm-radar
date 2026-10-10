export default function PageHeading({ title, description, eyebrow, children }) {
  return <header className="page-heading">
    <div className="page-heading-copy">
      {eyebrow && <span className="eyebrow">{eyebrow}</span>}
      <h1 tabIndex={-1}>{title}</h1>
      {description && <p>{description}</p>}
    </div>
    {children && <div className="page-heading-actions">{children}</div>}
  </header>
}
