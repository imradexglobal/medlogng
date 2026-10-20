// Printable prescription script.
//
// Pure string builder (no DOM) so the consultation workspace, the patient chart
// and the admission workspace all print the same document, and so the markup can
// be read without a browser. It reuses the print classes the lab/imaging
// documents established, so one `@media print` block covers every sheet the app
// emits.
import { esc } from '../utils/sanitize.js'
import { fmtDateTime } from '../utils/format.js'
import { staffLabel } from './staffName.js'

function metaTable(rows) {
  return '<table class="p-meta">' + rows
    .filter((r) => r && r[1] !== '' && r[1] != null)
    .map((r) => '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>')
    .join('') + '</table>'
}

// The whole script, one row per medicine, so the pharmacist and the patient
// read the prescription in the order it was written.
function lineTable(items) {
  if (!items.length) return '<p>No medicines recorded on this prescription.</p>'
  return '<table class="p-tbl">' +
    '<tr><th>#</th><th>Medicine</th><th>Dosage</th><th>Qty</th><th>Instructions</th><th>Source</th></tr>' +
    items.map((l, i) => {
      const qty = l.quantity === '' || l.quantity == null ? '—' : l.quantity + (l.unit ? ' ' + l.unit : '')
      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td><strong>' + esc(l.medicine || '—') + '</strong></td>' +
        '<td>' + esc(l.dosage || '—') + '</td>' +
        '<td>' + esc(qty) + '</td>' +
        '<td>' + esc(l.instructions || '—') + '</td>' +
        '<td>' + (l.external ? 'External pharmacy' : 'Hospital pharmacy') + '</td>' +
        '</tr>'
    }).join('') + '</table>'
}

// o: { hospitalName, patientName, mrn, encounterId, scriptId, status,
//      items: [{ medicine, dosage, quantity, unit, instructions, external }],
//      prescribedBy, prescribedAt }
export function prescriptionHtml(o) {
  const items = (o.items || []).filter(Boolean)
  const externalOnly = items.length > 0 && items.every((l) => l.external)
  const meta = [
    ['Patient', o.patientName],
    ['MRN', o.mrn],
    ['Script no.', o.scriptId ? String(o.scriptId).slice(0, 8).toUpperCase() : ''],
    ['Encounter', o.encounterId ? String(o.encounterId).slice(0, 8) : ''],
    ['Status', o.status],
    ['Prescribed by', staffLabel(o.prescribedBy)],
    ['Date', fmtDateTime(o.prescribedAt)],
  ]
  return '' +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(o.hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Outpatient prescription</div>' +
      '</div>' +
      '<div class="p-doctitle">Prescription</div>' +
    '</div>' +
    metaTable(meta) +
    '<h4 class="p-h4">Medicines prescribed</h4>' +
    lineTable(items) +
    (externalOnly
      ? '<p class="p-note">Every medicine on this prescription is to be bought from an outside pharmacy.</p>'
      : '') +
    (items.some((l) => l.external)
      ? '<p class="p-note">Lines marked "External pharmacy" are not dispensed by the hospital pharmacy.</p>'
      : '') +
    '<div class="p-sign">' +
      '<div><div class="p-line"></div><div class="p-cap">Prescribed by (signature)</div></div>' +
      '<div><div class="p-line"></div><div class="p-cap">Dispensed by</div></div>' +
    '</div>' +
    '<div class="p-foot">Generated ' + esc(new Date().toLocaleString('en-GB')) + '</div>'
}
