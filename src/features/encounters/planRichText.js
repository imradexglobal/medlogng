// Rich treatment plans stay in the existing treatment_plan string field.
// The prefix distinguishes sanitized HTML from legacy plain-text plans.
import { esc } from '../../utils/sanitize.js'

export const RICH_PLAN_PREFIX = '[[MEDLOGNG_RICH_PLAN_V1]]\n'

const ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'BR', 'P', 'DIV', 'UL', 'OL', 'LI', 'SPAN', 'FONT'])
const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'SVG', 'MATH', 'VIDEO', 'AUDIO', 'IMG', 'INPUT', 'BUTTON'])

function safeColor(value) {
  const color = String(value || '').trim()
  return /^(#[\da-f]{3}|#[\da-f]{6}|#[\da-f]{8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i.test(color) ? color : ''
}

export function sanitizePlanHtml(html) {
  const template = document.createElement('template')
  template.innerHTML = String(html || '')
  const result = document.createElement('div')

  function copyChildren(source, target) {
    for (const node of [...source.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) {
        target.appendChild(document.createTextNode(node.nodeValue || ''))
        continue
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const tag = node.tagName.toUpperCase()
      if (DROP_TAGS.has(tag)) continue
      if (!ALLOWED_TAGS.has(tag)) {
        copyChildren(node, target)
        continue
      }
      const clean = document.createElement(tag === 'FONT' ? 'span' : tag.toLowerCase())
      if (tag === 'SPAN' || tag === 'FONT') {
        const color = safeColor(node.getAttribute('color') || node.style?.color)
        if (color) clean.style.color = color
      }
      copyChildren(node, clean)
      target.appendChild(clean)
    }
  }

  copyChildren(template.content, result)
  return result.innerHTML
}

export function planHtmlForEditor(value) {
  const text = String(value || '')
  if (text.startsWith(RICH_PLAN_PREFIX)) return sanitizePlanHtml(text.slice(RICH_PLAN_PREFIX.length))
  return esc(text).replace(/\r?\n/g, '<br>')
}

export function serializePlanHtml(html) {
  const clean = sanitizePlanHtml(html)
  const text = document.createElement('div')
  text.innerHTML = clean
  return text.textContent?.trim() ? RICH_PLAN_PREFIX + clean : ''
}

export function planHtmlForDisplay(value) {
  if (!value) return ''
  return planHtmlForEditor(value)
}
