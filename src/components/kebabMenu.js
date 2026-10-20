// Shared kebab "more actions" menu for table rows.
// Renders a ⋮ trigger + a hidden dropdown menu. Call wireKebabs() after
// inserting the HTML into the DOM. Each action calls onAction(rowId, action).
import { esc } from '../utils/sanitize.js'

let _outsideWired = false

export function kebabTrigger({ rowId, label = '⋮', ariaLabel = 'More actions' }) {
  return `<button type="button" class="kebab-trigger" data-kebab-row="${esc(String(rowId))}" aria-label="${esc(ariaLabel)}">${esc(label)}</button>`
}

export function kebabMenu({ rowId, items }) {
  // items: [{ label, tone: 'default'|'danger', dataAction }]
  const itemsHtml = items.map((it) => {
    const cls = it.tone === 'danger' ? 'kebab-item danger' : 'kebab-item'
    return `<button type="button" class="${cls}" data-kebab-action="${esc(String(it.dataAction))}" data-kebab-row="${esc(String(rowId))}">${esc(it.label)}</button>`
  }).join('')
  return `<div class="kebab-menu" data-kebab-menu="${esc(String(rowId))}" hidden>${itemsHtml}</div>`
}

export function kebabCell({ rowId, items }) {
  return `<div class="kebab-cell">${kebabTrigger({ rowId })}${kebabMenu({ rowId, items })}</div>`
}

export function wireKebabs(root, onAction) {
  if (!root) return

  root.querySelectorAll('.kebab-trigger').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation()
      const cell = btn.closest('.kebab-cell') || btn.parentElement
      const menu = cell ? cell.querySelector('.kebab-menu') : null
      root.querySelectorAll('.kebab-menu').forEach((m) => { m.hidden = true })
      if (menu) menu.hidden = false
    }
  })

  root.querySelectorAll('.kebab-item').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation()
      const rowId = btn.getAttribute('data-kebab-row')
      const action = btn.getAttribute('data-kebab-action')
      const menu = btn.closest('.kebab-menu')
      if (menu) menu.hidden = true
      if (onAction) onAction(rowId, action)
    }
  })

  if (!_outsideWired) {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.kebab-trigger') && !e.target.closest('.kebab-menu')) {
        document.querySelectorAll('.kebab-menu').forEach((m) => { m.hidden = true })
      }
    })
    _outsideWired = true
  }
}
