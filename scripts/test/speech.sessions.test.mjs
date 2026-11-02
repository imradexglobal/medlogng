import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { createSpeechSessions, speechProofPayload } from '../../hub/speech/sessions.js'

const saved = { value: '[]' }
const log = { error() {} }
let now = Date.now()
const sessions = createSpeechSessions({ load: async () => saved.value, save: async (value) => { saved.value = value }, log, clock: () => now })
await sessions.initialize()
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicKey = pair.publicKey.export({ format: 'jwk' })
const identity = { uid: 'clinician-1', email: 'clinician@example.test' }
const authorization = { uid: identity.uid, orgId: 'hospital-1', capability: '', membership: { status: 'active', capabilities: ['encounter.edit', 'patient.read'] } }
const session = await sessions.register({ identity, authorization, orgId: 'hospital-1', publicKey })
assert.deepEqual(session.permissions, ['encounter.edit', 'patient.read'])
assert.equal((await sessions.register({ identity, authorization: { ...authorization, capability: 'patient.read' }, orgId: 'hospital-1', publicKey })).deviceId, session.deviceId,
  'host sessions enroll all currently verified membership capabilities')

function request(method = 'GET', url = '/speech/jobs/job?orgId=hospital-1', nonce = 'abcdefghijklmnop') {
  const timestamp = String(now)
  const bodyHash = createHash('sha256').update('').digest('hex')
  const requestId = ''
  const contentType = ''
  const payload = speechProofPayload({ method, url, requestId, contentType, bodyHash, timestamp, nonce })
  const signature = sign('sha256', Buffer.from(payload), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return { method, url, headers: { 'x-speech-device': session.deviceId, 'x-speech-timestamp': timestamp,
    'x-speech-nonce': nonce, 'x-speech-signature': signature, 'x-speech-body-sha256': bodyHash } }
}

assert.equal(sessions.authenticate(request(), 'hospital-1').uid, identity.uid)
assert.throws(() => sessions.authenticate(request(), 'other-hospital'), /valid Host-registered/)
const tampered = request('GET', '/speech/jobs/job?orgId=hospital-1', 'qrstuvwxyzabcdef')
tampered.url = '/speech/jobs/forged?orgId=hospital-1'
assert.throws(() => sessions.authenticate(tampered), /proof is invalid/)
assert.throws(() => sessions.authenticate(request(), 'hospital-1'), /already been used/)

const capturedBeforeRestart = request('GET', '/speech/jobs/job?orgId=hospital-1', 'abcdefghijklmnopqr')
now += 1000
const justRestarted = createSpeechSessions({ load: async () => saved.value, save: async (value) => { saved.value = value }, log, clock: () => now })
await justRestarted.initialize()
assert.throws(() => justRestarted.authenticate(capturedBeforeRestart, 'hospital-1'), /stale or malformed/,
  'a signed request captured before Host restart cannot be replayed after restart')

now += 365 * 24 * 60 * 60 * 1000
const restarted = createSpeechSessions({ load: async () => saved.value, save: async (value) => { saved.value = value }, log, clock: () => now })
await restarted.initialize()
assert.equal(restarted.authenticate(request('GET', '/speech/jobs/job?orgId=hospital-1', '1234567890abcdef'), 'hospital-1').uid, identity.uid,
  'last verified permission remains available without a fixed expiry')
const changedGrant = await restarted.updateAuthorization(session.deviceId, { identity,
  authorization: { ...authorization, membership: { status: 'active', capabilities: ['patient.read'] } } })
assert.deepEqual(changedGrant.permissions, ['patient.read'], 'revalidation refreshes the full capability set')
assert.throws(() => restarted.authenticate(request('GET', '/speech/jobs/job?orgId=hospital-1', 'abcdefghijklmnop'), 'hospital-1'), /required permission/,
  'speech actions remain limited to encounter.edit')
assert.equal(await restarted.revoke(session.deviceId), true)
assert.throws(() => restarted.authenticate(request('GET', '/speech/jobs/job?orgId=hospital-1', '234567890abcdefg'), 'hospital-1'), /valid Host-registered/)
console.log('Offline speech device binding, live grant requirement, signed request proof, replay defense, persistence, no fixed expiry and sign-out revocation passed.')
