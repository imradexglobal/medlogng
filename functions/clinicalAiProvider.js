// Provider-neutral seam for Firebase-hosted hospitals. A provider adapter must
// be selected only after the hospital approves processor terms, data location,
// retention, cost and consent. No default vendor or external network request.
export async function generateStructuredDraft(_transcript) {
  const error = new Error('No approved clinical AI provider is configured for this Firebase project.')
  error.code = 'failed-precondition'
  throw error
}
