import assert from 'node:assert/strict'
import { createLocalClinicalAi } from '../../hub/clinical-ai/ollama.js'
import { validateClinicalDraft as validateCloudDraft } from '../../functions/draftValidation.js'
import { validateClinicalDraft as validateClientDraft } from '../../src/features/clinicalDocumentation/drafts.js'

const transcript = 'I have had a cough for three days. No fever.'
const modelOutput = {
  fields: {
    S: [{ text: 'Reports cough for three days.', provenance: 'patient-reported', certainty: 'clear', evidence_quotes: ['I have had a cough for three days.'] }],
    O: [], A: [], P: [],
  }, unresolved: ['No examination findings were provided.'], conflicts: [],
}
let received = ''
const service = createLocalClinicalAi({ endpoint: 'http://127.0.0.1:11434', model: 'synthetic-test-model', fetchImpl: async (url, options) => {
  assert.equal(url, 'http://127.0.0.1:11434/api/generate')
  assert.equal(options.method, 'POST')
  const body = JSON.parse(options.body)
  received = body.prompt
  assert.equal(body.format.additionalProperties, false, 'Ollama receives a constrained JSON schema')
  return new Response(JSON.stringify({ response: JSON.stringify(modelOutput) }), { status: 200 })
} })
const draft = await service.generate(transcript)
assert.equal(validateCloudDraft(draft, transcript).valid, true)
assert.equal(validateClientDraft(draft, transcript).valid, true)
assert.match(received, /I have had a cough for three days/)
assert.equal(draft.fields.S[0].text, 'Reports cough for three days.')
assert.equal(transcript.slice(draft.fields.S[0].evidence[0].start, draft.fields.S[0].evidence[0].end), 'I have had a cough for three days.')
assert.deepEqual(draft.fields.P, [])

const fabricated = createLocalClinicalAi({ model: 'synthetic-test-model', fetchImpl: async () => new Response(JSON.stringify({ response: JSON.stringify({
  fields: { S: [{ text: 'Has severe pneumonia.', provenance: 'patient-reported', certainty: 'clear', evidence_quotes: ['Patient has severe pneumonia.'] }], O: [], A: [], P: [] }, unresolved: [], conflicts: [],
}) }), { status: 200 }) })
await assert.rejects(() => fabricated.generate(transcript), /evidence not present/)
assert.equal(validateCloudDraft({ schemaVersion: 1, fields: { S: [{ text: 'Unsupported', provenance: 'patient-reported', certainty: 'clear', evidence: [{ start: 0, end: 29, quote: 'Patient has severe pneumonia.' }] }], O: [], A: [], P: [] }, unresolved: [], conflicts: [] }, transcript).valid, false)

const remote = createLocalClinicalAi({ endpoint: 'https://provider.example/api', model: 'x', fetchImpl: async () => { throw new Error('must not make network call') } })
await assert.rejects(() => remote.generate(transcript), /loopback endpoint/)

const unavailable = createLocalClinicalAi({ model: '', fetchImpl: async () => { throw new Error('must not call provider') } })
await assert.rejects(() => unavailable.generate(transcript), /not configured/)

let currentModelCalls = 0
let peakModelCalls = 0
const serialized = createLocalClinicalAi({ model: 'synthetic-test-model', fetchImpl: async () => {
  currentModelCalls += 1
  peakModelCalls = Math.max(peakModelCalls, currentModelCalls)
  await new Promise((resolve) => setTimeout(resolve, 25))
  currentModelCalls -= 1
  return new Response(JSON.stringify({ response: JSON.stringify(modelOutput) }), { status: 200 })
} })
const queued = [serialized.generate(transcript), serialized.generate(transcript), serialized.generate(transcript)]
assert.equal(serialized.status().pending, 3)
await assert.rejects(() => serialized.generate(transcript), /busy/)
await Promise.all(queued)
assert.equal(peakModelCalls, 1, 'Host sends at most one generation to Ollama at a time')
assert.deepEqual(serialized.status(), { active: 0, pending: 0, concurrency: 1, maxQueued: 2 })
console.log('clinical AI local adapter: synthetic structure, exact evidence, fabricated citation rejection, remote-provider denial and serialized bounded queue passed')
