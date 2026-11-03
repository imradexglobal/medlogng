// Offline-tolerant Firestore reads.
//
// Plain getDocs/getDoc always try the network first, and with no server
// reachable they hang until the browser's DNS/connect timeout — which made
// every boot screen sit on "Loading…" for tens of seconds while offline.
//
// These wrappers:
//  - go straight to the local cache when the device reports offline;
//  - when online, race the network against a short timeout and fall back to
//    the cache so a dead connection cannot stall the UI;
//  - after the timeout, use cached results (including an empty query result)
//    or surface the read error instead of leaving screens waiting forever.
import {
  getDocs, getDocsFromCache, getDoc, getDocFromCache, getCountFromServer,
} from '../firebase.js'

const DEFAULT_TIMEOUT_MS = 5500

export function isOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(Object.assign(new Error('offline read timed out'), { code: 'offline/timeout' }))
    }, ms)
    promise.then(
      (v) => { clearTimeout(t); resolve(v) },
      (e) => { clearTimeout(t); reject(e) },
    )
  })
}

// getDocs() that serves the IndexedDB cache when the network is gone or slow.
export async function getDocsTolerant(q, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  // getDocs is the shared Firestore adapter: it first asks the hospital Host
  // for an authorized cached query, then falls back to this device's cache.
  if (isOffline()) return await getDocs(q)
  const pending = getDocs(q)
  try {
    return await withTimeout(pending, timeoutMs)
  } catch (e) {
    if (e?.code === 'offline/timeout') {
      const cached = await withTimeout(getDocsFromCache(q), timeoutMs).catch(() => null)
      // A valid empty cached query is still useful offline. Waiting for the
      // network after the timeout leaves screens stuck when a LAN is up but
      // the internet is down.
      if (cached) return cached
    }
    throw e
  }
}

// getDoc() with the same offline behaviour as getDocsTolerant().
export async function getDocTolerant(ref, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (isOffline()) return await getDoc(ref)
  const pending = getDoc(ref)
  try {
    return await withTimeout(pending, timeoutMs)
  } catch (e) {
    if (e?.code === 'offline/timeout') {
      const cached = await withTimeout(getDocFromCache(ref), timeoutMs).catch(() => null)
      if (cached && cached.exists()) return cached
    }
    throw e
  }
}

// getCountFromServer() is a server-only aggregation and can never be served
// from cache. Offline (or once the short timeout fires) count the cached docs
// instead; if even that yields nothing, return null so the stat card shows
// "—" rather than hanging the whole dashboard load.
export async function withServerCount(q, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isOffline()) {
    try {
      const snap = await withTimeout(getCountFromServer(q), timeoutMs)
      return snap.data().count
    } catch { /* fall through to cache */ }
  }
  try {
    const snap = await withTimeout(getDocsFromCache(q), timeoutMs)
    return snap.size
  } catch {
    return null
  }
}
