import { useCallback, useMemo, useState } from 'react'
import AppShell from './AppShell'
import { ShellContext } from '../shellContext'

/** Keep navigation mounted while lazy routes change; pages supply their own actions. */
export default function ShellLayout({ children }) {
  const [page, setPage] = useState(null)
  const register = useCallback((owner, props) => setPage({ owner, props }), [])
  const unregister = useCallback((owner) => setPage((current) => current?.owner === owner ? null : current), [])
  const context = useMemo(() => ({ register, unregister }), [register, unregister])
  return <ShellContext.Provider value={context}>
    <AppShell {...page?.props} />
    {children}
  </ShellContext.Provider>
}
