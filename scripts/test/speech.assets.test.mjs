import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = await mkdtemp(join(process.cwd(), '.tmp-speech-assets-test-'))
const verifier = join(process.cwd(), 'scripts', 'verify-speech-assets.ps1')
const powershell = process.env.POWERSHELL_EXECUTABLE || 'pwsh.exe'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const runVerifier = (dir) => {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', verifier, '-AssetDir', dir]
  const modern = spawnSync(powershell, args, { encoding: 'utf8' })
  return modern.error?.code === 'ENOENT'
    ? spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, { encoding: 'utf8' })
    : modern
}

try {
  const missingDir = join(root, 'missing')
  await mkdir(missingDir)
  const missing = runVerifier(missingDir)
  assert.notEqual(missing.status, 0, 'missing required assets must fail verification')
  assert.match(missing.stderr + missing.stdout, /speech-assets\.json is missing/i)

  const corruptWorkerDir = join(root, 'corrupt-worker')
  await mkdir(corruptWorkerDir)
  const workerOriginal = Buffer.from([0x4d, 0x5a, 0x00])
  const workerCorrupt = Buffer.from([0x4d, 0x5a, 0xff])
  const model = Buffer.from('test model bytes')
  const ffmpeg = Buffer.from([0x4d, 0x5a, 0x00])
  const sourceArchive = Buffer.from('source')
  const sourceSignature = Buffer.from('official signature fixture')
  const signingKey = Buffer.from('official key fixture')
  const whisperLicense = Buffer.from('MIT License\n'.padEnd(180, 'x'))
  const ffmpegLicense = Buffer.from('GNU LESSER GENERAL PUBLIC LICENSE\n'.padEnd(180, 'x'))
  await writeFile(join(corruptWorkerDir, 'medilog-whisper-worker.exe'), workerCorrupt)
  await writeFile(join(corruptWorkerDir, 'ggml-tiny.en-q5_1.bin'), model)
  await writeFile(join(corruptWorkerDir, 'ffmpeg.exe'), ffmpeg)
  await writeFile(join(corruptWorkerDir, 'ffmpeg-9.0.2.tar.xz'), sourceArchive)
  await writeFile(join(corruptWorkerDir, 'ffmpeg-9.0.2.tar.xz.asc'), sourceSignature)
  await writeFile(join(corruptWorkerDir, 'ffmpeg-devel.asc'), signingKey)
  await writeFile(join(corruptWorkerDir, 'LICENSE-whisper.cpp.txt'), whisperLicense)
  await writeFile(join(corruptWorkerDir, 'COPYING.LGPLv2.1'), ffmpegLicense)
  const manifest = {
    schemaVersion: 1,
    architecture: 'windows-x64',
    whisperCpp: {
      source: 'https://github.com/ggml-org/whisper.cpp.git', version: 'v1.9.5', commit: 'd1be6fd', license: 'MIT',
      licenseFile: 'LICENSE-whisper.cpp.txt',
    },
    toolchain: {
      cmake: '4.2.0', visualStudioVersion: '17.14.0', compilerId: 'MSVC', compilerVersion: '19.44',
      platformToolset: 'v143', windowsSdkVersion: '10.0.26100.0',
    },
    worker: { file: 'medilog-whisper-worker.exe', version: 'v1.9.5', sizeBytes: workerOriginal.length, sha256: sha256(workerOriginal) },
    model: {
      file: 'ggml-tiny.en-q5_1.bin', version: 'tiny.en-q5_1', repositoryRevision: 'f281eb4', license: 'MIT',
      source: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/f281eb4/ggml-tiny.en-q5_1.bin',
      sizeBytes: model.length, sha256: sha256(model),
    },
    ffmpeg: {
      file: 'ffmpeg.exe', version: 'ffmpeg version test', license: 'LGPL-2.1-or-later', configuration: 'static test build',
      source: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz', sourceVersion: '9.0.2', sourceSha256: sha256(Buffer.from('source')),
      signature: 'https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz.asc',
      signatureFingerprint: 'FCF986EA15E6E293A5644F10B4322F04D67658D8', signatureVerified: true,
      sourceArchiveFile: 'ffmpeg-9.0.2.tar.xz', sourceSignatureFile: 'ffmpeg-9.0.2.tar.xz.asc',
      sourceSigningKeyFile: 'ffmpeg-devel.asc', licenseFile: 'COPYING.LGPLv2.1',
      toolchain: 'MSYS2 UCRT64 test manifest', configureArgs: ['--enable-static'],
      sizeBytes: ffmpeg.length, sha256: sha256(ffmpeg),
    },
  }
  await writeFile(join(corruptWorkerDir, 'speech-assets.json'), JSON.stringify(manifest))
  const corruptWorker = runVerifier(corruptWorkerDir)
  assert.notEqual(corruptWorker.status, 0, 'an asset that differs from its manifest hash must fail verification')
  assert.match(corruptWorker.stderr + corruptWorker.stdout, /SHA-256 does not match/i)

  manifest.ffmpeg.configuration = 'configuration: --enable-gpl'
  await writeFile(join(corruptWorkerDir, 'speech-assets.json'), JSON.stringify(manifest))
  const gplFfmpeg = runVerifier(corruptWorkerDir)
  assert.notEqual(gplFfmpeg.status, 0, 'an FFmpeg build enabling GPL components must fail verification')
  assert.match(gplFfmpeg.stderr + gplFfmpeg.stdout, /LGPL licence|GPL or nonfree/i)

  manifest.ffmpeg.configuration = 'static test build'
  await writeFile(join(corruptWorkerDir, 'medilog-whisper-worker.exe'), workerOriginal)
  await writeFile(join(corruptWorkerDir, 'ffmpeg-9.0.2.tar.xz'), Buffer.from('tampered source'))
  await writeFile(join(corruptWorkerDir, 'speech-assets.json'), JSON.stringify(manifest))
  const corruptSource = runVerifier(corruptWorkerDir)
  assert.notEqual(corruptSource.status, 0, 'a source archive that differs from its verified receipt must fail')
  assert.match(corruptSource.stderr + corruptSource.stdout, /source archive SHA-256 does not match/i)

  const corruptModelDir = join(root, 'corrupt-model')
  await mkdir(corruptModelDir)
  manifest.ffmpeg.configuration = 'static test build'
  const worker = Buffer.from([0x4d, 0x5a, 0x00])
  const wrongModel = Buffer.from('a corrupted or substituted model')
  await writeFile(join(corruptModelDir, 'medilog-whisper-worker.exe'), worker)
  await writeFile(join(corruptModelDir, 'ggml-tiny.en-q5_1.bin'), wrongModel)
  await writeFile(join(corruptModelDir, 'ffmpeg.exe'), ffmpeg)
  await writeFile(join(corruptModelDir, 'ffmpeg-9.0.2.tar.xz'), sourceArchive)
  await writeFile(join(corruptModelDir, 'ffmpeg-9.0.2.tar.xz.asc'), sourceSignature)
  await writeFile(join(corruptModelDir, 'ffmpeg-devel.asc'), signingKey)
  await writeFile(join(corruptModelDir, 'LICENSE-whisper.cpp.txt'), whisperLicense)
  await writeFile(join(corruptModelDir, 'COPYING.LGPLv2.1'), ffmpegLicense)
  manifest.worker.sizeBytes = worker.length
  manifest.worker.sha256 = sha256(worker)
  manifest.model.sizeBytes = wrongModel.length
  manifest.model.sha256 = sha256(wrongModel)
  manifest.ffmpeg.sizeBytes = ffmpeg.length
  manifest.ffmpeg.sha256 = sha256(ffmpeg)
  await writeFile(join(corruptModelDir, 'speech-assets.json'), JSON.stringify(manifest))
  const corruptModel = runVerifier(corruptModelDir)
  assert.notEqual(corruptModel.status, 0, 'a substituted model must fail its pinned upstream hash check')
  assert.match(corruptModel.stderr + corruptModel.stdout, /pinned upstream SHA-256/i)

  console.log('Speech asset verifier rejects missing assets, hash mismatches and substituted model files.')
} finally {
  await rm(root, { recursive: true, force: true })
}
