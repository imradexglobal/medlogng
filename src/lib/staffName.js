// Staff display names — the one place that answers "who did this?".
//
// Firebase Auth only carries an email (displayName is empty for email/password
// signups), so records used to store `user.email` wherever a person's name
// belonged. Everything now writes currentStaffName() instead — the membership's
// `staff_name`, which the admin can rename from Administration → Staff & roles.
//
// staffLabel() is the read-side complement: rows written before that change (and
// rows whose actor never had a staff name) still hold an email or uid, so it maps
// those back to the staff name using a small per-org directory (memberships +
// devices) that the router loads once per hospital before a view mounts. Values
// that already are names — or that cannot be resolved — pass through untouched.
import { db, collection, query, where, limit } from '../firebase.js'
import { getDocsTolerant } from './offlineRead.js'
import { authStore } from '../store/authStore.js'

function activeMembership(orgId) {
  const { memberships } = authStore.getState()
  if (!memberships || !memberships.length) return null
  return (orgId && memberships.find((m) => m.organization_id === orgId && m.status === 'active'))
    || memberships.find((m) => m.status === 'active')
    || null
}

// Name of the signed-in user for the current hospital. Write sites store this
// in `*_name` / `by` fields so lists, reports and printouts show a person, not
// an email address.
export function currentStaffName() {
  const { user, activeOrg } = authStore.getState()
  const me = activeMembership(activeOrg)
  const name = (me && me.staff_name) || user?.displayName || ''
  if (String(name).trim()) return String(name).trim()
  return user?.email || ''
}

const byId = new Map() // user_id → staff_name
const byEmail = new Map() // email (lowercased) → staff_name
let loadedFor = null
let loading = null

function emailLabel(email) {
  const local = String(email || '').split('@')[0].replace(/[._-]+/g, ' ').trim()
  return local ? local.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Staff member'
}

// Resolve a stored actor value (email, uid, or an already-written name) for
// display. Synchronous by design — views render straight to HTML strings.
export function staffLabel(value) {
  if (value == null) return value
  const s = String(value).trim()
  if (!s) return value
  const uid = s.includes('_') ? s.split('_').slice(1).join('_') : s
  const known = byId.get(s) || byId.get(uid) || staffNameForId(s) || staffNameForId(uid) || byEmail.get(s.toLowerCase())
  if (known) return known
  if (/^[A-Z0-9_-]{20,}$/i.test(s)) return 'Staff member'
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return emailLabel(s)
  return value
}

// Audit details can contain a uid inside prose (for example, an older
// "uid → role" entry), so resolve or hide uid-shaped tokens in the full text.
export function staffText(value) {
  if (value == null) return value
  return String(value).replace(/\b[A-Z0-9_-]{20,40}\b/gi, (token) => staffLabel(token))
}

// Name for a uid, or '' when unknown — for callers that need to tell "resolved
// to a name" apart from "fell back to the raw value".
export function staffNameForId(userId) {
  if (!userId) return ''
  const cached = byId.get(userId)
  if (cached) return cached
  // Membership ids are stored as `${orgId}_${uid}`; unwrap to the uid.
  const uid = String(userId).includes('_') ? String(userId).split('_').slice(1).join('_') : userId
  if (uid !== userId) {
    const cached2 = byId.get(uid)
    if (cached2) { rememberStaffName({ userId, name: cached2 }); return cached2 }
  }
  const membership = authStore.getState().memberships?.find((m) => (m.user_id === userId || m.user_id === uid) && m.staff_name)
  if (membership?.staff_name) {
    rememberStaffName({ userId, email: membership.email, name: membership.staff_name })
    if (uid !== userId) rememberStaffName({ userId: uid, email: membership.email, name: membership.staff_name })
    return String(membership.staff_name).trim()
  }
  return ''
}

// Human-readable fallback for UI that has a staff record but no saved name.
// Keep Firebase ids available to application logic without exposing them as labels.
export function staffDisplayName({ staff_name, email, user_id, user_name } = {}) {
  const known = staff_name || user_name || staffNameForId(user_id) || staffLabel(email)
  if (known && String(known).trim()) {
    const label = String(known).trim()
    if (email && label === email) return emailLabel(email)
    return label
  }
  return 'Staff member'
}

// Keep the directory in step when a member is renamed (or registered) so the
// next render shows the new name without a reload.
export function rememberStaffName({ userId, email, name }) {
  const clean = String(name || '').trim()
  if (!clean) return
  if (userId) byId.set(userId, clean)
  if (email) byEmail.set(String(email).trim().toLowerCase(), clean)
}

// Load once per hospital: members (uid → name, email → name) plus the device
// registry, which is the only place that pairs a user's email with their uid
// for members who joined before memberships stored an email. Never throws —
// a missing directory only means rows keep showing whatever was stored.
export function ensureStaffDirectory(orgId) {
  if (!orgId) return Promise.resolve()
  if (loadedFor === orgId) return Promise.resolve()
  if (loading && loading.orgId === orgId) return loading.promise
  const { user, memberships } = authStore.getState()
  // Memberships are already in the auth store for this session. Seed their
  // names immediately so labels work even if the directory read is denied.
  memberships?.forEach((m) => {
    if (m.organization_id === orgId && m.staff_name) {
      rememberStaffName({ userId: m.user_id, email: m.email, name: m.staff_name })
    }
  })
  const me = activeMembership(orgId)
  if (user?.uid && me?.staff_name) rememberStaffName({ userId: user.uid, email: user.email, name: me.staff_name })
  const promise = (async () => {
    try {
      const snap = await getDocsTolerant(query(
        collection(db, 'organization_memberships'),
        where('organization_id', '==', orgId),
        limit(100),
      ))
      snap.docs.forEach((d) => {
        const m = d.data()
        if (m.user_id && m.staff_name) rememberStaffName({ userId: m.user_id, name: m.staff_name })
        if (m.email && m.staff_name) rememberStaffName({ email: m.email, name: m.staff_name })
      })
    } catch {
      // Pending members may only read their own row — skip quietly.
    }
    try {
      const snap = await getDocsTolerant(query(
        collection(db, 'devices'),
        where('organization_id', '==', orgId),
        limit(50),
      ))
      snap.docs.forEach((d) => {
        const dev = d.data()
        if (!dev.user_email) return
        const name = dev.user_name || (dev.user_id && byId.get(dev.user_id))
        if (name) rememberStaffName({ email: dev.user_email, name })
      })
    } catch {
      // Devices are admin-only — non-admins just don't get the extra mapping.
    }
    loadedFor = orgId
    if (loading && loading.orgId === orgId) loading = null
  })()
  loading = { orgId, promise }
  return promise
}
