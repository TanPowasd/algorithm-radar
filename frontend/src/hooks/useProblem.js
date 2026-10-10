import { useCallback, useEffect, useState } from 'react'
import { useApp } from '../state'

export function useProblem(pid, initial) {
  const { data, getProblem } = useApp()
  const base = initial || data.problems?.[pid]
  const needsDetail = Boolean(base?.hasContent && typeof base.content !== 'string')
  const [result, setResult] = useState(null)
  const [failure, setFailure] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const retry = useCallback(() => setAttempt((value) => value + 1), [])
  const key = `${data.epoch}:${data.revision}:${data.scope}:${pid}`
  useEffect(() => {
    let active = true
    if (needsDetail && getProblem) getProblem(pid).then((problem) => {
      if (active) setResult({ key, attempt, problem })
    }).catch((err) => { if (active) setFailure({ key, attempt, message: err.message }) })
    return () => { active = false }
  }, [pid, key, attempt, needsDetail, getProblem])
  const detail = needsDetail && result?.key === key && result.attempt === attempt ? result.problem : null
  const error = failure?.key === key && failure.attempt === attempt ? failure.message : ''
  return { problem: detail || base, loading: needsDetail && !detail && !error, error, retry }
}
