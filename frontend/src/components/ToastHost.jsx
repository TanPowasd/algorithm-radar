import { useApp } from '../state'

export default function ToastHost() {
  const { toasts } = useApp()
  if (!toasts.length) return null
  return (
    <>
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </>
  )
}
