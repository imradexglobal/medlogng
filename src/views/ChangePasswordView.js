// Forced password-change gate (membership.must_change_password == true).
import { authStore } from '../store/authStore.js'
import { logout, changeOwnPassword } from '../services/authService.js'
import { validateNewPassword } from '../features/admin/roles.js'
import { navigate } from '../router.js'
import { esc } from '../utils/sanitize.js'

function renderPasswordField(inputId, labelText, autocomplete, placeholder, type = 'password') {
  const toggleId = inputId + 'Toggle'
  return '<div class="fn-pw-wrap">' +
    '<label for="' + inputId + '">' + labelText + '</label>' +
    '<div class="fn-pw-input-wrap">' +
      '<input id="' + inputId + '" class="input" type="' + type + '" autocomplete="' + autocomplete + '" placeholder="' + placeholder + '" />' +
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

export async function ChangePasswordView(app) {
  const { user } = authStore.getState()
  if (!user) { navigate('/login'); return }

  app.innerHTML =
    '<div class="auth-wrap"><div class="card auth-card">' +
    '<div class="brand"><span class="brand-mark">✚</span><span><h1>MediLog NG</h1><p class="muted">Change your password</p></span></div>' +
    '<p>Your administrator requires a password change for <strong>' + esc(user.email || '') + '</strong> ' +
    'before you can continue. Minimum 8 characters, letters + numbers, not a common password.</p>' +
    renderPasswordField('np', 'New password', 'new-password', 'New password') +
    renderPasswordField('cp', 'Confirm new password', 'new-password', 'Repeat new password') +
    '<p id="perr" class="err"></p>' +
    '<div class="row"><button id="save" class="btn">Change password →</button>' +
    '<button id="out" class="btn btn-ghost">Sign out</button></div>' +
    '</div></div>'

  setupPasswordToggle('np')
  setupPasswordToggle('cp')

  document.getElementById('save').onclick = async (e) => {
    const btn = e.target
    const np = document.getElementById('np').value
    const cp = document.getElementById('cp').value
    const box = document.getElementById('perr')
    if (np !== cp) { box.textContent = 'Passwords do not match'; return }
    const bad = validateNewPassword(np)
    if (bad) { box.textContent = bad; return }
    box.textContent = ''
    btn.disabled = true
    btn.textContent = 'Saving…'
    try {
      await changeOwnPassword(np)
      navigate('/')
    } catch (err) {
      box.textContent = String(err?.message || err)
      btn.disabled = false
      btn.textContent = 'Change password →'
    }
  }
  document.getElementById('out').onclick = async () => { await logout(); navigate('/login') }
}
