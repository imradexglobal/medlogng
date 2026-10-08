import { loginEmail, loginGoogle, authErrorMessage, registerNewHospital, registerJoinHospital, registrationErrorMessage, postLoginRoute } from '../services/authService.js'
import { authStore } from '../store/authStore.js'
import { navigate } from '../router.js'
import { esc } from '../utils/sanitize.js'
import { validateRegistration, validateOrg, ORG_TYPES, JOIN_ROLES, normalizeOrgId } from '../features/orgs/domain.js'

// Unified auth screen, inspired by https://app.fundednext.com/login.
// Single page, three inline modes — Log in / Create / Join — no page flip.
// Right side: full-bleed Nigerian-healthcare imagery + glass benefit card.
const SLIDES = [
  {
    img: 'https://images.unsplash.com/photo-1622253692010-333f2da6031d?q=80&w=1400&auto=format&fit=crop',
    alt: 'African doctor in white coat with stethoscope',
    badge: 'Built for Nigeria',
    title: 'Admit in minutes, not hours',
    body: 'Paperless intake, vitals and encounter notes in one flow — for hospitals, clinics, diagnostic centres and pharmacies.',
    stat: 'EMR + Pharmacy + Billing in one workspace',
  },
  {
    img: 'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?q=80&w=1400&auto=format&fit=crop',
    alt: 'Doctor reviewing digital patient records on a tablet',
    badge: 'Secure & reliable',
    title: 'Patient records you can trust',
    body: 'Role-based access per hospital, audit-friendly history and cloud backup — no missing folders, ever.',
    stat: 'Role-based access · Cloud backup · Audit trail',
  },
  {
    img: 'https://images.unsplash.com/photo-1538108149393-fbbd81895907?q=80&w=1400&auto=format&fit=crop',
    alt: 'Modern hospital corridor',
    badge: 'For every care team',
    title: 'One workspace per hospital',
    body: 'Create a hospital to go live immediately as admin — or join your team and start once your admin approves.',
    stat: 'Lagos · Abuja · PH · Kano — works anywhere',
  },
]

