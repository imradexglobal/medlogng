// Printable Laboratory & Imaging documents — international standard edition.
// Covers: Lab request slip, structured request slip, legacy lab report,
//         full LIMS lab report with per-item reference ranges, imaging request/report.
// Pure string builders (no DOM). Follows ISO 15189 and clinical document conventions.
import { esc } from '../utils/sanitize.js'
import { formatTestResult } from '../services/laboratoryService.js'
import { fmtDateTime } from '../utils/format.js'
import { staffLabel } from './staffName.js'

// ── Shared helpers ────────────────────────────────────────────────────────────

const CONFIDENTIAL = '<div class="p-confidential">CONFIDENTIAL — This document contains patient health information. Authorised personnel only. Unauthorised disclosure is a breach of patient confidentiality.</div>'

function metaTable(rows) {
  return '<table class="p-meta">' + rows
    .filter(Boolean)
    .map((r) => '<tr><td class="k">' + esc(r[0]) + '</td><td>' + esc(String(r[1] ?? '—')) + '</td></tr>')
    .join('') + '</table>'
}

function printedAt() {
  return esc(new Date().toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'medium' }))
}

function pageFooter(hospitalName, docType) {
  return '<div class="p-foot">' +
    esc(hospitalName || 'Hospital') + ' &nbsp;|&nbsp; ' + esc(docType) +
    ' &nbsp;|&nbsp; MediLog NG EMR &nbsp;|&nbsp; Printed ' + printedAt() +
    '</div>'
}

function shell({ hospitalName, docTitle, subtitle, metaRows, bodyHtml, signatures, watermark, footer }) {
  return CONFIDENTIAL +
    (watermark ? '<div class="p-watermark">' + esc(watermark) + '</div>' : '') +
    '<div class="p-head">' +
      '<div class="p-left">' +
        '<div class="p-hospital">' + esc(hospitalName || 'Hospital') + '</div>' +
        '<div class="p-sub">' + esc(subtitle || 'Laboratory Services') + '</div>' +
      '</div>' +
      '<div class="p-doctitle">' + esc(docTitle) + '</div>' +
    '</div>' +
    metaTable(metaRows) +
    bodyHtml +
    (signatures || '') +
    (footer || '') +
    pageFooter(hospitalName, docTitle)
}

function testList(tests) {
  const list = (tests && tests.length) ? tests : ['—']
  return '<ol class="p-list">' + list.map((t) => '<li>' + esc(t) + '</li>').join('') + '</ol>'
}

function pairList(items) {
  const list = (items && items.length) ? items : []
  if (!list.length) return ''
  return '<table class="p-tbl"><thead><tr><th>Modality</th><th>Study / body part</th></tr></thead><tbody>' +
    list.map((it) => '<tr><td>' + esc(it.modality || '—') + '</td><td>' + esc(it.study || '—') + '</td></tr>').join('') +
    '</tbody></table>'
}

const EXTERNAL_NOTE = 'This order is to be carried to an external facility. Please bring the printed report back to the hospital.'

function facilityRow(facility) {
  return facility === 'external' ? ['Facility', 'External facility'] : null
}

function resultRows(tests, result) {
  const list = (tests && tests.length) ? tests : ['Result']
  const map = (result && typeof result === 'object' && !Array.isArray(result)) ? result : null
  return '<table class="p-tbl"><thead><tr><th>Test</th><th>Result</th></tr></thead><tbody>' +
    list.map((t) => {
      const value = map ? (map[t] || '') : (list.length === 1 ? formatTestResult(result) : '')
      return '<tr><td>' + esc(t) + '</td><td>' + esc(value || '—') + '</td></tr>'
    }).join('') + '</tbody></table>'
}

function signatures(left) {
  return '<div class="p-sign">' +
    '<div><div class="p-line"></div><div class="p-cap">' + esc(left || 'Requested by') + '</div></div>' +
    '<div><div class="p-line"></div><div class="p-cap">Verified by</div></div>' +
    '</div>'
}

