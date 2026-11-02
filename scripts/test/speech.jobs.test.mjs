import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createSpeechJobs } from '../../hub/speech/jobs.js'

function makeWav() {
  const samples = Buffer.alloc(8000)
  const wav = Buffer.alloc(44 + samples.length)
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8)
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36)
  wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44)
  return wav
}

const waitFor = async (predicate, message) => {
  const until = Date.now() + 5000
  while (Date.now() < until) {
    const value = await predicate()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

const root = await mkdtemp(join(process.cwd(), '.tmp-speech-test-'))
const log = { warn() {}, info() {}, error() {} }
try {
  let interruptFirstJob
  let firstWorkerStopped = false
  const interruptedWorker = {
    transcribe: () => firstWorkerStopped
      ? Promise.reject(new Error('Speech service stopped.'))
      : new Promise((_resolve, reject) => { interruptFirstJob = reject }),
    async stop() {
      firstWorkerStopped = true
      interruptFirstJob?.(new Error('Speech service stopped.'))
    },
  }
  const first = createSpeechJobs({ directory: root, worker: interruptedWorker, log, getFreeMemory: () => 2 * 1024 ** 3 })
  await first.initialize()
  const request = (requestId) => Readable.from([makeWav()])
  const accepted = await first.createFromRequest(request(), {
    owner: 'clinician-a', orgId: 'hospital-a', requestId: 'request-restart-01', contentType: 'audio/wav',
  })
  await waitFor(async () => (await first.get(accepted.id, 'clinician-a', 'hospital-a'))?.status === 'processing',
    'job did not enter processing before simulated Host restart')
  assert.equal(await first.get(accepted.id, 'clinician-b', 'hospital-a'), null, 'another user must not read the job')
  await first.close()

  const calls = []
  let activeCalls = 0
  let maxActiveCalls = 0
  const restarted = createSpeechJobs({
    directory: root,
    worker: { async transcribe({ id }) {
      calls.push(id)
      activeCalls++
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
      await new Promise((resolve) => setTimeout(resolve, 10))
      activeCalls--
      return 'result-for-' + id
    } },
    getFreeMemory: () => 2 * 1024 ** 3,
    log,
  })
  await restarted.initialize()
  const recovered = await waitFor(async () => {
    const job = await restarted.get(accepted.id, 'clinician-a', 'hospital-a')
    return job?.status === 'complete' ? job : null
  }, 'queued job was not recovered after Host restart')
  assert.equal(recovered.text, 'result-for-' + accepted.id)

  const [clientA, clientB] = await Promise.all([
    restarted.createFromRequest(request(), {
      owner: 'clinician-a', orgId: 'hospital-a', requestId: 'request-client-a-02', contentType: 'audio/wav',
    }),
    restarted.createFromRequest(request(), {
      owner: 'clinician-b', orgId: 'hospital-a', requestId: 'request-client-b-03', contentType: 'audio/wav',
    }),
  ])
  const duplicate = await restarted.createFromRequest(request(), {
    owner: 'clinician-a', orgId: 'hospital-a', requestId: 'request-client-a-02', contentType: 'audio/wav',
  })
  assert.equal(duplicate.id, clientA.id, 'repeated request id should return the original job')

  const [concurrentDuplicateA, concurrentDuplicateB] = await Promise.all([
    restarted.createFromRequest(request(), {
      owner: 'clinician-c', orgId: 'hospital-a', requestId: 'request-concurrent-04', contentType: 'audio/wav',
    }),
    restarted.createFromRequest(request(), {
      owner: 'clinician-c', orgId: 'hospital-a', requestId: 'request-concurrent-04', contentType: 'audio/wav',
    }),
  ])
  assert.equal(concurrentDuplicateA.id, concurrentDuplicateB.id, 'simultaneous duplicate request ids must reserve only one job')
  await waitFor(async () => (await restarted.get(clientA.id, 'clinician-a', 'hospital-a'))?.status === 'complete' &&
    (await restarted.get(clientB.id, 'clinician-b', 'hospital-a'))?.status === 'complete' &&
    (await restarted.get(concurrentDuplicateA.id, 'clinician-c', 'hospital-a'))?.status === 'complete',
  'multiple clients did not receive completed results')
  assert.equal(new Set(calls).size, calls.length, 'a job must be submitted to the worker only once')
  assert.equal(maxActiveCalls, 1, 'only one worker inference may be active at a time')
  assert.equal(await restarted.get(clientB.id, 'clinician-a', 'hospital-a'), null, 'results must remain private to the owning user')
  await restarted.close()

  let attempt = 0
  const continuesAfterFailure = createSpeechJobs({
    directory: join(root, 'failure-continuation'),
    worker: { async transcribe({ id }) {
      attempt++
      if (attempt === 1) throw new Error('synthetic per-job failure')
      return 'recovered-' + id
    } },
    getFreeMemory: () => 2 * 1024 ** 3,
    log,
  })
  await continuesAfterFailure.initialize()
  await assert.rejects(continuesAfterFailure.createFromRequest(Readable.from([Buffer.from('not audio')]), {
    owner: 'clinician-d', orgId: 'hospital-a', requestId: 'request-invalid-10', contentType: 'audio/wav',
  }), (error) => error.status === 415)
  const failedJob = await continuesAfterFailure.createFromRequest(request(), {
    owner: 'clinician-d', orgId: 'hospital-a', requestId: 'request-failure-05', contentType: 'audio/wav',
  })
  const nextJob = await continuesAfterFailure.createFromRequest(request(), {
    owner: 'clinician-e', orgId: 'hospital-a', requestId: 'request-after-failure-06', contentType: 'audio/wav',
  })
  await waitFor(async () => (await continuesAfterFailure.get(failedJob.id, 'clinician-d', 'hospital-a'))?.status === 'failed' &&
    (await continuesAfterFailure.get(nextJob.id, 'clinician-e', 'hospital-a'))?.status === 'complete',
  'a failed transcription permanently blocked the next queued job')
  assert.equal((await continuesAfterFailure.get(failedJob.id, 'clinician-d', 'hospital-a')).error, 'synthetic per-job failure')
  await continuesAfterFailure.close()

  const corruptStateDir = join(root, 'corrupt-state')
  const preservedAudioDir = join(corruptStateDir, 'audio')
  await mkdir(preservedAudioDir, { recursive: true })
  const orphanedQueuedAudio = join(preservedAudioDir, 'b2ab318a-084b-4b67-b2a6-26a50720e87a.wav')
  await writeFile(join(corruptStateDir, 'jobs.json'), '{not valid json')
  await writeFile(orphanedQueuedAudio, makeWav())
  const corruptState = createSpeechJobs({ directory: corruptStateDir, worker: { async transcribe() { return '' } }, log })
  await assert.rejects(corruptState.initialize(), /state is corrupt.*preserved/i)
  await access(orphanedQueuedAudio)
  await corruptState.close()

  let releaseQueueWorker
  let queueWorkerCalls = 0
  const boundedQueue = createSpeechJobs({
    directory: join(root, 'queue-limit'),
    maxPending: 1,
    worker: { transcribe: () => {
      queueWorkerCalls++
      return queueWorkerCalls === 1
        ? new Promise((resolve) => { releaseQueueWorker = resolve })
        : Promise.resolve('next-queue-result')
    } },
    getFreeMemory: () => 2 * 1024 ** 3,
    log,
  })
  await boundedQueue.initialize()
  const activeJob = await boundedQueue.createFromRequest(request(), {
    owner: 'clinician-f', orgId: 'hospital-a', requestId: 'request-limit-07', contentType: 'audio/wav',
  })
  await waitFor(async () => (await boundedQueue.get(activeJob.id, 'clinician-f', 'hospital-a'))?.status === 'processing',
    'first queue-limit job did not start')
  const waitingJob = await boundedQueue.createFromRequest(request(), {
    owner: 'clinician-g', orgId: 'hospital-a', requestId: 'request-limit-08', contentType: 'audio/wav',
  })
  await assert.rejects(boundedQueue.createFromRequest(request(), {
    owner: 'clinician-h', orgId: 'hospital-a', requestId: 'request-limit-09', contentType: 'audio/wav',
  }), (error) => error.status === 429)
  releaseQueueWorker('queue-result')
  await waitFor(async () => (await boundedQueue.get(activeJob.id, 'clinician-f', 'hospital-a'))?.status === 'complete' &&
    (await boundedQueue.get(waitingJob.id, 'clinician-g', 'hospital-a'))?.status === 'complete',
  'accepted queue jobs did not continue after the queue-full response')
  await boundedQueue.close()
  console.log('Speech job persistence, restart recovery, serialization and ownership checks passed.')
} finally {
  await rm(root, { recursive: true, force: true })
}
