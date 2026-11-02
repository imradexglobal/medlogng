const DB = 'medlogng-speech-session'
const STORE = 'keys'
const encoder = new TextEncoder()

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'key' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
async function read(key) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key)
    request.onsuccess = () => { db.close(); resolve(request.result || null) }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}
export async function readDeviceSession(uid, orgId) {
  if (!uid || !orgId) return null
  return read(`${uid}:${orgId}`)
}
async function write(value) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value)
    request.onsuccess = () => { db.close(); resolve() }
    request.onerror = () => { db.close(); reject(request.error) }
  })
}
export async function clearSpeechSession(uid, orgId) {
  const key = `${uid}:${orgId}`
  const saved = await read(key).catch(() => null)
  const db = await openDb()
  await new Promise((resolve) => { const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key); req.onsuccess = req.onerror = () => resolve() })
  db.close()
  if (saved?.deviceId) {
    await signedSpeechRequest('/device/session/revoke?orgId=' + encodeURIComponent(orgId), {
      method: 'POST', signal: AbortSignal.timeout(1500),
    }, saved).catch(() => {})
    await signedSpeechRequest('/device/session/revoke?orgId=' + encodeURIComponent(orgId), {
      method: 'POST', signal: AbortSignal.timeout(1500),
    }, saved).catch(() => {})
  }
}
export async function clearAllSpeechSessions(uid) {
  const db = await openDb()
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
  const owned = rows.filter((row) => row.uid === uid)
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    for (const row of owned) store.delete(row.key)
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve()
  })
  db.close()
  await Promise.allSettled(owned.flatMap((row) => [
    signedSpeechRequest('/device/session/revoke?orgId=' + encodeURIComponent(row.orgId), { method: 'POST', signal: AbortSignal.timeout(1500) }, row),
    signedSpeechRequest('/device/session/revoke?orgId=' + encodeURIComponent(row.orgId), { method: 'POST', signal: AbortSignal.timeout(1500) }, row),
  ]))
}

export async function getOrCreateDeviceKey(uid, orgId) {
  const key = `${uid}:${orgId}`
  let saved = await read(key)
  if (saved) return saved
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  const publicKey = await crypto.subtle.exportKey('jwk', pair.publicKey)
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey)
  const digest = await crypto.subtle.digest('SHA-256', spki)
  const deviceId = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  saved = { key, uid, orgId, deviceId, privateKey: pair.privateKey, publicKey }
  await write(saved)
  return saved
}

export async function ensureSpeechSession(user, orgId) {
  if (!user?.uid || !orgId) throw new Error('Sign in and select a hospital before recording.')
  let saved = await read(`${user.uid}:${orgId}`)
  const url = '/device/session/register?orgId=' + encodeURIComponent(orgId)
  if (navigator.onLine) {
    const token = await user.getIdToken()
    if (!saved) saved = await getOrCreateDeviceKey(user.uid, orgId)
    let response = null
    try {
      response = await fetch(window.location.origin + url, { method: 'POST', headers: {
        authorization: 'Bearer ' + token, 'content-type': 'application/json', 'x-medilog-client': 'medilogng-web',
        ...(saved?.deviceId ? { 'x-speech-device': saved.deviceId } : {}),
      }, body: JSON.stringify({ publicKey: saved.publicKey }), cache: 'no-store', signal: AbortSignal.timeout(2500) })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.session) { saved.deviceId = data.session.deviceId; await write(saved); return saved }
      if (response.status === 401 || response.status === 403) throw new Error(data.error || 'Speech access is not authorized.')
      if (!saved || ![503, 502, 504].includes(response.status)) throw new Error(data.error || 'Could not register this device for speech.')
    } catch (error) {
      if (!saved || response && ![502, 503, 504].includes(response.status)) throw error
    }
  }
  if (!saved) throw new Error('Connect once to verify speech access on this device.')
  const response = await signedSpeechRequest('/device/session/offline?orgId=' + encodeURIComponent(orgId), { method: 'POST' }, saved)
  if (!response.ok) throw new Error('The Host has no verified offline device session for this account.')
  return saved
}

export async function signedSpeechRequest(path, options = {}, saved) {
  const method = String(options.method || 'GET').toUpperCase()
  const { baseUrl = window.location.origin, ...fetchOptions } = options
  const body = options.body || null
  const bytes = body ? new Uint8Array(await (body.arrayBuffer ? body.arrayBuffer() : Promise.resolve(encoder.encode(body)))) : new Uint8Array()
  const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const timestamp = String(Date.now())
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18))
  const nonce = btoa(String.fromCharCode(...nonceBytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const requestId = String(options.requestId || options.headers?.['x-speech-request-id'] || '')
  const contentType = String(options.contentType || body?.type || '')
  const payload = [method, path, requestId, contentType.toLowerCase(), bodyHash, timestamp, nonce].join('\n')
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, saved.privateKey, encoder.encode(payload))
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return fetch(baseUrl.replace(/\/+$/, '') + path, { ...fetchOptions, headers: { ...(options.headers || {}),
    'x-medilog-client': 'medilogng-web', 'x-speech-device': saved.deviceId,
    'x-speech-timestamp': timestamp, 'x-speech-nonce': nonce, 'x-speech-signature': encodedSignature,
    'x-speech-body-sha256': bodyHash, ...(requestId ? { 'x-speech-request-id': requestId } : {}),
    ...(contentType ? { 'content-type': contentType } : {}),
  }, cache: 'no-store' })
}

export async function signedSpeechHeaders(path, { method = 'GET', body = null, contentType = '', requestId = '', authorization = '' } = {}, saved) {
  const bytes = body ? new Uint8Array(await body.arrayBuffer()) : new Uint8Array()
  const bodyHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')
  const timestamp = String(Date.now())
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = [String(method).toUpperCase(), path, requestId, contentType.toLowerCase(), bodyHash, timestamp, nonce].join('\n')
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, saved.privateKey, encoder.encode(payload))
  const headers = { 'x-medilog-client': 'medilogng-web', 'x-speech-device': saved.deviceId,
    'x-speech-timestamp': timestamp, 'x-speech-nonce': nonce,
    'x-speech-signature': btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    'x-speech-body-sha256': bodyHash }
  if (requestId) headers['x-speech-request-id'] = requestId
  if (contentType) headers['content-type'] = contentType
  if (authorization) headers.authorization = authorization
  return headers
}

export async function revalidateSpeechSession(user, orgId) {
  const saved = await read(`${user?.uid}:${orgId}`)
  if (!saved || !navigator.onLine) return false
  try {
    const token = await user.getIdToken(true)
    const response = await signedSpeechRequest('/device/session/revalidate?orgId=' + encodeURIComponent(orgId), {
      method: 'POST', headers: { authorization: 'Bearer ' + token },
    }, saved)
    if (response.status === 401 || response.status === 403) {
      const db = await openDb()
      await new Promise((resolve) => { const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(saved.key); req.onsuccess = req.onerror = () => resolve() })
      db.close()
      return false
    }
    return response.ok
  } catch { return false }
}

export async function revalidateAllSpeechSessions(user) {
  if (!user?.uid || !navigator.onLine) return
  const db = await openDb()
  const rows = await new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).getAll()
    request.onsuccess = () => resolve(request.result || [])
    request.onerror = () => reject(request.error)
  })
  db.close()
  for (const row of rows) if (row.uid === user.uid) await revalidateSpeechSession(user, row.orgId)
}
