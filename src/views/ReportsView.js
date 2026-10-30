// Reports — full reporting platform for MediLog NG.
// Replaces the dashboard-style summary page with real, exportable reports:
// Overview, Financial (revenue/receivables/payment-methods/monthly trends),
// Patients, Appointments, Consultations, Laboratory, Pharmacy, Admissions.
// All data is read directly from Firestore, scoped to the active hospital,
// filtered by the selected date range, and exportable to CSV or printable.
import { shell, toast, wireToast } from '../components/shell.js'
import { printDocument } from '../lib/print.js'
import { authStore } from '../store/authStore.js'
import { esc } from '../utils/sanitize.js'
import { fmtDate } from '../utils/format.js'

import { listOrgPatientsPage } from '../services/patientService.js'
import { listOrgAppointmentsPage } from '../services/appointmentService.js'
import { listOrgEncountersPage } from '../services/consultationService.js'
import { listOrgAdmissionsPage } from '../services/admissionService.js'
import { listOrgLabsPage } from '../services/laboratoryService.js'
import { listOrgDrugsPage } from '../services/pharmacyService.js'
import { listOrgDispense } from '../services/pharmacyService.js'
import { listOrgInvoicesPage } from '../services/billingService.js'
import { listOrgPayments } from '../services/billingService.js'
import { billingSummary } from '../services/billingSummary.js'
import { countOrgDocs } from '../services/pagination.js'

const CAP = 400

function naira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG')
}

function msOf(dateStr) {
  if (!dateStr) return null
  return new Date(dateStr + 'T00:00:00').getTime()
}

function inRange(ms, startMs, endMs) {
  if (!ms) return true
  if (startMs != null && ms < startMs) return false
  if (endMs != null && ms > endMs) return false
  return true
}

