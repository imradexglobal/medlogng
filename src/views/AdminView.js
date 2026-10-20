// Administration — fully wired (live Firestore, Spark plan: no backend).
// Tabs: Staff & roles · Organization · Devices · Audit trail.
// UX gates hide controls; Firestore Security Rules remain the authority.
import { shell, statusBadge, openModal, closeModal, toast, field, inp, sel } from '../components/shell.js'
import { onCleanup } from '../lib/lifecycle.js'
import { authStore } from '../store/authStore.js'
import { auth } from '../firebase.js'
import { loadOrganization, setActiveOrg, sendVerificationEmail } from '../services/authService.js'
import {
  myAdminCaps, listMembers, approveMember, rejectMember, suspendMember,
  reactivateMember, updateMemberRole, updateMemberCapabilities, requirePasswordReset, listInvites,
  createInvite, revokeInvite, updateOrgProfile, registerThisDevice,
  listOrgDevices, setDeviceStatus, listAudit, AUDIT_ACTIONS, updateMemberName,
  friendlyAdminError,
} from '../services/adminService.js'
import { staffLabel, staffNameForId } from '../lib/staffName.js'
import { ROLE_OPTIONS, ALL_CAPS, capsForRole, normalizeCaps, isValidEmail } from '../features/admin/roles.js'
import {
  listPayers, savePayer, setPayerActive, deletePayer, refreshCache,
  myPayerCaps, cachedPayers, PAYER_CATEGORIES,
} from '../services/payerService.js'
import { listOrgTests, getLabSettings, myLabAdminCaps } from '../services/labCatalogueService.js'
import { isDevHost, hostName } from '../utils/env.js'
import { createLoadMore } from '../components/loadMore.js'
import { esc } from '../utils/sanitize.js'
import { IMPORT_ORDER_TABLES } from '../features/data/schema.js'
import {
  generateTemplate, readDatabase, closeDatabase, describeDatabase,
  stageImport, pushQueue, flushPending, exportToDatabase,
  queue as bulkQueue,
} from '../services/bulkDataService.js'

// The payer list is a global master list, not a per-hospital setting, so its
// maintenance screen is a developer tool: it only renders on localhost. Hospital
// staff never see the tab — they only ever read the cached list into the payer
// dropdown on Register patient / Edit demographics / New invoice.
const DATA_TAB = 'Data import / export'
const LAB_TAB = 'Laboratory'
const TABS = ['Staff & roles', 'Organization', 'Devices', 'Audit trail', LAB_TAB, DATA_TAB]
const DEV_TAB = 'Payment types'
const visibleTabs = () => (isDevHost() ? [...TABS, DEV_TAB] : TABS)

