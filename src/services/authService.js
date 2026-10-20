import {
  auth, db, collection, query, where, getDocs, doc, getDoc, setDoc, addDoc, updateDoc,
  serverTimestamp, signInWithEmailAndPassword, signInWithPopup,
  googleProvider, createUserWithEmailAndPassword, signOut, onAuthStateChanged,
  updatePassword, sendEmailVerification, sendPasswordResetEmail,
  verifyPasswordResetCode, confirmPasswordReset, limit,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { authErrorMessage, registrationErrorMessage } from '../features/auth/errors.js'
import { validateNewPassword } from '../features/admin/roles.js'
import { generateOrgId, normalizeOrgId } from '../features/orgs/domain.js'
import { findInviteFor, acceptInvite, logAudit } from './adminService.js'
import { navigate } from '../router.js'
import { getDocsTolerant, getDocTolerant, isOffline } from '../lib/offlineRead.js'

export { authErrorMessage, registrationErrorMessage }

// ---- reads (live Firestore, no emulator) ---------------------------------

export async function loadMemberships(uid) {
  const q = query(collection(db, 'organization_memberships'), where('user_id', '==', uid))
  const snap = await getDocsTolerant(q)
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

// Return the membership for a specific organization (or null if not a member)
export function myMembershipForOrg(memberships, orgId) {
  return memberships.find((m) => m.organization_id === orgId) || null
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

export async function saveLastLogin(email) {
  try {
    localStorage.setItem('medilogng.lastLoggedInUser', email)
  } catch {}
}

export async function clearLastLogin() {
  try {
    localStorage.removeItem('medilogng.lastLoggedInUser')
  } catch {}
}

export async function attemptOfflineLogin() {
  // If user is already signed in (from browserLocalPersistence cache), they're handled
  // by the authStore subscription above which checks !s.user before calling this.
  // If we get here, there's no cached user, so we cannot auto-sign in without a password.
  // Just return false - the login form will show with the email pre-filled.
  return false
}

// Password reset by email — the path a signed-OUT user takes from the login
// screen. Firebase mails a link; the user opens it from their mail app and
// types the new password TWICE on the app's reset screen (the link returns
// here via handleCodeInApp). It is Auth-level on purpose (no membership
// lookup), so a pending or suspended account is not blocked from recovering
// its password.
export async function requestPasswordReset(email) {
  const mail = String(email || '').trim()
  if (!mail) throw new Error('Enter your email address.')
  const settings = resetReturnSettings()
  try {
    await sendPasswordResetEmail(auth, mail, settings)
    if (settings) {
      // The emailed link should be this URL + ?mode=resetPassword&oobCode=…
      console.info('[auth] Reset link will return to', settings.url)
    } else {
      console.warn('[auth] No in-app return URL for ' + window.location.protocol +
        '// pages (desktop build) — Firebase will host the reset page.')
    }
  } catch (e) {
    // Origin not in the project's Authorized domains (a fresh deploy, a dev
    // server on localhost, or a domain the admin never added) — resend with
    // Firebase's own hosted reset page instead of failing outright, so the
    // user still recovers. LOUD on purpose: the hosted page only offers a
    // single password field, losing the type-it-twice check.
    if (e && e.code === 'auth/unauthorized-continue-uri' && settings) {
      console.warn(
        '[auth] Reset email fell back to Firebase\'s hosted page — ' +
        window.location.origin + ' is not an Authorized domain. ' +
        'Add it in Firebase Console → Authentication → Settings → Authorized domains.',
      )
      await sendPasswordResetEmail(auth, mail)
      return
    }
    throw e
  }
}

// Where the emailed link should land: back in the app, on the reset screen,
// so the new password is typed twice there (see LoginView). Firebase only
// accepts http(s) origins that are in the project's Authorized domains — the
// desktop build (file://) is not one, so there the link falls back to
// Firebase's own hosted page, which still resets the password.
function resetReturnSettings() {
  try {
    const here = window.location.href.split('#')[0]
    if (!/^https?:$/.test(window.location.protocol)) return undefined
    return { url: here + '#/login', handleCodeInApp: true }
  } catch { return undefined }
}

// Validate the one-time code from the link and return the email it belongs to
// (an invalid/expired code throws — see authErrorMessage).
export async function verifyResetCode(code) {
  const c = String(code || '').trim()
  if (!c) throw new Error('The reset link is missing its code.')
  return await verifyPasswordResetCode(auth, c)
}

// Save the new password. The code is single-use: after this the link is dead,
// so the view strips it from the URL. The session is not signed in here — the
// user logs in with the new password. No audit row is written: this runs while
// signed out (logAudit keys off the current user), so there is nothing to
// attribute the reset to.
export async function completePasswordReset(code, newPw) {
  const err = validateNewPassword(newPw)
  if (err) throw new Error(err)
  const c = String(code || '').trim()
  if (!c) throw new Error('The reset link is missing its code.')
  await confirmPasswordReset(auth, c, newPw)
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
    email: email.trim(),
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
    email: email.trim(),
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

// The hospital name is cosmetic, so when we already know the org id from
// localStorage its lookup runs alongside the memberships query instead of
// after it. When we don't (first sign-in on this device) the id only comes out
// of the memberships result, so that one lookup has to wait for it.
async function resolveOrg(memberships, saved) {
  const orgId = saved || memberships[0]?.organization_id || null
  if (!orgId) return { orgId: null, name: '' }
  const org = await loadOrganization(orgId)
  return { orgId, name: org?.name || orgId }
}

export async function refreshSession() {
  const user = auth.currentUser
  if (!user) {
    authStore.setState({ user: null, memberships: [], activeOrg: null, activeOrgName: '', ready: true })
    return
  }
  let memberships = []
  let saved = null
  try { saved = localStorage.getItem('medilogng.activeOrg') } catch {}
  try {
    memberships = await loadMemberships(user.uid)
  } catch (e) {
    console.warn('[auth] loadMemberships failed:', e?.message)
  }
  // Resolve active org: use saved preference, otherwise first active membership
  let activeOrg = saved
  let activeOrgName = ''
  if (!activeOrg && memberships.length) {
    const firstActive = memberships.find((m) => m.status === 'active')
    activeOrg = firstActive ? firstActive.organization_id : null
  }
  // Load organization name if we have an active org
  if (activeOrg) {
    try {
      const org = await loadOrganization(activeOrg)
      if (org?.name) activeOrgName = org.name
    } catch {}
  }
  // If no saved active org and multiple memberships, store all memberships for UI switching
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
  // Query strings are stripped: a reset link (#/login?mode=resetPassword…) is
  // still the login screen and must not be bounced to /verify-email or
  // /change-password by the gates below.
  const hash = (window.location.hash || '').replace(/^#/, '').split('?')[0]
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
    if (t) { t.textContent = msg; t.hidden = false; return }
    // Pages without the app shell (login, verify-email, change-password) have
    // no #toast — build one on the body rather than blocking on alert(), which
    // the idle logout hits when a session expires on those screens.
    const el = document.createElement('div')
    el.className = 'toast'
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(() => { el.remove() }, 4500)
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
    // Offline: skip the round-trip entirely — the cached memberships are
    // already in the store, and a forced-logout check needs the server.
    if (isOffline()) return
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
  // If email verification required, redirect accordingly
  if (me?.email_verification_required && u && u.emailVerified === false) return '/verify-email'
  if (me?.must_change_password === true) return '/change-password'
  // If user has multiple active hospitals and no saved preference, show choice
  const { memberships, activeOrg } = authStore.getState()
  if (memberships.filter((m) => m.status === 'active').length > 1 && !localStorage.getItem('medilogng.activeOrg')) {
    return '/hospital-choice' // New route to show hospital selection
  }
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
// Bounded + cached per session (called on every modal).
const _staffCache = new Map()
export async function getClinicalStaff(orgId) {
  const cached = _staffCache.get(orgId)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.rows
  const snap = await getDocs(
    query(
      collection(db, 'organization_memberships'),
      where('organization_id', '==', orgId),
      where('status', '==', 'active'),
      limit(100),
    )
  )
  const clinicalRoles = ['hospital_admin', 'doctor', 'nurse']
  const rows = snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((m) => clinicalRoles.includes(m.role))
    .map((m) => ({
      value: m.staff_name || m.user_id,
      label: m.staff_name + (m.role ? ' (' + m.role + ')' : ''),
    }))
    .sort((a, b) => a.label.localeCompare(b.label))
  _staffCache.set(orgId, { at: Date.now(), rows })
  return rows
}
