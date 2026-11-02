// Owns one persistent CPU Whisper worker for the Host process.
// The worker speaks a private line protocol over stdio; it does not open a
// network listener. Only the hub should call transcribe().
import { spawn } from 'node:child_process'
import { realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { createInterface } from 'node:readline'

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/

function inside(parent, child) {
  const rel = path.relative(parent, child)
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)
}

export function createSpeechWorker({ executable, model, audioDir, threads = 1, log = console,
  spawnProcess = spawn, startupTimeoutMs = 120_000, transcribeTimeoutMs = 15 * 60 * 1000 }) {
  const queue = []
  const requests = new Map()
  let child = null
  let lineReader = null
  let active = null
  let modelReady = false
  let stopping = false
  let lastError = ''
  let startedAt = 0
  let pumpPromise = null
  let startPromise = null
  let restartTimer = null
  let activeTimer = null

  function workerError(message, code = 'SPEECH_UNAVAILABLE') {
    const error = new Error(message)
    error.code = code
    return error
  }

  function scheduleRestart() {
    if (stopping || restartTimer) return
    restartTimer = setTimeout(() => {
      restartTimer = null
      start().catch((error) => {
        lastError = String(error?.message || error)
        log.warn('[speech] worker restart failed:', lastError)
      })
    }, 3000)
    restartTimer.unref?.()
  }

  function status() {
    return {
      enabled: true,
      ready: modelReady && !!child && child.exitCode === null && child.stdin?.writable,
      activeJobId: active?.id || '',
      queued: queue.length,
      lastError,
      startedAt: startedAt || null,
    }
  }

  function failAll(error) {
    const failure = error instanceof Error ? error : new Error(String(error || 'Speech worker stopped.'))
    const message = String(failure.message || 'Speech worker stopped.')
    lastError = message
    if (active) {
      clearTimeout(activeTimer)
      activeTimer = null
      active.reject(failure)
      requests.delete(active.id)
      active = null
    }
    while (queue.length) {
      const job = queue.shift()
      requests.delete(job.id)
      job.reject(failure)
    }
  }

  function onLine(line) {
    if (line === 'READY' || line === 'STOPPED') return
    const first = line.indexOf('\t')
    const second = first < 0 ? -1 : line.indexOf('\t', first + 1)
    if (first < 0 || second < 0) {
      log.warn('[speech] ignored malformed worker response')
      return
    }
    const id = line.slice(0, first)
    const kind = line.slice(first + 1, second)
    const payload = line.slice(second + 1)
    if (!active || active.id !== id) {
      log.warn('[speech] ignored response for an inactive job')
      return
    }
    const job = active
    active = null
    clearTimeout(activeTimer)
    activeTimer = null
    requests.delete(id)
    if (kind === 'OK') {
      try { job.resolve(Buffer.from(payload, 'base64').toString('utf8')) }
      catch (error) { job.reject(error) }
    } else {
      const message = Buffer.from(payload, 'base64').toString('utf8') || 'Transcription failed.'
      lastError = message
      job.reject(new Error(message))
    }
    void pump()
  }

  async function launch() {
    if (child && child.exitCode === null) return status()
    stopping = false
    const bin = await realpath(executable)
    const modelPath = await realpath(model)
    const audioRoot = await realpath(audioDir)
    const [binStat, modelStat] = await Promise.all([stat(bin), stat(modelPath)])
    if (!binStat.isFile() || !modelStat.isFile()) throw new Error('Speech engine or model is unavailable.')

    child = spawnProcess(bin, ['--model', modelPath, '--audio-dir', audioRoot, '--threads', String(threads)], {
      cwd: path.dirname(bin),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const current = child
    modelReady = false
    lineReader = createInterface({ input: current.stdout, crlfDelay: Infinity })
    lineReader.on('line', onLine)
    current.stderr.on('data', (chunk) => {
      const line = String(chunk).trim()
      if (line) log.info('[speech-worker]', line.slice(0, 500))
    })
    current.once('error', (error) => {
      if (child !== current) return
      failAll(workerError('Speech engine could not start: ' + (error?.message || error)))
    })
    current.once('exit', (code, signal) => {
      if (child !== current) return
      lineReader?.close()
      lineReader = null
      child = null
      modelReady = false
      if (!stopping) {
        failAll(workerError('Speech engine exited (' + (code ?? signal ?? 'unknown') + ').'))
        scheduleRestart()
      }
    })

    // The worker writes READY only after it has loaded the model.
    await new Promise((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        finish(workerError('Speech model startup timed out.'))
        try { current.kill() } catch {}
      }, startupTimeoutMs)
      const finish = (error) => {
        clearTimeout(timer)
        lineReader?.removeListener('line', readyLine)
        if (error) rejectReady(error)
        else resolveReady()
      }
      const readyLine = (line) => {
        if (line === 'READY') { modelReady = true; finish() }
        else onLine(line)
      }
      lineReader?.on('line', readyLine)
      current.once('exit', (code) => finish(new Error('Speech engine exited before the model loaded (' + code + ').')))
    })
    startedAt = Date.now()
    lastError = ''
    void pump()
    return status()
  }

  async function start() {
    if (startPromise) return startPromise
    if (child && child.exitCode === null && status().ready) return status()
    stopping = false
    clearTimeout(restartTimer)
    restartTimer = null
    startPromise = launch().catch((error) => {
      lastError = String(error?.message || error)
      if (child && child.exitCode === null) {
        try { child.kill() } catch {}
      }
      scheduleRestart()
      throw error
    }).finally(() => { startPromise = null })
    return startPromise
  }

  async function pump() {
    if (pumpPromise) return pumpPromise
    pumpPromise = (async () => {
      if (!child || child.exitCode !== null || active || stopping) return
      const job = queue.shift()
      if (!job) return
      active = job
      try {
        const wav = await realpath(job.wavPath)
        if (!inside(await realpath(audioDir), wav)) throw new Error('Audio path is outside the speech temporary folder.')
        const info = await stat(wav)
        if (!info.isFile() || info.size < 44) throw new Error('Audio file is empty or invalid.')
        activeTimer = setTimeout(() => {
          if (active?.id !== job.id) return
          active = null
          requests.delete(job.id)
          job.reject(workerError('Transcription timed out. Please submit the recording again.', 'SPEECH_TIMEOUT'))
          activeTimer = null
          const current = child
          child = null
          modelReady = false
          lineReader?.close()
          lineReader = null
          try { current?.kill() } catch {}
          scheduleRestart()
          void pump()
        }, transcribeTimeoutMs)
        activeTimer.unref?.()
        child.stdin.write(job.id + '\t' + wav + '\n', (error) => {
          if (error && active?.id === job.id) {
            clearTimeout(activeTimer)
            activeTimer = null
            active = null
            requests.delete(job.id)
            job.reject(workerError('Speech engine stopped while accepting the job.'))
            void pump()
          }
        })
      } catch (error) {
        active = null
        requests.delete(job.id)
        job.reject(error)
        void pump()
      }
    })().finally(() => { pumpPromise = null })
    return pumpPromise
  }

  async function transcribe({ id, wavPath }) {
    if (!ID_RE.test(String(id || ''))) throw new Error('Invalid transcription job id.')
    if (requests.has(id)) throw new Error('Duplicate transcription job id.')
    if (queue.length >= 10) throw new Error('Speech queue is full.')
    if (!child || child.exitCode !== null || !status().ready) throw workerError('Speech service is restarting. The job can be retried.')
    const promise = new Promise((resolve, reject) => {
      const job = { id, wavPath, resolve, reject }
      requests.set(id, job)
      queue.push(job)
    })
    void pump()
    return promise
  }

  async function stop() {
    stopping = true
    clearTimeout(restartTimer)
    restartTimer = null
    clearTimeout(activeTimer)
    activeTimer = null
    failAll(new Error('Speech service stopped.'))
    if (!child) return
    const current = child
    child = null
    modelReady = false
    lineReader?.close()
    lineReader = null
    await new Promise((resolveStop) => {
      const timer = setTimeout(() => { try { current.kill() } catch {}; resolveStop() }, 5000)
      current.once('exit', () => { clearTimeout(timer); resolveStop() })
      try { current.stdin.end('QUIT\n') } catch { try { current.kill() } catch {}; clearTimeout(timer); resolveStop() }
    })
  }

  async function restart() {
    await stop()
    return start()
  }

  return { start, stop, restart, transcribe, status }
}
