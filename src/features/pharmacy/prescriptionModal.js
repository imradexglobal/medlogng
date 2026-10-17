import { openModal } from '../../components/shell.js'
import { esc } from '../../utils/sanitize.js'
import { toQty } from './requests.js'

// Shared "write a prescription" modal used by every prescribing surface.
//
// One modal = one prescription SCRIPT. It holds exactly ONE input card: the
// clinician fills it, presses "Add to list", and the medicine is summarised as
// a row in the table underneath while the card clears itself for the next one.
// Rows are selectable for editing — "Edit" reloads a row into the card and the
// next "Add to list" writes it back in place — and everything is handed back in
// a single `onSubmit(rows)` call, so the whole script lands on one pharmacy
// order instead of one row per pill.
//
// Each entry offers two sources:
//   • Internal pharmacy — an in-house catalogue lot, validated against the stock
//     the clinician can see; the pharmacy later issues and decrements it.
//   • External pharmacy — a free-text medicine name for a drug the hospital
//     does not stock. External lines never touch in-house stock, so they are
//     excluded from stock checks, dispensing and every balance.
//
// When the catalogue is empty the external source is preselected, so a
// clinician can still prescribe with nothing on the shelf.
//
// `initialLines` seeds the table for ADJUSTING a script already on the record.
// A line the pharmacy has already issued (`dispensed_qty > 0`) is history: it
// sits in the table read-only, with no Edit/Remove, and is replayed untouched
// on submit — the lock is per medicine, so the rest of the script stays fully
// editable. Reversing that issue at the pharmacy drops `dispensed_qty` back to
// zero, which unlocks the row here.
//
// Each row handed to onSubmit is normalised:
//   { medicine, dosage, qty, instructions, external, [drug_id, sku, unit,
//     line_id, dispensed_qty] }
export function openPrescriptionModal({
  drugs = [],
  title = 'New prescription',
  submitLabel = 'Prescribe',
  hint = '',
  initialLines = [],
  onSubmit,
} = {}) {
  const options = drugs.map((d) => ({
    value: d.id,
    label: (d.name || 'Unnamed') + (d.strength ? ' ' + d.strength : '') +
      ' — ' + Number(d.stock || 0) + ' ' + (d.unit || 'tabs') + ' in stock',
  }))
  // A fresh card defaults to the source that can actually be filled: with an
  // empty catalogue that is the external one.
  const startExternal = options.length === 0

  // The script under construction. The table is a pure view of this array;
  // only the card above it holds transient, not-yet-added input.
  const rows = (initialLines || []).filter((l) => l && (l.medicine || l.drug_id))
  // Row index the card is currently editing, or -1 when it is collecting a new
  // medicine.
  let editing = -1

  const HIDE = 'display:none'

  function drugSelectHtml(line) {
    const chosen = line?.drug_id || ''
    const known = options.some((o) => o.value === chosen)
    // A pre-filled line whose lot has since left the catalogue must still show
    // the medicine it was written for rather than a blank box.
    const extra = (chosen && !known)
      ? [{ value: chosen, label: (line.medicine || chosen) + ' (no longer in catalogue)' }]
      : []
    const opts = [...extra, ...options]
      .map((o) => '<option value="' + esc(o.value) + '" data-label="' + esc(o.label) + '"' +
        (o.value === chosen ? ' selected' : '') + '>' + esc(o.label) + '</option>').join('')
    const filter = options.length > 1
      ? '<input class="input" style="margin-bottom:6px" data-rx-filter placeholder="Search in-house medicines…" autocomplete="off">'
      : ''
    return filter +
      '<select class="input" data-rx-drug>' +
      '<option value="">Choose a medicine…</option>' + opts + '</select>'
  }

  openModal(title,
    '<p class="sub" style="margin:0 0 10px">' +
      esc(hint || 'Add each medicine to the list below, then send them to the pharmacy as one prescription.') + '</p>' +
    '<div class="rx-card" data-rx-line style="border:1px solid var(--emr-line);border-radius:10px;padding:10px 12px 12px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">' +
        '<strong style="font-size:.72rem;letter-spacing:.05em;text-transform:uppercase;color:#64748b">Add medicine</strong>' +
        '<span class="pill info" id="rxEditing" style="display:none"></span>' +
      '</div>' +
      '<div class="fgrid">' +
        '<label class="fld full"><span>Source</span>' +
          '<select class="input" data-rx-source>' +
            '<option value="internal"' + (startExternal ? '' : ' selected') + '>Internal pharmacy (from hospital stock)</option>' +
            '<option value="external"' + (startExternal ? ' selected' : '') + '>External pharmacy (patient buys outside)</option>' +
          '</select></label>' +
        '<label class="fld full" data-rx-internal' + (startExternal ? ' style="' + HIDE + '"' : '') + '><span>Medicine (in-house stock)</span>' +
          drugSelectHtml(null) + '</label>' +
        '<label class="fld full" data-rx-external' + (startExternal ? '' : ' style="' + HIDE + '"') + '><span>Medicine name (external pharmacy)</span>' +
          '<input class="input" data-rx-name placeholder="e.g. Amlodipine 10mg" value=""></label>' +
        '<label class="fld"><span>Dosage</span>' +
          '<input class="input" data-rx-dosage placeholder="e.g. 1 tab daily" value=""></label>' +
        '<label class="fld"><span>Quantity</span>' +
          '<input class="input" data-rx-qty placeholder="e.g. 30" value=""></label>' +
        '<label class="fld full"><span>Instructions</span>' +
          '<input class="input" data-rx-instructions placeholder="e.g. after meals" value=""></label>' +
      '</div>' +
      '<div class="toolbar" style="margin:10px 0 0">' +
        '<button type="button" class="btn" id="rxAdd">Add to list</button>' +
        '<button type="button" class="btn ghost sm" id="rxCancelEdit" style="display:none">Cancel edit</button>' +
      '</div>' +
    '</div>' +
    '<div id="rxTableWrap" style="display:none;margin-top:14px">' +
      '<p class="eyebrow" style="margin:0 0 6px">Prescription list</p>' +
      '<div class="tblwrap"><table class="tbl">' +
        '<tr><th>#</th><th>Medicine</th><th>Dosage</th><th>Qty</th><th>Instructions</th><th>Issued</th><th></th></tr>' +
        '<tbody id="rxRows"></tbody>' +
      '</table></div>' +
    '</div>' +
    '<p id="rxError" style="color:var(--emr-bad);font-size:.8rem;min-height:16px;margin:8px 0 0"></p>' +
    '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
    '<button class="btn" id="rxSave">' + esc(submitLabel) + '</button></div>')

  const cardEl = document.querySelector('#modalBody [data-rx-line]')
  const errEl = document.getElementById('rxError')
  const addBtn = document.getElementById('rxAdd')
  const cancelEditBtn = document.getElementById('rxCancelEdit')
  const editPill = document.getElementById('rxEditing')
  const tableWrap = document.getElementById('rxTableWrap')
  const tbody = document.getElementById('rxRows')
  const saveBtn = document.getElementById('rxSave')

  // Only the medicine field matching the chosen source stays visible, so the
  // card cannot be read as asking for both at once.
  function applyVisibility() {
    const sel = cardEl.querySelector('[data-rx-source]')
    const external = sel ? sel.value === 'external' : startExternal
    const inside = cardEl.querySelector('[data-rx-internal]')
    const outside = cardEl.querySelector('[data-rx-external]')
    if (inside) inside.style.display = external ? HIDE : ''
    if (outside) outside.style.display = external ? '' : HIDE
  }

  // Long catalogues are unusable as a bare scroll list on a phone, so a typed
  // fragment narrows the options in place — the saved value is still the option
  // value, so filtering can never change what gets submitted.
  function wireFilter(box) {
    const sel = cardEl.querySelector('[data-rx-drug]')
    if (!sel) return
    const opts = Array.from(sel.options)
    box.oninput = () => {
      const q = box.value.trim().toLowerCase()
      const digits = q.replace(/\D/g, '')
      for (const o of opts) {
        const label = String(o.getAttribute('data-label') || o.textContent || '').toLowerCase()
        o.hidden = !(!q || (/[0-9]/.test(q) ? label.replace(/\D/g, '').includes(digits) : label.includes(q)))
      }
      if (sel.selectedOptions[0] && sel.selectedOptions[0].hidden) {
        const first = opts.find((o) => !o.hidden)
        sel.value = first ? first.value : ''
      }
    }
  }

  function clearFilter() {
    const box = cardEl.querySelector('[data-rx-filter]')
    if (!box) return
    box.value = ''
    box.oninput?.()
  }

  function field(sel) {
    const el = cardEl.querySelector(sel)
    return el ? String(el.value || '').trim() : ''
  }

  function focusFirst() {
    const externalVisible = (cardEl.querySelector('[data-rx-external]') || {}).style?.display !== HIDE
    const target = externalVisible
      ? cardEl.querySelector('[data-rx-name]')
      : (cardEl.querySelector('[data-rx-drug]') || cardEl.querySelector('[data-rx-dosage]'))
    try { target?.focus({ preventScroll: false }) } catch { /* not focusable */ }
  }

  // Read the card back as one line object, rejecting anything half-filled
  // instead of silently saving it. The row being edited keeps its identity, so
  // the edit lands on that line rather than appending a second one.
  function readCard() {
    const external = (cardEl.querySelector('[data-rx-source]') || {}).value === 'external'
    const drugId = field('[data-rx-drug]')
    const name = field('[data-rx-name]')
    const dosage = field('[data-rx-dosage]')
    const qty = field('[data-rx-qty]')
    const instructions = field('[data-rx-instructions]')
    const prev = editing >= 0 ? rows[editing] : null
    const lineId = prev?.line_id ? { line_id: prev.line_id } : {}

    if (!drugId && !name && !dosage && !qty && !instructions) {
      throw new Error('Fill in the medicine before adding it to the list.')
    }

    if (external) {
      if (!name) throw new Error('Type the medicine name for an external prescription.')
      return { medicine: name, dosage, qty, instructions, external: true, ...lineId }
    }

    const drug = drugs.find((d) => d.id === drugId)
    if (!drug) throw new Error('Choose an in-house medicine, or switch Source to "External pharmacy".')
    if (qty !== '') {
      const q = Number(qty)
      if (!Number.isFinite(q) || q <= 0) throw new Error('Quantity must be a number greater than zero.')
      if (q > Number(drug.stock || 0)) {
        throw new Error('Only ' + Number(drug.stock || 0) + ' ' + (drug.unit || 'tabs') + ' of ' + drug.name + ' left in stock.')
      }
    }
    return {
      medicine: drug.name,
      drug_id: drug.id,
      sku: drug.sku || '',
      unit: drug.unit || '',
      dosage,
      qty: qty === '' ? '' : String(qty),
      instructions,
      external: false,
      ...lineId,
    }
  }

  function renderRows() {
    tableWrap.style.display = rows.length ? '' : 'none'
    if (!rows.length) { tbody.innerHTML = ''; return }
    tbody.innerHTML = rows.map((r, i) => {
      const issued = toQty(r.dispensed_qty, 0)
      const locked = issued > 0
      const qty = String(r.qty ?? r.quantity ?? '')
      return '<tr>' +
        '<td class="mut">' + (i + 1) + '</td>' +
        '<td><strong>' + esc(r.medicine || '—') + '</strong>' +
          (r.external ? ' <span class="pill info">external</span>' : '') +
          (r.sku ? '<div class="mut">' + esc(r.sku) + '</div>' : '') + '</td>' +
        '<td>' + esc(r.dosage || '—') + '</td>' +
        '<td>' + esc(qty || '—') + (qty && r.unit ? ' ' + esc(r.unit) : '') + '</td>' +
        '<td class="mut">' + esc(r.instructions || '—') + '</td>' +
        '<td>' + (locked
          ? '<span class="pill warn">' + esc(issued) + ' issued</span>'
          : '<span class="mut">—</span>') + '</td>' +
        '<td style="white-space:nowrap">' + (locked
          ? '<span class="pill">locked</span>'
          : '<button type="button" class="btn ghost sm" data-rx-edit="' + i + '">Edit</button> ' +
            '<button type="button" class="btn ghost sm" data-rx-del="' + i + '">Remove</button>') +
        '</td></tr>'
    }).join('')
    tbody.querySelectorAll('[data-rx-edit]').forEach((b) => {
      b.onclick = () => startEdit(Number(b.getAttribute('data-rx-edit')))
    })
    tbody.querySelectorAll('[data-rx-del]').forEach((b) => {
      b.onclick = () => {
        const i = Number(b.getAttribute('data-rx-del'))
        rows.splice(i, 1)
        if (editing === i) resetCard()
        else if (editing > i) editing--
        renderRows()
        if (editing < 0) focusFirst()
      }
    })
  }

  function resetCard() {
    const src = cardEl.querySelector('[data-rx-source]')
    if (src) src.value = startExternal ? 'external' : 'internal'
    const sel = cardEl.querySelector('[data-rx-drug]')
    if (sel) sel.value = ''
    cardEl.querySelector('[data-rx-name]').value = ''
    cardEl.querySelector('[data-rx-dosage]').value = ''
    cardEl.querySelector('[data-rx-qty]').value = ''
    cardEl.querySelector('[data-rx-instructions]').value = ''
    clearFilter()
    applyVisibility()
    editing = -1
    addBtn.textContent = 'Add to list'
    editPill.style.display = 'none'
    cancelEditBtn.style.display = 'none'
  }

  // Load a row back into the card so the clinician amends it rather than
  // retyping it. Locked rows never get here — the table offers no Edit for them.
  function startEdit(i) {
    const r = rows[i]
    if (!r || toQty(r.dispensed_qty, 0) > 0) return
    editing = i
    const external = !!r.external
    const src = cardEl.querySelector('[data-rx-source]')
    if (src) src.value = external ? 'external' : 'internal'
    const sel = cardEl.querySelector('[data-rx-drug]')
    if (sel) {
      const drugId = r.drug_id || ''
      if (drugId && !Array.from(sel.options).some((o) => o.value === drugId)) {
        const o = document.createElement('option')
        o.value = drugId
        o.setAttribute('data-label', (r.medicine || drugId) + ' (no longer in catalogue)')
        o.textContent = o.getAttribute('data-label')
        sel.appendChild(o)
      }
      sel.value = drugId
    }
    cardEl.querySelector('[data-rx-name]').value = external ? (r.medicine || '') : ''
    cardEl.querySelector('[data-rx-dosage]').value = r.dosage || ''
    cardEl.querySelector('[data-rx-qty]').value = String(r.qty ?? r.quantity ?? '')
    cardEl.querySelector('[data-rx-instructions]').value = r.instructions || ''
    clearFilter()
    applyVisibility()
    addBtn.textContent = 'Update row'
    editPill.style.display = ''
    editPill.textContent = 'Editing row ' + (i + 1) + ' of ' + rows.length
    cancelEditBtn.style.display = ''
    errEl.textContent = ''
    focusFirst()
  }

  cardEl.querySelector('[data-rx-source]')?.addEventListener('change', () => applyVisibility())
  const filterBox = cardEl.querySelector('[data-rx-filter]')
  if (filterBox) wireFilter(filterBox)

  addBtn.onclick = () => {
    errEl.textContent = ''
    let line
    try {
      line = readCard()
    } catch (e) {
      errEl.textContent = e?.message || 'Check the medicine fields.'
      return
    }
    if (editing >= 0) rows[editing] = line
    else rows.push(line)
    renderRows()
    resetCard()
    focusFirst()
  }

  cancelEditBtn.onclick = () => {
    errEl.textContent = ''
    resetCard()
    focusFirst()
  }

  const saveLabel = saveBtn.textContent
  saveBtn.onclick = async () => {
    errEl.textContent = ''
    if (!rows.length) {
      errEl.textContent = 'Add at least one medicine to this prescription.'
      return
    }
    // A medicine still sitting in the card was never added to the list, so
    // submitting now would silently drop it. Say so instead.
    const cardDirty = editing >= 0 || field('[data-rx-name]') || field('[data-rx-drug]') ||
      field('[data-rx-dosage]') || field('[data-rx-qty]') || field('[data-rx-instructions]')
    if (cardDirty) {
      errEl.textContent = 'The medicine in the card is not on the list yet — press "Add to list" to add it, or "Cancel edit" to discard it.'
      return
    }
    saveBtn.disabled = true
    saveBtn.textContent = 'Saving…'
    try {
      await onSubmit(rows.slice())
      // A caller that closes the modal on success is unaffected (the node is
      // gone); one that resolves without closing must not be left latched.
      saveBtn.disabled = false
      saveBtn.textContent = saveLabel
    } catch (e) {
      errEl.textContent = e?.message || 'Something went wrong. Please retry.'
      saveBtn.disabled = false
      saveBtn.textContent = saveLabel
    }
  }

  renderRows()
  applyVisibility()
}