function refTextFor(ref) {
  if (!ref) return ''
  if (typeof ref === 'string') return ref
  if (ref.low != null && ref.high != null) return ref.low + ' – ' + ref.high
  if (ref.low != null) return '≥ ' + ref.low
  if (ref.high != null) return '≤ ' + ref.high
  return ''
}

function statusLabelFor(status) {
  const map = {
    ordered: 'not yet collected', sample_collected: 'awaiting receipt', received: 'processing in laboratory',
    result_entered: 'awaiting validation', validated: 'validated', rejected: 'rejected', cancelled: 'cancelled',
  }
  return map[status] || status || 'pending'
}

function itemResultTable(item) {
  const snap = item.snapshot || {}
  const components = Array.isArray(snap.components) ? snap.components : []
  const values = (item.result && item.result.values) || {}

  if (!components.length) {
    const text = formatTestResult(item.result)
    return text ? '<div class="p-res">' + esc(text) + '</div>' : ''
  }

  return '<table class="p-tbl p-res-tbl"><thead><tr>' +
    '<th>Component</th><th>Result</th><th>Unit</th><th>Reference</th><th style="width:36px;text-align:center">Flag</th>' +
    '</tr></thead><tbody>' +
    components.map((c) => {
      const v = values[c.id] || {}
      const val = v.value != null && v.value !== '' ? String(v.value) : '—'
      const unit = c.unit || ''
      const ref = v.ref_display || v.refText || refTextFor(v.ref)
      const flag = v.flag || ''
      const flagCls = flag === 'critical' ? 'crit' : (flag === 'H' ? 'high' : (flag === 'L' ? 'low' : ''))
      return '<tr>' +
        '<td><strong>' + esc(c.display_name || c.name || c.id) + '</strong>' +
        (v.remark ? '<div class="p-remark">' + esc(v.remark) + '</div>' : '') +
        '</td>' +
        '<td><strong>' + esc(val) + '</strong></td>' +
        '<td>' + esc(unit) + '</td>' +
        '<td>' + esc(ref) + '</td>' +
        '<td class="p-flag ' + flagCls + '">' + esc(flag) + '</td>' +
        '</tr>'
    }).join('') +
    '</tbody></table>'
}

function itemBlock(item) {
  const snap = item.snapshot || {}
  const status = item.status || ''
  const released = status === 'released'
  const header = '<div class="p-item-head">' +
    '<strong>' + esc(snap.name || item.test_name || 'Test') + '</strong>' +
    (snap.code ? ' <span class="p-code">[' + esc(snap.code) + ']</span>' : '') +
    (item.accession_no ? '<span class="p-acc">Accession ' + esc(item.accession_no) + '</span>' : '') +
    (snap.specimen_type ? '<span class="p-spec">Specimen: ' + esc(snap.specimen_type) + '</span>' : '') +
    '</div>'
  if (!released) {
    return header + '<p class="p-pending">Result ' + esc(statusLabelFor(status)) + ' — not released.</p>'
  }
  return header + itemResultTable(item)
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

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
    signatures: signatures('Verified by'),
  })
}

export function imagingRequestHtml(o) {
  const items = Array.isArray(o.items) ? o.items : []
  const studies = (Array.isArray(o.studies) && o.studies.length) ? o.studies : (items.length ? [] : (o.tests || []))
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
    subtitle: 'Request slip',
    metaRows: meta,
    bodyHtml:
      '<h4 class="p-h4">Studies requested</h4>' +
      (items.length > 0 ? pairList(items) : testList(studies)) +
      (o.facility === 'external' ? '<p class="p-note">' + esc(EXTERNAL_NOTE) + '</p>' : '') +
      ((o.indication || o.clinical_info || o.note) ? '<h4 class="p-h4">Clinical indication</h4><p>' + esc(o.indication || o.clinical_info || o.note) + '</p>' : ''),
    signatures: signatures('Requesting clinician'),
  })
}

