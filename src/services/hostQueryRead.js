import { Bytes, GeoPoint, Timestamp, doc } from 'firebase/firestore'
import { serializeFirestoreQuery } from '../lib/firestoreQuery.js'

let hubBase = undefined

async function getHubBase() {
  if (hubBase !== undefined) return hubBase
  if (typeof window === 'undefined' || !window.location || !window.isSecureContext) return hubBase = ''
  try {
    const configured = localStorage.getItem('medilogng.hubUrl') || import.meta.env?.VITE_HUB_URL || ''
    if (configured) {
      const candidate = String(configured).replace(/\/+$/, '')
      const parsed = new URL(candidate)
      return hubBase = parsed.protocol === 'https:' || ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname) ? candidate : ''
    }
  } catch { /* disabled storage */ }
  try {
    const origin = new URL(window.location.origin)
    if (origin.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]', '::1'].includes(origin.hostname)) return hubBase = ''
    const fetchPromise = fetch(window.location.origin + '/health')
    const response = await Promise.race([
      fetchPromise,
      new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('hub health check timed out'), { code: 'hub/timeout' })), 1200)),
    ])
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

function makeDocumentSnapshot(db, ref, row, source) {
  const fromCache = source === 'host-cache'
  const exists = !!row.exists
  const data = exists ? reviveData(row.data || {}) : undefined
  const localRef = doc(db, ref.path)
  return {
    id: ref.id,
    ref: localRef,
    metadata: { fromCache, hasPendingWrites: false },
    exists: () => exists,
    data: () => data,
    get: (field) => exists ? String(field).split('.').reduce((v, k) => v?.[k], data) : undefined,
    isEqual: (other) => other?.ref?.path === localRef.path,
  }
}

async function signedHostRequest(baseUrl, path, body, user, orgId, signal) {
  const payload = JSON.stringify(body)
  let token = ''
  if (navigator.onLine !== false) {
    let tokenTimer
    token = await Promise.race([
      user.getIdToken().catch(() => ''),
      new Promise((resolve) => { tokenTimer = setTimeout(() => resolve(''), 600) }),
    ])
    clearTimeout(tokenTimer)
  }
  let device = null
  try {
    const { readDeviceSession } = await import('./deviceSession.js')
    device = await readDeviceSession(user.uid, orgId)
  } catch { /* not enrolled */ }
  if (device) {
    const { signedDeviceRequest } = await import('./deviceSession.js')
    return signedDeviceRequest(path, { method: 'POST', body: payload, contentType: 'application/json', baseUrl,
      headers: token ? { authorization: 'Bearer ' + token } : {}, signal }, device)
  }
  if (!token) return null
  const fetchPromise = fetch(baseUrl + path, { method: 'POST', headers: {
    authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-medilog-client': 'medilogng-web',
  }, body: payload, signal, cache: 'no-store' })
  return Promise.race([
    fetchPromise,
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('host request timed out'), { code: 'host/timeout' })), 5000)),
  ])
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
  const path = '/device/data/query'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await signedHostRequest(baseUrl, path, { orgId, query: spec }, user, orgId, controller.signal)
    if (!response) return null
    if (response.status === 400 || response.status === 404 || response.status === 405 || response.status === 413 || response.status >= 500) return null
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

export async function readDocumentFromHost(db, ref) {
  const segments = String(ref?.path || '').split('/')
  if (![2, 4].includes(segments.length) || !segments[0] || !segments[1] || segments.length === 4 && (segments[2] !== 'blob' || segments[3] !== 'data')) return null
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
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await signedHostRequest(baseUrl, '/device/data/document', {
      orgId, collection: segments[0], id: segments[1], path: segments.join('/'),
    }, user, orgId, controller.signal)
    if (!response || response.status === 400 || response.status === 404 || response.status === 405 || response.status >= 500) return null
    if (response.status === 403) {
      const data = await response.json().catch(() => ({}))
      if (/collection is not available|record reference is invalid/i.test(String(data.error || ''))) return null
      throw new Error(data.error || 'The Host denied access to this hospital record.')
    }
    if (!response.ok) return null
    const data = await response.json()
    if (typeof data.exists !== 'boolean') return null
    return makeDocumentSnapshot(db, ref, data, data.source)
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return null
    if (/denied access to this hospital record/.test(String(error?.message || ''))) throw error
    return null
  } finally { clearTimeout(timer) }
}
