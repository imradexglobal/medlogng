import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, query, where, getDocs as firestoreGetDocs, getDocsFromCache, getCountFromServer, onSnapshot,
  runTransaction, writeBatch as firestoreWriteBatch, serverTimestamp, Timestamp,
  waitForPendingWrites,
  doc as firestoreDoc, getDoc as firestoreGetDoc, getDocFromCache,
  setDoc as firestoreSetDoc, addDoc as firestoreAddDoc,
  updateDoc as firestoreUpdateDoc, deleteDoc as firestoreDeleteDoc, orderBy, limit, startAfter, Bytes,
} from 'firebase/firestore'
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, updatePassword,
  sendEmailVerification, sendPasswordResetEmail,
  verifyPasswordResetCode, confirmPasswordReset,
  EmailAuthProvider, reauthenticateWithCredential,
} from 'firebase/auth'
import { readWithCache } from './lib/readFallback.js'
import { readDocumentFromHost, readQueryFromHost } from './services/hostQueryRead.js'

// Live Firestore — NO emulator. Config comes from Vite env (VITE_ keys).
// `.env.local` holds BOTH blocks: the local-test project (active) and the
// real project (commented). Vite loads `.env.local` in dev AND build, so
// switch the two blocks by hand before deploying.
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

// Analytics is optional — only the real-project block sets a measurement id.
const measurementId = import.meta.env.VITE_FIREBASE_MEASUREMENT_ID

const requiredConfigKeys = [
  'apiKey', 'authDomain', 'projectId', 'storageBucket', 'messagingSenderId', 'appId',
]

export function hasFirebaseConfig() {
  return requiredConfigKeys.every(
    (k) => typeof firebaseConfig[k] === 'string' && firebaseConfig[k].trim() !== '',
  )
}

if (!hasFirebaseConfig()) {
  console.error('[MediLog] Firebase web config missing. Copy .env.example to .env.local and fill VITE_ keys.')
}

export const app = initializeApp(firebaseConfig)

// Analytics: initialize only when a measurement id is present (real deploy)
// and the environment supports it. Skipped silently on unsupported hosts
// (e.g. Capacitor/Electron) so it can never break startup. When the device
// is offline the gtag script cannot load — defer until connectivity returns
// instead of stalling on the external request at boot.
if (measurementId) {
  const initAnalytics = () => {
    isSupported()
      .then((supported) => { if (supported) getAnalytics(app) })
      .catch(() => {})
  }
  if (typeof navigator === 'undefined' || navigator.onLine !== false) initAnalytics()
  else window.addEventListener('online', initAnalytics, { once: true })
}

// Offline-first per device: keep a persistent IndexedDB cache so previously
// loaded reads and supported writes survive a connection loss. Firestore keeps
// its local queue; selected, idempotent writes also hand off to the LAN host.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})

// A LAN can remain connected while the internet route to Firebase is down,
// so navigator.onLine alone is not enough. Bound network-first reads, then
// fall back to this device's persistent Firestore cache on transport failure.
// Permission/validation errors are preserved instead of being hidden by stale
// cache results.
export async function getDocs(q) {
  const host = await readQueryFromHost(db, q).catch((error) => { throw error })
  if (host) return host
  return readWithCache(() => firestoreGetDocs(q), () => getDocsFromCache(q), { label: 'Collection' })
}
export function getDoc(ref) {
  return readDocumentFromHost(db, ref).then((host) => host ||
    readWithCache(() => firestoreGetDoc(ref), () => getDocFromCache(ref), { label: 'Document' }))
}

// Firestore applies writes to its persistent local cache immediately, then its
// promise remains pending until the cloud acknowledges them. Do not leave a
// ward workflow spinner running throughout an internet outage: after a short
// grace period let the screen continue while Firestore retains the write for
// later delivery. Late rule/validation failures are surfaced in the app shell.
const LOCAL_WRITE_GRACE_MS = 1800
const HOST_MUTATION_COLLECTIONS = new Set([
  'patients', 'organization_patients', 'documents', 'appointments', 'encounters', 'vitals', 'allergies', 'diagnoses', 'admission_plan_items',
  'imaging_orders', 'lab_orders', 'wards', 'lab_test_catalogue', 'lab_settings', 'price_catalogue',
])
function reportLateWriteFailure(error, label) {
  console.warn('[offline-write] queued ' + label + ' was rejected during sync:', error?.message || error)
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('medilog-write-sync-error', {
      detail: { message: 'A saved change could not sync. Reopen the affected page to review it.' },
    }))
  }
}
function reportPendingWrite(label) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('medilog-write-pending', { detail: { label } }))
  }
}
function mutationValue(value, depth = 0) {
  if (depth > 8) throw new Error('offline write is nested too deeply')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('offline write has a non-finite number'); return value }
  if (value === undefined) return undefined
  if (value instanceof Date) return { __firestoreType: 'timestamp', value: value.toISOString() }
  if (value && typeof value.toDate === 'function') return { __firestoreType: 'timestamp', value: value.toDate().toISOString() }
  if (value?.constructor?.name === 'ServerTimestampFieldValueImpl') return { __firestoreType: 'serverTimestamp' }
  if (Array.isArray(value)) return value.map((item) => mutationValue(item, depth + 1))
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('offline write has a forbidden key')
      const next = mutationValue(item, depth + 1)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  throw new Error('offline write contains a Firestore transform that cannot be shared safely')
}
function makeMutation(ref, action, data) {
  const collection = ref?.parent?.path
  const id = ref?.id
  if (!collection || collection.includes('/') || !id || !HOST_MUTATION_COLLECTIONS.has(collection)) return null
  try { return { collection, id, action, ...(data !== undefined ? { data: mutationValue(data) } : {}) } }
  catch { return null }
}
async function persistMutationHandoff(mutations) {
  if (!mutations?.length || mutations.length > 20) return
  if (mutations.some((m) => !m)) return
  try {
    const { enqueue } = await import('./services/clinicalOutbox.js')
    await enqueue('document_mutation', { mutations })
  } catch (error) {
    console.warn('[offline-write] could not save LAN handoff:', error?.message || error)
  }
}
function settleWrite(promise, label, mutation = null) {
  const queueHandoff = () => mutation ? persistMutationHandoff(Array.isArray(mutation) ? mutation : [mutation]) : Promise.resolve()
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    reportPendingWrite(label)
    promise.catch((error) => reportLateWriteFailure(error, label))
    return queueHandoff().then(() => ({ pendingSync: true }))
  }
  let timer
  let settled = false
  promise.catch((error) => {
    if (settled) reportLateWriteFailure(error, label)
  })
  return Promise.race([
    promise.then((value) => { settled = true; return value }),
    new Promise((resolve) => { timer = setTimeout(() => {
      settled = true
      reportPendingWrite(label)
      queueHandoff().finally(() => resolve({ pendingSync: true }))
    }, LOCAL_WRITE_GRACE_MS) }),
  ]).finally(() => clearTimeout(timer))
}

