// MediLog NG LAN hub — HTTP front door (v2, verified Firebase Auth).
//
//   GET  /         the EMR app itself (serves dist/ when present)
//   GET  /health   { ok, version, hub } — operational detail on this PC / with auth
//   POST /outbox   { ops: [...] } -> authorised, durably queued, acked in ms
//
// ONE port does everything. Ward PCs load the app from here AND the app's
// offline handoffs post back to the same origin — which quietly removes every
// browser obstacle (mixed content, Private Network Access, CORS) that a page
// on the public internet would hit when talking to a LAN device.
//
// The hub never waits for the internet to acknowledge a handoff: POST /outbox
// only touches the local queue file, and the relay delivers later.
//
// AUTH MODEL (v2):
//   * The caller must present a Firebase Auth ID token: `Authorization: Bearer`.
//   * The Admin SDK verifies the signature and expiry.
//   * The requested organisation is checked against the caller's own
//     membership document; `orgId` in the body is a request, never proof.
//   * Each op kind maps to a capability (rx_mirror -> prescription.create,
//     lab_snapshot -> lab.order); a role without it is rejected.
//   * Every record the handler touches is checked for organisation ownership.
//   * Delivered writes append an audit_events row with the verified uid.
//
// There is NO shared secret, NO token injected into HTML, and NO wildcard
// CORS. HUB_TOKEN is obsolete; if it is still in .env the hub warns and
// ignores it.

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { networkInterfaces } from 'node:os'

import { loadConfig, PROJECT_ROOT, normalizeOrigin, parseOrigins } from './config.js'
import { createQueue } from './queue.js'
import { HANDLERS } from './handlers.js'
import { createRelay } from './relay.js'
import { initFoundation, foundationSummary } from './foundation.js'
import { createAuthenticator } from './auth.js'
import { createAuditor } from './audit.js'
import { validateOp, capabilityFor } from './ops.js'
import { listLanAddresses, startupLines, describeListenError } from './netinfo.js'

const VERSION = 'hub-2.0.0'
const MAX_BODY = 1024 * 1024 // 1 MB
const MAX_OPS = 100
const CLIENT_HEADER = 'x-medilog-client'
const CLIENT_VALUE = 'medilogng-web'

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

class RequestError extends Error {
  constructor(status, message, code = '') {
    super(message)
    this.status = status
    this.code = code
    this.expose = true
  }
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
}

function json(res, code, body, extra = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extra,
  })
  res.end(payload)
}

function isLoopbackAddress(address) {
  const a = String(address || '')
  return a === '::1' || a === '127.0.0.1' || a.startsWith('127.') || a === '::ffff:127.0.0.1'
}

function allowedOriginsFor(req, cfg) {
  const host = String(req.headers.host || '')
  const self = []
  if (host) {
    const http = normalizeOrigin('http://' + host)
    const https = normalizeOrigin('https://' + host)
    if (http) self.push(http)
    if (https) self.push(https)
  }
  return new Set([...self, ...(cfg.allowedOrigins || [])])
}

// Returns { ok, origin }. No Origin header = non-browser client (curl, the
// relay, a native app); auth is still required for sensitive routes, so this
// cannot be used to bypass anything. A browser Origin must be explicitly
// trusted: the hub's own page origin, or ALLOWED_ORIGINS.
function checkOrigin(req, cfg) {
  const raw = req.headers.origin
  if (!raw) return { ok: true, origin: '' }
  const origin = normalizeOrigin(raw)
  if (!origin) return { ok: false, origin: '' }
  return { ok: allowedOriginsFor(req, cfg).has(origin), origin }
}

function applyCors(req, res, cfg) {
  const origin = checkOrigin(req, cfg)
  if (origin.origin) res.setHeader('Vary', 'Origin')
  if (origin.ok && origin.origin) {
    res.setHeader('Access-Control-Allow-Origin', origin.origin)
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, ' + CLIENT_HEADER)
    res.setHeader('Access-Control-Max-Age', '600')
    if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
  }
  return origin
}

