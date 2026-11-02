import assert from 'node:assert/strict'
import {
  validateClinicalDraft, createClinicalDraftReview, decideClinicalDraft, approvedClinicalText, clinicalDraftAuditEvent,
} from '../../src/features/clinicalDocumentation/drafts.js'

const transcript = 'Patient reports fever since yesterday. Temperature is 38 C.'
const first = { start: 0, end: 39, quote: transcript.slice(0, 39) }
const second = { start: 40, end: transcript.length, quote: transcript.slice(40) }
const draft = {
  schemaVersion: 1,
  fields: {
    S: [{ text: 'Fever since yesterday', provenance: 'patient-reported', certainty: 'clear', evidence: [first] }],
    O: [{ text: 'Temperature is 38 C', provenance: 'clinician-observed', certainty: 'clear', evidence: [second] }],
    A: [], P: [],
  },
  unresolved: [],
  conflicts: [],
}

assert.deepEqual(validateClinicalDraft(draft, transcript), { valid: true })
assert.equal(validateClinicalDraft({ ...draft, actions: [{ type: 'prescribe' }] }, transcript).valid, false)
assert.equal(validateClinicalDraft({ ...draft, fields: { ...draft.fields, S: [{ ...draft.fields.S[0], evidence: [{ ...first, quote: 'altered' }] }] } }, transcript).valid, false)
assert.equal(validateClinicalDraft({ ...draft, fields: { ...draft.fields, A: [{ text: 'diagnosis', provenance: 'clinician-observed', certainty: 'clear', evidence: [] }] } }, transcript).valid, false)
assert.equal(validateClinicalDraft(draft, '').valid, false)

const review = createClinicalDraftReview({ draft, transcript, uid: 'test-clinician', organizationId: 'test-hospital', patientId: 'synthetic-patient', encounterId: 'synthetic-encounter' })
assert.throws(() => decideClinicalDraft(review, { decision: 'approved', reviewerUid: 'other-clinician', activeEncounterId: 'synthetic-encounter', canEditEncounter: true }), /owns this draft/)
assert.throws(() => decideClinicalDraft(review, { decision: 'approved', reviewerUid: 'test-clinician', activeEncounterId: 'other-encounter', canEditEncounter: true }), /does not match/)
assert.throws(() => decideClinicalDraft(review, { decision: 'approved', reviewerUid: 'test-clinician', activeEncounterId: 'synthetic-encounter', canEditEncounter: false }), /encounter.edit/)
assert.equal(review.status, 'review', 'review state remains unchanged until an explicit decision')
const tamperedReview = createClinicalDraftReview({ draft, transcript, uid: 'test-clinician', organizationId: 'test-hospital', patientId: 'synthetic-patient', encounterId: 'synthetic-encounter' })
tamperedReview.draft.fields.S[0].evidence[0].quote = 'changed after generation'
assert.throws(() => decideClinicalDraft(tamperedReview, { decision: 'approved', reviewerUid: 'test-clinician', activeEncounterId: 'synthetic-encounter', canEditEncounter: true }), /changed after validation/)

const approved = decideClinicalDraft(review, { decision: 'approved', reviewerUid: 'test-clinician', activeEncounterId: 'synthetic-encounter', canEditEncounter: true, now: 1234 })
assert.equal(approved.status, 'approved')
assert.deepEqual(approvedClinicalText(approved, new Map([['S:0', 'accepted'], ['O:0', 'rejected']])), { S: ['Fever since yesterday'], O: [], A: [], P: [] })
assert.throws(() => approvedClinicalText(review, new Map([['S:0', 'accepted']])), /Only an approved review/)
assert.equal(clinicalDraftAuditEvent(approved, 'approved').encounter_id, 'synthetic-encounter')
assert.equal(clinicalDraftAuditEvent(approved, 'approved').actor_uid, 'test-clinician')
assert.throws(() => decideClinicalDraft(approved, { decision: 'approved', reviewerUid: 'test-clinician', activeEncounterId: 'synthetic-encounter', canEditEncounter: true }), /not awaiting/)
console.log('clinical draft safety contract passed')
