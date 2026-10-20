// Shared confirm-then-delete flow for every view that offers deletion.
//
// One place for the three rules that must hold on every delete button:
//   1. The button only renders when the user actually holds data.delete.
//   2. A modal states exactly WHAT is being deleted (never a bare "Are you
//      sure?") — the service guards underneath also refuse unsafe states,
//      and their message is shown verbatim so the user learns why.
//   3. Success toasts; failure surfaces the reason and leaves the row alone.
import { openModal, closeModal, toast } from '../components/shell.js'
import { esc } from '../utils/sanitize.js'
import { canDeleteRecords } from '../services/deleteService.js'

// Renders the small destructive button, or nothing when the user lacks the
// capability. Call inside a row template:
//   + delBtn('appointment', a.id, 'this appointment')
export function delBtn(type, id, what) {
  if (!canDeleteRecords()) return ''
  return '<button class="btn ghost sm danger" data-del="' + type + '" data-del-id="' + esc(id) +
    '" data-del-what="' + esc(what) + '" title="Delete ' + esc(what) + '">Delete</button>'
}

// Wires every [data-del] button inside `root` (call after each render).
// `handlers` maps the data-del type to an async (id) => void delete fn.
// `after` is called on success (usually a re-render/reload).
export function wireDelButtons(root, handlers, after) {
  if (!root) return
  root.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const type = b.getAttribute('data-del')
      const id = b.getAttribute('data-del-id')
      const what = b.getAttribute('data-del-what') || 'this record'
      const run = handlers[type]
      if (!run) return
      confirmDelete(what, () => run(id), after)
    }
  })
}

export function confirmDelete(what, run, after) {
  openModal('Delete ' + what,
    '<p>Delete <strong>' + esc(what) + '</strong>? This cannot be undone.</p>' +
    '<div class="mrow"><button class="btn ghost" data-close>Cancel</button>' +
    '<button class="btn" id="delOk">Delete</button></div>')
  document.getElementById('delOk').onclick = async (e) => {
    e.target.disabled = true
    try {
      await run()
      closeModal()
      toast('Deleted.')
      if (after) await after()
    } catch (err) {
      closeModal()
      toast(err?.message || 'Could not delete.')
    }
  }
}
