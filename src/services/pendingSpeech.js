const DB_NAME = 'medilogng-pending-speech-v1'
const STORE_RECORDINGS = 'recordings'
const STORE_KEYS = 'keys'

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE_RECORDINGS)) db.createObjectStore(STORE_RECORDINGS, { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS, { keyPath: 'uid' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Local recording storage is unavailable.'))
  })
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Local recording storage failed.'))
  })
}

async function keyFor(db, uid) {
  const existing = await requestResult(db.transaction(STORE_KEYS, 'readonly').objectStore(STORE_KEYS).get(uid))
  if (existing?.key) return existing.key
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  try {
    await requestResult(db.transaction(STORE_KEYS, 'readwrite').objectStore(STORE_KEYS).add({ uid, key }))
    return key
  } catch {
    const winner = await requestResult(db.transaction(STORE_KEYS, 'readonly').objectStore(STORE_KEYS).get(uid))
    if (winner?.key) return winner.key
    throw new Error('Could not securely prepare local recording storage.')
  }
}

export async function savePendingSpeech(blob, { uid, orgId, patientId, encounterId }) {
  if (!uid || !orgId || !patientId || !encounterId || !(blob instanceof Blob) || !blob.size) throw new Error('Recording needs a signed-in clinician and open consultation.')
  const db = await openDb()
  try {
    const key = await keyFor(db, uid)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const aad = new TextEncoder().encode([uid, orgId, patientId, encounterId].join('\n'))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, await blob.arrayBuffer())
    const id = crypto.randomUUID()
    await requestResult(db.transaction(STORE_RECORDINGS, 'readwrite').objectStore(STORE_RECORDINGS).put({
      id, uid, orgId, patientId, encounterId, contentType: blob.type || 'audio/webm',
      createdAt: Date.now(), iv: Array.from(iv), ciphertext,
    }))
    return id
  } finally { db.close() }
}

export async function loadPendingSpeech(id, { uid, orgId, patientId, encounterId }) {
  const db = await openDb()
  try {
    const row = await requestResult(db.transaction(STORE_RECORDINGS, 'readonly').objectStore(STORE_RECORDINGS).get(id))
    if (!row || row.uid !== uid || row.orgId !== orgId || row.patientId !== patientId || row.encounterId !== encounterId) throw new Error('Saved recording does not match this clinician and consultation.')
    const keyRow = await requestResult(db.transaction(STORE_KEYS, 'readonly').objectStore(STORE_KEYS).get(uid))
    if (!keyRow?.key) throw new Error('Saved recording decryption key is unavailable.')
    const aad = new TextEncoder().encode([uid, orgId, patientId, encounterId].join('\n'))
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(row.iv), additionalData: aad }, keyRow.key, row.ciphertext)
    return new Blob([clear], { type: row.contentType })
  } finally { db.close() }
}

export async function deletePendingSpeech(id, uid) {
  const db = await openDb()
  try {
    const store = db.transaction(STORE_RECORDINGS, 'readwrite').objectStore(STORE_RECORDINGS)
    const row = await requestResult(store.get(id))
    if (row?.uid === uid) await requestResult(store.delete(id))
  } finally { db.close() }
}

export async function findPendingSpeech({ uid, orgId, patientId, encounterId }) {
  const db = await openDb()
  try {
    const rows = await requestResult(db.transaction(STORE_RECORDINGS, 'readonly').objectStore(STORE_RECORDINGS).getAll())
    return rows.filter((r) => r.uid === uid && r.orgId === orgId && r.patientId === patientId && r.encounterId === encounterId)
      .sort((a, b) => b.createdAt - a.createdAt).map(({ id, createdAt }) => ({ id, createdAt }))
  } finally { db.close() }
}
