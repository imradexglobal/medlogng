// Request authentication + server-side authorisation for the hub.
//
// The hub is not a Firebase client: the Admin SDK bypasses Security Rules, so
// every check the Rules would have made must be repeated here.
//
// Identity comes ONLY from a Firebase Auth ID token verified with the Admin
// SDK. Nothing else is trusted:
//   - no shared secret
//   - no `orgId` supplied by the body
//   - no `actor` object supplied by the client
//
// Authorisation is resolved server-side from the caller's membership document
// (`organization_memberships/{orgId}_{uid}`), exactly the same document the
// Rules use. A user may belong to several hospitals; the requested org is
// checked independently, so legitimate multi-org access keeps working while a
// forged orgId is rejected.

export class HttpError extends Error {
  constructor(status, message, code = '') {
    super(message)
    this.name = 'HttpError'
    this.status = Number(status) || 500
    this.code = code
    this.expose = true
  }
}

export const MEMBERSHIPS = 'organization_memberships'
export const SUPER_ADMINS = 'platform_admins'

export function membershipDocId(orgId, uid) {
  return String(orgId) + '_' + String(uid)
}

// Pure: mirrors src/features/admin/roles.js `can()` so the browser and the hub
// can never disagree about what a membership allows.
export function membershipHasCapability(membership, capability) {
  if (!membership || membership.status !== 'active') return false
  const caps = Array.isArray(membership.capabilities) ? membership.capabilities : []
  return caps.includes('*') || (!!capability && caps.includes(capability))
}

export function bearerToken(req) {
  const header = String(req?.headers?.authorization || '')
  const m = /^Bearer\s+([A-Za-z0-9._~+/=-]{20,8192})$/i.exec(header.trim())
  return m ? m[1] : ''
}

export function identityFromToken(decoded = {}) {
  return {
    uid: String(decoded.uid || decoded.sub || ''),
    email: String(decoded.email || ''),
    emailVerified: decoded.email_verified === true,
    displayName: String(decoded.name || ''),
    token: decoded,
  }
}

export function createAuthenticator({ auth = null, db = null, log = console, checkSuperAdmins = true } = {}) {
  async function verify(req) {
    const token = bearerToken(req)
    if (!token) {
      throw new HttpError(401, 'Sign-in required: send a Firebase ID token as "Authorization: Bearer <token>".', 'no_token')
    }
    if (!auth) {
      throw new HttpError(503, 'This hub has no authentication backend configured — ask the administrator to import the Firebase key.', 'auth_unavailable')
    }
    let decoded
    try {
      // Signature + expiry are always verified. checkRevoked is deliberately
      // false: it needs a live Google call and would make the hub unusable
      // during the very internet outages it exists for.
      decoded = await auth.verifyIdToken(token)
    } catch {
      throw new HttpError(401, 'Your sign-in token is invalid or has expired. Reload the app and sign in again.', 'bad_token')
    }
    const identity = identityFromToken(decoded)
    if (!identity.uid) throw new HttpError(401, 'The sign-in token has no user id.', 'bad_token')
    return identity
  }

  async function loadMembership(uid, orgId) {
    if (!db) return null
    const ref = db.collection(MEMBERSHIPS).doc(membershipDocId(orgId, uid))
    const snap = await ref.get()
    if (snap.exists) return snap.data() || null
    // Compatibility: a very old membership may not use the deterministic id.
    // The query is still scoped to BOTH the verified uid and the requested org.
    const q = await db.collection(MEMBERSHIPS)
      .where('user_id', '==', uid)
      .where('organization_id', '==', orgId)
      .limit(1)
      .get()
    return q.empty ? null : (q.docs[0].data() || null)
  }

  async function isSuperAdmin(uid) {
    if (!checkSuperAdmins || !db) return false
    try {
      const snap = await db.collection(SUPER_ADMINS).doc(uid).get()
      return snap.exists
    } catch {
      return false
    }
  }

  // Resolve and verify one (user, org, capability) triple. Returns an
  // authorisation context used by the request handler and the audit trail.
  async function authorize(identity, orgId, capability) {
    if (!db) {
      throw new HttpError(503, 'Firestore is not ready on this hub — the administrator must fix the service-account key.', 'db_unavailable')
    }
    if (!identity?.uid) throw new HttpError(401, 'Sign-in required.', 'no_identity')
    if (typeof orgId !== 'string' || !orgId) {
      throw new HttpError(400, 'Missing organization id.', 'no_org')
    }

    const superAdmin = await isSuperAdmin(identity.uid)
    const membership = superAdmin ? null : await loadMembership(identity.uid, orgId)

    if (!superAdmin) {
      if (!membership) {
        throw new HttpError(403, 'Your account is not a member of that hospital.', 'not_a_member')
      }
      if (membership.status !== 'active') {
        throw new HttpError(403, 'Your membership for that hospital is not active (status: ' + String(membership.status || 'unknown') + ').', 'inactive_member')
      }
      if (capability && !membershipHasCapability(membership, capability)) {
        throw new HttpError(403, 'Your role does not allow this operation (' + capability + ').', 'missing_capability')
      }
    }

    return {
      uid: identity.uid,
      email: identity.email,
      emailVerified: identity.emailVerified,
      displayName: identity.displayName || membership?.staff_name || '',
      orgId,
      capability: capability || '',
      membership,
      superAdmin,
    }
  }

  return { verify, authorize, loadMembership, isSuperAdmin }
}
