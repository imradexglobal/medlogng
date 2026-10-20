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
//  - if the timeout fires but the cache is empty, keep waiting for the
//    original request (it may still succeed) instead of returning nothing.
import {
  getDocs, getDocsFromCache, getDoc, getDocFromCache, getCountFromServer,
} from '../firebase.js'

const DEFAULT_TIMEOUT_MS = 2500

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
  if (isOffline()) return await getDocsFromCache(q)
  const pending = getDocs(q)
  try {
    return await withTimeout(pending, timeoutMs)
  } catch (e) {
    if (e?.code === 'offline/timeout') {
      const cached = await getDocsFromCache(q).catch(() => null)
      // Only prefer a non-empty cache; an empty one might just mean this query
      // was never primed, so keep waiting for the live request instead.
      if (cached && cached.docs.length > 0) return cached
    }
    return await pending
  }
}

// getDoc() with the same offline behaviour as getDocsTolerant().
export async function getDocTolerant(ref, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (isOffline()) return await getDocFromCache(ref)
  const pending = getDoc(ref)
  try {
    return await withTimeout(pending, timeoutMs)
  } catch (e) {
    if (e?.code === 'offline/timeout') {
      const cached = await getDocFromCache(ref).catch(() => null)
      if (cached && cached.exists()) return cached
    }
    return await pending
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
    const snap = await getDocsFromCache(q)
    return snap.size
  } catch {
    return null
  }
}
