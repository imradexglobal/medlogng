// Pure patient search + phone rules — no Firebase imports (unit-testable).
// Same pattern as features/encounters/domain.js and features/admissions/domain.js.
//
// A patient record stores two phone fields:
//   phone     — display/E.164, e.g. '+2348031234567'
//   phone_key — bare local digits, e.g. '803123456'
// A search box, however, receives whatever the user has to hand: '0803…',
// '803…', '+234 803…', '234803…'. Every one of those has to resolve to the same
// record, so search always compares BARE DIGITS.

export const MIN_PHONE_DIGITS = 4

// ---- phone normalisation ----------------------------------------------------
// Accepts 0803…, 803…, 234803…, +234 803… → canonical '0XXXXXXXXXX' or '' if invalid.
export function normalizePhone(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '')
  if (!d) return ''
  // A country code is only stripped when the number is LONGER than a local one.
  // '234…' is also a valid local mobile prefix, so a bare 10-digit number
  // starting 234 must not be mistaken for '+234…'.
  if (d.length > 10 && d.startsWith('234')) d = '0' + d.slice(3)
  else if (d.length === 10) d = '0' + d
  return /^0\d{10}$/.test(d) ? d : ''
}

export function phoneKey(raw) {
  const local = normalizePhone(raw)
  return local ? local.slice(1) : ''
}

export function formatPhone(phone, key) {
  const d = String(phone || '').replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('234')) {
    return '+234 ' + d.slice(3, 6) + ' ' + d.slice(6, 9) + ' ' + d.slice(9)
  }
  if (key) return '+234 ' + String(key).replace(/(\d{3})(\d{3})(\d+)/, '$1 $2 $3')
  return phone || '—'
}

// Lenient counterpart to normalizePhone, for SEARCH only: strips the country
// code and any leading trunk zero so '0803…', '+234 803…' and '8031234567' all
// collapse to the same digit run. Unlike normalizePhone it does not reject a
// partial number, because searching '8031' must still be able to match.
//
// Idempotent: normalising already-normalised digits is a no-op, so callers may
// normalise a query and then hand it to phoneMatches without corrupting it.
export function phoneSearchDigits(raw) {
  let d = String(raw == null ? '' : raw).replace(/\D/g, '')
  if (!d) return ''
  if (d.length > 10) {
    if (d.startsWith('234')) d = d.slice(3)
    else if (d.startsWith('0')) d = d.slice(1)
  }
  return d
}

// The digits a record can be found by, preferring phone_key but tolerating
// records written before that field existed.
function recordPhoneDigits(row) {
  const key = phoneSearchDigits(row && row.phone_key)
  if (key) return key
  return phoneSearchDigits(row && row.phone)
}

// Substring match, so a partial number works. Exact-only matching made a
// patient unreachable unless the clerk retyped all 11 digits.
export function phoneMatches(row, query) {
  const q = phoneSearchDigits(query)
  if (!q) return true
  return recordPhoneDigits(row).includes(q)
}

// ---- query parsing ----------------------------------------------------------
// A search box entry is ONE of: a mobile number, a name, a patient ID or an MRN.
// Deciding which is the whole job — feeding '08031234567' into the surname
// matcher is what made "search by mobile" silently return nothing.
export function parseSearchTerm(raw) {
  const term = String(raw == null ? '' : raw).trim()
  if (!term) {
    return { term: '', text: '', surname: '', given_names: '', phoneDigits: '', isPhone: false }
  }

  const letters = term.replace(/[^a-z]/gi, '')
  const digits = term.replace(/\D/g, '')

  // Digits with no letters, long enough to be a mobile number. Patient IDs are
  // Firestore auto-IDs and MRNs are 'IMR-XXXXXX', both of which contain letters,
  // so this branch can never swallow an ID or an MRN search.
  if (!letters && digits.length >= MIN_PHONE_DIGITS) {
    const phoneDigits = phoneSearchDigits(digits)
    return { term, text: phoneDigits, surname: '', given_names: '', phoneDigits, isPhone: true }
  }

  const parts = term.split(/\s+/)
  return {
    term,
    text: term.toLowerCase(),
    surname: parts[0] || '',
    given_names: parts.slice(1).join(' '),
    phoneDigits: '',
    isPhone: false,
  }
}

function norm(v) {
  return String(v == null ? '' : v).trim().toLowerCase()
}

// Everything a free-text box can legitimately be matched against.
export function patientHaystack(row) {
  if (!row) return ''
  return [
    row.name, row.full_name, row.surname, row.given_names,
    row.pid, row.id, row.mrn,
    row.phone, row.phone_key,
    row.sex, row.dob,
  ].map(norm).join(' ')
}

// Text search: either the whole entry appears in the haystack, or it parses as
// surname [+ given names]. Each part is matched against BOTH name fields so
// 'ada' finds Ada Okoro whether she was filed under surname or given names.
function matchesText(row, parsed) {
  if (parsed.text && patientHaystack(row).includes(parsed.text)) return true
  const surname = norm(parsed.surname)
  if (!surname) return false
  const sn = norm(row.surname)
  const gn = norm(row.given_names)
  const full = (sn + ' ' + gn).trim()
  if (!sn.includes(surname) && !gn.includes(surname) && !full.includes(surname)) return false
  const given = norm(parsed.given_names)
  if (given && !gn.includes(given) && !full.includes(given) && !sn.includes(given)) return false
  return true
}

// The one matcher every view must use, so a result the service returned is
// never thrown away by a second, stricter filter in the UI.
export function matchesPatient(row, query) {
  const parsed = query && typeof query === 'object' && 'term' in query
    ? query
    : parseSearchTerm(query)
  if (!parsed.term) return true
  if (parsed.isPhone) return phoneMatches(row, parsed.phoneDigits)
  return matchesText(row, parsed)
}
