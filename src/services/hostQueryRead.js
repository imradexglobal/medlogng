import { Bytes, GeoPoint, Timestamp, doc } from 'firebase/firestore'
import { serializeFirestoreQuery } from '../lib/firestoreQuery.js'

let hubBase = undefined

async function getHubBase() {
  if (hubBase !== undefined) return hubBase
  if (typeof window === 'undefined' || !window.location || !window.isSecureContext) return hubBase = ''
  try {
    const configured = localStorage.getItem('medilogng.hubUrl') || import.meta.env?.VITE_HUB_URL || ''
    if (configured) return hubBase = String(configured).replace(/\/+$/, '')
  } catch { /* disabled storage */ }
  try {
    const response = await fetch(window.location.origin + '/health', { signal: AbortSignal.timeout(1200) })
    if (!response.ok) return hubBase = ''
    const data = await response.json()
    return hubBase = data?.ok && String(data.version || '').startsWith('hub-') ? window.location.origin : ''
  } catch { return hubBase = '' }
}

function reviveData(value) {
  if (Array.isArray(value)) return value.map(reviveData)
  if (!value || typeof value !== 'object') return value
  if (value.__firestoreType === 'timestamp') return new Timestamp(Number(value.seconds) || 0, Number(value.nanoseconds) || 0)
  if (value.__firestoreType === 'bytes') return Bytes.fromBase64String(String(value.value || ''))
  if (value.__firestoreType === 'geoPoint') return new GeoPoint(Number(value.value?.latitude) || 0, Number(value.value?.longitude) || 0)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = reviveData(item)
  return out
}

function makeSnapshot(db, query, collectionName, rows, source) {
  const fromCache = source === 'host-cache'
  const docs = rows.map((row) => {
    const ref = doc(db, collectionName, row.id)
    const data = reviveData(row.data || {})
    return {
      id: row.id,
      ref,
      metadata: { fromCache, hasPendingWrites: false },
      data: () => data,
      get: (field) => String(field).split('.').reduce((v, k) => v?.[k], data),
      exists: () => true,
      isEqual: (other) => other?.ref?.path === ref.path,
    }
  })
  return {
    docs, size: docs.length, empty: docs.length === 0, query,
    metadata: { fromCache, hasPendingWrites: false },
    forEach: (callback, thisArg) => docs.forEach(callback, thisArg),
    docChanges: () => [],
  }
}

export async function readQueryFromHost(db, query) {
  const spec = serializeFirestoreQuery(query)
  if (!spec) return null
  const baseUrl = await getHubBase()
  if (!baseUrl) return null
  let authStore, auth
  try {
    ;[{ authStore }, { auth }] = await Promise.all([
      import('../store/authStore.js'), import('../firebase.js'),
    ])
  } catch { return null }
  const state = authStore.getState()
  const user = auth.currentUser
  const orgId = state.activeOrg || ''
  if (!user?.uid || !orgId) return null
  const payload = { orgId, query: spec }
  const body = JSON.stringify(payload)
  const path = '/device/data/query'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const token = await user.getIdToken().catch(() => '')
    let device = null
    try {
      const { readDeviceSession } = await import('./speechSession.js')
      device = await readDeviceSession(user.uid, orgId)
    } catch { /* no Host device key enrolled yet */ }
    let response = null
    if (device) {
      const { signedSpeechRequest } = await import('./speechSession.js')
      response = await signedSpeechRequest(path, {
        method: 'POST', body, contentType: 'application/json', baseUrl,
        headers: token ? { authorization: 'Bearer ' + token } : {}, signal: controller.signal,
      }, device)
    } else if (token) {
      response = await fetch(baseUrl + path, { method: 'POST', headers: {
        authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-medilog-client': 'medilogng-web',
      }, body, signal: controller.signal, cache: 'no-store' })
    } else return null
    if (response.status === 400 || response.status === 404 || response.status === 405 || response.status >= 500) return null
    if (response.status === 403) {
      const data = await response.json().catch(() => ({}))
      if (/only caches queries scoped|query (?:filter|collection|order|cursor|limit)/i.test(String(data.error || ''))) return null
      throw new Error(data.error || 'The Host denied access to this hospital data.')
    }
    if (!response.ok) return null
    const data = await response.json()
    if (!Array.isArray(data.docs)) return null
    return makeSnapshot(db, query, spec.collection, data.docs, data.source)
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return null
    if (/denied access to this hospital data/.test(String(error?.message || ''))) throw error
    return null
  } finally { clearTimeout(timer) }
}
