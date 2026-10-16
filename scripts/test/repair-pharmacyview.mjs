// One-off repair for src/views/PharmacyView.js.
//
// A PowerShell Set-Content round-trip read the file's UTF-8 bytes as Windows-1252
// and wrote them back as UTF-8, corrupting every multi-byte character. Two-byte
// sequences (the middle dot) survived a later latin1 reversal; the three-byte
// ones did not and are now U+FFFD. This restores each damaged line from its
// surrounding ASCII, which is intact.
import fs from 'node:fs'

const P = 'src/views/PharmacyView.js'
const EM = '\u2014'   // —
const ARR = '\u2192'  // →
const DOT = '\u00B7'  // ·
const NAIRA = '\u20A6' // ₦
const REFRESH = '\u21BB' // ↻
const MINUS = '\u2212'  // −
const NEQ = '\u2260'    // ≠
const TIMES = '\u00D7'  // ×
const EN = '\u2013'     // –
const ELL = '\u2026'    // …

// line number (1-based) -> the corrected text
const FIX = {
  1: '// Pharmacy with Firestore persistence (offline-first, cached).',
  32: "      body: '<div class=\"card\"><p class=\"sub\">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class=\"btn\" href=\"#/admin\">Open Administration " + ARR + '</a></div>\',',
  43: '  // without switching tabs ' + EM + ' the old four tiles counted catalogue, not demand.',
  51: "      '<button class=\"btn ghost\" id=\"refreshBtn\">" + REFRESH + ' Refresh</button>\' +',
  52: "      (caps.canDispense ? '<button class=\"btn\" id=\"dispenseBtn\">Dispense " + ARR + "</button>' : '') +",
  60: "      '<div class=\"stat\"><em>Stock value</em><strong id=\"ph-value\">" + NAIRA + "0</strong><span>at catalogue price</span></div></div>' +",
  88: '    // This tile used to be a "Balance (collected ' + MINUS + ' given out)" that no code',
  89: '    // ever wrote, so it was pinned at 0. Pharmacy records no money ' + EM + ' a',
  94: "    set('ph-value', '" + NAIRA + "' + stockValue.toLocaleString('en-NG', { maximumFractionDigits: 0 }))",
  116: "      return '<tr><td><strong>' + esc(r.patientName || '" + EM + "') + '</strong>' +",
  123: "        '<td>' + (r.total ? esc(r.dispensed) + ' / ' + esc(r.total) : '" + EM + "') + '</td>' +",
  126: "          ? '<button class=\"btn sm\" data-open-request=\"' + esc(r.id) + '\">Open " + ARR + "</button>'",
  127: "          : '<span class=\"mut\">" + EM + "</span>') + '</td></tr>'",
  164: "        '<td>' + esc(l.dosage || '" + EM + "') + '</td>' +",
  176: "    openModal('Prescription " + EM + " ' + (req.patientName || 'patient'),",
  181: "      '<button class=\"btn\" id=\"reqDispense\">Dispense selected lines " + ARR + "</button></div>')",
  214: "          : 'Issued ' + issued.reduce((n, i) => n + i.requestedQty, 0) + ' unit(s) " + EM + " ' +",
  230: "      '<td>' + esc(d.expiry || '" + EM + "') + '</td>' +",
  231: "      '<td>" + NAIRA + "' + esc(String(d.price)) + '</td>' +",
  239: "      '<p class=\"sub\" style=\"margin-top:10px\">Prescribe " + NEQ + " Dispense " + EM + " prescriptions queue on the Receive tab for a pharmacist to issue.</p>'",
  251: "      if (!raw) return '" + EM + "'",
  255: "        return parsed.map((it) => it.qty + ' " + TIMES + " ' + (it.name || it.sku || 'item')).join(', ')",
  262: "      '<td>' + esc(d.patientName || '" + EM + "') + '</td>' +",
  264: "      '<td class=\"mut\">' + esc(d.by || '" + EM + "') + '</td>' +",
  280: "      '<td>' + esc(d.expiry || '" + EM + "') + '</td><td>' + statusBadge(d.status) + '</td></tr>'",
  289: '// button and the Receive tab ' + EM + ' previously that button rendered for anyone who',
  297: "      toast('Add a catalogue item first " + EM + " stock is received against an item.')",
  303: "      submitLabel: 'Receive stock " + ARR + "',",
  327: "        toast('Received ' + qty + ' " + TIMES + " ' + (drug?.name || 'item') + ' " + EM + " on hand now ' + res.newStock)",
  337: "      title: 'Adjust stock " + EM + " ' + drug.name,",
  341: "        { name: 'price', label: 'Price " + NAIRA + "', placeholder: String(drug.price || 0) },",
  392: '    // stale responses ' + EM + ' only the latest sequence writes to the DOM.',
  401: '        if (seq !== nameCheckSeq) return // stale ' + EM + ' user kept typing',
  406: '          setHint(\'warn\', \'Similar to "\' + similar[0].name + \'"\' + (similar.length > 1 ? \' (and \' + (similar.length - 1) + \' more)\' : \'\') + \'' + EM + ' double-check the spelling.\')',
  408: "          setHint('ok', 'No match found " + EM + " this name is free.')",
  419: "      submitLabel: 'Save item " + ARR + "',",
  422: "        { name: 'drug_code', label: 'Drug code', required: true, placeholder: 'PCM (3" + EN + "6 chars)' },",
  430: "        { name: 'price', label: 'Price " + NAIRA + "', placeholder: '1800' },",
  458: '        // --- name uniqueness check (authoritative ' + EM + ' runs regardless of live hint) ---',
  497: '    // Immediate check on blur (tab/click away) ' + EM + " don't wait for the debounce.",
}

const lines = fs.readFileSync(P, 'utf8').split(/\r?\n/)
let fixed = 0
for (const [n, text] of Object.entries(FIX)) {
  const i = Number(n) - 1
  if (lines[i] === text) continue
  if (!lines[i] || !lines[i].includes('\uFFFD')) {
    console.error('SKIP line ' + n + ' - no replacement char found: ' + JSON.stringify(lines[i] || ''))
    continue
  }
  lines[i] = text
  fixed++
}
fs.writeFileSync(P, lines.join('\n'))
console.log('repaired ' + fixed + ' lines')

const after = fs.readFileSync(P, 'utf8')
const bad = after.split(/\r?\n/).filter((l) => l.includes('\uFFFD'))
console.log('lines still corrupted: ' + bad.length)
for (const b of bad) console.log('  ' + b.trim().slice(0, 90))
// Also flag any remaining control characters, which are the other half of the damage.
const ctrl = after.split(/\r?\n/).map((l, i) => [i + 1, l]).filter(([, l]) => /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(l))
console.log('lines with stray control chars: ' + ctrl.length)
for (const [n, l] of ctrl) console.log('  ' + n + ': ' + l.trim().slice(0, 90))