// Printable Laboratory / Imaging documents (request slip and signed-out report).
// Pure string builders so the same markup backs both Lab and Imaging and can be
// unit-tested without a DOM.
import { esc } from '../utils/sanitize.js'
import { formatTestResult } from '../services/laboratoryService.js'

function fmtDate(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

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

function testList(tests) {
  const list = (tests && tests.length) ? tests : ['—']
  return '<ol class="p-list">' + list.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ol>'
}

// One order can carry several modality + study pairs (e.g. chest X-ray and
// brain MRI). Render them as a two-column table when pairs are supplied, so the
// radiology team reads each request unambiguously.
function pairList(items) {
  const list = (items && items.length) ? items : []
  if (!list.length) return ''
  return '<table class="p-tbl"><tr><th>Modality</th><th>Study / body part</th></tr>' +
    list.map((it) => '<tr><td>' + esc(it.modality || '—') + '</td><td>' + esc(it.study || '—') + '</td></tr>').join('') +
    '</table>'
}

const EXTERNAL_NOTE = 'This order is to be carried to an external facility. Please bring the printed report back to the hospital.'

function facilityRow(facility) {
  return facility === 'external' ? ['Facility', 'External facility'] : null
}

function resultRows(tests, result) {
  const list = (tests && tests.length) ? tests : ['Result']
  const map = (result && typeof result === 'object' && !Array.isArray(result)) ? result : null
  return '<table class="p-tbl"><tr><th>Test</th><th>Result</th></tr>' +
    list.map((t) => {
      const value = map ? (map[t] || '') : (list.length === 1 ? formatTestResult(result) : '')
      return '<tr><td>' + esc(t) + '</td><td>' + esc(value || '—') + '</td></tr>'
    }).join('') + '</table>'
}

function signatures(left) {
  return '<div class="p-sign">' +
    '<div><div class="p-line"></div><div class="p-cap">' + esc(left || 'Requested by') + '</div></div>' +
    '<div><div class="p-line"></div><div class="p-cap">Verified by</div></div>' +
    '</div>'
}

export function labRequestHtml(o) {
  const meta = [
    ['Patient', o.patientName],
    ['MRN', o.mrn],
    ['Order no.', String(o.orderId || '').slice(0, 8).toUpperCase()],
    facilityRow(o.facility),
    ['Priority', o.priority || 'Routine'],
    ['Ordered by', o.orderedByName],
    ['Date', fmtDate(o.orderedAt)],
  ]
  return shell({
    hospitalName: o.hospitalName,
    docTitle: 'Laboratory request',
    subtitle: 'Request & specimen collection slip',
    metaRows: meta,
    bodyHtml:
      '<h4 class="p-h4">Tests requested</h4>' + testList(o.tests) +
      (o.facility === 'external' ? '<p class="p-note">' + esc(EXTERNAL_NOTE) + '</p>' : ''),
    signatures: signatures('Requesting clinician'),
  })
}

export function labResultHtml(o) {
  const meta = [
    ['Patient', o.patientName],
    ['MRN', o.mrn],
    ['Order no.', String(o.orderId || '').slice(0, 8).toUpperCase()],
    ['Ordered by', o.orderedByName],
    ['Ordered', fmtDate(o.orderedAt)],
    ['Verified by', o.verifiedBy],
    ['Verified', fmtDate(o.verifiedAt)],
  ]
  return shell({
    hospitalName: o.hospitalName,
    docTitle: 'Laboratory report',
    subtitle: 'Verified results',
    metaRows: meta,
    bodyHtml: '<h4 class="p-h4">Results</h4>' + resultRows(o.tests, o.result),
  })
}

export function imagingRequestHtml(o) {
  const items = Array.isArray(o.items) ? o.items : []
  const meta = [
    ['Patient', o.patientName],
    ['MRN', o.mrn],
    ['Order no.', String(o.orderId || '').slice(0, 8).toUpperCase()],
    ['Modality', o.modality || [...new Set(items.map((it) => it.modality).filter(Boolean))].join(', ')],
    facilityRow(o.facility),
    ['Priority', o.priority || 'Routine'],
    ['Ordered by', o.orderedByName],
    ['Date', fmtDate(o.orderedAt)],
  ]
  return shell({
    hospitalName: o.hospitalName,
    docTitle: 'Imaging request',
    subtitle: 'Radiology request slip',
    metaRows: meta,
    bodyHtml:
      '<h4 class="p-h4">Studies requested</h4>' +
      (items.length ? pairList(items) : testList(o.studies)) +
      (o.facility === 'external' ? '<p class="p-note">' + esc(EXTERNAL_NOTE) + '</p>' : '') +
      (o.indication ? '<h4 class="p-h4">Clinical indication</h4><p>' + esc(o.indication) + '</p>' : ''),
    signatures: signatures('Requesting clinician'),
  })
}

export function imagingResultHtml(o) {
  const items = Array.isArray(o.items) ? o.items : []
  const meta = [
    ['Patient', o.patientName],
    ['MRN', o.mrn],
    ['Order no.', String(o.orderId || '').slice(0, 8).toUpperCase()],
    ['Modality', o.modality || [...new Set(items.map((it) => it.modality).filter(Boolean))].join(', ')],
    facilityRow(o.facility),
    ['Ordered by', o.orderedByName],
    ['Ordered', fmtDate(o.orderedAt)],
    ['Verified by', o.verifiedBy],
  ]
  const report = formatTestResult(o.result) || 'No report text recorded.'
  return shell({
    hospitalName: o.hospitalName,
    docTitle: 'Imaging report',
    subtitle: 'Radiology report',
    metaRows: meta,
    bodyHtml:
      '<h4 class="p-h4">Studies</h4>' + (items.length ? pairList(items) : testList(o.studies)) +
      '<h4 class="p-h4">Findings / report</h4><p>' + esc(report) + '</p>',
  })
}
