// Administration data layer (direct Firestore, Spark plan: no backend).
// Every mutation is capability-gated by firestore.rules; failures surface
// as friendly messages. Mutations best-effort append an audit_events row.
import {
  auth, db, collection, query, where, getDocs, doc, getDoc, setDoc,
  addDoc, updateDoc, orderBy, limit, startAfter, serverTimestamp,
} from '../firebase.js'
import { authStore } from '../store/authStore.js'
import { ROLE_CAPS, can, isValidEmail, MAX_HOSPITAL_ADMINS, capsForRole, normalizeCaps } from '../features/admin/roles.js'
import { runChunk } from './pagination.js'
import { currentStaffName, rememberStaffName } from '../lib/staffName.js'

export function myMembership(orgId) {
  const { memberships } = authStore.getState()
  return memberships.find((m) => m.organization_id === orgId) || null
}

export function myAdminCaps(orgId) {
  const me = myMembership(orgId)
  return {
    me,
    canManageRoles: can(me, 'admin.roles.manage'),
    canManageDevices: can(me, 'admin.roles.manage') || can(me, 'admin.devices.manage'),
  }
}

export function friendlyAdminError(e, fallback) {
  const code = e?.code || ''
  if (code === 'permission-denied' || /permission|denied|allow/i.test(e?.message || '')) {
    return 'Not allowed — this needs an admin account with role-management rights.'
  }
  if (code === 'failed-precondition' || /index/i.test(e?.message || '')) {
    return 'This list needs a Firestore index — open the browser console link to create it, then retry.'
  }
  return (e?.message || fallback || 'Something went wrong. Please retry.')
}

// ---- audit ---------------------------------------------------------------
export async function logAudit({ action, organizationId, patientId = null, details = '' }) {
  try {
    const u = auth.currentUser
    if (!u) return
    await addDoc(collection(db, 'audit_events'), {
      actor_user_id: u.uid,
      actor_email: u.email || null,
      actor_name: currentStaffName() || null,
      actor_organization_id: organizationId,
      action,
      patient_id: patientId,
      details: String(details || '').slice(0, 500),
      occurredAt: serverTimestamp(),
    })
  } catch (e) {
    console.warn('[admin] audit append failed:', e?.message)
  }
}

// ---- members --------------------------------------------------------------
// Bounded to 100 rows (staff lists are small; paginate if a hospital grows
// past this — see listAudit for the cursor pattern).
export async function listMembers(orgId, { limitN = 100 } = {}) {
  const snap = await getDocs(
    query(collection(db, 'organization_memberships'), where('organization_id', '==', orgId), limit(limitN)),
  )
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
  const rank = { pending: 0, suspended: 1, rejected: 2, active: 3 }
  rows.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
  return rows
}

async function writeMember(mshipId, patch, audit) {
  await updateDoc(doc(db, 'organization_memberships', mshipId), {
    ...patch,
    updated_at: serverTimestamp(),
  })
  if (audit) await logAudit(audit)
}

// Max-admins guard: at most MAX_HOSPITAL_ADMINS ACTIVE hospital_admins.
// (Rules cannot count documents — client-enforced + audited. Race between
// two admins is a known, accepted MVP edge; the audit trail shows who acted.)
export async function countActiveAdmins(orgId) {
  const rows = await listMembers(orgId)
  return rows.filter((m) => m.status === 'active' && m.role === 'hospital_admin')
}

export async function ensureAdminSlot(orgId, targetMemberId, role) {
  if (role !== 'hospital_admin') return
  const admins = await countActiveAdmins(orgId)
  const already = admins.some((m) => m.id === targetMemberId)
  if (!already && admins.length >= MAX_HOSPITAL_ADMINS) {
    throw new Error(`Only ${MAX_HOSPITAL_ADMINS} hospital admins allowed — suspend or demote one first.`)
  }
}

export async function approveMember(m, role, caps) {
  const r = role || m.requested_role || m.role || 'receptionist'
  if (!ROLE_CAPS[r]) throw new Error('Unknown role: ' + r)
  const finalCaps = normalizeCaps(caps != null ? caps : capsForRole(r))
  if (!finalCaps.length) throw new Error('Capabilities required')
  await ensureAdminSlot(m.organization_id, m.id, r)
  await writeMember(m.id, {
    status: 'active',
    role: r,
    requested_role: m.requested_role || m.role || null,
    capabilities: finalCaps,
    approved_by: auth.currentUser?.uid || null,
    approved_at: serverTimestamp(),
  }, { action: 'member.approved', organizationId: m.organization_id, details: `${m.staff_name || m.user_id} → ${r} · caps=${finalCaps.length}` })
}

export async function rejectMember(m) {
  await writeMember(m.id, { status: 'rejected' },
    { action: 'member.rejected', organizationId: m.organization_id, details: m.staff_name || m.user_id })
}

