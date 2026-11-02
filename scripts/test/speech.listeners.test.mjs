import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { startHub } from '../../hub/server.js'

const root = await mkdtemp(join(tmpdir(), 'medilog-speech-listeners-'))
const pfxPath = join(root, 'test-cert.pfx')
const caPath = join(root, 'test-cert.cer')
const certScript = join(process.cwd(), 'scripts', 'test', 'create-speech-test-certificate.ps1')
let created = spawnSync('pwsh.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', certScript, '-OutputPath', pfxPath, '-CertificatePath', caPath], { encoding: 'utf8' })
if (created.error?.code === 'ENOENT') created = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', certScript, '-OutputPath', pfxPath, '-CertificatePath', caPath], { encoding: 'utf8' })
assert.equal(created.status, 0, 'could not create temporary HTTPS certificate: ' + (created.stderr || created.stdout))
const testCa = new X509Certificate(await readFile(caPath)).toString()

function audio() { const b = Buffer.alloc(1024); b.write('RIFF'); b.write('WAVE', 8); return b }
const request = (secure, port, path, { method = 'GET', body = null, headers = {} } = {}) => new Promise((resolve, reject) => {
  const requester = secure ? httpsRequest : httpRequest
  const req = requester({ host: '127.0.0.1', port, path, method, headers, ...(secure ? { ca: testCa } : {}) }, (res) => {
    const chunks = []; res.on('data', (chunk) => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
  })
  req.once('error', reject); if (body) req.write(body); req.end()
})

let providerCalls = 0
const audit = []
const db = {
  doc: () => ({ get: async () => ({ exists: false }) }),
  collection(name) {
    if (name === 'encounters') return { doc: () => ({ get: async () => ({ exists: true, data: () => ({ organization_id: 'hospital-1', patient_id: 'patient-1' }) }) }) }
    if (name === 'audit_events') return { add: async (record) => { audit.push(record) } }
    throw new Error('Unexpected collection ' + name)
  },
}
const authenticator = {
  async verifyOnline(req) { if (req.headers.authorization !== 'Bearer valid-live-id-token-for-clinician') throw Object.assign(new Error('invalid token'), { status: 401, expose: true }); return { uid: 'clinician-1' } },
  async authorize(_identity, _orgId, capability) { if (capability !== 'encounter.edit') throw Error('unexpected capability'); return { membership: { status: 'active' } } },
}
const envBefore = { key: process.env.DEEPGRAM_API_KEY, endpoint: process.env.DEEPGRAM_ENDPOINT, enable: process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO }
process.env.DEEPGRAM_API_KEY = 'test-only-not-a-real-key'
process.env.DEEPGRAM_ENDPOINT = 'https://api.in.deepgram.com'
process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO = 'true'
let hub
try {
  hub = await startHub({ host: '127.0.0.1', port: 0, httpsPort: 0, tls: { pfx: await readFile(pfxPath) }, allowedOrigins: ['https://medlogng.web.app'],
    queueFile: join(root, 'outbox.json'), foundation: { db, auth: {} }, authenticator, log: { info() {}, warn() {}, error() {} },
    speechProvider: async ({ audio: bytes, contentType, apiKey, endpoint }) => {
      providerCalls++; assert.equal(bytes.length, 1024); assert.equal(contentType, 'audio/wav'); assert.match(apiKey, /^test-only/); assert.equal(endpoint, 'https://api.in.deepgram.com')
      return { text: 'Synthetic online transcription.', model: 'nova-3-medical' }
    },
    auditSpeech: async (record) => audit.push(record),
  })
  const q = '?orgId=hospital-1&patientId=patient-1&encounterId=encounter-1'
  const headers = { 'content-type': 'audio/wav', authorization: 'Bearer valid-live-id-token-for-clinician', 'x-medilog-client': 'medilogng-web',
    'x-speech-request-id': 'request-synthetic-0001', origin: 'https://medlogng.web.app' }
  const rejectedHttp = await request(false, hub.port, '/speech/transcribe' + q, { method: 'POST', body: audio(), headers })
  assert.equal(rejectedHttp.status, 403, 'HTTP listener must never accept microphone recordings')
  assert.equal(providerCalls, 0)
  const result = await request(true, hub.httpsPort, '/speech/transcribe' + q, { method: 'POST', body: audio(), headers })
  assert.equal(result.status, 200)
  assert.equal(JSON.parse(result.body.toString()).text, 'Synthetic online transcription.')
  assert.equal(providerCalls, 1)
  assert.equal(audit.some((row) => row.actor_user_id === 'clinician-1' && row.patient_id === 'patient-1' && row.record_id === 'encounter-1'), true)
  const oldQueue = await request(true, hub.httpsPort, '/speech/jobs/00000000-0000-4000-8000-000000000000?orgId=hospital-1', { headers })
  assert.equal(oldQueue.status, 404, 'obsolete local worker job endpoint must be removed')
  const oldSession = await request(true, hub.httpsPort, '/speech/session?orgId=hospital-1', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: Buffer.from('{}') })
  assert.equal(oldSession.status, 404, 'offline-only speech session endpoint must be removed')
} finally {
  if (hub) await hub.close()
  if (envBefore.key === undefined) delete process.env.DEEPGRAM_API_KEY; else process.env.DEEPGRAM_API_KEY = envBefore.key
  if (envBefore.endpoint === undefined) delete process.env.DEEPGRAM_ENDPOINT; else process.env.DEEPGRAM_ENDPOINT = envBefore.endpoint
  if (envBefore.enable === undefined) delete process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO; else process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO = envBefore.enable
  await rm(root, { recursive: true, force: true })
}
console.log('Host HTTPS-only online transcription, live auth, encounter binding, audit and legacy endpoint removal passed')
