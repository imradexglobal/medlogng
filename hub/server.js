// MediLog NG LAN hub — HTTP front door.
//
//   GET  /         the EMR app itself (serves dist/ when present)
//   GET  /health   { ok, internet, queue counts, lastContact, ... }
//   POST /outbox   { ops: [...] } -> durably queued, acked in milliseconds
//
// ONE port does everything. Ward PCs load the app from here AND the app's
// offline handoffs post back to the same origin — which quietly removes every
// browser obstacle (mixed content, Private Network Access, CORS) that a page
// on the public internet would hit when talking to a LAN device.
//
// The hub never waits for the internet to acknowledge a handoff: POST /outbox
// only touches the local queue file, and the relay delivers later. That is
// what lets a department machine with a dead internet line keep accepting
// prescriptions from the ward.
//
// Auth: a single shared secret (HUB_TOKEN) in the `x-hub-token` header —
// compared in constant time. CORS stays wide open so pages NOT served from
// here (e.g. https://medlogng.web.app during transition) can still post.

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs'
import { join, extname, normalize, resolve } from 'node:path'
import { createHash, timingSafeEqual } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { loadConfig, PROJECT_ROOT } from './config.js'
import { createQueue } from './queue.js'
import { initFirestore, HANDLERS, PermanentError } from './handlers.js'
import { createRelay } from './relay.js'

const VERSION = 'hub-1.1.0'
const MAX_BODY = 1024 * 1024 // 1 MB
const MAX_OPS = 100
const KEY_RE = /^[A-Za-z0-9_:.\-]{1,160}$/

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

const sha = (s) => createHash('sha256').update(String(s)).digest()
function tokenOk(presented, expected) {
  if (!expected) return false
  try {
    return timingSafeEqual(sha(presented || ''), sha(expected))
  } catch {
    return false
  }
}

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-hub-token')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  // Chrome's Private Network Access preflight: a public https page talking to
  // a 192.168.x device asks for this explicitly.
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
}

function json(res, code, body) {
  const payload = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(payload)
}

