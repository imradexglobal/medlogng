import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { PassThrough, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSpeechWorker } from '../../hub/speech/worker.js'

const root = await mkdtemp(join(tmpdir(), 'medlog-speech-worker-test-'))
const audioDir = join(root, 'audio')
const executable = join(root, 'worker.exe')
const model = join(root, 'model.bin')
const wav = join(audioDir, 'sample.wav')
const outsideWav = join(root, 'elsewhere.wav')
await mkdir(audioDir)
await Promise.all([writeFile(executable, 'mock executable'), writeFile(model, 'mock model'), writeFile(wav, Buffer.alloc(64)), writeFile(outsideWav, Buffer.alloc(64))])

const waitFor = async (predicate, message) => {
  const until = Date.now() + 6000
  while (Date.now() < until) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.fail(message)
}

function fakeWorkerProcess(onRequest, ready = true) {
  const child = new EventEmitter()
  child.exitCode = null
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.keepAlive = setInterval(() => {}, 1000)
  let buffered = ''
  let exited = false
  const exit = (code) => {
    if (exited) return
    exited = true
    clearInterval(child.keepAlive)
    child.exitCode = code
    process.nextTick(() => child.emit('exit', code, null))
  }
  child.kill = () => { exit(1); return true }
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      buffered += String(chunk)
      const lines = buffered.split('\n')
      buffered = lines.pop()
      for (const line of lines) {
        if (line === 'QUIT') { exit(0); continue }
        if (line) onRequest(child, line)
      }
      callback()
    },
    final(callback) { exit(0); callback() },
  })
  if (ready) process.nextTick(() => child.stdout.write('READY\n'))
  return child
}

const log = { info() {}, warn() {}, error() {} }
let spawnCount = 0
let firstRequest = true
let crashOnce = true
let stallNext = false
const worker = createSpeechWorker({
  executable, model, audioDir, log, startupTimeoutMs: 500, transcribeTimeoutMs: 80,
  spawnProcess: () => {
    spawnCount++
    return fakeWorkerProcess((child, line) => {
      const [id] = line.split('\t')
      if (firstRequest) {
        firstRequest = false
        child.stdout.write('malformed worker output\n')
      }
      if (crashOnce) {
        crashOnce = false
        child.kill()
      } else if (stallNext) {
        stallNext = false
      } else {
        child.stdout.write(id + '\tOK\t' + Buffer.from('mock transcript').toString('base64') + '\n')
      }
    })
  },
})

try {
  assert.equal((await worker.start()).ready, true, 'worker should report ready only after model startup')
  await assert.rejects(worker.transcribe({ id: 'crash-job-01', wavPath: wav }), (error) => error.code === 'SPEECH_UNAVAILABLE')
  await waitFor(() => worker.status().ready && spawnCount >= 2, 'worker did not restart after a crash')

  stallNext = true
  await assert.rejects(worker.transcribe({ id: 'timeout-job-02', wavPath: wav }), (error) => error.code === 'SPEECH_TIMEOUT')
  await waitFor(() => worker.status().ready && spawnCount >= 3, 'worker did not restart after a timed out request')

  const result = await worker.transcribe({ id: 'success-job-03', wavPath: wav })
  assert.equal(result, 'mock transcript', 'worker should decode the line protocol response')
  await assert.rejects(worker.transcribe({ id: 'outside-job-04', wavPath: outsideWav }),
    /outside the speech temporary folder/i)
  await worker.stop()
  assert.equal(worker.status().ready, false)

  const slowStartupWorker = createSpeechWorker({
    executable, model, audioDir, log, startupTimeoutMs: 20, transcribeTimeoutMs: 80,
    spawnProcess: () => fakeWorkerProcess(() => {}, false),
  })
  await assert.rejects(slowStartupWorker.start(), /startup timed out/i)
  await slowStartupWorker.stop()
  console.log('Mock worker startup, startup timeout, protocol, crash restart, inference timeout and path validation checks passed (no real Whisper binary used).')
} finally {
  await worker.stop()
  await rm(root, { recursive: true, force: true })
}
