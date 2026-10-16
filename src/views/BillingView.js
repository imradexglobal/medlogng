// Billing with Firestore persistence (offline-first, cached).
// CRITICAL: charge/discount math lives in billingService and is preserved.
import { shell, statusBadge, formModal, toast, closeModal, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgInvoicesPage, subscribeOrgInvoices, createInvoice, recordPayment, myBillingCaps,
} from '../services/billingService.js'
import { listOrgPatientsPage, listOrgPatients, formatPhone, matchesPatient, parseSearchTerm, searchPatientsGlobally } from '../services/patientService.js'
import { payerOptions } from '../services/payerService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { createLoadMore } from '../components/loadMore.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'

const CATALOGUE = [
  ['General Outpatient Department (GOPD) consultation', 'Consult', 5000],
  ['Antenatal visit', 'Consult', 8000],
  ['FBC + ESR', 'Lab', 6500],
  ['Malaria RDT', 'Lab', 2500],
  ['Ward bed (per day)', 'Bed', 15000],
  ['Amlodipine 5mg ×30', 'Drug', 4500],
]
const TABS = ['Invoices', 'Payments', 'Price catalogue']
const DEFAULT_PAYER = 'Self-pay'

function naira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG')
}

// Billing is reachable with context from other screens:
//   #/billing?patient=<pid>&new=1&from=enc
// `patient` pre-selects the invoice patient (and their saved payer), `new=1`
// opens the New invoice form immediately, `from=enc` offers a way back to the
// encounter the charge came from.
export async function BillingView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myBillingCaps()
  const presetPid = String(params.patient || '')
  const autoOpen = params.new === '1' || params.new === 'true'
  const fromEncounter = params.from === 'enc'

  if (!activeOrg) {
    shell(app, {
      active: '/billing',
      title: 'Billing',
      subtitle: 'No hospital selected',
      body: '<div class="card"><p class="sub">Your account is not linked to a hospital yet. Ask an administrator for an invite, or register your hospital first.</p><a class="btn" href="#/admin">Open Administration →</a></div>',
    })
    return
  }

  let invoices = []
  let patients = []
  let payerOpts = []
  let tab = 'Invoices'
  let openedPreset = false
  let unsubs = []
  let watchedOrg = activeOrg
  // Infinite scroll: rows accumulate and `cursor` marks the end of what we hold.
  let cursor = null
  let hasMore = false
  let loading = false

  shell(app, {
    active: '/billing',
    title: 'Billing',
    subtitle: 'Invoices · payments in exact ₦ (kobo-safe)',
    actions:
      (fromEncounter ? '<a class="btn ghost" href="#/consultations' + (params.enc ? '?enc=' + encodeURIComponent(params.enc) : '') + '">← Back to encounter</a>' : '') +
      '<button class="btn ghost" id="refreshBtn">↻ Refresh</button>' +
      (caps.canInvoice ? '<button class="btn" id="invBtn">+ New invoice</button>' : ''),
    body:
      '<div class="grid4"><div class="stat"><em>Billed</em><strong id="bill-billed">₦0</strong><span id="bill-count">0 invoices</span></div>' +
      '<div class="stat"><em>Collected</em><strong id="bill-collected">₦0</strong><span id="bill-rate">collection rate 0%</span></div>' +
      '<div class="stat"><em>Outstanding</em><strong id="bill-outstanding">₦0</strong><span>open invoices</span></div>' +
      '<div class="stat"><em>Open</em><strong id="bill-open">0</strong><span>unpaid / part-paid</span></div></div>' +
      '<div class="tabs" id="bt">' + TABS.map((t, i) => '<button data-t="' + esc(t) + '" class="' + (i === 0 ? 'on' : '') + '">' + esc(t) + '</button>').join('') + '</div><div class="card" id="bpane"></div>',
  })

  const more = createLoadMore(loadMore)

  // Append the next chunk of invoices. The first call has no cursor and
  // replaces the list; later ones walk forward from the last row loaded.
  async function loadMore() {
    if (loading) return
    const first = cursor == null && invoices.length === 0
    loading = true
    more.setLoading(true)
    document.querySelector('#bpane .tblwrap')?.classList.add('is-loading')
    try {
      const [pg, pats, payers] = await Promise.all([
        listOrgInvoicesPage(activeOrg, { cursor }),
        first ? listOrgPatientsPage(activeOrg, { pageSize: 100 }).then((r) => r.rows).catch(() => []) : Promise.resolve(patients),
        first ? payerOptions().catch(() => []) : Promise.resolve([]),
      ])
      // A row written between two chunk reads shifts the cursor stream and can
      // repeat the boundary document.
      const seen = new Set(invoices.map((i) => i.id))
      invoices = first ? pg.rows : [...invoices, ...pg.rows.filter((i) => !seen.has(i.id))]
      cursor = pg.cursor
      hasMore = pg.hasMore
      if (first) {
        patients = pats
        payerOpts = payers.length ? payers : [{ value: DEFAULT_PAYER, label: DEFAULT_PAYER }]
      }
      loading = false
      more.setLoading(false)
      more.setDone(!hasMore)
      render()
      // The pre-selected patient only exists after the list resolves, so the
      // form is opened here rather than before the first paint.
      if (autoOpen && !openedPreset) {
        openedPreset = true
        if (!caps.canInvoice) {
          toast('Your role cannot create invoices — a billing officer must raise this charge.')
        } else {
          openInvoiceForm(presetPid)
        }
      }
    } catch (e) {
      console.error('[billing] list failed:', e)
      loading = false
      more.setLoading(false)
      if (first) toast('Could not load billing data: ' + friendlyWriteError(e))
      else more.setError('Could not load more — retry')
    } finally {
      document.querySelector('#bpane .tblwrap')?.classList.remove('is-loading')
    }
  }

  // A fresh read of the whole list.
  function reload() {
    invoices = []
    cursor = null
    hasMore = false
    more.reset()
    teardownListeners()
    loadMore().then(subscribeLive)
  }

  function render() {
    const billed = invoices.reduce((s, i) => s + (i.total || 0), 0)
    const collected = invoices.reduce((s, i) => s + (i.paid || 0), 0)
    const outstanding = billed - collected
    const rate = billed ? Math.round((collected / billed) * 100) : 0
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v }
    set('bill-billed', naira(billed))
    set('bill-count', invoices.length + (invoices.length === 1 ? ' invoice' : ' invoices'))
    set('bill-collected', naira(collected))
    set('bill-rate', 'collection rate ' + rate + '%')
    set('bill-outstanding', naira(outstanding))
    set('bill-open', String(invoices.filter((i) => i.status !== 'paid').length))
    document.querySelectorAll('#bt button').forEach((b) => {
      b.classList.toggle('on', b.getAttribute('data-t') === tab)
    })
    if (tab === 'Invoices') renderInvoices()
    else if (tab === 'Payments') renderPayments()
    else renderCatalogue()
  }

  function renderInvoices() {
    const pane = document.getElementById('bpane')
    if (!pane) return
    const rows = invoices.map((i) =>
      '<tr><td><strong>' + esc(i.invoiceId.slice(0, 8)) + '</strong><div class="mut">' + esc(i.date || '') + '</div></td>' +
      '<td>' + esc(i.patientName) + '</td><td>' + esc(i.payer) + '</td>' +
      '<td><strong>' + esc(naira(i.total)) + '</strong><div class="mut">paid ' + esc(naira(i.paid)) + '</div></td>' +
      '<td>' + statusBadge(i.status) + '</td>' +
      '<td>' + (i.status !== 'paid' && caps.canPayment ? '<button class="btn ghost sm" data-pay="' + esc(i.id) + '">Record payment</button>' : '') + '</td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><tr><th>Invoice</th><th>Patient</th><th>Payer</th><th>Total</th><th>Status</th><th></th></tr>' +
      (rows || '<tr><td colspan="6" class="mut" style="text-align:center;padding:22px 8px">No invoices yet</td></tr>') +
      '</table><div class="loadmore" data-loadmore="1"></div></div>'
    pane.querySelectorAll('[data-pay]').forEach((b) => {
      b.onclick = () => openPaymentForm(b.getAttribute('data-pay'))
    })
    more.mount(pane.querySelector('.tblwrap'))
  }

  function renderPayments() {
    const pane = document.getElementById('bpane')
    if (!pane) return
    const rows = invoices.filter((i) => (i.paid || 0) > 0).map((i) =>
      '<tr><td><strong>' + esc(i.invoiceId.slice(0, 8)) + '</strong></td><td>' + esc(i.patientName) + '</td>' +
      '<td>' + esc(naira(i.paid)) + '</td><td>' + statusBadge(i.status) + '</td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><tr><th>Invoice</th><th>Patient</th><th>Amount paid</th><th>Status</th></tr>' +
      (rows || '<tr><td colspan="4" class="mut" style="text-align:center;padding:22px 8px">No payments recorded</td></tr>') +
      '</table></div>'
  }

  function renderCatalogue() {
    const pane = document.getElementById('bpane')
    if (!pane) return
    // CATALOGUE stores prices in kobo (same as createInvoice) — divide before
    // formatting, otherwise a ₦5,000 item renders as "₦50".
    const rows = CATALOGUE.map((r) =>
      '<tr><td><strong>' + esc(r[0]) + '</strong></td><td>' + esc(r[1]) + '</td><td><strong>' + esc(naira(r[2] / 100)) + '</strong></td></tr>'
    ).join('')
    pane.innerHTML =
      '<div class="tblwrap"><table class="tbl"><tr><th>Service / item</th><th>Category</th><th>Price</th></tr>' + rows + '</table></div>'
  }

  // `presetPid` comes from #/billing?patient=… — used by the consultation
  // "Bill item" flow so the cashier does not re-pick the patient.
  async function openInvoiceForm(presetPid = '') {
    let patientList = patients
    let preSelectedPatient = null

    // If coming from consultation with a preset patient, fetch more details/search
    // to ensure we can find and prefill with full patient info
    if (presetPid) {
      try {
        // Try to find in current list first
        preSelectedPatient = patients.find((p) => p.pid === presetPid)
        if (!preSelectedPatient) {
          // Not in current loaded list (might be beyond pageSize 100), do a targeted search
          const { local, cloud } = await searchPatientsGlobally(presetPid)
          const found = [...local, ...cloud].find((p) => p.pid === presetPid)
          if (found) {
            preSelectedPatient = found
            // Add to patient list so select has it
            if (!patients.some((p) => p.pid === found.pid)) {
              patientList = [...patients, found]
            } else {
              patientList = patients
            }
          }
        }
      } catch (e) {
        console.warn('[billing] failed to locate preset patient:', e?.message)
      }
    }

    if (!patientList.length && !preSelectedPatient) {
      toast('No patients registered yet — register a patient first.')
      return
    }

    // Build patient options with full list (current + any found preset)
    const baseList = preSelectedPatient && !patientList.some((p) => p.pid === preSelectedPatient.pid)
      ? [...patientList, preSelectedPatient]
      : patientList
    const patientOpts = baseList.map((p) => ({
      value: p.pid,
      label: p.name + ' · ' + (p.mrn || p.pid) + ' · ' + formatPhone(p.phone, p.phone_key),
    }))

    const itemOpts = CATALOGUE.map((c) => c[0])
    const pid = presetPid && baseList.some((p) => p.pid === presetPid) ? presetPid : ''
    if (presetPid && !pid) {
      toast('That patient is not on this hospital\'s list — pick one below.')
    }
    const pre = baseList.find((p) => p.pid === pid)

    // For billing from consultation, show patient name prominently as read-only
    const fromConsult = !!presetPid || fromEncounter
    const fields = [
      {
        name: 'patient_id',
        label: 'Patient',
        type: 'select',
        options: patientOpts,
        required: true,
        full: true,
        value: pid,
        searchable: true,
        searchPlaceholder: 'Name, ID or mobile…'
      },
      { name: 'payer', label: 'Payer', type: 'select', options: payerOpts, value: (pre && pre.payer) || DEFAULT_PAYER },
      { name: 'item', label: 'Item', type: 'select', options: itemOpts, required: true, full: true },
      { name: 'qty', label: 'Qty', placeholder: '1', required: true },
    ]

    formModal({
      title: fromConsult && pre ? 'New invoice — ' + pre.name : 'New invoice',
      submitLabel: 'Create draft →',
      fields,
      onSubmit: async (v) => {
        try {
          const sel = baseList.find((p) => p.pid === v.patient_id)
          await createInvoice({
            patient_id: v.patient_id,
            patient_name: sel ? sel.name : v.patient_id,
            item: v.item,
            qty: Number(v.qty) || 1,
            payer: v.payer || DEFAULT_PAYER,
          })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Invoice created')
        reload()
      },
    })
  }

  function openPaymentForm(invoiceId) {
    const inv = invoices.find((i) => i.id === invoiceId)
    if (!inv) return
    formModal({
      title: 'Record payment — ' + naira(inv.outstanding) + ' outstanding',
      submitLabel: 'Save payment',
      fields: [
        { name: 'amount', label: 'Amount ₦', required: true, placeholder: String(inv.outstanding) },
        { name: 'method', label: 'Method', type: 'select', options: ['Cash', 'Transfer', 'POS', 'NHIA'] },
        { name: 'notes', label: 'Receipt note', full: true, placeholder: '…' },
      ],
      onSubmit: async (v) => {
        let result
        try {
          const amount = Number(v.amount)
          if (!amount || amount <= 0) throw new Error('Amount must be greater than 0.')
          result = await recordPayment({
            invoice_id: invoiceId,
            amount_kobo: Math.round(amount * 100),
            method: v.method || 'Cash',
            notes: v.notes || '',
          })
        } catch (e) {
          throw new Error(friendlyWriteError(e))
        }
        closeModal()
        toast('Payment recorded — ' + result.status)
        reload()
      },
    })
  }

  document.querySelectorAll('#bt button').forEach((b) => {
    b.onclick = () => { tab = b.getAttribute('data-t'); render() }
  })
  document.getElementById('refreshBtn').onclick = reload
  const invBtn = document.getElementById('invBtn')
  if (invBtn) invBtn.onclick = () => { openInvoiceForm() }
  wireToast(app)

  function teardownListeners() {
    unsubs.forEach((u) => u())
    unsubs = []
  }

  // Live updates for invoices/payments. The patient picker stays one-shot
  // (registry is never live); a brand-new patient may only appear after reload.
  function subscribeLive() {
    teardownListeners()
    if (!watchedOrg) return
    // The live feed only ever knows about the newest slice of the ledger. Once
    // the user has scrolled past it, leave the accumulated list alone rather
    // than truncating it back to one chunk.
    if (cursor != null) return
    unsubs.push(
      subscribeOrgInvoices(watchedOrg,
        (rows) => {
          if (cursor != null) return
          const seen = new Set(invoices.map((i) => i.id))
          invoices = rows.filter((i) => !seen.has(i.id)).concat(invoices)
          render()
        },
        (e) => {
          console.warn('[billing] live update failed; refreshing once:', e?.message || e)
          listOrgInvoicesPage(watchedOrg)
            .then((r) => { invoices = r.rows; render() })
            .catch(() => {})
        }),
    )
  }

  onCleanup(() => {
    teardownListeners()
    unsubAuth()
  })

  // The app does not re-route on org change, so rebuild the listener when the
  // active hospital switches.
  const unsubAuth = authStore.subscribe((s) => {
    if (s.activeOrg === watchedOrg) return
    watchedOrg = s.activeOrg
    subscribeLive()
  })

  await loadMore()
  subscribeLive()
}
