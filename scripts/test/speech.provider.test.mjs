import assert from 'node:assert/strict'
import { checkDeepgram, transcribeWithDeepgram, validateSpeechAudio } from '../../functions/speechProvider.js'

const wav = Buffer.alloc(1024)
wav.write('RIFF', 0); wav.write('WAVE', 8)
assert.equal(validateSpeechAudio(wav, 'audio/wav'), 'audio/wav')
assert.throws(() => validateSpeechAudio(Buffer.alloc(1024), 'audio/wav'), /signature/i)
assert.throws(() => validateSpeechAudio(wav, 'application/octet-stream'), /format/i)
assert.throws(() => validateSpeechAudio(Buffer.alloc(26 * 1024 * 1024), 'audio/wav'), /25 MB/i)

let sentUrl
let sentHeaders
const result = await transcribeWithDeepgram({
  audio: wav, contentType: 'audio/wav', apiKey: 'test-server-secret', endpoint: 'https://api.in.deepgram.com',
  fetchImpl: async (url, options) => {
    sentUrl = new URL(url); sentHeaders = options.headers
    assert.equal(options.method, 'POST')
    assert.equal(options.body, wav)
    return { ok: true, json: async () => ({ results: { channels: [{ alternatives: [{ transcript: 'Synthetic transcript.' }] }] }, metadata: { request_id: 'provider-request' } }) }
  },
})
assert.equal(result.text, 'Synthetic transcript.')
assert.equal(result.model, 'nova-3-medical')
assert.equal(sentUrl.hostname, 'api.in.deepgram.com')
assert.equal(sentUrl.searchParams.get('model'), 'nova-3-medical')
assert.equal(sentUrl.searchParams.get('language'), 'en')
assert.equal(sentUrl.searchParams.get('mip_opt_out'), 'true')
assert.equal(sentHeaders.Authorization, 'Token test-server-secret')

for (const endpoint of ['http://api.deepgram.com', 'https://evil.example', 'https://api.deepgram.com:444', 'https://user:pass@api.deepgram.com']) {
  await assert.rejects(() => transcribeWithDeepgram({ audio: wav, contentType: 'audio/wav', apiKey: 'secret', endpoint,
    fetchImpl: async () => { assert.fail('disallowed endpoint received the secret') } }), /Deepgram endpoint/i)
}
assert.equal(await checkDeepgram({ apiKey: 'secret', endpoint: 'https://api.deepgram.com', fetchImpl: async (url, opts) => {
  assert.equal(new URL(url).pathname, '/v1/projects'); assert.equal(opts.headers.Authorization, 'Token secret'); return { ok: true }
} }), true)
assert.equal(await checkDeepgram({ apiKey: 'secret', endpoint: 'https://evil.example', fetchImpl: async () => assert.fail('invalid health endpoint must not be contacted') }), false)
console.log('Deepgram adapter validation, retention opt-out, endpoint allowlist and health checks passed')
