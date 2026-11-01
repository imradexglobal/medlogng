import {
  auth, db, collection, query, where, getDocs, doc, getDoc, setDoc, addDoc, updateDoc,
  serverTimestamp, signInWithEmailAndPassword, signInWithPopup,
  googleProvider, createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, sendEmailVerification, sendPasswordResetEmail,
  verifyPasswordResetCode, confirmPasswordReset, limit,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { authErrorMessage, registrationErrorMessage } from '../features/auth/errors.js'
import { validateNewPassword, capsForRole } from '../features/admin/roles.js'
import { generateOrgId, normalizeOrgId } from '../features/orgs/domain.js'
import { findInviteFor, acceptInvite, logAudit } from './adminService.js'
import { navigate } from '../router.js'
import { getDocsTolerant, getDocTolerant, isOffline } from '../lib/offlineRead.js'

export { authErrorMessage, registrationErrorMessage }

export async function saveLastLogin(email) {
  // Best-effort only: this is a convenience stamp (last-visited email for the
  // login screen), never a gate. The `users` collection has no Firestore rule
  // of its own, so a fresh project denies the write outright — a bare
  // permission-denied there used to abort login with the generic "Something
  // went wrong" message, because the Firebase sign-in itself had already
  // succeeded. Swallowing it here keeps the stamp optional without hiding
  // real failures anywhere else.
  try {
    const userRef = doc(db, 'users', email)
    await setDoc(userRef, { lastLogin: serverTimestamp() }, { merge: true })
  } catch (e) {
    console.warn('[auth] saveLastLogin skipped:', e?.message || e)
  }
}

export async function logout() {
  await signOut(auth)
}

export async function setActiveOrg(orgId, orgName) {
  const store = authStore.getState()
  store.activeOrg = orgId
  store.activeOrgName = orgName || ''
  await saveLastLogin(store.user.email)
}

export function myActiveMembership() {
  const store = authStore.getState()
  return store.memberships.find((m) => m.organization_id === store.activeOrg) || null
}

export async function forceLogout(reason) {
  await signOut(auth)
}

export async function attemptOfflineLogin() {
  // Try to log in with stored credentials for offline mode
  // This would check localStorage or IndexedDB for saved auth state
  return false
}

export async function refreshSession() {
  // Refresh the auth session
  return true
}

export function initAuthListener() {
  if (listenerSet) return
  listenerSet = true
  // Firebase restores the session from local storage on cold load, so the
  // first callback can arrive with a user before memberships are loaded. The
  // router guard gates on `ready`, so this is the ONLY place that flips it —
  // an empty stub here left the app on the boot splash forever.
  onAuthStateChanged(auth, async (u) => {
    let memberships = []
    if (u) {
      // Never let a dead connection stall the boot: race the membership read
      // against a hard deadline. getDocsTolerant already falls back to the
      // IndexedDB cache on timeout; this deadline only covers the case where
      // the cache is empty too (cold first load, offline).
      memberships = await Promise.race([
        loadMemberships(u.uid).catch(() => []),
        new Promise((res) => setTimeout(() => res([]), 8000)),
      ])
    }
    const store = authStore.getState()
    // Keep the active hospital across reloads when the user is still a
    // member; otherwise drop it so HospitalChoiceView re-picks.
    let activeOrg = store.activeOrg
    let activeOrgName = store.activeOrgName
    if (activeOrg && !memberships.some((m) => m.organization_id === activeOrg && m.status === 'active')) {
      activeOrg = null
      activeOrgName = ''
    }
    authStore.setState({
      user: u ? { uid: u.uid, email: u.email, displayName: u.displayName } : null,
      memberships,
      activeOrg,
      activeOrgName,
      ready: true,
    })
  })
}

let listenerSet = false

export async function verifyResetCode(code) {
  return await verifyPasswordResetCode(auth, code)
}

export async function completePasswordReset(code, np) {
  await confirmPasswordReset(auth, code, np)
}

export async function loginGoogle() {
  await signInWithPopup(auth, googleProvider)
}

export async function postLoginRoute() {
  // Determine where to navigate after login
  const store = authStore.getState()
  if (store.activeOrg) return '/'
  // A user with active memberships but no hospital selected must pick one —
  // sending them to /welcome (which renders DashboardView) just shows the
  // "not linked to a hospital" error. Route them to the chooser instead.
  const hasActive = store.memberships.some((m) => m.status === 'active')
  return hasActive ? '/hospital-choice' : '/welcome'
}

export async function registerNewHospital(data) {
  // Create a new hospital/organization
  const orgId = generateOrgId()
  await setDoc(doc(db, 'organizations', orgId), {
    name: data.name,
    organization_type: data.orgType,
    state: data.state,
    lga: data.lga,
    created_at: serverTimestamp(),
  })
  // Create admin invitation
  await createInvite(orgId, data.email, 'admin', { name: data.name })
  // Create founding membership (active) for the hospital creator
  const u = auth.currentUser
  if (u) {
    await setDoc(doc(db, 'organization_memberships', orgId + '_' + u.uid), {
      user_id: u.uid,
      organization_id: orgId,
      status: 'active',
      role: 'hospital_admin',
      capabilities: ['*'],
    })
  }
  return orgId
}

export async function registerJoinHospital(data) {
  // Join existing hospital by sending invitation
  const orgId = data.organizationId
  await createInvite(orgId, data.email, data.role, { name: data.name })
  return true
}

export async function requestPasswordReset(email) {
  await sendPasswordResetEmail(auth, email)
}

// Send the email-verification link to the signed-in user.
export async function sendVerificationEmail() {
  const u = auth.currentUser
  if (!u) throw new Error('Not signed in')
  await sendEmailVerification(u)
}

// Check whether the signed-in user's email is now verified. Returns
// 'verified' or 'pending' (never throws — the caller decides what to show).
export async function confirmEmailVerified() {
  const u = auth.currentUser
  if (!u) return 'pending'
  await u.reload()
  return u.emailVerified ? 'verified' : 'pending'
}

// Change the signed-in user's own password (forced-change gate and the
// account settings screen). Uses Firebase updatePassword, which requires
// recent sign-in — the gate screens run right after login, so that holds.
export async function changeOwnPassword(newPassword) {
  const u = auth.currentUser
  if (!u) throw new Error('Not signed in')
  await updatePassword(u, newPassword)
}

export function checkAccess() {
  const path = String(window.location.hash || '').replace(/^#/, '').split('?')[0]
  const { user } = authStore.getState()
  if (!user && path !== '/login' && path !== '/register') return '/login'
  return undefined
}

export function startAccessWatch() {
  // Periodic access check hook; router guard handles redirects.
}

export async function loadMemberships(uid) {
  const q = query(collection(db, 'organization_memberships'), where('user_id', '==', uid))
  const snap = await getDocsTolerant(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// Return the membership for a specific organization (or null if not a member)
export function myMembershipForOrg(memberships, orgId) {
  return memberships.find((m) => m.organization_id === orgId) || null
}

// Clinical staff directory for an organization: every active member, as
// { value, label } options for dropdowns (admitting doctor, encounter
// clinician, etc.). `value` is the membership id (what gets written to the
// record); `label` is the human name, falling back to email when no
// staff_name was set. Never throws — callers `.catch(() => [])`.
export async function getClinicalStaff(orgId) {
  if (!orgId) return []
  const snap = await getDocsTolerant(
    query(collection(db, 'organization_memberships'), where('organization_id', '==', orgId), limit(100)),
  )
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const rank = { pending: 0, suspended: 1, rejected: 2, active: 3 }
  rows.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
  return rows
    .filter((m) => m.status === 'active')
    .map((m) => ({
      value: m.id,
      label: String(m.staff_name || m.email || m.user_id || m.id).trim(),
    }))
}

export async function loadOrganization(orgId) {
  if (!orgId) return null
  try {
    const snap = await getDocTolerant(doc(db, 'organizations', orgId))
    return snap.exists() ? { id: snap.id, ...snap.data() } : null
  } catch {
    return null
  }
}

// ---- auth -----------------------------------------------------------------

export async function loginEmail(email, password) {
  await signInWithEmailAndPassword(auth, email.trim(), password)
  await saveLastLogin(email)
  // onAuthStateChanged listener refreshes store + memberships.
}

// ... rest of the file unchanged