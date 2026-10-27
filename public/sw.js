/* MediLog NG service worker — app-shell offline support.
 *
 * Firestore already persists its own data in IndexedDB (see src/firebase.js
 * `persistentLocalCache`), so this worker only has to make the *app shell*
 * (HTML/JS/CSS/wasm) available offline. Data requests to Firebase are never
 * intercepted — the Firestore SDK handles its own caching and write queue.
 *
 * Strategy:
 *  - Navigations: cached shell served instantly when the device reports
 *    offline; when online, the network is raced against a short timeout so a
 *    dead or hanging connection can no longer stall boot for tens of seconds
 *    waiting on DNS. Slow network → shell appears after the timeout, and the
 *    late network response still refreshes the cache for the next load.
 *  - Same-origin static assets (hashed build output): stale-while-revalidate.
 *    Content hashes make them immutable, so serving from cache is always safe
 *    and a background refresh picks up new builds.
 *  - Cross-origin images (login-screen Unsplash photos): cache-first so the
 *    login screen paints offline after one successful online visit.
 *  - Cross-origin Firebase/Firestore/Auth: untouched — pass through.
 */
const CACHE = 'medilogng-shell-v3'
const SHELL = ['./', './index.html', './logo.svg', './manifest.webmanifest']
const NAV_TIMEOUT_MS = 2000

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

function timeout(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)

  // Cross-origin: only cache images. Firebase / Firestore / Auth traffic is
  // left to the SDKs, which own their own retry and offline behaviour.
  if (url.origin !== self.location.origin) {
    if (req.destination === 'image') {
      event.respondWith(cacheFirstImage(req))
    }
    return
  }

  // SPA navigations (hash routes all load the same document).
  if (req.mode === 'navigate') {
    event.respondWith(navigationResponse(req))
    return
  }

  // Hashed build assets + static files: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(req, copy))
          return res
        }
        // A hashed chunk that 404s means the tab is running an older shell than
        // the one deployed. If we already have a copy, keep serving it instead
        // of failing the dynamic import.
        return hit || res
      }).catch(() => hit)
      return hit || refresh
    })
  )
})

async function navigationResponse(req) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match('./index.html')
  // Device knows it is offline — skip the network entirely, no timeout wait.
  if (navigator.onLine === false) {
    return cached || Response.error()
  }
  // Online (or the flag is stale): race the network against a short timeout.
  // The fetch is not cancelled on loss — a late 200 still refreshes the cache.
  // `no-cache` revalidates the document so a deploy is picked up immediately
  // instead of being masked for up to an hour by the HTTP cache.
  const network = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res && res.status === 200) {
      cache.put('./index.html', res.clone()).catch(() => {})
    }
    return res
  }).catch(() => null)
  const winner = await Promise.race([network, timeout(NAV_TIMEOUT_MS).then(() => null)])
  return winner || cached || Response.error()
}

async function cacheFirstImage(req) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(req)
  if (hit) return hit
  try {
    const res = await fetch(req)
    // Opaque (no-cors <img>) responses report status 0 but are still cacheable.
    if (res && (res.type === 'opaque' || res.status === 200)) {
      cache.put(req, res.clone()).catch(() => {})
    }
    return res
  } catch {
    return Response.error()
  }
}
