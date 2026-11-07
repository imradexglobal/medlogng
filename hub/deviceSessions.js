// Host-issued offline device-session authorization for signed LAN reads and
// handoffs. It is not an audio-transcription permission or backend.
// The browser keeps a non-exportable P-256 private key in IndexedDB; the Host
// keeps only its public key and the last live-verified encounter.edit grant.
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'

const DEVICE_ID_RE = /^[A-Za-z0-9_-]{43}$/
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000

function deviceIdFor(publicKey) {
  const key = createPublicKey({ key: publicKey, format: 'jwk' })
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw Object.assign(new Error('Only P-256 client keys are supported.'), { status: 400, expose: true })
  }
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('base64url')
}

function canonicalPublicKey(publicKey) {
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256' ||
      typeof publicKey.x !== 'string' || typeof publicKey.y !== 'string') {
    throw Object.assign(new Error('Invalid Device device public key.'), { status: 400, expose: true })
  }
  const key = { kty: 'EC', crv: 'P-256', x: publicKey.x, y: publicKey.y, ext: true, key_ops: ['verify'] }
  deviceIdFor(key)
  return key
}

export function deviceProofPayload({ method, url, requestId = '', contentType = '', bodyHash = '', timestamp, nonce }) {
  return [String(method || '').toUpperCase(), String(url || ''), String(requestId || ''),
    String(contentType || '').toLowerCase(), String(bodyHash || '').toLowerCase(), String(timestamp || ''), String(nonce || '')].join('\n')
}

function snapshotFor({ identity, authorization, orgId, publicKey, deviceId }) {
  const membership = authorization.membership || null
  const permissions = authorization.superAdmin ? ['*']
    : (Array.isArray(membership?.capabilities) && membership.capabilities.length
      ? membership.capabilities.slice(0, 500).map(String) : ['read'])
  return {
    deviceId,
    uid: identity.uid,
    orgId,
    active: true,
    permissions,
    membership: membership ? {
      status: String(membership.status || ''),
      capabilities: Array.isArray(membership.capabilities) ? membership.capabilities.slice(0, 500).map(String) : [],
      staff_name: String(membership.staff_name || '').slice(0, 160),
    } : null,
    superAdmin: !!authorization.superAdmin,
    email: String(identity.email || '').slice(0, 254),
    displayName: String(authorization.displayName || identity.displayName || '').slice(0, 160),
    publicKey,
    issuedAt: Date.now(),
    lastVerifiedAt: Date.now(),
  }
}

