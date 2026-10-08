import {
  auth, db, collection, query, where, getDocs, doc, getDoc, setDoc, addDoc, updateDoc,
  serverTimestamp, signInWithEmailAndPassword, signInWithPopup,
  googleProvider, createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, sendEmailVerification,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { authErrorMessage, registrationErrorMessage } from '../features/auth/errors.js'
import { validateNewPassword } from '../features/admin/roles.js'
import { generateOrgId, normalizeOrgId } from '../features/orgs/domain.js'
import { findInviteFor, acceptInvite, logAudit } from './adminService.js'
import { navigate } from '../router.js'

export { authErrorMessage, registrationErrorMessage }

// ---- reads (live Firestore, no emulator) ---------------------------------

export async function loadMemberships(uid) {
  const q = query(collection(db, 'organization_memberships'), where('user_id', '==', uid))
  const snap = await getDocs(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

export async function loadOrganization(orgId) {
  if (!orgId) return null
  try {
    const snap = await getDoc(doc(db, 'organizations', orgId))
    return snap.exists() ? { id: snap.id, ...snap.data() } : null
  } catch {
    return null
  }
}

// ---- auth -----------------------------------------------------------------

export async function loginEmail(email, password) {
  await signInWithEmailAndPassword(auth, email.trim(), password)
  // onAuthStateChanged listener refreshes store + memberships.
}

export async function loginGoogle() {
  const result = await signInWithPopup(auth, googleProvider)
  // Return user + a snapshot of their memberships so the caller can decide
  // whether to dashboard, create, or join.
  const uid = result.user.uid
  let memberships = []
  try {
    const q = query(collection(db, 'organization_memberships'), where('user_id', '==', uid))
    const snap = await getDocs(q)
    memberships = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  } catch (e) {
    console.warn('[auth] loadMemberships after Google sign-in failed:', e?.message)
  }
  const activeMship = memberships.find((m) => m.status === 'active')
  return { user: result.user, memberships, activeMship, allMships: memberships }
}

export async function logout() {
  await signOut(auth)
  authStore.setState({ user: null, memberships: [], activeOrg: null, activeOrgName: '' })
  try { localStorage.removeItem('medilogng.activeOrg') } catch {}
}

// ---- registration (direct Firestore writes, per firestore.rules) ----------
// New hospital: org + founding membership created 'active' (creator-owned,
// so nobody can self-activate into someone else's hospital).
// Join hospital: membership stays 'pending' until an admin approves.

export async function registerNewHospital({ name, email, password, orgName, orgType, state, lga }) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password)
  const uid = cred.user.uid
  try { await cred.user.getIdToken(true) } catch {}

  // Organization IDs are human-readable: XXX-XXX-XXX, letters only.
  let newOrgId = null
  for (let i = 0; i < 5 && !newOrgId; i++) {
    const cand = generateOrgId()
    const existing = await getDoc(doc(db, 'organizations', cand))
    if (!existing.exists()) newOrgId = cand
  }
  if (!newOrgId) throw new Error('Could not allocate an organization ID — please retry.')
  const orgRef = doc(db, 'organizations', newOrgId)
  await setDoc(orgRef, {
    name: orgName.trim(),
    organization_type: orgType,
    state: state.trim(),
    lga: lga?.trim() || null,
    status: 'active',
    created_by: uid,
    created_at: serverTimestamp(),
  })

  const mshipId = `${orgRef.id}_${uid}`
  const mship = {
    organization_id: orgRef.id,
    user_id: uid,
    staff_name: name.trim(),
    role: 'hospital_admin',
    status: 'active',
    capabilities: ['*'],
    // New accounts must verify email; admins clear it by verifying.
    email_verification_required: true,
    must_change_password: false,
    created_at: serverTimestamp(),
  }
  try {
    await setDoc(doc(db, 'organization_memberships', mshipId), mship)
  } catch (firstErr) {
    // The auth token right after sign-up can be stale for rules that call
    // get() on the freshly created org doc — refresh once and retry before
    // giving up. If it still fails, attach the orgId: the organization doc
    // already exists in Firestore, so the UI must say so (recovery path)
    // instead of a generic failure.
    console.warn('[auth] founding membership write failed, refreshing token and retrying:', firstErr)
    try { await cred.user.getIdToken(true) } catch {}
    try {
      await setDoc(doc(db, 'organization_memberships', mshipId), mship)
    } catch (secondErr) {
      secondErr.orgId = orgRef.id
      secondErr.stage = 'founding-membership'
      throw secondErr
    }
  }

  try { await sendEmailVerification(cred.user) } catch {}

  await refreshSession()
  // refreshSession depends on the membership list query; if that read lags
  // (or is denied) the welcome screen would show a blank org — pin the
  // just-created hospital explicitly so success is never ambiguous.
  const { activeOrg } = authStore.getState()
  if (!activeOrg) setActiveOrg(orgRef.id, orgName.trim())
  return orgRef.id
}

export async function registerJoinHospital({ name, email, password, organizationId, role }) {
  const cred = await createUserWithEmailAndPassword(auth, email.trim(), password)
  const uid = cred.user.uid
  try { await cred.user.getIdToken(true) } catch {}

  const orgId = normalizeOrgId(organizationId)
  const mshipId = `${orgId}_${uid}`
  // Staff-created flow: if an admin pre-created an invite for this email,
  // inherit its role/capabilities and require email verification.
  const invite = await findInviteFor(orgId, email)
  await setDoc(doc(db, 'organization_memberships', mshipId), {
    organization_id: orgId,
    user_id: uid,
    staff_name: name.trim(),
    requested_role: role,
    role: invite?.role || role,
    status: 'pending',
    capabilities: invite?.capabilities || [],
    email_verification_required: true,
    must_change_password: false,
    created_at: serverTimestamp(),
  })
  if (invite) {
    await acceptInvite(invite)
    await logAudit({
      action: 'invite.accepted', organizationId: orgId,
      details: `${email.trim()} claimed invite → ${invite.role}`,
    })
  }
  try { await sendEmailVerification(cred.user) } catch {}

  await refreshSession()
  return orgId
}

// ---- session ---------------------------------------------------------------

export async function refreshSession() {
  const user = auth.currentUser
  if (!user) {
    authStore.setState({ user: null, memberships: [], activeOrg: null, activeOrgName: '', ready: true })
    return
  }
  let memberships = []
  try {
    memberships = await loadMemberships(user.uid)
  } catch (e) {
    console.warn('[auth] loadMemberships failed:', e?.message)
  }
  let saved = null
  try { saved = localStorage.getItem('medilogng.activeOrg') } catch {}
  const activeOrg = saved || memberships[0]?.organization_id || null
  let activeOrgName = ''
  if (activeOrg) {
    const org = await loadOrganization(activeOrg)
    activeOrgName = org?.name || activeOrg
  }
  authStore.setState({
    user: { uid: user.uid, email: user.email, displayName: user.displayName },
    memberships,
    activeOrg,
    activeOrgName,
    ready: true,
  })
}

export function setActiveOrg(orgId, orgName = '') {
  authStore.setState({ activeOrg: orgId, activeOrgName: orgName || orgId })
  try {
    if (orgId) localStorage.setItem('medilogng.activeOrg', orgId)
    else localStorage.removeItem('medilogng.activeOrg')
  } catch {}
}

export function initAuthListener() {
  onAuthStateChanged(auth, async () => {
    await refreshSession()
  })
}

// ---- post-auth enforcement (email verification + forced password change) ---
// Grandfathering: only memberships carrying email_verification_required are
// hard-blocked. Older memberships without the flag just see a banner.

export function myActiveMembership() {
  const { memberships, activeOrg } = authStore.getState()
  return memberships.find((m) => m.organization_id === activeOrg) || memberships[0] || null
}

// Sync guard used by the router on every navigation (no reload here).
// Suspended/rejected members are signed out on the spot using cached state;
// the background watcher below refreshes that state.
export function checkAccess() {
  const { ready, user } = authStore.getState()
  const u = auth.currentUser
  if (!ready || !user || !u) return null
  const hash = (window.location.hash || '').replace(/^#/, '')
  if (hash === '/login' || hash === '/register' || hash === '/verify-email' || hash === '/change-password') return null
  const me = myActiveMembership()
  if (!me) return null
  if (me.status === 'suspended' || me.status === 'rejected') {
    forceLogout('Your access was ' + me.status + ' by an administrator.')
    return '/login'
  }
  if (me.email_verification_required && u.emailVerified === false) return '/verify-email'
  if (me.must_change_password === true) return '/change-password'
  return null
}

let loggingOut = false
export async function forceLogout(reason) {
  if (loggingOut) return
  loggingOut = true
  try {
    await logout()
    try { toast(reason) } catch {}
    navigate('/login')
  } finally {
    setTimeout(() => { loggingOut = false }, 2000)
  }
  function toast(msg) {
    const t = document.getElementById('toast')
    if (t) { t.textContent = msg; t.hidden = false }
    else alert(msg)
  }
}

// Background watch: refresh my memberships every 5 min + whenever the tab
// regains focus or connectivity returns. Suspended/rejected staff are
// automatically logged out, on this device, without admin follow-up.
let watchStarted = false
export function startAccessWatch() {
  if (watchStarted) return
  watchStarted = true
  async function poll() {
    const u = auth.currentUser
    if (!u || loggingOut) return
    let memberships = []
    try {
      memberships = await loadMemberships(u.uid)
    } catch { return }
    authStore.setState({ memberships })
    const me = myActiveMembership()
    if (me && (me.status === 'suspended' || me.status === 'rejected')) {
      await forceLogout('Your access was ' + me.status + ' by an administrator.')
    }
  }
  setInterval(poll, 5 * 60 * 1000)
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll() })
  window.addEventListener('online', poll)
}

