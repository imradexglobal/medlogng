// Print helper for the SPA.
//
// Instead of opening a popup (blocked in many webviews), a single print root is
// injected into the page and everything else is hidden with `@media print`. The
// root is removed once printing finishes (or after a short fallback timeout for
// environments that never fire `afterprint`).
export function printDocument(title, innerHtml) {
  const prior = document.getElementById('print-root')
  if (prior) prior.remove()

  const root = document.createElement('div')
  root.id = 'print-root'
  root.innerHTML = '<div class="print-sheet">' + innerHtml + '</div>'

  let titleEl = document.querySelector('title')
  const prevTitle = titleEl ? titleEl.textContent : ''
  if (titleEl && title) titleEl.textContent = title

  document.body.appendChild(root)
  document.body.classList.add('printing')

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    document.body.classList.remove('printing')
    root.remove()
    if (titleEl && title) titleEl.textContent = prevTitle
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  try { window.print() } catch { /* ignore */ }
  setTimeout(cleanup, 2000)
}

export function printTextBlock(body) {
  return String(body || '').split('\n').map((line) => line ? '<p>' + escapeHtml(line) + '</p>' : '<p>&nbsp;</p>').join('')
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
