// Verify-email gate (all new accounts; older accounts see a banner only).
import { authStore } from '../store/authStore.js'
import { logout, sendVerificationEmail, confirmEmailVerified } from '../services/authService.js'
import { navigate } from '../router.js'
import { esc } from '../utils/sanitize.js'

export async function VerifyEmailView(app) {
  const { user } = authStore.getState()
  if (!user) { navigate('/login'); return }

  app.innerHTML =
    '<div class="auth-wrap"><div class="card auth-card">' +
    '<div class="brand"><span class="brand-mark">✚</span><span><h1>MedLogNg</h1><p class="muted">Verify your email</p></span></div>' +
    '<p>We sent a verification link to <strong>' + esc(user.email || '') + '</strong>. ' +
    'Open it, then press the button below. You cannot reach the workspace until your email is verified.</p>' +
    '<p id="vmsg" class="muted"></p>' +
    '<p id="verr" class="err"></p>' +
    '<div class="row"><button id="chk" class="btn">I verified — continue</button>' +
    '<button id="rsnd" class="btn btn-ghost">Resend link</button></div>' +
    '<div class="row"><button id="out" class="btn btn-ghost">Sign out</button></div>' +
    '</div></div>'

  document.getElementById('chk').onclick = async (e) => {
    const btn = e.target
    btn.disabled = true
    btn.textContent = 'Checking…'
    try {
      const res = await confirmEmailVerified()
      if (res === 'verified') navigate('/')
      else {
        document.getElementById('verr').textContent = 'Not verified yet — open the link in your inbox first.'
        btn.disabled = false
        btn.textContent = 'I verified — continue'
      }
    } catch (err) {
      document.getElementById('verr').textContent = String(err?.message || err)
      btn.disabled = false
      btn.textContent = 'I verified — continue'
    }
  }
  let cooling = false
  document.getElementById('rsnd').onclick = async () => {
    if (cooling) return
    cooling = true
    try {
      await sendVerificationEmail()
      document.getElementById('vmsg').textContent = 'Verification link re-sent.'
    } catch (err) {
      document.getElementById('verr').textContent = String(err?.message || err)
    }
    setTimeout(() => { cooling = false }, 30000)
  }
  document.getElementById('out').onclick = async () => { await logout(); navigate('/login') }
}
