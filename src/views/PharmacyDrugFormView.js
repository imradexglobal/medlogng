// Add or edit a catalogue drug — full page (replaces the add/adjust modals).
import { shell, setPage, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  createDrug, updateDrug, getDrug, listOrgDrugs, findDrugNameMatches,
} from '../services/pharmacyService.js'
import { onCleanup } from '../lib/lifecycle.js'
import {
  generateSku, drugCodeError, strengthError, packSizeError,
} from '../utils/sku.js'
import { esc } from '../utils/sanitize.js'
import { delBtn, wireDelButtons } from './deleteUi.js'
import { deleteDrug } from '../services/deleteService.js'
import { navigate } from '../router.js'

const UNITS = ['tabs', 'caps', 'vials', 'sachets', 'ml', 'ampoules']

export async function PharmacyDrugFormView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const drugId = params.id
  const isEdit = !!drugId

  shell(app, {
    active: '/pharmacy',
    title: isEdit ? 'Edit medicine' : 'Add medicine',
    subtitle: isEdit ? 'Change stock, price and batch details' : 'Create a new catalogue item',
    actions: '<a class="btn ghost" href="#/pharmacy">← Back to pharmacy</a>',
    body: '<div class="card" id="pdf-form"></div>',
  })

  const formEl = document.getElementById('pdf-form')
  if (!formEl) return

  let drug = null
  let similarAcknowledged = false
  let nameCheckTimer = null
  let nameCheckSeq = 0

  async function loadDrug() {
    if (!drugId) return
    try {
      drug = await getDrug(drugId)
      if (!drug) {
        toast('Drug not found')
        navigate('/pharmacy')
        return
      }
      renderForm(drug)
    } catch (e) {
      toast('Could not load drug: ' + (e?.message || e))
      navigate('/pharmacy')
    }
  }

  function setHint(cls, msg) {
    const hint = document.querySelector('#pdfFields [data-hint="name"]')
    if (!hint) return
    hint.className = 'fldhint' + (cls ? ' ' : '') + (cls || '')
    hint.textContent = msg || ''
    hint.hidden = !msg
  }

  async function checkNameLive(name) {
    const seq = ++nameCheckSeq
    const trimmed = (name || '').trim()
    if (trimmed.length < 2) { setHint('', ''); return }
    setHint('', 'Checking…')
    try {
      const { exact, similar } = await findDrugNameMatches(activeOrg, trimmed)
      if (seq !== nameCheckSeq) return
      if (exact && (!drug || exact.id !== drug.id)) {
        setHint('bad', 'Already exists: "' + exact.name + '". Choose a different name.')
      } else if (similar.length > 0 && !similar.some((s) => drug && s.id === drug.id)) {
        setHint('warn', 'Similar to "' + similar[0].name + '" — double-check the spelling.')
      } else {
        setHint('ok', 'No match found — this name is free.')
      }
    } catch {
      if (seq !== nameCheckSeq) return
      setHint('', '')
    }
  }

  function renderForm(d) {
    const sku = d.sku || generateSku(d.drug_code, d.strength, d.pack_size)
    const purchasePrice = Number(d.purchase_price || 0)
    const sellPrice = Number(d.price || 0)
    const margin = sellPrice > 0 && purchasePrice > 0
      ? (((sellPrice - purchasePrice) / sellPrice) * 100).toFixed(0)
      : '—'

    formEl.innerHTML =
      '<h2 style="margin:0 0 10px;font-size:1.1rem">' + (isEdit ? 'Edit ' + esc(d.name) : 'New catalogue item') + '</h2>' +
      '<form id="pdfForm" novalidate>' +
      '<div class="fgrid" id="pdfFields">' +
      '<label class="fld"><span>Drug name *</span>' +
      '<input class="input" name="name" placeholder="e.g. Enrofloxacin" value="' + esc(d.name || '') + '" />' +
      '<small class="fldhint" data-hint="name" hidden></small></label>' +

      '<label class="fld"><span>Drug code *</span>' +
      '<input class="input" name="drug_code" placeholder="PCM (3–6 chars)" value="' + esc(d.drug_code || '') + '" /></label>' +

      '<label class="fld"><span>Strength *</span>' +
      '<input class="input" name="strength" placeholder="e.g. 500mg" value="' + esc(d.strength || '') + '" /></label>' +

      '<label class="fld"><span>Pack size *</span>' +
      '<input class="input" name="pack_size" placeholder="e.g. 10" value="' + esc(d.pack_size || '') + '" /></label>' +

      '<label class="fld"><span>SKU</span>' +
      '<input class="input ro" name="sku" readonly value="' + esc(sku) + '" /></label>' +

      '<label class="fld"><span>Unit</span>' +
      '<select class="input" name="unit">' +
      UNITS.map((u) => '<option value="' + esc(u) + '"' + (d.unit === u ? ' selected' : '') + '>' + esc(u) + '</option>').join('') +
      '</select></label>' +

      '<label class="fld"><span>Purchase price ₦ (what you paid)</span>' +
      '<input class="input" type="number" name="purchase_price" step="0.01" min="0" placeholder="0.00" value="' + esc(purchasePrice > 0 ? purchasePrice.toFixed(2) : '') + '" /></label>' +

      '<label class="fld"><span>Selling price ₦ (what you charge)</span>' +
      '<input class="input" type="number" name="price" step="0.01" min="0" placeholder="0.00" value="' + esc(sellPrice > 0 ? sellPrice.toFixed(2) : '') + '" /></label>' +

      '<label class="fld"><span>Profit margin</span>' +
      '<input class="input ro" name="margin" readonly value="' + (typeof margin === 'number' ? margin + '%' : margin) + '" /></label>' +

      '<label class="fld"><span>Opening stock</span>' +
      '<input class="input" type="number" name="stock" min="0" placeholder="0" value="' + (isEdit ? esc(String(d.stock || 0)) : '') + '" /></label>' +

      '<label class="fld"><span>Batch</span>' +
      '<input class="input" name="batch" placeholder="e.g. B-001" value="' + esc(d.batch || '') + '" /></label>' +

      '<label class="fld"><span>Expiry (YYYY-MM-DD)</span>' +
      '<input class="input" type="date" name="expiry" value="' + esc(d.expiry || '') + '" /></label>' +

      '<label class="fld"><span>Supplier</span>' +
      '<input class="input" name="supplier" placeholder="Optional" value="' + esc(d.supplier || '') + '" /></label>' +

      '</div>' +
      '<p id="pdfError" style="color:var(--emr-bad);font-size:.8rem;min-height:16px;margin:8px 0 0"></p>' +
      '<div class="mrow">' +
      '<button class="btn ghost" type="button" data-cancel>Cancel</button>' +
      '<button class="btn" type="submit">' + (isEdit ? 'Save changes →' : 'Save item →') + '</button>' +
      (isEdit ? '<button class="btn danger" type="button" data-delete>Delete item</button>' : '') +
      '</div>' +
      '</form>'

    const form = document.getElementById('pdfForm')
    const nameInput = form.querySelector('[name="name"]')

    // Live SKU preview as the user types code/strength/pack size.
    function refreshSku() {
      const vals = collectValues()
      const skuEl = form.querySelector('[name="sku"]')
      const marginEl = form.querySelector('[name="margin"]')
      if (skuEl) skuEl.value = generateSku(vals.drug_code, vals.strength, vals.pack_size) || ''
      const pp = Number(vals.purchase_price || 0)
      const sp = Number(vals.price || 0)
      let m = '—'
      if (sp > 0 && pp > 0) m = (((sp - pp) / sp) * 100).toFixed(0) + '%'
      if (marginEl) marginEl.value = m
    }

    form.querySelectorAll('[name]').forEach((el) => {
      el.oninput = () => {
        if (el.name === 'name') {
          clearTimeout(nameCheckTimer)
          nameCheckTimer = setTimeout(() => checkNameLive(el.value), 600)
          similarAcknowledged = false
        }
        refreshSku()
      }
      el.onchange = refreshSku
    })

    if (nameInput) {
      nameInput.onblur = () => {
        clearTimeout(nameCheckTimer)
        checkNameLive(nameInput.value)
      }
    }

    form.onsubmit = async (e) => {
      e.preventDefault()
      const btn = form.querySelector('button[type="submit"]')
      const vals = collectValues()
      const errEl = document.getElementById('pdfError')
      errEl.textContent = ''
      btn.disabled = true
      btn.textContent = 'Saving…'

      try {
        const codeErr = drugCodeError(vals.drug_code)
        if (codeErr) throw new Error(codeErr)
        const strErr = strengthError(vals.strength)
        if (strErr) throw new Error(strErr)
        const packErr = packSizeError(vals.pack_size)
        if (packErr) throw new Error(packErr)
        if (!vals.name) throw new Error('Drug name is required.')

        const sku = generateSku(vals.drug_code, vals.strength, vals.pack_size)
        if (!sku) throw new Error('Could not generate SKU. Check drug code, strength, and pack size.')

        const { exact, similar } = await findDrugNameMatches(activeOrg, vals.name)
        if (exact && (!drug || exact.id !== drug.id)) {
          throw new Error('A drug with this name already exists: "' + exact.name + '". Choose a different name.')
        }
        if (similar.length > 0 && !similar.some((s) => drug && s.id === drug.id) && !similarAcknowledged) {
          similarAcknowledged = true
          throw new Error('Similar drug name(s) found. Click Save again to proceed.')
        }

        if (isEdit) {
          await updateDrug(drug.id, {
            name: vals.name,
            drug_code: vals.drug_code.trim().toUpperCase(),
            strength: vals.strength,
            pack_size: vals.pack_size,
            sku,
            unit: vals.unit || 'tabs',
            price: Number(vals.price) || 0,
            purchase_price: Number(vals.purchase_price) || 0,
            stock: Number(vals.stock) || 0,
            batch: vals.batch || '',
            expiry: vals.expiry || '',
            status: (Number(vals.stock) || 0) === 0 ? 'Out' : ((Number(vals.stock) || 0) < 20 ? 'Low' : 'OK'),
            supplier: vals.supplier || '',
          })
          toast('Saved ' + vals.name)
        } else {
          await createDrug({
            name: vals.name,
            drug_code: vals.drug_code.trim().toUpperCase(),
            strength: vals.strength,
            pack_size: vals.pack_size,
            sku,
            unit: vals.unit || 'tabs',
            price: Number(vals.price) || 0,
            purchase_price: Number(vals.purchase_price) || 0,
            stock: Number(vals.stock) || 0,
            batch: vals.batch || '',
            expiry: vals.expiry || '',
            supplier: vals.supplier || '',
          })
          toast('Drug added · SKU ' + sku)
        }
        navigate('/pharmacy')
      } catch (e) {
        errEl.textContent = e?.message || 'Something went wrong. Please retry.'
        btn.disabled = false
        btn.textContent = isEdit ? 'Save changes →' : 'Save item →'
      }
    }

    form.querySelector('[data-cancel]').onclick = () => navigate('/pharmacy')

    const delBtnEl = form.querySelector('[data-delete]')
    if (delBtnEl) {
      delBtnEl.onclick = async () => {
        if (!window.confirm('Delete "' + esc(d.name) + '" from the catalogue? This cannot be undone.')) return
        try {
          await deleteDrug(d.id, 'medicine ' + d.name)
          toast('Deleted ' + d.name)
          navigate('/pharmacy')
        } catch (e) {
          toast('Could not delete: ' + (e?.message || e))
        }
      }
    }
  }

  function collectValues() {
    const values = {}
    formEl.querySelectorAll('#pdfFields [name]').forEach((el) => {
      values[el.name] = String(el.value || '').trim()
    })
    return values
  }

  if (isEdit) {
    loadDrug()
  } else {
    renderForm({
      name: '', drug_code: '', strength: '', pack_size: '', unit: 'tabs',
      purchase_price: 0, price: 0, stock: 0, batch: '', expiry: '', supplier: '',
    })
  }

  wireToast(app)
  onCleanup(() => {
    if (nameCheckTimer) clearTimeout(nameCheckTimer)
  })
}