function csvEscape(v) {
  const s = String(v == null ? '' : v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function exportCsv(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(',')]
  rows.forEach((r) => lines.push(r.map(csvEscape).join(',')))
  const csv = lines.join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  toast('Exported ' + filename)
}

function moneyCell(n) {
  return naira(n)
}

function statusPill(s) {
  const map = {
    Paid: 'ok', Dispensed: 'ok', Verified: 'ok', Completed: 'ok', Active: 'ok', 'Checked-in': 'ok',
    'Part-paid': 'warn', Pending: 'warn', Ready: 'warn', Waiting: 'warn', Low: 'warn',
    'no-show': 'warn', cancelled: 'bad', Unpaid: 'bad', Out: 'bad', Overdue: 'bad',
    Scheduled: '', Open: '', Verified: 'ok',
  }
  const cls = map[s] || ''
  return '<span class="pill ' + cls + '">' + esc(String(s)) + '</span>'
}

// ---- data loading -----------------------------------------------------------

async function loadAllData(orgId, startMs, endMs) {
  const [
    counts,
    patients, appointments, encounters, admissions, labs, drugs, invoices,
  ] = await Promise.all([
    (async () => {
      const [cPat, cApt, cEnc, cAdm, cLab, cDrug, cInv] = await Promise.all([
        countOrgDocs('organization_patients', orgId).catch(() => null),
        countOrgDocs('appointments', orgId).catch(() => null),
        countOrgDocs('encounters', orgId).catch(() => null),
        countOrgDocs('admissions', orgId).catch(() => null),
        countOrgDocs('lab_orders', orgId).catch(() => null),
        countOrgDocs('stock_lots', orgId).catch(() => null),
        countOrgDocs('invoices', orgId).catch(() => null),
      ])
      return { patients: cPat, appointments: cApt, encounters: cEnc, admissions: cAdm, labs: cLab, drugs: cDrug, invoices: cInv }
    })(),
    listOrgPatientsPage(orgId, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
    listOrgAppointmentsPage(orgId, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
    listOrgEncountersPage(orgId, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
    listOrgAdmissionsPage(orgId, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
    listOrgLabsPage(orgId, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
    listOrgDrugsPage(orgId, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
    listOrgInvoicesPage(orgId, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
  ])

  const payments = await listOrgPayments(orgId).catch(() => [])

  const p = patients.filter((x) => inRange(x.registered, startMs, endMs))
  const a = appointments.filter((x) => inRange(x.createdAt, startMs, endMs))
  const e = encounters.filter((x) => inRange(x.createdAt, startMs, endMs))
  const ad = admissions.filter((x) => inRange(x.createdAt || x.admissionDate, startMs, endMs))
  const l = labs.filter((x) => inRange(x.orderedAt || x.createdAt, startMs, endMs))
  const d = drugs.filter((x) => inRange(x.createdAt, startMs, endMs))
  const i = invoices.filter((x) => inRange(x.createdAt, startMs, endMs))
  const pay = payments.filter((x) => inRange(
    x.paid_at ? (typeof x.paid_at.toMillis === 'function' ? x.paid_at.toMillis() : x.paid_at) : 0,
    startMs, endMs))

  return { counts, patients: p, appointments: a, encounters: e, admissions: ad, labs: l, drugs: d, invoices: i, payments: pay }
}

// ---- report renderers -------------------------------------------------------

function renderOverview(data) {
  const { patients, appointments, encounters, admissions, labs, drugs, invoices, payments, counts } = data
  const s = billingSummary(invoices)
  const totalReceivable = s.outstanding
  const totalCollected = s.collected
  const totalBilled = s.billed
  const dispensedCount = drugs.filter((x) => x.status === 'Dispensed' || x.stock === 0).length
  const lowStock = drugs.filter((x) => x.stock > 0 && x.stock < 20).length
  const outStock = drugs.filter((x) => x.stock === 0).length

  const activeAdm = admissions.filter((x) => x.status === 'active').length
  const dischargedAdm = admissions.filter((x) => x.status === 'discharged').length
  const verifiedLabs = labs.filter((x) => x.status === 'verified').length
  const pendingLabs = labs.filter((x) => x.status === 'order' || x.status === 'pending').length

  const payerMix = {}
  patients.forEach((p) => { const k = p.payer || 'Self-pay'; payerMix[k] = (payerMix[k] || 0) + 1 })
  const payerRows = Object.entries(payerMix).map(([k, v]) => [k, v])

  const html =
    '<div class="toolbar" style="margin-bottom:4px">' +
    '<button class="btn" id="rep-print-overview">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-overview">Export CSV</button>' +
    '</div>' +
    '<div class="grid4">' +
    '<div class="stat"><em>Patients registered</em><strong>' + patients.length + '</strong><span>exact: ' + (counts.patients ?? '—') + '</span></div>' +
    '<div class="stat"><em>Appointments</em><strong>' + appointments.length + '</strong><span>exact: ' + (counts.appointments ?? '—') + '</span></div>' +
    '<div class="stat"><em>Consultations</em><strong>' + encounters.length + '</strong><span>open: ' + encounters.filter((x) => x.status !== 'closed').length + '</span></div>' +
    '<div class="stat"><em>Admissions (active)</em><strong>' + activeAdm + '</strong><span>discharged: ' + dischargedAdm + '</span></div>' +
    '<div class="stat"><em>Lab orders</em><strong>' + labs.length + '</strong><span>verified: ' + verifiedLabs + ' · pending: ' + pendingLabs + '</span></div>' +
    '<div class="stat"><em>Pharmacy SKUs</em><strong>' + drugs.length + '</strong><span>low: ' + lowStock + ' · out: ' + outStock + '</span></div>' +
    '<div class="stat"><em>Billed</em><strong>' + naira(totalBilled) + '</strong><span>invoices: ' + invoices.length + '</span></div>' +
    '<div class="stat"><em>Collected</em><strong>' + naira(totalCollected) + '</strong><span>outstanding: ' + naira(totalReceivable) + '</span></div>' +
    '</div>' +

    '<div class="card"><div class="card-head"><h3>Payer mix (registrations)</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Payer</th><th>Patients</th><th>Share</th></tr></thead><tbody>' +
    payerRows.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, patients.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Revenue snapshot</h3></div>' +
    '<div class="grid4">' +
    '<div class="stat"><em>Total billed</em><strong>' + naira(totalBilled) + '</strong><span>' + invoices.length + ' invoice(s)</span></div>' +
    '<div class="stat"><em>Total collected</em><strong>' + naira(totalCollected) + '</strong><span>' + Math.round(s.rate) + '% collection rate</span></div>' +
    '<div class="stat"><em>Outstanding receivables</em><strong>' + naira(totalReceivable) + '</strong><span>' + s.open + ' unpaid/part-paid</span></div>' +
    '<div class="stat"><em>Payments recorded</em><strong>' + naira(payments.reduce((t, x) => t + (Number(x.amount_kobo || 0) / 100), 0)) + '</strong><span>' + payments.length + ' payment(s)</span></div>' +
    '</div></div>'

  return html
}

function renderFinancial(data) {
  const { invoices, payments } = data
  const s = billingSummary(invoices)

  // Revenue by payer
  const byPayer = {}
  invoices.forEach((inv) => {
    const k = inv.payer || 'Self-pay'
    if (!byPayer[k]) byPayer[k] = { billed: 0, paid: 0, count: 0 }
    byPayer[k].billed += Number(inv.total || 0)
    byPayer[k].paid += Number(inv.paid || 0)
    byPayer[k].count += 1
  })
  const payerRows = Object.entries(byPayer).map(([k, v]) => [
    k, v.count, naira(v.billed), naira(v.paid), naira(v.billed - v.paid),
    v.billed ? Math.round((v.paid / v.billed) * 100) + '%' : '0%',
  ])

  // Payment methods
  const byMethod = {}
  payments.forEach((p) => {
    const k = p.method || 'Cash'
    if (!byMethod[k]) byMethod[k] = { amount: 0, count: 0 }
    byMethod[k].amount += Number(p.amount_kobo || 0) / 100
    byMethod[k].count += 1
  })
  const methodRows = Object.entries(byMethod).map(([k, v]) => [k, v.count, naira(v.amount)])

  // Monthly trend (last 12 months)
  const now = Date.now()
  const months = []
  for (let m = 11; m >= 0; m--) {
    const d = new Date(now)
    d.setMonth(d.getMonth() - m)
    months.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'))
  }
  const monthly = {}
  months.forEach((m) => { monthly[m] = { billed: 0, collected: 0 } })
  invoices.forEach((inv) => {
    const ms = inv.createdAt || 0
    const ym = new Date(ms).toISOString().slice(0, 7)
    if (monthly[ym]) { monthly[ym].billed += Number(inv.total || 0); monthly[ym].collected += Number(inv.paid || 0) }
  })
  const monthRows = months.map((m) => [m, naira(monthly[m].billed), naira(monthly[m].collected), naira(monthly[m].billed - monthly[m].collected)])

  // Outstanding receivables (unpaid/part-paid invoices)
  const outstanding = invoices.filter((inv) => (inv.status || 'unpaid') !== 'paid')
    .sort((a, b) => b.createdAt - a.createdAt)
  const outRows = outstanding.map((inv) => [
    inv.invoiceId || inv.id, inv.patientName, inv.payer, inv.date || fmtDate(inv.createdAt),
    statusPill(inv.status), naira(inv.total), naira(inv.paid), naira(inv.outstanding),
  ])

  const html =
    '<div class="toolbar" style="margin-bottom:4px">' +
    '<button class="btn" id="rep-print-financial">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-financial">Export CSV</button>' +
    '</div>' +

    '<div class="grid4">' +
    '<div class="stat"><em>Total billed</em><strong>' + naira(s.billed) + '</strong><span>' + invoices.length + ' invoices</span></div>' +
    '<div class="stat"><em>Total collected</em><strong>' + naira(s.collected) + '</strong><span>' + s.rate + '% collected</span></div>' +
    '<div class="stat"><em>Outstanding</em><strong style="color:var(--emr-bad)">' + naira(s.outstanding) + '</strong><span>' + s.open + ' unpaid</span></div>' +
    '<div class="stat"><em>Payments recorded</em><strong>' + naira(payments.reduce((t, x) => t + (Number(x.amount_kobo || 0) / 100), 0)) + '</strong><span>' + payments.length + ' payments</span></div>' +
    '</div>' +

    '<div class="card"><div class="card-head"><h3>Revenue by payer</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Payer</th><th>Invoices</th><th>Billed</th><th>Collected</th><th>Outstanding</th><th>Collected %</th></tr></thead><tbody>' +
    payerRows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + r[3] + '</td><td>' + r[4] + '</td><td>' + r[5] + '</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Payments by method</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Method</th><th>Payments</th><th>Amount</th></tr></thead><tbody>' +
    methodRows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Monthly billing trend (last 12 months)</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Month</th><th>Billed</th><th>Collected</th><th>Outstanding</th></tr></thead><tbody>' +
    monthRows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + r[3] + '</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Outstanding receivables</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Invoice</th><th>Patient</th><th>Payer</th><th>Date</th><th>Status</th><th>Billed</th><th>Collected</th><th>Outstanding</th></tr></thead><tbody>' +
    outRows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td><td>' + r[4] + '</td><td>' + r[5] + '</td><td>' + r[6] + '</td><td style="color:var(--emr-bad);font-weight:700">' + r[7] + '</td></tr>').join('') +
    '</tbody></table>' +
    (outstanding.length === 0 ? '<p class="sub">No outstanding receivables in this period.</p>' : '') +
    '</div></div>'

  return html
}

function renderPatients(data) {
  const { patients } = data

  // By sex
  const bySex = {}
  patients.forEach((p) => { const k = p.sex || 'Not stated'; bySex[k] = (bySex[k] || 0) + 1 })

  // By age group
  const ageGroups = { '0-17': 0, '18-35': 0, '36-50': 0, '51-65': 0, '65+': 0 }
  patients.forEach((p) => {
    const age = p.age || 0
    if (age <= 17) ageGroups['0-17']++
    else if (age <= 35) ageGroups['18-35']++
    else if (age <= 50) ageGroups['36-50']++
    else if (age <= 65) ageGroups['51-65']++
    else ageGroups['65+']++
  })

  // By blood group
  const byBlood = {}
  patients.forEach((p) => { const k = p.blood_group || 'Not stated'; byBlood[k] = (byBlood[k] || 0) + 1 })

  // Payer mix
  const byPayer = {}
  patients.forEach((p) => { const k = p.payer || 'Self-pay'; byPayer[k] = (byPayer[k] || 0) + 1 })

  const rows = patients.map((p) => [
    p.mrn, p.name, p.sex || '—', p.age || '—', p.phone, p.payer || 'Self-pay', statusPill(p.status), fmtDate(p.registered),
  ])

  const html =
    '<div class="toolbar" style="margin-bottom:4px">' +
    '<button class="btn" id="rep-print-patients">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-patients">Export CSV</button>' +
    '</div>' +

    '<div class="grid4">' +
    '<div class="stat"><em>Total patients</em><strong>' + patients.length + '</strong><span>registered in period</span></div>' +
    '<div class="stat"><em>Self-pay</em><strong>' + (byPayer['Self-pay'] || 0) + '</strong><span>' + Math.round(((byPayer['Self-pay'] || 0) / Math.max(1, patients.length)) * 100) + '%</span></div>' +
    '<div class="stat"><em>NHIA / HMO</em><strong>' + ((byPayer['NHIA'] || 0) + (byPayer['HMO'] || 0)) + '</strong><span>scheme-covered</span></div>' +
    '<div class="stat"><em>Active</em><strong>' + patients.filter((p) => p.status === 'Active').length + '</strong><span>active status</span></div>' +
    '</div>' +

    '<div class="card"><div class="card-head"><h3>Patient demographics</h3></div>' +
    '<div class="grid4">' +
    '<div class="stat"><em>Male</em><strong>' + (bySex['Male'] || 0) + '</strong><span>' + Math.round(((bySex['Male'] || 0) / Math.max(1, patients.length)) * 100) + '%</span></div>' +
    '<div class="stat"><em>Female</em><strong>' + (bySex['Female'] || 0) + '</strong><span>' + Math.round(((bySex['Female'] || 0) / Math.max(1, patients.length)) * 100) + '%</span></div>' +
    '<div class="stat"><em>Other / not stated</em><strong>' + ((bySex['Other'] || 0) + (bySex['Not stated'] || 0)) + '</strong><span></span></div>' +
    '<div class="stat"><em>Avg age</em><strong>' + (patients.length ? Math.round(patients.reduce((t, p) => t + (Number(p.age) || 0), 0) / patients.length) : 0) + ' yrs</strong><span></span></div>' +
    '</div></div>' +

    '<div class="card"><div class="card-head"><h3>By age group</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Age group</th><th>Patients</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(ageGroups).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, patients.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By blood group</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Blood group</th><th>Patients</th></tr></thead><tbody>' +
    Object.entries(byBlood).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By payer</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Payer</th><th>Patients</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(byPayer).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, patients.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Patient register</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>MRN</th><th>Name</th><th>Sex</th><th>Age</th><th>Phone</th><th>Payer</th><th>Status</th><th>Registered</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + r[3] + '</td><td>' + esc(r[4]) + '</td><td>' + esc(r[5]) + '</td><td>' + r[6] + '</td><td>' + esc(r[7]) + '</td></tr>').join('') +
    '</tbody></table>' +
    (patients.length === 0 ? '<p class="sub">No patients in this period.</p>' : '') +
    '</div></div>'

  return html
}

function renderAppointments(data) {
  const { appointments } = data

  const byStatus = {}
  appointments.forEach((a) => { const k = a.status || 'scheduled'; byStatus[k] = (byStatus[k] || 0) + 1 })

  const byClinic = {}
  appointments.forEach((a) => { const k = a.clinic || 'General'; byClinic[k] = (byClinic[k] || 0) + 1 })

  const rows = appointments.map((a) => [
    a.patientName, a.clinic || '—', a.doctor || '—', a.type || '—', statusPill(a.status),
    a.checkedIn ? 'Yes' : '—', fmtDate(a.createdAt), a.time || '—',
  ])

  const html =
    '<div class="toolbar" style="margin-bottom:4px">' +
    '<button class="btn" id="rep-print-appointments">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-appointments">Export CSV</button>' +
    '</div>' +

    '<div class="grid4">' +
    '<div class="stat"><em>Total appointments</em><strong>' + appointments.length + '</strong><span>in period</span></div>' +
    '<div class="stat"><em>Scheduled</em><strong>' + (byStatus['scheduled'] || 0) + '</strong><span></span></div>' +
    '<div class="stat"><em>Completed</em><strong>' + (byStatus['completed'] || 0) + '</strong><span></span></div>' +
    '<div class="stat"><em>No-shows</em><strong>' + (byStatus['no-show'] || 0) + '</strong><span>' + Math.round(((byStatus['no-show'] || 0) / Math.max(1, appointments.length)) * 100) + '% rate</span></div>' +
    '</div>' +

    '<div class="card"><div class="card-head"><h3>By status</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Status</th><th>Count</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(byStatus).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, appointments.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By clinic</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Clinic</th><th>Appointments</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(byClinic).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, appointments.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Appointment schedule</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Patient</th><th>Clinic</th><th>Doctor</th><th>Type</th><th>Status</th><th>Checked in</th><th>Date</th><th>Time</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td><td>' + r[4] + '</td><td>' + r[5] + '</td><td>' + esc(r[6]) + '</td><td>' + esc(r[7]) + '</td></tr>').join('') +
    '</tbody></table>' +
    (appointments.length === 0 ? '<p class="sub">No appointments in this period.</p>' : '') +
    '</div></div>'

  return html
}

function renderConsultations(data) {
  const { encounters } = data

  const byStatus = {}
  encounters.forEach((e) => { const k = e.status || 'open'; byStatus[k] = (byStatus[k] || 0) + 1 })

  const byType = {}
  encounters.forEach((e) => { const k = e.type || 'General'; byType[k] = (byType[k] || 0) + 1 })

  const byClinician = {}
  encounters.forEach((e) => { const k = e.clinician || 'Not assigned'; byClinician[k] = (byClinician[k] || 0) + 1 })

  const rows = encounters.map((e) => [
    e.patientName, e.type || '—', e.clinician || '—', statusPill(e.status),
    e.chiefComplaint || '—', fmtDate(e.createdAt),
  ])

  const html =
    '<div class="toolbar" style="margin-bottom:4px">' +
    '<button class="btn" id="rep-print-consultations">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-consultations">Export CSV</button>' +
    '</div>' +

    '<div class="grid4">' +
    '<div class="stat"><em>Total encounters</em><strong>' + encounters.length + '</strong><span>in period</span></div>' +
    '<div class="stat"><em>Open</em><strong>' + encounters.filter((e) => e.status !== 'closed').length + '</strong><span>not yet closed</span></div>' +
    '<div class="stat"><em>Closed</em><strong>' + (byStatus['closed'] || 0) + '</strong><span></span></div>' +
    '<div class="stat"><em>Clinicians</em><strong>' + Object.keys(byClinician).length + '</strong><span>active</span></div>' +
    '</div>' +

    '<div class="card"><div class="card-head"><h3>By encounter type</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Type</th><th>Encounters</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(byType).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, encounters.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By clinician workload</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Clinician</th><th>Encounters</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(byClinician).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, encounters.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By status</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Status</th><th>Count</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(byStatus).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, encounters.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Encounter log</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Patient</th><th>Type</th><th>Clinician</th><th>Status</th><th>Chief complaint</th><th>Date</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + r[3] + '</td><td>' + esc(r[4]) + '</td><td>' + esc(r[5]) + '</td></tr>').join('') +
    '</tbody></table>' +
    (encounters.length === 0 ? '<p class="sub">No encounters in this period.</p>' : '') +
    '</div></div>'

  return html
}

function renderLaboratory(data) {
  const { labs, invoices } = data

  // Build a fast invoice lookup by both id and invoiceId aliases
  const invMap = {}
  invoices.forEach((inv) => { invMap[inv.id] = inv; if (inv.invoiceId && inv.invoiceId !== inv.id) invMap[inv.invoiceId] = inv })

  // ── camelCase fields from toLabRow ──────────────────────────────────────
  // totalKobo, invoiceId, billingStatus, testPanel, tests[], patientName,
  // orderedAt, status, priority, facility, createdAt

  // ── Financial metrics ───────────────────────────────────────────────────
  const totalBilledKobo = labs.reduce((s, l) => s + (l.totalKobo || 0), 0)
  const invoicedLabs = labs.filter((l) => !!l.invoiceId)
  const unbilledLabs = labs.filter((l) => !l.invoiceId)
  const invoicedKobo = invoicedLabs.reduce((s, l) => s + (l.totalKobo || 0), 0)
  const unbilledKobo = unbilledLabs.reduce((s, l) => s + (l.totalKobo || 0), 0)

  let totalCollectedNaira = 0
  let totalOutstandingNaira = 0
  invoicedLabs.forEach((l) => {
    const inv = invMap[l.invoiceId]
    if (inv) { totalCollectedNaira += Number(inv.paid || 0); totalOutstandingNaira += Number(inv.outstanding || 0) }
  })

  // Revenue by test panel (split multi-test orders evenly per test)
  const byTestRev = {}
  labs.forEach((l) => {
    const tests = Array.isArray(l.tests) && l.tests.length ? l.tests : (l.testPanel ? [l.testPanel] : ['(uncategorised)'])
    const perKobo = tests.length ? Math.round((l.totalKobo || 0) / tests.length) : 0
    tests.forEach((t) => {
      if (!byTestRev[t]) byTestRev[t] = { count: 0, kobo: 0 }
      byTestRev[t].count++
      byTestRev[t].kobo += perKobo
    })
  })
  const byTestArr = Object.entries(byTestRev).sort((a, b) => b[1].kobo - a[1].kobo)

  // Billing status breakdown
  const byBilling = {}
  labs.forEach((l) => { const k = l.billingStatus || 'unbilled'; byBilling[k] = (byBilling[k] || 0) + 1 })

  // Monthly trend — last 6 months
  const now6 = Date.now()
  const months6 = []
  for (let m = 5; m >= 0; m--) {
    const dd = new Date(now6); dd.setMonth(dd.getMonth() - m)
    months6.push(dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0'))
  }
  const monthly6 = {}
  months6.forEach((m) => { monthly6[m] = { count: 0, kobo: 0 } })
  labs.forEach((l) => {
    const ts = l.orderedAt || l.createdAt
    if (!ts) return
    const ym = new Date(ts).toISOString().slice(0, 7)
    if (monthly6[ym]) { monthly6[ym].count++; monthly6[ym].kobo += (l.totalKobo || 0) }
  })

  // Outstanding lab invoices (invoiced but not fully paid)
  const outstandingList = invoicedLabs
    .map((l) => ({ l, inv: invMap[l.invoiceId] }))
    .filter(({ inv }) => inv && Number(inv.outstanding || 0) > 0)
    .sort((a, b) => (b.l.orderedAt || 0) - (a.l.orderedAt || 0))
    .slice(0, 25)

  // ── Technical / Operational metrics ───────────────────────────────────────
  const byStatus = {}
  labs.forEach((l) => { const k = l.status || 'order'; byStatus[k] = (byStatus[k] || 0) + 1 })

  const byPriority = {}
  labs.forEach((l) => { const k = l.priority || 'Routine'; byPriority[k] = (byPriority[k] || 0) + 1 })

  const byFacility = {}
  labs.forEach((l) => { const k = l.facility || 'internal'; byFacility[k] = (byFacility[k] || 0) + 1 })

  // Completion funnel rates
  const COLLECTED_ST = ['sample_collected', 'received', 'result_entered', 'validated', 'released', 'verified']
  const RESULT_ST = ['result_entered', 'validated', 'released', 'verified']
  const RELEASED_ST = ['validated', 'released', 'verified']
  const collectedCount = labs.filter((l) => COLLECTED_ST.includes(l.status)).length
  const resultCount = labs.filter((l) => RESULT_ST.includes(l.status)).length
  const releasedCount = labs.filter((l) => RELEASED_ST.includes(l.status)).length

  // Revenue leakage: released/verified but never invoiced
  const leakage = labs.filter((l) => RELEASED_ST.includes(l.status) && !l.invoiceId)

  // Status funnel display order
  const STATUS_FUNNEL = ['order', 'sample_collected', 'received', 'result_entered', 'validated', 'released', 'verified', 'cancelled', 'rejected']

  // Full order log rows
  const logRows = labs.map((l) => {
    const testLabel = Array.isArray(l.tests) && l.tests.length ? l.tests.join(', ') : (l.testPanel || '—')
    return [
      l.patientName || '—', testLabel,
      l.priority || 'Routine', l.facility || 'internal',
      l.status || 'order', l.billingStatus || 'unbilled',
      naira(Number(l.totalKobo || 0) / 100),
      l.invoiceId ? l.invoiceId.slice(0, 8) : '—',
      fmtDate(l.orderedAt || l.createdAt),
    ]
  })

  const html =
    // ── Toolbar with sub-tab toggle ─────────────────────────────────────────
    '<div class="toolbar" style="margin-bottom:4px;flex-wrap:wrap;gap:6px">' +
    '<button class="btn" id="rep-print-laboratory">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-laboratory">Export CSV</button>' +
    '<span style="display:inline-flex;gap:4px;margin-left:8px">' +
    '<button class="btn sm lab-sub on" data-lsub="financial">📊 Financial</button>' +
    '<button class="btn ghost sm lab-sub" data-lsub="technical">⚗️ Technical</button>' +
    '</span>' +
    '</div>' +

    // ══════════════════════════════════════════════════════════════════
    // FINANCIAL PANE
    // ══════════════════════════════════════════════════════════════════
    '<div id="lab-fin">' +

    // KPI row
    '<div class="grid4">' +
    '<div class="stat"><em>Total lab revenue</em><strong>' + naira(totalBilledKobo / 100) + '</strong><span>' + labs.length + ' orders in period</span></div>' +
    '<div class="stat"><em>Invoiced</em><strong>' + naira(invoicedKobo / 100) + '</strong><span>' + invoicedLabs.length + ' orders with invoice</span></div>' +
    '<div class="stat"><em>Collected</em><strong style="color:var(--emr-ok,#1e7e34)">' + naira(totalCollectedNaira) + '</strong><span>paid against lab invoices</span></div>' +
    '<div class="stat"><em>Unbilled</em><strong style="color:var(--emr-warn,#d97706)">' + naira(unbilledKobo / 100) + '</strong><span>' + unbilledLabs.length + ' orders not yet invoiced</span></div>' +
    '</div>' +

    // Revenue by test panel
    '<div class="card"><div class="card-head"><h3>Revenue by test / panel</h3>' +
    '<span class="mut" style="font-size:.82rem;font-weight:400">Multi-test orders split proportionally per test</span></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr>' +
    '<th>Test / panel</th><th>Orders</th><th>Revenue (₦)</th><th>Avg per order</th><th>Revenue share</th>' +
    '</tr></thead><tbody>' +
    (byTestArr.length
      ? byTestArr.map(([name, v]) => {
          const share = totalBilledKobo ? Math.round((v.kobo / totalBilledKobo) * 100) : 0
          return '<tr>' +
            '<td><strong>' + esc(name) + '</strong></td>' +
            '<td>' + v.count + '</td>' +
            '<td>' + naira(v.kobo / 100) + '</td>' +
            '<td>' + naira(v.count ? Math.round(v.kobo / v.count) / 100 : 0) + '</td>' +
            '<td><span style="display:inline-flex;align-items:center;gap:6px">' +
            share + '%' +
            '<span style="display:inline-block;height:8px;width:' + Math.max(4, Math.round(share * 0.8)) + 'px;background:var(--emr-accent,#2563eb);border-radius:4px;opacity:.55"></span>' +
            '</span></td>' +
            '</tr>'
        }).join('')
      : '<tr><td colspan="5" class="mut" style="text-align:center;padding:22px 8px">No lab orders in this period.</td></tr>'
    ) +
    '</tbody></table></div></div>' +

    // Two-column: billing status + monthly trend
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">' +

    '<div class="card"><div class="card-head"><h3>Billing status breakdown</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Status</th><th>Orders</th><th>Share</th><th>Value (₦)</th></tr></thead><tbody>' +
    (Object.keys(byBilling).length
      ? Object.entries(byBilling).map(([k, v]) => {
          const kobo = labs.filter((l) => (l.billingStatus || 'unbilled') === k).reduce((s, l) => s + (l.totalKobo || 0), 0)
          return '<tr><td>' + statusPill(k) + '</td><td>' + v + '</td><td>' + (labs.length ? Math.round((v / labs.length) * 100) : 0) + '%</td><td>' + naira(kobo / 100) + '</td></tr>'
        }).join('')
      : '<tr><td colspan="4" class="mut" style="text-align:center;padding:16px">No data.</td></tr>'
    ) +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Monthly trend — last 6 months</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Month</th><th>Orders</th><th>Revenue (₦)</th></tr></thead><tbody>' +
    months6.map((m) => '<tr><td>' + m + '</td><td>' + monthly6[m].count + '</td><td>' + naira(monthly6[m].kobo / 100) + '</td></tr>').join('') +
    '</tbody></table></div></div>' +
    '</div>' +

    // Outstanding lab invoices
    '<div class="card">' +
    '<div class="card-head"><h3>Outstanding lab invoices</h3>' +
    (outstandingList.length
      ? '<span class="pill bad" style="margin-left:8px">' + outstandingList.length + ' unpaid / part-paid</span>'
      : '<span class="pill ok" style="margin-left:8px">All clear ✓</span>'
    ) +
    '</div>' +
    (outstandingList.length
      ? '<div class="tblwrap"><table class="tbl"><thead><tr>' +
        '<th>Patient</th><th>Test / panel</th><th>Invoice ref</th><th>Billed</th><th>Paid</th><th>Outstanding</th><th>Ordered</th>' +
        '</tr></thead><tbody>' +
        outstandingList.map(({ l, inv }) => {
          const testLabel = Array.isArray(l.tests) && l.tests.length ? l.tests.join(', ') : (l.testPanel || '—')
          return '<tr>' +
            '<td>' + esc(l.patientName || '—') + '</td>' +
            '<td>' + esc(testLabel) + '</td>' +
            '<td><code style="font-size:.8rem">' + esc(l.invoiceId ? l.invoiceId.slice(0, 8) : '—') + '</code></td>' +
            '<td>' + naira(Number(l.totalKobo || 0) / 100) + '</td>' +
            '<td>' + naira(inv ? Number(inv.paid || 0) : 0) + '</td>' +
            '<td style="color:var(--emr-warn,#d97706);font-weight:600">' + naira(inv ? Number(inv.outstanding || 0) : 0) + '</td>' +
            '<td>' + fmtDate(l.orderedAt || l.createdAt) + '</td>' +
            '</tr>'
        }).join('') +
        '</tbody></table></div>'
      : '<p class="sub" style="padding:16px 18px">All invoiced lab orders are fully settled. ✓</p>'
    ) +
    '</div>' +

    '</div>' + // end #lab-fin

    // ══════════════════════════════════════════════════════════════════
    // TECHNICAL / OPERATIONAL PANE (hidden by default)
    // ══════════════════════════════════════════════════════════════════
    '<div id="lab-tech" style="display:none">' +

    // Completion KPI row
    '<div class="grid4">' +
    '<div class="stat"><em>Total orders</em><strong>' + labs.length + '</strong><span>in selected period</span></div>' +
    '<div class="stat"><em>Sample collected</em><strong>' + collectedCount + '</strong><span>' + (labs.length ? Math.round((collectedCount / labs.length) * 100) : 0) + '% rate</span></div>' +
    '<div class="stat"><em>Results entered</em><strong>' + resultCount + '</strong><span>' + (labs.length ? Math.round((resultCount / labs.length) * 100) : 0) + '% completion</span></div>' +
    '<div class="stat"><em>Released / verified</em><strong>' + releasedCount + '</strong><span>' + (labs.length ? Math.round((releasedCount / labs.length) * 100) : 0) + '% release rate</span></div>' +
    '</div>' +

    // Revenue leakage banner
    (leakage.length
      ? '<div class="card" style="border:2px solid var(--emr-warn,#d97706)">' +
        '<div class="card-head"><h3>⚠ Revenue leakage — completed orders without invoice (' + leakage.length + ')</h3>' +
        '<span class="mut" style="font-size:.82rem">These orders have results released but no invoice attached — billing is incomplete.</span>' +
        '</div>' +
        '<div class="tblwrap"><table class="tbl"><thead><tr>' +
        '<th>Patient</th><th>Tests</th><th>Status</th><th>Value (at risk)</th><th>Ordered</th>' +
        '</tr></thead><tbody>' +
        leakage.slice(0, 25).map((l) => {
          const testLabel = Array.isArray(l.tests) && l.tests.length ? l.tests.join(', ') : (l.testPanel || '—')
          return '<tr>' +
            '<td>' + esc(l.patientName || '—') + '</td>' +
            '<td>' + esc(testLabel) + '</td>' +
            '<td>' + statusPill(l.status) + '</td>' +
            '<td style="color:var(--emr-warn,#d97706);font-weight:600">' + naira(Number(l.totalKobo || 0) / 100) + '</td>' +
            '<td>' + fmtDate(l.orderedAt || l.createdAt) + '</td>' +
            '</tr>'
        }).join('') +
        '</tbody></table></div></div>'
      : '<div class="card" style="border:2px solid var(--emr-ok,#1e7e34)"><p class="sub" style="padding:14px 18px">✓ No released orders found without an invoice. Billing is complete for this period.</p></div>'
    ) +

    // Three-column: status funnel | priority | facility
    '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px">' +

    '<div class="card"><div class="card-head"><h3>Order status funnel</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Stage</th><th>Orders</th><th>Share</th></tr></thead><tbody>' +
    STATUS_FUNNEL.filter((k) => byStatus[k]).map((k) =>
      '<tr><td>' + statusPill(k) + '</td><td>' + byStatus[k] + '</td><td>' + (labs.length ? Math.round((byStatus[k] / labs.length) * 100) : 0) + '%</td></tr>'
    ).join('') +
    (Object.keys(byStatus).length === 0 ? '<tr><td colspan="3" class="mut" style="text-align:center;padding:16px">No orders.</td></tr>' : '') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By priority</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Priority</th><th>Orders</th><th>%</th></tr></thead><tbody>' +
    Object.entries(byPriority).map(([k, v]) =>
      '<tr><td><strong>' + esc(k) + '</strong></td><td>' + v + '</td><td>' + (labs.length ? Math.round((v / labs.length) * 100) : 0) + '%</td></tr>'
    ).join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By facility</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Facility</th><th>Orders</th><th>%</th></tr></thead><tbody>' +
    Object.entries(byFacility).map(([k, v]) =>
      '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + (labs.length ? Math.round((v / labs.length) * 100) : 0) + '%</td></tr>'
    ).join('') +
    '</tbody></table></div></div>' +

    '</div>' + // end 3-col

    // Full order log
    '<div class="card"><div class="card-head"><h3>Full order log</h3>' +
    '<span class="mut" style="font-size:.82rem;font-weight:400">' + labs.length + ' orders</span></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr>' +
    '<th>Patient</th><th>Test / panel</th><th>Priority</th><th>Facility</th>' +
    '<th>Status</th><th>Billing</th><th>Value</th><th>Invoice ref</th><th>Ordered</th>' +
    '</tr></thead><tbody>' +
    logRows.map((r) =>
      '<tr>' +
      '<td>' + esc(r[0]) + '</td>' +
      '<td>' + esc(r[1]) + '</td>' +
      '<td>' + esc(r[2]) + '</td>' +
      '<td>' + esc(r[3]) + '</td>' +
      '<td>' + statusPill(r[4]) + '</td>' +
      '<td>' + statusPill(r[5]) + '</td>' +
      '<td>' + r[6] + '</td>' +
      '<td><code style="font-size:.8rem">' + esc(r[7]) + '</code></td>' +
      '<td>' + esc(r[8]) + '</td>' +
      '</tr>'
    ).join('') +
    (labs.length === 0 ? '<tr><td colspan="9" class="mut" style="text-align:center;padding:22px 8px">No lab orders in this period.</td></tr>' : '') +
    '</tbody></table></div></div>' +

    '</div>' // end #lab-tech

  return html
}


function renderPharmacy(data) {
  const { drugs } = data

  const lowStock = drugs.filter((d) => d.stock > 0 && d.stock < 20)
  const outStock = drugs.filter((d) => d.stock === 0)
  const totalStockValue = drugs.reduce((t, d) => t + Number(d.stock || 0) * Number(d.price || 0), 0)

  const rows = drugs.map((d) => [
    d.name, d.drug_code || '—', d.strength || '—', d.sku || '—',
    d.stock, d.unit || 'tabs', naira(d.price), naira(Number(d.stock || 0) * Number(d.price || 0)),
    statusPill(d.stock === 0 ? 'Out' : (d.stock < 20 ? 'Low' : 'OK')),
  ])

  const html =
    '<div class="toolbar" style="margin-bottom:4px">' +
    '<button class="btn" id="rep-print-pharmacy">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-pharmacy">Export CSV</button>' +
    '</div>' +

    '<div class="grid4">' +
    '<div class="stat"><em>Total SKUs</em><strong>' + drugs.length + '</strong><span>in catalogue</span></div>' +
    '<div class="stat"><em>In stock</em><strong>' + drugs.filter((d) => d.stock > 0).length + '</strong><span>available</span></div>' +
    '<div class="stat"><em>Low stock</em><strong style="color:var(--emr-warn)">' + lowStock.length + '</strong><span>below 20 units</span></div>' +
    '<div class="stat"><em>Out of stock</em><strong style="color:var(--emr-bad)">' + outStock.length + '</strong><span>zero units</span></div>' +
    '</div>' +

    '<div class="card"><div class="card-head"><h3>Inventory valuation</h3></div>' +
    '<div class="grid4">' +
    '<div class="stat"><em>Total stock value</em><strong>' + naira(totalStockValue) + '</strong><span>at selling price</span></div>' +
    '<div class="stat"><em>Low-stock value</em><strong>' + naira(lowStock.reduce((t, d) => t + Number(d.stock || 0) * Number(d.price || 0), 0)) + '</strong><span></span></div>' +
    '<div class="stat"><em>Out-of-stock value</em><strong>' + naira(outStock.reduce((t, d) => t + 0, 0)) + '</strong><span></span></div>' +
    '<div class="stat"><em>Avg price per SKU</em><strong>' + (drugs.length ? naira(drugs.reduce((t, d) => t + Number(d.price || 0), 0) / drugs.length) : '₦0') + '</strong><span></span></div>' +
    '</div></div>' +

    '<div class="card"><div class="card-head"><h3>Stock catalogue & valuation</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Drug</th><th>Code</th><th>Strength</th><th>SKU</th><th>Stock</th><th>Unit</th><th>Price</th><th>Stock value</th><th>Status</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td><td>' + r[4] + '</td><td>' + esc(r[5]) + '</td><td>' + r[6] + '</td><td>' + r[7] + '</td><td>' + r[8] + '</td></tr>').join('') +
    '</tbody></table>' +
    (drugs.length === 0 ? '<p class="sub">No pharmacy stock in this period.</p>' : '') +
    '</div></div>'

  return html
}

function renderAdmissions(data) {
  const { admissions } = data

  const active = admissions.filter((a) => a.status === 'active')
  const discharged = admissions.filter((a) => a.status === 'discharged')

  // Length of stay for discharged
  const losValues = discharged.map((a) => {
    const adm = a.admissionDate || a.createdAt || 0
    const dis = a.discharge_date || 0
    if (!adm || !dis) return null
    return Math.max(0, Math.round((dis - adm) / (24 * 3600 * 1000)))
  }).filter(Boolean)
  const avgLos = losValues.length ? Math.round(losValues.reduce((t, v) => t + v, 0) / losValues.length) : 0

  const byWard = {}
  admissions.forEach((a) => { const k = a.ward_name || 'General'; byWard[k] = (byWard[k] || 0) + 1 })

  const rows = admissions.map((a) => {
    const los = a.discharge_date && (a.admissionDate || a.createdAt)
      ? Math.max(0, Math.round((new Date(a.discharge_date).getTime() - (a.admissionDate || a.createdAt)) / (24 * 3600 * 1000))) + ' days'
      : '—'
    return [
      a.patientName || '—', a.ward_name || '—', a.bed_number || '—',
      a.admission_type || '—', statusPill(a.status),
      fmtDate(a.admissionDate || a.createdAt), fmtDate(a.discharge_date || 0), los,
    ]
  })

  const html =
    '<div class="toolbar" style="margin-bottom:4px">' +
    '<button class="btn" id="rep-print-admissions">Print Report</button>' +
    '<button class="btn ghost" id="rep-csv-admissions">Export CSV</button>' +
    '</div>' +

    '<div class="grid4">' +
    '<div class="stat"><em>Total admissions</em><strong>' + admissions.length + '</strong><span>in period</span></div>' +
    '<div class="stat"><em>Active stays</em><strong>' + active.length + '</strong><span>currently admitted</span></div>' +
    '<div class="stat"><em>Discharged</em><strong>' + discharged.length + '</strong><span></span></div>' +
    '<div class="stat"><em>Avg length of stay</em><strong>' + avgLos + ' days</strong><span>discharged patients</span></div>' +
    '</div>' +

    '<div class="card"><div class="card-head"><h3>By ward</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Ward</th><th>Admissions</th><th>Share</th></tr></thead><tbody>' +
    Object.entries(byWard).map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v + '</td><td>' + Math.round((v / Math.max(1, admissions.length)) * 100) + '%</td></tr>').join('') +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>By status</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Status</th><th>Count</th><th>Share</th></tr></thead><tbody>' +
    '<tr><td>Active</td><td>' + active.length + '</td><td>' + Math.round((active.length / Math.max(1, admissions.length)) * 100) + '%</td></tr>' +
    '<tr><td>Discharged</td><td>' + discharged.length + '</td><td>' + Math.round((discharged.length / Math.max(1, admissions.length)) * 100) + '%</td></tr>' +
    '</tbody></table></div></div>' +

    '<div class="card"><div class="card-head"><h3>Admission register</h3></div>' +
    '<div class="tblwrap"><table class="tbl"><thead><tr><th>Patient</th><th>Ward</th><th>Bed</th><th>Admission type</th><th>Status</th><th>Admitted</th><th>Discharged</th><th>Length of stay</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td><td>' + esc(r[3]) + '</td><td>' + r[4] + '</td><td>' + esc(r[5]) + '</td><td>' + esc(r[6]) + '</td><td>' + esc(r[7]) + '</td></tr>').join('') +
    '</tbody></table>' +
    (admissions.length === 0 ? '<p class="sub">No admissions in this period.</p>' : '') +
    '</div></div>'

  return html
}

// ---- print templates --------------------------------------------------------

function printableReport(title, orgName, subtitle, bodyHtml) {
  return (
    '<div class="print-sheet">' +
    '<div class="p-head">' +
    '<div>' +
    '<div class="p-hospital">' + esc(orgName) + '</div>' +
    '<div class="p-sub">MediLog NG · Hospital Management System</div>' +
    '</div>' +
    '<div class="p-doctitle">' + esc(title) + '</div>' +
    '</div>' +
    '<table class="p-meta"><tr><td class="k">Report</td><td>' + esc(title) + '</td>' +
    '<td class="k">Period</td><td>' + esc(subtitle) + '</td></tr>' +
    '<tr><td class="k">Generated</td><td>' + new Date().toLocaleString('en-NG') + '</td>' +
    '<td class="k">Hospital</td><td>' + esc(orgName) + '</td></tr></table>' +
    bodyHtml +
    '</div>'
  )
}

function printTable(headers, rows, caption) {
  const head = '<thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead>'
  const body = '<tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('</tbody>')
  return '<div class="p-h4">' + esc(caption) + '</div><table class="p-tbl">' + head + body + '</table>'
}

async function printReport(kind, data, rangeLabel, orgName) {
  let title, body
  switch (kind) {
    case 'overview': {
      const { patients, appointments, encounters, admissions, labs, drugs, invoices, payments } = data
      const s = billingSummary(invoices)
      body =
        printTable(
          ['Metric', 'Value'],
          [
            ['Patients registered', String(patients.length)],
            ['Appointments', String(appointments.length)],
            ['Consultations', String(encounters.length)],
            ['Active admissions', String(admissions.filter((a) => a.status === 'active').length)],
            ['Discharged', String(admissions.filter((a) => a.status === 'discharged').length)],
            ['Lab orders', String(labs.length)],
            ['Verified lab results', String(labs.filter((l) => l.status === 'verified').length)],
            ['Pharmacy SKUs', String(drugs.length)],
            ['Low stock', String(drugs.filter((d) => d.stock > 0 && d.stock < 20).length)],
            ['Out of stock', String(drugs.filter((d) => d.stock === 0).length)],
            ['Total billed', naira(s.billed)],
            ['Total collected', naira(s.collected)],
            ['Outstanding', naira(s.outstanding)],
          ],
          'Executive summary'
        )
      title = 'Operations Report'
      break
    }
    case 'financial': {
      const { invoices, payments } = data
      const s = billingSummary(invoices)
      const byPayer = {}
      invoices.forEach((inv) => {
        const k = inv.payer || 'Self-pay'
        if (!byPayer[k]) byPayer[k] = { b: 0, p: 0, c: 0 }
        byPayer[k].b += Number(inv.total || 0); byPayer[k].p += Number(inv.paid || 0); byPayer[k].c++
      })
      const payerRows = Object.entries(byPayer).map(([k, v]) => [k, String(v.c), naira(v.b), naira(v.p), naira(v.b - v.p)])
      body =
        printTable(['Metric', 'Value'], [
          ['Total billed', naira(s.billed)],
          ['Total collected', naira(s.collected)],
          ['Outstanding receivables', naira(s.outstanding)],
          ['Collection rate', s.rate + '%'],
          ['Invoices', String(invoices.length)],
          ['Payments recorded', String(payments.length)],
        ], 'Revenue summary') +
        printTable(['Payer', 'Invoices', 'Billed', 'Collected', 'Outstanding'], payerRows, 'Revenue by payer')
      title = 'Financial Report'
      break
    }
    case 'patients': {
      const { patients } = data
      const rows = patients.map((p) => [p.mrn, p.name, p.sex || '—', String(p.age || '—'), p.phone, p.payer || 'Self-pay', p.status || 'Active', fmtDate(p.registered)])
      body = printTable(['MRN', 'Name', 'Sex', 'Age', 'Phone', 'Payer', 'Status', 'Registered'], rows, 'Patient register (' + patients.length + ' patients)')
      title = 'Patient Report'
      break
    }
    case 'appointments': {
      const { appointments } = data
      const rows = appointments.map((a) => [a.patientName, a.clinic || '—', a.doctor || '—', a.type || '—', a.status || 'scheduled', a.checkedIn ? 'Yes' : 'No', fmtDate(a.createdAt), a.time || '—'])
      body = printTable(['Patient', 'Clinic', 'Doctor', 'Type', 'Status', 'Checked in', 'Date', 'Time'], rows, 'Appointment schedule (' + appointments.length + ' appointments)')
      title = 'Appointment Report'
      break
    }
    case 'consultations': {
      const { encounters } = data
      const rows = encounters.map((e) => [e.patientName, e.type || '—', e.clinician || '—', e.status || 'open', e.chiefComplaint || '—', fmtDate(e.createdAt)])
      body = printTable(['Patient', 'Type', 'Clinician', 'Status', 'Chief complaint', 'Date'], rows, 'Encounter log (' + encounters.length + ' encounters)')
      title = 'Consultation Report'
      break
    }
    case 'laboratory': {
      const { labs: prtLabs, invoices: prtInvs } = data
      const prtInvMap = {}
      prtInvs.forEach((inv) => { prtInvMap[inv.id] = inv; if (inv.invoiceId) prtInvMap[inv.invoiceId] = inv })
      const prtTotalKobo = prtLabs.reduce((s, l) => s + (l.totalKobo || 0), 0)
      const prtInvoicedKobo = prtLabs.filter((l) => !!l.invoiceId).reduce((s, l) => s + (l.totalKobo || 0), 0)
      const prtUnbilledKobo = prtLabs.filter((l) => !l.invoiceId).reduce((s, l) => s + (l.totalKobo || 0), 0)
      let prtCollectedNaira = 0
      prtLabs.forEach((l) => { const inv = prtInvMap[l.invoiceId]; if (inv) prtCollectedNaira += Number(inv.paid || 0) })
      const prtResultCount = prtLabs.filter((l) => ['result_entered', 'validated', 'released', 'verified'].includes(l.status)).length
      const prtReleasedCount = prtLabs.filter((l) => ['validated', 'released', 'verified'].includes(l.status)).length
      const prtLeakage = prtLabs.filter((l) => ['validated', 'released', 'verified'].includes(l.status) && !l.invoiceId).length
      const summaryRows = [
        ['Total orders', String(prtLabs.length)],
        ['Total lab revenue billed', naira(prtTotalKobo / 100)],
        ['Invoiced', naira(prtInvoicedKobo / 100)],
        ['Unbilled', naira(prtUnbilledKobo / 100)],
        ['Collected from lab invoices', naira(prtCollectedNaira)],
        ['Results entered', String(prtResultCount) + ' (' + (prtLabs.length ? Math.round((prtResultCount / prtLabs.length) * 100) : 0) + '%)'],
        ['Released / verified', String(prtReleasedCount) + ' (' + (prtLabs.length ? Math.round((prtReleasedCount / prtLabs.length) * 100) : 0) + '%)'],
        ['Revenue leakage (released, no invoice)', String(prtLeakage) + (prtLeakage > 0 ? ' ⚠' : ' ✓')],
      ]
      const orderRows = prtLabs.map((l) => {
        const inv = prtInvMap[l.invoiceId]
        const testLabel = Array.isArray(l.tests) && l.tests.length ? l.tests.join(', ') : (l.testPanel || '—')
        return [
          l.patientName || '—', testLabel,
          l.priority || 'Routine', l.status || 'order',
          l.billingStatus || 'unbilled', naira(Number(l.totalKobo || 0) / 100),
          l.invoiceId ? l.invoiceId.slice(0, 8) : '—',
          inv ? naira(Number(inv.outstanding || 0)) : '—',
          fmtDate(l.orderedAt || l.createdAt),
        ]
      })
      body =
        printTable(['Metric', 'Value'], summaryRows, 'Laboratory Financial Summary') +
        printTable(
          ['Patient', 'Test / panel', 'Priority', 'Status', 'Billing', 'Value', 'Invoice ref', 'Outstanding', 'Ordered'],
          orderRows,
          'Lab order log (' + prtLabs.length + ' orders)'
        )
      title = 'Laboratory Report'
      break
    }
    case 'pharmacy': {
      const { drugs } = data
      const rows = drugs.map((d) => [d.name, d.drug_code || '—', d.strength || '—', d.sku || '—', String(d.stock || 0), d.unit || 'tabs', naira(d.price), naira(Number(d.stock || 0) * Number(d.price || 0)), d.stock === 0 ? 'Out' : (d.stock < 20 ? 'Low' : 'OK')])
      body = printTable(['Drug', 'Code', 'Strength', 'SKU', 'Stock', 'Unit', 'Price', 'Stock value', 'Status'], rows, 'Pharmacy inventory (' + drugs.length + ' SKUs)')
      title = 'Pharmacy Report'
      break
    }
    case 'admissions': {
      const { admissions } = data
      const rows = admissions.map((a) => {
        const los = a.discharge_date && (a.admissionDate || a.createdAt)
          ? Math.max(0, Math.round((new Date(a.discharge_date).getTime() - (a.admissionDate || a.createdAt)) / (24 * 3600 * 1000))) + ' days'
          : '—'
        return [a.patientName || '—', a.ward_name || '—', a.bed_number || '—', a.admission_type || '—', a.status || 'active', fmtDate(a.admissionDate || a.createdAt), fmtDate(a.discharge_date || 0), los]
      })
      body = printTable(['Patient', 'Ward', 'Bed', 'Type', 'Status', 'Admitted', 'Discharged', 'Length of stay'], rows, 'Admission register (' + admissions.length + ' admissions)')
      title = 'Admissions Report'
      break
    }
    default:
      return
  }
  printDocument(title + ' — ' + esc(orgName), printableReport(title, orgName, rangeLabel, body))
}

// ---- main view --------------------------------------------------------------

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'financial', label: 'Financial' },
  { id: 'patients', label: 'Patients' },
  { id: 'appointments', label: 'Appointments' },
  { id: 'consultations', label: 'Consultations' },
  { id: 'laboratory', label: 'Laboratory' },
  { id: 'pharmacy', label: 'Pharmacy' },
  { id: 'admissions', label: 'Admissions' },
]

const RENDER = {
  overview: renderOverview,
  financial: renderFinancial,
  patients: renderPatients,
  appointments: renderAppointments,
  consultations: renderConsultations,
  laboratory: renderLaboratory,
  pharmacy: renderPharmacy,
  admissions: renderAdmissions,
}

const CSV_HEADERS = {
  overview: ['Metric', 'Value'],
  financial_payer: ['Payer', 'Invoices', 'Billed', 'Collected', 'Outstanding'],
  financial_method: ['Method', 'Payments', 'Amount'],
  financial_monthly: ['Month', 'Billed', 'Collected', 'Outstanding'],
  financial_outstanding: ['Invoice', 'Patient', 'Payer', 'Date', 'Status', 'Billed', 'Collected', 'Outstanding'],
  patients: ['MRN', 'Name', 'Sex', 'Age', 'Phone', 'Payer', 'Status', 'Registered'],
  appointments: ['Patient', 'Clinic', 'Doctor', 'Type', 'Status', 'Checked in', 'Date', 'Time'],
  consultations: ['Patient', 'Type', 'Clinician', 'Status', 'Chief complaint', 'Date'],
  laboratory_financial: ['Test / panel', 'Orders', 'Revenue (NGN)', 'Avg per order (NGN)', 'Revenue share %'],
  laboratory_billing: ['Patient', 'Test / panel', 'Invoice ref', 'Billed (NGN)', 'Paid (NGN)', 'Outstanding (NGN)', 'Billing status', 'Ordered'],
  laboratory_technical: ['Patient', 'Test / panel', 'Priority', 'Facility', 'Status', 'Billing status', 'Value (NGN)', 'Invoice ref', 'Ordered'],
  pharmacy: ['Drug', 'Code', 'Strength', 'SKU', 'Stock', 'Unit', 'Price', 'Stock value', 'Status'],
  admissions: ['Patient', 'Ward', 'Bed', 'Type', 'Status', 'Admitted', 'Discharged', 'Length of stay'],
}

export async function ReportsView(app) {
  const { activeOrg } = authStore.getState()
  if (!activeOrg) {
    shell(app, {
      active: '/reports', title: 'Reports', subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let startMs = null
  let endMs = null
  let currentTab = 'overview'
  let data = null

  shell(app, {
    active: '/reports',
    title: 'Reports',
    subtitle: 'Real reports from live hospital data — filter by date, export to CSV, or print',
    actions: '' +
      '<label class="fld" style="margin:0"><span>From</span><input id="rep-from" class="input" type="date" style="width:150px" /></label>' +
      '<label class="fld" style="margin:0"><span>To</span><input id="rep-to" class="input" type="date" style="width:150px" /></label>' +
      '<button class="btn ghost sm" id="rep-apply">Apply</button>' +
      '<button class="btn ghost sm" id="rep-clear">Clear</button>' +
      '<button class="btn" id="rep-refresh">↻ Refresh</button>',
    body: '' +
      '<div class="toolbar" style="margin-bottom:8px">' +
      '<p class="sub" id="rep-status">Loading…</p>' +
      '</div>' +
      '<div class="tabs" id="rep-tabs">' +
      TABS.map((t) => '<button class="' + (t.id === currentTab ? 'on' : '') + '" data-tab="' + t.id + '">' + esc(t.label) + '</button>').join('') +
      '</div>' +
      '<div id="rep-body"></div>',
  })

  async function reload() {
    const statusEl = document.getElementById('rep-status')
    try {
      if (statusEl) statusEl.textContent = 'Loading data…'
      data = await loadAllData(activeOrg, startMs, endMs)
      renderCurrent()
      const rangeTxt = (startMs != null || endMs != null)
        ? ' · ' + (startMs != null ? new Date(startMs).toLocaleDateString('en-NG') : '…') + ' → ' + (endMs != null ? new Date(endMs).toLocaleDateString('en-NG') : '…')
        : ' · all time'
      if (statusEl) statusEl.textContent = 'Live data' + rangeTxt
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Could not load reports: ' + (e.message || 'unknown error')
    }
  }

  function renderCurrent() {
    if (!data) return
    const body = document.getElementById('rep-body')
    if (!body) return
    const renderFn = RENDER[currentTab]
    body.innerHTML = renderFn ? renderFn(data) : '<div class="card"><p class="sub">Report not available.</p></div>'
    wireActions(currentTab, data)
  }

  function wireActions(kind, d) {
    const printBtn = document.getElementById('rep-print-' + kind)
    const csvBtn = document.getElementById('rep-csv-' + kind)
    const rangeLabel = (startMs != null || endMs != null)
      ? (startMs != null ? new Date(startMs).toLocaleDateString('en-NG') : '…') + ' → ' + (endMs != null ? new Date(endMs).toLocaleDateString('en-NG') : '…')
      : 'All time'

    if (printBtn) {
      printBtn.onclick = () => printReport(kind, d, rangeLabel, authStore.getState().activeOrgName || 'Hospital')
    }
    // Wire Financial/Technical sub-tabs for the Laboratory report
    if (kind === 'laboratory') {
      document.querySelectorAll('.lab-sub').forEach((btn) => {
        btn.onclick = () => {
          document.querySelectorAll('.lab-sub').forEach((b) => {
            b.classList.remove('on'); b.classList.add('ghost')
          })
          btn.classList.add('on'); btn.classList.remove('ghost')
          const sub = btn.getAttribute('data-lsub')
          const fin = document.getElementById('lab-fin')
          const tech = document.getElementById('lab-tech')
          if (fin) fin.style.display = sub === 'financial' ? '' : 'none'
          if (tech) tech.style.display = sub === 'technical' ? '' : 'none'
        }
      })
    }

        if (csvBtn) {
      csvBtn.onclick = () => {
        switch (kind) {
          case 'overview': {
            const { patients, appointments, encounters, admissions, labs, drugs, invoices, payments } = d
            const s = billingSummary(invoices)
            const rows = [
              ['Patients registered', String(patients.length)],
              ['Appointments', String(appointments.length)],
              ['Consultations', String(encounters.length)],
              ['Active admissions', String(admissions.filter((a) => a.status === 'active').length)],
              ['Discharged', String(admissions.filter((a) => a.status === 'discharged').length)],
              ['Lab orders', String(labs.length)],
              ['Verified lab results', String(labs.filter((l) => l.status === 'verified').length)],
              ['Pharmacy SKUs', String(drugs.length)],
              ['Low stock', String(drugs.filter((x) => x.stock > 0 && x.stock < 20).length)],
              ['Out of stock', String(drugs.filter((x) => x.stock === 0).length)],
              ['Total billed', String(s.billed)],
              ['Total collected', String(s.collected)],
              ['Outstanding', String(s.outstanding)],
            ]
            exportCsv('medilog-report-overview.csv', CSV_HEADERS.overview, rows)
            break
          }
          case 'financial': {
            const { invoices, payments } = d
            const s = billingSummary(invoices)
            const byPayer = {}
            invoices.forEach((inv) => {
              const k = inv.payer || 'Self-pay'
              if (!byPayer[k]) byPayer[k] = { b: 0, p: 0, c: 0 }
              byPayer[k].b += Number(inv.total || 0); byPayer[k].p += Number(inv.paid || 0); byPayer[k].c++
            })
            const payerRows = Object.entries(byPayer).map(([k, v]) => [k, String(v.c), String(v.b), String(v.p), String(v.b - v.p)])
            const byMethod = {}
            payments.forEach((p) => { const k = p.method || 'Cash'; if (!byMethod[k]) byMethod[k] = { a: 0, c: 0 }; byMethod[k].a += Number(p.amount_kobo || 0) / 100; byMethod[k].c++ })
            const methodRows = Object.entries(byMethod).map(([k, v]) => [k, String(v.c), String(v.a)])
            const now = Date.now()
            const months = []
            for (let m = 11; m >= 0; m--) { const dd = new Date(now); dd.setMonth(dd.getMonth() - m); months.push(dd.getFullYear() + '-' + String(dd.getMonth() + 1).padStart(2, '0')) }
            const monthly = {}
            months.forEach((m) => { monthly[m] = { b: 0, c: 0 } })
            invoices.forEach((inv) => { const ym = new Date(inv.createdAt || 0).toISOString().slice(0, 7); if (monthly[ym]) { monthly[ym].b += Number(inv.total || 0); monthly[ym].c += Number(inv.paid || 0) } })
            const monthRows = months.map((m) => [m, String(monthly[m].b), String(monthly[m].c), String(monthly[m].b - monthly[m].c)])
            const outstanding = invoices.filter((inv) => (inv.status || 'unpaid') !== 'paid').sort((a, b) => b.createdAt - a.createdAt)
            const outRows = outstanding.map((inv) => [inv.invoiceId || inv.id, inv.patientName, inv.payer, inv.date || fmtDate(inv.createdAt), inv.status, String(inv.total), String(inv.paid), String(inv.outstanding)])

            exportCsv('medilog-report-financial-payer.csv', CSV_HEADERS.financial_payer, payerRows)
            exportCsv('medilog-report-financial-method.csv', CSV_HEADERS.financial_method, methodRows)
            exportCsv('medilog-report-financial-monthly.csv', CSV_HEADERS.financial_monthly, monthRows)
            exportCsv('medilog-report-financial-outstanding.csv', CSV_HEADERS.financial_outstanding, outRows)
            toast('Financial CSVs exported (4 files)')
            break
          }
          case 'patients': {
            const rows = d.patients.map((p) => [p.mrn, p.name, p.sex || '—', String(p.age || '—'), p.phone, p.payer || 'Self-pay', p.status || 'Active', fmtDate(p.registered)])
            exportCsv('medilog-report-patients.csv', CSV_HEADERS.patients, rows)
            break
          }
          case 'appointments': {
            const rows = d.appointments.map((a) => [a.patientName, a.clinic || '—', a.doctor || '—', a.type || '—', a.status || 'scheduled', a.checkedIn ? 'Yes' : 'No', fmtDate(a.createdAt), a.time || '—'])
            exportCsv('medilog-report-appointments.csv', CSV_HEADERS.appointments, rows)
            break
          }
          case 'consultations': {
            const rows = d.encounters.map((e) => [e.patientName, e.type || '—', e.clinician || '—', e.status || 'open', e.chiefComplaint || '—', fmtDate(e.createdAt)])
            exportCsv('medilog-report-consultations.csv', CSV_HEADERS.consultations, rows)
            break
          }
          case 'laboratory': {
            const { labs: csvLabs, invoices: csvInvoices } = d
            const csvInvMap = {}
            csvInvoices.forEach((inv) => { csvInvMap[inv.id] = inv; if (inv.invoiceId) csvInvMap[inv.invoiceId] = inv })
            // Revenue by test panel
            const csvByTest = {}
            const csvTotalKobo = csvLabs.reduce((s, l) => s + (l.totalKobo || 0), 0)
            csvLabs.forEach((l) => {
              const tests = Array.isArray(l.tests) && l.tests.length ? l.tests : (l.testPanel ? [l.testPanel] : ['(uncategorised)'])
              const perKobo = tests.length ? Math.round((l.totalKobo || 0) / tests.length) : 0
              tests.forEach((t) => { if (!csvByTest[t]) csvByTest[t] = { count: 0, kobo: 0 }; csvByTest[t].count++; csvByTest[t].kobo += perKobo })
            })
            const testRows = Object.entries(csvByTest).sort((a, b) => b[1].kobo - a[1].kobo).map(([name, v]) => [
              name, String(v.count),
              String((v.kobo / 100).toFixed(2)),
              String(v.count ? (v.kobo / 100 / v.count).toFixed(2) : '0.00'),
              String(csvTotalKobo ? Math.round((v.kobo / csvTotalKobo) * 100) : 0) + '%',
            ])
            exportCsv('medilog-lab-revenue-by-test.csv', CSV_HEADERS.laboratory_financial, testRows)
            // Billing & outstanding per order
            const billingRows = csvLabs.map((l) => {
              const inv = csvInvMap[l.invoiceId]
              const testLabel = Array.isArray(l.tests) && l.tests.length ? l.tests.join(', ') : (l.testPanel || '—')
              return [
                l.patientName || '—', testLabel,
                l.invoiceId ? l.invoiceId.slice(0, 8) : '—',
                String((Number(l.totalKobo || 0) / 100).toFixed(2)),
                String(inv ? Number(inv.paid || 0).toFixed(2) : '0.00'),
                String(inv ? Number(inv.outstanding || 0).toFixed(2) : (Number(l.totalKobo || 0) / 100).toFixed(2)),
                l.billingStatus || 'unbilled',
                fmtDate(l.orderedAt || l.createdAt),
              ]
            })
            exportCsv('medilog-lab-billing.csv', CSV_HEADERS.laboratory_billing, billingRows)
            // Full technical log
            const techRows = csvLabs.map((l) => {
              const testLabel = Array.isArray(l.tests) && l.tests.length ? l.tests.join(', ') : (l.testPanel || '—')
              return [
                l.patientName || '—', testLabel,
                l.priority || 'Routine', l.facility || 'internal',
                l.status || 'order', l.billingStatus || 'unbilled',
                String((Number(l.totalKobo || 0) / 100).toFixed(2)),
                l.invoiceId ? l.invoiceId.slice(0, 8) : '—',
                fmtDate(l.orderedAt || l.createdAt),
              ]
            })
            exportCsv('medilog-lab-technical.csv', CSV_HEADERS.laboratory_technical, techRows)
            toast('Lab CSVs exported (3 files: revenue by test, billing, technical log)')
            break
          }
          case 'pharmacy': {
            const rows = d.drugs.map((drug) => [drug.name, drug.drug_code || '—', drug.strength || '—', drug.sku || '—', String(drug.stock || 0), drug.unit || 'tabs', String(drug.price), String(Number(drug.stock || 0) * Number(drug.price || 0)), drug.stock === 0 ? 'Out' : (drug.stock < 20 ? 'Low' : 'OK')])
            exportCsv('medilog-report-pharmacy.csv', CSV_HEADERS.pharmacy, rows)
            break
          }
          case 'admissions': {
            const rows = d.admissions.map((a) => {
              const los = a.discharge_date && (a.admissionDate || a.createdAt)
                ? Math.max(0, Math.round((new Date(a.discharge_date).getTime() - (a.admissionDate || a.createdAt)) / (24 * 3600 * 1000))) + ' days'
                : '—'
              return [a.patientName || '—', a.ward_name || '—', a.bed_number || '—', a.admission_type || '—', a.status || 'active', fmtDate(a.admissionDate || a.createdAt), fmtDate(a.discharge_date || 0), los]
            })
            exportCsv('medilog-report-admissions.csv', CSV_HEADERS.admissions, rows)
            break
          }
        }
      }
    }
  }

  document.getElementById('rep-refresh').onclick = reload
  document.getElementById('rep-apply').onclick = () => {
    const f = document.getElementById('rep-from').value
    const t = document.getElementById('rep-to').value
    if (f && t && f > t) { toast('“From” date must be on or before “To” date.'); return }
    startMs = f ? msOf(f) : null
    endMs = t ? new Date(t + 'T23:59:59').getTime() : null
    reload()
  }
  document.getElementById('rep-clear').onclick = () => {
    document.getElementById('rep-from').value = ''
    document.getElementById('rep-to').value = ''
    startMs = null
    endMs = null
    reload()
  }

  document.getElementById('rep-tabs').onclick = (e) => {
    const btn = e.target.closest('[data-tab]')
    if (!btn) return
    currentTab = btn.getAttribute('data-tab')
    document.getElementById('rep-tabs').querySelectorAll('button').forEach((b) => b.classList.remove('on'))
    btn.classList.add('on')
    renderCurrent()
  }

  wireToast(app)
  await reload()
}
