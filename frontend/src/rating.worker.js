import { IncrementalRatingEngine, RatingCancelled } from './ratingEngine.js'

const engines = new Map()
const latest = new Map()
const MAX_ENGINES = 2

function engineFor(request, checkpoint) {
  const key = JSON.stringify([request.epoch ?? '0', request.scope ?? 'public', request.mode ?? 'bestLevel'])
  let entry = engines.get(key)
  if (!entry) {
    let engine = new IncrementalRatingEngine({ mode: request.mode })
    if (checkpoint && !engine.restore(checkpoint)) engine = new IncrementalRatingEngine({ mode: request.mode })
    entry = { engine, tail: Promise.resolve() }
  }
  engines.delete(key)
  engines.set(key, entry)
  while (engines.size > MAX_ENGINES) engines.delete(engines.keys().next().value)
  return entry
}

self.onmessage = ({ data }) => {
  const { id, channel, type } = data
  if (type === 'cancel') {
    if (latest.get(channel) === id) latest.delete(channel)
    return
  }
  if (type !== 'calculate') return
  latest.set(channel, id)
  const entry = engineFor(data.request, data.checkpoint)
  const cancelled = () => latest.get(channel) !== id
  entry.tail = entry.tail.catch(() => {}).then(async () => {
    if (cancelled()) return
    try {
      await entry.engine.calculate(data.request.records || [], data.request.problems || {}, {
        cancelled,
        emit(event) {
          if (cancelled()) return
          self.postMessage({ id, channel, ...event, ratings: [...event.ratings] })
        },
      })
      if (!cancelled() && data.request.cachePublic && data.request.scope === 'public') {
        self.postMessage({ id, channel, kind: 'checkpoint', checkpoint: entry.engine.checkpoint() })
      }
    } catch (error) {
      if (!(error instanceof RatingCancelled) && !cancelled()) {
        self.postMessage({ id, channel, kind: 'error', error: error.message || String(error) })
      }
    }
  })
}
