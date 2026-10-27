// Stale-build recovery for lazy (code-split) routes.
//
// Every deploy ships a new set of content-hashed chunks and a new index.html.
// A tab that is still running — or a service worker still serving — the
// previous index.html asks for a chunk that no longer exists, and the route
// import rejects with "Failed to fetch dynamically imported module". Nothing is
// broken in the app; the document and its chunk map are just out of date.
//
// The only reliable cure is to reload the document so the fresh shell is
// fetched. Reloading blindly would loop forever against a genuinely broken
// build, so a sessionStorage stamp allows one reload per cooldown window.

const RELOAD_KEY = 'medlog:chunk-reload-at'
const RELOAD_COOLDOWN_MS = 30 * 1000

// Messages browsers produce for a chunk that could not be fetched. Keep this
// narrow: a real error thrown *inside* a view must still be reported, not hide
// behind a reload.
const CHUNK_ERROR_RE =
  /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed|load failed|chunkloaderror|loading chunk [\w-]+ failed/i

export function isChunkLoadError(err) {
  if (!err) return false
  const msg = String(err.message || err.reason || err)
  return CHUNK_ERROR_RE.test(msg)
}

// Returns true when a reload was started. Callers should stop rendering: the
// document is about to be replaced.
export function recoverFromStaleChunk() {
  if (typeof window === 'undefined') return false

  let last = 0
  try {
    last = Number(window.sessionStorage.getItem(RELOAD_KEY) || 0)
  } catch {
    // Private mode / storage disabled: allow one attempt per page load.
  }
  if (last && Date.now() - last < RELOAD_COOLDOWN_MS) return false

  try {
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    /* storage unavailable — the cooldown is best-effort */
  }

  const reload = () => {
    // A unique query string defeats the HTTP cache *and* the service worker's
    // cached index.html, so the reload really does pick up the new build. The
    // hash route is preserved, so the user lands back on the page they wanted.
    try {
      const url = new URL(window.location.href)
      url.searchParams.set('_r', String(Date.now()))
      window.location.replace(url.toString())
    } catch {
      window.location.reload()
    }
  }

  // Drop the app-shell cache first: the service worker would otherwise hand the
  // very same stale index.html back on the reload. Firestore's offline data
  // lives in IndexedDB, not Cache Storage, so this loses no clinical data.
  if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(reload, reload)
  } else {
    reload()
  }
  return true
}

// Catches chunk failures that never reach the router's try/catch — a module
// preload that fails, or a view importing a helper chunk inside its own async
// handler. Returns the cleanup function.
export function installChunkRecovery() {
  if (typeof window === 'undefined') return () => {}

  const onPreloadError = (event) => {
    if (recoverFromStaleChunk() && event.preventDefault) event.preventDefault()
  }
  const onUnhandledRejection = (event) => {
    if (!isChunkLoadError(event.reason)) return
    if (recoverFromStaleChunk() && event.preventDefault) event.preventDefault()
  }

  window.addEventListener('vite:preloadError', onPreloadError)
  window.addEventListener('unhandledrejection', onUnhandledRejection)
  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError)
    window.removeEventListener('unhandledrejection', onUnhandledRejection)
  }
}
