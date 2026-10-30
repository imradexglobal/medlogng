// Dispense a prescription — full page (replaces the request-detail modal).
import { shell, statusBadge, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgDrugs, listOrgRequests, dispense, reverseDispenseIssue, myPharmacyCaps,
} from '../services/pharmacyService.js'
import { createInvoiceFromLines } from '../services/billingService.js'
import { getPatient } from '../services/patientService.js'
import * as R from '../features/pharmacy/requests.js'
import { onCleanup } from '../lib/lifecycle.js'
import { friendlyWriteError } from '../utils/errors.js'
import { esc } from '../utils/sanitize.js'
import { navigate } from '../router.js'

export async function PharmacyRequestView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const caps = myPharmacyCaps()
  const reqId = params.id

  if (!caps.canDispense) {
    shell(app, {
      active: '/pharmacy',
      title: 'Prescription',
      subtitle: 'Not authorised',
      actions: '<a class="btn ghost" href="#/pharmacy">← Back to pharmacy</a>',
      body: '<div class="card"><p class="sub">Your role cannot dispense medication.</p></div>',
    })
    return
  }

  shell(app, {
    active: '/pharmacy',
    title: 'Prescription',
    subtitle: 'Issue medicines and track stock',
    actions: '<a class="btn ghost" href="#/pharmacy">← Back to pharmacy</a>',
    body: '<div class="card" id="prv-form"></div>',
  })

  const formEl = document.getElementById('prv-form')
  if (!formEl) return

  let drugs = []
  let req = null

  async function load() {
    try {
      const [d, reqs] = await Promise.all([
        listOrgDrugs(activeOrg),
        listOrgRequests(activeOrg),
      ])
      drugs = d
      req = reqs.find((r) => r.id === reqId)
      if (!req) {
        toast('Prescription not found')
        navigate('/pharmacy')
        return
      }
      render()
    } catch (e) {
      toast('Could not load prescription: ' + friendlyWriteError(e))
    }
  }

  function render() {
    const anyOwed = req.items.some((l) => !l.external && R.lineOutstanding(l) > 0)
    const rows = req.items.map((l) => {
      const owed = R.lineOutstanding(l)
      const drug = l.drug_id ? drugs.find((d) => d.id === l.drug_id) : null
      const onHand = drug ? Number(drug.stock || 0) : 0
      const short = owed > 0 && (!drug || onHand < owed)
      const settled = owed === 0

      if (l.external) {
        return '<tr style="opacity:.7">' +
          '<td><strong>' + esc(l.medicine || 'Unnamed item') + '</strong> <span class="pill info">external</span>' +
          (l.sku ? '<div class="mut">' + esc(l.sku) + '</div>' : '') + '</td>' +
          '<td>' + esc(l.dosage || '—') + '</td>' +
          '<td>' + esc(R.toQty(l.quantity, 0)) + ' ' + esc(l.unit || '') + '</td>' +
          '<td>—</td><td>—</td>' +
          '<td><span class="mut">External pharmacy</span></td></tr>'
      }

      const reverseBtn = '<button type="button" class="btn ghost sm" data-reverse-line="' + esc(l.line_id) + '">↩ Reverse</button>'
      const issueCell = settled
        ? reverseBtn
        : (short
          ? '<span class="pill bad">only ' + esc(onHand) + ' on hand</span>'
          : '<input class="input" type="number" min="1" max="' + esc(owed) + '" value="' + esc(owed) +
            '" data-qty-for="' + esc(l.line_id) + '" style="width:96px" />') +
          (R.toQty(l.dispensed_qty, 0) > 0 ? ' ' + reverseBtn : '')

      return '<tr' + (settled ? ' style="opacity:.55"' : '') + '>' +
        '<td><strong>' + esc(l.medicine || 'Unnamed item') + '</strong>' +
        (l.sku ? '<div class="mut">' + esc(l.sku) + '</div>' : '') + '</td>' +
        '<td>' + esc(l.dosage || '—') + '</td>' +
        '<td>' + esc(R.toQty(l.quantity, 0)) + ' ' + esc(l.unit || '') + '</td>' +
        '<td>' + esc(R.toQty(l.dispensed_qty, 0)) + '</td>' +
        '<td>' + esc(owed) + '</td>' +
        '<td style="white-space:nowrap">' + issueCell + '</td></tr>'
    }).join('')

    formEl.innerHTML =
      '<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:14px;flex-wrap:wrap">' +
      '<h2 style="margin:0;font-size:1.1rem">Prescription — ' + esc(req.patientName || 'patient') + '</h2>' +
      '<span class="pill ' + (req.status === 'Dispensed' ? 'ok' : req.status === 'Partially dispensed' ? 'warn' : '') + '">' + esc(req.status) + '</span>' +
      (req.encounterId ? '<div class="mut" style="margin-left:auto">Encounter ' + esc(req.encounterId.slice(0, 10)) + '</div>' : '') +
      '</div>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Medicine</th><th>Dose</th><th>Prescribed</th><th>Issued</th><th>Owed</th><th>Issue now</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
      '<p class="sub" style="margin-top:8px">Issued quantities go straight to stock. An issued medicine can be reversed — the units return to the shelf and the line unlocks for the prescriber.</p>' +
      '<div class="mrow" style="margin-top:14px">' +
      '<a class="btn ghost" href="#/pharmacy">Close</a>' +
      (anyOwed ? '<button class="btn" id="reqDispense">Dispense selected lines →</button>' : '') +
      '</div>'

    formEl.querySelectorAll('[data-reverse-line]').forEach((b) => {
      b.onclick = async () => {
        const lineId = b.getAttribute('data-reverse-line')
        const line = req.items.find((l) => l.line_id === lineId)
        const issued = R.toQty(line?.dispensed_qty, 0)
        if (!window.confirm('Reverse ' + issued + ' × ' + (line?.medicine || 'this medicine') + '?\n\nThe units go back on the shelf and this medicine becomes editable again.')) return
        b.disabled = true
        try {
          const res = await reverseDispenseIssue({ requestId: req.id, lineId })
          toast('Reversed ' + res.qty + ' × ' + res.medicine + ' — ' + res.newStock + ' now on the shelf · prescription is ' + res.status)
          navigate('/pharmacy')
        } catch (err) {
          b.disabled = false
          toast('Could not reverse: ' + friendlyWriteError(err))
        }
      }
    })

    const dispenseBtn = document.getElementById('reqDispense')
    if (dispenseBtn) {
      dispenseBtn.onclick = async (e) => {
        const btn = e.currentTarget
        const issued = []
        for (const l of req.items) {
          const owed = R.lineOutstanding(l)
          if (owed === 0) continue
          const box = document.querySelector('[data-qty-for="' + l.line_id + '"]')
          if (!box) continue
          const qty = Number(box.value)
          if (!Number.isFinite(qty) || qty <= 0) continue
          if (qty > owed) { toast('Cannot issue more than the ' + owed + ' still owed for ' + l.medicine + '.'); return }
          issued.push({ drugId: l.drug_id, requestedQty: qty, lineId: l.line_id, medicine: l.medicine })
        }
        if (!issued.length) { toast('Enter a quantity on at least one line.'); return }
        const unresolved = issued.filter((i) => !i.drugId)
        if (unresolved.length) {
          toast('Not matched to catalogue: ' + unresolved.map((i) => i.medicine).join(', '))
          return
        }
        btn.disabled = true
        try {
          const res = await dispense({
            items: issued.map(({ drugId, requestedQty, lineId }) => ({ drugId, requestedQty, lineId })),
            patientId: req.patientId,
            patientName: req.patientName,
            medicationRequestId: req.id,
          })
          const p = res.requestProgress
          toast(p && p.outstanding === 0
            ? 'Prescription fully dispensed for ' + req.patientName
            : 'Issued ' + issued.reduce((n, i) => n + i.requestedQty, 0) + ' unit(s) — ' +
              (p ? p.outstanding : '?') + ' still owed')
          // Raise a billing invoice for the dispensed lines so the patient is charged.
          try {
            const pat = await getPatient(req.patientId).catch(() => null)
            const patientPayer = (pat && pat.payer) ? pat.payer : 'Self-pay'
            const lines = issued.map((i) => {
              const drug = drugs.find((d) => d.id === i.drugId)
              return {
                label: i.medicine || (drug ? drug.name : 'Medicine'),
                category: 'Pharmacy',
                unit_price_kobo: Math.round(Number(drug ? drug.price : 0) * 100),
                qty: i.requestedQty,
              }
            })
            await createInvoiceFromLines({
              patient_id: req.patientId,
              patient_name: req.patientName,
              payer: patientPayer,
              source_type: 'dispense',
              source_id: res.dispensationId,
              lines,
            })
            toast('Invoice raised for ' + req.patientName + ' (' + patientPayer + ')')
          } catch (e) {
            // Invoice failure must not roll back a successful dispense.
            console.warn('[pharmacy] invoice not raised:', e?.message)
          }
          navigate('/pharmacy')
        } catch (err) {
          btn.disabled = false
          toast('Could not dispense: ' + friendlyWriteError(err))
        }
      }
    }
  }

  load()
  wireToast(app)
  onCleanup(() => {})
}
