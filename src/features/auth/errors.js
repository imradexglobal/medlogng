// Friendly Firebase Auth error messages (same mapping as medilogng_old).

export function authErrorMessage(code) {
  switch (code) {
    case 'auth/invalid-email':
      return 'That email address looks invalid.'
    case 'auth/missing-password':
      return 'Please enter your password.'
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
      return 'Wrong email or password.'
    case 'auth/user-not-found':
      return 'No account found for that email. Register first.'
    case 'auth/email-already-in-use':
      return 'That email is already registered. Sign in instead.'
    // Emailed reset-link lifecycle (see LoginView's password-reset screen).
    case 'auth/invalid-action-code':
      return 'This reset link is invalid or has already been used. Request a new one.'
    case 'auth/expired-action-code':
      return 'This reset link has expired — request a new one.'
    case 'auth/user-disabled':
      return 'This account has been disabled — contact your hospital admin.'
    case 'auth/weak-password':
      return 'Password must be at least 8 characters.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a minute and try again.'
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and retry.'
    case 'auth/popup-closed-by-user':
      return 'Google sign-in was cancelled.'
    default:
      return 'Something went wrong. Please try again.'
  }
}

// Detailed message for registration (Auth + Firestore). Unlike the login
// box above, this NEVER swallows the code — an unmapped error still shows
// its code so the real cause (usually Firestore rules) can be diagnosed
// instead of hiding behind "Something went wrong".
export function registrationErrorMessage(err) {
  const code = err && err.code
  switch (code) {
    case 'permission-denied':
      return 'Write blocked by Firestore rules (permission-denied). ' +
        'Deploy the latest firestore.rules (`firebase deploy --only firestore:rules`) and retry. ' +
        'Details: ' + (err.message || 'permission denied')
    case 'unavailable':
      return 'Firestore is unreachable (unavailable). Check your connection and retry.'
    case 'failed-precondition':
      return 'Firestore rejected the write (failed-precondition, often a missing index). Details: ' + (err.message || '')
    case 'already-exists':
      return 'That record already exists (already-exists). Try signing in instead.'
    case 'unauthenticated':
      return 'Not signed in (unauthenticated). Please retry — your session may have expired mid-registration.'
    default:
      if (code && code.startsWith('auth/')) return authErrorMessage(code)
      return 'Registration failed' + (code ? ' (' + code + ')' : '') + ': ' + ((err && err.message) || 'unknown error') +
        '. Open DevTools console for the full error object.'
  }
}
