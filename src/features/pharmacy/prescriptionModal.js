import { openModal } from '../../components/shell.js'
import { esc } from '../../utils/sanitize.js'
import { toQty } from './requests.js'

// Shared "write a prescription" modal used by every prescribing surface.
//
// One modal = one prescription SCRIPT, so it holds as many medicine lines as the
// clinician wants and hands them back in a single `onSubmit(lines)` call. The
// whole script then lands on one pharmacy order instead of one row per pill.
//
// Each line offers two sources:
//   • Internal pharmacy — an in-house catalogue lot, validated against the stock
//     the clinician can see; the pharmacy later issues and decrements it.
//   • External pharmacy — a free-text medicine name for a drug the hospital
//     does not stock. External lines never touch in-house stock, so they are
//     excluded from stock checks, dispensing and every balance.
//
// When the catalogue is empty the external source is preselected, so a
// clinician can still prescribe with nothing on the shelf.
//
// `initialLines` seeds the form for ADJUSTING a script already on the record.
// Lines that have been partly issued come back locked (their quantity and
// issued amount are history, not an editable draft), and carry their line_id so
// the caller can write the edited script back over the same request.
//
// Each line handed to onSubmit is normalised:
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
  // A fresh line defaults to the source that can actually be filled: with an
  // empty catalogue that is the external one.
  const startExternal = options.length === 0
  const seeded = (initialLines || []).length ? initialLines : [null]

  // ---- markup --------------------------------------------------------------
  function drugSelectHtml(line, idx, dis = '') {
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
      ? '<input class="input" style="margin-bottom:6px" data-rx-filter placeholder="Search in-house medicines…" autocomplete="off"' + dis + '>'
      : ''
    return filter +
      '<select class="input" data-rx-drug' + dis + '>' +
      '<option value="">Choose a medicine…</option>' + opts + '</select>'
  }

  // `.fld`/`.btn` set their own `display`, which beats the UA rule that hides
  // [hidden] — so visibility here is always an inline style, never the
  // hidden attribute.
  const HIDE = 'display:none'
  function blockHtml(line, idx) {
    const external = line ? !!line.external : startExternal
    const issued = line ? toQty(line.dispensed_qty, 0) : 0
    // A line the pharmacy has already issued against is history: it stays on
    // the script read-only so the editable copy can never contradict what went
    // out of the cupboard.
    const locked = issued > 0
    const qty = line ? String(line.qty ?? line.quantity ?? '') : ''
    const dis = locked ? ' disabled' : ''
    return '<div class="rx-line" data-rx-line' +
      (line?.line_id ? ' data-line-id="' + esc(line.line_id) + '"' : '') +
      (locked ? ' data-locked="1"' : '') +
      ' style="border:1px solid var(--emr-line);border-radius:10px;padding:10px 12px 12px;margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:8px">' +
        '<strong style="font-size:.72rem;letter-spacing:.05em;text-transform:uppercase;color:#64748b">Medicine <span data-rx-no>' + (idx + 1) + '</span></strong>' +
        (locked
          ? '<span class="pill ok">' + esc(issued) + ' issued — locked</span>'
          : '<button type="button" class="btn ghost sm" data-rx-remove>Remove</button>') +
      '</div>' +
      '<div class="fgrid">' +
        '<label class="fld full"><span>Source</span>' +
          '<select class="input" data-rx-source' + dis + '>' +
            '<option value="internal"' + (external ? '' : ' selected') + '>Internal pharmacy (from hospital stock)</option>' +
            '<option value="external"' + (external ? ' selected' : '') + '>External pharmacy (patient buys outside)</option>' +
          '</select></label>' +
        '<label class="fld full" data-rx-internal' + (external ? ' style="' + HIDE + '"' : '') + '><span>Medicine (in-house stock)</span>' +
          drugSelectHtml(line, idx, dis) + '</label>' +
        '<label class="fld full" data-rx-external' + (external ? '' : ' style="' + HIDE + '"') + '><span>Medicine name (external pharmacy)</span>' +
          '<input class="input" data-rx-name placeholder="e.g. Amlodipine 10mg" value="' + esc(external && line ? (line.medicine || '') : '') + '"' + dis + '></label>' +
        '<label class="fld"><span>Dosage</span>' +
          '<input class="input" data-rx-dosage placeholder="e.g. 1 tab daily" value="' + esc(line ? (line.dosage || '') : '') + '"' + dis + '></label>' +
        '<label class="fld"><span>Quantity</span>' +
          '<input class="input" data-rx-qty placeholder="e.g. 30" value="' + esc(qty) + '"' + dis + '></label>' +
        '<label class="fld full"><span>Instructions</span>' +
          '<input class="input" data-rx-instructions placeholder="e.g. after meals" value="' + esc(line ? (line.instructions || '') : '') + '"' + dis + '></label>' +
      '</div></div>'
  }

  openModal(title,
    '<p class="sub" style="margin:0 0 10px">' +
      esc(hint || 'One prescription, many medicines — add every drug for this visit and send them in one go.') + '</p>' +
    '<div id="rxLines">' + seeded.map(blockHtml).join('') + '</div>' +
    '<button type="button" class="btn ghost sm" id="rxAdd">+ Add more medicines</button>' +
    '<p id="rxError" style="color:var(--emr-bad);font-size:.8rem;min-height:16px;margin:8px 0 0"></p>' +
    '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
    '<button class="btn" id="rxSave">' + esc(submitLabel) + '</button></div>')

  const linesEl = document.getElementById('rxLines')
  const errEl = document.getElementById('rxError')
  const addBtn = document.getElementById('rxAdd')
  const saveBtn = document.getElementById('rxSave')
  // Locked blocks are passed through untouched on submit, so their original
  // (already-issued) line is kept here rather than re-read from disabled inputs.
  const lockedById = new Map(
    (initialLines || []).filter((l) => toQty(l?.dispensed_qty, 0) > 0 && l.line_id)
      .map((l) => [l.line_id, l]),
  )

  // Only the medicine field matching the chosen source stays visible, so a line
  // cannot be read as asking for both at once.
  function applyVisibility(block) {
    if (!block) return
    const sel = block.querySelector('[data-rx-source]')
    const external = sel ? sel.value === 'external' : startExternal
    const inside = block.querySelector('[data-rx-internal]')
    const outside = block.querySelector('[data-rx-external]')
    if (inside) inside.style.display = external ? HIDE : ''
    if (outside) outside.style.display = external ? '' : HIDE
  }

  function renumber() {
    const blocks = linesEl.querySelectorAll('[data-rx-line]')
    blocks.forEach((b, i) => {
      const no = b.querySelector('[data-rx-no]')
      if (no) no.textContent = String(i + 1)
      const rm = b.querySelector('[data-rx-remove]')
      if (rm) rm.style.display = blocks.length === 1 ? HIDE : ''
    })
  }

  // Long catalogues are unusable as a bare scroll list on a phone, so a typed
  // fragment narrows the options in place — the saved value is still the option
  // value, so filtering can never change what gets submitted.
  function wireFilter(box) {
    const sel = box.parentElement.querySelector('[data-rx-drug]')
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

  function wireBlock(block) {
    block.querySelector('[data-rx-source]')?.addEventListener('change', () => applyVisibility(block))
    block.querySelector('[data-rx-filter]') && wireFilter(block.querySelector('[data-rx-filter]'))
    block.querySelector('[data-rx-remove]')?.addEventListener('click', () => {
      block.remove()
      renumber()
    })
  }

  linesEl.querySelectorAll('[data-rx-line]').forEach(wireBlock)

  addBtn.onclick = () => {
    linesEl.insertAdjacentHTML('beforeend', blockHtml(null, linesEl.querySelectorAll('[data-rx-line]').length))
    const block = linesEl.lastElementChild
    wireBlock(block)
    applyVisibility(block)
    renumber()
    // Land the clinician in the new line, not back at the button they pressed.
    const externalVisible = (block.querySelector('[data-rx-external]') || {}).style?.display !== HIDE
    const focusTarget = externalVisible
      ? block.querySelector('[data-rx-name]')
      : (block.querySelector('[data-rx-drug]') || block.querySelector('[data-rx-dosage]'))
    try { focusTarget?.focus({ preventScroll: false }) } catch { /* not focusable */ }
  }

  // Read every block back into line objects, dropping untouched ones and
  // reporting anything half-filled instead of silently saving it.
  function collect() {
    const blocks = Array.from(linesEl.querySelectorAll('[data-rx-line]'))
    const out = []
    blocks.forEach((b, i) => {
      const n = i + 1
      const get = (sel) => { const el = b.querySelector(sel); return el ? String(el.value || '').trim() : '' }
      const lineId = b.getAttribute('data-line-id') || ''
      if (b.getAttribute('data-locked') === '1') {
        const original = lockedById.get(lineId)
        if (original) { out.push({ ...original }); return }
      }
      const external = (b.querySelector('[data-rx-source]') || {}).value === 'external'
      const drugId = get('[data-rx-drug]')
      const name = get('[data-rx-name]')
      const dosage = get('[data-rx-dosage]')
      const qty = get('[data-rx-qty]')
      const instructions = get('[data-rx-instructions]')

      // An untouched line the clinician added and then abandoned is dropped
      // rather than saved as an empty row on the pharmacy order.
      if (!drugId && !name && !dosage && !qty && !instructions) return

      if (external) {
        if (!name) throw new Error('Line ' + n + ': type the medicine name for an external prescription.')
        out.push({
          medicine: name, dosage, qty, instructions, external: true,
          ...(lineId ? { line_id: lineId } : {}),
        })
        return
      }
      const drug = drugs.find((d) => d.id === drugId)
      if (!drug) throw new Error('Line ' + n + ': choose an in-house medicine, or switch Source to "External pharmacy".')
      if (qty !== '') {
        const q = Number(qty)
        if (!Number.isFinite(q) || q <= 0) throw new Error('Line ' + n + ': quantity must be a number greater than zero.')
        if (q > Number(drug.stock || 0)) {
          throw new Error('Line ' + n + ': only ' + Number(drug.stock || 0) + ' ' + (drug.unit || 'tabs') + ' of ' + drug.name + ' left in stock.')
        }
      }
      out.push({
        medicine: drug.name,
        drug_id: drug.id,
        sku: drug.sku || '',
        unit: drug.unit || '',
        dosage,
        qty: qty === '' ? '' : String(qty),
        instructions,
        external: false,
        ...(lineId ? { line_id: lineId } : {}),
      })
    })
    return out
  }

  const label = saveBtn.textContent
  saveBtn.onclick = async () => {
    errEl.textContent = ''
    let lines
    try {
      lines = collect()
    } catch (e) {
      errEl.textContent = e?.message || 'Check the highlighted lines.'
      return
    }
    if (!lines.length) {
      errEl.textContent = 'Add at least one medicine to this prescription.'
      return
    }
    saveBtn.disabled = true
    saveBtn.textContent = 'Saving…'
    try {
      await onSubmit(lines)
      // A caller that closes the modal on success is unaffected (the node is
      // gone); one that resolves without closing must not be left latched.
      saveBtn.disabled = false
      saveBtn.textContent = label
    } catch (e) {
      errEl.textContent = e?.message || 'Something went wrong. Please retry.'
      saveBtn.disabled = false
      saveBtn.textContent = label
    }
  }

  renumber()
}
