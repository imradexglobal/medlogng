// Reports — real aggregation from Firestore (offline-first, cached).
import { shell, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import { listOrgPatientsPage } from '../services/patientService.js'
import { listOrgAppointmentsPage } from '../services/appointmentService.js'
import { listOrgEncountersPage } from '../services/consultationService.js'
import { listOrgAdmissionsPage } from '../services/admissionService.js'
import { listOrgLabsPage } from '../services/laboratoryService.js'
import { listOrgDrugsPage } from '../services/pharmacyService.js'
import { listOrgInvoicesPage } from '../services/billingService.js'
import { countOrgDocs } from '../services/pagination.js'
import { esc } from '../utils/sanitize.js'

function naira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG')
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

  shell(app, {
    active: '/reports',
    title: 'Reports',
    subtitle: 'Operational summaries from live hospital data',
    actions: '<button class="btn ghost" id="refreshBtn">↻ Refresh</button><button class="btn ghost" id="expBtn">Export CSV</button>',
    body: '<div class="card"><div class="toolbar">' +
      '<label class="fld"><span>From</span><input id="rep-from" class="input" type="date" /></label>' +
      '<label class="fld"><span>To</span><input id="rep-to" class="input" type="date" /></label>' +
      '<button class="btn ghost sm" id="rep-apply">Apply</button>' +
      '<button class="btn ghost sm" id="rep-clear">Clear</button></div>' +
      '<p class="sub" id="rep-status">Loading…</p></div><div class="wardgrid" id="rep-grid"></div>',
  })

  function inRange(ms) {
    if (!ms) return true
    if (startMs != null && ms < startMs) return false
    if (endMs != null && ms > endMs) return false
    return true
  }

  async function load() {
    const statusEl = document.getElementById('rep-status')
    try {
      if (statusEl) statusEl.textContent = 'Loading live data…'
      // Bounded: counts for totals (no doc reads) + capped recent pages for
      // breakdowns. Large hospitals no longer download every document to
      // render this page. Sums (revenue) cover the sampled page — see note.
      const CAP = 200
      const [counts, patientsAll, apptsAll, encsAll, admsAll, labsAll, drugsAll, invoicesAll] = await Promise.all([
        Promise.all([
          countOrgDocs('organization_patients', activeOrg).catch(() => null),
          countOrgDocs('appointments', activeOrg).catch(() => null),
          countOrgDocs('encounters', activeOrg).catch(() => null),
          countOrgDocs('admissions', activeOrg).catch(() => null),
          countOrgDocs('lab_orders', activeOrg).catch(() => null),
          countOrgDocs('stock_lots', activeOrg).catch(() => null),
          countOrgDocs('invoices', activeOrg).catch(() => null),
        ]),
        listOrgPatientsPage(activeOrg, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
        listOrgAppointmentsPage(activeOrg, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
        listOrgEncountersPage(activeOrg, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
        listOrgAdmissionsPage(activeOrg, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
        listOrgLabsPage(activeOrg, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
        listOrgDrugsPage(activeOrg, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
        listOrgInvoicesPage(activeOrg, { pageSize: CAP }).then((r) => r.rows).catch(() => []),
      ])
      const patients = patientsAll.filter((p) => inRange(p.registered))
      const appts = apptsAll.filter((a) => inRange(a.createdAt))
      const encs = encsAll.filter((e) => inRange(e.createdAt))
      const adms = admsAll.filter((a) => inRange(a.createdAt))
      const labs = labsAll.filter((l) => inRange(l.orderedAt))
      const drugs = drugsAll.filter((d) => inRange(d.createdAt))
      const invoices = invoicesAll.filter((i) => inRange(i.createdAt))
      const billed = invoices.reduce((s, i) => s + (i.total || 0), 0)
      const collected = invoices.reduce((s, i) => s + (i.paid || 0), 0)
      const cards = [
        ['Patients', String(patients.length) + ' registered', 'Registrations by payer: ' + ['Self-pay', 'NHIA', 'HMO'].map((p) => p + ' ' + patients.filter((x) => (x.payer || '').includes(p === 'HMO' ? 'HMO' : p)).length).join(' · '), '#/patients'],
        ['Appointments', String(appts.length) + ' total', 'Scheduled ' + appts.filter((a) => a.status === 'scheduled').length + ' · Checked-in ' + appts.filter((a) => a.status === 'checked-in').length + ' · No-show ' + appts.filter((a) => a.status === 'no-show').length, '#/appointments'],
        ['Consultations', String(encs.length) + ' encounters', 'Open ' + encs.filter((e) => e.status !== 'closed').length + ' · Closed ' + encs.filter((e) => e.status === 'closed').length, '#/consultations'],
        ['Admissions', String(adms.filter((a) => a.status === 'active').length) + ' active', 'Total ' + adms.length + ' · Discharged ' + adms.filter((a) => a.status === 'discharged').length, '#/admissions'],
        ['Laboratory', String(labs.length) + ' orders', 'Verified ' + labs.filter((l) => l.status === 'verified').length + ' · Pending ' + labs.filter((l) => l.status === 'order').length, '#/laboratory'],
        ['Pharmacy', String(drugs.length) + ' SKUs', 'Out of stock ' + drugs.filter((d) => d.stock === 0).length + ' · Low ' + drugs.filter((d) => d.stock > 0 && d.stock < 20).length, '#/pharmacy'],
        ['Revenue', naira(billed) + ' billed', 'Collected ' + naira(collected) + ' · Outstanding ' + naira(billed - collected), '#/billing'],
      ]
      const rangeTxt = (startMs != null || endMs != null)
        ? ' · range ' + (startMs != null ? new Date(startMs).toLocaleDateString('en-NG') : '…') + ' → ' + (endMs != null ? new Date(endMs).toLocaleDateString('en-NG') : '…')
        : ' · all time'
      const [cPat, cApt, , cAdm, , , cInv] = counts
      const totTxt = (cPat ?? patients.length) + ' patients · ' + (cInv ?? invoices.length) + ' invoices'
      if (statusEl) statusEl.textContent = 'Live data · ' + totTxt + rangeTxt + ' · sampled ' + CAP + ' most recent per list' +
        ((cApt != null && cApt > CAP) || (cAdm != null && cAdm > CAP) ? ' (totals are exact counts; breakdowns cover the sample)' : '')
      const grid = document.getElementById('rep-grid')
      if (grid) {
        grid.innerHTML = cards.map((c) =>
          '<div class="ward"><div class="card-head"><h4>' + esc(c[0]) + '</h4></div>' +
          '<p><strong>' + esc(c[1]) + '</strong></p><p class="sub">' + esc(c[2]) + '</p>' +
          '<div class="toolbar"><a class="btn ghost sm" href="' + c[3] + '">Open source →</a></div></div>'
        ).join('')
      }
      const expBtn = document.getElementById('expBtn')
      if (expBtn) expBtn.onclick = () => {
        const rows = [['type', 'id', 'patient', 'status', 'total']]
        invoices.forEach((i) => rows.push(['invoice', i.id, i.patientName, i.status, String(i.total)]))
        patients.forEach((p) => rows.push(['patient', p.pid, p.name, p.status, '']))
        const csv = rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n')
        const blob = new Blob([csv], { type: 'text/csv' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = 'medilog-report.csv'
        a.click()
        toast('CSV exported from live data')
      }
    } catch (e) {
      if (statusEl) statusEl.textContent = 'Could not load reports: ' + (e.message || 'unknown error')
    }
  }

  document.getElementById('refreshBtn').onclick = load
  document.getElementById('rep-apply').onclick = () => {
    const f = document.getElementById('rep-from').value
    const t = document.getElementById('rep-to').value
    if (f && t && f > t) { toast('“From” date must be on or before “To” date.'); return }
    startMs = f ? new Date(f + 'T00:00:00').getTime() : null
    endMs = t ? new Date(t + 'T23:59:59').getTime() : null
    load()
  }
  document.getElementById('rep-clear').onclick = () => {
    document.getElementById('rep-from').value = ''
    document.getElementById('rep-to').value = ''
    startMs = null
    endMs = null
    load()
  }
  wireToast(app)
  await load()
}
