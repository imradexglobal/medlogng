// Hub configuration — every knob comes from the environment so the hub PC
// never needs code edits. Reads a plain .env-style file if present (no
// dependency: a two-line parser) plus process.env overrides.
//
//   HUB_HOST          bind address                     (default 0.0.0.0 = LAN)
//                     use 127.0.0.1 to accept this PC only
//   PORT              listen port                       (default 8787)
//   ALLOWED_ORIGINS   extra browser origins allowed to call /outbox
//                     comma-separated, e.g. https://medlogng.web.app
//                     The hub's own origin (the address the page was served
//                     from) is always allowed; nothing else is.
//   PROJECT_ID        firebase project                  (default medlogng)
//   KEY_FILE          service-account json path         (default hub/keys/service-account.json)
//   QUEUE_FILE        durable queue state file          (default hub/queue.json)
//   RELAY_MS          relay tick interval               (default 15000 = 15s)
//
// HUB_TOKEN is obsolete and ignored. If it is still set, the server logs a
// warning: the shared secret must be removed from .env and from every client.
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
    const val = m[2].replace(/^["']|["']$/g, '')
    if (process.env[key] === undefined) process.env[key] = val
  }
}
loadEnvFile()

export function normalizeOrigin(origin) {
  const raw = String(origin || '').trim().replace(/\/+$/, '')
  if (!raw) return ''
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return (u.protocol + '//' + u.host).toLowerCase()
  } catch {
    return ''
  }
}

export function parseOrigins(value) {
  const out = []
  for (const part of String(value || '').split(',')) {
    const origin = normalizeOrigin(part)
    if (origin && !out.includes(origin)) out.push(origin)
  }
  return out
}

export function loadConfig() {
  const keyFile = process.env.KEY_FILE
    ? resolve(PROJECT_ROOT, process.env.KEY_FILE)
    : resolve(HUB_DIR, 'keys', 'service-account.json')
  const host = String(process.env.HUB_HOST || '0.0.0.0').trim() || '0.0.0.0'
  return {
    host,
    port: Number(process.env.PORT) || 8787,
    // Extra cross-origin callers. Same-origin (the app served by this hub) is
    // always allowed and never needs listing here.
    allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
    projectId: process.env.GCLOUD_PROJECT || process.env.PROJECT_ID || 'medlogng',
    keyFile,
    queueFile: process.env.QUEUE_FILE
      ? resolve(PROJECT_ROOT, process.env.QUEUE_FILE)
      : resolve(HUB_DIR, 'queue.json'),
    relayMs: Number(process.env.RELAY_MS) || 15000,
    emulator: process.env.FIRESTORE_EMULATOR_HOST || '',
    // Obsolete shared secret retained only so the server can warn about it.
    legacyToken: process.env.HUB_TOKEN || '',
  }
}