export function imagingResultHtml(o) {
  const items = Array.isArray(o.items) ? o.items : []
  const studies = (Array.isArray(o.studies) && o.studies.length) ? o.studies : (items.length ? [] : (o.tests || []))
  const resultText = o.result || o.findings || ''
  const meta = [
    ['Patient', o.patientName],
    ['MRN', o.mrn],
    ['Order no.', String(o.orderId || '').slice(0, 8).toUpperCase()],
    ['Modality', o.modality || [...new Set(items.map((it) => it.modality).filter(Boolean))].join(', ')],
    ['Ordered by', staffLabel(o.orderedByName)],
    ['Ordered', fmtDateTime(o.orderedAt)],
    ['Verified by', staffLabel(o.verifiedBy || o.reportedBy)],
    ['Verified', fmtDateTime(o.verifiedAt || o.reportedAt)],
  ]
  return shell({
    hospitalName: o.hospitalName,
    docTitle: 'Imaging report',
    subtitle: 'Verified results',
    metaRows: meta,
    bodyHtml:
      (studies.length ? '<h4 class="p-h4">Studies</h4>' + testList(studies) : '') +
      '<h4 class="p-h4">Results / Findings</h4>' +
      '<div class="p-res">' + (resultText ? esc(resultText) : '<p>No report text entered.</p>') + '</div>' +
      (o.impression ? '<h4 class="p-h4">Impression</h4><p>' + esc(o.impression) + '</p>' : '') +
      '<div class="p-end-of-report">— END OF REPORT —</div>',
    signatures: signatures('Reported by'),
  })
}

export function labReportHtml(order, opts = {}) {
  if (!order) return ''
  const lab = opts.labSettings || {}
  const report = lab.report || {}
  const patient = opts.patient || {}
  const items = Array.isArray(order.items) ? order.items : []
  const released = items.filter((it) => it.status === 'released')
  const hasUnreleased = items.some((it) => it.status !== 'released' && it.status !== 'cancelled')
  const watermark = hasUnreleased ? 'PRELIMINARY' : null

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

  const bodyHtml =
    (hasUnreleased ? '<p class="p-note" style="font-weight:700">⚠ PRELIMINARY REPORT — One or more tests are pending validation and marked below.</p>' : '') +
    items.map((it) => itemBlock(it)).join('') +
    '<div class="p-end-of-report">— END OF REPORT —</div>'

  const signName = report.signatory_name || staffLabel(order.verifiedByName) || staffLabel(order.verifiedBy) || ''
  const signTitle = report.signatory_title || 'Verified by'
  const signaturesHtml = '<div class="p-sign">' +
    '<div><div class="p-line"></div><div class="p-cap">Requested by: ' + esc(staffLabel(order.orderedByName) || '') + '</div></div>' +
    '<div><div class="p-line"></div><div class="p-cap">' + esc(signTitle) + (signName ? ': ' + esc(signName) : '') + '</div></div>' +
    '</div>'

  return shell({
    hospitalName: report.lab_name || opts.hospitalName || 'Hospital',
    docTitle: 'Laboratory report',
    subtitle: [report.address, report.contact].filter(Boolean).join(' · '),
    metaRows: meta.filter(Boolean),
    bodyHtml: bodyHtml || '<p>No results on this order.</p>',
    signatures: signaturesHtml,
    watermark,
    footer: report.footer ? '<div class="p-note">' + esc(report.footer) + '</div>' : '',
  })
}

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
    '<table class="p-tbl"><thead><tr><th>Accession</th><th>Test</th><th>Code</th><th>Specimen</th></tr></thead><tbody>' +
    items.map((it) => '<tr>' +
      '<td>' + esc(it.accession_no || '—') + '</td>' +
      '<td>' + esc(it.test_name || '—') + '</td>' +
      '<td>' + esc(it.test_code || '') + '</td>' +
      '<td>' + esc(it.specimen_type || (it.snapshot && it.snapshot.specimen_type) || '—') + '</td>' +
      '</tr>').join('') +
    '</tbody></table>' +
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
