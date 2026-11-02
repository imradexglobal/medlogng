const fields = ['S', 'O', 'A', 'P']
const provenance = new Set(['patient-reported', 'clinician-observed', 'unclear'])
const certainty = new Set(['clear', 'uncertain'])

// Deployment-local mirror of src/features/clinicalDocumentation/drafts.js.
// Keep these schema rules in parity when changing the versioned draft format.
export function validateClinicalDraft(draft, transcript) {
  const record = (value) => value && typeof value === 'object' && !Array.isArray(value)
  const only = (value, keys) => record(value) && Object.keys(value).every((key) => keys.includes(key))
  const span = (item) => only(item, ['start', 'end', 'quote']) &&
    Number.isSafeInteger(item.start) && Number.isSafeInteger(item.end) && item.start >= 0 && item.end > item.start &&
    item.end <= transcript.length && item.quote === transcript.slice(item.start, item.end)
  if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 100_000 || !only(draft, ['schemaVersion', 'fields', 'unresolved', 'conflicts']) || draft.schemaVersion !== 1 ||
      !only(draft.fields, fields) ||
      !Array.isArray(draft.unresolved) || !Array.isArray(draft.conflicts)) return { valid: false }
  for (const key of fields) {
    const items = draft.fields[key]
    if (!Array.isArray(items) || items.length > 100) return { valid: false }
    for (const item of items) {
      if (!only(item, ['text', 'provenance', 'certainty', 'evidence', 'conflict']) ||
          typeof item.text !== 'string' || !item.text.trim() || item.text.length > 4000 || !provenance.has(item.provenance) ||
          !certainty.has(item.certainty) || !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 10 ||
          (item.conflict !== undefined && typeof item.conflict !== 'string') ||
          item.evidence.some((value) => !span(value))) return { valid: false }
    }
  }
  if (draft.unresolved.length > 100 || draft.unresolved.some((item) => typeof item !== 'string' || !item.trim() || item.length > 4000)) return { valid: false }
  if (draft.conflicts.length > 100 || draft.conflicts.some((item) => !only(item, ['description', 'evidence']) ||
      typeof item.description !== 'string' || !item.description.trim() || item.description.length > 4000 || !Array.isArray(item.evidence) ||
      item.evidence.length < 2 || item.evidence.some((value) => !span(value)))) return { valid: false }
  return { valid: true }
}
