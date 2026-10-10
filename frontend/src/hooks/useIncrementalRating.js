import { useCallback, useEffect, useId, useState } from 'react'
import { getRatingClient } from '../ratingClient.js'

const empty = () => ({ ratings: new Map(), status: 'idle', error: null, diagnostics: {} })

export function useIncrementalRating({
  records, problems, epoch = '0', scope = 'public', mode = 'bestLevel', enabled = true, cachePublic = false,
}) {
  const [state, setState] = useState(empty)
  const [attempt, setAttempt] = useState(0)
  const channel = useId()
  const key = JSON.stringify([epoch, scope, mode])
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  useEffect(() => {
    if (!enabled) return undefined
    let active = true
    let cancel
    const request = { records, problems, key, attempt }
    Promise.resolve().then(() => {
      if (!active) return
      cancel = getRatingClient().calculate({ records, problems, epoch, scope, mode, cachePublic }, (event) => {
        if (!active) return
        if (event.kind === 'error') {
          setState((previous) => ({
            ...(previous.request?.key === key ? previous : empty()), request, status: 'error', error: event.error,
          }))
        } else if (event.kind === 'point' || event.kind === 'ready') {
          setState({
            ratings: event.ratings, status: event.kind === 'point' ? 'intervals' : 'ready',
            error: null, diagnostics: event.diagnostics || {}, request,
          })
        }
      }, channel)
    }).catch((error) => {
      if (active) setState((previous) => ({
        ...(previous.request?.key === key ? previous : empty()), request,
        status: 'error', error: error.message || String(error),
      }))
    })
    return () => { active = false; cancel?.() }
  }, [records, problems, epoch, scope, mode, enabled, cachePublic, attempt, channel, key])
  const current = state.request?.key === key && state.request.records === records
    && state.request.problems === problems && state.request.attempt === attempt
  const visible = !enabled ? empty() : current ? state : {
    ...(state.request?.key === key ? state : empty()), status: 'computing', error: null,
  }
  return { ratings: visible.ratings, status: visible.status, error: visible.error, diagnostics: visible.diagnostics, retry }
}

export default useIncrementalRating
