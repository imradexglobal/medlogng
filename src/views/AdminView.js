// Administration — fully wired (live Firestore, Spark plan: no backend).
// Tabs: Staff & roles · Organization · Devices · Audit trail.
// UX gates hide controls; Firestore Security Rules remain the authority.
import { shell, statusBadge, openModal, closeModal, toast, field, inp, sel } from '../components/shell.js'
import { authStore } from '../store/authStore.js'
import { auth } from '../firebase.js'
import { loadOrganization, setActiveOrg, sendVerificationEmail } from '../services/authService.js'
import {
  myAdminCaps, listMembers, approveMember, rejectMember, suspendMember,
  reactivateMember, updateMemberRole, requirePasswordReset, listInvites,
  createInvite, revokeInvite, updateOrgProfile, registerThisDevice,
  listOrgDevices, setDeviceStatus, listAudit, AUDIT_ACTIONS, AUDIT_PAGE,
  friendlyAdminError,
} from '../services/adminService.js'
import { ROLE_OPTIONS, ROLE_CAPS, isValidEmail } from '../features/admin/roles.js'
import {
  listPayers, savePayer, setPayerActive, deletePayer, refreshCache,
  myPayerCaps, cachedPayers, PAYER_CATEGORIES,
} from '../services/payerService.js'
import { isDevHost, hostName } from '../utils/env.js'
import { esc } from '../utils/sanitize.js'