export async function suspendMember(m) {
  await writeMember(m.id, { status: 'suspended', capabilities: [] },
    { action: 'member.suspended', organizationId: m.organization_id, details: m.staff_name || m.user_id })
}

export async function reactivateMember(m) {
  // Reactivate with existing capabilities; if empty, fall back to role defaults
  const caps = normalizeCaps((m.capabilities && m.capabilities.length) ? m.capabilities : capsForRole(m.role))
  await writeMember(m.id, { status: 'active', capabilities: caps },
    { action: 'member.reactivated', organizationId: m.organization_id, details: m.staff_name || m.user_id })
}

export async function updateMemberRole(m, role) {
  const r = role
  if (!ROLE_CAPS[r]) throw new Error('Unknown role: ' + r)
  if (m.user_id === auth.currentUser?.uid && r !== m.role) {
    throw new Error('You cannot change your own role — ask the other admin.')
  }
  await ensureAdminSlot(m.organization_id, m.id, r)
  // Role is a label now — capabilities are assigned per user and must survive
  // a role change. Only seed defaults when the member has none yet.
  const current = normalizeCaps(m.capabilities || [])
  const finalCaps = current.length ? current : normalizeCaps(capsForRole(r))
  await writeMember(m.id, { role: r, capabilities: finalCaps },
    { action: 'member.role_updated', organizationId: m.organization_id, details: `${m.staff_name || m.user_id} → ${r} · caps=${finalCaps.length}` })
}

export async function updateMemberCapabilities(m, caps) {
  if (m.user_id === auth.currentUser?.uid) {
    throw new Error('You cannot change your own capabilities — ask the other admin.')
  }
  const finalCaps = normalizeCaps(caps)
  if (!finalCaps.length) throw new Error('Capabilities required')
  await writeMember(m.id, { capabilities: finalCaps },
    { action: 'member.capabilities_updated', organizationId: m.organization_id, details: `${m.staff_name || m.user_id} · caps=${finalCaps.length}` })
}

export async function requirePasswordReset(m, required = true) {
  await writeMember(m.id, { must_change_password: required },
    { action: 'member.password_reset_required', organizationId: m.organization_id, details: `${m.staff_name || m.user_id} → ${required ? 'must change' : 'cleared'}` })
}

// Rename a staff member. The name is what every clinical record, report and
// printout shows instead of the sign-in email, so it is the one detail admins
// edit most. An admin may rename anyone, including themselves.
export async function updateMemberName(m, name) {
  const clean = String(name || '').replace(/\s+/g, ' ').trim()
  if (!clean) throw new Error('Staff name required')
  if (clean.length > 80) throw new Error('Staff name is too long (80 characters max)')
  if (clean === String(m.staff_name || '').trim()) return
  await writeMember(m.id, { staff_name: clean },
    { action: 'member.name_updated', organizationId: m.organization_id, details: `${m.staff_name || m.user_id || '—'} → ${clean}` })
  rememberStaffName({ userId: m.user_id, email: m.email, name: clean })
  // Renaming yourself must be visible in the shell without a reload.
  if (m.user_id === auth.currentUser?.uid) {
    const st = authStore.getState()
    authStore.setState({
      memberships: (st.memberships || []).map((x) => (x.id === m.id ? { ...x, staff_name: clean } : x)),
    })
  }
}

