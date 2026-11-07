// Offline cache seed — warms the Host's offline query cache with the canonical
// organisation-scoped reads so ward tablets can work with no prior online
// session. Runs only when the Host has a live Firestore connection; the result
// is the same durable cache the relay already serves during outages.
//
// Triggered automatically after the first successful sign-in + hospital
// selection. A toast tells the operator what is happening; the work runs in
// the background and never blocks the UI.
//
// It is deliberately narrow:
//   - one read per canonical collection, org-scoped, no filters, capped at
//     MAX_SEED_DOCS per collection (the cache's own MAX_CACHED_QUERY_DOCS is
//     10000, so this stays well under it)
//   - no client-supplied payloads — every row comes from Firestore
//   - failures are logged and skipped, never fatal: a partial seed still
//     leaves the Host able to serve whatever it got

import { getOrCreateDeviceKey, readDeviceSession, signedDeviceRequest } from './deviceSession.js'

function hostBaseUrl() {
  try {
    const configured = localStorage.getItem('medilogng.hubUrl') || import.meta.env?.VITE_HUB_URL || ''
    return String(configured || window.location.origin).replace(/\/+$/, '')
  } catch { return window.location.origin }
}

export async function seedHostOfflineCache(user, orgId, opts = {}) {
  if (!user?.uid || !orgId) return null
  const baseUrl = hostBaseUrl()
  let device
  try { device = await getOrCreateDeviceKey(user.uid, orgId) }
  catch { device = null }
  const token = await user.getIdToken().catch(() => '')
  const headers = {
    'content-type': 'application/json',
    'x-medilog-client': 'medilogng-web',
  }
  if (token) headers.authorization = 'Bearer ' + token

  let response
  if (device) {
    response = await signedDeviceRequest('/device/data/seed?orgId=' + encodeURIComponent(orgId), {
      method: 'POST', headers, body: JSON.stringify({ orgId }), cache: 'no-store',
      signal: opts.signal || AbortSignal.timeout(60000),
    }, device)
  } else if (token) {
    response = await fetch(baseUrl + '/device/data/seed?orgId=' + encodeURIComponent(orgId), {
      method: 'POST', headers, body: JSON.stringify({ orgId }), cache: 'no-store',
      signal: opts.signal || AbortSignal.timeout(60000),
    })
  } else {
    return null
  }
  if (!response?.ok) return null
  try { return await response.json() } catch { return null }
}