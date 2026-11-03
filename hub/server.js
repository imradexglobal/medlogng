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
import { X509Certificate, createHash } from 'node:crypto'
import { checkServerIdentity, connect as connectTls } from 'node:tls'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, extname, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { networkInterfaces } from 'node:os'

import { loadConfig, PROJECT_ROOT, normalizeOrigin, parseOrigins } from './config.js'
import { createQueue } from './queue.js'
import { createOfflineQueryCache } from './offlineQueryCache.js'
import { applyQuerySpec, MAX_CACHED_QUERY_DOCS, ORG_QUERY_READS, requiredCapabilitiesForRead, serializeFirestoreData, validateQuerySpec } from './querySpec.js'
import { capabilitiesForMutationArgs, validateOp, capabilityFor } from './ops.js'
import { HANDLERS } from './handlers.js'
import { createRelay } from './relay.js'
import { initFoundation, foundationSummary } from './foundation.js'
import { createAuthenticator } from './auth.js'
import { createAuditor } from './audit.js'
import { createLocalClinicalAi } from './clinical-ai/ollama.js'
import { createInferenceScheduler } from './clinical-ai/inferenceScheduler.js'
import { seedOfflineCache } from './seed.js'
import { listLanAddresses, startupLines, describeListenError } from './netinfo.js'
import { checkDeepgram, transcribeWithDeepgram } from '../functions/speechProvider.js'

const VERSION = 'hub-2.0.0'
const MAX_BODY = 2 * 1024 * 1024 // 2 MB: enough for a bounded, compressed offline result PDF
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
    res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, ' + CLIENT_HEADER +
      ', x-speech-request-id, x-speech-device, x-speech-timestamp, x-speech-nonce, x-speech-signature, x-speech-body-sha256')
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

