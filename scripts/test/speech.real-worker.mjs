// Integration tests against the built Windows worker and pinned real audio.
// These are intentionally separate from the mock-only speech test suite.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createSpeechWorker } from '../../hub/speech/worker.js'

const repoRoot = path.resolve(import.meta.dirname, '../..')
const executable = path.join(repoRoot, 'vendor/speech/medilog-whisper-worker.exe')
const model = path.join(repoRoot, 'vendor/speech/ggml-tiny.en-q5_1.bin')
const sample = path.join(repoRoot, '.cache/whisper.cpp-v1.9.5/samples/jfk.wav')
const expectedSampleHash = '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e'
const sampleHash = (await import('node:crypto')).createHash('sha256').update(await readFile(sample)).digest('hex')
assert.equal(sampleHash, expectedSampleHash, 'pinned whisper.cpp test audio hash must match')

const root = await mkdtemp(path.join(os.tmpdir(), 'medlog-speech-real-worker-'))
const audioDir = path.join(root, 'audio')
const wav = path.join(audioDir, 'jfk.wav')
const invalidWav = path.join(audioDir, 'invalid.wav')
await mkdir(audioDir, { recursive: true })
await copyFile(sample, wav)
await writeFile(invalidWav, Buffer.alloc(64, 0x42))

const quietLog = { info() {}, warn() {}, error() {} }
const children = []
const startRealWorker = async (options = {}) => {
  const service = createSpeechWorker({
    executable, model, audioDir, threads: 1, log: quietLog,
    spawnProcess: (...args) => {
      const child = spawn(...args)
      children.push(child)
      return child
    },
    ...options,
  })
  await service.start()
  return service
}
const waitFor = async (predicate, message, timeoutMs = 30_000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.fail(message)
}
const isExpectedText = (text) => /ask not what your country can do for you/i.test(text) &&
  /ask what you can do for your country/i.test(text)

let service
let timeoutService
try {
  service = await startRealWorker()
  assert.equal(service.status().ready, true, 'real model must load before the worker reports ready')

  const failedJob = service.transcribe({ id: 'invalid-audio', wavPath: invalidWav })
  const validJob = service.transcribe({ id: 'valid-after-error', wavPath: wav })
  const [failed, completed] = await Promise.allSettled([failedJob, validJob])
  assert.equal(failed.status, 'rejected', 'real worker must reject malformed WAV data')
  assert.equal(completed.status, 'fulfilled', 'worker must continue after an audio-level failure')
  assert.ok(isExpectedText(completed.value), 'real worker must transcribe the pinned speech sample')

  const beforeCrashCount = children.length
  children.at(-1).kill()
  await waitFor(() => children.length > beforeCrashCount && service.status().ready,
    'worker supervisor must restart the real executable after a crash')
  const afterCrashText = await service.transcribe({ id: 'valid-after-crash', wavPath: wav })
  assert.ok(isExpectedText(afterCrashText), 'real worker must process a job after automatic crash recovery')
  await service.stop()
  service = null

  timeoutService = await startRealWorker({ transcribeTimeoutMs: 1 })
  await assert.rejects(
    timeoutService.transcribe({ id: 'real-timeout', wavPath: wav }),
    (error) => error?.code === 'SPEECH_TIMEOUT',
    'real worker supervisor must enforce the configured inference timeout'
  )
  const beforeTimeoutRecovery = children.length
  await waitFor(() => children.length > beforeTimeoutRecovery && timeoutService.status().ready,
    'real worker supervisor must recover after terminating a timed-out worker')
  await timeoutService.stop()
  timeoutService = null
  process.stdout.write('Real worker tests passed: model load, transcription, invalid audio, queue continuation, crash restart and timeout recovery.\n')
} finally {
  await service?.stop().catch(() => {})
  await timeoutService?.stop().catch(() => {})
  for (const child of children) if (child.exitCode === null) child.kill()
  await rm(root, { recursive: true, force: true })
}