// Small in-memory sliding-window limiter. It protects the queue file and the
// Admin SDK from accidental loops; it is not a substitute for auth.
const buckets = new Map()
function rateLimit(key, limit, windowMs = 60_000) {
  const now = Date.now()
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (now > b.resetAt) buckets.delete(k)
  }
  let b = buckets.get(key)
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs }
    buckets.set(key, b)
  }
  b.count += 1
  return { ok: b.count <= limit, retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) }
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new RequestError(413, 'Request body is larger than ' + limit + ' bytes', 'too_large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function requireJson(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase()
  if (!/^application\/json\s*(;|$)/.test(type)) {
    throw new RequestError(415, 'Content-Type must be application/json', 'bad_content_type')
  }
  const encoding = String(req.headers['content-encoding'] || 'identity').toLowerCase()
  if (encoding !== 'identity') {
    throw new RequestError(415, 'Compressed request bodies are not supported', 'bad_content_encoding')
  }
}

async function readJson(req) {
  requireJson(req)
  const raw = await readBody(req, MAX_BODY)
  try {
    return JSON.parse(raw)
  } catch {
    throw new RequestError(400, 'Request body is not valid JSON', 'bad_json')
  }
}

// ---- static app ------------------------------------------------------------

function withinRoot(root, candidate) {
  const rootFs = root.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const candFs = candidate.replace(/\\/g, '/').toLowerCase()
  return candFs === rootFs || candFs.startsWith(rootFs + '/')
}

