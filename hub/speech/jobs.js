// Disk-backed speech jobs. Audio stays in a Host-only temporary directory;
// only a short-lived status/result record survives successful processing.
import { createWriteStream } from 'node:fs'
import { mkdir, open, readFile, realpath, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { freemem } from 'node:os'

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const MAX_WAV_BYTES = 32 * 1024 * 1024
const MAX_SECONDS = 5 * 60
const RETAIN_MS = 30 * 60 * 1000
const MIN_FREE_RAM_BYTES = 700 * 1024 * 1024
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,100}$/

function isWithin(root, candidate) {
  const rel = path.relative(root, candidate)
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

function audioKind(head) {
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WAVE') return 'wav'
  if (head.subarray(0, 4).toString() === 'OggS') return 'ogg'
  if (head.subarray(0, 4).toString('hex') === '1a45dfa3') return 'webm'
  if (head.subarray(4, 8).toString() === 'ftyp') return 'mp4'
  if (head.subarray(0, 3).toString() === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'mp3'
  return ''
}

async function validatePcmWav(file) {
  const h = await open(file, 'r')
  try {
    const info = await h.stat()
    if (!info.isFile() || info.size < 44 || info.size > MAX_WAV_BYTES) throw new Error('Audio file is empty, invalid, or too large.')
    const header = Buffer.alloc(Math.min(info.size, 64 * 1024))
    const { bytesRead } = await h.read(header, 0, header.length, 0)
    const b = header.subarray(0, bytesRead)
    if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Audio conversion did not produce a WAV file.')
    let format = 0, channels = 0, rate = 0, bits = 0, dataBytes = 0
    for (let p = 12; p + 8 <= b.length;) {
      const size = b.readUInt32LE(p + 4)
      const start = p + 8
      if (b.toString('ascii', p, p + 4) === 'fmt ' && size >= 16 && start + 16 <= b.length) {
        format = b.readUInt16LE(start)
        channels = b.readUInt16LE(start + 2)
        rate = b.readUInt32LE(start + 4)
        bits = b.readUInt16LE(start + 14)
      } else if (b.toString('ascii', p, p + 4) === 'data') {
        dataBytes = size
        break
      }
      if (start + size <= p || start + size > info.size) break
      p = start + size + (size & 1)
    }
    if (format !== 1 || channels !== 1 || rate !== 16000 || bits !== 16 || !dataBytes || (dataBytes & 1))
      throw new Error('Audio must be 16 kHz mono PCM WAV after conversion.')
    const duration = dataBytes / (rate * channels * (bits / 8))
    if (duration < 0.25) throw new Error('Recording is too short or contains no usable audio.')
    if (duration > MAX_SECONDS) throw new Error('Recording exceeds the five-minute limit.')
    return duration
  } finally { await h.close() }
}

function convertToWav(ffmpeg, input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
      '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve()
    }
    child.stderr.on('data', (chunk) => { if (stderr.length < 2000) stderr += String(chunk) })
    child.once('error', () => finish(new Error('Audio conversion could not start.')))
    child.once('exit', (code) => finish(code === 0 ? null : new Error('Audio conversion failed: ' + (stderr.trim().slice(0, 300) || 'unsupported recording format'))))
    const timer = setTimeout(() => { try { child.kill() } catch {}; finish(new Error('Audio conversion timed out.')) }, 120_000)
  })
}

