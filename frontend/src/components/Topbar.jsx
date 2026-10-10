import { useContext, useLayoutEffect, useRef } from 'react'
import AppShell from './AppShell'
import { ShellContext } from '../shellContext'

export default function Topbar(props) {
  const shell = useContext(ShellContext)
  const owner = useRef(Symbol('page-shell'))
  useLayoutEffect(() => {
    if (!shell) return
    const token = owner.current
    shell.register(token, props)
    return () => shell.unregister(token)
  }, [shell, props])
  // Standalone page renders (including component selftests) retain a local shell.
  return shell ? null : <AppShell {...props} />
}