// Serves the built web app (dist/) from this same port. Path-traversal safe;
// unknown routes WITHOUT a file extension fall back to index.html so
// client-side URLs (e.g. /login) work as bookmarkable addresses.
//
// No server-side value is ever injected into HTML or JS. Dotfiles/secret-looking
// segments are refused even though dist/ should never contain them.
function makeStaticHandler(staticDir) {
  if (!staticDir) return null
  const root = resolve(staticDir)
  return function serveStatic(req, res, url) {
    let rel
    try {
      rel = decodeURIComponent(url)
    } catch {
      json(res, 400, { ok: false, error: 'malformed path' })
      return true
    }
    rel = rel.replace(/^\/+/, '') || 'index.html'
    if (rel.includes('\0') || rel.split(/[\\/]+/).some((seg) => seg.startsWith('.'))) {
      json(res, 404, { ok: false, error: 'not found' })
      return true
    }
    const candidate = resolve(root, normalize(rel))
    if (!withinRoot(root, candidate)) {
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
    // The service worker and the HTML shell must always be revalidated — a
    // stale one would pin ward PCs to an old app version forever.
    if (file.endsWith('sw.js') || ext === '.html') headers['cache-control'] = 'no-cache'
    res.writeHead(200, headers)
    createReadStream(file).pipe(res)
    return true
  }
}

// ---- request handler -------------------------------------------------------

function makeHandler({ cfg, queue, relay, db, authReady, authenticator, staticDir, serveStatic, log }) {
  async function handleOutbox(req, res) {
    const ip = String(req.socket.remoteAddress || 'unknown')
    const ipLimit = rateLimit('ip:' + ip, 120)
    if (!ipLimit.ok) {
      json(res, 429, { ok: false, error: 'Too many requests — wait a moment and retry.' }, { 'retry-after': String(ipLimit.retryAfter) })
      return
    }

    const origin = checkOrigin(req, cfg)
    if (!origin.ok) {
      log.warn('[hub] rejected /outbox from untrusted origin:', origin.origin || '(unparseable)')
      json(res, 403, { ok: false, error: 'This browser origin is not allowed to use this hub.' })
      return
    }

    // A custom header forces a CORS preflight and prevents a plain HTML form
    // (or a <script>/<img> URL) from reaching this endpoint. Bearer auth in an
    // Authorization header is already not sent automatically by browsers, so
    // this is defence in depth rather than the primary CSRF defence.
    if (String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
      json(res, 400, { ok: false, error: 'Missing ' + CLIENT_HEADER + ' header (expected ' + CLIENT_VALUE + ').' })
      return
    }

    let identity
    try {
      identity = await authenticator.verify(req)
    } catch (e) {
      if (e?.expose) json(res, e.status || 401, { ok: false, error: e.message })
      else {
        log.error('[hub] auth failure:', e?.message || e)
        json(res, 503, { ok: false, error: 'Authentication is temporarily unavailable.' })
      }
      return
    }

    const userLimit = rateLimit('uid:' + identity.uid, 120)
    if (!userLimit.ok) {
      json(res, 429, { ok: false, error: 'Too many requests for this account — wait a moment and retry.' }, { 'retry-after': String(userLimit.retryAfter) })
      return
    }

    let parsed
    try {
      parsed = await readJson(req)
    } catch (e) {
      if (e?.expose) {
        json(res, e.status || 400, { ok: false, error: e.message }, e.status === 413 ? { connection: 'close' } : {})
      } else {
        log.warn('[hub] body read failed:', e?.message || e)
        json(res, 400, { ok: false, error: 'Could not read the request body.' })
      }
      return
    }

    const rawOps = Array.isArray(parsed?.ops) ? parsed.ops : null
    if (!rawOps || !rawOps.length) {
      json(res, 400, { ok: false, error: 'Body must be { ops: [...] } with at least one op.' })
      return
    }
    if (rawOps.length > MAX_OPS) {
      json(res, 400, { ok: false, error: 'Too many ops per request (max ' + MAX_OPS + ').' })
      return
    }

    // Schema validation before any database read.
    const ops = []
    const errors = []
    rawOps.forEach((raw, i) => {
      const result = validateOp(raw, i)
      if (result.error) errors.push(result.error)
      else ops.push(result.op)
    })
    if (errors.length) {
      json(res, 400, { ok: false, error: errors[0], errors: errors.slice(0, 10) })
      return
    }

    // Authorise each distinct (org, capability) pair once, before queueing.
    // A request touching two hospitals must be allowed in both.
    const approved = new Map()
    for (const op of ops) {
      const capability = capabilityFor(op.kind)
      const key = op.orgId + '|' + capability
      if (approved.has(key)) continue
      try {
        approved.set(key, await authenticator.authorize(identity, op.orgId, capability))
      } catch (e) {
        // Authenticated but forbidden: safe to name the org/capability in the
        // server log (no patient data). The client gets a short message.
        log.warn('[hub] denied op', op.kind, 'uid=' + identity.uid, 'org=' + op.orgId, 'cap=' + capability, '—', e?.message || e)
        if (e?.expose) json(res, e.status || 403, { ok: false, error: e.message })
        else {
          log.error('[hub] authorisation failure:', e?.message || e)
          json(res, 503, { ok: false, error: 'Authorisation is temporarily unavailable.' })
        }
        return
      }
    }

    // Durable before ack — after this returns the device may delete its copy.
    const actor = {
      uid: identity.uid,
      email: identity.email,
      name: identity.displayName || approved.values().next().value?.membership?.staff_name || '',
    }
    let accepted = 0
    let duplicates = 0
    for (const op of ops) {
      const r = queue.add({
        // Org-scoped storage key: legacy v1 client keys are only unique per
        // device, so two hospitals must never collide in one queue file.
        queueKey: op.orgId + ':' + op.clientOpKey,
        clientOpKey: op.clientOpKey,
        kind: op.kind,
        args: op.args,
        orgId: op.orgId,
        // Identity from the verified token, never from the request body.
        actor,
        authVersion: 2,
        createdAt: op.createdAt,
      })
      if (r.duplicate) duplicates += 1
      else accepted += 1
    }
    log.info('[hub] accepted', accepted, 'op(s)' + (duplicates ? ' (' + duplicates + ' duplicate(s) skipped)' : '') + ' uid=' + identity.uid)
    json(res, 200, { ok: true, accepted, duplicates, queue: queue.counts() })
  }

  async function handleHealth(req, res, url) {
    const loopback = isLoopbackAddress(req.socket.remoteAddress)
    const params = url.searchParams
    const wantsDetail = params.get('detail') === '1'
    const lanAddrs = listLanAddresses(networkInterfaces())
    const lanUrl = lanAddrs.length ? `http://${lanAddrs[0]}:${cfg.port || 8787}` : ''
    const minimal = {
      ok: true,
      hub: true,
      version: VERSION,
      time: new Date().toISOString(),
      lanUrl,
      addresses: lanAddrs,
      port: Number(cfg.port) || 8787,
    }
    if (!wantsDetail && !loopback) {
      json(res, 200, minimal)
      return
    }

    // Detail is available to the local operator (Electron tray polls from
    // 127.0.0.1) or to an authenticated caller. It never contains the raw
    // credential error: that can disclose filesystem paths.
    if (!loopback) {
      try {
        await authenticator.verify(req)
      } catch (e) {
        json(res, e?.status || 401, { ok: false, error: e?.expose ? e.message : 'Sign-in required.' })
        return
      }
    }
    const status = db ? await relay.refreshStatus({ timeoutMs: 2000 }) : relay.status()
    json(res, 200, {
      ...minimal,
      projectId: cfg.projectId,
      firestoreReady: !!db,
      authReady: !!authReady,
      internet: status.online,
      lastContact: status.lastContact,
      lastProbeError: status.lastError || undefined,
      queue: queue.counts(),
      servesApp: !!staticDir,
    })
  }

  return async function handle(req, res) {
    securityHeaders(res)
    applyCors(req, res, cfg)

    let url
    try {
      url = new URL(req.url || '/', 'http://hub.local')
    } catch {
      json(res, 400, { ok: false, error: 'malformed URL' })
      return
    }
    const path = url.pathname

    if (req.method === 'OPTIONS') {
      const origin = checkOrigin(req, cfg)
      if (!origin.ok) {
        json(res, 403, { ok: false, error: 'This browser origin is not allowed to use this hub.' })
        return
      }
      res.writeHead(204)
      res.end()
      return
    }

    if (req.method === 'GET' && path === '/health') {
      await handleHealth(req, res, url)
      return
    }

    if (req.method === 'POST' && path === '/outbox') {
      await handleOutbox(req, res)
      return
    }

    if (req.method === 'GET' && serveStatic) {
      serveStatic(req, res, path)
      return
    }

    if (req.method === 'GET' && path === '/') {
      json(res, 200, {
        ok: true,
        hub: true,
        version: VERSION,
        note: 'web app (dist/) not present on this hub — API only',
        auth: 'Firebase ID token required for POST /outbox',
        endpoints: ['GET /health', 'POST /outbox'],
      })
      return
    }

    if (path === '/outbox') {
      json(res, 405, { ok: false, error: 'Use POST /outbox' }, { allow: 'POST, OPTIONS' })
      return
    }
    json(res, 404, { ok: false, error: 'not found — try GET /health' })
  }
}

// ---- startup ---------------------------------------------------------------

// Build the server (exported so tests can mount it on an ephemeral port and
// inject a fake authenticator / foundation). Returns a promise of the handle.
export function startHub(overrides = {}) {
  const cfg = { ...loadConfig(), ...overrides }
  const log = overrides.log || console
  if (typeof cfg.allowedOrigins === 'string') cfg.allowedOrigins = parseOrigins(cfg.allowedOrigins)
  if (!Array.isArray(cfg.allowedOrigins)) cfg.allowedOrigins = []

  if (cfg.legacyToken && !overrides.ignoreLegacyToken) {
    log.warn('[hub] HUB_TOKEN is set but obsolete — the hub now requires Firebase sign-in. Remove HUB_TOKEN from .env and from clients.')
  }

  const foundation = overrides.foundation || initFoundation(cfg, log)
  const db = foundation.db
  if (!db) {
    log.warn('[hub] ' + foundationSummary(foundation, cfg))
    log.warn('[hub] Sensitive endpoints (POST /outbox) will be DENIED until credentials are fixed.')
  } else {
    log.info('[hub] ' + foundationSummary(foundation, cfg))
  }

  const queue = createQueue(cfg.queueFile)

  // Serve the built app when present. Electron host mode passes an explicit
  // dir (the packaged dist); standalone `node hub/server.js` auto-detects
  // ./dist — with no dist, the hub behaves as an API only.
  let staticDir = overrides.staticDir
  if (staticDir === undefined) {
    staticDir = existsSync(resolve(PROJECT_ROOT, 'dist', 'index.html')) ? resolve(PROJECT_ROOT, 'dist') : ''
  }
  const serveStatic = makeStaticHandler(staticDir)

  const authenticator = overrides.authenticator
    || createAuthenticator({ auth: foundation.auth, db, log })
  const auditor = overrides.auditor || createAuditor({ db, log })
  const relay = createRelay({
    db,
    queue,
    handlers: overrides.handlers || HANDLERS,
    cfg,
    log,
    audit: auditor,
  })

  const handler = makeHandler({
    cfg, queue, relay, db, authReady: !!foundation.auth, authenticator, staticDir, serveStatic, log,
  })
  const server = createServer((req, res) => {
    handler(req, res).catch((e) => {
      // Never leak stack traces, paths, credentials or PHI to the client.
      log.error('[hub] request failed:', e?.message || e)
      try {
        if (!res.headersSent) json(res, e?.expose ? e.status : 500, { ok: false, error: e?.expose ? e.message : 'internal server error' })
        else res.end()
      } catch { /* socket already gone */ }
    })
  })

  // Process-wide failure of a socket must not take the hub down.
  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  })

  return new Promise((resolveStart, rejectStart) => {
    const onError = (err) => rejectStart(describeListenError(err, cfg.port))

    server.once('error', onError)
    server.listen(cfg.port, cfg.host, () => {
      server.removeListener('error', onError)
      relay.start()

      const addr = server.address()
      const actualPort = addr && typeof addr === 'object' ? addr.port : cfg.port
      const interfaces = overrides.interfaces || networkInterfaces()
      const lanAddresses = listLanAddresses(interfaces)
      const boundHost = cfg.host

      for (const line of startupLines({ host: boundHost, port: actualPort, version: VERSION, lanAddresses })) {
        log.info(line)
      }
      log.info('[hub] authentication: Firebase ID token (Authorization: Bearer)')
      log.info('[hub] do not port-forward this port on the hospital router; it is for the trusted LAN only.')

      resolveStart({
        cfg: { ...cfg, port: actualPort },
        port: actualPort,
        lanAddresses,
        queue,
        relay,
        server,
        db,
        auth: foundation.auth,
        foundation,
        authenticator,
        localUrl: 'http://127.0.0.1:' + actualPort,
        lanUrl: lanAddresses.length ? 'http://' + lanAddresses[0] + ':' + actualPort : '',
        close: () =>
          new Promise((r) => {
            relay.stop()
            server.close(() => r())
            // fetch()/undici keeps sockets alive; do not leave a test or a
            // restart hanging on an idle keep-alive connection.
            server.closeIdleConnections?.()
          }),
      })
    })
  })
}

// `node hub/server.js` starts it; an import (tests) does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHub().catch((e) => {
    console.error('[hub] failed to start: ' + (e?.message || e))
    process.exit(1)
  })
}
