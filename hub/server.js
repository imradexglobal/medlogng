// MediLog NG LAN hub — HTTP front door (v2, verified Firebase Auth).
//
//   GET  /         the EMR app itself (serves dist/ when present)
//   GET  /health   { ok, version, hub } — operational detail on this PC / with auth
//   POST /outbox   { ops: [...] } -> authorised, durably queued, acked in ms
//
// One shared Hub serves the existing HTTP port and, when configured, a second
// HTTPS port for secure-context features such as browser microphone access.
// Both listeners use this same handler, durable queue, authentication, relay,
// and speech job service; HTTP compatibility is retained.
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

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { isIP } from 'node:net'
import { X509Certificate } from 'node:crypto'
import { checkServerIdentity, connect as connectTls } from 'node:tls'
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
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, ' + CLIENT_HEADER + ', x-speech-request-id')
    res.setHeader('Access-Control-Max-Age', '600')
    if (String(req.headers['access-control-request-private-network'] || '').toLowerCase() === 'true') {
      res.setHeader('Access-Control-Allow-Private-Network', 'true')
    }
  }
  return origin
}

function validateHttpsAddress(host, port) {
  return new Promise((resolveValidation, rejectValidation) => {
    const socket = connectTls({ host, port, rejectUnauthorized: false,
      ...(isIP(host) ? {} : { servername: host }) })
    const timer = setTimeout(() => {
      socket.destroy()
      rejectValidation(new Error('Certificate check timed out for ' + host + '.'))
    }, 5000)
    socket.once('error', (error) => {
      clearTimeout(timer)
      rejectValidation(new Error('Could not check the HTTPS certificate for ' + host + ': ' + (error?.message || error)))
    })
    socket.once('secureConnect', () => {
      try {
        const peer = socket.getPeerCertificate(true)
        if (!peer?.raw) throw new Error('The HTTPS listener did not present a certificate.')
        const cert = new X509Certificate(peer.raw)
        const now = Date.now()
        if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo))
          throw new Error('The HTTPS certificate is outside its valid date range.')
        const identityError = checkServerIdentity(host, peer)
        if (identityError) throw new Error('The HTTPS certificate is not valid for ' + host + '.')
        clearTimeout(timer)
        socket.end()
        resolveValidation(true)
      } catch (error) {
        clearTimeout(timer)
        socket.destroy()
        rejectValidation(error)
      }
    })
  })
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