// The payer list is a global master list, not a per-hospital setting, so its
// maintenance screen is a developer tool: it only renders on localhost. Hospital
// staff never see the tab — they only ever read the cached list into the payer
// dropdown on Register patient / Edit demographics / New invoice.
const TABS = ['Staff & roles', 'Organization', 'Devices', 'Audit trail']
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
  const state = { members: [], invites: [], org: null, auditCursor: [], auditAction: '', auditUser: '', auditRows: [] }

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
    const caps = ROLE_CAPS[role] || []
    if (caps.includes('*')) return 'All capabilities (*)'
    return caps.join('\n')
  }

  function statusPill(s) {
    const cls = s === 'active' ? 'ok' : s === 'pending' ? 'warn' : s === 'suspended' ? 'bad' : s === 'rejected' ? 'bad' : s === 'revoked' ? 'bad' : ''
    return '<span class="pill ' + cls + '">' + esc(s) + '</span>'
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
          '<button class="btn ghost sm" data-reject="' + esc(m.id) + '">Reject</button>'
      } else if (m.status === 'active') {
        actions = (self ? '<span class="muted">you</span>'
          : '<button class="btn ghost sm" data-saverole="' + esc(m.id) + '">Save role</button> ' +
            '<button class="btn ghost sm" data-suspend="' + esc(m.id) + '">Suspend</button> ' +
            '<button class="btn ghost sm" data-pwreset="' + esc(m.id) + '">' + (m.must_change_password ? 'Clear pw flag' : 'Require pw change') + '</button>')
      } else {
        actions = '<button class="btn ghost sm" data-reactivate="' + esc(m.id) + '">Reactivate</button>'
      }
    }
    return '<tr><td><strong>' + esc(m.staff_name || '(no name)') + '</strong>' + flags + '</td>' +
      '<td>' + roleSel + (m.requested_role && m.requested_role !== m.role ? '<div class="mut">requested: ' + esc(m.requested_role) + '</div>' : '') + '</td>' +
      '<td class="mut">' + esc(capsOf(m)) + '</td><td>' + statusPill(m.status) + '</td><td>' + actions + '</td></tr>'
  }

  function renderStaff() {
    const pending = state.members.filter((m) => m.status === 'pending')
    const active = state.members.filter((m) => m.status === 'active')
    const others = state.members.filter((m) => m.status !== 'pending' && m.status !== 'active')
    pane.innerHTML =
      '<div class="card-head"><h3>Staff & roles</h3><span class="pill">' + state.members.length + ' members</span></div>' +
      '<p class="sub">Roles map to fixed capabilities enforced by Security Rules. Max <strong>2 active hospital admins</strong> — receptionists cannot prescribe (hidden here for UX, blocked in Rules for real).</p>' +
      (canManageRoles ? '<div class="toolbar"><button class="btn sm" id="createStaff">+ Create staff</button>' +
        '<span class="sub">New staff: enter email + role → they sign up themselves with that email + Org ID, then you approve.</span></div>' : '') +
      '<h3>Pending approvals (' + pending.length + ')</h3>' +
      (pending.length
        ? '<div class="tblwrap"><table class="tbl"><tr><th>Staff</th><th>Role</th><th>Caps</th><th>Status</th><th></th></tr>' + pending.map(memberRow).join('') + '</table></div>'
        : '<p class="sub">No pending requests. Share the Org ID (top-right) with staff to let them join.</p>') +
      '<h3 style="margin-top:14px">Active (' + active.length + ')</h3>' +
      '<div class="tblwrap"><table class="tbl"><tr><th>Staff</th><th>Role</th><th>Caps</th><th>Status</th><th></th></tr>' + (active.map(memberRow).join('') || '<tr><td colspan="5" class="muted">None</td></tr>') + '</table></div>' +
      (others.length ? '<h3 style="margin-top:14px">Suspended / rejected (' + others.length + ')</h3>' +
        '<div class="tblwrap"><table class="tbl"><tr><th>Staff</th><th>Role</th><th>Caps</th><th>Status</th><th></th></tr>' + others.map(memberRow).join('') + '</table></div>' : '') +
      (canManageRoles ? '<h3 style="margin-top:14px">Pending invites (' + state.invites.length + ')</h3>' +
        (state.invites.length
          ? '<div class="tblwrap"><table class="tbl"><tr><th>Email</th><th>Role</th><th></th></tr>' +
            state.invites.map((v) => '<tr><td><strong>' + esc(v.email) + '</strong></td><td>' + esc(v.role) + '</td>' +
              '<td><button class="btn ghost sm" data-revoke-inv="' + esc(v.id) + '">Revoke</button></td></tr>').join('') + '</table></div>'
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

  function wireMemberButtons() {
    pane.querySelectorAll('[data-approve]').forEach((b) => {
      b.onclick = () => {
        const m = find(b.getAttribute('data-approve'))
        const role = pane.querySelector('[data-role-for="' + m.id + '"]')?.value || m.requested_role || m.role || 'receptionist'
        confirmDo('Approve staff', 'Approve <strong>' + esc(m.staff_name || m.user_id) + '</strong> as <strong>' + esc(role) + '</strong> with ' + (ROLE_CAPS[role] || []).length + ' capabilities (' + esc((ROLE_CAPS[role] || []).join(', ')) + ')?', 'Approve →',
          () => approveMember(m, role))
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
        confirmDo('Change role', 'Change <strong>' + esc(m.staff_name || m.user_id) + '</strong> from <strong>' + esc(m.role) + '</strong> to <strong>' + esc(role) + '</strong>? Capabilities update immediately.', 'Change role', () => updateMemberRole(m, role))
      }
    })
    pane.querySelectorAll('[data-pwreset]').forEach((b) => {
      b.onclick = async () => {
        const m = find(b.getAttribute('data-pwreset'))
        try { await requirePasswordReset(m, !m.must_change_password); toast('Updated.'); await reloadAndRender('Staff & roles') }
        catch (e) { toast(friendlyAdminError(e)) }
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
      '</div><p id="csErr" class="err"></p>' +
      '<div class="mrow"><button class="btn ghost" data-close>Cancel</button><button class="btn" id="csGo">Create →</button></div>' +
      '<p class="sub" id="csCaps"></p>')
    const roleSel = document.getElementById('csRole')
    const caps = document.getElementById('csCaps')
    const showCaps = () => { caps.textContent = 'Capabilities: ' + (ROLE_CAPS[roleSel.value].includes('*') ? 'all (*)' : ROLE_CAPS[roleSel.value].join(', ')) }
    roleSel.onchange = showCaps
    showCaps()
    document.getElementById('csGo').onclick = async (e) => {
      const email = document.getElementById('csEmail').value
      if (!isValidEmail(email)) { document.getElementById('csErr').textContent = 'Enter a valid email address'; return }
      e.target.disabled = true
      try {
        await createInvite(activeOrg, email, roleSel.value)
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
        ? '<div class="tblwrap"><table class="tbl"><tr><th>Device</th><th>User</th><th>Last seen</th><th>Status</th><th></th></tr>' +
          devs.map((d) => '<tr><td><strong>' + esc(d.device_name || d.id) + '</strong><div class="mut">' + esc(d.platform || '') + ' · ' + esc(d.id) + '</div></td>' +
            '<td class="mut">' + esc(d.user_email || '—') + '</td>' +
            '<td class="mut">' + esc(d.last_seen?.toDate ? d.last_seen.toDate().toLocaleString() : '—') + '</td>' +
            '<td>' + statusPill(d.status || 'active') + '</td>' +
            '<td>' + (canManageDevices
              ? (d.status === 'revoked'
                ? '<button class="btn ghost sm" data-unrev="' + esc(d.id) + '">Reactivate</button>'
                : '<button class="btn ghost sm" data-rev="' + esc(d.id) + '">Revoke</button>')
              : '') + '</td></tr>').join('') + '</table></div>'
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
        ? '<div class="tblwrap"><table class="tbl"><tr><th>Payer</th><th>Category</th><th>Sort</th><th>Code</th><th>Status</th><th></th></tr>' +
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
            '</td></tr>').join('') + '</table></div>'
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
      '<div id="auList"><p class="muted">Loading…</p></div>' +
      '<div class="mrow"><button class="btn ghost sm" id="auPrev">← Newer</button><button class="btn ghost sm" id="auNext">Older (' + AUDIT_PAGE + ' per page)</button></div>'
    const listEl = document.getElementById('auList')
    async function load() {
      listEl.innerHTML = '<p class="muted">Loading…</p>'
      try {
        const { rows, lastDoc, hasMore } = await listAudit(activeOrg, { action: state.auditAction, cursorStack: state.auditCursor })
        state.auditRows = rows
        state.auditLast = lastDoc
        state.auditMore = hasMore
        const q = state.auditUser.toLowerCase()
        const shown = q ? rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q)) : rows
        listEl.innerHTML = shown.length
          ? '<div class="tblwrap"><table class="tbl"><tr><th>When</th><th>Action</th><th>By</th><th>Detail</th></tr>' +
            shown.map((r) => '<tr><td class="mut">' + esc(fmtTs(r.occurredAt)) + '</td><td><strong>' + esc(r.action || '') + '</strong></td>' +
              '<td class="mut">' + esc(r.actor_email || r.actor_user_id || '') + '</td><td>' + esc(r.details || '') + '</td></tr>').join('') + '</table></div>'
          : '<p class="sub">No audit events match.</p>'
        document.getElementById('auNext').disabled = !hasMore
        document.getElementById('auPrev').disabled = state.auditCursor.length === 0
      } catch (e) {
        listEl.innerHTML = '<p class="err">' + esc(friendlyAdminError(e)) + '</p>'
      }
    }
    document.getElementById('auGo').onclick = () => {
      state.auditAction = document.getElementById('auAction').value
      state.auditUser = document.getElementById('auUser').value
      state.auditCursor = []
      load()
    }
    document.getElementById('auNext').onclick = () => {
      if (!state.auditMore) return
      state.auditCursor = [...state.auditCursor, state.auditLast]
      load()
    }
    document.getElementById('auPrev').onclick = () => {
      state.auditCursor = state.auditCursor.slice(0, -1)
      load()
    }
    await load()
  }

  function syncTabs(name) {
    document.querySelectorAll('#adt button').forEach((x) => x.classList.toggle('on', x.getAttribute('data-t') === name))
  }

  async function reloadAndRender(tab) {
    pane.innerHTML = '<p class="muted">Loading…</p>'
    const ok = await refreshAll()
    if (ok) render(tab)
  }

  function render(tab) {
    syncTabs(tab)
    if (tab === 'Staff & roles') renderStaff()
    else if (tab === 'Organization') renderOrg()
    else if (tab === 'Devices') renderDevices()
    else if (tab === DEV_TAB) renderPayers()
    else { state.auditCursor = state.auditCursor || []; renderAudit() }
  }

  document.querySelectorAll('#adt button').forEach((b) => {
    b.onclick = () => render(b.getAttribute('data-t'))
  })
  document.getElementById('inviteTop').onclick = openCreateStaff

  pane.innerHTML = '<p class="muted">Loading…</p>'
  const ok = await refreshAll()
  if (ok) render('Staff & roles')
}
