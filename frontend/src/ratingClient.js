import { loadRatingCheckpoint, saveRatingCheckpoint } from './ratingCheckpoint.js'

let singleton
let sequence = 0

export function createRatingClient(worker) {
  const listeners = new Map()
  let failed = false
  worker.onmessage = ({ data }) => {
    const listener = listeners.get(data.id)
    if (!listener) return
    if (data.kind === 'checkpoint') {
      void saveRatingCheckpoint(listener.request, data.checkpoint)
      listeners.delete(data.id)
      return
    }
    listener.emit({ ...data, ratings: new Map(data.ratings || []) })
    if (data.kind === 'error' || data.kind === 'ready' && !(listener.request.cachePublic && listener.request.scope === 'public')) listeners.delete(data.id)
  }
  worker.onerror = () => {
    failed = true
    for (const listener of listeners.values()) listener.emit({ kind: 'error', error: 'Rating worker could not complete the calculation' })
    listeners.clear()
    worker.terminate()
  }
  worker.onmessageerror = worker.onerror
  return {
    get failed() { return failed },
    calculate(request, emit, channel) {
      const id = ++sequence
      let active = true
      listeners.set(id, { request, emit })
      loadRatingCheckpoint(request).then((checkpoint) => {
        if (!active || failed) return
        try { worker.postMessage({ type: 'calculate', id, channel, request, checkpoint }) }
        catch (error) {
          listeners.delete(id)
          emit({ kind: 'error', error: error.message || String(error) })
        }
      })
      return () => {
        active = false
        listeners.delete(id)
        if (!failed) worker.postMessage({ type: 'cancel', id, channel })
      }
    },
    dispose() { failed = true; listeners.clear(); worker.terminate() },
  }
}

export function getRatingClient() {
  if (!singleton || singleton.failed) {
    if (typeof Worker === 'undefined') throw new Error('This browser does not support background rating calculations')
    singleton = createRatingClient(new Worker(new URL('./rating.worker.js', import.meta.url), { type: 'module' }))
  }
  return singleton
}
