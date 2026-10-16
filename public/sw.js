/* MediLog NG service worker — app-shell offline support.
 *
 * Firestore already persists its own data in IndexedDB (see src/firebase.js
 * `persistentLocalCache`), so this worker only has to make the *app shell*
 * (HTML/JS/CSS/wasm) available offline. Data requests to Firebase are never
 * intercepted — the Firestore SDK handles its own caching and write queue.
 *
 * Strategy:
 *  - Navigations: network-first, fall back to the cached SPA shell so hash
 *    routes (#/patients etc.) keep working with no connection.
 *  - Same-origin static assets (hashed build output): stale-while-revalidate.
 *    Content hashes make them immutable, so serving from cache is always safe
 *    and a background refresh picks up new builds.
 *  - Cross-origin (Firebase/Firestore/Auth): untouched — pass through.
 */
const CACHE = 'medilogng-shell-v1'
const SHELL = ['./', './index.html', './logo.svg', './manifest.webmanifest']

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

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return

  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return // Firestore/Auth/Firebase — SDK owns these

  // SPA navigations: network-first so a deploy is picked up immediately,
  // cached shell so an offline reload still boots the app.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone()
        caches.open(CACHE).then((cache) => cache.put('./index.html', copy))
        return res
      }).catch(() =>
        caches.match('./index.html').then((hit) => hit || Response.error())
      )
    )
    return
  }

  // Hashed build assets + static files: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((hit) => {
      const refresh = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone()
          caches.open(CACHE).then((cache) => cache.put(req, copy))
        }
        return res
      }).catch(() => hit)
      return hit || refresh
    })
  )
})
