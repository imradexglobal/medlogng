// Structured result entry for ONE ordered test (item).
// The form is rendered from the item's FROZEN configuration snapshot — never
// from the live catalogue — so what is entered always matches what was ordered
// and what will print. Flags (L/H) preview live from the snapshot reference.
// Layout: one row per component — analyte, editable result cell, SI unit,
// acceptable range, flag, remark — mirroring a paper result sheet.
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

  function resultCell(comp, locked) {
    const cur = values[comp.id] || { value: '', remark: '' }
    const id = 'comp_' + comp.id
    if (locked) {
      return esc(cur.value || '—')
    }
    if (comp.result_type === 'qualitative' || comp.result_type === 'selection') {
      return '<select class="input" id="' + id + '" style="min-width:130px"><option value=""></option>' +
        (comp.options || []).map((o) => '<option' + (o === cur.value ? ' selected' : '') + '>' + esc(o) + '</option>').join('') +
        '</select>'
    }
    if (comp.result_type === 'text') {
      return '<textarea class="input" id="' + id + '" rows="2" style="min-width:220px">' + esc(cur.value) + '</textarea>'
    }
    const { ref } = flagFor(comp)
    let bar = ''
    if (ref && (ref.low != null || ref.high != null) && cur.value) {
      const n = Number(cur.value)
      const low = ref.low != null ? ref.low : 0
      const high = ref.high != null ? ref.high : 100
      const span = Math.max(high - low, 1)
      const pct = Math.min(Math.max((n - low) / span, 0), 1) * 100
      bar = '<div class="range-bar"><div class="range-track"><div class="range-fill" style="left:' + pct + '%"></div></div>' +
        '<div class="range-labels"><span style="font-size:.65rem;color:var(--emr-muted)">' + esc(String(ref.low)) + '</span>' +
        '<span style="font-size:.65rem;color:var(--emr-muted);float:right">' + esc(String(ref.high)) + '</span></div></div>'
    }
    return '<input class="input" id="' + id + '" inputmode="decimal" style="min-width:90px" value="' + esc(cur.value) + '" placeholder="—">' + bar
  }

  function flagCell(comp) {
    if (comp.result_type !== 'numeric') return '<span class="mut">—</span>'
    const { flag } = flagFor(comp)
    if (!flag) return '<span class="flag-cell mut" data-flag="' + esc(comp.id) + '">—</span>'
    const isCrit = flag.startsWith('critical')
    return '<span class="pill ' + (isCrit ? 'bad' : (flag === 'L' ? 'warn' : 'bad')) + ' flag-cell" data-flag="' + esc(comp.id) +
      '" title="' + esc(FLAG_LABELS[flag] || flag) + '">' + (isCrit ? '!' : flag) + '</span>'
  }

  function componentsTable(comps, locked) {
    return '<div class="tblwrap"><table class="tbl res-tbl"><thead><tr><th style="width:26%">Test</th><th>Result</th><th style="width:90px">SI unit</th><th style="width:130px">Acceptable range</th><th style="width:56px">Flag</th><th style="width:22%">Remark</th></tr></thead><tbody>' +
      comps.map((c) =>
        '<tr data-row="' + esc(c.id) + '">' +
        '<td><strong>' + esc(c.display_name || c.name) + '</strong>' +
        (c.required ? ' <span class="mut" title="Required">*</span>' : '') + '</td>' +
        '<td>' + resultCell(c, locked) + '</td>' +
        '<td class="mut">' + (c.unit ? esc(c.unit) : '—') + '</td>' +
        '<td class="mut">' + (refDisplay(c) ? esc(refDisplay(c)) : '—') + '</td>' +
        '<td>' + flagCell(c) + '</td>' +
        '<td>' + (locked
          ? esc((values[c.id] && values[c.id].remark) || '')
          : '<input class="input" data-remark="' + esc(c.id) + '" placeholder="optional" value="' + esc((values[c.id] && values[c.id].remark) || '') + '">') +
        '</td>' +
        '</tr>').join('') +
      '</tbody></table></div>'
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
      (patient ? ' · ' + esc(String(patient.sex || 'sex n/r')) + (patient.dob ? ', DOB ' + esc(patient.dob) : '') : '') +
      '</p>' +
      (locked ? '<p class="sub" style="color:#b91c1c"><span style="margin-right:6px">🔒</span>This result has been released and is locked. A correction must be audited.</p>' : '') +
      '</div>' +

      '<div class="card">' +
      (comps.length
        ? componentsTable(comps, locked)
        : '<p class="mut">This test has no structured components — use the free-text field.</p>' +
          '<label>Result<textarea class="input" id="legacyText" rows="3"' + (locked ? ' disabled' : '') + '>' + esc(item.result?.legacy_text || '') + '</textarea></label>') +
      '<label style="margin-top:10px">Result note (optional)<input class="input" id="resultNote" value="' + esc(item.result?.note || '') + '"' + (locked ? ' disabled' : '') + '></label>' +
      (locked ? '' :
        '<div class="mrow" style="margin-top:14px">' +
        '<button class="btn" id="saveBtn">Save result</button>' +
        '<button class="btn ghost" id="draftBtn">Save draft</button>' +
        '<button class="btn ghost" id="normalBtn">Mark all normal</button>' +
        '<a class="btn ghost" href="#/laboratory/orders/' + esc(lid) + '">Cancel</a>' +
        '</div>') +
      '</div>'

    if (locked) return
    comps.forEach((c) => {
      const el = root.querySelector('#comp_' + CSS.escape(c.id))
      if (el) {
        el.oninput = () => { collectValues(comps); refreshFlag(c) }
        el.onchange = () => { collectValues(comps); refreshFlag(c) }
      }
    })
    root.querySelectorAll('[data-remark]').forEach((el) => {
      el.oninput = () => collectValues(comps)
    })
    const save = root.querySelector('#saveBtn')
    if (save) save.onclick = () => doSave(comps, false)
    const draft = root.querySelector('#draftBtn')
    if (draft) draft.onclick = () => doSave(comps, true)
    const normal = root.querySelector('#normalBtn')
    if (normal) normal.onclick = () => {
      for (const c of comps) {
        const el = document.getElementById('comp_' + CSS.escape(c.id))
        if (!el) continue
        if (c.result_type === 'numeric') {
          const { ref } = flagFor(c)
          let mid = ''
          if (ref && ref.low != null && ref.high != null) mid = String(((Number(ref.low) + Number(ref.high)) / 2))
          else if (ref && ref.low != null) mid = String(Number(ref.low))
          else if (ref && ref.high != null) mid = String(Number(ref.high))
          if (mid !== '') el.value = mid
        } else if (c.result_type === 'qualitative' || c.result_type === 'selection') {
          if (c.options && c.options.length) el.value = c.options[0]
        }
      }
      collectValues(comps)
      comps.forEach((c) => refreshFlag(c))
    }
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

  // Live flag update in the row's flag cell — no full re-render, so focus
  // stays in the cell being typed.
  function refreshFlag(comp) {
    const cell = document.querySelector('[data-flag="' + comp.id + '"]')
    if (!cell || comp.result_type !== 'numeric') return
    const { flag } = flagFor(comp)
    if (!flag) {
      cell.textContent = '—'
      cell.className = 'flag-cell mut'
      cell.removeAttribute('title')
    } else {
      const isCrit = flag.startsWith('critical')
      cell.textContent = isCrit ? '!' : flag
      cell.className = 'pill ' + (isCrit ? 'bad' : (flag === 'L' ? 'warn' : 'bad')) + ' flag-cell'
      cell.title = FLAG_LABELS[flag] || flag
    }
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
