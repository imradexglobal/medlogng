import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { X509Certificate, generateKeyPairSync, createHash, sign } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { startHub } from '../../hub/server.js'
import { speechProofPayload } from '../../hub/speech/sessions.js'

const root = await mkdtemp(join(process.cwd(), '.tmp-speech-listeners-'))
const pfxPath = join(root, 'test-cert.pfx')
const caPath = join(root, 'test-cert.cer')
const certScript = join(process.cwd(), 'scripts', 'test', 'create-speech-test-certificate.ps1')
const powershell = process.env.POWERSHELL_EXECUTABLE || 'pwsh.exe'
const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', certScript, '-OutputPath', pfxPath, '-CertificatePath', caPath]
let certResult = spawnSync(powershell, args, { encoding: 'utf8' })
if (certResult.error?.code === 'ENOENT') {
  certResult = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, { encoding: 'utf8' })
}
assert.equal(certResult.status, 0, 'could not create temporary HTTPS test certificate: ' + (certResult.stderr || certResult.stdout))
const testCa = new X509Certificate(await readFile(caPath)).toString()

function makeWav() {
  const pcm = Buffer.alloc(8000)
  const data = Buffer.alloc(44 + pcm.length)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVE', 8)
  data.write('fmt ', 12); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20)
  data.writeUInt16LE(1, 22); data.writeUInt32LE(16000, 24); data.writeUInt32LE(32000, 28)
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36)
  data.writeUInt32LE(pcm.length, 40); pcm.copy(data, 44)
  return data
}

const request = (secure, port, path, { method = 'GET', body = null, headers = {} } = {}) => new Promise((resolve, reject) => {
  const requester = secure ? httpsRequest : httpRequest
  const req = requester({ host: '127.0.0.1', port, path, method, headers, ...(secure ? { ca: testCa } : {}) }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
  })
  req.once('error', reject)
  if (body) req.write(body)
  req.end()
})

const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
const publicKey = keyPair.publicKey.export({ format: 'jwk' })
let deviceId = ''
function signedHeaders(method, path, body = null, contentType = '', requestId = '', extra = {}) {
  const timestamp = String(Date.now())
  const nonce = cryptoNonce()
  const bodyHash = createHash('sha256').update(body || Buffer.alloc(0)).digest('hex')
  const payload = speechProofPayload({ method, url: path, requestId, contentType, bodyHash, timestamp, nonce })
  const signature = sign('sha256', Buffer.from(payload), { key: keyPair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return { 'x-medilog-client': 'medilogng-web', 'x-speech-device': deviceId, 'x-speech-timestamp': timestamp,
    'x-speech-nonce': nonce, 'x-speech-signature': signature, 'x-speech-body-sha256': bodyHash,
    ...(contentType ? { 'content-type': contentType } : {}), ...(requestId ? { 'x-speech-request-id': requestId } : {}), ...extra }
}
function cryptoNonce() { return randomNonce() }
function randomNonce() { return Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(18))).toString('base64url') }