// ---- staff invites (admin pre-approves email + role; staff sets own password) --
export async function listInvites(orgId) {
  // Pushed to the server (was client-side filter over the full invite list).
  const snap = await getDocs(
    query(
      collection(db, 'staff_invites'),
      where('organization_id', '==', orgId),
      where('status', '==', 'pending'),
      limit(50),
    ),
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

export async function createInvite(orgId, email, role, caps) {
  const clean = String(email || '').trim().toLowerCase()
  if (!isValidEmail(clean)) throw new Error('Enter a valid email address')
  if (role && !ROLE_CAPS[role]) throw new Error('Select a role')
  await ensureAdminSlot(orgId, '(new invite)', role || 'receptionist')
  const finalCaps = normalizeCaps(caps != null ? caps : capsForRole(role))
  if (!finalCaps.length) throw new Error('Capabilities required')
  const ref = await addDoc(collection(db, 'staff_invites'), {
    organization_id: orgId,
    email: clean,
    role: role || 'receptionist',
    capabilities: finalCaps,
    status: 'pending',
    created_by: auth.currentUser?.uid || null,
    created_at: serverTimestamp(),
  })
  await logAudit({ action: 'invite.created', organizationId: orgId, details: `${clean} → ${role} · caps=${finalCaps.length}` })
  return ref.id
}

export async function revokeInvite(inv) {
  await updateDoc(doc(db, 'staff_invites', inv.id), { status: 'revoked', updated_at: serverTimestamp() })
  await logAudit({ action: 'invite.revoked', organizationId: inv.organization_id, details: inv.email })
}

export async function findInviteFor(orgId, email) {
  const clean = String(email || '').trim().toLowerCase()
  if (!clean) return null
  try {
    const snap = await getDocs(query(
      collection(db, 'staff_invites'),
      where('organization_id', '==', orgId),
      where('email', '==', clean),
      where('status', '==', 'pending'),
    ))
    if (snap.empty) return null
    return { id: snap.docs[0].id, ...snap.docs[0].data() }
  } catch {
    return null
  }
}

export async function acceptInvite(inv) {
  try {
    await updateDoc(doc(db, 'staff_invites', inv.id), { status: 'accepted', updated_at: serverTimestamp() })
  } catch (e) {
    console.warn('[admin] invite accept failed:', e?.message)
  }
}

// ---- organization ----------------------------------------------------------
export async function updateOrgProfile(orgId, { name, organization_type, state, lga }) {
  if (!name || !name.trim()) throw new Error('Facility name required')
  await updateDoc(doc(db, 'organizations', orgId), {
    name: name.trim(),
    organization_type: organization_type || null,
    state: state || null,
    lga: lga || null,
    updated_at: serverTimestamp(),
  })
  await logAudit({ action: 'org.updated', organizationId: orgId, details: name.trim() })
}

// ---- devices (org-scoped; admin-only control, option A) --------------------
function deviceId() {
  try {
    let id = localStorage.getItem('medilogng.deviceId')
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
      localStorage.setItem('medilogng.deviceId', id)
    }
    return id
  } catch {
    return 'dev_' + Math.random().toString(36).slice(2)
  }
}

export async function registerThisDevice(orgId) {
  const u = auth.currentUser
  if (!u) throw new Error('Sign in first')
  const id = deviceId()
  await setDoc(doc(db, 'devices', id), {
    user_id: u.uid,
    user_email: u.email || null,
    user_name: currentStaffName() || null,
    organization_id: orgId,
    device_name: (navigator.userAgentData?.platform || navigator.platform || 'desktop').slice(0, 80),
    platform: /android/i.test(navigator.userAgent) ? 'android' : 'windows',
    app_version: 'mvp-admin-1',
    last_seen: serverTimestamp(),
    status: 'active',
  }, { merge: true })
  return id
}

export async function listOrgDevices(orgId, { limitN = 50 } = {}) {
  const snap = await getDocs(
    query(collection(db, 'devices'), where('organization_id', '==', orgId), limit(limitN)),
  )
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
}

export async function setDeviceStatus(dev, status) {
  await updateDoc(doc(db, 'devices', dev.id), { status, updated_at: serverTimestamp() })
  await logAudit({
    action: status === 'revoked' ? 'device.revoked' : 'device.reactivated',
    organizationId: dev.organization_id,
    details: `${dev.device_name || dev.id} · ${staffNameForId(dev.user_id) || dev.user_name || dev.user_email || dev.user_id}`,
  })
}

// ---- audit listing (filter + chunked walk) ---------------------------------
export const AUDIT_PAGE = 25

export async function listAudit(orgId, { action = '', cursor = null } = {}) {
  const base = action
    ? query(
      collection(db, 'audit_events'),
      where('actor_organization_id', '==', orgId),
      where('action', '==', action),
      orderBy('occurredAt', 'desc'),
    )
    : query(
      collection(db, 'audit_events'),
      where('actor_organization_id', '==', orgId),
      orderBy('occurredAt', 'desc'),
    )
  try {
    const { docs, hasMore, cursor: next } = await runChunk(base, { pageSize: AUDIT_PAGE, cursor })
    return { rows: docs.map((d) => ({ id: d.id, ...d.data() })), hasMore, cursor: next }
  } catch (e) {
    // Missing composite index for the unfiltered feed: fall back to an
    // unordered org query + client-side sort. The fallback cannot be walked
    // with a cursor, so it always serves its single chunk and stops there.
    if (cursor || action) throw e
    const snap = await getDocs(query(
      collection(db, 'audit_events'),
      where('actor_organization_id', '==', orgId),
      limit(100),
    ))
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    rows.sort((a, b) => {
      const at = a.occurredAt?.toMillis ? a.occurredAt.toMillis() : 0
      const bt = b.occurredAt?.toMillis ? b.occurredAt.toMillis() : 0
      return bt - at
    })
    return { rows: rows.slice(0, AUDIT_PAGE), hasMore: false, cursor: null, fallback: true }
  }
}

export const AUDIT_ACTIONS = [
  '', 'member.approved', 'member.rejected', 'member.suspended', 'member.reactivated',
  'member.role_updated', 'member.capabilities_updated', 'member.password_reset_required', 'member.name_updated', 'invite.created',
  'invite.revoked', 'invite.accepted', 'org.updated', 'device.revoked',
  'device.reactivated', 'password.changed', 'email.verified',
  'data.template', 'data.export', 'data.staged', 'data.push',
  'hub.op.delivered', 'hub.op.failed',
]