export async function AdminView(app) {
  const { activeOrg, activeOrgName } = authStore.getState()
  if (!activeOrg) {
    shell(app, { active: '/admin', title: 'Administration', subtitle: 'No hospital selected', body: '<div class="card"><p>Sign in with a hospital membership first.</p></div>' })
    return
  }
  const { me, canManageRoles, canManageDevices } = myAdminCaps(activeOrg)

  if (!me || me.status !== 'active') {
    shell(app, {
      active: '/admin', title: 'Administration',
      subtitle: esc(activeOrgName || activeOrg),
      body: '<div class="card"><h3>Membership ' + esc(me?.status || 'missing') + '</h3>' +
        '<p class="sub">Your membership for this hospital is not active. Administration unlocks after an admin approves you.</p></div>',
    })
    return
  }
  if (!canManageRoles && !canManageDevices) {
    shell(app, {
      active: '/admin', title: 'Administration',
      subtitle: esc(activeOrgName || activeOrg),
      body: '<div class="card"><h3>Requires admin access</h3>' +
        '<p class="sub">You are signed in as <strong>' + esc(me.role || 'staff') + '</strong>. ' +
        'Staff management, organization settings, devices and audit need the admin capability. Contact your hospital admin.</p></div>',
    })
    return
  }

  const unverifiedBanner = (me.email_verification_required && auth.currentUser && auth.currentUser.emailVerified === false)
    ? '<div class="card" style="border-color:#fcd34d;background:#fffbeb"><strong>Verify your email</strong> ' +
      '<span class="sub">as an admin — check your inbox.</span> <button class="btn ghost sm" id="bResend">Resend link</button></div>'
    : (!auth.currentUser?.emailVerified
      ? '<div class="card"><span class="sub">Your email is not verified (older account — workspace stays open). </span><button class="btn ghost sm" id="bResend">Verify email</button></div>'
      : '')

  shell(app, {
    active: '/admin',
    title: 'Administration',
    subtitle: esc(activeOrgName || activeOrg) + ' · signed in as ' + esc(me.staff_name || me.role || ''),
    actions: '<button class="btn ghost" id="copyOrg">Copy Org ID</button><button class="btn" id="inviteTop">+ Create staff</button>',
    body: unverifiedBanner +
      '<div class="tabs" id="adt">' + visibleTabs().map((t, i) => '<button data-t="' + t + '" class="' + (i === 0 ? 'on' : '') + '">' + t + '</button>').join('') + '</div>' +
      '<div class="card" id="adpane"><p class="muted">Loading…</p></div>',
  })

  const copy = document.getElementById('copyOrg')
  if (copy) copy.onclick = async () => {
    try { await navigator.clipboard.writeText(activeOrg); toast('Org ID copied — share it with staff to join.') }
    catch { toast('Org ID: ' + activeOrg) }
  }
  const rs = document.getElementById('bResend')
  if (rs) rs.onclick = async () => {
    try { await sendVerificationEmail(); toast('Verification link sent.') }
    catch (e) { toast(String(e?.message || e)) }
  }

  const pane = document.getElementById('adpane')
  const state = {
    members: [], invites: [], org: null,
    auditCursor: null, auditMore: false,
    auditAction: '', auditUser: '', auditRows: [], auditLoading: false, auditFallback: false,
  }
  let statusTimer = null
  let pushing = false
  let pushStop = false
  let importDb = null
  let lastTabs = []
  let lastErrs = []

  async function refreshAll() {
    try {
      const [members, invites, org] = await Promise.all([
        listMembers(activeOrg).catch((e) => { throw e }),
        canManageRoles ? listInvites(activeOrg).catch(() => []) : Promise.resolve([]),
        loadOrganization(activeOrg),
      ])
      state.members = members
      state.invites = invites
      state.org = org
    } catch (e) {
      pane.innerHTML = '<h3>Could not load administration</h3><p class="err">' + esc(friendlyAdminError(e)) + '</p>' +
        '<button class="btn ghost" id="retry">Retry</button>'
      document.getElementById('retry').onclick = () => render(document.querySelector('#adt button.on')?.getAttribute('data-t') || TABS[0])
      return false
    }
    return true
  }

  function capsOf(m) {
    const caps = m.capabilities || []
    if (caps.includes('*')) return 'all (*)'
    return caps.length + ' caps'
  }

  function roleTooltip(role) {
    const caps = capsForRole(role) || []
    if (caps.includes('*')) return 'All capabilities (*)'
    return caps.join('\n')
  }

  function statusPill(s) {
    const cls = s === 'active' ? 'ok' : s === 'pending' ? 'warn' : s === 'suspended' ? 'bad' : s === 'rejected' ? 'bad' : s === 'revoked' ? 'bad' : ''
    return '<span class="pill ' + cls + '">' + esc(s) + '</span>'
  }

  function capCheckboxes(m, includeAll) {
    const current = new Set((m.capabilities || []).map((c) => String(c)))
    let list = ALL_CAPS.slice()
    if (includeAll) list = ['*', ...ALL_CAPS]
    else if (current.has('*')) list = ['*', ...ALL_CAPS]
    const chunks = []
    for (const c of list) {
      const checked = current.has(c) ? ' checked' : ''
      chunks.push('<label class="ck"><input type="checkbox" data-cap="' + esc(c) + '" value="' + esc(c) + '"' + checked + ' /> <span>' + esc(c) + '</span></label>')
    }
    return chunks.join('')
  }

  function memberRow(m) {
    const self = m.user_id === auth.currentUser?.uid
    const tooltip = roleTooltip(m.role || '')
    const roleSel = !canManageRoles
      ? '<strong title="' + esc(tooltip) + '">' + esc(m.role || '—') + '</strong>'
      : self
        ? '<strong title="' + esc(tooltip) + '">' + esc(m.role || '—') + '</strong><div class="mut">your role — only the other admin can change it</div>'
        : '<select class="input" data-role-for="' + esc(m.id) + '" style="max-width:190px" title="' + esc(tooltip) + '">' +
          ROLE_OPTIONS.map((r) => '<option value="' + r + '"' + (m.role === r ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>'
    const flags =
      (m.must_change_password ? ' <span class="pill warn">must change pw</span>' : '') +
      (m.email_verification_required ? ' <span class="pill warn">unverified</span>' : '')
    let actions = ''
    if (canManageRoles) {
      if (m.status === 'pending') {
        actions = '<button class="btn sm" data-approve="' + esc(m.id) + '">Approve</button> ' +
          '<button class="btn ghost sm" data-reject="' + esc(m.id) + '">Reject</button> ' +
          '<button class="btn ghost sm" data-rename="' + esc(m.id) + '">Rename</button>'
      } else if (m.status === 'active') {
        actions = (self ? '<span class="muted">you</span> '
          : '<button class="btn ghost sm" data-saverole="' + esc(m.id) + '">Save role</button> ' +
            '<button class="btn ghost sm" data-editcaps="' + esc(m.id) + '">Edit caps</button> ' +
            '<button class="btn ghost sm" data-suspend="' + esc(m.id) + '">Suspend</button> ' +
            '<button class="btn ghost sm" data-pwreset="' + esc(m.id) + '">' + (m.must_change_password ? 'Clear pw flag' : 'Require pw change') + '</button> ') +
          '<button class="btn ghost sm" data-rename="' + esc(m.id) + '">Rename</button>'
      } else {
        actions = '<button class="btn ghost sm" data-reactivate="' + esc(m.id) + '">Reactivate</button> ' +
          '<button class="btn ghost sm" data-rename="' + esc(m.id) + '">Rename</button>'
      }
    }
    return '<tr><td><strong>' + esc(m.staff_name || '(no name)') + '</strong>' +
      (m.email ? '<div class="mut">' + esc(m.email) + '</div>' : '') + flags + '</td>' +
      '<td>' + roleSel + (m.requested_role && m.requested_role !== m.role ? '<div class="mut">requested: ' + esc(m.requested_role) + '</div>' : '') + '</td>' +
      '<td class="mut" title="' + esc((m.capabilities || []).join('\n')) + '">' + esc(capsOf(m)) + '</td><td>' + statusPill(m.status) + '</td><td>' + actions + '</td></tr>'
  }

  function renderStaff() {
    const pending = state.members.filter((m) => m.status === 'pending')
    const active = state.members.filter((m) => m.status === 'active')
    const others = state.members.filter((m) => m.status !== 'pending' && m.status !== 'active')
    pane.innerHTML =
      '<div class="card-head"><h3>Staff & roles</h3><span class="pill">' + state.members.length + ' members</span></div>' +
      '<p class="sub">Permissions are assigned <strong>per user</strong> (add or remove capabilities anytime) and enforced by Security Rules. The role is just a label + a starting preset. Max <strong>2 active hospital admins</strong>.</p>' +
      (canManageRoles ? '<div class="toolbar"><button class="btn sm" id="createStaff">+ Create staff</button>' +
        '<span class="sub">New staff: enter email + role + capabilities → they sign up themselves with that email + Org ID, then you approve.</span></div>' : '') +
      '<h3>Pending approvals (' + pending.length + ')</h3>' +
      (pending.length
        ? '<div class="tblwrap"><table class="tbl"><thead><tr><th>Staff</th><th>Role</th><th>Caps</th><th>Status</th><th></th></tr></thead><tbody>' + pending.map(memberRow).join('') + '</tbody></table></div>'
        : '<p class="sub">No pending requests. Share the Org ID (top-right) with staff to let them join.</p>') +
      '<h3 style="margin-top:14px">Active (' + active.length + ')</h3>' +
      '<div class="tblwrap"><table class="tbl"><thead><tr><th>Staff</th><th>Role</th><th>Caps</th><th>Status</th><th></th></tr></thead><tbody>' + (active.map(memberRow).join('') || '<tr><td colspan="5" class="muted">None</td></tr>') + '</tbody></table></div>' +
      (others.length ? '<h3 style="margin-top:14px">Suspended / rejected (' + others.length + ')</h3>' +
        '<div class="tblwrap"><table class="tbl"><thead><tr><th>Staff</th><th>Role</th><th>Caps</th><th>Status</th><th></th></tr></thead><tbody>' + others.map(memberRow).join('') + '</tbody></table></div>' : '') +
      (canManageRoles ? '<h3 style="margin-top:14px">Pending invites (' + state.invites.length + ')</h3>' +
        (state.invites.length
          ? '<div class="tblwrap"><table class="tbl"><thead><tr><th>Email</th><th>Role</th><th></th></tr></thead><tbody>' +
            state.invites.map((v) => '<tr><td><strong>' + esc(v.email) + '</strong></td><td>' + esc(v.role) + '</td>' +
              '<td><button class="btn ghost sm" data-revoke-inv="' + esc(v.id) + '">Revoke</button></td></tr>').join('') + '</tbody></table></div>'
          : '<p class="sub">No open invites.</p>') : '')
    wireMemberButtons()
    const cs = document.getElementById('createStaff')
    if (cs) cs.onclick = openCreateStaff
  }

  function find(id) {
    return state.members.find((m) => m.id === id)
  }

  // `afterTab` is which tab to land back on; the staff list is the default
  // because most confirmations are membership changes.
  function confirmDo(title, text, okLabel, fn, afterTab = 'Staff & roles') {
    openModal(title,
      '<p>' + text + '</p><div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
      '<button class="btn" id="cfOk">' + esc(okLabel) + '</button></div>')
    document.getElementById('cfOk').onclick = async (e) => {
      e.target.disabled = true
      try { await fn(); closeModal(); toast('Done.'); await reloadAndRender(afterTab) }
      catch (err) { closeModal(); toast(friendlyAdminError(err)) }
    }
  }

  function collectCapsFrom(selector) {
    const checks = document.querySelectorAll(selector)
    const caps = []
    checks.forEach((x) => { if (x.checked) caps.push(x.value) })
    return normalizeCaps(caps)
  }

  function wireMemberButtons() {
    pane.querySelectorAll('[data-approve]').forEach((b) => {
      b.onclick = () => {
        const m = find(b.getAttribute('data-approve'))
        openModal('Approve staff',
          '<p class="sub">Approve <strong>' + esc(m.staff_name || m.user_id || m.email || '—') + '</strong>. Choose role and individual capabilities.</p>' +
          '<div class="fgrid">' +
          field('Role', sel(ROLE_OPTIONS)).replace('<select class="input">', '<select id="apRole" class="input">') +
          '</div>' +
          '<div class="card" style="margin-top:8px"><div class="card-head"><h4>Capabilities</h4><span class="sub">Uncheck to remove; check to add</span></div>' +
          '<div class="fgrid" id="apCaps">' + capCheckboxes(m, true) + '</div></div>' +
          '<p id="apErr" class="err"></p>' +
          '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="apGo">Approve →</button></div>')
        const roleSel = document.getElementById('apRole')
        const rowRole = pane.querySelector('[data-role-for="' + m.id + '"]')?.value
        roleSel.value = rowRole || m.requested_role || m.role || 'receptionist'
        const applyRole = () => {
          const r = roleSel.value
          const d = capsForRole(r)
          const set = new Set(d)
          document.querySelectorAll('#apCaps input[data-cap]').forEach((x) => {
            if (x.value === '*') { x.checked = d.includes('*'); return }
            x.checked = set.has(x.value)
          })
        }
        roleSel.onchange = applyRole
        // Preserve capabilities already chosen on the invite (if any); only
        // seed from the role preset when the member has none.
        if (!(m.capabilities && m.capabilities.length)) applyRole()
        document.getElementById('apGo').onclick = async (e) => {
          const r = roleSel.value
          const caps = collectCapsFrom('#apCaps input[data-cap]')
          if (!caps.length) { document.getElementById('apErr').textContent = 'Select at least one capability'; return }
          e.target.disabled = true
          try {
            await approveMember(m, r, caps)
            closeModal()
            toast('Approved.')
            await reloadAndRender('Staff & roles')
          } catch (err) {
            document.getElementById('apErr').textContent = friendlyAdminError(err)
            e.target.disabled = false
          }
        }
      }
    })
    pane.querySelectorAll('[data-reject]').forEach((b) => {
      b.onclick = () => {
        const m = find(b.getAttribute('data-reject'))
        confirmDo('Reject request', 'Reject <strong>' + esc(m.staff_name || m.user_id) + '</strong>? They stay signed in but have no hospital access.', 'Reject', () => rejectMember(m))
      }
    })
    pane.querySelectorAll('[data-suspend]').forEach((b) => {
      b.onclick = () => {
        const m = find(b.getAttribute('data-suspend'))
        confirmDo('Suspend access', 'Suspend <strong>' + esc(m.staff_name || m.user_id) + '</strong>? Their devices become useless immediately. History is kept.', 'Suspend', () => suspendMember(m))
      }
    })
    pane.querySelectorAll('[data-reactivate]').forEach((b) => {
      b.onclick = async () => {
        const m = find(b.getAttribute('data-reactivate'))
        try { await reactivateMember(m); toast('Reactivated.'); await reloadAndRender('Staff & roles') }
        catch (e) { toast(friendlyAdminError(e)) }
      }
    })
    pane.querySelectorAll('[data-saverole]').forEach((b) => {
      b.onclick = () => {
        const m = find(b.getAttribute('data-saverole'))
        const role = pane.querySelector('[data-role-for="' + m.id + '"]')?.value || m.role
        if (role === m.role) { toast('Role unchanged.'); return }
        confirmDo('Change role', 'Change <strong>' + esc(m.staff_name || m.user_id) + '</strong> from <strong>' + esc(m.role) + '</strong> to <strong>' + esc(role) + '</strong>? Role label changes; individual capabilities are preserved.', 'Change role', () => updateMemberRole(m, role))
      }
    })
    pane.querySelectorAll('[data-pwreset]').forEach((b) => {
      b.onclick = async () => {
        const m = find(b.getAttribute('data-pwreset'))
        try { await requirePasswordReset(m, !m.must_change_password); toast('Updated.'); await reloadAndRender('Staff & roles') }
        catch (e) { toast(friendlyAdminError(e)) }
      }
    })
    pane.querySelectorAll('[data-editcaps]').forEach((b) => {
      b.onclick = () => {
        const m = find(b.getAttribute('data-editcaps'))
        if (m.user_id === auth.currentUser?.uid) { toast('You cannot change your own capabilities.'); return }
        openModal('Edit capabilities',
          '<p class="sub">Customize capabilities for <strong>' + esc(m.staff_name || m.user_id) + '</strong> (role: <strong>' + esc(m.role) + '</strong>). Changes take effect immediately.</p>' +
          '<div class="card"><div class="fgrid">' + capCheckboxes(m, true) + '</div></div>' +
          '<p id="ecErr" class="err"></p>' +
          '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="ecGo">Save →</button></div>')
        document.getElementById('ecGo').onclick = async (e) => {
          const caps = collectCapsFrom('#modal input[data-cap]')
          if (!caps.length) { document.getElementById('ecErr').textContent = 'Select at least one capability'; return }
          e.target.disabled = true
          try {
            await updateMemberCapabilities(m, caps)
            closeModal()
            toast('Capabilities updated.')
            await reloadAndRender('Staff & roles')
          } catch (err) {
            document.getElementById('ecErr').textContent = friendlyAdminError(err)
            e.target.disabled = false
          }
        }
      }
    })
    pane.querySelectorAll('[data-rename]').forEach((b) => {
      b.onclick = () => {
        const m = find(b.getAttribute('data-rename'))
        openModal('Rename staff',
          '<p class="sub">Update the display name for <strong>' + esc(m.staff_name || m.email || m.user_id || '—') + '</strong>. ' +
          'The name is what records, reports and printouts show instead of the sign-in email.</p>' +
          '<div class="fgrid">' +
          field('Staff name', '<input id="rnName" class="input" maxlength="80" value="' + esc(m.staff_name || '') + '" placeholder="e.g. Dr. A. Okafor" />').replace('class="fld"', 'class="fld full"') +
          '</div><p id="rnErr" class="err"></p>' +
          '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="rnGo">Save name</button></div>')
        const input = document.getElementById('rnName')
        const go = document.getElementById('rnGo')
        input.focus()
        input.select()
        input.onkeydown = (ev) => { if (ev.key === 'Enter') go.click() }
        go.onclick = async (e) => {
          const name = input.value
          if (!name.trim()) { document.getElementById('rnErr').textContent = 'Enter a name'; return }
          e.target.disabled = true
          try {
            await updateMemberName(m, name)
            closeModal()
            toast('Name saved — records and reports now show it instead of the email.')
            await reloadAndRender('Staff & roles')
          } catch (err) {
            document.getElementById('rnErr').textContent = friendlyAdminError(err)
            e.target.disabled = false
          }
        }
      }
    })
    pane.querySelectorAll('[data-revoke-inv]').forEach((b) => {
      b.onclick = async () => {
        const v = state.invites.find((x) => x.id === b.getAttribute('data-revoke-inv'))
        try { await revokeInvite(v); toast('Invite revoked.'); await reloadAndRender('Staff & roles') }
        catch (e) { toast(friendlyAdminError(e)) }
      }
    })
  }

  function openCreateStaff() {
    openModal('Create staff',
      '<p class="sub">Enter their email + role. They sign up themselves (own password), then appear in Pending approvals. No default passwords — staff always set their own. Max 2 active hospital admins.</p>' +
      '<div class="fgrid">' +
      field('Email', '<input id="csEmail" class="input" type="email" placeholder="staff@hospital.ng" />').replace('class="fld"', 'class="fld full"') +
      field('Role', sel(ROLE_OPTIONS)) .replace('<select class="input">', '<select id="csRole" class="input">') +
      '</div>' +
      '<div class="card" style="margin-top:8px"><div class="card-head"><h4>Capabilities</h4><span class="sub">Uncheck to customize</span></div>' +
      '<div class="fgrid" id="csCapsGrid"></div></div>' +
      '<p id="csErr" class="err"></p>' +
      '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="csGo">Create →</button></div>')
    const roleSel = document.getElementById('csRole')
    const grid = document.getElementById('csCapsGrid')
    function renderGrid() {
      grid.innerHTML = capCheckboxes({ capabilities: capsForRole(roleSel.value) }, true)
    }
    roleSel.onchange = renderGrid
    renderGrid()
    document.getElementById('csGo').onclick = async (e) => {
      const email = document.getElementById('csEmail').value
      if (!isValidEmail(email)) { document.getElementById('csErr').textContent = 'Enter a valid email address'; return }
      const caps = collectCapsFrom('#csCapsGrid input[data-cap]')
      if (!caps.length) { document.getElementById('csErr').textContent = 'Select at least one capability'; return }
      e.target.disabled = true
      try {
        await createInvite(activeOrg, email, roleSel.value, caps)
        closeModal()
        toast('Staff created — tell them to Join with this Org ID.')
        await reloadAndRender('Staff & roles')
      } catch (err) {
        document.getElementById('csErr').textContent = friendlyAdminError(err)
        e.target.disabled = false
      }
    }
  }

  function renderOrg() {
    const o = state.org || {}
    pane.innerHTML =
      '<div class="card-head"><h3>Organization</h3><span class="pill">Org ID: ' + esc(activeOrg) + '</span></div>' +
      (canManageRoles
        ? '<div class="fgrid">' +
          field('Facility name', '<input id="ogName" class="input" value="' + esc(o.name || '') + '" />').replace('class="fld"', 'class="fld full"') +
          field('Type', '<select id="ogType" class="input">' + ['tertiary', 'secondary', 'primary_centre', 'primary_clinic', 'private_hospital', 'private_clinic', 'diagnostic_centre', 'pharmacy'].map((t) => '<option' + (o.organization_type === t ? ' selected' : '') + '>' + t + '</option>').join('') + '</select>') +
          field('State', '<input id="ogState" class="input" value="' + esc(o.state || '') + '" />') +
          field('LGA', '<input id="ogLga" class="input" value="' + esc(o.lga || '') + '" />') +
          '</div><p id="ogErr" class="err"></p><div class="mrow"><button class="btn" id="ogSave">Save profile</button></div>'
        : '<div class="kv"><div><em>Facility</em><strong style="font-size:.9rem">' + esc(o.name || '—') + '</strong></div>' +
          '<div><em>Type</em><strong style="font-size:.9rem">' + esc(o.organization_type || '—') + '</strong></div>' +
          '<div><em>State / LGA</em><strong style="font-size:.9rem">' + esc((o.state || '—') + ' · ' + (o.lga || '—')) + '</strong></div>' +
          '<div><em>Status</em><strong style="font-size:.9rem">' + esc(o.status || '—') + '</strong></div></div>')
    const sv = document.getElementById('ogSave')
    if (sv) sv.onclick = async () => {
      sv.disabled = true
      try {
        const name = document.getElementById('ogName').value
        await updateOrgProfile(activeOrg, {
          name,
          organization_type: document.getElementById('ogType').value,
          state: document.getElementById('ogState').value,
          lga: document.getElementById('ogLga').value,
        })
        setActiveOrg(activeOrg, name.trim())
        toast('Organization saved.')
        await reloadAndRender('Organization')
      } catch (e) {
        document.getElementById('ogErr').textContent = friendlyAdminError(e)
        sv.disabled = false
      }
    }
  }

  async function renderDevices() {
    pane.innerHTML = '<p class="muted">Loading devices…</p>'
    let devs = []
    try {
      devs = await listOrgDevices(activeOrg)
    } catch (e) {
      pane.innerHTML = '<h3>Devices</h3><p class="err">' + esc(friendlyAdminError(e)) + '</p>'
      return
    }
    const revoked = devs.filter((d) => d.status === 'revoked')
    pane.innerHTML =
      '<div class="card-head"><h3>Devices (' + devs.length + ')</h3><span class="pill">admin-only control</span></div>' +
      '<p class="sub">Only admins see and revoke hospital devices. Staff have no device controls. ' +
      'Suspending a <a href="#" id="goStaff">staff member</a> blocks them instantly — revoking a device blocks that device. ' +
      'Only devices registered after this update appear here.</p>' +
      '<div class="toolbar"><button class="btn sm" id="regDev">+ Register this device</button></div>' +
      (devs.length
        ? '<div class="tblwrap"><table class="tbl"><thead><tr><th>Device</th><th>User</th><th>Last seen</th><th>Status</th><th></th></tr></thead><tbody>' +
          devs.map((d) => '<tr><td><strong>' + esc(d.device_name || d.id) + '</strong><div class="mut">' + esc(d.platform || '') + ' · ' + esc(d.id) + '</div></td>' +
            '<td class="mut">' + esc(staffNameForId(d.user_id) || staffLabel(d.user_name) || d.user_email || '—') + '</td>' +
            '<td class="mut">' + esc(d.last_seen?.toDate ? d.last_seen.toDate().toLocaleString() : '—') + '</td>' +
            '<td>' + statusPill(d.status || 'active') + '</td>' +
            '<td>' + (canManageDevices
              ? (d.status === 'revoked'
                ? '<button class="btn ghost sm" data-unrev="' + esc(d.id) + '">Reactivate</button>'
                : '<button class="btn ghost sm" data-rev="' + esc(d.id) + '">Revoke</button>')
              : '') + '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="sub">No devices registered yet. Press “Register this device” on each hospital PC/tablet.</p>') +
      (revoked.length ? '<p class="sub" style="margin-top:8px">' + revoked.length + ' revoked device(s) are blocked by Rules.</p>' : '')
    document.getElementById('goStaff').onclick = (e) => { e.preventDefault(); render('Staff & roles'); syncTabs('Staff & roles') }
    document.getElementById('regDev').onclick = async (e) => {
      e.target.disabled = true
      try { await registerThisDevice(activeOrg); toast('This device registered.'); await renderDevices() }
      catch (err) { toast(friendlyAdminError(err)); e.target.disabled = false }
    }
    pane.querySelectorAll('[data-rev]').forEach((b) => {
      b.onclick = () => {
        const d = devs.find((x) => x.id === b.getAttribute('data-rev'))
        confirmDo('Revoke device', 'Revoke <strong>' + esc(d.device_name || d.id) + '</strong>? It will be blocked by Security Rules immediately.', 'Revoke', () => setDeviceStatus(d, 'revoked'))
      }
    })
    pane.querySelectorAll('[data-unrev]').forEach((b) => {
      b.onclick = async () => {
        const d = devs.find((x) => x.id === b.getAttribute('data-unrev'))
        try { await setDeviceStatus(d, 'active'); toast('Device reactivated.'); await renderDevices() }
        catch (e) { toast(friendlyAdminError(e)) }
      }
    })
  }

  function fmtTs(ts) {
    try {
      if (ts?.toDate) return ts.toDate().toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })
      return '—'
    } catch { return '—' }
  }

  // ---- Payment types (developer-only, localhost) -----------------------------
  // Backs the payer dropdown on Register patient / Edit demographics / New
  // invoice. Reads come from the local offline copy; "Pull from cloud" is the
  // only button that hits Firestore, so editing works with no connection and
  // pushes the moment the app is back online (Firestore queues the write).
  function openPayerForm(existing) {
    const p = existing || null
    openModal(p ? 'Edit payer' : 'Add payer',
      '<div class="fgrid">' +
      field('Payer name', '<input id="pyName" class="input" value="' + esc(p?.name || '') + '" placeholder="e.g. NHIA" />').replace('class="fld"', 'class="fld full"') +
      field('Category', '<select id="pyCat" class="input">' +
        PAYER_CATEGORIES.map((c) => '<option value="' + c.value + '"' + (p?.category === c.value ? ' selected' : '') + '>' + esc(c.label) + '</option>').join('') +
        '</select>') +
      field('Sort order', '<input id="pySort" class="input" type="number" value="' + esc(p?.sortOrder ?? 100) + '" />') +
      field('Code', '<input id="pyCode" class="input" value="' + esc(p?.code || '') + '" placeholder="optional" />') +
      field('Active', '<select id="pyActive" class="input"><option value="1"' + (p && p.active === false ? '' : ' selected') + '>Yes</option><option value="0"' + (p && p.active === false ? ' selected' : '') + '>No</option></select>') +
      '</div><p id="pyErr" class="err"></p><p class="sub">The name is what gets stored on a patient and invoice, so renaming one does not rewrite history. Deactivate instead of deleting when a payer is retired.</p>' +
      '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="pySave">Save payer</button></div>')
    document.getElementById('pySave').onclick = async (e) => {
      const btn = e.target
      btn.disabled = true
      try {
        await savePayer({
          id: p?.id,
          name: document.getElementById('pyName').value,
          category: document.getElementById('pyCat').value,
          sort_order: Number(document.getElementById('pySort').value),
          code: document.getElementById('pyCode').value,
          active: document.getElementById('pyActive').value === '1',
        })
        closeModal()
        toast('Payer saved')
        renderPayers()
      } catch (err) {
        document.getElementById('pyErr').textContent = friendlyAdminError(err)
        btn.disabled = false
      }
    }
  }

  async function renderPayers() {
    if (!isDevHost()) { render('Staff & roles'); return }
    const caps = myPayerCaps()
    const offline = cachedPayers()
    pane.innerHTML = '<p class="muted">Loading payers…</p>'
    let rows = []
    try {
      rows = await listPayers()
    } catch (e) {
      pane.innerHTML = '<h3>Payment types</h3><p class="err">' + esc(friendlyAdminError(e)) + '</p>'
      return
    }
    const builtIn = rows.filter((r) => r.fallback)
    pane.innerHTML =
      '<div class="card-head"><h3>Payment types (' + rows.filter((r) => !r.fallback).length + ')</h3>' +
      '<span class="pill warn">developer tool · ' + esc(hostName()) + '</span></div>' +
      '<p class="sub">Global payer list (<code>payers</code>) shared by every hospital — it is <strong>not</strong> per-facility. ' +
      'It is pulled from the cloud once and cached on this device; every payer dropdown then reads that offline copy. ' +
      (caps.canManage ? 'Editing requires the <strong>billing.invoice</strong> capability.' : 'Your role cannot edit this list.') + '</p>' +
      (builtIn.length
        ? '<p class="sub" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:8px 12px">' +
          'The <code>payers</code> collection is empty, so these built-in defaults are being shown. ' +
          'Saving one below writes it to the collection and the defaults stop being used.</p>'
        : '') +
      '<div class="toolbar">' +
      (caps.canManage ? '<button class="btn sm" id="pyAdd">+ Add payer</button>' : '') +
      '<button class="btn ghost sm" id="pySync">↻ Pull from cloud</button>' +
      '<span class="mut">' + (offline ? 'Offline copy: ' + offline.length + ' rows' : 'No offline copy yet') + '</span></div>' +
      (rows.length
        ? '<div class="tblwrap"><table class="tbl"><thead><tr><th>Payer</th><th>Category</th><th>Sort</th><th>Code</th><th>Status</th><th></th></tr></thead><tbody>' +
          rows.map((r) =>
            '<tr><td><strong>' + esc(r.name) + '</strong>' + (r.fallback ? '<div class="mut">built-in default</div>' : '') + '</td>' +
            '<td>' + esc(r.category) + '</td><td class="mut">' + esc(r.sortOrder) + '</td><td class="mut">' + esc(r.code || '—') + '</td>' +
            '<td>' + (r.active !== false ? '<span class="pill ok">Active</span>' : '<span class="pill">Inactive</span>') + '</td>' +
            '<td>' + (caps.canManage && !r.fallback
              ? '<button class="btn ghost sm" data-py-edit="' + esc(r.id) + '">Edit</button> ' +
                (r.active !== false
                  ? '<button class="btn ghost sm" data-py-off="' + esc(r.id) + '">Deactivate</button>'
                  : '<button class="btn ghost sm" data-py-on="' + esc(r.id) + '">Activate</button>') +
                ' <button class="btn ghost sm" data-py-del="' + esc(r.id) + '">Delete</button>'
              : (caps.canManage && r.fallback ? '<button class="btn ghost sm" data-py-save="' + esc(r.name) + '">Save to cloud</button>' : '')) +
            '</td></tr>').join('') + '</tbody></table></div>'
        : '<p class="sub">No payers yet — add one to populate the dropdowns.</p>')

    const addBtn = document.getElementById('pyAdd')
    if (addBtn) addBtn.onclick = () => openPayerForm(null)
    const syncBtn = document.getElementById('pySync')
    if (syncBtn) syncBtn.onclick = async () => {
      syncBtn.disabled = true
      try { await refreshCache(); toast('Payer list pulled from cloud'); renderPayers() }
      catch (e) { toast(friendlyAdminError(e)); syncBtn.disabled = false }
    }
    pane.querySelectorAll('[data-py-edit]').forEach((b) => {
      b.onclick = () => openPayerForm(rows.find((r) => r.id === b.getAttribute('data-py-edit')))
    })
    pane.querySelectorAll('[data-py-save]').forEach((b) => {
      b.onclick = () => openPayerForm({ name: b.getAttribute('data-py-save'), category: 'other', sortOrder: 100, active: true })
    })
    pane.querySelectorAll('[data-py-on]').forEach((b) => {
      b.onclick = async () => {
        try { await setPayerActive(b.getAttribute('data-py-on'), true); toast('Payer activated'); renderPayers() }
        catch (e) { toast(friendlyAdminError(e)) }
      }
    })
    pane.querySelectorAll('[data-py-off]').forEach((b) => {
      b.onclick = async () => {
        try { await setPayerActive(b.getAttribute('data-py-off'), false); toast('Payer deactivated — hidden from new records, kept on existing ones'); renderPayers() }
        catch (e) { toast(friendlyAdminError(e)) }
      }
    })
    pane.querySelectorAll('[data-py-del]').forEach((b) => {
      b.onclick = () => {
        const r = rows.find((x) => x.id === b.getAttribute('data-py-del'))
        confirmDo('Delete payer',
          'Remove <strong>' + esc(r?.name || '') + '</strong> from the list? Existing patients and invoices keep their stored value.',
          'Delete',
          () => deletePayer(b.getAttribute('data-py-del')),
          DEV_TAB)
      }
    })
  }

  async function renderAudit() {
    pane.innerHTML =
      '<div class="card-head"><h3>Audit trail</h3><span class="pill">append-only</span></div>' +
      '<p class="sub">Who did what, when. Normal users can never edit or delete these records (enforced by Rules).</p>' +
      '<div class="toolbar"><select id="auAction" class="input" style="max-width:240px">' +
      AUDIT_ACTIONS.map((a) => '<option value="' + a + '"' + (state.auditAction === a ? ' selected' : '') + '>' + (a || 'All actions') + '</option>').join('') + '</select>' +
      '<div class="search"><input id="auUser" class="input" placeholder="Filter by user…" value="' + esc(state.auditUser) + '" /></div>' +
      '<button class="btn ghost sm" id="auGo">Apply</button></div>' +
      '<div id="auList"><p class="muted">Loading…</p></div>'
    const listEl = document.getElementById('auList')
    const more = createLoadMore(loadMore)

    function paintAudit() {
      const q = state.auditUser.toLowerCase()
      // Match the stored row *and* the resolved staff name, so filtering by a
      // person works even where the row still holds their email.
      const shown = q
        ? state.auditRows.filter((r) =>
          JSON.stringify(r).toLowerCase().includes(q) ||
          (r.actor_name || staffNameForId(r.actor_user_id) || staffLabel(r.actor_email) || '').toLowerCase().includes(q))
        : state.auditRows
      if (!shown.length) {
        listEl.innerHTML = '<p class="sub">No audit events match.</p>'
        return
      }
      listEl.innerHTML =
        '<div class="tblwrap"><table class="tbl"><thead><tr><th>When</th><th>Action</th><th>By</th><th>Detail</th></tr></thead><tbody>' +
        shown.map((r) => '<tr><td class="mut">' + esc(fmtTs(r.occurredAt)) + '</td><td><strong>' + esc(r.action || '') + '</strong></td>' +
          '<td class="mut">' + esc(r.actor_name || staffNameForId(r.actor_user_id) || staffLabel(r.actor_email) || r.actor_user_id || '') + '</td><td>' + esc(r.details || '') + '</td></tr>').join('') +
        '</tbody></table><div class="loadmore" data-loadmore="1"></div></div>'
      more.mount(listEl.querySelector('.tblwrap'))
    }

    // Append the next chunk of audit events. The first call has no cursor and
    // replaces the list; later ones walk forward from the last row loaded.
    async function loadMore() {
      if (state.auditLoading) return
      const first = state.auditCursor == null && state.auditRows.length === 0
      state.auditLoading = true
      more.setLoading(true)
      // Keep the existing table laid out (dimmed) while the chunk loads —
      // swapping it for a "Loading…" paragraph made the card collapse.
      listEl.querySelector('.tblwrap')?.classList.add('is-loading')
      try {
        const pg = await listAudit(activeOrg, { action: state.auditAction, cursor: state.auditCursor })
        // A row written between two chunk reads shifts the cursor stream and
        // can repeat the boundary document.
        const seen = new Set(state.auditRows.map((r) => r.id))
        state.auditRows = first
          ? pg.rows
          : [...state.auditRows, ...pg.rows.filter((r) => !seen.has(r.id))]
        state.auditCursor = pg.cursor
        state.auditMore = pg.hasMore
        state.auditFallback = !!pg.fallback
        state.auditLoading = false
        more.setLoading(false)
        more.setDone(!state.auditMore)
        paintAudit()
      } catch (e) {
        state.auditLoading = false
        more.setLoading(false)
        if (first) listEl.innerHTML = '<p class="err">' + esc(friendlyAdminError(e)) + '</p>'
        else more.setError('Could not load more — retry')
      } finally {
        listEl.querySelector('.tblwrap')?.classList.remove('is-loading')
      }
    }

    document.getElementById('auGo').onclick = () => {
      state.auditAction = document.getElementById('auAction').value
      state.auditUser = document.getElementById('auUser').value
      state.auditRows = []
      state.auditCursor = null
      state.auditMore = false
      state.auditFallback = false
      more.reset()
      loadMore()
    }
    await loadMore()
  }

  // ---- Data import / export ---------------------------------------------------
  function stopStatusPoll() {
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null }
  }

  function dataPanelHTML() {
    return '<div class="card-head"><h3>Data import / export</h3><span class="pill">SQLite .db · admin-only</span></div>' +
      '<p class="sub">Move this hospital\'s data in and out as one SQLite file (patients, encounters, admissions, billing, pharmacy…). ' +
      'Each row\'s <code>id</code> is the Firestore document id, so imports <strong>upsert</strong> — the same id overwrites its document. ' +
      'Rows are staged <strong>locally first</strong>, then pushed with the exact doc shapes and mirrors the app writes. Nothing touches the cloud until you press <strong>Push now</strong>.</p>' +

      '<div class="data-block"><h4>Template</h4>' +
      '<p class="sub">A blank .db of all ' + IMPORT_ORDER_TABLES.length + ' tables, keys, joins and a <code>schema_reference</code> guide column-by-column.</p>' +
      '<div class="mrow"><button class="btn" id="dlTemplate">Download template (.db)</button></div></div>' +

      '<div class="data-block"><h4>Export this hospital</h4>' +
      '<p class="sub">Dump Firestore data for the selected tables to a .db (timestamps become ISO text, json columns become text).</p>' +
      '<div class="fgrid" id="exportTables">' + IMPORT_ORDER_TABLES.map((e, i) => tableCheck(e, 'ex', i === 0)).join('') + '</div>' +
      '<div class="mrow"><button class="btn" id="dlExport">Export selected (.db)</button>' +
      '<span class="sub" id="exportStat"></span></div></div>' +

      '<div class="data-block"><h4>Import</h4>' +
      '<p class="sub">Pick a .db file (the template, or an export you edited), choose tables, <strong>1 · Stage locally</strong> — then <strong>Push now</strong> in the status panel below.</p>' +
      '<input type="file" id="importFile" accept=".db,.sqlite,.sqlite3" />' +
      '<div class="sub" id="importMeta"></div>' +
      '<div class="fgrid" id="importTables"></div>' +
      '<div class="mrow">' +
      '<button class="btn" id="stageBtn" disabled>1 · Stage locally</button>' +
      '<button class="btn ghost sm" id="selAll">Select all</button>' +
      '<button class="btn ghost sm" id="selNone">None</button>' +
      '</div>' +
      '<p class="err" id="importErr"></p>' +
      '<div id="importSummary"></div></div>' +

      '<div class="data-block"><h4>Upload status <span id="onlineDot" class="dot"></span></h4>' +
      '<div id="queueStats" class="qstats"></div>' +
      '<div id="queueBar"></div>' +
      '<div id="queueByTable"></div>' +
      '<div class="mrow" id="queueActions">' +
      '<button class="btn" id="pushBtn">Push now →</button>' +
      '<button class="btn ghost sm" id="pauseBtn" hidden>Pause</button>' +
      '<button class="btn ghost sm" id="flushBtn" disabled>Flush pending</button>' +
      '<button class="btn ghost sm" id="resumeBtn" disabled>Resume</button>' +
      '<button class="btn ghost sm" id="retryBtn" disabled>Retry failed</button>' +
      '<button class="btn ghost sm" id="clearBtn" disabled>Clear finished</button>' +
      '<button class="btn ghost sm" id="purgeBtn" disabled>Empty queue</button>' +
      '</div>' +
      '<div id="queueErrors"></div>' +
      '<div class="sub" style="margin-top:6px"><a href="#" id="dlErrors">Download error report (.csv)</a></div></div>'
  }

  function tableCheck(e, prefix, checked) {
    return '<label class="ck"><input type="checkbox" id="' + prefix + '-' + esc(e.table) + '" data-table="' + esc(e.table) + '"' + (checked ? ' checked' : '') + ' /> <span>' + esc(e.label) + '</span></label>'
  }

  function toggleImportChecks(on) {
    document.querySelectorAll('#importTables input[type=checkbox]').forEach((x) => { x.checked = on })
  }

  function csvEsc(s) { return String(s ?? '').replace(/"/g, '""') }

  function fileStamp() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes())
  }

  function downloadBytes(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  function wireDataPanel() {
    document.getElementById('dlTemplate').onclick = async () => {
      try {
        const bytes = await generateTemplate()
        downloadBytes(bytes, 'medilog-template.db')
        toast('Template downloaded')
      } catch (e) { toast(friendlyAdminError(e)) }
    }
    document.getElementById('dlExport').onclick = async (e) => {
      const picked = [...document.querySelectorAll('#exportTables input:checked')].map((x) => x.getAttribute('data-table'))
      if (!picked.length) { toast('Tick at least one table to export.'); return }
      e.target.disabled = true
      try {
        const bytes = await exportToDatabase(picked, { orgId: activeOrg })
        downloadBytes(bytes, 'medilog-export-' + activeOrg + '-' + fileStamp() + '.db')
        toast('Exported ' + picked.length + ' tables')
      } catch (err) { toast(friendlyAdminError(err)) }
      e.target.disabled = false
    }
    const file = document.getElementById('importFile')
    file.onchange = async () => {
      const f = file.files && file.files[0]
      if (!f) return
      document.getElementById('importErr').textContent = ''
      try {
        if (importDb) { closeDatabase(importDb); importDb = null }
        importDb = await readDatabase(f)
      } catch (err) {
        document.getElementById('importErr').textContent = friendlyAdminError(err, 'Could not read the .db file — open the browser console for details.')
        return
      }
      const known = describeDatabase(importDb)
      const meta = document.getElementById('importMeta')
      if (!known.length) {
        meta.textContent = 'This file has none of the MedLogNg tables. Use the template above to start one.'
        return
      }
      const total = known.reduce((n, t) => n + t.count, 0)
      meta.textContent = known.length + ' known table(s) · ' + total + ' total rows'
      document.getElementById('importTables').innerHTML = known.map((t) =>
        '<label class="ck"><input type="checkbox" data-table="' + esc(t.table) + '" checked /> <span>' + esc(t.label) + '</span> <span class="pill">' + t.count + '</span></label>').join('')
      document.getElementById('stageBtn').disabled = false
    }
    document.getElementById('selAll').onclick = () => toggleImportChecks(true)
    document.getElementById('selNone').onclick = () => toggleImportChecks(false)
    document.getElementById('stageBtn').onclick = doStage

    document.getElementById('pushBtn').onclick = startPush
    document.getElementById('pauseBtn').onclick = () => {
      pushStop = true
      document.getElementById('pauseBtn').disabled = true
      toast('Pausing after the current batch — press Push now to resume.')
    }
    document.getElementById('flushBtn').onclick = async () => {
      try {
        const r = await flushPending()
        if (r.offline) toast('You are offline — reconnect to flush pending writes.')
        else toast('Wrote ' + (r.flushed || 0) + ' row(s) to the cloud, ' + (r.remaining || 0) + ' still pending.')
        refreshStatus()
      } catch (e) { toast(friendlyAdminError(e)) }
    }
    document.getElementById('resumeBtn').onclick = async () => {
      await bulkQueue.resendSending()
      toast('Interrupted rows re-queued.')
      refreshStatus()
    }
    document.getElementById('retryBtn').onclick = async () => {
      const n = await bulkQueue.retryErrors()
      toast('Re-queued ' + n + ' failed row(s).')
      refreshStatus()
    }
    document.getElementById('clearBtn').onclick = async () => {
      const n = await bulkQueue.clearSynced()
      toast('Cleared ' + n + ' finished row(s).')
      refreshStatus()
    }
    document.getElementById('purgeBtn').onclick = () => {
      openModal('Empty queue',
        '<p>Remove everything staged for import on this device? Cloud/previous runs are <strong>not</strong> touched — this only clears the local outbox so you can stage a fresh file.</p>' +
        '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="purgeGo">Empty queue</button></div>')
      document.getElementById('purgeGo').onclick = async () => {
        const n = await bulkQueue.purge()
        closeModal()
        toast('Queue emptied (' + n + ' row(s)).')
        refreshStatus()
      }
    }
    document.getElementById('dlErrors').onclick = async (ev) => {
      ev.preventDefault()
      const rows = await bulkQueue.errorRows()
      const csv = ['table,document_id,message'].concat(
        rows.map((r) => '"' + csvEsc(r.table) + '","' + csvEsc(r.docId) + '","' + csvEsc(r.error) + '"'),
      ).join('\n')
      downloadBytes(new TextEncoder().encode('\ufeff' + csv), 'medilog-import-errors.csv')
    }
  }

  async function doStage() {
    const picked = [...document.querySelectorAll('#importTables input:checked')].map((x) => x.getAttribute('data-table'))
    if (!picked.length) { document.getElementById('importErr').textContent = 'Tick at least one table to stage.'; return }
    if (!importDb) return
    const btn = document.getElementById('stageBtn')
    btn.disabled = true
    btn.textContent = 'Staging…'
    document.getElementById('importErr').textContent = ''
    try {
      const res = await stageImport(importDb, picked, { orgId: activeOrg })
      renderImportSummary(res)
      closeDatabase(importDb)
      importDb = null
      document.getElementById('importFile').value = ''
      toast('Staged ' + res.staged + ' row(s) locally — ready to push.')
      refreshStatus()
    } catch (err) {
      document.getElementById('importErr').textContent = friendlyAdminError(err)
      btn.disabled = false
    }
    btn.textContent = '1 · Stage locally'
  }

  function renderImportSummary(res) {
    const el = document.getElementById('importSummary')
    if (!el) return
    let html = '<div class="msum"><strong>' + res.staged + ' row(s) staged locally.</strong>' +
      (Object.keys(res.perTable).length
        ? '<div class="sub">' + esc(Object.entries(res.perTable).map(([t, n]) => t + ' × ' + n).join(' · ')) + '</div>'
        : '<div class="sub">Nothing to stage in the selected tables.</div>')
    if (res.errors.length) {
      html += '<p class="err">' + res.errors.length + ' row(s) skipped: ' +
        esc(res.errors.slice(0, 10).map((r) => r.table + ' ' + r.id + ' — ' + r.message).join('; ')) +
        (res.errors.length > 10 ? '; …' : '') + '</p>'
    }
    if (res.fkWarnings.length) {
      html += '<p class="sub" style="background:#fffbeb;border:1px solid #fcd34d;border-radius:10px;padding:8px 12px">' +
        'Foreign-key check: ' + res.fkWarnings.map((w) =>
          w.table + '.' + w.column + ' → ' + w.references + ': ' + w.missing + ' id(s) not in the file' +
          (w.samples.length ? ' (e.g. ' + esc(w.samples.join(', ')) + ')' : '')).join(' · ') +
        '</p>'
    }
    html += '</div>'
    el.innerHTML = html
  }

  async function refreshStatus() {
    if (pushing) return
    const c = await bulkQueue.counts().catch(() => null)
    if (!c) return
    const tabs = await bulkQueue.byTable().catch(() => [])
    const errs = await bulkQueue.errorRows().catch(() => [])
    lastTabs = tabs
    lastErrs = errs
    renderQueueUi(c, tabs, errs)
  }

  // The importer auto-writes a mirror row for every patient (patients ->
  // organization_patients). Fold those derived rows under the parent table they
  // come from and tag them "auto", so one import does not look like two tables
  // holding duplicate data.
  function mirrorParent(table) {
    const parent = IMPORT_ORDER_TABLES.find((e) => e.importMirror && e.importMirror.table === table)
    return parent ? parent.table : ''
  }

  function queueRow(t, mirrored) {
    let name = esc(t.table)
    if (mirrored && mirrored.length) {
      name += mirrored.map((m) =>
        '<div class="mut">↳ ' + esc(m.table) +
        ' <span class="pill" title="Mirror record the importer writes automatically for imported patients">auto</span>' +
        ' · ' + m.total + (m.error ? ' <span class="err">' + m.error + ' failed</span>' : '') +
        '</div>').join('')
    } else if (t.auto > 0) {
      name += ' <span class="pill" title="Rows the importer writes automatically for imported patients">' + t.auto + ' auto</span>'
    }
    return '<tr><td>' + name + '</td><td>' + t.total + '</td><td>' + t.queued + '</td><td>' + t.sending +
      '</td><td>' + t.written + '</td><td>' + t.synced + '</td><td' + (t.error ? ' class="err"' : '') + '>' + t.error + '</td></tr>'
  }

  function renderQueueUi(c, tabs, errs) {
    const dot = document.getElementById('onlineDot')
    if (dot) {
      const online = typeof navigator === 'undefined' || navigator.onLine !== false
      dot.className = 'dot ' + (online ? 'ok' : 'off')
      dot.title = online ? 'Online — pushes sync to the cloud' : 'Offline — pushes stay local until you reconnect'
    }
    const stats = document.getElementById('queueStats')
    if (stats) {
      const remaining = c.queued + c.sending + c.written
      const pct = c.total ? Math.round(((c.total - remaining) / c.total) * 100) : 0
      stats.innerHTML =
        '<span class="pill">total ' + c.total + '</span>' +
        '<span class="pill">queued ' + c.queued + '</span>' +
        '<span class="pill">sending ' + c.sending + '</span>' +
        '<span class="pill warn">pending cloud sync ' + c.written + '</span>' +
        '<span class="pill ok">synced ' + c.synced + '</span>' +
        '<span class="pill' + (c.error ? ' bad' : '') + '">failed ' + c.error + '</span>' +
        (c.total ? '<span class="pill">' + pct + '%</span>' : '')
    }
    const bar = document.getElementById('queueBar')
    if (bar) {
      const remaining = c.queued + c.sending + c.written
      const pct = c.total ? Math.round(((c.total - remaining) / c.total) * 100) : 0
      bar.innerHTML = '<div class="bar"><div class="barfill" style="width:' + pct + '%"></div></div>'
    }
    const byT = document.getElementById('queueByTable')
    if (byT) {
      if (tabs && tabs.length) {
        const mirroredByParent = new Map()
        const top = []
        for (const t of tabs) {
          const parent = t.auto && t.auto === t.total ? mirrorParent(t.table) : ''
          const parentTab = parent && tabs.find((x) => x.table === parent)
          if (parentTab) {
            if (!mirroredByParent.has(parent)) mirroredByParent.set(parent, [])
            mirroredByParent.get(parent).push(t)
          } else {
            top.push(t)
          }
        }
        byT.innerHTML = '<div class="tblwrap"><table class="tbl"><thead><tr><th>Table</th><th>Total</th><th>Queued</th><th>Sending</th><th>Pending cloud</th><th>Synced</th><th>Failed</th></tr></thead><tbody>' +
          top.map((t) => queueRow(t, mirroredByParent.get(t.table))).join('') + '</tbody></table></div>' +
          (mirroredByParent.size
            ? '<p class="sub" style="margin-top:6px">“auto” rows are mirror records the importer writes automatically for imported patients — not a second copy of the data.</p>'
            : '')
      } else {
        byT.innerHTML = '<p class="sub">Nothing staged yet — upload a .db and press “1 · Stage locally”.</p>'
      }
    }
    const errEl = document.getElementById('queueErrors')
    if (errEl) {
      const errs = lastErrs || []
      errEl.innerHTML = errs.length
        ? '<p class="err"><strong>' + errs.length + ' failed row(s).</strong><br/>' +
          esc(errs.slice(0, 6).map((r) => r.table + ' · ' + (r.docId || '(new)') + ': ' + r.error).join('<br/>') || '') +
          (errs.length > 6 ? '<br/>… download the full error report below.' : '') + '</p>'
        : ''
    }
    setQueueButtons(c)
  }

  function setQueueButtons(c) {
    const push = document.getElementById('pushBtn')
    const pause = document.getElementById('pauseBtn')
    const flush = document.getElementById('flushBtn')
    const resume = document.getElementById('resumeBtn')
    const retry = document.getElementById('retryBtn')
    const clear = document.getElementById('clearBtn')
    const purge = document.getElementById('purgeBtn')
    if (push) push.disabled = pushing || (!c.queued && !c.sending)
    if (pause) pause.hidden = !pushing
    if (flush) flush.disabled = !c.written
    if (resume) resume.disabled = pushing || !c.sending
    if (retry) retry.disabled = !c.error
    if (clear) clear.disabled = !c.synced
    if (purge) purge.disabled = pushing || !c.total
  }

  async function startPush() {
    if (pushing) return
    const c = await bulkQueue.counts().catch(() => null)
    if (!c || (!c.queued && !c.sending && !c.written)) { toast('Nothing to push — stage an import first.'); return }
    pushing = true
    pushStop = false
    try {
      await pushQueue({
        shouldStop: () => pushStop,
        onProgress: onPushProgress,
      })
    } catch (e) {
      toast(friendlyAdminError(e, 'Push failed'))
    } finally {
      pushing = false
    }
    await refreshStatus()
  }

  function onPushProgress({ sent, failed, counts, done }) {
    renderQueueUi(counts, lastTabs, lastErrs)
    if (done) {
      toast(failed
        ? 'Push complete — ' + sent + ' written, ' + failed + ' failed (see error report).'
        : 'Push complete — ' + sent + ' row(s) written' + (counts.synced ? ' and synced to the cloud.' : '.'))
    }
  }

  async function renderData() {
    pane.innerHTML = dataPanelHTML()
    wireDataPanel()
    await refreshStatus()
    statusTimer = setInterval(refreshStatus, 1000)
  }

  function syncTabs(name) {
    document.querySelectorAll('#adt button').forEach((x) => x.classList.toggle('on', x.getAttribute('data-t') === name))
  }

  async function reloadAndRender(tab) {
    pane.innerHTML = '<p class="muted">Loading…</p>'
    const ok = await refreshAll()
    if (ok) render(tab)
  }

  // The laboratory tab is a summary + launch pad; the catalogue itself is
  // managed on a dedicated full page (which carries the same capability gate).
  async function renderLaboratory() {
    pane.innerHTML = '<p class="muted">Loading…</p>'
    const labCaps = myLabAdminCaps()
    try {
      const [tests, settings] = await Promise.all([
        listOrgTests(activeOrg),
        getLabSettings(activeOrg),
      ])
      const active = tests.filter((t) => t.active).length
      const withComponents = tests.filter((t) => (t.components || []).length).length
      pane.innerHTML =
        '<div class="card-head"><h3>Laboratory</h3>' +
        (labCaps.canManageCatalogue
          ? '<a class="btn sm" href="#/laboratory/catalogue">Open test catalogue →</a>'
          : '') + '</div>' +
        '<p class="sub">The test catalogue drives order entry, result forms and printed reports. Ordered tests freeze a snapshot of the catalogue entry — editing a test never rewrites history.</p>' +
        '<div class="grid4">' +
        '<div class="stat"><em>Catalogue</em><strong>' + tests.length + '</strong><span>tests (' + active + ' active)</span></div>' +
        '<div class="stat"><em>Structured</em><strong>' + withComponents + '</strong><span>with result components</span></div>' +
        '<div class="stat"><em>Categories</em><strong>' + (settings.categories || []).length + '</strong><span>on order forms</span></div>' +
        '<div class="stat"><em>Specimen types</em><strong>' + (settings.specimen_types || []).length + '</strong><span>configured</span></div>' +
        '</div>' +
        (labCaps.canManageCatalogue
          ? '<div class="mrow" style="margin-top:12px">' +
            '<a class="btn ghost" href="#/laboratory/catalogue">Manage tests & components</a>' +
            '<a class="btn ghost" href="#/laboratory">Open laboratory worklist</a></div>'
          : '<p class="sub">Your role can view this summary but only administrators with <code>lab.catalogue.manage</code> can edit the catalogue.</p>')
    } catch (e) {
      pane.innerHTML = '<h3>Could not load laboratory summary</h3><p class="err">' + esc(friendlyAdminError(e)) + '</p>' +
        '<button class="btn ghost" id="labRetry">Retry</button>'
      document.getElementById('labRetry').onclick = () => render(LAB_TAB)
    }
  }

  function render(tab) {
    stopStatusPoll()
    syncTabs(tab)
    if (tab === 'Staff & roles') renderStaff()
    else if (tab === 'Organization') renderOrg()
    else if (tab === 'Devices') renderDevices()
    else if (tab === LAB_TAB) renderLaboratory()
    else if (tab === DATA_TAB) renderData()
    else if (tab === DEV_TAB) renderPayers()
    else renderAudit()
  }

  document.querySelectorAll('#adt button').forEach((b) => {
    b.onclick = () => render(b.getAttribute('data-t'))
  })
  document.getElementById('inviteTop').onclick = openCreateStaff

  // The 1s status poll below is started by renderData() and only stopped by
  // render(). Navigating off Administration without touching a tab left it
  // running against a detached pane, hitting IndexedDB every second for the
  // rest of the session. Tie it to the view's lifetime.
  onCleanup(() => stopStatusPoll())

  pane.innerHTML = '<p class="muted">Loading…</p>'
  const ok = await refreshAll()
  if (ok) render('Staff & roles')
}
