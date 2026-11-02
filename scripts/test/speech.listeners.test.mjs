import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { startHub } from '../../hub/server.js'

const root = await mkdtemp(join(process.cwd(), '.tmp-speech-listeners-'))
const pfxPath = join(root, 'test-cert.pfx')
const certScript = join(process.cwd(), 'scripts', 'test', 'create-speech-test-certificate.ps1')
const powershell = process.env.POWERSHELL_EXECUTABLE || 'pwsh.exe'
const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', certScript, '-OutputPath', pfxPath]
let certResult = spawnSync(powershell, args, { encoding: 'utf8' })
if (certResult.error?.code === 'ENOENT') {
  certResult = spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, { encoding: 'utf8' })
}
assert.equal(certResult.status, 0, 'could not create temporary HTTPS test certificate: ' + (certResult.stderr || certResult.stdout))

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
  const req = requester({ host: '127.0.0.1', port, path, method, rejectUnauthorized: false, headers }, (res) => {
    const chunks = []
    res.on('data', (chunk) => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
  })
  req.once('error', reject)
  if (body) req.write(body)
  req.end()
})

const log = { info() {}, warn() {}, error() {} }
let hub
try {
  const speechWorker = {
    status: () => ({ ready: true }),
    async transcribe({ id }) { return 'transcript-' + id },
  }
  const authenticator = {
    async verify() { return { uid: 'test-clinician', email: 'test@example.test' } },
    async authorizeSpeech() {},
  }
  hub = await startHub({
    host: '127.0.0.1', port: 0, httpsPort: 0,
    tls: { pfx: await readFile(pfxPath) },
    speechWorker,
    speechDir: join(root, 'speech'),
    speechGetFreeMemory: () => 2 * 1024 ** 3,
    queueFile: join(root, 'outbox.json'),
    foundation: { db: null, auth: null },
    authenticator,
    log,
  })
  assert.ok(hub.httpsPort > 0, 'HTTPS listener did not start')
  assert.ok(hub.speechJobs, 'speech job service was not created')
  assert.equal(hub.speechJobs.status().ready, true)

  const httpHealth = await request(false, hub.port, '/health')
  assert.equal(httpHealth.status, 200, 'existing HTTP health connection should remain available')

  const headers = {
    'content-type': 'audio/wav',
    'content-length': String(makeWav().length),
    'x-medilog-client': 'medilogng-web',
    'x-speech-request-id': 'listener-test-request-01',
  }
  const blockedHttp = await request(false, hub.port, '/speech/jobs?orgId=test-hospital', {
    method: 'POST', body: makeWav(), headers,
  })
  assert.equal(blockedHttp.status, 403, 'transcription upload over HTTP must be rejected')

  const acceptedHttpsResponses = await Promise.all([1, 2].map(() => request(true, hub.httpsPort, '/speech/jobs?orgId=test-hospital', {
    method: 'POST', body: makeWav(), headers,
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
        const response = await request(true, hub.httpsPort, '/speech/jobs/' + id + '?orgId=test-hospital', {
          headers: { 'x-medilog-client': 'medilogng-web' },
        })
        const body = JSON.parse(response.body.toString('utf8'))
        if (body.job?.status === 'complete') return resolve(body.job)
      } catch (error) { return reject(error) }
      await new Promise((wait) => setTimeout(wait, 25))
    }
    reject(new Error('HTTPS job did not complete'))
  })
  assert.equal(result.text, 'transcript-' + id)
  const blockedHttpResult = await request(false, hub.port, '/speech/jobs/' + id + '?orgId=test-hospital', {
    headers: { 'x-medilog-client': 'medilogng-web' },
  })
  assert.equal(blockedHttpResult.status, 403, 'transcription results must not be readable over HTTP')
  assert.equal(hub.speechJobs.status().ready, true, 'both listeners should share the same initialized job service')

  console.log('HTTP compatibility, HTTPS submission, concurrent duplicate protection, HTTP upload/result rejection and shared speech-job service checks passed.')
} finally {
  if (hub) await hub.close()
  await rm(root, { recursive: true, force: true })
}
