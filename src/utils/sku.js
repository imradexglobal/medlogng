// SKU generation, validation, and fuzzy drug-name matching.
//
// SKU format: DRUGCODE-STRENGTH-PACKSIZE  (e.g. PCM-500MG-10)
// Drug code: 3–6 alphanumeric characters, uppercase.
// Strength:  free text (e.g. "500mg", "250mg/5ml").
// Pack size: positive integer.

// ---- drug code validation ---------------------------------------------------
export function validateDrugCode(code) {
  const t = (code || '').trim().toUpperCase()
  if (t.length < 3 || t.length > 6) return false
  return /^[A-Z0-9]+$/.test(t)
}

export function drugCodeError(code) {
  const t = (code || '').trim()
  if (!t) return 'Drug code is required.'
  if (t.length < 3) return 'Drug code must be at least 3 characters.'
  if (t.length > 6) return 'Drug code must be at most 6 characters.'
  if (!/^[A-Za-z0-9]+$/.test(t)) return 'Drug code must be alphanumeric (letters and digits only).'
  return null
}

// ---- strength / pack size validation ----------------------------------------
export function strengthError(s) {
  const t = (s || '').trim()
  if (!t) return 'Strength is required.'
  if (t.length > 40) return 'Strength is too long.'
  return null
}

export function packSizeError(p) {
  const t = (p || '').trim()
  if (!t) return 'Pack size is required.'
  if (!/^\d+$/.test(t)) return 'Pack size must be a positive whole number.'
  if (Number(t) <= 0) return 'Pack size must be greater than zero.'
  return null
}

// ---- SKU generation ---------------------------------------------------------
export function generateSku(drugCode, strength, packSize) {
  const code = (drugCode || '').trim().toUpperCase()
  const str = (strength || '').trim().toUpperCase()
  const pack = (packSize || '').trim()
  if (!code || !str || !pack) return ''
  return code + '-' + str + '-' + pack
}

// ---- fuzzy name matching (Levenshtein) ---------------------------------------
function levenshtein(a, b) {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  const curr = new Array(b.length + 1)

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(
        curr[j - 1] + 1,   // insertion
        prev[j] + 1,       // deletion
        prev[j - 1] + cost // substitution
      )
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]
  }
  return prev[b.length]
}

// Returns a 0–1 similarity score. 1 = identical, 0 = completely different.
export function nameSimilarity(a, b) {
  const s = (a || '').trim().toLowerCase()
  const t = (b || '').trim().toLowerCase()
  if (!s || !t) return 0
  if (s === t) return 1
  const dist = levenshtein(s, t)
  const maxLen = Math.max(s.length, t.length)
  return maxLen === 0 ? 1 : 1 - dist / maxLen
}

// Similarity threshold: names at or above this score are flagged as "similar".
export const SIMILARITY_THRESHOLD = 0.8

// Returns true when two names are similar enough to warrant a typo warning
// but are not identical.
export function isSimilarName(a, b) {
  const s = (a || '').trim().toLowerCase()
  const t = (b || '').trim().toLowerCase()
  if (!s || !t) return false
  if (s === t) return false // exact matches are handled separately (hard reject)
  return nameSimilarity(a, b) >= SIMILARITY_THRESHOLD
}

// ---- exact match (case-insensitive) -------------------------------------------
export function isExactNameMatch(a, b) {
  return (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase()
}
