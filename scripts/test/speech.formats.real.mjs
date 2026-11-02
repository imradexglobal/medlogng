// Real media conversion + transcription against the packaged Windows assets.
// M4A/AAC/WebM/OGG fixtures are encoded from the pinned public JFK sample;
// WAV and MP3 are the upstream sample files. This is format coverage, not a
// clinical-accuracy evaluation.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createSpeechWorker } from '../../hub/speech/worker.js'
import { createSpeechJobs } from '../../hub/speech/jobs.js'

const root = path.resolve(import.meta.dirname, '../..')
const speechDir = path.join(root, 'vendor', 'speech')
const sampleDir = path.join(root, '.cache', 'whisper.cpp-v1.9.5', 'samples')
const temp = await mkdtemp(path.join(root, '.tmp-speech-formats-'))
const audioDir = path.join(temp, 'audio')
await mkdir(audioDir)

const ffmpeg = path.join(speechDir, 'ffmpeg.exe')
const sampleWav = path.join(sampleDir, 'jfk.wav')
const formats = [
  { name: 'WAV', file: sampleWav, contentType: 'audio/wav' },
  { name: 'MP3', file: path.join(sampleDir, 'jfk.mp3'), contentType: 'audio/mpeg' },
  { name: 'M4A', ext: 'm4a', args: ['-c:a', 'aac', '-b:a', '96k'], contentType: 'audio/mp4' },
  { name: 'AAC', ext: 'aac', args: ['-c:a', 'aac', '-b:a', '96k', '-f', 'adts'], contentType: 'audio/aac' },
  { name: 'WebM', ext: 'webm', args: ['-c:a', 'opus', '-b:a', '96k'], contentType: 'audio/webm' },
  { name: 'OGG', ext: 'ogg', args: ['-ac', '2', '-c:a', 'vorbis', '-b:a', '96k'], contentType: 'audio/ogg' },
]

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, 'FFmpeg failed: ' + (result.stderr || result.error?.message || 'unknown error'))
}

let worker
let jobs
try {
  for (const format of formats) {
    if (!format.ext) continue
    format.file = path.join(temp, format.name.toLowerCase() + '.' + format.ext)
    runFfmpeg([
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sampleWav, '-vn',
      '-strict', '-2', ...format.args, format.file,
    ])
  }

  worker = createSpeechWorker({
    executable: path.join(speechDir, 'medilog-whisper-worker.exe'),
    model: path.join(speechDir, 'ggml-tiny.en-q5_1.bin'),
    audioDir,
    threads: 1,
    log: { info() {}, warn() {}, error() {} },
  })
  await worker.start()
  jobs = createSpeechJobs({
    directory: temp,
    worker,
    ffmpeg,
    // Format coverage needs deterministic queue acceptance; target memory
    // admission is measured separately on the real Host hardware.
    getFreeMemory: () => 2 * 1024 ** 3,
    log: { info() {}, warn() {}, error() {} },
  })
  await jobs.initialize()

  for (const format of formats) {
    const startedAt = Date.now()
    const result = await jobs.createFromRequest(Readable.from([await readFile(format.file)]), {
      owner: 'format-audit-user',
      orgId: 'format-audit-org',
      requestId: 'format-' + format.name.toLowerCase() + '-001',
      contentType: format.contentType,
    })
    let job
    const deadline = Date.now() + 120_000
    do {
      job = await jobs.get(result.id, 'format-audit-user', 'format-audit-org')
      if (job?.status === 'complete' || job?.status === 'failed') break
      await new Promise((resolve) => setTimeout(resolve, 100))
    } while (Date.now() < deadline)

    assert.equal(job?.status, 'complete', format.name + ' failed: ' + (job?.error || 'timed out'))
    assert.match(job.text, /ask not what your country can do for you/i)
    process.stdout.write('PASS ' + format.name + ': converted and transcribed in ' + ((Date.now() - startedAt) / 1000).toFixed(2) + ' s\n')
  }

  const corrupt = path.join(temp, 'corrupt.mp3')
  await writeFile(corrupt, Buffer.from([0xff, 0xfb, 0x90, 0x64, ...Array(128).fill(0)]))
  await assert.rejects(jobs.createFromRequest(Readable.from([await readFile(corrupt)]), {
    owner: 'format-audit-user', orgId: 'format-audit-org', requestId: 'format-corrupt-001', contentType: 'audio/mpeg',
  }))
  process.stdout.write('PASS corrupted MP3 rejected\n')

  await assert.rejects(jobs.createFromRequest(Readable.from([Buffer.from('not audio')]), {
    owner: 'format-audit-user', orgId: 'format-audit-org', requestId: 'format-unsupported-001', contentType: 'application/octet-stream',
  }), (error) => error.status === 415)
  process.stdout.write('PASS unsupported format rejected with HTTP 415\n')
} finally {
  await jobs?.close()
  await worker?.stop()
  await rm(temp, { recursive: true, force: true })
}
