// Durable, encrypted-at-rest cache of exact organisation-scoped read queries.
// The cache stores only results the Hub has successfully read from Firestore;
// it is never populated from a client-supplied record payload.
import { createHash } from 'node:crypto'

const MAX_ENTRIES = 750
const MAX_ENTRY_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_BYTES = 128 * 1024 * 1024

function cacheId(query) {
  return createHash('sha256').update(JSON.stringify(query)).digest('hex')
}

export function createOfflineQueryCache({ loadIndex = async () => [], saveIndex = async () => {},
  loadEntry = null, saveEntry = null, removeEntry = null,
  log = console, clock = Date.now } = {}) {
  const entries = new Map()
  const volatile = new Map()
  const loadRow = loadEntry || (async (id) => volatile.get(id) || null)
  const saveRow = saveEntry || (async (id, value) => volatile.set(id, value))
  const removeRow = removeEntry || (async (id) => volatile.delete(id))
  let ready = false
  let writeChain = Promise.resolve()

  async function initialize() {
    let index
    try { index = await loadIndex() }
    catch (error) {
      log.error('[hub] offline query index could not be read:', error?.message || error)
      throw new Error('Offline query cache is unavailable; refusing to start its read service.')
    }
    if (!Array.isArray(index)) throw new Error('Offline query index is malformed.')
    for (const row of index) {
      if (/^[a-f0-9]{64}$/.test(String(row?.id || '')) && Number.isFinite(row.at)) {
        entries.set(row.id, { at: row.at, size: Math.max(0, Number(row.size) || 0) })
      }
    }
    ready = true
  }

  function persistIndex() {
    const value = JSON.stringify([...entries].map(([id, row]) => ({ id, at: row.at, size: row.size })))
    writeChain = writeChain.catch(() => {}).then(() => saveIndex(value))
    return writeChain
  }

  async function get(query) {
    if (!ready) return null
    const id = cacheId(query)
    if (!entries.has(id)) return null
    let raw
    try { raw = await loadRow(id) }
    catch (error) {
      log.warn('[hub] encrypted offline query entry could not be read:', id.slice(0, 10), error?.message || error)
      return null
    }
    if (!raw) { entries.delete(id); await persistIndex(); return null }
    try {
      const row = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (row?.id !== id || !Array.isArray(row.docs)) throw new Error('invalid cached query row')
      entries.set(id, { at: clock(), size: Buffer.byteLength(typeof raw === 'string' ? raw : JSON.stringify(raw)) })
      await persistIndex()
      return row
    } catch (error) {
      log.warn('[hub] invalid offline query entry ignored:', id.slice(0, 10), error?.message || error)
      return null
    }
  }

  async function set(query, docs) {
    if (!ready) throw new Error('Offline query cache is not ready.')
    const id = cacheId(query)
    const row = { id, orgId: query.orgId, collection: query.collection, docs, savedAt: clock() }
    const raw = JSON.stringify(row)
    if (Buffer.byteLength(raw) > MAX_ENTRY_BYTES) {
      throw Object.assign(new Error('Query is too large to keep in the Host offline cache.'), { code: 'offline/cache-too-large' })
    }
    await saveRow(id, raw)
    entries.set(id, { at: clock(), size: Buffer.byteLength(raw) })
    let totalBytes = [...entries.values()].reduce((sum, item) => sum + item.size, 0)
    for (const [oldId, item] of [...entries].sort((a, b) => a[1].at - b[1].at)) {
      if (entries.size <= MAX_ENTRIES && totalBytes <= MAX_TOTAL_BYTES) break
      entries.delete(oldId)
      totalBytes -= item.size
      await removeRow(oldId).catch((error) => log.warn('[hub] old offline query entry could not be pruned:', error?.message || error))
    }
    await persistIndex()
    return row
  }

  return { initialize, get, set, status: () => ({ ready, queries: entries.size,
    bytes: [...entries.values()].reduce((sum, item) => sum + item.size, 0) }) }
}