const log = { info() {}, warn() {}, error() {} }
let hub
try {
  const speechWorker = {
    status: () => ({ ready: true }),
    async transcribe({ id }) { return 'transcript-' + id },
  }
  let canEdit = true
  const authenticator = {
    async verify() { return { uid: 'test-clinician', email: 'test@example.test' } },
    async verifyOnline() { return { uid: 'test-clinician', email: 'test@example.test' } },
    async authorizeSpeech(identity, orgId, capability) {
      if (!canEdit) throw Object.assign(new Error('permission revoked'), { status: 403, expose: true })
      return { uid: identity.uid, orgId, capability, membership: { status: 'active', capabilities: ['encounter.edit'] }, authorizationSource: 'firestore' }
    },
    async authorize(identity, orgId) {
      if (!canEdit) throw Object.assign(new Error('membership revoked'), { status: 403, expose: true })
      return { uid: identity.uid, orgId, membership: { status: 'active', capabilities: ['encounter.edit'] } }
    },
  }
  let encryptedSessionState = '[]'
  hub = await startHub({
    host: '127.0.0.1', port: 0, httpsPort: 0,
    tls: { pfx: await readFile(pfxPath) },
    speechWorker,
    speechDir: join(root, 'speech'),
    speechGetFreeMemory: () => 2 * 1024 ** 3,
    queueFile: join(root, 'outbox.json'),
    foundation: { db: null, auth: null },
    authenticator,
    loadSpeechSessions: async () => encryptedSessionState,
    saveSpeechSessions: async (value) => { encryptedSessionState = value },
    log,
  })
  assert.ok(hub.httpsPort > 0, 'HTTPS listener did not start')
  assert.ok(hub.speechJobs, 'speech job service was not created')
  assert.equal(hub.speechJobs.status().ready, true)

  const refusedHttpEnrollment = await request(false, hub.port, '/device/session/register?orgId=test-hospital', {
    method: 'POST', body: Buffer.from(JSON.stringify({ publicKey })),
    headers: { authorization: 'Bearer test-id-token-at-least-twenty-chars', 'content-type': 'application/json', 'x-medilog-client': 'medilogng-web' },
  })
  assert.equal(refusedHttpEnrollment.status, 403, 'device session enrollment must never send or accept credentials over HTTP')

  const registered = await request(true, hub.httpsPort, '/speech/session?orgId=test-hospital', {
    method: 'POST', body: Buffer.from(JSON.stringify({ publicKey })),
    headers: { authorization: 'Bearer test-id-token-at-least-twenty-chars', 'content-type': 'application/json', 'x-medilog-client': 'medilogng-web' },
  })
  assert.equal(registered.status, 200, 'live verified clinician may register a local speech session')
  deviceId = JSON.parse(registered.body.toString('utf8')).session.deviceId
  const deviceRegistration = await request(true, hub.httpsPort, '/device/session/register?orgId=test-hospital', {
    method: 'POST', body: Buffer.from(JSON.stringify({ publicKey })),
    headers: { authorization: 'Bearer test-id-token-at-least-twenty-chars', 'content-type': 'application/json',
      'x-medilog-client': 'medilogng-web', 'x-speech-device': deviceId },
  })
  assert.equal(deviceRegistration.status, 200, 'live handoff device session may register over HTTPS')
  const offlinePath = '/speech/session/offline?orgId=test-hospital'
  const offlineBootstrap = await request(true, hub.httpsPort, offlinePath, { method: 'POST', headers: signedHeaders('POST', offlinePath) })
  assert.equal(offlineBootstrap.status, 200, 'device can restore only its Host-verified offline identity')
  const deviceOfflinePath = '/device/session/offline?orgId=test-hospital'
  const deviceOffline = await request(true, hub.httpsPort, deviceOfflinePath, { method: 'POST', headers: signedHeaders('POST', deviceOfflinePath) })
  assert.equal(deviceOffline.status, 200, 'handoff session restores its Host-verified membership')

  const httpHealth = await request(false, hub.port, '/health')
  assert.equal(httpHealth.status, 200, 'existing HTTP health connection should remain available')

  const body = makeWav()
  const uploadPath = '/speech/jobs?orgId=test-hospital&encounterId=encounter-1'
  const headers = { ...signedHeaders('POST', uploadPath, body, 'audio/wav', 'listener-test-request-01'), 'content-length': String(body.length) }
  const blockedHttp = await request(false, hub.port, '/speech/jobs?orgId=test-hospital&encounterId=encounter-1', {
    method: 'POST', body, headers,
  })
  assert.equal(blockedHttp.status, 403, 'transcription upload over HTTP must be rejected')

  const acceptedHttpsResponses = await Promise.all([1, 2].map(() => request(true, hub.httpsPort, uploadPath, {
    method: 'POST', body, headers: { ...signedHeaders('POST', uploadPath, body, 'audio/wav', 'listener-test-request-01'), 'content-length': String(body.length) },
  })))
  assert.ok(acceptedHttpsResponses.every((response) => [200, 202].includes(response.status)), 'HTTPS listener should accept a recording and its retry')
  const acceptedBodies = acceptedHttpsResponses.map((response) => JSON.parse(response.body.toString('utf8')))
  assert.equal(acceptedBodies[0].job.id, acceptedBodies[1].job.id, 'simultaneous retries with the same request id must share a job')
  const acceptedBody = acceptedBodies[0]
  const id = acceptedBody.job.id
  assert.ok(id)

  const result = await new Promise(async (resolve, reject) => {
    const until = Date.now() + 5000
    while (Date.now() < until) {
      try {
        const jobPath = '/speech/jobs/' + id + '?orgId=test-hospital'
        const response = await request(true, hub.httpsPort, jobPath, { headers: signedHeaders('GET', jobPath) })
        const body = JSON.parse(response.body.toString('utf8'))
        if (body.job?.status === 'complete') return resolve(body.job)
      } catch (error) { return reject(error) }
      await new Promise((wait) => setTimeout(wait, 25))
    }
    reject(new Error('HTTPS job did not complete'))
  })
  assert.equal(result.text, 'transcript-' + id)
  const blockedPath = '/speech/jobs/' + id + '?orgId=test-hospital'
  const blockedHttpResult = await request(false, hub.port, blockedPath, {
    headers: signedHeaders('GET', blockedPath),
  })
  assert.equal(blockedHttpResult.status, 403, 'transcription results must not be readable over HTTP')
  assert.equal(hub.speechJobs.status().ready, true, 'both listeners should share the same initialized job service')

  canEdit = false
  const revalidatePath = '/device/session/revalidate?orgId=test-hospital'
  const deniedRevalidation = await request(true, hub.httpsPort, revalidatePath, { method: 'POST', headers: signedHeaders(
    'POST', revalidatePath, null, '', '', { authorization: 'Bearer test-id-token-at-least-twenty-chars' }) })
  assert.equal(deniedRevalidation.status, 403, 'revoked online membership invalidates the local session')
  const afterRevocation = await request(true, hub.httpsPort, blockedPath, { headers: signedHeaders('GET', blockedPath) })
  assert.equal(afterRevocation.status, 401, 'subsequent job requests are denied after revocation')

  console.log('HTTP compatibility, HTTPS device registration, offline bootstrap, signed transcription, duplicate protection, revocation and HTTP rejection checks passed.')
} finally {
  if (hub) await hub.close()
  await rm(root, { recursive: true, force: true })
}
