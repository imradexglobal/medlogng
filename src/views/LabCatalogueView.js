// Laboratory test catalogue — the configuration surface the whole LIMS reads.
// One org, many tests; each test may carry structured components (analytes)
// that drive result entry and the printed report. Editing a test never rewrites
// history: live orders keep the frozen snapshot taken at order time.
// Routes: #/laboratory/catalogue (list) · #/laboratory/catalogue/:id (editor)
import { shell, toast, wireToast, openModal, closeModal } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import {
  listOrgTests, createTest, updateTest, setTestActive, validateTestInput,
  seedStarterCatalogue, applyStandardReferenceRanges, myLabAdminCaps,
  getLabSettings, saveLabSettings, defaultLabSettings,
} from '../services/labCatalogueService.js'
import { refreshOrderSnapshotsFromCatalogue } from '../services/laboratoryService.js'
import { DEFAULT_CATEGORIES, DEFAULT_SPECIMEN_TYPES } from '../features/labs/domain.js'
import { esc } from '../utils/sanitize.js'
import { friendlyWriteError } from '../utils/errors.js'
import { onCleanup } from '../lib/lifecycle.js'
import { confirmDelete } from './deleteUi.js'
import { kebabCell, wireKebabs } from '../components/kebabMenu.js'
import { canDeleteRecords } from '../services/deleteService.js'
import { deleteLabTest } from '../services/deleteService.js'

const naira = (kobo) => '₦' + ((Number(kobo) || 0) / 100).toLocaleString('en-NG')

const RESULT_TYPES = [
  { value: 'numeric', label: 'Numeric (with unit + reference)' },
  { value: 'qualitative', label: 'Qualitative (Positive / Negative …)' },
  { value: 'selection', label: 'Selection (fixed options)' },
  { value: 'text', label: 'Free text' },
]

function blankComponent() {
  return { id: 'c' + Math.random().toString(36).slice(2, 8), name: '', display_name: '', result_type: 'numeric', unit: '', ref_low: '', ref_high: '', ref_text: '', options: [], required: true, active: true, sort_order: 0 }
}

