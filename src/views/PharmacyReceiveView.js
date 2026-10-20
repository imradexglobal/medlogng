// Receive batch — full page (replaces the receive modal).
// Records purchase (unit) cost so profit can be tracked against the selling price.
import { shell, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import { listOrgDrugs, receiveBatch } from '../services/pharmacyService.js'
import { myPharmacyCaps } from '../services/pharmacyService.js'
import { onCleanup } from '../lib/lifecycle.js'
import { esc } from '../utils/sanitize.js'
import { navigate } from '../router.js'

export async function PharmacyReceiveView(app) {
  const { activeOrg } = authStore.getState()
  const caps = myPharmacyCaps()

  if (!caps.canManageInventory) {
    shell(app, {
      active: '/pharmacy',
      title: 'Receive batch',
      subtitle: 'Not authorised',
      actions: '<a class="btn ghost" href="#/pharmacy">← Back to pharmacy</a>',
      body: '<div class="card"><p class="sub">Your role cannot receive stock. Ask an administrator.</p></div>',
    })
    return
  }

  shell(app, {
    active: '/pharmacy',
    title: 'Receive batch',
    subtitle: 'Add incoming stock to a catalogue item',
    actions: '<a class="btn ghost" href="#/pharmacy">← Back to pharmacy</a>',
    body: '<div class="card" id="prv-form"></div>',
  })

  const formEl = document.getElementById('prv-form')
  if (!formEl) return

  let drugs = []

  async function load() {
    try {
      drugs = await listOrgDrugs(activeOrg)
      render()
    } catch (e) {
      toast('Could not load drugs: ' + (e?.message || e))
    }
  }

  function render() {
    const options = drugs.map((d) => ({
      value: d.id,
      label: d.name + ' (on hand: ' + Number(d.stock || 0) + ' · current cost ₦' + Number(d.purchase_price || 0).toFixed(2) + ' · sell ₦' + Number(d.price || 0).toFixed(2) + ')',
    }))

    formEl.innerHTML =
      '<h2 style="margin:0 0 10px;font-size:1.1rem">Receive batch</h2>' +
      '<form id="prvForm" novalidate>' +
      '<div class="fgrid">' +
      '<label class="fld"><span>Medicine *</span>' +
      '<select class="input" name="drugId">' +
      options.map((o) => '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>').join('') +
      '</select></label>' +

      '<label class="fld"><span>Quantity received *</span>' +
      '<input class="input" type="number" name="qty" min="1" placeholder="100" /></label>' +

      '<label class="fld"><span>Unit cost ₦ (purchase price) *</span>' +
      '<input class="input" type="number" name="unit_cost" step="0.01" min="0" placeholder="0.00" /></label>' +

      '<label class="fld"><span>Batch number *</span>' +
      '<input class="input" name="batch" placeholder="e.g. B-001" /></label>' +

      '<label class="fld"><span>Expiry (YYYY-MM-DD) *</span>' +
      '<input class="input" type="date" name="expiry" /></label>' +

      '<label class="fld"><span>Supplier</span>' +
      '<input class="input" name="supplier" placeholder="Optional" /></label>' +

      '<label class="fld"><span>Invoice ref</span>' +
      '<input class="input" name="invoice_ref" placeholder="Optional" /></label>' +

      '</div>' +
      '<p id="prvError" style="color:var(--emr-bad);font-size:.8rem;min-height:16px;margin:8px 0 0"></p>' +
      '<div class="mrow">' +
      '<button class="btn ghost" type="button" data-cancel>Cancel</button>' +
      '<button class="btn" type="submit">Receive stock →</button>' +
      '</div>' +
      '</form>' +
      '<p class="sub" style="margin-top:12px">The unit cost you enter becomes this item\'s purchase price. Profit = selling price − purchase price.</p>'

    const form = document.getElementById('prvForm')
    form.onsubmit = async (e) => {
      e.preventDefault()
      const btn = form.querySelector('button[type="submit"]')
      const errEl = document.getElementById('prvError')
      const vals = {}
      form.querySelectorAll('[name]').forEach((el) => { vals[el.name] = String(el.value || '').trim() })
      errEl.textContent = ''
      btn.disabled = true
      btn.textContent = 'Receiving…'

      try {
        const qty = Number(vals.qty)
        if (!(qty > 0)) throw new Error('Quantity must be greater than zero.')
        if (!vals.batch) throw new Error('Batch number is required.')
        if (!vals.expiry) throw new Error('Expiry date is required.')

        const res = await receiveBatch({
          drugId: vals.drugId,
          qty,
          batch: vals.batch,
          expiry: vals.expiry,
          supplier: vals.supplier,
          invoice_ref: vals.invoice_ref,
          unit_cost: vals.unit_cost !== '' ? Number(vals.unit_cost) : 0,
        })
        const drug = drugs.find((d) => d.id === vals.drugId)
        toast('Received ' + qty + ' × ' + (drug?.name || 'item') + ' — on hand now ' + res.newStock + ' · cost ₦' + Number(vals.unit_cost || 0).toFixed(2))
        navigate('/pharmacy')
      } catch (e) {
        errEl.textContent = e?.message || 'Something went wrong. Please retry.'
        btn.disabled = false
        btn.textContent = 'Receive stock →'
      }
    }

    form.querySelector('[data-cancel]').onclick = () => navigate('/pharmacy')
  }

  load()
  wireToast(app)
  onCleanup(() => {})
}
