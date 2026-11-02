import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const cli = resolve(root, 'node_modules/firebase-tools/lib/bin/firebase.js')
const configHome = mkdtempSync(join(tmpdir(), 'medilogng-firebase-cli-'))
try {
  const args = [cli, 'emulators:exec', '--only', 'auth,firestore,functions', '--project', 'demo-medlogng', 'node scripts/test/clinical-ai.functions.emulator.mjs']
  const result = spawnSync(process.execPath, args, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, XDG_CONFIG_HOME: configHome },
  })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(configHome, { recursive: true, force: true })
}
