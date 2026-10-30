// Printable prescription / medication order sheet — international standard edition.
// Pure string builder (no DOM). Reuses the print classes from labPrintTemplates.
// Notation follows international pharmacy conventions (Rp. prefix, signa format).
import { esc } from '../utils/sanitize.js'
import { fmtDateTime } from '../utils/format.js'
import { staffLabel } from './staffName.js'

const CONFIDENTIAL = '<div class="p-confidential">CONFIDENTIAL — This prescription is a legal medical document. Unauthorised reproduction or alteration is a criminal offence.</div>'

function metaTable(rows) {
  return '<table class="p-meta">' + rows
    .filter((r) => r && r[1] !== '' && r[1] != null)
    .map((r) => '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(String(r[1])) + '</td></tr>')
    .join('') + '</table>'
}

function printedAt() {
  return esc(new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'medium' }))
}

function pageFooter(hospitalName) {
  return '<div class="p-foot">' +
    esc(hospitalName || 'Hospital') + ' &nbsp;|&nbsp; Prescription &nbsp;|&nbsp; MediLog NG EMR &nbsp;|&nbsp; Printed ' + printedAt() +
    '</div>'
}

function signatureBlock(cols) {
  return '<div class="p-sign">' +
    cols.map((c) =>
      '<div>' +
      '<div class="p-line"></div>' +
      '<div class="p-cap">' + esc(c.label) + '</div>' +
      (c.name ? '<div class="p-cap-name">' + esc(c.name) + '</div>' : '') +
      '</div>'
    ).join('') +
    '</div>'
}

// Renders a single prescription line in international pharmacy notation.
// Format: Rp. [Generic name] (Brand) · Dosage · Route · Frequency · Duration · Qty
function lineTable(items) {
  if (!items.length) return '<p style="font-style:italic;color:#555">No medicines recorded on this prescription.</p>'

  return '<table class="p-tbl"><thead><tr>' +
    '<th style="width:26px">#</th>' +
    '<th>Medicine <span style="font-weight:400;font-size:9pt">(generic / brand)</span></th>' +
    '<th style="width:72px">Dose</th>' +
    '<th style="width:56px">Route</th>' +
    '<th style="width:72px">Frequency</th>' +
    '<th style="width:60px">Duration</th>' +
    '<th style="width:46px">Qty</th>' +
    '<th>Instructions / Sig.</th>' +
    '<th style="width:70px">Dispensed from</th>' +
    '</tr></thead><tbody>' +
    items.map((l, i) => {
      const qty = l.quantity === '' || l.quantity == null ? '—' : String(l.quantity) + (l.unit ? ' ' + l.unit : '')
      // Generic bold, brand in italics if both are available
      const nameParts = l.medicine ? l.medicine.split('/') : []
      const generic = nameParts[0] ? nameParts[0].trim() : (l.medicine || '—')
      const brand   = nameParts[1] ? nameParts[1].trim() : (l.brand || '')
      const nameHtml = '<strong>Rp. ' + esc(generic) + '</strong>' +
        (brand ? ' <em style="font-size:9.5pt;color:#555">(' + esc(brand) + ')</em>' : '')

      return '<tr>' +
        '<td>' + (i + 1) + '</td>' +
        '<td>' + nameHtml + '</td>' +
        '<td>' + esc(l.dosage || '—') + '</td>' +
        '<td>' + esc(l.route || 'oral') + '</td>' +
        '<td>' + esc(l.frequency || l.instructions || '—') + '</td>' +
        '<td>' + esc(l.duration || '—') + '</td>' +
        '<td>' + esc(qty) + '</td>' +
        '<td>' + esc(l.sig || l.instructions || '—') + '</td>' +
        '<td>' + (l.external ? 'External pharmacy' : 'Hospital pharmacy') + '</td>' +
        '</tr>'
    }).join('') +
    '</tbody></table>'
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * Printable prescription sheet.
 *
 * o: { hospitalName, patientName, mrn, encounterId, scriptId, status,
 *      items: [{ medicine, brand?, dosage, route?, frequency?, duration?,
 *               quantity, unit, instructions, sig?, external }],
 *      prescribedBy, prescribedAt,
 *      allowSubstitution? }
 */
export function prescriptionHtml(o) {
  const items        = (o.items || []).filter(Boolean)
  const externalOnly = items.length > 0 && items.every((l) => l.external)
  const hasExternal  = items.some((l) => l.external)
  const allowSub     = o.allowSubstitution !== false  // default: substitution permitted

  const meta = [
    ['Patient Name',   o.patientName],
    ['MRN / File No.', o.mrn],
    ['Script No.',     o.scriptId ? String(o.scriptId).slice(0, 10).toUpperCase() : '—'],
    ['Encounter Ref.', o.encounterId ? String(o.encounterId).slice(0, 10) : '—'],
    ['Status',         o.status || 'Active'],
    ['Prescribed by',  staffLabel(o.prescribedBy)],
    ['Date & Time',    fmtDateTime(o.prescribedAt)],
    ['Dispensed by',   ''],  // blank — filled in by pharmacist
    ['Date Dispensed', ''],
  ]

  return CONFIDENTIAL +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(o.hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">Outpatient / Inpatient Prescription</div>' +
      '</div>' +
      '<div class="p-doctitle">PRESCRIPTION</div>' +
    '</div>' +
    metaTable(meta) +

    // Validity & caution box
    '<div class="p-caution">' +
      '<strong>⚠ VALIDITY NOTICE:</strong> This prescription is valid for <strong>30 days</strong> from the date of issue. ' +
      'Prescriptions presented after expiry will not be dispensed without re-assessment by the prescribing clinician.' +
    '</div>' +

    '<h4 class="p-h4">Medicines Prescribed (' + items.length + ' item' + (items.length !== 1 ? 's' : '') + ')</h4>' +
    lineTable(items) +

    // Substitution / dispensing notes
    '<div style="display:flex;gap:18px;margin:10px 0;font-size:9.5pt">' +
      '<div style="border:1.5px solid #1a3a5c;padding:6px 12px;border-radius:3px">' +
        (allowSub
          ? '☑ <strong>SUBSTITUTION PERMITTED</strong> — Generic equivalent acceptable'
          : '☐ <strong>DISPENSE AS WRITTEN</strong> — No substitution') +
      '</div>' +
      '<div style="border:1.5px solid #1a3a5c;padding:6px 12px;border-radius:3px">' +
        '☐ <strong>DISPENSE AS WRITTEN</strong>' +
      '</div>' +
    '</div>' +

    // Notes for external items
    (externalOnly
      ? '<div class="p-note">All medicines on this prescription are to be obtained from an outside pharmacy.</div>'
      : '') +
    (hasExternal && !externalOnly
      ? '<div class="p-note">Lines marked "External pharmacy" are not stocked or dispensed by the hospital pharmacy — patient must procure independently.</div>'
      : '') +

    signatureBlock([
      { label: 'Prescribing Clinician (signature & stamp)', name: staffLabel(o.prescribedBy) },
      { label: 'Dispensed by (Pharmacist / signature)' },
      { label: 'Received by (Patient / Representative)' },
    ]) +
    pageFooter(o.hospitalName)
}