// Decides where to land right after sign-in/up (reloads Auth + session first).
export async function postLoginRoute() {
  await refreshSession()
  const u = auth.currentUser
  try { await u?.reload() } catch {}
  const me = myActiveMembership()
  if (me?.email_verification_required && u && u.emailVerified === false) return '/verify-email'
  if (me?.must_change_password === true) return '/change-password'
  return '/'
}

export async function sendVerificationEmail() {
  const u = auth.currentUser
  if (!u) throw new Error('Sign in first')
  await sendEmailVerification(u)
}

// Returns 'verified' | 'pending' (reloads Auth, clears own flag when done).
export async function confirmEmailVerified() {
  const u = auth.currentUser
  if (!u) throw new Error('Sign in first')
  await u.reload()
  if (!u.emailVerified) return 'pending'
  // Force ID token refresh so request.auth.token.email_verified is true in rules.
  try { await u.getIdToken(true) } catch {}
  const { memberships } = authStore.getState()
  for (const m of memberships.filter((x) => x.email_verification_required)) {
    try {
      await updateDoc(doc(db, 'organization_memberships', m.id), { email_verification_required: false })
    } catch (e) {
      console.warn('[auth] clear verification flag failed:', e?.message)
    }
  }
  await logAudit({ action: 'email.verified', organizationId: memberships[0]?.organization_id || 'none' })
  await refreshSession()
  return 'verified'
}

