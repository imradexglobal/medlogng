// Printable Laboratory / Imaging documents (request slip and signed-out report).
// Pure string builders so the same markup backs both Lab and Imaging and can be
// unit-tested without a DOM.
import { esc } from '../utils/sanitize.js'
import { formatTestResult } from '../services/laboratoryService.js'
import { fmtDateTime } from '../utils/format.js'
import { staffLabel } from './staffName.js'

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
    ['Ordered by', staffLabel(o.orderedByName)],
    ['Date', fmtDateTime(o.orderedAt)],
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
    ['Ordered by', staffLabel(o.orderedByName)],
    ['Ordered', fmtDateTime(o.orderedAt)],
    ['Verified by', staffLabel(o.verifiedBy)],
    ['Verified', fmtDateTime(o.verifiedAt)],
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
    ['Ordered by', staffLabel(o.orderedByName)],
    ['Date', fmtDateTime(o.orderedAt)],
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
    ['Ordered by', staffLabel(o.orderedByName)],
    ['Ordered', fmtDateTime(o.orderedAt)],
    ['Verified by', staffLabel(o.verifiedBy)],
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

// ---- structured multi-test LIMS report (A4) ---------------------------------
// Renders every ordered test from its FROZEN configuration snapshot: one
// analyte table per test with result / unit / reference range / L-H flag, a
// specimen + accession block, and the laboratory's configured signatory.
// `labSettings` and `patient` are optional; nothing clinical is invented —
// empty reference cells stay empty.

function flagCell(flag) {
  if (flag === 'L') return '<td class="p-flag">L</td>'
  if (flag === 'H') return '<td class="p-flag">H</td>'
  return '<td class="p-flag"></td>'
}

function refText(comp, ref) {
  if (!comp) return ''
  const r = ref || {}
  if (r.text) return String(r.text)
  if (r.low != null && r.high != null) return r.low + ' – ' + r.high
  if (r.low != null) return '≥ ' + r.low
  if (r.high != null) return '≤ ' + r.high
  if (comp.ref_text) return String(comp.ref_text)
  return ''
}

function itemResultTable(item) {
  const snap = item.snapshot
  const comps = (snap && snap.components) || []
  const values = (item.result && item.result.values) || {}
  // Legacy / free-text results have no component grid — one Results line.
  if (!comps.length || item.result?.legacy_text) {
    const text = item.result?.legacy_text || ''
    return '<p class="p-res">' + esc(text || '—') + '</p>'
  }
  return '<table class="p-tbl p-res-tbl">' +
    '<tr><th>Investigation</th><th>Result</th><th>Unit</th><th>Reference</th><th></th></tr>' +
    comps.map((c) => {
      const v = values[c.id] || {}
      const val = v.value == null || v.value === '' ? '—' : String(v.value)
      const remark = v.remark ? '<div class="p-remark">' + esc(v.remark) + '</div>' : ''
      const ref = refText(c, v.ref)
      return '<tr>' +
        '<td>' + esc(c.display_name || c.name) + remark + '</td>' +
        '<td><strong>' + esc(val) + '</strong></td>' +
        '<td>' + esc(c.unit || '') + '</td>' +
        '<td>' + esc(ref) + '</td>' +
        flagCell(v.flag || '') +
        '</tr>'
    }).join('') + '</table>'
}

function statusLabelFor(status) {
  const map = {
    ordered: 'not yet collected', sample_collected: 'awaiting receipt', received: 'processing',
    result_entered: 'awaiting validation', validated: 'validated', rejected: 'rejected', cancelled: 'cancelled',
  }
  return map[status] || status || 'pending'
}

function itemBlock(item) {
  const snap = item.snapshot || {}
  const status = item.status || ''
  const released = status === 'released'
  const header = '<div class="p-item-head">' +
    '<strong>' + esc(snap.name || item.test_name || 'Test') + '</strong>' +
    (snap.code ? ' <span class="p-code">' + esc(snap.code) + '</span>' : '') +
    (item.accession_no ? '<span class="p-acc">Accession ' + esc(item.accession_no) + '</span>' : '') +
    (snap.specimen_type ? '<span class="p-spec">Specimen: ' + esc(snap.specimen_type) + '</span>' : '') +
    '</div>'
  if (!released) {
    return header + '<p class="p-pending">Result ' + esc(statusLabelFor(status)) + ' — not released.</p>'
  }
  return header + itemResultTable(item)
}