async function readJson(req, limit = MAX_BODY) {
  requireJson(req)
  const raw = await readBody(req, limit)
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

export function makeHandler({ cfg, queue, relay, db, authReady, authenticator, staticDir, serveStatic, log,
  speechSessions = null, offlineQueryCache = null, auditSpeech = async () => {}, clinicalAi = null, verifiedHttpsAddresses = new Set(), speechProvider = transcribeWithDeepgram }) {
  let activeSpeechRequests = 0
  async function recordClinicalAiAudit(action, uid, orgId, patientId, encounterId, decisions = {}, metadata = null) {
    if (!db) throw new Error('Clinical audit storage is unavailable.')
    await db.collection('audit_events').add({
      action: 'clinical_draft.' + action, actor_user_id: uid, organization_id: orgId,
      actor_organization_id: orgId, source: 'clinical-ai', operation: action,
      patient_id: patientId, record_id: encounterId, occurredAt: new Date(),
      ...(action === 'approved' || action === 'rejected' ? {
        accepted_suggestions: decisions.accepted || [], rejected_suggestions: decisions.rejected || [],
      } : {}),
      ...(action === 'generated' && metadata ? {
        model_name: String(metadata.model || '').slice(0, 160), model_digest: String(metadata.modelDigest || '').slice(0, 160),
        generation_ms: Number.isFinite(metadata.totalDurationMs) ? metadata.totalDurationMs : null,
      } : {}),
    })
  }
  async function authorizeClinicalDraftRequest(req, orgId, patientId, encounterId) {
    const identity = typeof authenticator.verifyOnline === 'function'
      ? await authenticator.verifyOnline(req) : await authenticator.verify(req)
    await authenticator.authorize(identity, orgId, 'encounter.edit')
    if (!db) throw Object.assign(new Error('Authoritative encounter access is unavailable.'), { status: 503, expose: true })
    const snapshot = await db.collection('encounters').doc(encounterId).get()
    const encounter = snapshot.exists ? snapshot.data() || {} : null
    if (!encounter || encounter.organization_id !== orgId || encounter.patient_id !== patientId) {
      throw Object.assign(new Error('Encounter does not belong to this patient and hospital.'), { status: 403, expose: true })
    }
    return identity
  }
  async function handleClinicalDraft(req, res) {
    const ip = String(req.socket.remoteAddress || 'unknown')
    const quota = rateLimit('clinical-ai:' + ip, 10)
    if (!quota.ok) { req.resume(); json(res, 429, { ok: false, error: 'Too many clinical AI requests. Wait and retry.' }, { 'retry-after': String(quota.retryAfter) }); return }
    if (!req.socket.encrypted) { req.resume(); json(res, 403, { ok: false, error: 'Clinical AI requests require HTTPS.' }); return }
    const origin = checkOrigin(req, cfg)
    if (!origin.ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
      req.resume(); json(res, 403, { ok: false, error: 'This browser is not allowed to use this Host.' }); return
    }
    if (!clinicalAi) { req.resume(); json(res, 503, { ok: false, error: 'Local clinical AI is not configured on this Host.' }); return }
    try {
      const body = await readJson(req, 150_000)
      const { orgId, encounterId, patientId, transcript } = body || {}
      if (![orgId, encounterId, patientId].every((v) => typeof v === 'string' && v.length > 0) ||
          typeof transcript !== 'string' || !transcript.trim() || transcript.length > 100_000) {
        json(res, 400, { ok: false, error: 'Organization, patient, encounter and a bounded transcript are required.' }); return
      }
      const identity = await authorizeClinicalDraftRequest(req, orgId, patientId, encounterId)
      const generated = clinicalAi.generateDetailed ? await clinicalAi.generateDetailed(transcript) : { draft: await clinicalAi.generate(transcript), metadata: null }
      const draft = generated?.draft || generated
      const metadata = generated?.draft ? generated.metadata || null : null
      await recordClinicalAiAudit('generated', identity.uid, orgId, patientId, encounterId, {}, metadata)
      json(res, 200, { ok: true, draft, metadata, binding: { uid: identity.uid, organizationId: orgId, patientId, encounterId } })
      log.info('[hub] clinical draft generated', { uid: identity.uid, orgId, encounterId })
    } catch (error) {
      const status = Number(error?.status) || (error?.expose ? Number(error.status) || 400 : 503)
      json(res, status, { ok: false, error: error?.expose || status < 500 ? error.message : 'Clinical draft generation failed. Check local AI service status.' })
    }
  }
  async function handleSpeechTranscribe(req, res, url) {
    if (!req.socket.encrypted) { req.resume(); json(res, 403, { ok: false, error: 'Speech transcription requires HTTPS.' }); return }
    const origin = checkOrigin(req, cfg)
    if (!origin.ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) { req.resume(); json(res, 403, { ok: false, error: 'This browser is not allowed to use this Host.' }); return }
    if (process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO !== 'true' || !process.env.DEEPGRAM_API_KEY || !process.env.DEEPGRAM_ENDPOINT) {
      req.resume(); json(res, 503, { ok: false, error: 'Online clinical transcription is not configured for this Host.' }); return
    }
    const ip = String(req.socket.remoteAddress || 'unknown')
    if (!rateLimit('speech-online:' + ip, 12).ok) { req.resume(); json(res, 429, { ok: false, error: 'Too many transcription requests. Wait and retry.' }); return }
    const orgId = String(url.searchParams.get('orgId') || '')
    const patientId = String(url.searchParams.get('patientId') || '')
    const encounterId = String(url.searchParams.get('encounterId') || '')
    const requestId = String(req.headers['x-speech-request-id'] || '')
    if (![orgId, patientId, encounterId].every(Boolean) || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) { req.resume(); json(res, 400, { ok: false, error: 'Hospital, patient, consultation and request id are required.' }); return }
    let speechSlot = false
    try {
      const identity = await authenticator.verifyOnline(req)
      await authenticator.authorize(identity, orgId, 'encounter.edit')
      if (!db) throw Object.assign(new Error('Authoritative consultation access is unavailable.'), { status: 503, expose: true })
      const encounterSnapshot = await db.collection('encounters').doc(encounterId).get()
      const encounter = encounterSnapshot.exists ? encounterSnapshot.data() || {} : null
      if (!encounter || encounter.organization_id !== orgId || encounter.patient_id !== patientId) throw Object.assign(new Error('Consultation does not belong to this patient and hospital.'), { status: 403, expose: true })
      const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
      if (!contentType.startsWith('audio/')) { req.resume(); json(res, 415, { ok: false, error: 'Send a supported audio recording.' }); return }
      if (activeSpeechRequests >= 10) { req.resume(); json(res, 429, { ok: false, error: 'The Host transcription service is busy. Try again shortly.' }); return }
      activeSpeechRequests++
      speechSlot = true
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 25 * 1024 * 1024) throw Object.assign(new Error('Audio exceeds the 25 MB limit.'), { status: 413, expose: true })
        chunks.push(chunk)
      }
      const audio = Buffer.concat(chunks)
      const submittedAt = new Date()
      const requestHash = createHash('sha256').update([identity.uid, orgId, encounterId, requestId].join('\n')).digest('hex')
      const auditRef = db.collection('audit_events').doc('speech_transcription_' + requestHash)
      try { await auditRef.create({ action: 'speech.transcription-submit', actor_user_id: identity.uid, actor_organization_id: orgId,
        organization_id: orgId, patient_id: patientId, record_id: encounterId, request_id: requestId,
        model: 'nova-3-medical', status: 'started', source: 'host-deepgram-stt', occurredAt: submittedAt }) }
      catch (error) {
        if (error?.code === 6 || error?.code === 'already-exists') { json(res, 409, { ok: false, error: 'This transcription request was already submitted. Start a new request if a retry is needed.' }); return }
        throw error
      }
      await auditSpeech({ action: 'speech.transcription-submit', uid: identity.uid, orgId, patientId, encounterId, requestId,
        model: 'nova-3-medical', at: submittedAt.toISOString() })
      let result
      try { result = await speechProvider({ audio, contentType, apiKey: process.env.DEEPGRAM_API_KEY, endpoint: process.env.DEEPGRAM_ENDPOINT }) }
      catch (error) { await auditRef.update({ status: 'failed', failure_code: String(error?.code || 'provider-error').slice(0, 80), provider_status: Number(error?.providerStatus) || null, completedAt: new Date() }).catch(() => {}); throw error }
      const record = { action: 'speech.transcription-complete', uid: identity.uid, orgId, patientId, encounterId, requestId, model: result.model, at: new Date().toISOString() }
      await auditRef.update({ status: 'completed', model: result.model, processing_ms: result.processingMs ?? null, completedAt: new Date() })
      await auditSpeech(record)
      json(res, 200, { ok: true, status: 'completed', text: result.text, model: result.model, processingMs: result.processingMs ?? null, requestId })
    } catch (error) {
      const status = Number(error?.status) || (error?.code === 'invalid-argument' ? 400 : error?.code === 'failed-precondition' ? 503 : 503)
      log.warn('[speech] transcription failed', String(error?.code || error?.name || 'error').slice(0, 80))
      json(res, status, { ok: false, error: error?.expose || status < 500 ? error.message : 'Online transcription could not be completed.' })
    } finally { if (speechSlot) activeSpeechRequests-- }
  }
  async function handleClinicalDraftReview(req, res) {
    const ip = String(req.socket.remoteAddress || 'unknown')
    const quota = rateLimit('clinical-ai-review:' + ip, 30)
    if (!quota.ok) { req.resume(); json(res, 429, { ok: false, error: 'Too many clinical review requests. Wait and retry.' }, { 'retry-after': String(quota.retryAfter) }); return }
    if (!req.socket.encrypted) { req.resume(); json(res, 403, { ok: false, error: 'Clinical AI review requires HTTPS.' }); return }
    const origin = checkOrigin(req, cfg)
    if (!origin.ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) { req.resume(); json(res, 403, { ok: false, error: 'This browser is not allowed to use this Host.' }); return }
    try {
      const body = await readJson(req, 16 * 1024)
      const { orgId, patientId, encounterId, action, acceptedSuggestions = [], rejectedSuggestions = [] } = body || {}
      if (![orgId, patientId, encounterId].every((v) => typeof v === 'string' && v) || !['approved', 'rejected'].includes(action)) {
        json(res, 400, { ok: false, error: 'A consultation binding and approve/reject decision are required.' }); return
      }
      const validSuggestionIds = (value) => Array.isArray(value) && value.length <= 200 && value.every((item) => /^(S|O|A|P):\d{1,3}$/.test(item))
      if (!validSuggestionIds(acceptedSuggestions) || !validSuggestionIds(rejectedSuggestions)) {
        json(res, 400, { ok: false, error: 'Reviewed suggestion references are invalid.' }); return
      }
      const identity = await authorizeClinicalDraftRequest(req, orgId, patientId, encounterId)
      await recordClinicalAiAudit(action, identity.uid, orgId, patientId, encounterId, { accepted: acceptedSuggestions, rejected: rejectedSuggestions })
      json(res, 200, { ok: true })
    } catch (error) {
      const status = Number(error?.status) || 503
      json(res, status, { ok: false, error: error?.expose || status < 500 ? error.message : 'Clinical review audit could not be saved.' })
    }
  }
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

    let identity = null
    let bearerError = null
    try { identity = await authenticator.verify(req) }
    catch (e) { bearerError = e }

    let parsed
    let rawBody
    try {
      requireJson(req)
      rawBody = await readBody(req, MAX_BODY)
      parsed = JSON.parse(rawBody)
    } catch (e) {
      if (e?.expose) {
        json(res, e.status || 400, { ok: false, error: e.message }, e.status === 413 ? { connection: 'close' } : {})
      } else {
        log.warn('[hub] body read failed:', e?.message || e)
        json(res, 400, { ok: false, error: 'Could not read the request body.' })
      }
      return
    }

    let offlineSession = null
    if (!identity) {
      try {
        offlineSession = speechSessions?.authenticate(req, '', '') || null
        if (!offlineSession) throw bearerError || new Error('Sign-in required.')
        const expectedHash = createHash('sha256').update(rawBody).digest('hex')
        if (String(req.headers['x-speech-body-sha256'] || '').toLowerCase() !== expectedHash) {
          throw Object.assign(new Error('Signed request body does not match.'), { status: 401, expose: true })
        }
        identity = { uid: offlineSession.uid, email: offlineSession.email, displayName: offlineSession.displayName }
      } catch (e) {
        if (e?.expose) json(res, e.status || 401, { ok: false, error: e.message })
        else {
          log.error('[hub] auth failure:', e?.message || e)
          json(res, 503, { ok: false, error: 'Authentication is temporarily unavailable.' })
        }
        return
      }
    }

    const userLimit = rateLimit('uid:' + identity.uid, 120)
    if (!userLimit.ok) {
      json(res, 429, { ok: false, error: 'Too many requests for this account — wait a moment and retry.' }, { 'retry-after': String(userLimit.retryAfter) })
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
    const opCapabilities = new Map()
    for (const op of ops) {
      const candidates = op.kind === 'document_mutation' ? capabilitiesForMutationArgs(op.args) : [capabilityFor(op.kind, op.args)]
      const capability = candidates[0]
      if (offlineSession) {
        if (op.orgId !== offlineSession.orgId ||
            (!offlineSession.permissions.includes('*') && !candidates.some((cap) => offlineSession.permissions.includes(cap)))) {
          json(res, 403, { ok: false, error: 'This device session does not have permission for this handoff.' })
          return
        }
        const chosen = candidates.find((cap) => offlineSession.permissions.includes('*') || offlineSession.permissions.includes(cap))
        approved.set(op.orgId + '|' + chosen, { membership: offlineSession.membership })
        opCapabilities.set(op.clientOpKey, chosen)
        continue
      }
      let authorized = false
      let lastError = null
      for (const candidate of candidates) {
        const key = op.orgId + '|' + candidate
        if (approved.has(key)) { opCapabilities.set(op.clientOpKey, candidate); authorized = true; break }
        try {
          approved.set(key, await authenticator.authorize(identity, op.orgId, candidate))
          opCapabilities.set(op.clientOpKey, candidate)
          authorized = true
          break
        } catch (e) {
          lastError = e
          if (!(e?.status === 403 || e?.status === 400)) break
        }
      }
      if (!authorized) {
        const e = lastError || new Error('No capability is configured for this operation.')
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
    const requestedBedClaims = new Set()
    for (const op of ops) {
      if (op.kind !== 'admission_create') continue
      const queueKey = op.orgId + ':' + op.clientOpKey
      const alreadyHeld = !!queue.get(queueKey)
      if (!alreadyHeld && (requestedBedClaims.has(op.args.claimId) || queue.hasPendingClaim?.(op.args.claimId))) {
        json(res, 409, { ok: false, error: 'That bed already has an admission waiting to sync from another device. Refresh Admissions and choose another bed.' })
        return
      }
      requestedBedClaims.add(op.args.claimId)
    }
    let accepted = 0
    let duplicates = 0
    for (const op of ops) {
      const queueKey = op.orgId + ':' + op.clientOpKey
      const r = queue.add({
        // Org-scoped storage key: legacy v1 client keys are only unique per
        // device, so two hospitals must never collide in one queue file.
        queueKey,
        clientOpKey: op.clientOpKey,
        kind: op.kind,
        args: op.args,
        orgId: op.orgId,
        // Identity from the verified token, never from the request body.
        actor,
        authVersion: 2,
        authorizedCapability: opCapabilities.get(op.clientOpKey) || '',
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
      speech: { enabled: process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO === 'true' && !!process.env.DEEPGRAM_API_KEY && !!process.env.DEEPGRAM_ENDPOINT },
      servesApp: !!staticDir,
    })
  }

  // Online verified enrollment for a local device key. The Host retains only
  // the public key and last verified capability set; it can authenticate
  // signed LAN handoffs after Firebase ID tokens expire during an outage.
  async function offlineDeviceSessionRoute(req, res, url, action) {
    if (!req.socket.encrypted) { req.resume(); json(res, 403, { ok: false, error: 'Host device sessions require HTTPS.' }); return }
    if (!speechSessions) { req.resume(); json(res, 503, { ok: false, error: 'Host offline-session service is unavailable.' }); return }
    const origin = checkOrigin(req, cfg)
    if (!origin.ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
      req.resume(); json(res, 403, { ok: false, error: 'This browser is not allowed to use this Host.' }); return
    }
    const orgId = url.searchParams.get('orgId') || ''
    const ip = String(req.socket.remoteAddress || 'unknown')
    if (!rateLimit('device-session-ip:' + ip, action === 'offline' ? 120 : 30).ok) {
      req.resume(); json(res, 429, { ok: false, error: 'Too many device session requests. Wait and retry.' }); return
    }
    let newlyRegisteredDevice = ''
    let registeringPublicKey = null
    let currentSession = null
    try {
      if (action === 'register') {
        const body = await readJson(req, 16 * 1024)
        registeringPublicKey = body.publicKey
        const identity = typeof authenticator.verifyOnline === 'function'
          ? await authenticator.verifyOnline(req) : await authenticator.verify(req)
        const authorization = await authenticator.authorize(identity, orgId, '')
        const session = await speechSessions.register({ identity, authorization, orgId, publicKey: body.publicKey })
        newlyRegisteredDevice = session.deviceId
        await auditSpeech({ action: 'offline-device-session-registered', uid: identity.uid, orgId,
          deviceId: session.deviceId, permissions: session.permissions, at: new Date().toISOString() })
        json(res, 200, { ok: true, session }); return
      }
      const current = currentSession = speechSessions.authenticate(req, orgId, '')
      if (action === 'offline') {
        json(res, 200, { ok: true, session: { uid: current.uid, orgId: current.orgId, email: current.email,
          displayName: current.displayName, membership: current.membership, permissions: current.permissions } }); return
      }
      if (action === 'revalidate') {
        const identity = await authenticator.verifyOnline(req)
        if (identity.uid !== current.uid) throw Object.assign(new Error('Signed-in user does not match this Host session.'), { status: 401, expose: true })
        const authorization = await authenticator.authorize(identity, orgId, '')
        const session = await speechSessions.updateAuthorization(current.deviceId, { identity, authorization })
        if (!session) throw Object.assign(new Error('Hospital access was revoked.'), { status: 403, expose: true })
        await auditSpeech({ action: 'offline-device-session-revalidated', uid: identity.uid, orgId,
          deviceId: current.deviceId, permissions: session.permissions, at: new Date().toISOString() })
        json(res, 200, { ok: true, session }); return
      }
      if (action === 'revoke') {
        const current = speechSessions.authenticate(req, orgId, '')
        await speechSessions.revoke(current.deviceId)
        await auditSpeech({ action: 'offline-device-session-revoked', uid: current.uid, orgId,
          deviceId: current.deviceId, at: new Date().toISOString() })
        json(res, 200, { ok: true }); return
      }
    } catch (error) {
      if (newlyRegisteredDevice) await speechSessions.revoke(newlyRegisteredDevice)
      if (action === 'register' && [401, 403].includes(Number(error?.status))) {
        const deviceId = String(req.headers['x-speech-device'] || '')
        const existing = speechSessions.matchesDeviceKey(deviceId, registeringPublicKey) ? speechSessions.get(deviceId) : null
        if (existing) await speechSessions.invalidateUserOrg(existing.uid, existing.orgId)
      }
      if (action === 'revalidate' && [401, 403].includes(Number(error?.status)) && currentSession) {
        await speechSessions.invalidateUserOrg(currentSession.uid, currentSession.orgId)
      }
      json(res, error?.expose ? error.status || 401 : 503, {
        ok: false, error: error?.expose ? error.message : 'Host offline session could not be verified.',
      })
    }
  }

  // Read-through Host cache for organization-scoped queries. Online results
  // come from Firestore and are saved on the Host; during an internet outage,
  // the exact previously authorized query can be served to another LAN PC.
  async function handleOfflineSeed(req, res) {
    if (!req.socket.encrypted && !isLoopbackAddress(req.socket.remoteAddress)) {
      req.resume(); json(res, 403, { ok: false, error: 'Cache seeding requires HTTPS.' }); return
    }
    if (!offlineQueryCache) { req.resume(); json(res, 503, { ok: false, error: 'Host offline data cache is unavailable.' }); return }
    const origin = checkOrigin(req, cfg)
    if (!origin.ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
      req.resume(); json(res, 403, { ok: false, error: 'This browser is not allowed to seed Host data.' }); return
    }
    const ip = String(req.socket.remoteAddress || 'unknown')
    if (!rateLimit('seed-ip:' + ip, 6).ok) { req.resume(); json(res, 429, { ok: false, error: 'Cache seeding is in progress. Wait and retry.' }); return }
    let body
    try { body = await readJson(req, 4 * 1024) }
    catch (error) { json(res, error?.status || 400, { ok: false, error: error?.expose ? error.message : 'Could not read seed request.' }); return }
    const orgId = String(body?.orgId || '')
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(orgId)) {
      json(res, 400, { ok: false, error: 'A valid hospital id is required to seed the offline cache.' }); return
    }

    let identity
    try { identity = await authenticator.verify(req) }
    catch (error) {
      json(res, error?.expose ? error.status || 401 : 503, { ok: false, error: error?.expose ? error.message : 'Host authentication is unavailable.' }); return
    }
    // Seeding writes to durable storage, so it needs an explicit grant — the
    // same admin gate that lets a user manage the hospital's data.
    try { await authenticator.authorize(identity, orgId, 'admin.roles.manage') }
    catch (error) {
      json(res, error?.expose ? error.status || 403 : 503, { ok: false, error: error?.expose ? error.message : 'Host authorisation is unavailable.' }); return
    }
    if (!db) { json(res, 503, { ok: false, error: 'Firestore is not ready on this Host.' }); return }

    log.info('[hub] offline cache seed requested by', identity.uid, 'for', orgId)
    const summary = await seedOfflineCache(db, offlineQueryCache, orgId, log)
    json(res, 200, { ok: true, ...summary })
  }

  // Read-through Host cache for organization-scoped queries. Online results
  // come from Firestore and are saved on the Host; during an internet outage,
  // the exact previously authorized query can be served to another LAN PC.
  async function offlineDataQueryRoute(req, res) {
    if (!req.socket.encrypted && !isLoopbackAddress(req.socket.remoteAddress)) {
      req.resume(); json(res, 403, { ok: false, error: 'Shared clinical data reads require HTTPS.' }); return
    }
    if (!offlineQueryCache) { req.resume(); json(res, 503, { ok: false, error: 'Host offline data cache is unavailable.' }); return }
    const origin = checkOrigin(req, cfg)
    if (!origin.ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
      req.resume(); json(res, 403, { ok: false, error: 'This browser is not allowed to read Host data.' }); return
    }
    const ip = String(req.socket.remoteAddress || 'unknown')
    if (!rateLimit('data-ip:' + ip, 180).ok) { req.resume(); json(res, 429, { ok: false, error: 'Too many Host data requests.' }); return }

    let body
    try { body = await readJson(req, 128 * 1024) }
    catch (error) { json(res, error?.status || 400, { ok: false, error: error?.expose ? error.message : 'Could not read query.' }); return }
    const orgId = String(body?.orgId || '')
    let spec
    try { spec = validateQuerySpec(body?.query, { orgId, uid: '' }) }
    catch (error) {
      // Membership list queries are bound to the signed-in uid; validate that
      // field only after determining which identity signed the request.
      if (!String(error?.message || '').includes('signed-in user')) { json(res, 400, { ok: false, error: error.message }); return }
    }

    let bearerIdentity = null
    let bearerError = null
    try { bearerIdentity = await authenticator.verify(req) } catch (error) { bearerError = error }
    let deviceSession = null
    const hasDeviceProof = !!String(req.headers['x-speech-device'] || '')
    if (hasDeviceProof) {
      try {
        deviceSession = speechSessions?.authenticate(req, orgId, '') || null
        const expectedHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
        if (String(req.headers['x-speech-body-sha256'] || '').toLowerCase() !== expectedHash) {
          throw Object.assign(new Error('Signed query body does not match.'), { status: 401, expose: true })
        }
        if (bearerIdentity && bearerIdentity.uid !== deviceSession.uid) {
          throw Object.assign(new Error('Signed-in user does not match the Host device session.'), { status: 401, expose: true })
        }
      } catch (error) {
        if (error?.expose) { json(res, error.status || 401, { ok: false, error: error.message }); return }
        deviceSession = null
      }
    }
    const identity = bearerIdentity || (deviceSession ? {
      uid: deviceSession.uid, email: deviceSession.email, displayName: deviceSession.displayName,
    } : null)
    if (!identity) {
      const error = bearerError
      json(res, error?.expose ? error.status || 401 : 503, { ok: false, error: error?.expose ? error.message : 'Host authentication is unavailable.' })
      return
    }
    if (deviceSession && deviceSession.orgId !== orgId) { json(res, 403, { ok: false, error: 'Device session belongs to another hospital.' }); return }
    if (!spec) {
      try { spec = validateQuerySpec(body?.query, { orgId, uid: identity.uid }) }
      catch (error) { json(res, 400, { ok: false, error: error.message }); return }
    }
    if (deviceSession && (!deviceSession.permissions.length || deviceSession.orgId !== orgId)) {
      json(res, 403, { ok: false, error: 'This Host session has no access to the selected hospital.' }); return
    }

    let membershipLive = false
    try {
      await authenticator.authorize(identity, orgId, '')
      membershipLive = true
    } catch (error) {
      if (error?.expose && error.status !== 503) { json(res, error.status || 403, { ok: false, error: error.message }); return }
      if (!deviceSession) {
        json(res, error?.expose ? error.status || 503 : 503, { ok: false, error: error?.expose ? error.message : 'Hospital membership could not be verified.' })
        return
      }
    }

    const requiredCaps = requiredCapabilitiesForRead(spec.collection, identity, spec.filters)
    if (requiredCaps.length) {
      let allowed = false
      let backendUnavailable = false
      if (membershipLive) {
        for (const capability of requiredCaps) {
          try { await authenticator.authorize(identity, orgId, capability); allowed = true; break }
          catch (error) {
            if (!(error?.status === 403 || error?.status === 400)) { backendUnavailable = true; break }
          }
        }
      } else if (deviceSession) {
        allowed = deviceSession.permissions.includes('*') || requiredCaps.some((cap) => deviceSession.permissions.includes(cap))
      }
      if (!allowed && !backendUnavailable) {
        json(res, 403, { ok: false, error: 'Your hospital role does not allow reading this collection.' }); return
      }
      if (!allowed && backendUnavailable && !deviceSession) {
        json(res, 503, { ok: false, error: 'Hospital access could not be verified.' }); return
      }
      if (!allowed && backendUnavailable && deviceSession &&
          !deviceSession.permissions.includes('*') && !requiredCaps.some((cap) => deviceSession.permissions.includes(cap))) {
        json(res, 403, { ok: false, error: 'Your last verified hospital role does not allow reading this collection.' }); return
      }
    }

    const cacheKey = { orgId, query: body.query }
    const withPendingWrites = (docs) => {
      const byId = new Map((docs || []).map((row) => [row.id, row]))
      const stamp = (ms) => ({ __firestoreType: 'timestamp', seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 })
      const decode = (value, at) => {
        if (Array.isArray(value)) return value.map((item) => decode(item, at))
        if (!value || typeof value !== 'object') return value
        if (value.__firestoreType === 'serverTimestamp') return stamp(at)
        if (value.__firestoreType === 'timestamp' && value.value) {
          const ms = new Date(value.value).getTime()
          return Number.isFinite(ms) ? stamp(ms) : null
        }
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, decode(v, at)]))
      }
      const matches = (data) => spec.filters.every((f) => {
        const value = data?.[f.field]
        const norm = (x) => x && typeof x === 'object' && Number.isFinite(x.seconds)
          ? x.seconds * 1000 + (x.nanoseconds || 0) / 1e6 : x instanceof Date ? x.getTime() : x
        const a = norm(value), b = norm(f.value)
        if (f.op === '==') return a === b
        if (f.op === '!=') return a !== b
        if (f.op === 'in') return Array.isArray(f.value) && f.value.some((x) => norm(x) === a)
        if (f.op === '<') return a < b
        if (f.op === '<=') return a <= b
        if (f.op === '>') return a > b
        if (f.op === '>=') return a >= b
        return false
      })
      for (const op of (queue.pendingForOrg?.(orgId) || [])) {
        if (op.kind === 'admission_create' && spec.collection === 'admissions') {
          const data = { ...op.args.admission, created_at: stamp(op.addedAt), updated_at: stamp(op.addedAt) }
          if (matches(data)) byId.set(op.args.admissionId, { id: op.args.admissionId, data })
        }
        if (op.kind === 'admission_discharge') {
          const { admissionId, claimId, legacyClaimId, dischargeData } = op.args
          if (spec.collection === 'admissions') {
            const current = byId.get(admissionId)?.data
            if (current) {
              const data = { ...current, ...dischargeData, discharged_by: op.actor?.uid || null,
                discharged_by_name: op.actor?.name || op.actor?.email || '', updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(admissionId, { id: admissionId, data })
              else byId.delete(admissionId)
            }
          } else if (spec.collection === 'bed_claims') {
            byId.delete(claimId)
            if (legacyClaimId) byId.delete(legacyClaimId)
          }
        }
        if (op.kind === 'admission_transfer') {
          const { admissionId, oldClaimId, newClaimId, legacyOldClaimId, wardName, bedNumber, reason, transferAt, newClaim } = op.args
          if (spec.collection === 'admissions') {
            const current = byId.get(admissionId)?.data
            if (current) {
              const history = Array.isArray(current.transfer_history) ? current.transfer_history : []
              const data = { ...current, ward_name: wardName, bed_number: bedNumber,
                transfer_history: [...history, { at: transferAt, from_ward: current.ward_name || '', from_bed: String(current.bed_number || ''),
                  to_ward: wardName, to_bed: bedNumber, reason, staff_id: op.actor?.uid || '', staff_name: op.actor?.name || op.actor?.email || '' }],
                updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(admissionId, { id: admissionId, data })
              else byId.delete(admissionId)
            }
          } else if (spec.collection === 'bed_claims') {
            byId.delete(oldClaimId)
            if (legacyOldClaimId) byId.delete(legacyOldClaimId)
            const data = { ...newClaim, created_at: stamp(op.addedAt) }
            if (matches(data)) byId.set(newClaimId, { id: newClaimId, data })
          }
        }
        if (op.kind === 'billing_payment') {
          const { invoiceId, paymentId, amountKobo, method, reference, notes, labOrderId, preview = {} } = op.args
          if (spec.collection === 'invoices') {
            const current = byId.get(invoiceId)?.data
            if (current) {
              const paid = Math.max(0, Number(current.paid_kobo) || 0) + amountKobo
              const total = Math.max(0, Number(current.total_kobo) || 0)
              const data = { ...current, paid_kobo: paid, status: paid >= total ? 'paid' : (paid > 0 ? 'part-paid' : 'unpaid'), updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(invoiceId, { id: invoiceId, data })
              else byId.delete(invoiceId)
            }
          } else if (spec.collection === 'payments') {
            const data = { invoice_id: invoiceId, invoice_number: preview.invoice_number || invoiceId,
              lab_order_id: labOrderId || '', patient_id: preview.patient_id || '', patient_name: preview.patient_name || '',
              amount_kobo: amountKobo, amount_naira: amountKobo / 100, method, reference: reference || '',
              receipt_number: 'REC-' + paymentId.slice(0, 8).toUpperCase(), paid_by: op.actor?.name || op.actor?.email || '',
              paid_at: stamp(op.addedAt), organization_id: orgId, notes: notes || '' }
            if (matches(data)) byId.set(paymentId, { id: paymentId, data })
          } else if (spec.collection === 'lab_orders' && labOrderId) {
            const current = byId.get(labOrderId)?.data
            if (current) {
              const paid = Math.max(0, Number(current.paid_kobo) || 0) + amountKobo
              const data = { ...current, paid_kobo: paid, payment_recorded_at: stamp(op.addedAt), updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(labOrderId, { id: labOrderId, data })
            }
          }
        }
        if (op.kind === 'medication_administer') {
          const { requestId, doseId, lineId, qty, route, site, note, preview = {} } = op.args
          if (spec.collection === 'medication_requests') {
            const current = byId.get(requestId)?.data
            if (current) {
              let items = Array.isArray(current.items) ? current.items.map((item) => ({ ...item })) : []
              if (!items.length && preview.quantity) items = [{ line_id: lineId, medicine: preview.medicine || '', unit: preview.unit || '',
                dosage: preview.dosage || '', quantity: preview.quantity, administered_qty: Number(current.administered_qty) || 0 }]
              items = items.map((item) => item.line_id === lineId
                ? { ...item, administered_qty: Math.min(Number(item.quantity) || 0, (Number(item.administered_qty) || 0) + qty) }
                : item)
              const data = { ...current, items, updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(requestId, { id: requestId, data })
            }
          } else if (spec.collection === 'medication_administrations') {
            const data = { ...preview, medication_request_id: requestId, line_id: lineId, medicine: preview.medicine || '',
              unit: preview.unit || '', dosage: preview.dosage || '', qty, route, site: site || '', note: note || '', type: 'given',
              reverses_id: '', administered_by: op.actor?.uid || '', administered_by_name: op.actor?.name || op.actor?.email || '',
              organization_id: orgId, administered_at: stamp(op.addedAt), created_at: stamp(op.addedAt), updated_at: stamp(op.addedAt) }
            if (matches(data)) byId.set(doseId, { id: doseId, data })
          }
        }
        if (op.kind === 'stock_receive') {
          const { drugId, movementId, qty, batch, expiry, supplier, unitCost, invoiceRef, preview = {} } = op.args
          if (spec.collection === 'stock_lots') {
            const current = byId.get(drugId)?.data
            if (current) {
              const stock = (Number(current.stock) || 0) + qty
              const data = { ...current, stock, batch, expiry, purchase_price: unitCost,
                status: stock === 0 ? 'Out' : (stock < 20 ? 'Low' : 'OK'), updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(drugId, { id: drugId, data })
            }
          } else if (spec.collection === 'stock_movements') {
            const data = { type: 'in', organization_id: orgId, drug_id: drugId, sku: preview.sku || '', name: preview.name || '',
              qty, batch, expiry, supplier: supplier || '', unit_cost: unitCost || 0, invoice_ref: invoiceRef || '',
              received_at: stamp(op.addedAt), created_at: stamp(op.addedAt), created_by: op.actor?.uid || null,
              created_by_name: op.actor?.name || op.actor?.email || '' }
            if (matches(data)) byId.set(movementId, { id: movementId, data })
          }
        }
        if (op.kind === 'pharmacy_dispense') {
          const { dispensationId, patientId, patientName, medicationRequestId, items } = op.args
          if (spec.collection === 'stock_lots') {
            const totals = new Map()
            for (const item of items) totals.set(item.drugId, (totals.get(item.drugId) || 0) + Number(item.requestedQty))
            for (const [drugId, qty] of totals) {
              const current = byId.get(drugId)?.data
              if (current) {
                const stock = Math.max(0, (Number(current.stock) || 0) - qty)
                const data = { ...current, stock, batch: stock > 0 ? (current.batch || '') : '', expiry: stock > 0 ? (current.expiry || '') : '',
                  status: stock === 0 ? 'Out' : (stock < 20 ? 'Low' : 'OK'), updated_at: stamp(op.addedAt) }
                if (matches(data)) byId.set(drugId, { id: drugId, data })
                else byId.delete(drugId)
              }
            }
          } else if (spec.collection === 'dispensations') {
            const data = { patient_id: patientId || '', patient_name: patientName || '',
              items: JSON.stringify(items.map((item) => ({ drug_id: item.drugId, sku: item.preview?.sku || '', name: item.preview?.name || '',
                batch: item.preview?.batch || '', qty: item.requestedQty, unit: item.preview?.unit || 'tabs' }))),
              by: op.actor?.name || op.actor?.email || '', status: 'dispensed', organization_id: orgId,
              medication_request_id: medicationRequestId || '', created_at: stamp(op.addedAt), updated_at: stamp(op.addedAt) }
            if (matches(data)) byId.set(dispensationId, { id: dispensationId, data })
          } else if (spec.collection === 'stock_movements') {
            for (const item of items) {
              const data = { type: 'out', organization_id: orgId, drug_id: item.drugId, sku: item.preview?.sku || '',
                name: item.preview?.name || '', qty: item.requestedQty, batch: item.preview?.batch || '', expiry: item.preview?.expiry || '',
                patient_id: patientId || '', patient_name: patientName || '', dispensation_id: dispensationId,
                medication_request_id: medicationRequestId || '', created_by: op.actor?.uid || null,
                created_by_name: op.actor?.name || op.actor?.email || '', created_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(item.movementId, { id: item.movementId, data })
            }
          } else if (spec.collection === 'medication_requests' && medicationRequestId) {
            const current = byId.get(medicationRequestId)?.data
            if (current) {
              let requestItems = Array.isArray(current.items) ? current.items.map((item) => ({ ...item })) : []
              const issued = new Map()
              for (const item of items) {
                const lineId = item.lineId || (requestItems.length === 1 ? requestItems[0].line_id : '')
                if (lineId) issued.set(lineId, (issued.get(lineId) || 0) + Number(item.requestedQty))
              }
              requestItems = requestItems.map((item) => issued.has(item.line_id)
                ? { ...item, dispensed_qty: Math.min(Number(item.quantity) || 0, (Number(item.dispensed_qty) || 0) + issued.get(item.line_id)) }
                : item)
              const complete = requestItems.length > 0 && requestItems.every((item) => (Number(item.dispensed_qty) || 0) >= (Number(item.quantity) || 0))
              const data = { ...current, items: requestItems, status: complete ? 'Dispensed' : 'Partially Dispensed',
                ...(complete ? { dispensed_at: stamp(op.addedAt) } : {}), updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(medicationRequestId, { id: medicationRequestId, data })
            }
          }
        }
        if (op.kind === 'stock_create' && spec.collection === 'stock_lots') {
          const data = { ...op.args.drug, created_at: stamp(op.addedAt), updated_at: stamp(op.addedAt),
            created_by: op.actor?.uid || null, created_by_name: op.actor?.name || op.actor?.email || '' }
          if (matches(data)) byId.set(op.args.drugId, { id: op.args.drugId, data })
        }
        if (op.kind === 'stock_create' && op.args.movementId && spec.collection === 'stock_movements') {
          const drug = op.args.drug
          const data = { type: 'opening', organization_id: orgId, drug_id: op.args.drugId,
            sku: drug.sku || drug.drug_code || '', name: drug.name || '', qty: Number(drug.stock), batch: drug.batch || '', expiry: drug.expiry || '',
            reference: 'opening balance', created_by: op.actor?.uid || null, created_by_name: op.actor?.name || op.actor?.email || '', created_at: stamp(op.addedAt) }
          if (matches(data)) byId.set(op.args.movementId, { id: op.args.movementId, data })
        }
        if (op.kind === 'stock_correct') {
          const { drugId, movementId, countedQty, reason } = op.args
          if (spec.collection === 'stock_lots') {
            const current = byId.get(drugId)?.data
            if (current) {
              const data = { ...current, stock: countedQty, status: countedQty === 0 ? 'Out' : (countedQty < 20 ? 'Low' : 'OK'), updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(drugId, { id: drugId, data })
              else byId.delete(drugId)
            }
          } else if (spec.collection === 'stock_movements') {
            const lot = byId.get(drugId)?.data || op.args.preview || {}
            const data = { type: 'adjust', organization_id: orgId, drug_id: drugId, sku: lot.sku || '', name: lot.name || '',
              qty: countedQty, counted_qty: countedQty, batch: lot.batch || '', expiry: lot.expiry || '', reason: reason || '',
              created_by: op.actor?.uid || null, created_by_name: op.actor?.name || op.actor?.email || '', created_at: stamp(op.addedAt) }
            if (matches(data)) byId.set(movementId, { id: movementId, data })
          }
        }
        if (op.kind === 'stock_update') {
          const { drugId, movementId, fields, previousStock = 0 } = op.args
          if (spec.collection === 'stock_lots') {
            const current = byId.get(drugId)?.data
            if (current) {
              const data = { ...current, ...fields, updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(drugId, { id: drugId, data })
              else byId.delete(drugId)
            }
          } else if (spec.collection === 'stock_movements') {
            const data = { type: 'adjust', organization_id: orgId, drug_id: drugId, sku: fields.sku || '', name: fields.name || '',
              qty: Number(fields.stock) - Number(previousStock), counted_qty: Number(fields.stock), batch: fields.batch || '', expiry: fields.expiry || '',
              reason: 'Stock adjustment via item edit', created_by: op.actor?.uid || null,
              created_by_name: op.actor?.name || op.actor?.email || '', created_at: stamp(op.addedAt) }
            if (matches(data)) byId.set(movementId, { id: movementId, data })
          }
        }
        if (op.kind === 'file_upload' && !op.args.remove) {
          const collectionName = op.args.kind === 'patient_photo' ? 'patient_photos' : 'result_images'
          if (spec.collection === collectionName) {
            const data = { ...op.args.metadata, created_by: op.actor?.uid || null,
              created_by_name: op.actor?.name || op.actor?.email || '',
              ...(op.args.kind === 'patient_photo' ? { updated_at: stamp(op.addedAt) } : { created_at: stamp(op.addedAt) }) }
            if (matches(data)) byId.set(op.args.id, { id: op.args.id, data })
          }
        }
        if (op.kind === 'file_upload' && op.args.remove && spec.collection === 'patient_photos') byId.delete(op.args.id)
        if (op.kind === 'pharmacy_reverse') {
          const { requestId, lineId, movementId, ticketId, preview = {} } = op.args
          if (spec.collection === 'stock_lots' && preview.drugId) {
            const current = byId.get(preview.drugId)?.data
            if (current) {
              const stock = (Number(current.stock) || 0) + (Number(preview.qty) || 0)
              const data = { ...current, stock, batch: current.batch || preview.batch || '', expiry: current.expiry || preview.expiry || '',
                status: stock === 0 ? 'Out' : (stock < 20 ? 'Low' : 'OK'), updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(preview.drugId, { id: preview.drugId, data })
            }
          } else if (spec.collection === 'stock_movements') {
            const data = { type: 'in', organization_id: orgId, drug_id: preview.drugId || '', sku: '', name: preview.medicine || '',
              qty: Number(preview.qty) || 0, batch: preview.batch || '', expiry: preview.expiry || '', reason: 'Dispense reversed', patient_id: preview.patientId || '',
              medication_request_id: requestId, line_id: lineId, created_by: op.actor?.uid || null,
              created_by_name: op.actor?.name || op.actor?.email || '', created_at: stamp(op.addedAt) }
            if (matches(data)) byId.set(movementId, { id: movementId, data })
          } else if (spec.collection === 'dispensations') {
            const data = { patient_id: preview.patientId || '', patient_name: preview.patientName || '', items: JSON.stringify([{ drug_id: preview.drugId, name: preview.medicine || '', qty: Number(preview.qty) || 0 }]),
              by: op.actor?.name || op.actor?.email || '', status: 'reversed', reason: 'Dispense reversed', organization_id: orgId,
              medication_request_id: requestId, line_id: lineId, created_at: stamp(op.addedAt), updated_at: stamp(op.addedAt) }
            if (matches(data)) byId.set(ticketId, { id: ticketId, data })
          } else if (spec.collection === 'medication_requests') {
            const current = byId.get(requestId)?.data
            if (current) {
              const items = Array.isArray(current.items) ? current.items.map((item) => item.line_id === lineId ? { ...item, dispensed_qty: 0 } : { ...item }) : []
              const data = { ...current, items, status: 'Partially Dispensed', reason: 'Dispense reversed', updated_at: stamp(op.addedAt) }
              if (matches(data)) byId.set(requestId, { id: requestId, data })
            }
          }
        }
        if (op.kind !== 'document_mutation') continue
        for (const mutation of op.args.mutations || []) {
          if (mutation.collection !== spec.collection) continue
          if (mutation.action === 'delete') { byId.delete(mutation.id); continue }
          const incoming = decode(mutation.data || {}, op.addedAt)
          let data
          if (mutation.action === 'create' || mutation.action === 'merge') {
            const current = byId.get(mutation.id)?.data
            data = mutation.action === 'merge' && current
              ? { ...current, ...incoming, updated_at: stamp(op.addedAt) }
              : { ...incoming, created_by: op.actor?.uid || null, created_by_name: op.actor?.name || op.actor?.email || '', updated_at: stamp(op.addedAt) }
          } else {
            const current = byId.get(mutation.id)?.data
            if (!current) continue
            data = { ...current, ...incoming, updated_at: stamp(op.addedAt) }
          }
          if (matches(data)) byId.set(mutation.id, { id: mutation.id, data })
          else byId.delete(mutation.id)
        }
      }
      let rows = [...byId.values()]
      for (const order of [...spec.orderBy].reverse()) {
        rows.sort((a, b) => {
          const convert = (v) => v && typeof v === 'object' && Number.isFinite(v.seconds) ? v.seconds * 1000 + (v.nanoseconds || 0) / 1e6 : v
          const x = convert(a.data?.[order.field]), y = convert(b.data?.[order.field])
          return (x < y ? -1 : x > y ? 1 : 0) * (order.dir === 'desc' ? -1 : 1)
        })
      }
      if (spec.limit) rows = rows.slice(0, spec.limit)
      return rows
    }

    if (membershipLive && db) {
      let queryTimer
      try {
        const query = applyQuerySpec(db, spec)
        const snap = await Promise.race([
          query.get(),
          new Promise((_, reject) => { queryTimer = setTimeout(() => reject(Object.assign(new Error('Firestore query timed out.'), { code: 'ETIMEDOUT' })), 3500) }),
        ])
        if (!spec.limit && snap.docs.length > MAX_CACHED_QUERY_DOCS) {
          json(res, 413, { ok: false, error: 'This query is too large for shared Host reads; narrow the list and retry.' }); return
        }
        const docs = snap.docs.map((item) => ({ id: item.id, data: serializeFirestoreData(item.data() || {}) }))
        try { await offlineQueryCache.set(cacheKey, docs) }
        catch (error) { log.warn('[hub] query result was served but not cached:', error?.message || error) }
        json(res, 200, { ok: true, source: 'cloud', docs: withPendingWrites(docs), savedAt: Date.now() }); return
      } catch (error) {
        const code = String(error?.code || '').toLowerCase()
        const transport = ['unavailable', 'deadline-exceeded', 'resource-exhausted', 'econnreset', 'econnrefused', 'etimedout', 'enotfound', 'eai_again'].includes(code) ||
          /network|unavailable|deadline exceeded|connection reset|connection refused|timed? ?out|dns/i.test(String(error?.message || ''))
        if (!transport) {
          json(res, error?.expose ? error.status || 400 : 400, { ok: false, error: error?.expose ? error.message : 'Host could not run this query.' })
          return
        }
      } finally { clearTimeout(queryTimer) }
    }

    const cached = await offlineQueryCache.get(cacheKey)
    if (!cached) {
      json(res, 503, { ok: false, error: 'This query has no saved Host copy yet.' }); return
    }
    json(res, 200, { ok: true, source: 'host-cache', docs: withPendingWrites(cached.docs), savedAt: cached.savedAt })
  }

  async function offlineDataDocumentRoute(req, res) {
    if (!req.socket.encrypted && !isLoopbackAddress(req.socket.remoteAddress)) {
      req.resume(); json(res, 403, { ok: false, error: 'Shared clinical data reads require HTTPS.' }); return
    }
    if (!offlineQueryCache) { req.resume(); json(res, 503, { ok: false, error: 'Host offline data cache is unavailable.' }); return }
    const origin = checkOrigin(req, cfg)
    if (!origin.ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
      req.resume(); json(res, 403, { ok: false, error: 'This browser is not allowed to read Host data.' }); return
    }
    let body
    try { body = await readJson(req, 32 * 1024) }
    catch (error) { json(res, error?.status || 400, { ok: false, error: error?.expose ? error.message : 'Could not read record request.' }); return }
    const { orgId, collection: collectionName, id } = body || {}
    const documentPath = String(body?.path || (collectionName && id ? collectionName + '/' + id : ''))
    if (!ORG_QUERY_READS.has(String(collectionName || '')) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(id || '')) ||
        !/^[A-Za-z0-9_-]{1,100}$/.test(String(orgId || '')) ||
        ![collectionName + '/' + id, collectionName + '/' + id + '/blob/data'].includes(documentPath)) {
      json(res, 400, { ok: false, error: 'Hospital record reference is invalid.' }); return
    }

    let bearerIdentity = null
    let bearerError = null
    try { bearerIdentity = await authenticator.verify(req) } catch (error) { bearerError = error }
    let deviceSession = null
    if (String(req.headers['x-speech-device'] || '')) {
      try {
        deviceSession = speechSessions?.authenticate(req, orgId, '') || null
        if (String(req.headers['x-speech-body-sha256'] || '').toLowerCase() !== createHash('sha256').update(JSON.stringify(body)).digest('hex')) {
          throw Object.assign(new Error('Signed record request does not match.'), { status: 401, expose: true })
        }
        if (bearerIdentity && bearerIdentity.uid !== deviceSession.uid) {
          throw Object.assign(new Error('Signed-in user does not match the Host device session.'), { status: 401, expose: true })
        }
      } catch (error) {
        if (error?.expose) { json(res, error.status || 401, { ok: false, error: error.message }); return }
        deviceSession = null
      }
    }
    const identity = bearerIdentity || (deviceSession ? { uid: deviceSession.uid, email: deviceSession.email, displayName: deviceSession.displayName } : null)
    if (!identity) {
      json(res, bearerError?.expose ? bearerError.status || 401 : 503,
        { ok: false, error: bearerError?.expose ? bearerError.message : 'Host authentication is unavailable.' }); return
    }
    if (deviceSession && deviceSession.orgId !== orgId) { json(res, 403, { ok: false, error: 'Device session belongs to another hospital.' }); return }

    let membershipLive = false
    try { await authenticator.authorize(identity, orgId, ''); membershipLive = true }
    catch (error) {
      if (error?.expose && error.status !== 503) { json(res, error.status || 403, { ok: false, error: error.message }); return }
      if (!deviceSession) { json(res, 503, { ok: false, error: 'Hospital access could not be verified.' }); return }
    }
    const caps = requiredCapabilitiesForRead(collectionName, identity, [])
    if (caps.length) {
      let allowed = deviceSession && !membershipLive
        ? deviceSession.permissions.includes('*') || caps.some((cap) => deviceSession.permissions.includes(cap))
        : false
      if (membershipLive) {
        for (const capability of caps) {
          try { await authenticator.authorize(identity, orgId, capability); allowed = true; break }
          catch (error) { if (!(error?.status === 403 || error?.status === 400)) { if (!deviceSession) { json(res, 503, { ok: false, error: 'Hospital access could not be verified.' }); return } } }
        }
      }
      if (!allowed) { json(res, 403, { ok: false, error: 'Your hospital role does not allow reading this record.' }); return }
    }

    const cacheKey = { orgId, query: { collection: collectionName, documentId: documentPath } }
    if (membershipLive && db) {
      let timer
      try {
        const snap = await Promise.race([
          db.doc(documentPath).get(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Firestore document read timed out.'), { code: 'ETIMEDOUT' })), 3500) }),
        ])
        const exists = snap.exists && (snap.data()?.organization_id === orgId || collectionName === 'patients' && snap.data()?.organization_id === orgId)
        const docData = exists ? serializeFirestoreData(snap.data() || {}) : null
        const row = { id, exists: !!exists, data: docData }
        try { await offlineQueryCache.set(cacheKey, [row]) }
        catch (error) { log.warn('[hub] document result was served but not cached:', error?.message || error) }
        json(res, 200, { ok: true, source: 'cloud', ...row }); return
      } catch (error) {
        const transport = ['unavailable', 'deadline-exceeded', 'resource-exhausted', 'econnreset', 'econnrefused', 'etimedout', 'enotfound', 'eai_again'].includes(String(error?.code || '').toLowerCase()) ||
          /network|unavailable|deadline exceeded|connection reset|connection refused|timed? ?out|dns/i.test(String(error?.message || ''))
        if (!transport) { json(res, 400, { ok: false, error: 'Host could not read this record.' }); return }
      } finally { clearTimeout(timer) }
    }
    const cached = await offlineQueryCache.get(cacheKey)
    const fileOp = (queue.pendingForOrg?.(orgId, 'file_upload') || []).find((op) => op.args?.id === id &&
      (op.args.kind === 'patient_photo' ? 'patient_photos' : 'result_images') === collectionName)
    if (fileOp) {
      if (fileOp.args.remove) { json(res, 200, { ok: true, source: 'host-pending', id, exists: false, data: null }); return }
      const blobDocument = documentPath.endsWith('/blob/data')
      const data = blobDocument
        ? { bytes: { __firestoreType: 'bytes', value: fileOp.args.contentBase64 }, content_type: fileOp.args.contentType, organization_id: orgId }
        : { ...fileOp.args.metadata, ...(collectionName === 'patient_photos' ? { updated_at: stamp(fileOp.addedAt) } : { created_at: stamp(fileOp.addedAt) }) }
      json(res, 200, { ok: true, source: 'host-pending', id, exists: true, data }); return
    }
    if (!cached?.docs?.[0]) { json(res, 503, { ok: false, error: 'This record has no saved Host copy yet.' }); return }
    json(res, 200, { ok: true, source: 'host-cache', ...cached.docs[0] })
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

    if (req.method === 'GET' && path === '/speech/health') {
      const orgId = String(url.searchParams.get('orgId') || '')
      if (!req.socket.encrypted || !checkOrigin(req, cfg).ok || String(req.headers[CLIENT_HEADER] || '') !== CLIENT_VALUE) {
        json(res, 403, { ok: false, available: false }); return
      }
      try {
        const identity = await authenticator.verifyOnline(req)
        await authenticator.authorize(identity, orgId, 'encounter.edit')
        const enabled = process.env.DEEPGRAM_ALLOW_CLINICAL_AUDIO === 'true' && !!process.env.DEEPGRAM_API_KEY && !!process.env.DEEPGRAM_ENDPOINT
        const available = enabled && await checkDeepgram({ apiKey: process.env.DEEPGRAM_API_KEY, endpoint: process.env.DEEPGRAM_ENDPOINT })
        json(res, 200, { ok: true, available, provider: available ? 'deepgram' : '' })
      } catch (error) { json(res, Number(error?.status) || 503, { ok: false, available: false, error: error?.expose ? error.message : 'Online access could not be verified.' }) }
      return
    }

    const deviceSessionAction = path === '/device/session/register' ? 'register' : path === '/device/session/offline' ? 'offline'
      : path === '/device/session/revalidate' ? 'revalidate' : path === '/device/session/revoke' ? 'revoke' : ''
    if (deviceSessionAction && req.method === 'POST') { await offlineDeviceSessionRoute(req, res, url, deviceSessionAction); return }

    if (req.method === 'POST' && path === '/device/data/query') {
      await offlineDataQueryRoute(req, res)
      return
    }
    if (req.method === 'POST' && path === '/device/data/document') {
      await offlineDataDocumentRoute(req, res)
      return
    }
    if (req.method === 'POST' && path === '/device/data/seed') {
      await handleOfflineSeed(req, res)
      return
    }

    if (req.method === 'POST' && path === '/outbox') {
      await handleOutbox(req, res)
      return
    }

    if (req.method === 'POST' && path === '/clinical-drafts') {
      await handleClinicalDraft(req, res)
      return
    }
    if (req.method === 'POST' && path === '/clinical-drafts/review') {
      await handleClinicalDraftReview(req, res)
      return
    }

    if (req.method === 'POST' && path === '/speech/transcribe') {
      await handleSpeechTranscribe(req, res, url)
      return
    }
    if (path === '/speech/jobs' || path.startsWith('/speech/jobs/') || path === '/speech/session' || path.startsWith('/speech/session/')) {
      req.resume()
      json(res, 404, { ok: false, error: 'This local transcription endpoint has been retired.' })
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
        auth: 'Firebase ID token or enrolled Host device session',
        endpoints: ['GET /health', 'POST /outbox', 'POST /device/data/query', 'POST /device/data/document'],
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
  const inferenceScheduler = overrides.inferenceScheduler || createInferenceScheduler()
  const clinicalAi = overrides.clinicalAi || createLocalClinicalAi({ schedule: inferenceScheduler.run })
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

  const queue = createQueue(cfg.queueFile, {
    encode: overrides.encodeQueueState || ((text) => text),
    decode: overrides.decodeQueueState || null,
  })
  if (overrides.encodeQueueState && overrides.decodeQueueState) {
    log.info('[hub] clinical queue at rest: encrypted with Host secure storage')
  } else {
    log.warn('[hub] clinical queue at rest: plaintext; use the packaged Host for encrypted storage')
  }
  const offlineQueryCache = createOfflineQueryCache({
    loadIndex: overrides.loadOfflineQueryIndex,
    saveIndex: overrides.saveOfflineQueryIndex,
    loadEntry: overrides.loadOfflineQueryEntry,
    saveEntry: overrides.saveOfflineQueryEntry,
    removeEntry: overrides.removeOfflineQueryEntry,
    log,
  })
  await offlineQueryCache.initialize()
  log.info('[hub] shared offline query cache ready' +
    (overrides.loadOfflineQueryIndex ? ' (encrypted Host storage)' : ' (memory only)'))

  // Serve the built app when present. Electron host mode passes an explicit
  // dir (the packaged dist); standalone `node hub/server.js` auto-detects
  // ./dist — with no dist, the hub behaves as an API only.
  let staticDir = overrides.staticDir
  if (staticDir === undefined) {
    staticDir = existsSync(resolve(PROJECT_ROOT, 'dist', 'index.html')) ? resolve(PROJECT_ROOT, 'dist') : ''
  }
  const serveStatic = makeStaticHandler(staticDir)

  const authenticator = overrides.authenticator || createAuthenticator({ auth: foundation.auth, db, log })
  const auditor = overrides.auditor || createAuditor({ db, log })
  const relay = createRelay({
    db,
    queue,
    handlers: overrides.handlers || HANDLERS,
    cfg,
    log,
    audit: auditor,
  })

  let speechSessions = null
  if (typeof overrides.loadSpeechSessions === 'function' && typeof overrides.saveSpeechSessions === 'function') {
    try {
      const { createSpeechSessions } = await import('./speech/sessions.js')
      speechSessions = createSpeechSessions({ load: overrides.loadSpeechSessions, save: overrides.saveSpeechSessions, log })
      await speechSessions.initialize()
    } catch (error) {
      log.error('[hub] offline device-session service could not initialize:', error?.message || error)
      speechSessions = null
    }
  }

  const verifiedHttpsAddresses = new Set()
  const handler = makeHandler({
    cfg, queue, relay, db, authReady: !!foundation.auth, authenticator, staticDir, serveStatic, log, speechSessions, offlineQueryCache,
    clinicalAi,
    auditSpeech: overrides.auditSpeech,
    speechProvider: overrides.speechProvider || transcribeWithDeepgram,
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
    speechSessions,
    offlineQueryCache,
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