// Change own password, then clear the forced-change flag on my memberships.
export async function changeOwnPassword(newPw) {
  const err = validateNewPassword(newPw)
  if (err) throw new Error(err)
  const u = auth.currentUser
  if (!u) throw new Error('Sign in first')
  try {
    await updatePassword(u, newPw)
  } catch (e) {
    if (e?.code === 'auth/requires-recent-login') {
      throw new Error('For security, sign out and sign in again, then change your password.')
    }
    throw e
  }
  const { memberships } = authStore.getState()
  for (const m of memberships.filter((x) => x.must_change_password)) {
    try {
      await updateDoc(doc(db, 'organization_memberships', m.id), { must_change_password: false })
    } catch (e) {
      console.warn('[auth] clear must_change_password failed:', e?.message)
    }
  }
  await logAudit({ action: 'password.changed', organizationId: memberships[0]?.organization_id || 'none' })
  await refreshSession()
}

// Get active clinical staff for the current organization (doctors, nurses, admins)
export async function getClinicalStaff(orgId) {
  const snap = await getDocs(
    query(
      collection(db, 'organization_memberships'),
      where('organization_id', '==', orgId),
      where('status', '==', 'active')
    )
  )
  const clinicalRoles = ['hospital_admin', 'doctor', 'nurse']
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => clinicalRoles.includes(m.role))
    .map((m) => ({
      value: m.staff_name || m.user_id,
      label: m.staff_name + (m.role ? ' (' + m.role + ')' : ''),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
}
