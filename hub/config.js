// Hub configuration — every knob comes from the environment so the hub PC
// never needs code edits. Reads a plain .env-style file if present (no
// dependency: a two-line parser) plus process.env overrides.
//
//   PORT          listen port                     (default 8787)
//   HUB_TOKEN     shared secret clients must send  (REQUIRED in production)
//   PROJECT_ID    firebase project                 (default medlogng)
//   KEY_FILE      service-account json path        (default hub/keys/service-account.json)
//   QUEUE_FILE    durable queue state file         (default hub/queue.json)
//   RELAY_MS      relay tick interval              (default 15000 = 15s)
//
// FIRESTORE_EMULATOR_HOST / GCLOUD_PROJECT are honoured by the firebase-admin
// SDK itself, which is how the smoke test runs against the local emulator.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HUB_DIR = dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = resolve(HUB_DIR, '..')

// Minimal .env reader: KEY=VALUE lines, # comments, no export keyword.
function loadEnvFile() {
  const p = resolve(PROJECT_ROOT, '.env')
  if (!existsSync(p)) return
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    const key = m[1]
    let val = m[2].replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvFile()

export function loadConfig() {
  const keyFile = process.env.KEY_FILE
    ? resolve(PROJECT_ROOT, process.env.KEY_FILE)
    : resolve(HUB_DIR, 'keys', 'service-account.json')
  return {
    port: Number(process.env.PORT) || 8787,
    // Empty token = "refuse to start": a hub with no secret would accept
    // prescriptions from anyone who finds its IP.
    token: process.env.HUB_TOKEN || '',
    projectId: process.env.GCLOUD_PROJECT || process.env.PROJECT_ID || 'medlogng',
    keyFile,
    queueFile: process.env.QUEUE_FILE
      ? resolve(PROJECT_ROOT, process.env.QUEUE_FILE)
      : resolve(HUB_DIR, 'queue.json'),
    relayMs: Number(process.env.RELAY_MS) || 15000,
    emulator: process.env.FIRESTORE_EMULATOR_HOST || '',
  }
}
