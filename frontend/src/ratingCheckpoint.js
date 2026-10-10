import { RATING_VERSION } from './ratingVersion.js'

const DATABASE = 'k4u-public-rating'
const STORE = 'checkpoints'
const MAX_ENTRIES = 4
const MAX_BYTES = 4 * 1024 * 1024
const MAX_AGE = 7 * 24 * 60 * 60 * 1000
let databasePromise
const pendingWrites = new Map()

export function ratingCheckpointKey({ epoch = '0', scope = 'public', mode = 'bestLevel' }) {
  return JSON.stringify([RATING_VERSION, String(epoch), scope, mode])
}

function database() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  if (!databasePromise) {
    databasePromise = new Promise((resolve) => {
      const request = indexedDB.open(DATABASE, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' })
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => { databasePromise = null; resolve(null) }
      request.onblocked = () => resolve(null)
    })
  }
  return databasePromise
}

export async function loadRatingCheckpoint(request) {
  if (request.scope !== 'public' || !request.cachePublic) return null
  try {
    const db = await database()
    if (!db) return null
    return await new Promise((resolve) => {
      const query = db.transaction(STORE, 'readonly').objectStore(STORE).get(ratingCheckpointKey(request))
      query.onsuccess = () => {
        const entry = query.result
        resolve(entry && Date.now() - entry.savedAt <= MAX_AGE ? entry.checkpoint : null)
      }
      query.onerror = () => resolve(null)
    })
  } catch { return null }
}

/** Only compact public scores are persisted; account and filtered scopes are excluded. */
export async function saveRatingCheckpoint(request, checkpoint) {
  if (request.scope !== 'public' || !request.cachePublic || !checkpoint?.ready) return
  const key = ratingCheckpointKey(request)
  const savedAt = Date.now()
  const token = {}
  pendingWrites.set(key, token)
  try {
    if (JSON.stringify(checkpoint).length * 2 > MAX_BYTES) return
    const db = await database()
    if (!db || pendingWrites.get(key) !== token) return
    await new Promise((resolve) => {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      store.put({ key, savedAt, checkpoint })
      const all = store.getAll()
      all.onsuccess = () => {
        const entries = all.result.sort((a, b) => b.savedAt - a.savedAt)
        for (let i = 0; i < entries.length; i++) {
          if (i >= MAX_ENTRIES || savedAt - entries[i].savedAt > MAX_AGE) store.delete(entries[i].key)
        }
      }
      transaction.oncomplete = resolve
      transaction.onerror = resolve
      transaction.onabort = resolve
    })
  } catch { /* Storage denial and quota limits do not affect scoring. */ }
  finally { if (pendingWrites.get(key) === token) pendingWrites.delete(key) }
}