function makeHandler({ cfg, queue, relay, db, authReady, authenticator, staticDir, serveStatic, log,
  speechJobs = null, verifiedHttpsAddresses = new Set() }) {
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
    const scheme = req.socket.encrypted ? 'https' : 'http'
    const port = Number(req.socket.localPort) || Number(cfg.port) || 8787
    const loopback = isLoopbackAddress(req.socket.remoteAddress)
    const params = url.searchParams
    const wantsDetail = params.get('detail') === '1'
    const lanAddrs = listLanAddresses(networkInterfaces())
    const advertisedAddresses = req.socket.encrypted
      ? lanAddrs.filter((address) => verifiedHttpsAddresses.has(address))
      : lanAddrs
    const lanUrl = advertisedAddresses.length ? `${scheme}://${advertisedAddresses[0]}:${port}` : ''
    const minimal = {
      ok: true,
      hub: true,
      version: VERSION,
      time: new Date().toISOString(),
      lanUrl,
      addresses: advertisedAddresses,
      port,
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
      speech: speechJobs?.status() || { enabled: false },
      servesApp: !!staticDir,
    })
  }

  async function authorizeSpeech(req, res, orgId) {
    const origin = checkOrigin(req, cfg)
    if (!origin.ok) {
      json(res, 403, { ok: false, error: 'This browser origin is not allowed to use this hub.' })
      return null
    }
    if (String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
      json(res, 400, { ok: false, error: 'Missing ' + CLIENT_HEADER + ' header.' })
      return null
    }
    const ip = String(req.socket.remoteAddress || 'unknown')
    const pollRequest = req.method === 'GET'
    if (!rateLimit('speech-ip:' + ip, pollRequest ? 120 : 30).ok) {
      json(res, 429, { ok: false, error: 'Too many speech requests from this device. Wait and retry.' })
      return null
    }
    let identity
    try { identity = await authenticator.verify(req) }
    catch (error) {
      json(res, error?.expose ? error.status || 401 : 503,
        { ok: false, error: error?.expose ? error.message : 'Authentication is temporarily unavailable.' })
      return null
    }
    if (!rateLimit('speech-uid:' + identity.uid, pollRequest ? 120 : 30).ok) {
      json(res, 429, { ok: false, error: 'Too many speech requests for this account. Wait and retry.' })
      return null
    }
    try {
      if (typeof authenticator.authorizeSpeech === 'function') await authenticator.authorizeSpeech(identity, orgId, 'encounter.edit')
      else await authenticator.authorize(identity, orgId, 'encounter.edit')
    }
    catch (error) {
      json(res, error?.expose ? error.status || 403 : 503,
        { ok: false, error: error?.expose ? error.message : 'Authorisation is temporarily unavailable.' })
      return null
    }
    return identity
  }

  async function handleSpeechCreate(req, res, url) {
    if (!req.socket.encrypted) {
      req.resume()
      json(res, 403, { ok: false, error: 'Speech transcription requires the Host HTTPS address.' })
      return
    }
    if (!speechJobs) {
      json(res, 503, { ok: false, error: 'Host speech service is unavailable. Check HTTPS and speech service status.' })
      return
    }
    const orgId = url.searchParams.get('orgId') || ''
    const requestId = String(req.headers['x-speech-request-id'] || '')
    const identity = await authorizeSpeech(req, res, orgId)
    if (!identity) return
    const type = String(req.headers['content-type'] || '').toLowerCase()
    if (!(type.startsWith('audio/') || type.startsWith('application/octet-stream'))) {
      req.resume()
      json(res, 415, { ok: false, error: 'Send a supported audio recording.' })
      return
    }
    try {
      const duplicate = await speechJobs.findRequest(identity.uid, orgId, requestId)
      if (duplicate) {
        req.resume()
        json(res, 200, { ok: true, job: duplicate, duplicate: true })
        return
      }
      const job = await speechJobs.createFromRequest(req, {
        owner: identity.uid, orgId, requestId, contentType: type,
      })
      log.info('[speech] accepted job=' + job.id + ' uid=' + identity.uid)
      json(res, 202, { ok: true, job })
    } catch (error) {
      const status = Number(error?.status) || 500
      if (status !== 413) req.resume()
      json(res, status, { ok: false, error: status < 500 ? error.message : 'Speech request could not be processed.' },
        status === 413 ? { connection: 'close' } : {})
    }
  }

  async function handleSpeechJob(req, res, url, id, cancel = false) {
    if (!req.socket.encrypted) {
      json(res, 403, { ok: false, error: 'Speech transcription requires the Host HTTPS address.' })
      return
    }
    if (!speechJobs) {
      json(res, 503, { ok: false, error: 'Host speech service is unavailable.' })
      return
    }
    const orgId = url.searchParams.get('orgId') || ''
    const identity = await authorizeSpeech(req, res, orgId)
    if (!identity) return
    const job = cancel
      ? await speechJobs.cancel(id, identity.uid, orgId)
      : await speechJobs.get(id, identity.uid, orgId)
    if (!job) {
      json(res, 404, { ok: false, error: 'Speech job not found.' })
      return
    }
    json(res, 200, { ok: true, job })
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

    if (req.method === 'POST' && path === '/speech/jobs') {
      await handleSpeechCreate(req, res, url)
      return
    }
    const speechJobPath = /^\/speech\/jobs\/([0-9a-f-]{36})(\/cancel)?$/i.exec(path)
    if (speechJobPath && req.method === 'GET' && !speechJobPath[2]) {
      await handleSpeechJob(req, res, url, speechJobPath[1])
      return
    }
    if (speechJobPath && req.method === 'POST' && speechJobPath[2]) {
      await handleSpeechJob(req, res, url, speechJobPath[1], true)
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
export async function startHub(overrides = {}) {
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
    || createAuthenticator({
      auth: foundation.auth, db, log,
      loadSpeechAuthCache: overrides.loadSpeechAuthCache,
      saveSpeechAuthCache: overrides.saveSpeechAuthCache,
    })
  const auditor = overrides.auditor || createAuditor({ db, log })
  const relay = createRelay({
    db,
    queue,
    handlers: overrides.handlers || HANDLERS,
    cfg,
    log,
    audit: auditor,
  })

  let speechJobs = null
  if (overrides.tls && overrides.speechWorker && overrides.speechDir) {
    try {
      const { createSpeechJobs } = await import('./speech/jobs.js')
      speechJobs = createSpeechJobs({
        directory: overrides.speechDir,
        worker: overrides.speechWorker,
        ffmpeg: overrides.ffmpeg && existsSync(overrides.ffmpeg) ? overrides.ffmpeg : '',
        getFreeMemory: overrides.speechGetFreeMemory,
        protectResult: overrides.protectSpeechResult,
        unprotectResult: overrides.unprotectSpeechResult,
        log,
      })
      await speechJobs.initialize()
    } catch (error) {
      log.error('[speech] job service could not initialize; Host API remains available:', error?.message || error)
      try { await speechJobs?.close() } catch {}
      speechJobs = null
    }
  }

  const verifiedHttpsAddresses = new Set()
  const handler = makeHandler({
    cfg, queue, relay, db, authReady: !!foundation.auth, authenticator, staticDir, serveStatic, log, speechJobs,
    verifiedHttpsAddresses,
  })
  const onRequest = (req, res) => {
    handler(req, res).catch((e) => {
      // Never leak stack traces, paths, credentials or PHI to the client.
      log.error('[hub] request failed:', e?.message || e)
      try {
        if (!res.headersSent) json(res, e?.expose ? e.status : 500, { ok: false, error: e?.expose ? e.message : 'internal server error' })
        else res.end()
      } catch { /* socket already gone */ }
    })
  }
  const server = createHttpServer(onRequest)
  const httpsServer = overrides.tls ? createHttpsServer(overrides.tls, onRequest) : null

  // Process-wide failure of a socket must not take the hub down.
  for (const listener of [server, httpsServer].filter(Boolean)) {
    listener.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
  }

  const listen = (listener, port) => new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(describeListenError(error, port))
    listener.once('error', onError)
    listener.listen(port, cfg.host, () => {
      listener.removeListener('error', onError)
      listener.on('error', (error) => log.error('[hub] listener error:', error?.message || error))
      resolveListen(listener.address())
    })
  })

  const httpAddress = await listen(server, cfg.port)
  const actualPort = httpAddress && typeof httpAddress === 'object' ? httpAddress.port : cfg.port
  const interfaces = overrides.interfaces || networkInterfaces()
  const lanAddresses = listLanAddresses(interfaces)
  let httpsPort = 0
  let httpsError = ''
  if (httpsServer) {
    try {
      const httpsAddress = await listen(httpsServer, Number(overrides.httpsPort) || 0)
      httpsPort = httpsAddress && typeof httpsAddress === 'object' ? httpsAddress.port : Number(overrides.httpsPort) || 0
      const addressesToCheck = [...new Set(['127.0.0.1', ...lanAddresses])]
      for (const address of addressesToCheck) {
        try { await validateHttpsAddress(address, httpsPort); verifiedHttpsAddresses.add(address) }
        catch (error) { log.warn('[hub] HTTPS certificate not valid for ' + address + ': ' + (error?.message || error)) }
      }
      if (lanAddresses.length && !lanAddresses.some((address) => verifiedHttpsAddresses.has(address))) {
        httpsError = 'The HTTPS certificate is not valid for this Host LAN address. Use a reserved IP or stable DNS name covered by the certificate, then import a matching certificate.'
      }
    } catch (error) {
      httpsError = error?.message || 'HTTPS listener could not start.'
      log.error('[hub] HTTPS listener unavailable; existing HTTP service remains active:', httpsError)
    }
  }

  relay.start()
  const boundHost = cfg.host
  for (const line of startupLines({ host: boundHost, port: actualPort, version: VERSION, lanAddresses, protocol: 'http' })) log.info(line)
  if (httpsPort) {
    const secureLanAddresses = lanAddresses.filter((address) => verifiedHttpsAddresses.has(address))
    if (verifiedHttpsAddresses.has('127.0.0.1')) log.info('[hub] HTTPS local URL: https://127.0.0.1:' + httpsPort)
    if (secureLanAddresses.length) log.info('[hub] HTTPS LAN URL: https://' + secureLanAddresses[0] + ':' + httpsPort)
    if (httpsError) log.warn('[hub] ' + httpsError)
  }
  log.info('[hub] authentication: Firebase ID token (Authorization: Bearer)')
  log.info('[hub] do not port-forward these ports on the hospital router; they are for the trusted LAN only.')

  const localUrl = 'http://127.0.0.1:' + actualPort
  const lanUrl = lanAddresses.length ? 'http://' + lanAddresses[0] + ':' + actualPort : ''
  const secureLanAddress = lanAddresses.find((address) => verifiedHttpsAddresses.has(address)) || ''
  const httpsLanUrl = httpsPort && secureLanAddress ? 'https://' + secureLanAddress + ':' + httpsPort : ''
  const httpsLocalUrl = httpsPort && verifiedHttpsAddresses.has('127.0.0.1') ? 'https://127.0.0.1:' + httpsPort : ''
  return {
    cfg: { ...cfg, port: actualPort, httpsPort },
    port: actualPort,
    httpsPort,
    httpsError,
    lanAddresses,
    verifiedHttpsAddresses: [...verifiedHttpsAddresses],
    queue,
    speechJobs,
    relay,
    server,
    httpsServer: httpsPort ? httpsServer : null,
    db,
    auth: foundation.auth,
    foundation,
    authenticator,
    localUrl,
    lanUrl,
    httpsLocalUrl,
    httpsLanUrl,
    close: async () => {
      await speechJobs?.close()
      relay.stop()
      const closeListener = async (listener) => {
        if (!listener?.listening) return
        const closed = new Promise((resolveClose) => listener.close(() => resolveClose()))
        // fetch()/undici can retain idle keep-alive sockets across a restart;
        // a stalled upload must not keep the Host process alive indefinitely.
        listener.closeIdleConnections?.()
        listener.closeAllConnections?.()
        await closed
      }
      await Promise.all([closeListener(httpsServer), closeListener(server)])
    },
  }
}

// `node hub/server.js` starts it; an import (tests) does not.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startHub().catch((e) => {
    console.error('[hub] failed to start: ' + (e?.message || e))
    process.exit(1)
  })
}