export async function LoginView(app, params = {}) {
  const { user } = authStore.getState()
  if (user) { navigate('/welcome'); return }

  const initial = params && params.initial === 'join' ? 'join'
    : params && params.initial === 'create' ? 'create' : 'login'
  let mode = initial
  let timer = null
  let idx = 0

  app.innerHTML =
    '<div class="fn-page">' +
      '<div class="fn-left"><div class="fn-form">' +
        '<div class="fn-brand"><span class="brand-mark">✚</span>' +
          '<span><span class="fn-brand-name">MediLog NG</span>' +
          '<span class="fn-live"><i></i>System online</span></span></div>' +
        '<div class="fn-seg" role="tablist">' +
          '<button id="segLogin" class="fn-seg-btn" role="tab">Log in</button>' +
          '<button id="segCreate" class="fn-seg-btn" role="tab">Create</button>' +
          '<button id="segJoin" class="fn-seg-btn" role="tab">Join</button>' +
        '</div>' +
        '<div id="fnPane"></div>' +
        '<p id="err" class="err fn-err"></p>' +
        '<p class="fn-foot muted">New hospitals go live immediately · Joining needs admin approval.</p>' +
      '</div></div>' +
      '<div class="fn-right" aria-hidden="true">' +
        '<img id="fnImg" class="fn-img" src="' + SLIDES[0].img + '" alt="" />' +
        '<div class="fn-veil"></div>' +
        '<div class="fn-show">' +
          '<div id="fnSlide" class="fn-glass"></div>' +
          '<div class="fn-show-foot"><div id="fnDots" class="fn-dots"></div>' +
          '<p class="fn-trust">Trusted by care teams across Nigeria</p></div>' +
        '</div>' +
      '</div>' +
    '</div>'

  const pane = document.getElementById('fnPane')
  const errBox = () => document.getElementById('err')
  const setSeg = () => {
    document.getElementById('segLogin').classList.toggle('on', mode === 'login')
    document.getElementById('segCreate').classList.toggle('on', mode === 'create')
    document.getElementById('segJoin').classList.toggle('on', mode === 'join')
  }

  // ---------- carousel ----------
  const imgEl = document.getElementById('fnImg')
  const slideEl = document.getElementById('fnSlide')
  const dotsEl = document.getElementById('fnDots')
  imgEl.onerror = () => { imgEl.style.display = 'none' }
  function renderSlide() {
    const s = SLIDES[idx]
    slideEl.innerHTML =
      '<p class="fn-badge">' + esc(s.badge) + '</p>' +
      '<h2>' + esc(s.title) + '</h2>' +
      '<p class="fn-show-body">' + esc(s.body) + '</p>' +
      '<p class="fn-stat">' + esc(s.stat) + '</p>'
    dotsEl.innerHTML = SLIDES.map((_, i) =>
      '<button data-i="' + i + '" class="fn-dot' + (i === idx ? ' on' : '') + '" aria-label="Slide ' + (i + 1) + '"></button>'
    ).join('')
    dotsEl.querySelectorAll('.fn-dot').forEach((d) => {
      d.onclick = () => { idx = Number(d.dataset.i); crossfade(); restart() }
    })
  }
  function crossfade() {
    const s = SLIDES[idx]
    imgEl.style.opacity = '0'
    setTimeout(() => {
      imgEl.onerror = () => { imgEl.style.display = 'none' }
      imgEl.style.display = ''
      imgEl.src = s.img
      imgEl.alt = s.alt
      imgEl.onload = () => { imgEl.style.opacity = '1' }
      setTimeout(() => { imgEl.style.opacity = '1' }, 350)
    }, 180)
    renderSlide()
  }
  function restart() {
    if (timer) clearInterval(timer)
    timer = setInterval(() => { idx = (idx + 1) % SLIDES.length; crossfade() }, 6000)
  }
  renderSlide()
  restart()

  // ---------- mode switching (inline, no navigation) ----------
  function setMode(m) {
    mode = m
    errBox().textContent = ''
    setSeg()
    if (m === 'login') renderLogin()
    else if (m === 'create') renderCreate()
    else renderJoin()
  }
  document.getElementById('segLogin').onclick = () => setMode('login')
  document.getElementById('segCreate').onclick = () => setMode('create')
  document.getElementById('segJoin').onclick = () => setMode('join')

  function subline(title, sub) {
    return '<h1 class="fn-title">' + esc(title) + '</h1>' +
      '<p class="fn-sub">' + sub + '</p>'
  }
  const createOrJoinLinks =
    'Don\'t have a Hospital yet? ' +
    '<button class="fn-linkbtn" id="linkCreate">Create</button> or ' +
    '<button class="fn-linkbtn" id="linkJoin">Join</button> one'
  function wireSubLinks() {
    const c = document.getElementById('linkCreate')
    const j = document.getElementById('linkJoin')
    const b = document.getElementById('linkBackLogin')
    if (c) c.onclick = () => setMode('create')
    if (j) j.onclick = () => setMode('join')
    if (b) b.onclick = () => setMode('login')
  }

  function renderPasswordField(inputId, labelText, autocomplete, placeholder, type = 'password', extraHtml = '') {
    const toggleId = inputId + 'Toggle'
    return '<div class="fn-pw-wrap">' +
      '<div class="fn-label-row"><label class="fn-label" for="' + inputId + '">' + labelText + '</label>' + extraHtml + '</div>' +
      '<div class="fn-pw-input-wrap">' +
        '<input id="' + inputId + '" class="input fn-input" type="' + type + '" autocomplete="' + autocomplete + '" placeholder="' + placeholder + '" />' +
        '<button id="' + toggleId + '" class="fn-pw-toggle" type="button" tabindex="-1" aria-label="Show password" aria-pressed="false">' +
          '<svg class="fn-eye-open" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>' +
          '<svg class="fn-eye-closed" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" hidden><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>' +
        '</button>' +
      '</div>' +
    '</div>'
  }

  function setupPasswordToggle(inputId) {
    const input = document.getElementById(inputId)
    const toggle = document.getElementById(inputId + 'Toggle')
    if (!input || !toggle) return
    toggle.onclick = () => {
      const isPassword = input.type === 'password'
      input.type = isPassword ? 'text' : 'password'
      toggle.setAttribute('aria-pressed', isPassword)
      toggle.querySelector('.fn-eye-open').hidden = isPassword
      toggle.querySelector('.fn-eye-closed').hidden = !isPassword
      toggle.setAttribute('aria-label', isPassword ? 'Hide password' : 'Show password')
    }
  }

  // ---------- LOGIN ----------
  function renderLogin() {
    pane.innerHTML =
      subline('Welcome Back', createOrJoinLinks) +
      '<label class="fn-label" for="em">Email</label>' +
      '<input id="em" class="input fn-input" type="email" autocomplete="username" placeholder="you@hospital.ng" />' +
      renderPasswordField('pw', 'Password', 'current-password', 'Enter your password', 'password', '<button id="forgotLink" class="fn-linkbtn fn-forgot">Forgot password?</button>') +
      '<p id="forgotNote" class="fn-note" hidden>Password reset is coming soon — please contact your hospital admin.</p>' +
      '<button id="b1" class="fn-primary">Log in</button>' +
      '<div class="fn-or"><span></span><em>Or</em><span></span></div>' +
      '<button id="b2" class="fn-google">' +
        '<svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.1H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 13 4 4 13 4 24s9 20 20 20 20-9 20-20c0-1.3-.1-2.6-.4-3.9z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3l5.7-5.7C34.3 6.1 29.4 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.1H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C41 35.4 44 30.2 44 24c0-1.3-.1-2.6-.4-3.9z"/></svg>' +
        ' Continue with Google</button>'
    wireSubLinks()
    setupPasswordToggle('pw')
    document.getElementById('forgotLink').onclick = () => {
      document.getElementById('forgotNote').hidden = false
    }
    const busy = (on) => {
      document.getElementById('b1').disabled = on
      document.getElementById('b2').disabled = on
      document.getElementById('b1').textContent = on ? 'Logging in…' : 'Log in'
    }
    const doLogin = async () => {
      errBox().textContent = ''
      busy(true)
      try {
        await loginEmail(
          document.getElementById('em').value,
          document.getElementById('pw').value,
        )
        if (timer) clearInterval(timer)
        navigate(await postLoginRoute())
      } catch (e) {
        errBox().textContent = esc(authErrorMessage(e && e.code))
        busy(false)
      }
    }
    document.getElementById('b1').onclick = doLogin
    document.getElementById('pw').onkeydown = (e) => { if (e.key === 'Enter') doLogin() }
    document.getElementById('em').onkeydown = (e) => { if (e.key === 'Enter') doLogin() }
    document.getElementById('b2').onclick = async () => {
      errBox().textContent = ''
      busy(true)
      try {
        const { user, memberships, activeMship } = await loginGoogle()
        if (timer) clearInterval(timer)
        if (activeMship) {
          // Already a member with active status — go straight to dashboard.
          navigate(await postLoginRoute())
        } else if (memberships.length > 0) {
          // Email exists but membership is pending/suspended/rejected.
          // Show a choice: create a new hospital or join the existing one.
          await showMembershipChoice(user, memberships)
        } else {
          // First-time user — start the new-hospital registration flow.
          navigate('/register')
        }
      } catch {
        errBox().textContent = 'Google sign-in failed.'
        busy(false)
      }
    }
  }

  // ---------- shared account fields ----------
  function accountFields() {
    return '<div class="grid2"><div><label class="fn-label" for="nm">Full name</label>' +
      '<input id="nm" class="input fn-input" autocomplete="name" placeholder="Your full name" /></div>' +
      '<div><label class="fn-label" for="em2">Email</label>' +
      '<input id="em2" class="input fn-input" type="email" autocomplete="username" placeholder="you@hospital.ng" /></div></div>' +
      '<div class="grid2"><div>' + renderPasswordField('pw2', 'Password (min 8)', 'new-password', '••••••••') + '</div>' +
      '<div>' + renderPasswordField('pc', 'Confirm password', 'new-password', '••••••••') + '</div></div>'
  }
  function setBusy(on, btnId, idleText, busyText) {
    const btn = document.getElementById(btnId)
    if (btn) { btn.disabled = on; btn.textContent = on ? busyText : idleText }
  }

  // ---------- CREATE ----------
  function renderCreate() {
    pane.innerHTML =
      subline('Create your Hospital', 'Already have an account? <button class="fn-linkbtn" id="linkBackLogin">Log in</button>') +
      accountFields() +
      '<label class="fn-label" for="on">Facility name</label>' +
      '<input id="on" class="input fn-input" placeholder="e.g. Imradex Specialist Hospital, Lagos" />' +
      '<div class="grid2"><div><label class="fn-label" for="ot">Type</label><select id="ot" class="select fn-input">' +
      ORG_TYPES.map((t) => '<option>' + esc(t) + '</option>').join('') + '</select></div>' +
      '<div><label class="fn-label" for="os">State</label><input id="os" class="input fn-input" placeholder="Lagos" /></div></div>' +
      '<label class="fn-label" for="ol">LGA <span class="muted">(optional)</span></label>' +
      '<input id="ol" class="input fn-input" placeholder="e.g. Ikeja" />' +
      '<button id="go" class="fn-primary">Create hospital →</button>' +
      '<div id="msg"></div>'
    wireSubLinks()
    setupPasswordToggle('pw2')
    setupPasswordToggle('pc')
    document.getElementById('go').onclick = async () => {
      const msg = document.getElementById('msg')
      const v = {
        name: document.getElementById('nm').value.trim(),
        email: document.getElementById('em2').value.trim(),
        password: document.getElementById('pw2').value,
        confirm: document.getElementById('pc').value,
      }
      const org = {
        name: document.getElementById('on').value.trim(),
        orgType: document.getElementById('ot').value,
        state: document.getElementById('os').value.trim(),
      }
      const e1 = validateRegistration(v)
      const e2 = validateOrg(org)
      if (e1 || e2) { errBox().textContent = e1 || e2; return }
      errBox().textContent = ''
      setBusy(true, 'go', '', 'Creating…')
      try {
        await registerNewHospital({
          name: v.name, email: v.email, password: v.password,
          orgName: org.name, orgType: org.orgType, state: org.state,
          lga: document.getElementById('ol').value.trim() || null,
        })
        if (timer) clearInterval(timer)
        msg.innerHTML = '<div class="fn-success"><p><strong>Hospital created and active.</strong> ' +
          'You are signed in as hospital admin.</p>' +
          '<p><a href="#/welcome" class="fn-primary fn-continue">Continue →</a></p></div>'
        setBusy(false, 'go', 'Created ✓', '')
        document.getElementById('go').disabled = true
      } catch (e) {
        console.error('[register] create hospital failed:', e)
        errBox().textContent = esc(registrationErrorMessage(e)) +
          (e && e.orgId ? ' Hospital record ID: ' + e.orgId + ' — keep this ID.' : '')
        setBusy(false, 'go', 'Create hospital →', '')
      }
    }
  }

  // ---------- JOIN ----------
  function renderJoin() {
    pane.innerHTML =
      subline('Join your Hospital', 'Setting up a new facility? <button class="fn-linkbtn" id="linkCreate">Create one</button> · Have an account? <button class="fn-linkbtn" id="linkBackLogin">Log in</button>') +
      accountFields() +
      '<label class="fn-label" for="oid">Organization ID <span class="muted">(from your administrator)</span></label>' +
      '<input id="oid" class="input fn-input fn-mono" placeholder="e.g. KXA-QMP-ZTD" />' +
      '<label class="fn-label" for="rl">Role</label><select id="rl" class="select fn-input">' +
      JOIN_ROLES.map((r) => '<option>' + esc(r) + '</option>').join('') + '</select>' +
      '<button id="go" class="fn-primary">Request access →</button>' +
      '<div id="msg"></div>'
    // fix: only one back-login id exists here; wire create too
    const c = document.getElementById('linkCreate')
    if (c) c.onclick = () => setMode('create')
    const b = document.getElementById('linkBackLogin')
    if (b) b.onclick = () => setMode('login')
    setupPasswordToggle('pw2')
    setupPasswordToggle('pc')
    document.getElementById('go').onclick = async () => {
      const msg = document.getElementById('msg')
      const v = {
        name: document.getElementById('nm').value.trim(),
        email: document.getElementById('em2').value.trim(),
        password: document.getElementById('pw2').value,
        confirm: document.getElementById('pc').value,
      }
      const oid = normalizeOrgId(document.getElementById('oid').value)
      const err = validateRegistration(v) || (!oid ? 'organization ID required' : null)
      if (err) { errBox().textContent = err; return }
      errBox().textContent = ''
      setBusy(true, 'go', '', 'Sending…')
      try {
        await registerJoinHospital({
          name: v.name, email: v.email, password: v.password,
          organizationId: oid, role: document.getElementById('rl').value,
        })
        if (timer) clearInterval(timer)
        msg.innerHTML = '<div class="fn-success"><p><strong>Request sent — pending approval.</strong> ' +
          'Clinical access unlocks after your admin approves.</p>' +
          '<p><a href="#/welcome" class="fn-primary fn-continue">Continue →</a></p></div>'
        setBusy(false, 'go', 'Request sent ✓', '')
        document.getElementById('go').disabled = true
      } catch (e) {
        console.error('[register] join hospital failed:', e)
        errBox().textContent = esc(registrationErrorMessage(e))
        setBusy(false, 'go', 'Request access →', '')
      }
    }
  }

  // ---------------------------------------------------------------------------
  async function showMembershipChoice(user, memberships) {
    const active = memberships.find((m) => m.status === 'active')
    const pending = memberships.filter((m) => m.status === 'pending')
    const chooseHtml = [
      '<p>An account with this email already exists.</p>',
      active
        ? '<p>You have a pending membership change. Contact your administrator to approve it, or create a new hospital below.</p>'
        : pending.length
          ? '<p>You have <strong>' + pending.length + '</strong> pending invitation(s). Accept the invitation to join the hospital, or create a new one below.</p>'
          : '<p>This email is registered but has no active membership. <a id="choice-create" class="fn-primary" href="#">Create a new hospital</a> or <a id="choice-join" class="fn-primary" href="#">Join an existing hospital</a>.</p>',
    ].join('')

    openModal('Existing account detected', chooseHtml +
      '<div class="mrow"><button class="btn ghost" data-close>Cancel</button></div>')

    var choiceCreate = document.getElementById('choice-create')
    var choiceJoin = document.getElementById('choice-join')
    if (choiceCreate) {
      choiceCreate.onclick = async () => {
        closeModal()
        setMode('create')
        document.getElementById('em2').value = user.email
        document.getElementById('nm').value = user.displayName || ''
      }
    }
    if (choiceJoin) {
      choiceJoin.onclick = async () => {
        closeModal()
        setMode('join')
        document.getElementById('em2').value = user.email
      }
    }
    if (choiceCreate) choiceCreate.focus()
  }

// ---------------------------------------------------------------------------

  setSeg()
  if (mode === 'create') renderCreate()
  else if (mode === 'join') renderJoin()
  else renderLogin()
}