export function createDeviceSessions({ load = async () => '[]', save = async () => {}, log = console,
  clock = Date.now } = {}) {
  const sessions = new Map()
  const usedNonces = new Map()
  const processStartedAt = clock()
  let ready = false
  let writeChain = Promise.resolve()

  function saveAll() {
    const snapshot = JSON.stringify([...sessions.values()])
    writeChain = writeChain.catch(() => {}).then(() => save(snapshot))
    return writeChain
  }

  async function initialize() {
    let parsed = []
    try {
      const raw = await load()
      parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!Array.isArray(parsed)) throw new Error('Host device-session state must be an array.')
    } catch (error) {
      log.error('[Device] local session state could not be loaded; refusing offline sessions:', error?.message || error)
      throw new Error('Host device-session state is unavailable; local offline authorization is disabled.')
    }
    for (const row of parsed.slice(-5000)) {
      try {
        if (!row?.active || !row.uid || !row.orgId || !DEVICE_ID_RE.test(row.deviceId) ||
        !Array.isArray(row.permissions) || !row.permissions.length) continue
        const key = canonicalPublicKey(row.publicKey)
        if (deviceIdFor(key) !== row.deviceId) continue
        sessions.set(row.deviceId, row)
      } catch { /* discard malformed or inconsistent local records */ }
    }
    ready = true
    await saveAll()
  }

  async function register({ identity, authorization, orgId, publicKey }) {
    if (!ready) throw Object.assign(new Error('Device local-session service is not ready.'), { status: 503, expose: true })
    if (!identity?.uid || !orgId || authorization?.uid !== identity.uid || authorization?.orgId !== orgId ||
        (!authorization?.superAdmin && authorization?.membership?.status !== 'active')) {
      throw Object.assign(new Error('An online active hospital membership is required to register this device.'), { status: 403, expose: true })
    }
    const normalizedKey = canonicalPublicKey(publicKey)
    const deviceId = deviceIdFor(normalizedKey)
    const old = sessions.get(deviceId)
    if (old && (old.uid !== identity.uid || old.orgId !== orgId)) {
      throw Object.assign(new Error('This device key is already bound to another clinician or hospital. Sign out on that account first.'), { status: 409, expose: true })
    }
    const row = snapshotFor({ identity, authorization, orgId, publicKey: normalizedKey, deviceId })
    sessions.set(deviceId, row)
    await saveAll()
    return { deviceId, uid: row.uid, orgId: row.orgId, email: row.email, displayName: row.displayName,
      membership: row.membership, permissions: row.permissions, lastVerifiedAt: row.lastVerifiedAt }
  }

  function authenticate(req, expectedOrgId = '', requiredCapability = 'encounter.edit') {
    if (!ready) throw Object.assign(new Error('Device local-session service is not ready.'), { status: 503, expose: true })
    const deviceId = String(req.headers['x-device-device'] || '')
    const row = sessions.get(deviceId)
    if (!row?.active || !DEVICE_ID_RE.test(deviceId) ||
        (expectedOrgId && row.orgId !== expectedOrgId) || !row.permissions?.length ||
        (requiredCapability && !row.permissions.includes('*') && !row.permissions.includes(requiredCapability))) {
      throw Object.assign(new Error('A valid Host-registered device session with the required permission is required.'), { status: 401, expose: true })
    }
    const timestamp = String(req.headers['x-device-timestamp'] || '')
    const nonce = String(req.headers['x-device-nonce'] || '')
    const signatureText = String(req.headers['x-device-signature'] || '')
    const sentAt = Number(timestamp)
    if (!Number.isSafeInteger(sentAt) || sentAt < processStartedAt || Math.abs(clock() - sentAt) > MAX_CLOCK_SKEW_MS || !NONCE_RE.test(nonce)) {
      throw Object.assign(new Error('Device device proof is stale or malformed.'), { status: 401, expose: true })
    }
    const nonceKey = deviceId + ':' + nonce
    for (const [key, at] of usedNonces) if (clock() - at > MAX_CLOCK_SKEW_MS) usedNonces.delete(key)
    if (usedNonces.has(nonceKey)) throw Object.assign(new Error('Device device proof has already been used.'), { status: 401, expose: true })
    const payload = deviceProofPayload({
      method: req.method,
      url: req.url,
      requestId: req.headers['x-device-request-id'],
      contentType: req.headers['content-type'],
      bodyHash: req.headers['x-device-body-sha256'],
      timestamp,
      nonce,
    })
    let valid = false
    try {
      const key = createPublicKey({ key: row.publicKey, format: 'jwk' })
      valid = verifySignature('sha256', Buffer.from(payload), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureText, 'base64url'))
    } catch { /* malformed proof */ }
    if (!valid) throw Object.assign(new Error('Device device proof is invalid.'), { status: 401, expose: true })
    if (usedNonces.size >= 20_000) {
      for (const [key, at] of usedNonces) if (clock() - at > MAX_CLOCK_SKEW_MS) usedNonces.delete(key)
      if (usedNonces.size >= 20_000) throw Object.assign(new Error('Device request capacity is temporarily full.'), { status: 429, expose: true })
    }
    usedNonces.set(nonceKey, clock())
    return { ...row }
  }

  async function updateAuthorization(deviceId, { identity, authorization }) {
    const current = sessions.get(deviceId)
    if (!current?.active) return null
    if (identity.uid !== current.uid || authorization?.uid !== current.uid || authorization?.orgId !== current.orgId ||
        (!authorization?.superAdmin && authorization?.membership?.status !== 'active')) {
      await invalidateUserOrg(current.uid, current.orgId)
      return null
    }
    const updated = snapshotFor({ identity, authorization, orgId: current.orgId, publicKey: current.publicKey, deviceId })
    updated.issuedAt = current.issuedAt
    sessions.set(deviceId, updated)
    await saveAll()
    return { deviceId, uid: updated.uid, orgId: updated.orgId, email: updated.email,
      displayName: updated.displayName, membership: updated.membership, permissions: updated.permissions,
      lastVerifiedAt: updated.lastVerifiedAt }
  }

  async function revoke(deviceId) {
    const row = sessions.get(deviceId)
    if (!row) return false
    row.active = false
    row.revokedAt = clock()
    row.permissions = []
    sessions.set(deviceId, row)
    await saveAll()
    return true
  }

  async function invalidateUserOrg(uid, orgId) {
    let changed = false
    for (const row of sessions.values()) {
      if (row.uid === uid && row.orgId === orgId && row.active) {
        row.active = false
        row.revokedAt = clock()
        row.permissions = []
        changed = true
      }
    }
    if (changed) await saveAll()
    return changed
  }

  function get(deviceId) { return sessions.get(deviceId) || null }
  function matchesDeviceKey(deviceId, publicKey) {
    try { return deviceIdFor(canonicalPublicKey(publicKey)) === deviceId } catch { return false }
  }
  function findForUser(uid) {
    return [...sessions.values()].filter((row) => row.active && row.uid === uid && row.permissions?.length)
      .map((row) => ({ deviceId: row.deviceId, uid: row.uid, orgId: row.orgId, email: row.email,
        displayName: row.displayName, membership: row.membership, permissions: row.permissions }))
  }

  return { initialize, register, authenticate, updateAuthorization, revoke, invalidateUserOrg, get, matchesDeviceKey, findForUser,
    status: () => ({ ready, active: [...sessions.values()].filter((row) => row.active).length }) }
}