export async function LabCatalogueView(app, params = {}) {
  const { activeOrg } = authStore.getState()
  const adminCaps = myLabAdminCaps()
  const canManage = adminCaps.canManageCatalogue
  const editId = params.id || null   // 'new' or a test id

  let tests = []
  let loadError = null
  let editing = null   // draft object for the editor
  let settings = null
  let settingsError = null

  async function bootstrap() {
    try {
      tests = await listOrgTests(activeOrg)
      loadError = null
    } catch (e) { loadError = e }
    try {
      settings = await getLabSettings(activeOrg)
      settingsError = null
    } catch (e) { settingsError = e }
    if (editId) await loadEditor()
    render()
  }

  async function loadEditor() {
    if (editId === 'new') {
      editing = {
        id: null, code: '', name: '', category: (DEFAULT_CATEGORIES[0] || 'General'),
        specimen_type: (DEFAULT_SPECIMEN_TYPES[0] || 'Blood'), price_kobo: 0,
        turnaround_hours: 24, active: true, sort_order: tests.length,
        components: [],
      }
      return
    }
    const t = tests.find((x) => x.id === editId)
    if (!t) { editing = null; loadError = loadError || new Error('Test not found — it may have been deleted.') ; return }
    editing = JSON.parse(JSON.stringify(t))
  }

  function shellActions() {
    const bits = ['<a class="btn ghost" href="#/laboratory">← Laboratory</a>']
    if (!editId && canManage) bits.unshift('<a class="btn" href="#/laboratory/catalogue/new">+ New test</a>')
    return bits.join(' ')
  }

  function render() {
    const body = editId ? renderEditor() : renderList()
    shell(app, {
      active: '/laboratory',
      title: editId ? (editId === 'new' ? 'New catalogue test' : 'Edit test') : 'Test catalogue',
      subtitle: editId ? '' : 'Configure the tests your laboratory performs. Ordered tests keep a frozen snapshot.',
      actions: shellActions(),
      body,
    })
    wireToast(app)
    if (editId) wireEditor(); else wireList()
  }

  function renderList() {
    if (!canManage) {
      return '<div class="card"><p class="sub">Your role can view the catalogue but not change it (missing <code>lab.catalogue.manage</code>).</p></div>' +
        (loadError ? '<div class="card"><p class="sub">' + esc(friendlyWriteError(loadError)) + '</p></div>' : '') +
        renderTestsTable(true)
    }
    return (loadError ? '<div class="card"><p class="sub">' + esc(friendlyWriteError(loadError)) + '</p><button class="btn ghost" id="retryBtn">Retry</button></div>' : '') +
      (tests.length === 0 && !loadError
        ? '<div class="card" style="text-align:center"><div class="empty-icon" style="font-size:3rem;margin-bottom:10px">🧪</div>' +
        '<h3>Your catalogue is empty</h3>' +
        '<p class="sub">Seed it with the 24 common starter tests (no reference ranges baked in — you configure those), or add your own tests one by one.</p>' +
        '<div class="mrow" style="justify-content:center"><button class="btn" id="seedBtn">Seed starter catalogue</button>' +
        '<a class="btn ghost" href="#/laboratory/catalogue/new">+ Add a test manually</a></div></div>'
        : '') +
      '<div class="card"><div class="toolbar"><strong>' + tests.length + ' tests</strong>' +
        (canManage ? ' <button class="btn ghost sm" id="applyStdRangesBtn">Apply standard ranges</button>' +
          ' <button class="btn ghost sm" id="refreshOrderSnapshotsBtn">Refresh order ranges</button>' : '') +
        '</div>' +
        renderTestsTable(!canManage) + '</div>' +
      renderSettingsCard()
  }

  function renderTestsTable(readonly) {
    if (!tests.length && !loadError) return ''
    return '<div class="tblwrap"><table class="tbl"><thead><tr><th>Code</th><th>Name</th><th>Category</th><th>Specimen</th><th>Price</th><th>Turnaround</th><th>Components</th><th>Status</th>' + (readonly ? '' : '<th style="width:120px">Actions</th>') + '</tr></thead><tbody>' +
      tests.map((t) =>
        '<tr>' +
        '<td><span class="pill">' + esc(t.code) + '</span></td>' +
        '<td><strong>' + esc(t.name) + '</strong></td>' +
        '<td>' + esc(t.category) + '</td>' +
        '<td>' + esc(t.specimen_type) + '</td>' +
        '<td>' + naira(t.price_kobo) + '</td>' +
        '<td class="mut">' + (t.turnaround_hours ? esc(t.turnaround_hours) + 'h' : '—') + '</td>' +
        '<td class="mut">' + ((t.components || []).length || '—') + '</td>' +
        '<td>' + (t.active ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Inactive</span>') + '</td>' +
        (readonly ? '' :
          '<td style="white-space:nowrap">' + kebabCell({ rowId: t.id, items: [
            { label: 'Edit', dataAction: 'edit' },
            { label: t.active ? 'Disable' : 'Enable', dataAction: 'toggle' },
            { label: 'Delete', tone: 'danger', dataAction: 'delete' }
          ] }) + '</td>') +
        '</tr>').join('') +
      '</tbody></table></div>'
  }

  function renderSettingsCard() {
    if (!settings) return settingsError ? '<div class="card"><h3>Laboratory settings</h3><p class="sub">' + esc(friendlyWriteError(settingsError)) + '</p></div>' : ''
    if (!canManage) return ''
    return '<div class="card"><h3>Laboratory settings</h3>' +
      '<p class="sub">Categories and specimen types offered on order forms, plus report letterhead details.</p>' +
      '<div class="frow">' +
      '<label>Lab name<input class="input" id="setLabName" value="' + esc(settings.report?.lab_name || '') + '"></label>' +
      '<label>Contact<input class="input" id="setContact" value="' + esc(settings.report?.contact || '') + '"></label>' +
      '</div>' +
      '<label>Address<input class="input" id="setAddress" value="' + esc(settings.report?.address || '') + '"></label>' +
      '<div class="frow">' +
      '<label>Signatory name<input class="input" id="setSignatoryName" value="' + esc(settings.report?.signatory_name || '') + '"></label>' +
      '<label>Signatory title<input class="input" id="setSignatoryTitle" value="' + esc(settings.report?.signatory_title || '') + '" placeholder="e.g. Consultant Pathologist"></label>' +
      '</div>' +
      '<label>Report footer<input class="input" id="setFooter" value="' + esc(settings.report?.footer || '') + '"></label>' +
      '<label>Categories (one per line)<textarea class="input" id="setCategories" rows="4">' + esc((settings.categories || []).join('\n')) + '</textarea></label>' +
      '<label>Specimen types (one per line)<textarea class="input" id="setSpecimens" rows="3">' + esc((settings.specimen_types || []).join('\n')) + '</textarea></label>' +
      '<div class="mrow" style="margin-top:10px"><button class="btn" id="saveSettingsBtn">Save settings</button></div></div>'
  }

  function wireList() {
    const seed = document.getElementById('seedBtn')
    if (seed) {
      seed.onclick = () => {
        openModal('Seed starter catalogue?',
          '<p>Adds the 24 common starter tests. Every starter ships with <strong>no reference ranges</strong> — your laboratory fills those in. Only possible while the catalogue is empty.</p>' +
          '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="seedYes">Seed</button></div>')
        document.getElementById('seedYes').onclick = async () => {
          closeModal()
          try {
            const created = await seedStarterCatalogue()
            toast('Seeded ' + created.length + ' starter tests')
            bootstrap()
          } catch (e) { toast(friendlyWriteError(e, 'Seed failed')) }
        }
      }
    }
    document.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        const t = tests.find((x) => x.id === b.getAttribute('data-toggle'))
        if (!t) return
        try { await setTestActive(t.id, !t.active); toast(t.active ? 'Test disabled' : 'Test enabled'); bootstrap() }
        catch (e) { toast(friendlyWriteError(e, 'Update failed')) }
      }
    })
    wireKebabs(document, async (rowId, action) => {
      const t = tests.find((x) => x.id === rowId)
      if (!t) return
      if (action === 'edit') {
        window.location.hash = '#/laboratory/catalogue/' + rowId
        return
      }
      if (action === 'toggle') {
        try { await setTestActive(t.id, !t.active); toast(t.active ? 'Test disabled' : 'Test enabled'); bootstrap() }
        catch (e) { toast(friendlyWriteError(e, 'Update failed')) }
        return
      }
      if (action === 'delete') {
        confirmDelete('test ' + t.code + ' ' + t.name, () => deleteLabTest(rowId), bootstrap)
      }
    })
    const retry = document.getElementById('retryBtn')
    if (retry) retry.onclick = bootstrap
    const applyStdRanges = document.getElementById('applyStdRangesBtn')
    if (applyStdRanges) {
      applyStdRanges.onclick = async () => {
        if (!confirm('Apply standard reference ranges to tests with blank ranges? Already-set ranges will not be overwritten.')) return
        try {
          const result = await applyStandardReferenceRanges()
          toast('Applied standard ranges to ' + result.updatedTests + ' test(s) (' + result.updatedComponents + ' component(s))')
          bootstrap()
        } catch (e) { toast(friendlyWriteError(e, 'Apply failed')) }
      }
    }
    const refreshSnapshots = document.getElementById('refreshOrderSnapshotsBtn')
    if (refreshSnapshots) {
      refreshSnapshots.onclick = async () => {
        if (!confirm('Back-fill blank reference ranges onto existing lab order snapshots from the live catalogue? Already-set ranges on orders will not be overwritten.')) return
        try {
          const result = await refreshOrderSnapshotsFromCatalogue()
          toast('Refreshed order snapshots: ' + result.updatedOrders + ' order(s), ' + result.updatedItems + ' item(s), ' + result.updatedComponents + ' range(s)')
          bootstrap()
        } catch (e) { toast(friendlyWriteError(e, 'Refresh failed')) }
      }
    }
    const saveSettings = document.getElementById('saveSettingsBtn')
    if (saveSettings) {
      saveSettings.onclick = async () => {
        const next = {
          ...defaultLabSettings(activeOrg),
          ...settings,
          categories: document.getElementById('setCategories').value.split('\n').map((s) => s.trim()).filter(Boolean),
          specimen_types: document.getElementById('setSpecimens').value.split('\n').map((s) => s.trim()).filter(Boolean),
          report: {
            ...(settings.report || {}),
            lab_name: document.getElementById('setLabName').value.trim(),
            contact: document.getElementById('setContact').value.trim(),
            address: document.getElementById('setAddress').value.trim(),
            signatory_name: document.getElementById('setSignatoryName').value.trim(),
            signatory_title: document.getElementById('setSignatoryTitle').value.trim(),
            footer: document.getElementById('setFooter').value.trim(),
          },
        }
        try { await saveLabSettings(next); toast('Settings saved'); bootstrap() }
        catch (e) { toast(friendlyWriteError(e, 'Save failed')) }
      }
    }
  }

  function componentRow(c, i) {
    return '<tr data-comp="' + esc(c.id) + '">' +
      '<td><input class="input" data-f="name" value="' + esc(c.name) + '" placeholder="e.g. haemoglobin"></td>' +
      '<td><input class="input" data-f="display_name" value="' + esc(c.display_name) + '" placeholder="e.g. Haemoglobin (Hb)"></td>' +
      '<td><select class="input" data-f="result_type">' +
      RESULT_TYPES.map((r) => '<option value="' + r.value + '"' + (c.result_type === r.value ? ' selected' : '') + '>' + r.label + '</option>').join('') +
      '</select></td>' +
      '<td><input class="input" data-f="unit" value="' + esc(c.unit || '') + '" placeholder="e.g. g/dL"></td>' +
      '<td><input class="input" data-f="ref_low" value="' + esc(c.ref_low ?? '') + '"></td>' +
      '<td><input class="input" data-f="ref_high" value="' + esc(c.ref_high ?? '') + '"></td>' +
      '<td><input class="input" data-f="ref_text" value="' + esc(c.ref_text || '') + '" placeholder="e.g. negative"></td>' +
      '<td><input class="input" data-f="options" value="' + esc((c.options || []).join(', ')) + '" placeholder="comma-separated"></td>' +
      '<td style="text-align:center"><input type="checkbox" data-f="required"' + (c.required ? ' checked' : '') + '></td>' +
      '<td style="text-align:right"><button class="btn ghost sm" data-remove-comp="' + esc(c.id) + '" title="Remove row">✕</button></td>' +
      '</tr>'
  }

  function renderEditor() {
    if (!canManage) return '<div class="card"><p class="sub">Only administrators with <code>lab.catalogue.manage</code> can edit the catalogue.</p><a class="btn ghost" href="#/laboratory/catalogue">← Catalogue</a></div>'
    if (!editing) return '<div class="card"><p class="sub">' + esc(loadError ? friendlyWriteError(loadError) : 'Loading…') + '</p><a class="btn ghost" href="#/laboratory/catalogue">← Catalogue</a></div>'
    return '<div class="card">' +
      '<div class="frow">' +
      '<label>Code *<input class="input" id="fCode" value="' + esc(editing.code) + '" placeholder="e.g. FBC"></label>' +
      '<label>Name *<input class="input" id="fName" value="' + esc(editing.name) + '" placeholder="e.g. Full Blood Count"></label>' +
      '</div><div class="frow">' +
      '<label>Category<input class="input" id="fCategory" list="catList" value="' + esc(editing.category) + '"><datalist id="catList">' +
      (settings?.categories || DEFAULT_CATEGORIES).map((c) => '<option value="' + esc(c) + '">').join('') + '</datalist></label>' +
      '<label>Specimen type<input class="input" id="fSpecimen" list="specList" value="' + esc(editing.specimen_type) + '"><datalist id="specList">' +
      (settings?.specimen_types || DEFAULT_SPECIMEN_TYPES).map((c) => '<option value="' + esc(c) + '">').join('') + '</datalist></label>' +
      '</div><div class="frow">' +
      '<label>Price (kobo) *<input class="input" id="fPrice" inputmode="numeric" value="' + esc(editing.price_kobo) + '"><span class="mut" style="font-size:.8rem">₦' + ((Number(editing.price_kobo) || 0) / 100).toFixed(2) + '</span></label>' +
      '<label>Turnaround (hours)<input class="input" id="fTat" inputmode="numeric" value="' + esc(editing.turnaround_hours ?? '') + '"></label>' +
      '</div>' +
      '<label style="display:flex;gap:6px;align-items:center;margin-top:6px"><input type="checkbox" id="fActive"' + (editing.active ? ' checked' : '') + '> Active (available on order forms)</label>' +
      '</div>' +

      '<div class="card"><h3>Result components</h3>' +
      '<p class="sub">Each component becomes a field on the result-entry screen and a row on the printed report. Numeric components can carry unit + reference range. Leave ranges empty until your laboratory confirms them — nothing is invented for you.</p>' +
      ((editing.components || []).length
        ? '<div class="tblwrap"><table class="tbl comp-tbl"><thead><tr><th>Name</th><th>Display name</th><th>Type</th><th>Unit</th><th>Ref low</th><th>Ref high</th><th>Ref text</th><th>Options</th><th title="Required">Req</th><th></th></tr></thead><tbody>' +
          editing.components.map(componentRow).join('') +
          '</tbody></table></div>'
        : '<p class="mut">No components yet — a test without components gets a single free-text result field.</p>') +
      '<button class="btn ghost sm" id="addCompBtn" style="margin-top:8px">+ Add component</button>' +
      '</div>' +

      '<div class="mrow" style="margin-top:14px">' +
      '<button class="btn" id="saveTestBtn">Save test</button>' +
      '<a class="btn ghost" href="#/laboratory/catalogue">Cancel</a>' +
      '</div></div>'
  }

  function wireEditor() {
    document.getElementById('addCompBtn').onclick = () => {
      syncEditor()
      editing.components.push(blankComponent())
      render()
    }
    document.querySelectorAll('[data-remove-comp]').forEach((b) => {
      b.onclick = () => {
        syncEditor()
        editing.components = editing.components.filter((c) => c.id !== b.getAttribute('data-remove-comp'))
        render()
      }
    })
    document.getElementById('saveTestBtn').onclick = async () => {
      syncEditor()
      const err = validateTestInput(editing)
      if (err) { toast(err); return }
      try {
        if (editing.id) await updateTest(editing.id, editing)
        else await createTest(editing)
        toast('Test saved')
        window.location.hash = '#/laboratory/catalogue'
      } catch (e) { toast(friendlyWriteError(e, 'Save failed')) }
    }
  }

  function syncEditor() {
    const g = (id) => { const el = document.getElementById(id); return el ? el.value : '' }
    editing.code = g('fCode').trim()
    editing.name = g('fName').trim()
    editing.category = g('fCategory').trim()
    editing.specimen_type = g('fSpecimen').trim()
    editing.price_kobo = Number(g('fPrice')) || 0
    editing.turnaround_hours = g('fTat') === '' ? null : Number(g('fTat'))
    const act = document.getElementById('fActive')
    if (act) editing.active = act.checked
    editing.components = (editing.components || []).map((c, i) => {
      const row = document.querySelector('[data-comp="' + CSS.escape(c.id) + '"]')
      if (!row) return c
      const val = (f) => { const el = row.querySelector('[data-f="' + f + '"]'); return el ? el.value : '' }
      const chk = (f) => { const el = row.querySelector('[data-f="' + f + '"]'); return el ? el.checked : false }
      return {
        ...c,
        name: val('name').trim(),
        display_name: val('display_name').trim(),
        result_type: val('result_type'),
        unit: val('unit').trim(),
        ref_low: val('ref_low').trim(),
        ref_high: val('ref_high').trim(),
        ref_text: val('ref_text').trim(),
        options: val('options').split(',').map((s) => s.trim()).filter(Boolean),
        required: chk('required'),
        sort_order: i,
      }
    })
  }

  bootstrap()
}
