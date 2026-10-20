// Printable discharge summary document.
// Pure string builder, unit-testable without a DOM.
import { esc } from '../utils/sanitize.js'
import { fmtDateTime } from '../utils/format.js'

function metaTable(rows) {
  return '<table class="p-meta">' + rows
    .filter(Boolean)
    .map((r) => '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td></tr>')
    .join('') + '</table>'
}

function shell({ hospitalName, docTitle, subtitle, metaRows, bodyHtml, signatures }) {
  return '' +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">' + esc(subtitle || '') + '</div>' +
      '</div>' +
      '<div class="p-doctitle">' + esc(docTitle) + '</div>' +
    '</div>' +
    metaTable(metaRows) +
    bodyHtml +
    (signatures || '') +
    '<div class="p-foot">Generated ' + esc(new Date().toLocaleString('en-GB')) + '</div>'
}

export function dischargeSummaryHtml(o) {
  const meta = [
    ['Patient', o.patientName],
    ['MRN', o.mrn],
    ['Ward · Bed', o.ward + ' · ' + o.bed],
    ['Admission type', o.admissionType],
['Admitted', fmtDateTime(o.admittedAt)],
  ['Discharged', fmtDateTime(o.dischargedAt)],
    ['Discharge type', o.dischargeType.charAt(0).toUpperCase() + o.dischargeType.slice(1)],
    ['Attending provider', o.attendingProvider],
  ]
  return shell({
    hospitalName: o.hospitalName,
    docTitle: 'Discharge summary',
    subtitle: 'Discharge summary — ' + esc(o.patientName || 'Patient'),
    metaRows: meta,
    bodyHtml:
      '<h4 class="p-h4">Discharge reason</h4><p>' + esc(o.dischargeReason || '—') + '</p>' +
      (o.dischargeNotes ? '<h4 class="p-h4">Discharge notes</h4><p>' + esc(o.dischargeNotes) + '</p>' : '') +
      '<h4 class="p-h4">Advice on discharge</h4><p>Follow up with your attending physician as scheduled. Return immediately if symptoms worsen.</p>',
    signatures: '<div class="p-sign">' +
      '<div><div class="p-line"></div><div class="p-cap">Discharging clinician</div></div>' +
      '<div><div class="p-line"></div><div class="p-cap">Received by (patient / relative)</div></div>' +
      '</div>',
  })
}
