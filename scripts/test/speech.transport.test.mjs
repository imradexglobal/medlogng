import assert from 'node:assert/strict'
import { hasLocalSpeechHost } from '../../src/services/speechTransport.js'

let requestedUrl = ''
const host = await hasLocalSpeechHost({
  origin: 'https://host.hospital.test',
  fetchImpl: async (url) => {
    requestedUrl = url
    return { ok: true, headers: { get: () => 'application/json; charset=utf-8' }, json: async () => ({ ok: true, hub: true, version: 'hub-test' }) }
  },
})
assert.equal(host, true)
assert.equal(requestedUrl, 'https://host.hospital.test/health')

const firebaseHostingRewrite = await hasLocalSpeechHost({
  origin: 'https://medlogng.web.app',
  fetchImpl: async () => ({ ok: true, headers: { get: () => 'text/html; charset=utf-8' }, json: async () => { throw new Error('not JSON') } }),
})
assert.equal(firebaseHostingRewrite, false, 'Firebase Hosting index fallback is not a speech backend')

const fakeJsonHub = await hasLocalSpeechHost({
  origin: 'https://medlogng.web.app',
  fetchImpl: async () => ({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, hub: true }) }),
})
assert.equal(fakeJsonHub, false, 'a response without a Hub version is not accepted')

const unreachable = await hasLocalSpeechHost({ origin: 'https://host.hospital.test', fetchImpl: async () => { throw new Error('offline') } })
assert.equal(unreachable, false)
console.log('speech deployment detection passed')