export function setDoc(ref, data, options) {
  const action = options?.merge ? 'merge' : 'create'
  return settleWrite(firestoreSetDoc(ref, data, options), 'record update', makeMutation(ref, action, data))
}
export function updateDoc(ref, data) {
  return settleWrite(firestoreUpdateDoc(ref, data), 'record update', makeMutation(ref, 'update', data))
}
export function deleteDoc(ref) {
  return settleWrite(firestoreDeleteDoc(ref), 'record removal', makeMutation(ref, 'delete'))
}
export function addDoc(collectionRef, data) {
  // Allocate the ID locally so callers can navigate to the record before the
  // cloud acknowledges it. The generated reference remains stable on retry.
  const ref = firestoreDoc(collectionRef)
  const pending = firestoreSetDoc(ref, data)
  return settleWrite(pending, 'new record', makeMutation(ref, 'create', data)).then(() => ref)
}
export function writeBatch(firestore) {
  const batch = firestoreWriteBatch(firestore)
  const commit = batch.commit.bind(batch)
  const mutations = []
  let allMutationsShareable = true
  const set = batch.set.bind(batch), update = batch.update.bind(batch), del = batch.delete.bind(batch)
  batch.set = (ref, data, options) => {
    const mutation = makeMutation(ref, options?.merge ? 'merge' : 'create', data)
    if (mutation) mutations.push(mutation)
    else allMutationsShareable = false
    return set(ref, data, options)
  }
  batch.update = (ref, data) => {
    const mutation = makeMutation(ref, 'update', data)
    if (mutation) mutations.push(mutation)
    else allMutationsShareable = false
    return update(ref, data)
  }
  batch.delete = (ref) => {
    const mutation = makeMutation(ref, 'delete')
    if (mutation) mutations.push(mutation)
    else allMutationsShareable = false
    return del(ref)
  }
  batch.commit = () => settleWrite(commit(), 'record batch', allMutationsShareable && mutations.length ? mutations : null)
  return batch
}

function restoreMutationValue(value) {
  if (Array.isArray(value)) return value.map(restoreMutationValue)
  if (!value || typeof value !== 'object') return value
  if (value.__firestoreType === 'serverTimestamp') return serverTimestamp()
  if (value.__firestoreType === 'timestamp' && typeof value.value === 'string') return Timestamp.fromDate(new Date(value.value))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreMutationValue(item)]))
}
// Used only by the browser outbox when no LAN host is configured. Imports the
// raw SDK functions, avoiding another handoff being enqueued recursively.
export async function applyQueuedMutations(mutations) {
  const batch = firestoreWriteBatch(db)
  for (const mutation of mutations || []) {
    const ref = firestoreDoc(db, mutation.collection, mutation.id)
    const data = mutation.data ? restoreMutationValue(mutation.data) : null
    if (mutation.action === 'create') batch.set(ref, data)
    else if (mutation.action === 'update' || mutation.action === 'merge') batch.set(ref, data, { merge: true })
    else if (mutation.action === 'delete') batch.delete(ref)
    else throw new Error('Unsupported queued record action.')
  }
  await batch.commit()
}

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

setPersistence(auth, browserLocalPersistence).catch(() => {})

export {
  collection, query, where, getDocsFromCache, getCountFromServer, onSnapshot,
  runTransaction, serverTimestamp, Timestamp, waitForPendingWrites,
  firestoreDoc as doc, getDocFromCache, orderBy, limit, startAfter, Bytes,
  signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, updatePassword, sendEmailVerification,
  sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset,
  EmailAuthProvider, reauthenticateWithCredential,
}
