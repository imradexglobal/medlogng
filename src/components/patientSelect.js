// ONE patient search for every patient picker — no Firebase imports.
//
// The Patients registry (#/patients) searches through matchesPatient
// (features/patients/search.js): it parses the box once (mobile number vs
// name vs patient ID vs MRN) and matches surnames/given names in either
// order, the MRN, the pid and the BARE phone digits. Every other place a
// patient is picked — start encounter, admit, new lab order, new invoice,
// book appointment, admit-from-encounters — used to filter the <option>
// labels with a plain substring instead, so the same name (or number) typed
// there found nothing while #/patients found the record.
//
// These two helpers route the picker through the registry's matcher, so a
// query that finds a patient on #/patients finds them in every picker too.
import { wireSearchableSelect } from './shell.js'
import { matchesPatient } from '../features/patients/search.js'

// A match(option, rawQuery) for wireSearchableSelect / formModal's
// `searchable` selects, built from the patient rows the picker renders.
// Options carry the pid as their value, which is how the row behind an
// option is recovered — never re-parsed out of the label.
export function patientSelectMatcher(rows) {
  const byPid = new Map((rows || []).map((r) => [String(r.pid || ''), r]))
  return (option, query) => {
    if (!query) return true
    const row = byPid.get(String(option.value || ''))
    // The row is not in the loaded list (a patient added since the page was
    // built) — fall back to the visible label so the option is still pickable.
    if (!row) {
      const label = String(option.getAttribute('data-label') || option.textContent || '').trim().toLowerCase()
      return label.includes(String(query).toLowerCase())
    }
    return matchesPatient(row, query)
  }
}

// Wire a patient <select> (and its filter box, when the caller passes one)
// to the canonical matcher. `rows` are the same toPatientRow objects the
// option list was built from.
export function wirePatientSelect(box, sel, rows) {
  wireSearchableSelect(box, sel, { match: patientSelectMatcher(rows) })
}