function validateOp(raw, index) {
  if (!raw || typeof raw !== 'object') return 'op[' + index + '] is not an object'
  if (typeof raw.clientOpKey !== 'string' || !KEY_RE.test(raw.clientOpKey)) {
    return 'op[' + index + '].clientOpKey missing or malformed'
  }
  if (typeof raw.kind !== 'string' || !HANDLERS[raw.kind]) {
    return 'op[' + index + '].kind unknown: ' + String(raw.kind)
  }
  if (typeof raw.orgId !== 'string' || !raw.orgId || raw.orgId.length > 100) {
    return 'op[' + index + '].orgId missing'
  }
  if (!raw.args || typeof raw.args !== 'object' || Array.isArray(raw.args)) {
    return 'op[' + index + '].args must be an object'
  }
  return ''
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// Serves the built web app (dist/) from this same port. Returns true when the
// request was handled. Path-traversal safe; unknown routes without a file
// extension fall back to index.html so client-side URLs (e.g. /login) work
// as bookmarkable addresses.
//
// HTML pages get the hub token injected as window.__MEDILOG_HUB_TOKEN__.
// That is deliberate: any device allowed to LOAD the app from this hub is
// already allowed to use the EMR, so handing it the sync secret needs zero
// setup on ward PCs — and the secret never ships in an installer. (Do not
// port-forward the hub past the hospital router.)
function makeStaticHandler(staticDir, token) {
  if (!staticDir) return null
  const root = resolve(staticDir)
  const inject = token
    ? '<script>window.__MEDILOG_HUB_TOKEN__=' + JSON.stringify(token) + ';</script>'
    : ''
  return function serveStatic(req, res, url) {
    const rel = url === '/' ? 'index.html' : decodeURIComponent(url).replace(/^\/+/, '')
    const candidate = resolve(root, normalize(rel))
    // Compare on forward slashes: on Windows resolve() yields backslashes and
    // a naive startsWith(root + '/') would reject every legitimate file.
    const rootFs = root.replace(/\\/g, '/')
    const candFs = candidate.replace(/\\/g, '/')
    if (candFs !== rootFs && !candFs.startsWith(rootFs + '/')) {
      json(res, 403, { ok: false, error: 'forbidden' })
      return true
    }
    let file = candidate
    let isDir = false
    try { isDir = statSync(file).isDirectory() } catch { /* missing — handled below */ }
    if (isDir) file = join(file, 'index.html')
    if (!existsSync(file) && !extname(rel)) file = join(root, 'index.html') // SPA fallback
    if (!existsSync(file)) {
      json(res, 404, { ok: false, error: 'not found' })
      return true
    }
    const ext = extname(file).toLowerCase()
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream' }
    // The service worker and the HTML (which carries the injected token)
    // must always be revalidated — a stale one would pin ward PCs to an old
    // app version or an old secret forever.
    if (file.endsWith('sw.js') || ext === '.html') headers['cache-control'] = 'no-cache'
    if (ext === '.html' && inject) {
      const html = readFileSync(file, 'utf8').replace(/<\/head>/i, inject + '</head>')
      const buf = Buffer.from(html)
      headers['content-length'] = String(buf.length)
      res.writeHead(200, headers)
      res.end(buf)
      return true
    }
    res.writeHead(200, headers)
    createReadStream(file).pipe(res)
    return true
  }
}

// Build the server (exported so tests can mount it on an ephemeral port).
export function startHub(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides }
  const log = overrides.log || console

  if (!cfg.token && !cfg.allowNoToken) {
    throw new Error(
      'HUB_TOKEN is not set. Generate one (e.g. an openssl rand -hex 32 style random string),\n' +
      'put it in .env as HUB_TOKEN=..., and give the SAME value to every client (VITE_HUB_TOKEN).'
    )
  }

  const queue = createQueue(cfg.queueFile)

  // Serve the built app when present. Electron host mode passes an explicit
  // dir (the packaged dist); standalone `node hub/server.js` auto-detects
  // ./dist — with no dist, the hub behaves as before (API only).
  const staticDir = overrides.staticDir !== undefined
    ? overrides.staticDir
    : (existsSync(resolve(PROJECT_ROOT, 'dist', 'index.html')) ? resolve(PROJECT_ROOT, 'dist') : '')
  const serveStatic = makeStaticHandler(staticDir, cfg.token)

  let db = null
  let firestoreError = ''
  try {
    db = initFirestore(cfg)
    log.info('[hub] firestore ready (project ' + cfg.projectId + (cfg.emulator ? ', emulator ' + cfg.emulator : '') + ')')
  } catch (e) {
    firestoreError = String(e?.message || e)
    log.warn('[hub] firestore NOT ready:', firestoreError, '— queue will hold ops until credentials are fixed')
  }

  const relay = createRelay({ db, queue, handlers: HANDLERS, cfg, log })

  const server = createServer(async (req, res) => {
    cors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    const url = (req.url || '/').split('?')[0]

    if (req.method === 'GET' && url === '/health') {
      const relayStatus = db ? await relay.refreshStatus() : relay.status()
      json(res, 200, {
        ok: true,
        version: VERSION,
        projectId: cfg.projectId,
        firestoreReady: !!db,
        firestoreError: firestoreError || undefined,
        internet: relayStatus.online,
        lastContact: relayStatus.lastContact,
        lastProbeError: relayStatus.lastError || undefined,
        queue: queue.counts(),
        tokenConfigured: !!cfg.token,
        servesApp: !!staticDir,
        time: new Date().toISOString(),
      })
      return
    }

    if (req.method === 'GET' && serveStatic) {
      serveStatic(req, res, url)
      return
    }

    if (req.method === 'GET' && url === '/') {
      json(res, 200, {
        ok: true,
        hub: true,
        version: VERSION,
        note: 'web app (dist/) not present on this hub — API only',
        endpoints: ['GET /health', 'POST /outbox'],
      })
      return
    }

    if (req.method === 'POST' && url === '/outbox') {
      if (!tokenOk(req.headers['x-hub-token'], cfg.token)) {
        json(res, 401, { ok: false, error: 'bad or missing x-hub-token' })
        return
      }
      let body
      try {
        body = await readBody(req, MAX_BODY)
      } catch (e) {
        json(res, e.code === 'TOO_LARGE' ? 413 : 400, { ok: false, error: String(e.message || e) })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(body)
      } catch {
        json(res, 400, { ok: false, error: 'body is not valid JSON' })
        return
      }
      const ops = Array.isArray(parsed?.ops) ? parsed.ops : null
      if (!ops || !ops.length) {
        json(res, 400, { ok: false, error: 'body must be { ops: [...] } with at least one op' })
        return
      }
      if (ops.length > MAX_OPS) {
        json(res, 400, { ok: false, error: 'too many ops per request (max ' + MAX_OPS + ')' })
        return
      }
      const errors = ops.map((o, i) => validateOp(o, i)).filter(Boolean)
      if (errors.length) {
        json(res, 400, { ok: false, error: errors[0], errors: errors.slice(0, 10) })
        return
      }

      // Durable before ack — after this returns the device may delete its copy.
      let accepted = 0
      let duplicates = 0
      for (const op of ops) {
        const r = queue.add({
          clientOpKey: op.clientOpKey,
          kind: op.kind,
          args: op.args,
          orgId: op.orgId,
          actor: op.actor && typeof op.actor === 'object' ? op.actor : null,
          createdAt: typeof op.createdAt === 'string' ? op.createdAt.slice(0, 40) : '',
        })
        if (r.duplicate) duplicates += 1
        else accepted += 1
      }
      log.info('[hub] accepted', accepted, 'ops' + (duplicates ? ' (' + duplicates + ' duplicates skipped)' : ''))
      json(res, 200, { ok: true, accepted, duplicates, queue: queue.counts() })
      return
    }

    json(res, 404, { ok: false, error: 'not found — try GET /health or POST /outbox' })
  })

  // Process-wide failure of a socket must not take the hub down.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, () => {
      relay.start()
      const addr = server.address()
      log.info(`[hub] listening on http://0.0.0.0:${addr.port}  (health: GET /health)`)
      resolve({
        cfg,
        queue,
        relay,
        server,
        db,
        close: () =>
          new Promise((r) => {
            relay.stop()
            server.close(() => r())
          }),
      })
    })
  })
}

// `node hub/server.js` starts it; an import (tests) does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHub().catch((e) => {
    console.error('[hub] failed to start:', e.message || e)
    process.exit(1)
  })
}
