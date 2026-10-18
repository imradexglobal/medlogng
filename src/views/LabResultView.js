// Structured result entry for ONE ordered test (item).
// The form is rendered from the item's FROZEN configuration snapshot — never
// from the live catalogue — so what is entered always matches what was ordered
// and what will print. Flags (L/H) preview live from the snapshot reference.
// Route: #/laboratory/orders/:id/items/:itemId
import { shell, toast, wireToast } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import { getLabOrder, saveItemResult, myLabCaps } from '../services/laboratoryService.js'
import { esc } from '../utils/sanitize.js'
import { friendlyWriteError } from '../utils/errors.js'
import { resolveReferenceFor, computeFlag, FLAG_LABELS } from '../features/labs/domain.js'

export async function LabResultView(app, params = {}) {
  const caps = myLabCaps()
  const { id: lid, itemId } = params
  let order = null
  let item = null
  let patient = null
  let loadError = null
  const values = {}   // componentId -> { value, remark }

  shell(app, {
    active: '/laboratory',
    title: 'Enter result',
    subtitle: '',
    actions: '<a class="btn ghost" href="#/laboratory/orders/' + esc(lid) + '">← Order</a>',
    body: '<div id="result-page">Loading…</div>',
  })
  wireToast(app)

  async function reload(keepValues = false) {
    try {
      order = await getLabOrder(lid)
      loadError = null
      if (!order) { loadError = new Error('Lab order not found.'); return }
      item = (order.items || []).find((it) => it.item_id === itemId)
      if (!item) loadError = new Error('That test is not on this order (it may be a legacy order).')
    } catch (e) { loadError = e }
    if (order && !patient) {
      try {
        const { getPatient } = await import('../services/patientService.js')
        patient = await getPatient(order.patientId)
      } catch { patient = null }
    }
    if (!keepValues && item && item.result && item.result.values) {
      for (const [cid, v] of Object.entries(item.result.values)) {
        values[cid] = { value: v.value ?? '', remark: v.remark ?? '' }
      }
    }
    render()
  }

  function patientCtx() {
    return {
      sex: String(patient?.sex || '').toLowerCase().startsWith('f') ? 'female'
        : String(patient?.sex || '').toLowerCase().startsWith('m') ? 'male' : '',
      dob: patient?.dob || '',
      resultNow: Date.now(),
    }
  }

  function flagFor(comp) {
    const v = (values[comp.id] && values[comp.id].value) || ''
    if (comp.result_type !== 'numeric') return { flag: '', ref: null }
    const ref = resolveReferenceFor(comp, patientCtx().sex, patientCtx().dob, patientCtx().resultNow)
    return { flag: computeFlag(v, ref), ref }
  }

  function refDisplay(comp) {
    const { ref } = flagFor(comp)
    if (!ref) return (comp.ref_text || '')
    if (ref.text) return ref.text
    if (ref.low != null && ref.high != null) return ref.low + ' – ' + ref.high
    if (ref.low != null) return '≥ ' + ref.low
    if (ref.high != null) return '≤ ' + ref.high
    return comp.ref_text || ''
  }

  function componentField(comp) {
    const cur = values[comp.id] || { value: '', remark: '' }
    const id = 'comp_' + comp.id
    let control = ''
    if (comp.result_type === 'qualitative' || comp.result_type === 'selection') {
      control = '<select class="input" id="' + id + '"><option value=""></option>' +
        (comp.options || []).map((o) => '<option' + (o === cur.value ? ' selected' : '') + '>' + esc(o) + '</option>').join('') +
        '</select>'
    } else if (comp.result_type === 'text') {
      control = '<textarea class="input" id="' + id + '" rows="2">' + esc(cur.value) + '</textarea>'
    } else {
      control = '<input class="input" id="' + id + '" inputmode="decimal" value="' + esc(cur.value) + '" placeholder="—">'
    }
    const { flag } = flagFor(comp)
    const unit = comp.unit ? ' <span class="mut">' + esc(comp.unit) + '</span>' : ''
    const ref = refDisplay(comp)
    return '<div class="comp-field">' +
      '<div class="comp-label"><strong>' + esc(comp.display_name || comp.name) + '</strong>' + unit +
      (ref ? ' <span class="mut" style="font-size:.8rem">ref ' + esc(ref) + '</span>' : '') +
      (flag ? ' <span class="pill ' + (flag === 'L' ? 'warn' : 'bad') + '" title="' + esc(FLAG_LABELS[flag] || flag) + '">' + flag + '</span>' : '') +
      (comp.required ? ' <span class="mut" title="Required">*</span>' : '') +
      '</div>' + control +
      '<input class="input comp-remark" data-remark="' + esc(comp.id) + '" placeholder="Remark (optional)" value="' + esc(cur.remark) + '">' +
      '</div>'
  }

  function render() {
    const root = document.getElementById('result-page')
    if (!root) return
    if (loadError) {
      root.innerHTML = '<div class="card"><p class="sub">' + esc(friendlyWriteError(loadError)) + '</p><a class="btn ghost" href="#/laboratory">← Laboratory</a></div>'
      return
    }
    if (!item) { root.innerHTML = '<div class="card">Loading…</div>'; return }

    if (!caps.canResult) {
      root.innerHTML = '<div class="card"><p class="sub">Your role cannot enter lab results (missing <code>lab.result.enter</code> capability).</p><a class="btn ghost" href="#/laboratory/orders/' + esc(lid) + '">← Order</a></div>'
      return
    }
    const locked = item.status === 'released'
    const snap = item.snapshot || { name: item.test_name, components: [] }
    const comps = (snap.components || []).filter((c) => c.active !== false)

    root.innerHTML =
      '<div class="card">' +
      '<h3 style="margin:0">' + esc(snap.name || item.test_name) + ' ' + (snap.code ? '<span class="mut">' + esc(snap.code) + '</span>' : '') + '</h3>' +
      '<p class="sub" style="margin:4px 0 0">' +
      esc(order.patientName || '') + ' · ' + esc(order.orderNo || '') +
      (item.accession_no ? ' · accession ' + esc(item.accession_no) : '') +
      (snap.specimen_type ? ' · ' + esc(snap.specimen_type) : '') +
      ' · <span class="pill ' + esc(item.statusCls) + '">' + esc(item.statusLabel) + '</span>' +
      '</p>' +
      (locked ? '<p class="sub" style="color:#b91c1c">This result has been released and is locked. A correction must be audited.</p>' : '') +
      (comps.length
        ? comps.map(componentField).join('')
        : '<p class="mut">This test has no structured components — use the free-text field.</p>' +
          '<label>Result<textarea class="input" id="legacyText" rows="3"' + (locked ? ' disabled' : '') + '>' + esc(item.result?.legacy_text || '') + '</textarea></label>') +
      '<label style="margin-top:10px">Result note (optional)<input class="input" id="resultNote" value="' + esc(item.result?.note || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
      (locked ? '' :
        '<div class="mrow" style="margin-top:14px">' +
        '<button class="btn" id="saveBtn">Save result</button>' +
        '<button class="btn ghost" id="draftBtn">Save draft</button>' +
        '<a class="btn ghost" href="#/laboratory/orders/' + esc(lid) + '">Cancel</a>' +
        '</div>') +
      '</div>'

    if (locked) return
    comps.forEach((c) => {
      const el = root.querySelector('#comp_' + CSS.escape(c.id))
      if (el) el.oninput = () => { collectValues(comps); rerenderFlags(comps) }
      if (el) el.onchange = () => { collectValues(comps); rerenderFlags(comps) }
    })
    root.querySelectorAll('[data-remark]').forEach((el) => {
      el.oninput = () => collectValues(comps)
    })
    const save = root.querySelector('#saveBtn')
    if (save) save.onclick = () => doSave(comps, false)
    const draft = root.querySelector('#draftBtn')
    if (draft) draft.onclick = () => doSave(comps, true)
  }

  function collectValues(comps) {
    for (const c of comps) {
      const el = document.getElementById('comp_' + c.id)
      const rem = document.querySelector('[data-remark="' + c.id + '"]')
      values[c.id] = {
        value: el ? el.value : (values[c.id]?.value || ''),
        remark: rem ? rem.value : (values[c.id]?.remark || ''),
      }
    }
  }

  // Live flag badges without a full re-render (keeps focus in the field).
  function rerenderFlags(comps) {
    comps.forEach((c) => {
      const field = document.getElementById('comp_' + c.id)?.closest('.comp-field')
      if (!field) return
      const pill = field.querySelector('.pill')
      if (c.result_type !== 'numeric') { if (pill) pill.remove(); return }
      const { flag } = flagFor(c)
      if (pill) {
        if (!flag) pill.remove()
        else { pill.textContent = flag; pill.className = 'pill ' + (flag === 'L' ? 'warn' : 'bad') }
      } else if (flag) {
        const span = document.createElement('span')
        span.className = 'pill ' + (flag === 'L' ? 'warn' : 'bad')
        span.textContent = flag
        field.querySelector('.comp-label')?.appendChild(span)
      }
    })
  }

  async function doSave(comps, draft) {
    collectValues(comps)
    const noteEl = document.getElementById('resultNote')
    const legacyEl = document.getElementById('legacyText')
    const payload = { values: { ...values }, note: noteEl ? noteEl.value.trim() : '', draft }
    if (legacyEl) {
      // Free-text path: stuff the text into the single synthetic component.
      const cid = comps[0]?.id
      if (cid) payload.values[cid] = { value: legacyEl.value.trim(), remark: '' }
    }
    try {
      await saveItemResult(lid, itemId, payload)
      toast(draft ? 'Draft saved' : 'Result saved — awaiting validation')
      window.location.hash = '#/laboratory/orders/' + lid
    } catch (e) { toast(friendlyWriteError(e, 'Save failed')) }
  }

  reload()
}
