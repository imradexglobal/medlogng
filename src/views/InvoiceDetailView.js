// Invoice detail — real Firestore reads/writes (offline-first, cached).
import { shell, statusBadge, toast, wireToast } from '../components/shell.js'
import { openPaymentModal } from '../components/PaymentModal.js'
import { getInvoice, myBillingCaps } from '../services/billingService.js'
import { esc } from '../utils/sanitize.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteInvoice } from '../services/deleteService.js'
import { naira } from '../utils/format.js'

export async function InvoiceDetailView(app, params = {}) {
  const caps = myBillingCaps()
  let inv = null
  try {
    inv = await getInvoice(params.id)
  } catch (e) {
    inv = null
  }
  if (!inv) {
    shell(app, {
      active: '/billing',
      title: 'Invoice not found',
      subtitle: 'No invoice matches ' + esc(params.id || 'that ID'),
      actions: '<a class="btn" href="#/billing">← All invoices</a>',
      body: '<div class="card"><p class="sub">This invoice does not exist or has not been created yet.</p></div>',
    })
    return
  }
  shell(app, {
    active: '/billing',
    title: inv.invoiceId.slice(0, 12),
    subtitle: esc(inv.patientName) + ' · ' + esc(inv.date || '') + ' · ' + esc(inv.payer),
    actions: '<a class="btn ghost" href="#/billing">← All invoices</a>' +
      kebabCell({ rowId: inv.id, items: [
        ...(caps.canPayment && inv.status !== 'paid' ? [{ label: 'Record payment', dataAction: 'pay' }] : []),
        ...(canDeleteRecords() ? [{ label: 'Delete', tone: 'danger', dataAction: 'delete' }] : [])
      ] }),
    body:
      '<div class="grid2x"><div class="card"><div class="card-head"><h3>Items</h3>' + statusBadge(inv.status) + '</div>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Item</th><th>Total</th></tr></thead><tbody>' +
      '<tr><td>' + esc(typeof inv.items === 'string' ? inv.items : JSON.stringify(inv.items)) + '</td><td><strong>' + esc(naira(inv.total)) + '</strong></td></tr>' +
      '</tbody></table></div><div class="inv-total" style="margin-top:12px"><div><div>Total: <strong>' + esc(naira(inv.total)) + '</strong></div><div>Paid: ' + esc(naira(inv.paid)) + '</div><div class="grand">Balance: ' + esc(naira(inv.outstanding)) + '</div></div></div></div>' +
      '<div><div class="card"><h3>Payments</h3><p class="sub">Paid ' + esc(naira(inv.paid)) + ' of ' + esc(naira(inv.total)) + '.</p>' +
      (caps.canPayment && inv.status !== 'paid' ? '<button class="btn ghost sm" id="payB2">+ Add payment</button>' : '<p class="sub">No further payment due.</p>') + '</div>' +
      '<div class="card"><h3>Claim / payer</h3><p class="sub">' + esc(inv.payer) + ' · no claim attached.</p></div></div></div>',
  })

  function pay() {
    openPaymentModal({
      invoice: inv,
      onSuccess: () => { InvoiceDetailView(app, params) },
    })
  }
  wireKebabs(app, (rowId, action) => {
    if (action === 'pay') pay()
    if (action === 'delete') {
      confirmDelete('invoice ' + (inv.invoiceId || ''), () => deleteInvoice(rowId), () => { window.location.hash = '#/billing' })
    }
  })
  wireToast(app)
}
