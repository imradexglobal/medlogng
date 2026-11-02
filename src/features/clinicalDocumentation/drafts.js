// Versioned, evidence-linked clinical draft contract.
// This module validates provider output and review transitions; it does not
// generate clinical content or treat validation as proof of clinical accuracy.

export const CLINICAL_DRAFT_SCHEMA_VERSION = 1
export const CLINICAL_DRAFT_FIELDS = Object.freeze(['S', 'O', 'A', 'P'])
const MAX_TRANSCRIPT_LENGTH = 100_000
const MAX_ITEMS_PER_FIELD = 100
const MAX_ITEM_LENGTH = 4_000
const MAX_UNRESOLVED = 100
const PROVENANCE = new Set(['patient-reported', 'clinician-observed', 'unclear'])
const CERTAINTY = new Set(['clear', 'uncertain'])

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null))
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.includes(key))
}

function invalid(reason) {
  return { valid: false, reason }
}

/**
 * Check the structural and citation requirements for a draft. Evidence spans
 * use JavaScript UTF-16 offsets and must quote the exact immutable transcript.
 * Semantic support still requires clinician review.
 */
export function validateClinicalDraft(draft, transcript) {
  if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > MAX_TRANSCRIPT_LENGTH) {
    return invalid('A non-empty transcript within the supported size is required.')
  }
  if (!hasOnlyKeys(draft, ['schemaVersion', 'fields', 'unresolved', 'conflicts']) ||
      draft.schemaVersion !== CLINICAL_DRAFT_SCHEMA_VERSION ||
      !hasOnlyKeys(draft.fields, CLINICAL_DRAFT_FIELDS) ||
      !Array.isArray(draft.unresolved) || !Array.isArray(draft.conflicts)) {
    return invalid('Draft does not match the supported clinical draft schema.')
  }
  if (draft.unresolved.length > MAX_UNRESOLVED || draft.conflicts.length > MAX_UNRESOLVED) {
    return invalid('Draft contains too many unresolved items.')
  }

  for (const field of CLINICAL_DRAFT_FIELDS) {
    const items = draft.fields[field]
    if (!Array.isArray(items) || items.length > MAX_ITEMS_PER_FIELD) return invalid('Draft field is malformed.')
    for (const item of items) {
      if (!hasOnlyKeys(item, ['text', 'provenance', 'certainty', 'evidence', 'conflict']) ||
          typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_ITEM_LENGTH ||
          !PROVENANCE.has(item.provenance) || !CERTAINTY.has(item.certainty) ||
          !Array.isArray(item.evidence) || item.evidence.length === 0 || item.evidence.length > 10 ||
          (item.conflict !== undefined && typeof item.conflict !== 'string')) {
        return invalid('Every proposed clinical item must be bounded, classified, and evidence-linked.')
      }
      for (const evidence of item.evidence) {
        if (!hasOnlyKeys(evidence, ['start', 'end', 'quote']) ||
            !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
            evidence.start < 0 || evidence.end <= evidence.start || evidence.end > transcript.length ||
            typeof evidence.quote !== 'string' || evidence.quote !== transcript.slice(evidence.start, evidence.end)) {
          return invalid('Evidence must match an exact span in the reviewed transcript.')
        }
      }
    }
  }
  if (draft.unresolved.some((item) => typeof item !== 'string' || !item.trim() || item.length > MAX_ITEM_LENGTH)) {
    return invalid('Unresolved items must be short, non-empty text.')
  }
  for (const conflict of draft.conflicts) {
    if (!hasOnlyKeys(conflict, ['description', 'evidence']) ||
        typeof conflict.description !== 'string' || !conflict.description.trim() ||
        conflict.description.length > MAX_ITEM_LENGTH || !Array.isArray(conflict.evidence) || conflict.evidence.length < 2) {
      return invalid('Conflicts must identify a description and at least two evidence spans.')
    }
    for (const evidence of conflict.evidence) {
      if (!hasOnlyKeys(evidence, ['start', 'end', 'quote']) ||
          !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
          evidence.start < 0 || evidence.end <= evidence.start || evidence.end > transcript.length ||
          evidence.quote !== transcript.slice(evidence.start, evidence.end)) {
        return invalid('Conflict evidence must match exact transcript spans.')
      }
    }
  }
  return { valid: true }
}

/** Create an in-memory review state bound to the current clinician/encounter. */
export function createClinicalDraftReview({ draft, transcript, uid, organizationId, patientId, encounterId }) {
  const check = validateClinicalDraft(draft, transcript)
  if (!check.valid) throw new Error(check.reason)
  if (![uid, organizationId, patientId, encounterId].every((value) => typeof value === 'string' && value.trim())) {
    throw new Error('Clinician, organization, patient, and encounter bindings are required.')
  }
  return {
    status: 'review',
    schemaVersion: CLINICAL_DRAFT_SCHEMA_VERSION,
    draft: structuredClone(draft),
    transcript,
    binding: { uid, organizationId, patientId, encounterId },
    createdAt: Date.now(),
    reviewerUid: null,
    reviewedAt: null,
  }
}

/** Mark clinician decision for audit. This does not save encounter data. */
export function decideClinicalDraft(review, { decision, reviewerUid, activeEncounterId, canEditEncounter, now = Date.now() }) {
  if (!review || review.status !== 'review') throw new Error('Draft is not awaiting review.')
  const currentDraftCheck = validateClinicalDraft(review.draft, review.transcript)
  if (!currentDraftCheck.valid) throw new Error('Draft was changed after validation: ' + currentDraftCheck.reason)
  if (decision !== 'approved' && decision !== 'rejected') throw new Error('A clinician must approve or reject the draft.')
  if (!reviewerUid || reviewerUid !== review.binding.uid) throw new Error('Only the clinician who owns this draft may review it.')
  if (activeEncounterId !== review.binding.encounterId) throw new Error('Draft encounter does not match the open consultation.')
  if (decision === 'approved' && canEditEncounter !== true) throw new Error('Current encounter.edit permission is required to approve this draft.')
  return {
    ...review,
    status: decision,
    reviewerUid,
    reviewedAt: Number.isFinite(now) ? now : Date.now(),
  }
}

/** Return only clinician-accepted text after the bound draft has been approved. */
export function approvedClinicalText(review, decisions) {
  if (!review || review.status !== 'approved' || !decisions || typeof decisions.get !== 'function') {
    throw new Error('Only an approved review can be inserted.')
  }
  return Object.fromEntries(CLINICAL_DRAFT_FIELDS.map((field) => [field, review.draft.fields[field]
    .filter((_item, index) => decisions.get(field + ':' + index) === 'accepted')
    .map((item) => item.text.trim()).filter(Boolean)]))
}

/** Create a minimal audit record; callers persist it through approved audit APIs. */
export function clinicalDraftAuditEvent(review, action) {
  if (!review?.binding || !['generated', 'approved', 'rejected', 'saved'].includes(action)) {
    throw new Error('Invalid clinical draft audit action.')
  }
  return {
    action: 'clinical_draft.' + action,
    actor_uid: action === 'generated' ? review.binding.uid : (review.reviewerUid || review.binding.uid),
    organization_id: review.binding.organizationId,
    patient_id: review.binding.patientId,
    encounter_id: review.binding.encounterId,
    occurred_at: action === 'generated' ? review.createdAt : review.reviewedAt,
    schema_version: review.schemaVersion,
  }
}
