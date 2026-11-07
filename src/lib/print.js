// Print helper for the SPA.
//
// Instead of opening a popup (blocked in many webviews), a single print root is
// injected into the page and everything else is hidden with `@media print`. The
// root is removed once printing finishes (or after a short fallback timeout for
// environments that never fire `afterprint`). A hospital-specific @page rule
// shifts every printed page down without changing the document width.
import { authStore } from '../store/authStore.js'
import {
  getCachedPrintingSettings,
  getPrintingSettings,
  hasCachedPrintingSettings,
} from '../services/printingSettingsService.js'
import {
  DEFAULT_PRINTING_SETTINGS,
  buildPrintOffsetCss,
  buildLetterheadNameCss,
  normalizePrintingSettings,
} from '../features/printing/domain.js'

export function printDocument(title, innerHtml, options = {}) {
  const orgId = authStore.getState().activeOrg
  const suppliedSettings = options.printingSettings

  if (suppliedSettings) {
    return runPrint(title, innerHtml, normalizePrintingSettings(suppliedSettings))
  }
  if (!orgId) return runPrint(title, innerHtml, DEFAULT_PRINTING_SETTINGS)

  if (hasCachedPrintingSettings(orgId)) {
    const settings = getCachedPrintingSettings(orgId)
    const result = runPrint(title, innerHtml, settings)
    // Refresh the hospital-scoped cache in the background so another admin's
    // recent change is picked up without delaying or blocking the print dialog.
    void getPrintingSettings(orgId).catch((error) => {
      console.info('[printing] using the last saved hospital print setting:', error?.message || error)
    })
    return result
  }

  // On a first print before the startup preload finishes, wait for the
  // organization-scoped setting. This prevents silently using another
  // hospital's preference (or the default) for that first document.
  return getPrintingSettings(orgId)
    .catch((error) => {
      console.warn('[printing] could not load hospital print setting; using the backward-compatible default:', error?.message || error)
      return DEFAULT_PRINTING_SETTINGS
    })
    .then((settings) => runPrint(title, innerHtml, settings))
}

function runPrint(title, innerHtml, settings) {
  const prior = document.getElementById('print-root')
  if (prior) prior.remove()
  const priorStyle = document.getElementById('print-offset-style')
  if (priorStyle) priorStyle.remove()

  const printCss = [buildPrintOffsetCss(settings), buildLetterheadNameCss(settings)].filter(Boolean).join('\n')
  let offsetStyle = null
  if (printCss) {
    offsetStyle = document.createElement('style')
    offsetStyle.id = 'print-offset-style'
    offsetStyle.textContent = printCss
    document.head.appendChild(offsetStyle)
  }

  const root = document.createElement('div')
  root.id = 'print-root'
  root.innerHTML = '<div class="print-sheet">' + innerHtml + '</div>'

  const titleEl = document.querySelector('title')
  const prevTitle = titleEl ? titleEl.textContent : ''
  if (titleEl && title) titleEl.textContent = title

  document.body.appendChild(root)
  document.body.classList.add('printing')
  if (settings.letterhead_adjustment_enabled) document.body.classList.add('printing-preprinted-letterhead')
  else document.body.classList.remove('printing-preprinted-letterhead')

  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    document.body.classList.remove('printing')
    document.body.classList.remove('printing-preprinted-letterhead')
    root.remove()
    if (offsetStyle) offsetStyle.remove()
    if (titleEl && title) titleEl.textContent = prevTitle
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  try { window.print() } catch { /* preserve the existing no-throw print behaviour */ }
  setTimeout(cleanup, 2000)
  return undefined
}

export function printLetterheadTest(settings) {
  const normalized = normalizePrintingSettings(settings)
  const activeOffset = normalized.letterhead_adjustment_enabled ? normalized.top_offset_mm : 0
  const status = normalized.letterhead_adjustment_enabled ? 'enabled' : 'disabled'
  const html =
    '<div class="p-confidential">PRINT ALIGNMENT TEST — Not a clinical document</div>' +
    '<div class="p-head"><div class="p-left"><div class="p-hospital">Hospital Letterhead Test</div>' +
    '<div class="p-sub">Use this page to verify the content start against your pre-printed paper.</div></div>' +
    '<div class="p-doctitle">TEST PRINT</div></div>' +
    '<div style="border-top:2px dashed #b91c1c;padding-top:8px;margin-top:16px">' +
    '<strong>CONTENT START MARKER</strong></div>' +
    '<h2>Letterhead adjustment</h2>' +
    '<p>Adjustment is <strong>' + escapeHtml(status) + '</strong>. Configured offset: <strong>' +
    escapeHtml(normalized.top_offset_mm) + ' mm</strong>.</p>' +
    '<p>Additional downward shift for this test: <strong>' + escapeHtml(activeOffset) +
    ' mm</strong> below the application\'s existing starting position.</p>' +
    '<p>The top offset is applied to every printed page. This test is one page and does not change horizontal margins.</p>'
  return printDocument('Printing alignment test', html, { printingSettings: normalized })
}

export function printTextBlock(body) {
  return String(body || '').split('\n').map((line) => line ? '<p>' + escapeHtml(line) + '</p>' : '<p>&nbsp;</p>').join('')
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
