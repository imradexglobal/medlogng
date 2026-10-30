// Pharmacy Direct / Walk-in Sale Modal.
// Allows dispensing and selling drugs directly to non-patients / walk-in customers
// without requiring an existing consultation or registered patient record.
// Automatically generates the invoice, records payment, and prints an official receipt.

import { openModal, closeModal, toast } from './shell.js'
import { dispense } from '../services/pharmacyService.js'
import { createInvoiceFromLines, recordPayment } from '../services/billingService.js'
import { printDocument } from '../lib/print.js'
import { receiptPrintHtml } from '../lib/billingPrint.js'
import { authStore } from '../store/authStore.js'
import { naira } from '../utils/format.js'
import { esc } from '../utils/sanitize.js'
import { friendlyWriteError } from '../utils/errors.js'

export function openWalkInSaleModal({ drugs = [], onSuccess }) {
  const availableDrugs = drugs.filter((d) => Number(d.stock || 0) > 0)
  if (!availableDrugs.length) {
    toast('No drugs currently in stock to sell.')
    return
  }

  // Active state
  let customerName = 'Walk-in Customer'
  let customerContact = ''
  let notes = ''
  let paymentMethod = 'Cash'
  let paymentRef = ''
  let printReceipt = true

  let lines = [
    {
      drugId: availableDrugs[0].id,
      qty: 1,
      unitPrice: Number(availableDrugs[0].price || 0),
    },
  ]

  function calcTotal() {
    return lines.reduce((sum, l) => sum + (Number(l.unitPrice || 0) * Number(l.qty || 0)), 0)
  }

  function renderModalHtml() {
    const total = calcTotal()

    const lineRows = lines.map((line, idx) => {
      const selectedDrug = availableDrugs.find((d) => d.id === line.drugId) || availableDrugs[0]
      const maxStock = Number(selectedDrug.stock || 0)
      const lineTot = Number(line.unitPrice || 0) * Number(line.qty || 0)

      const options = availableDrugs.map((d) =>
        '<option value="' + esc(d.id) + '"' + (d.id === line.drugId ? ' selected' : '') + '>' +
        esc(d.name) + (d.strength ? ' (' + esc(d.strength) + ')' : '') +
        ' · Stock: ' + esc(String(d.stock)) + ' ' + esc(d.unit || 'tabs') +
        ' · ₦' + Number(d.price || 0).toLocaleString('en-NG') +
        '</option>'
      ).join('')

      return '<div class="walkin-line" data-idx="' + idx + '" style="display:grid;grid-template-columns:3fr 1fr 1fr 1fr auto;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid #f1f5f9">' +
        '<div>' +
          '<label style="font-size:.78rem;font-weight:600;display:block;margin-bottom:2px">Medicine</label>' +
          '<select class="input sm drug-sel" data-idx="' + idx + '" style="width:100%">' + options + '</select>' +
        '</div>' +
        '<div>' +
          '<label style="font-size:.78rem;font-weight:600;display:block;margin-bottom:2px">Qty (max ' + maxStock + ')</label>' +
          '<input class="input sm qty-inp" data-idx="' + idx + '" type="number" min="1" max="' + maxStock + '" value="' + esc(String(line.qty)) + '" style="width:100%" />' +
        '</div>' +
        '<div>' +
          '<label style="font-size:.78rem;font-weight:600;display:block;margin-bottom:2px">Price (₦)</label>' +
          '<input class="input sm price-inp" data-idx="' + idx + '" type="number" step="0.01" min="0" value="' + esc(String(line.unitPrice)) + '" style="width:100%" />' +
        '</div>' +
        '<div style="text-align:right">' +
          '<label style="font-size:.78rem;font-weight:600;display:block;margin-bottom:2px">Total</label>' +
          '<strong class="line-tot" style="font-size:.9rem">' + naira(lineTot) + '</strong>' +
        '</div>' +
        '<div>' +
          (lines.length > 1
            ? '<button type="button" class="btn danger sm rem-line-btn" data-idx="' + idx + '" title="Remove line" style="margin-top:16px;padding:4px 8px">✕</button>'
            : '<span style="display:inline-block;width:28px"></span>') +
        '</div>' +
      '</div>'
    }).join('')

    return '' +
      '<div style="max-height:75vh;overflow-y:auto;padding-right:4px">' +
        // Customer Information
        '<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin-bottom:14px">' +
          '<div style="font-weight:700;font-size:.88rem;color:#0f172a;margin-bottom:8px">Customer / Patient Details (Customizable)</div>' +
          '<div style="display:grid;grid-template-columns:2fr 1fr;gap:10px">' +
            '<div>' +
              '<label class="fld"><span>Customer Name / Identification *</span>' +
              '<input class="input" id="wkCustomerName" placeholder="e.g. Walk-in Customer, Alhaji Bello, Mrs. Musa…" value="' + esc(customerName) + '" />' +
              '</label>' +
            '</div>' +
            '<div>' +
              '<label class="fld"><span>Phone / Contact (Optional)</span>' +
              '<input class="input" id="wkCustomerPhone" placeholder="e.g. 0803 123 4567" value="' + esc(customerContact) + '" />' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div style="margin-top:6px">' +
            '<label class="fld"><span>Clinical / Sale Note (Optional)</span>' +
            '<input class="input" id="wkNotes" placeholder="e.g. OTC cold medication, verified dosage…" value="' + esc(notes) + '" />' +
            '</label>' +
          '</div>' +
        '</div>' +

        // Drug lines section
        '<div style="margin-bottom:12px">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
            '<strong style="font-size:.9rem">Dispensed Medicines (' + lines.length + ')</strong>' +
            '<button type="button" class="btn ghost sm" id="wkAddLineBtn">+ Add another medicine</button>' +
          '</div>' +
          lineRows +
        '</div>' +

        // Summary and payment details
        '<div style="background:#f0fdf4;border:1.5px solid #86efac;border-radius:6px;padding:12px;margin-top:14px">' +
          '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px">' +
            '<span style="font-size:1rem;font-weight:700">Total Amount:</span>' +
            '<strong id="wkGrandTotal" style="font-size:1.4rem;color:#166534">' + naira(total) + '</strong>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 2fr;gap:10px">' +
            '<div>' +
              '<label class="fld"><span>Payment Method</span>' +
              '<select class="input" id="wkMethod">' +
                '<option value="Cash"' + (paymentMethod === 'Cash' ? ' selected' : '') + '>Cash</option>' +
                '<option value="POS"' + (paymentMethod === 'POS' ? ' selected' : '') + '>POS</option>' +
                '<option value="Transfer"' + (paymentMethod === 'Transfer' ? ' selected' : '') + '>Bank Transfer</option>' +
              '</select>' +
              '</label>' +
            '</div>' +
            '<div>' +
              '<label class="fld"><span>Reference (POS RRN / Transfer ID)</span>' +
              '<input class="input" id="wkRef" placeholder="e.g. Terminal RRN, Bank Ref…" value="' + esc(paymentRef) + '" />' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div style="margin-top:8px">' +
            '<label style="display:inline-flex;align-items:center;gap:8px;font-size:.88rem;cursor:pointer">' +
              '<input type="checkbox" id="wkPrintReceipt"' + (printReceipt ? ' checked' : '') + ' />' +
              '<span><strong>Print Official Payment Receipt</strong> immediately upon completion</span>' +
            '</label>' +
          '</div>' +
        '</div>' +

        // Action buttons
        '<div class="mrow" style="margin-top:16px;display:flex;justify-content:flex-end;gap:10px">' +
          '<button type="button" class="btn ghost" id="wkCancelBtn">Cancel</button>' +
          '<button type="button" class="btn" id="wkSubmitBtn" style="background:#0d9488;color:#fff">Complete Sale &amp; Dispense →</button>' +
        '</div>' +
      '</div>'
  }

  function bindEvents() {
    const nameInp = document.getElementById('wkCustomerName')
    if (nameInp) nameInp.oninput = (e) => { customerName = e.target.value }

    const phoneInp = document.getElementById('wkCustomerPhone')
    if (phoneInp) phoneInp.oninput = (e) => { customerContact = e.target.value }

    const notesInp = document.getElementById('wkNotes')
    if (notesInp) notesInp.oninput = (e) => { notes = e.target.value }

    const methodSel = document.getElementById('wkMethod')
    if (methodSel) methodSel.onchange = (e) => { paymentMethod = e.target.value }

    const refInp = document.getElementById('wkRef')
    if (refInp) refInp.oninput = (e) => { paymentRef = e.target.value }

    const printChk = document.getElementById('wkPrintReceipt')
    if (printChk) printChk.onchange = (e) => { printReceipt = e.target.checked }

    // Drug selects
    document.querySelectorAll('.drug-sel').forEach((sel) => {
      sel.onchange = (e) => {
        const idx = Number(e.target.getAttribute('data-idx'))
        const newDrugId = e.target.value
        const drug = availableDrugs.find((d) => d.id === newDrugId)
        if (drug) {
          lines[idx].drugId = newDrugId
          lines[idx].unitPrice = Number(drug.price || 0)
          lines[idx].qty = Math.min(lines[idx].qty || 1, Number(drug.stock || 1))
          refreshModal()
        }
      }
    })

    // Quantity inputs
    document.querySelectorAll('.qty-inp').forEach((inp) => {
      inp.onchange = (e) => {
        const idx = Number(e.target.getAttribute('data-idx'))
        const drug = availableDrugs.find((d) => d.id === lines[idx].drugId)
        const maxStock = drug ? Number(drug.stock || 0) : 9999
        let q = Number(e.target.value) || 1
        if (q < 1) q = 1
        if (q > maxStock) {
          q = maxStock
          toast('Quantity adjusted to max available stock (' + maxStock + ')')
        }
        lines[idx].qty = q
        refreshModal()
      }
    })

    // Price inputs
    document.querySelectorAll('.price-inp').forEach((inp) => {
      inp.onchange = (e) => {
        const idx = Number(e.target.getAttribute('data-idx'))
        let p = Number(e.target.value) || 0
        if (p < 0) p = 0
        lines[idx].unitPrice = p
        refreshModal()
      }
    })

    // Remove buttons
    document.querySelectorAll('.rem-line-btn').forEach((b) => {
      b.onclick = (e) => {
        const idx = Number(e.currentTarget.getAttribute('data-idx'))
        lines.splice(idx, 1)
        refreshModal()
      }
    })

    // Add line button
    const addLineBtn = document.getElementById('wkAddLineBtn')
    if (addLineBtn) {
      addLineBtn.onclick = () => {
        // Pick next drug not already in lines, or first available
        const unused = availableDrugs.find((d) => !lines.some((l) => l.drugId === d.id)) || availableDrugs[0]
        lines.push({
          drugId: unused.id,
          qty: 1,
          unitPrice: Number(unused.price || 0),
        })
        refreshModal()
      }
    }

    // Cancel
    const cancelBtn = document.getElementById('wkCancelBtn')
    if (cancelBtn) cancelBtn.onclick = closeModal

    // Submit
    const submitBtn = document.getElementById('wkSubmitBtn')
    if (submitBtn) {
      submitBtn.onclick = async () => {
        const trimmedName = String(customerName || '').trim()
        if (!trimmedName) {
          toast('Please enter a customer or patient name.')
          return
        }

        if (!lines.length) {
          toast('Please add at least one medicine.')
          return
        }

        // Validate stock
        for (const l of lines) {
          const d = availableDrugs.find((x) => x.id === l.drugId)
          if (!d) {
            toast('Selected medicine not found in inventory.')
            return
          }
          if (l.qty > Number(d.stock || 0)) {
            toast('Insufficient stock for ' + d.name + ' (available: ' + d.stock + ', requested: ' + l.qty + ')')
            return
          }
        }

        submitBtn.disabled = true
        submitBtn.textContent = 'Processing sale…'

        try {
          const totalAmount = calcTotal()
          const totalKobo = Math.round(totalAmount * 100)
          const fullCustomerLabel = customerContact ? (trimmedName + ' · ' + customerContact) : trimmedName

          // 1. Dispense drugs (updates stock and ledger)
          const dispResult = await dispense({
            items: lines.map((l) => ({
              drugId: l.drugId,
              requestedQty: Number(l.qty),
            })),
            patientId: 'walk-in',
            patientName: fullCustomerLabel,
            medicationRequestId: '',
          })

          // 2. Create invoice
          const invLines = lines.map((l) => {
            const d = availableDrugs.find((x) => x.id === l.drugId)
            return {
              label: (d ? d.name : 'Medicine') + (d?.strength ? ' ' + d.strength : ''),
              category: 'Pharmacy',
              unit_price_kobo: Math.round(Number(l.unitPrice) * 100),
              qty: Number(l.qty),
            }
          })

          const invoice = await createInvoiceFromLines({
            patient_id: 'walk-in',
            patient_name: fullCustomerLabel,
            payer: 'Self-pay (Walk-in)',
            source_type: 'pharmacy_sale',
            source_id: dispResult.dispensationId,
            lines: invLines,
          })

          // 3. Record payment
          const payResult = await recordPayment({
            invoice_id: invoice.id,
            amount_kobo: totalKobo,
            method: paymentMethod || 'Cash',
            reference: (paymentRef || '').trim(),
            notes: notes ? ('Walk-in sale: ' + notes) : 'Walk-in pharmacy sale',
          })

          closeModal()
          toast('Sale complete — ₦' + totalAmount.toLocaleString('en-NG') + ' received for ' + trimmedName)

          // 4. Print official receipt if requested
          if (printReceipt) {
            try {
              const orgName = authStore.getState().activeOrgName || 'Hospital'
              const staffName = authStore.getState().user?.displayName || 'Pharmacist'
              const receiptHtml = receiptPrintHtml({
                hospitalName: orgName,
                payment: {
                  receipt_number: payResult.receiptNumber,
                  paid_at: Date.now(),
                  amount_kobo: totalKobo,
                  method: paymentMethod || 'Cash',
                  reference: (paymentRef || '').trim(),
                  notes: notes,
                  paid_by: staffName,
                },
                invoice: {
                  invoiceId: invoice.id,
                  patientName: fullCustomerLabel,
                  payer: 'Self-pay (Walk-in)',
                  outstanding: 0,
                },
                receivedBy: staffName,
              })
              printDocument('Receipt-' + payResult.receiptNumber, receiptHtml)
            } catch (pErr) {
              console.warn('[pharmacy] receipt printing failed:', pErr?.message)
            }
          }

          if (onSuccess) onSuccess()
        } catch (err) {
          submitBtn.disabled = false
          submitBtn.textContent = 'Complete Sale & Dispense →'
          toast('Sale failed: ' + friendlyWriteError(err))
        }
      }
    }
  }

  function refreshModal() {
    const body = document.getElementById('modalBody')
    if (!body) return
    body.innerHTML = renderModalHtml()
    bindEvents()
  }

  openModal('Walk-in Pharmacy Sale / Non-patient Dispense', renderModalHtml(), { wide: true })
  bindEvents()
}