export function labReportHtml(order, opts = {}) {
  if (!order) return ''
  const lab = opts.labSettings || {}
  const report = lab.report || {}
  const patient = opts.patient || {}
  const items = Array.isArray(order.items) ? order.items : []
  const released = items.filter((it) => it.status === 'released')

  const meta = [
    ['Patient', order.patientName || patient.name || '—'],
    ['MRN', patient.mrn || ''],
    ['Order no.', order.orderNo || String(order.id || '').slice(0, 8).toUpperCase()],
    ['Accession(s)', items.map((it) => it.accession_no).filter(Boolean).join(', ')],
    ['Priority', order.priority || 'Routine'],
    ['Ordered by', staffLabel(order.orderedByName)],
    ['Ordered', fmtDateTime(order.orderedAt)],
    (released.length && order.verifiedAt) ? ['Released', fmtDateTime(order.verifiedAt)] : null,
  ]

  // Every ordered test appears; unreleased ones are explicitly marked pending
  // so a partial print can never be mistaken for a complete report.
  const bodyHtml = items.map((it) => itemBlock(it)).join('')

  const signName = report.signatory_name || staffLabel(order.verifiedByName) || staffLabel(order.verifiedBy) || ''
  const signTitle = report.signatory_title || 'Verified by'
  const signatures = '<div class="p-sign">' +
    '<div><div class="p-line"></div><div class="p-cap">Requested by: ' + esc(staffLabel(order.orderedByName) || '') + '</div></div>' +
    '<div><div class="p-line"></div><div class="p-cap">' + esc(signTitle) + ': ' + esc(signName) + '</div></div>' +
    '</div>'

  return shell({
    hospitalName: report.lab_name || opts.hospitalName || 'Hospital',
    docTitle: 'Laboratory report',
    subtitle: [report.address, report.contact].filter(Boolean).join(' · '),
    metaRows: meta.filter(Boolean),
    bodyHtml: bodyHtml || '<p>No results on this order.</p>',
    signatures,
  }) + (report.footer ? '<div class="p-note">' + esc(report.footer) + '</div>' : '')
}

// Structured request slip for the new order flow: lists each test with its
// frozen code + specimen so the bench knows what to collect.
export function labRequestStructuredHtml(order, opts = {}) {
  if (!order) return ''
  const lab = opts.labSettings || {}
  const report = lab.report || {}
  const patient = opts.patient || {}
  const items = Array.isArray(order.items) ? order.items : []
  const meta = [
    ['Patient', order.patientName || patient.name || '—'],
    ['MRN', patient.mrn || ''],
    ['Order no.', order.orderNo || String(order.id || '').slice(0, 8).toUpperCase()],
    ['Priority', order.priority || 'Routine'],
    ['Ordered by', staffLabel(order.orderedByName)],
    ['Date', fmtDateTime(order.orderedAt)],
    order.facility === 'external' ? ['Facility', 'External facility'] : null,
  ]
  const bodyHtml =
    '<table class="p-tbl">' +
    '<tr><th>Accession</th><th>Test</th><th>Code</th><th>Specimen</th></tr>' +
    items.map((it) => '<tr>' +
      '<td>' + esc(it.accession_no || '—') + '</td>' +
      '<td>' + esc(it.test_name || '—') + '</td>' +
      '<td>' + esc(it.test_code || '') + '</td>' +
      '<td>' + esc(it.specimen_type || (it.snapshot && it.snapshot.specimen_type) || '—') + '</td>' +
      '</tr>').join('') +
    '</table>' +
    (order.facility === 'external' ? '<p class="p-note">' + esc(EXTERNAL_NOTE) + '</p>' : '') +
    (order.note ? '<h4 class="p-h4">Clinical note</h4><p>' + esc(order.note) + '</p>' : '')

  return shell({
    hospitalName: report.lab_name || opts.hospitalName || 'Hospital',
    docTitle: 'Laboratory request',
    subtitle: 'Request & specimen collection slip',
    metaRows: meta.filter(Boolean),
    bodyHtml,
    signatures: signatures('Requesting clinician'),
  })
}
