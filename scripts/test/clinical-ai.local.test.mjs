import assert from 'node:assert/strict'
import { createLocalClinicalAi } from '../../hub/clinical-ai/ollama.js'
import { validateClinicalDraft as validateCloudDraft } from '../../functions/draftValidation.js'
import { validateClinicalDraft as validateClientDraft } from '../../src/features/clinicalDocumentation/drafts.js'
import { createInferenceScheduler } from '../../hub/clinical-ai/inferenceScheduler.js'

const transcript = 'I have had a cough for three days. No fever.'
const modelOutput = {
  fields: {
    S: [{ text: 'Reports cough for three days.', provenance: 'patient-reported', certainty: 'clear', evidence_quotes: ['I have had a cough for three days.'] }],
    O: [], A: [], P: [],
  }, unresolved: ['No examination findings were provided.'], conflicts: [],
}
const fakeOllama = (output, onGenerate = async () => {}) => async (url, options) => {
  if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'synthetic-test-model', digest: 'synthetic-digest' }] }), { status: 200 })
  assert.equal(url, 'http://127.0.0.1:11434/api/generate')
  assert.equal(options.method, 'POST')
  const body = JSON.parse(options.body)
  assert.equal(body.format.additionalProperties, false, 'Ollama receives a constrained JSON schema')
  assert.equal(body.keep_alive, 0, 'Ollama unloads after the request to release RAM for Whisper')
  await onGenerate(body)
  return new Response(JSON.stringify({ model: 'synthetic-test-model', created_at: 'synthetic', total_duration: 1_250_000_000, load_duration: 250_000_000, prompt_eval_count: 400, eval_count: 100, response: JSON.stringify(output) }), { status: 200 })
}
let received = ''
const service = createLocalClinicalAi({ endpoint: 'http://127.0.0.1:11434', model: 'synthetic-test-model', fetchImpl: async (url, options) => {
  if (url.endsWith('/api/generate')) received = JSON.parse(options.body).prompt
  return fakeOllama(modelOutput)(url, options)
} })
const draft = await service.generate(transcript)
assert.equal(validateCloudDraft(draft, transcript).valid, true)
assert.equal(validateClientDraft(draft, transcript).valid, true)
assert.match(received, /I have had a cough for three days/)
assert.equal(draft.fields.S[0].text, 'Reports cough for three days.')
assert.equal(transcript.slice(draft.fields.S[0].evidence[0].start, draft.fields.S[0].evidence[0].end), 'I have had a cough for three days.')
assert.deepEqual(draft.fields.P, [])
const generatedDetailed = await service.generateDetailed(transcript)
assert.equal(generatedDetailed.metadata.modelDigest, 'synthetic-digest')
assert.equal(generatedDetailed.metadata.totalDurationMs, 1250)

const fabricated = createLocalClinicalAi({ model: 'synthetic-test-model', fetchImpl: fakeOllama({
  fields: { S: [{ text: 'Has severe pneumonia.', provenance: 'patient-reported', certainty: 'clear', evidence_quotes: ['Patient has severe pneumonia.'] }], O: [], A: [], P: [] }, unresolved: [], conflicts: [],
}) })
await assert.rejects(() => fabricated.generate(transcript), /evidence not present/)
assert.equal(validateCloudDraft({ schemaVersion: 1, fields: { S: [{ text: 'Unsupported', provenance: 'patient-reported', certainty: 'clear', evidence: [{ start: 0, end: 29, quote: 'Patient has severe pneumonia.' }] }], O: [], A: [], P: [] }, unresolved: [], conflicts: [] }, transcript).valid, false)

const remote = createLocalClinicalAi({ endpoint: 'https://provider.example/api', model: 'x', fetchImpl: async () => { throw new Error('must not make network call') } })
await assert.rejects(() => remote.generate(transcript), /loopback endpoint/)

const unavailable = createLocalClinicalAi({ model: '', fetchImpl: async () => { throw new Error('must not call provider') } })
await assert.rejects(() => unavailable.generate(transcript), /not configured/)

let currentModelCalls = 0
let peakModelCalls = 0
const serialized = createLocalClinicalAi({ model: 'synthetic-test-model', fetchImpl: fakeOllama(modelOutput, async () => {
  currentModelCalls += 1
  peakModelCalls = Math.max(peakModelCalls, currentModelCalls)
  await new Promise((resolve) => setTimeout(resolve, 25))
  currentModelCalls -= 1
}) })
const queued = [serialized.generate(transcript), serialized.generate(transcript), serialized.generate(transcript)]
assert.equal(serialized.status().pending, 3)
await assert.rejects(() => serialized.generate(transcript), /busy/)
await Promise.all(queued)
assert.equal(peakModelCalls, 1, 'Host sends at most one generation to Ollama at a time')
assert.deepEqual(serialized.status(), { active: 0, pending: 0, concurrency: 1, maxQueued: 2 })
const sharedLane = createInferenceScheduler()
const laneEvents = []
let activeWork = 0
let peakWork = 0
const scheduled = createLocalClinicalAi({ model: 'synthetic-test-model', schedule: sharedLane.run, fetchImpl: fakeOllama(modelOutput, async () => {
  activeWork += 1; peakWork = Math.max(peakWork, activeWork); laneEvents.push('clinical-ai')
  await new Promise((resolve) => setTimeout(resolve, 10))
  activeWork -= 1
}) })
const aiOne = scheduled.generate(transcript)
const whisperWork = sharedLane.run('whisper', async () => {
  activeWork += 1; peakWork = Math.max(peakWork, activeWork); laneEvents.push('whisper')
  await new Promise((resolve) => setTimeout(resolve, 10)); activeWork -= 1
})
const aiTwo = scheduled.generate(transcript)
await Promise.all([aiOne, whisperWork, aiTwo])
assert.equal(peakWork, 1, 'Whisper and local documentation generation share one inference lane')
assert.deepEqual(laneEvents, ['clinical-ai', 'whisper', 'clinical-ai'])
console.log('clinical AI local adapter: synthetic structure, exact evidence, fabricated citation rejection, remote-provider denial and serialized bounded queue passed')
