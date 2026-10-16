import { initializeApp } from 'firebase/app'
import { getAnalytics, isSupported } from 'firebase/analytics'
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, query, where, getDocs, getCountFromServer, onSnapshot,
  runTransaction, writeBatch, serverTimestamp, Timestamp,
  waitForPendingWrites,
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, orderBy, limit, startAfter, Bytes,
} from 'firebase/firestore'
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence, updatePassword,
  sendEmailVerification, sendPasswordResetEmail,
  verifyPasswordResetCode, confirmPasswordReset,
  EmailAuthProvider, reauthenticateWithCredential,
} from 'firebase/auth'

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
// (e.g. Capacitor/Electron) so it can never break startup.
if (measurementId) {
  isSupported()
    .then((supported) => { if (supported) getAnalytics(app) })
    .catch(() => {})
}

// Offline-first: keep a persistent IndexedDB cache so reads and writes work
// without a connection. Writes queue locally and flush to Firestore when the
// device comes back online (Spark plan — client SDK handles all syncing).
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
})

export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

setPersistence(auth, browserLocalPersistence).catch(() => {})

export {
  collection, query, where, getDocs, getCountFromServer, onSnapshot, runTransaction, writeBatch,
  serverTimestamp, Timestamp, waitForPendingWrites,
  doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, orderBy, limit, startAfter, Bytes,
  signInWithPopup, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, updatePassword, sendEmailVerification,
  sendPasswordResetEmail, verifyPasswordResetCode, confirmPasswordReset,
  EmailAuthProvider, reauthenticateWithCredential,
}
