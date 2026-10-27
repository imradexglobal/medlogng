// In-memory stand-in for src/firebase.js.
//
// Only the surface the services actually use is implemented. The point is not
// to emulate Firestore but to enforce the rules the real thing enforces, so a
// service that would fail in production fails here too.

export const __fake = {
  docs: new Map(),        // "collection/id" -> data object
  auditLog: [],
  resets: 0,
}

export function resetFake(seed = {}) {
  __fake.docs = new Map(Object.entries(seed.docs || {}))
  __fake.auditLog = []
  __fake.resets = 0
}

// ---- reference helpers -----------------------------------------------------
export function collection(db, name) {
  return { __collection: name }
}

// Mirrors the real overloads:
//   doc(collectionRef)      -> a new id under that collection
//   doc(db, 'coll')          -> a new id under 'coll'
//   doc(db, 'coll', 'id')    -> an explicit path
export function doc(...args) {
  const first = args[0]
  const path = first && first.__collection
    ? first.__collection + '/' + genId()
    : (() => {
      const [, coll, id] = args
      if (typeof coll !== 'string') throw new Error('doc() called with ' + JSON.stringify(args))
      return coll + '/' + (id || genId())
    })()
  // Real references expose `.id` and `.path`; services read `.id` off an
  // auto-generated ref, so the fake has to as well.
  return { __path: path, path, id: path.split('/')[1] }
}

function genId() {
  return 'id' + Math.random().toString(36).slice(2, 10)
}

const key = (path) => path

// ---- queries ---------------------------------------------------------------
export function query(base, ...constraints) { return { __query: true, base, constraints } }
export function where(field, op, value) { return { field, op, value } }
export function orderBy() { return {} }
export function limit() { return {} }
export function startAfter() { return {} }

function matches(data, constraints) {
  return constraints.every((c) => {
    if (!c || !c.field) return true
    if (c.op === '==') return data[c.field] === c.value
    return true
  })
}

export async function getDocs(q) {
  const coll = q && q.base ? q.base.__collection : null
  const out = []
  for (const [path, data] of __fake.docs) {
    if (!coll || !path.startsWith(coll + '/')) continue
    if (!matches(data, q.constraints)) continue
    out.push({ id: path.split('/')[1], data: () => ({ ...data }) })
  }
  return { docs: out, size: out.length, empty: out.length === 0 }
}

export async function getDocsFromCache(q) {
  return getDocs(q)
}

export async function getCountFromServer(q) {
  const snap = await getDocs(q)
  return { data: () => ({ count: snap.size }) }
}

export function onSnapshot(q, onNext) {
  // Enough for a one-shot push; tests do not rely on live re-firing.
  getDocs(q).then((s) => onNext(s))
  return () => {}
}

// ---- single-doc reads/writes ----------------------------------------------
export async function getDoc(ref) {
  const data = __fake.docs.get(key(ref.__path))
  return {
    id: ref.__path.split('/')[1],
    exists: () => !!data,
    data: () => ({ ...data }),
  }
}

export async function getDocFromCache(ref) {
  return getDoc(ref)
}

export async function setDoc(ref, data) {
  __fake.docs.set(key(ref.__path), { ...data })
}

export async function updateDoc(ref, data) {
  const p = key(ref.__path)
  const prev = __fake.docs.get(p)
  if (!prev) throw new Error('no-such-document ' + p)
  __fake.docs.set(p, { ...prev, ...data })
}

export async function addDoc(ref, data) {
  // Real addDoc takes a COLLECTION reference and generates the id itself.
  const p = ref && ref.__collection ? ref.__collection + '/' + genId() : key(ref.__path)
  __fake.docs.set(p, { ...data })
  return { id: p.split('/')[1] }
}

export async function deleteDoc(ref) {
  __fake.docs.delete(key(ref.__path))
}

export function writeBatch() {
  const ops = []
  return {
    set: (ref, d) => ops.push(() => setDoc(ref, d)),
    update: (ref, d) => ops.push(() => updateDoc(ref, d)),
    delete: (ref) => ops.push(() => deleteDoc(ref)),
    commit: async () => { for (const op of ops) await op() },
  }
}

// ---- transactions ----------------------------------------------------------
// This is the behaviour that matters: Firestore requires all reads to precede
// all writes inside a transaction. Reading after a write throws
// FAILED_PRECONDITION, which is exactly how the real `createDrug` failed.
export async function runTransaction(db, fn) {
  const snapshot = new Map(__fake.docs)
  const writes = []
  let hasWritten = false

  const tx = {
    async get(ref) {
      if (hasWritten) {
        const err = new Error('Firestore transactions require all reads before all writes')
        err.code = 'failed-precondition'
        throw err
      }
      const data = snapshot.get(key(ref.__path))
      return {
        id: ref.__path.split('/')[1],
        exists: () => !!data,
        data: () => (data ? { ...data } : undefined),
      }
    },
    set(ref, data) {
      hasWritten = true
      const p = key(ref.__path)
      writes.push(() => __fake.docs.set(p, { ...data }))
    },
    update(ref, data) {
      hasWritten = true
      const p = key(ref.__path)
      writes.push(() => {
        const prev = snapshot.get(p)
        if (!prev) throw new Error('no-such-document ' + p)
        __fake.docs.set(p, { ...prev, ...data })
      })
    },
    delete(ref) {
      hasWritten = true
      const p = key(ref.__path)
      writes.push(() => __fake.docs.delete(p))
    },
  }

  const result = await fn(tx)
  // All-or-nothing: if anything in the callback threw, nothing is applied.
  for (const w of writes) w()
  return result
}

export async function waitForPendingWrites() {}

// ---- misc stubs ------------------------------------------------------------
export function serverTimestamp() { return { __ts: true, toMillis: () => Date.now() } }
// Firestore Bytes stand-in: records the raw Uint8Array and can hand it back, so
// resultImageService can be exercised without a DOM/canvas.
export const Bytes = {
  fromUint8Array: (u8) => ({ __bytes: true, length: u8.length, toUint8Array: () => u8 }),
}
export class Timestamp {
  constructor(ms) { this.ms = ms }
  toMillis() { return this.ms }
  toDate() { return new Date(this.ms) }
}
export const db = { __fake: true }
export const app = {}
export const auth = { currentUser: null }
export const googleProvider = { providerId: 'google.com' }
export function hasFirebaseConfig() { return true }
export function getAuth() { return auth }
export function getAnalytics() { return {} }
export function isSupported() { return Promise.resolve(false) }
export function initializeApp() { return {} }
export function initializeFirestore() { return db }
export function persistentLocalCache() { return {} }
export function persistentMultipleTabManager() { return {} }
export function onAuthStateChanged() { return () => {} }
export async function setPersistence() {}
export async function signOut() {}
export function GoogleAuthProvider() {}
export async function signInWithPopup() {}
export async function signInWithEmailAndPassword() {}
export async function createUserWithEmailAndPassword() {}
export async function updatePassword() {}
export async function sendEmailVerification() {}
export async function sendPasswordResetEmail() {}
export async function verifyPasswordResetCode() {}
export async function confirmPasswordReset() {}
export function EmailAuthProvider() {}
export async function reauthenticateWithCredential() {}
export function browserLocalPersistence() { return {} }