export function createSpeechJobs({ directory, worker, ffmpeg = '', log = console, maxPending = 10, perUserPending = 2,
  getFreeMemory = freemem, protectResult = (text) => text, unprotectResult = (text) => text }) {
  const audioDir = path.join(directory, 'audio')
  const indexFile = path.join(directory, 'jobs.json')
  const jobs = new Map()
  const pending = []
  const requests = new Map()
  let active = null
  let saveChain = Promise.resolve()
  let pumping = false
  const pumpWaiters = []
  let ready = false
  let cleanupTimer = null
  let retryTimer = null
  const requestKey = (owner, orgId, requestId) => owner + ':' + orgId + ':' + requestId

  function publicJob(job) {
    const out = { id: job.id, status: job.status, createdAt: job.createdAt, updatedAt: job.updatedAt }
    if (job.status === 'complete') out.text = job.text || ''
    if (job.status === 'failed') out.error = job.error || 'Transcription failed.'
    const pos = pending.findIndex((entry) => entry.id === job.id)
    if (pos >= 0) out.queuePosition = pos + (active ? 2 : 1)
    else if (active?.id === job.id) out.queuePosition = 1
    return out
  }

  function persist() {
    const snapshot = JSON.stringify([...jobs.values()].map((job) => ({
      id: job.id, owner: job.owner, orgId: job.orgId, requestId: job.requestId, status: job.status,
      createdAt: job.createdAt, updatedAt: job.updatedAt, expiresAt: job.expiresAt,
      audioPath: job.audioPath, encryptedText: job.text ? protectResult(job.text) : '',
      error: job.error, cancelRequested: job.cancelRequested,
    })))
    saveChain = saveChain.then(async () => {
      const tmp = indexFile + '.' + randomUUID() + '.tmp'
      await writeFile(tmp, snapshot, 'utf8')
      try {
        for (let attempt = 0; ; attempt++) {
          try {
            await rename(tmp, indexFile)
            break
          } catch (error) {
            if (!['EPERM', 'EACCES'].includes(error?.code) || attempt >= 5) throw error
            await new Promise((resolve) => setTimeout(resolve, 20 * (2 ** attempt)))
          }
        }
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => {})
        throw error
      }
    })
    return saveChain
  }

  function countForOwner(owner) {
    let n = active?.owner === owner ? 1 : 0
    for (const job of pending) if (job.owner === owner) n++
    for (const job of jobs.values()) if (job.owner === owner && job.status === 'uploading') n++
    return n
  }

  function uploadingCount() {
    let n = 0
    for (const job of jobs.values()) if (job.status === 'uploading') n++
    return n
  }

  function capacity(owner) {
    return ready && getFreeMemory() >= MIN_FREE_RAM_BYTES && pending.length < maxPending && countForOwner(owner) < perUserPending
  }

  async function finish(job, status, details = {}) {
    job.status = status
    job.updatedAt = Date.now()
    job.expiresAt = Date.now() + RETAIN_MS
    if (details.text !== undefined) job.text = details.text
    if (details.error !== undefined) job.error = String(details.error).slice(0, 300)
    job.audioPath = ''
    await persist()
    if (details.fileToRemove) await rm(details.fileToRemove, { force: true }).catch(() => {})
  }

  async function pump() {
    if (pumping || active || !ready) return
    pumping = true
    try {
      while (!active && pending.length && ready) {
        const job = pending.shift()
        if (job.status === 'cancelled') continue
        active = job
        job.status = 'processing'
        job.updatedAt = Date.now()
        await persist()
        try {
          const text = await worker.transcribe({ id: job.id, wavPath: job.audioPath })
          await finish(job, job.cancelRequested ? 'cancelled' : 'complete', {
            text: job.cancelRequested ? '' : text,
            fileToRemove: job.audioPath,
          })
        } catch (error) {
          const message = String(error?.message || 'Transcription failed.')
          if (error?.code === 'SPEECH_UNAVAILABLE' || (!ready && message === 'Speech service stopped.')) {
            job.status = 'queued'
            job.updatedAt = Date.now()
            pending.unshift(job)
            await persist()
            if (ready && !retryTimer) {
              retryTimer = setTimeout(() => {
                retryTimer = null
                void pump()
              }, 3000)
              retryTimer.unref?.()
            }
            break
          }
          log.warn('[speech] job failed id=' + job.id + ': ' + message.slice(0, 180))
          await finish(job, 'failed', { error: message, fileToRemove: job.audioPath })
        } finally { active = null }
      }
    } finally {
      pumping = false
      while (pumpWaiters.length) pumpWaiters.shift()()
    }
  }

  async function initialize() {
    await mkdir(audioDir, { recursive: true })
    let saved = []
    try {
      const raw = await readFile(indexFile, 'utf8')
      let parsed
      try { parsed = JSON.parse(raw) }
      catch { throw new Error('Speech job state is corrupt; queued audio has been preserved and service startup was stopped.') }
      if (!Array.isArray(parsed)) throw new Error('Speech job state has an invalid format; queued audio has been preserved and service startup was stopped.')
      saved = parsed.slice(-1000)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    for (const raw of saved) {
      if (!raw || !/^[0-9a-f-]{36}$/i.test(raw.id || '') || !raw.owner || !raw.orgId) continue
      if (raw.expiresAt && raw.expiresAt < Date.now()) {
        if (raw.audioPath && isWithin(audioDir, path.resolve(raw.audioPath))) await rm(raw.audioPath, { force: true }).catch(() => {})
        continue
      }
      const job = { ...raw, text: raw.encryptedText ? unprotectResult(raw.encryptedText) : '' }
      delete job.encryptedText
      if (job.status === 'uploading') {
        job.status = 'failed'
        job.error = 'Audio upload was interrupted by Host restart.'
        job.audioPath = ''
        job.updatedAt = Date.now()
        job.expiresAt = Date.now() + RETAIN_MS
      }
      if (job.status === 'processing') job.status = 'queued'
      if (job.status === 'queued') {
        try { if (!isWithin(await realpath(audioDir), await realpath(job.audioPath))) throw new Error() }
        catch { job.status = 'failed'; job.error = 'Queued audio was unavailable after Host restart.'; job.audioPath = ''; job.expiresAt = Date.now() + RETAIN_MS }
        if (job.status === 'queued') pending.push(job)
      }
      if (job.requestId) requests.set(requestKey(job.owner, job.orgId, job.requestId), job.id)
      jobs.set(job.id, job)
    }
    const retainedAudio = new Set([...jobs.values()].filter((job) => job.audioPath).map((job) => path.basename(job.audioPath)))
    for (const name of await readdir(audioDir).catch(() => [])) {
      if (/^[0-9a-f-]{36}\.upload$/i.test(name) || (/^[0-9a-f-]{36}\.wav$/i.test(name) && !retainedAudio.has(name))) {
        await rm(path.join(audioDir, name), { force: true }).catch(() => {})
      }
    }
    ready = true
    await persist()
    cleanupTimer = setInterval(() => cleanup().catch((error) => log.warn('[speech] cleanup failed:', error?.message || error)), 60_000)
    void pump()
  }

  async function findRequest(owner, orgId, requestId) {
    const id = requests.get(requestKey(owner, orgId, requestId))
    const job = id ? jobs.get(id) : null
    return job ? publicJob(job) : null
  }

  async function createFromRequest(req, { owner, orgId, requestId, contentType }) {
    if (!ready) throw Object.assign(new Error('Speech service is not ready.'), { status: 503 })
    if (!REQUEST_ID_RE.test(String(requestId || ''))) throw Object.assign(new Error('Missing or invalid request id.'), { status: 400 })
    const key = requestKey(owner, orgId, requestId)
    // The caller may have awaited the same lookup at the same time. Recheck
    // the reservation synchronously before accepting the upload so concurrent
    // retries cannot create two jobs for one idempotency key.
    const duplicateId = requests.get(key)
    const duplicate = duplicateId ? jobs.get(duplicateId) : null
    if (duplicate) { req.resume(); return publicJob(duplicate) }
    if (getFreeMemory() < MIN_FREE_RAM_BYTES) throw Object.assign(new Error('Host is temporarily low on available memory. Try again later.'), { status: 503 })
    if (pending.length + uploadingCount() >= maxPending) throw Object.assign(new Error('Speech queue is full. Try again later.'), { status: 429 })
    if (countForOwner(owner) >= perUserPending) throw Object.assign(new Error('This user already has speech jobs waiting.'), { status: 429 })

    const id = randomUUID()
    const incoming = path.join(audioDir, id + '.upload')
    const wav = path.join(audioDir, id + '.wav')
    let bytes = 0
    const chunks = []
    let headSize = 0
    const output = createWriteStream(incoming, { flags: 'wx', mode: 0o600 })
    const outputDone = finished(output)
    const job = { id, owner, orgId, requestId, status: 'uploading', createdAt: Date.now(), updatedAt: Date.now(),
      audioPath: '', text: '', error: '', cancelRequested: false }
    jobs.set(id, job)
    requests.set(key, id)
    try {
      await persist()
      for await (const chunk of req) {
        bytes += chunk.length
        if (bytes > MAX_UPLOAD_BYTES) throw Object.assign(new Error('Audio upload exceeds the 25 MB limit.'), { status: 413 })
        if (headSize < 32) {
          const part = Buffer.from(chunk.subarray(0, 32 - headSize))
          chunks.push(part)
          headSize += part.length
        }
        if (!output.write(chunk)) await once(output, 'drain')
      }
      output.end()
      await outputDone
      if (!bytes) throw Object.assign(new Error('Audio upload is empty.'), { status: 400 })
      const head = Buffer.concat(chunks).subarray(0, 32)
      const kind = audioKind(head)
      if (!kind) throw Object.assign(new Error('Unsupported or invalid audio file.'), { status: 415 })
      if (!ffmpeg && kind !== 'wav') throw Object.assign(new Error('Host audio converter is unavailable.'), { status: 503 })
      if (ffmpeg) await convertToWav(ffmpeg, incoming, wav)
      else await rename(incoming, wav)
      await validatePcmWav(wav)
      await unlink(incoming).catch(() => {})

      job.status = 'queued'
      job.updatedAt = Date.now()
      job.audioPath = wav
      pending.push(job)
      await persist()
      void pump()
      return publicJob(job)
    } catch (error) {
      output.destroy()
      await outputDone.catch(() => {})
      await rm(incoming, { force: true }).catch(() => {})
      await rm(wav, { force: true }).catch(() => {})
      job.status = 'failed'
      job.error = String(error?.message || 'Audio upload failed.').slice(0, 300)
      job.updatedAt = Date.now()
      job.expiresAt = Date.now() + RETAIN_MS
      await persist().catch(() => {})
      throw error
    }
  }

  async function get(id, owner, orgId) {
    const job = jobs.get(id)
    if (!job || job.owner !== owner || job.orgId !== orgId) return null
    return publicJob(job)
  }

  async function cancel(id, owner, orgId) {
    const job = jobs.get(id)
    if (!job || job.owner !== owner || job.orgId !== orgId) return null
    if (job.status === 'queued') {
      const i = pending.findIndex((x) => x.id === id)
      if (i >= 0) pending.splice(i, 1)
      await finish(job, 'cancelled', { fileToRemove: job.audioPath })
    } else if (job.status === 'processing') {
      job.cancelRequested = true
      job.updatedAt = Date.now()
      await persist()
    }
    return publicJob(job)
  }

  async function cleanup() {
    const now = Date.now()
    for (const [id, job] of jobs) {
      if (job.expiresAt && job.expiresAt <= now && job.id !== active?.id) {
        if (job.audioPath && isWithin(audioDir, path.resolve(job.audioPath))) await rm(job.audioPath, { force: true }).catch(() => {})
        jobs.delete(id)
        if (job.requestId) requests.delete(requestKey(job.owner, job.orgId, job.requestId))
      }
    }
    await persist()
  }

  async function close() {
    ready = false
    if (cleanupTimer) clearInterval(cleanupTimer)
    if (retryTimer) clearTimeout(retryTimer)
    cleanupTimer = null
    retryTimer = null
    // Stop an active inference first, then wait for its rejection handler to
    // persist the job back as queued before the Host exits.
    if (typeof worker.stop === 'function') await worker.stop().catch(() => {})
    if (pumping) await new Promise((resolvePump) => pumpWaiters.push(resolvePump))
    await saveChain.catch(() => {})
  }

  return { initialize, createFromRequest, findRequest, get, cancel, cleanup, capacity, close,
    status: () => ({ ready, queued: pending.length, activeJobId: active?.id || '' }) }
}
