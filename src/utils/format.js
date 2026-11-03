// Shared display formatting used by billing, reports and other views.
// All money is stored in kobo (integer) and divided by 100 here for display.
export function naira(koboOrNaira) {
  const n = Number(koboOrNaira || 0)
  return '₦' + n.toLocaleString('en-NG')
}

export function kobo(nairaAmount) {
  return Math.round(Number(nairaAmount || 0) * 100)
}

export function statusBadge(status) {
  const map = {
    paid: 'ok', 'part-paid': 'warn', unpaid: 'bad', cancelled: 'bad',
    verified: 'ok', completed: 'ok', active: 'ok',
  }
  const cls = map[status] || 'neutral'
  return '<span class="pill ' + cls + '">' + String(status || '—') + '</span>'
}

// Format a timestamp/millis to DD/MM/YYYY (e.g. 20/10/2026).
export function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(typeof ts.toMillis === 'function' ? ts.toMillis() : ts)
  if (isNaN(d.getTime())) return '—'
  const day = String(d.getDate()).padStart(2, '0')
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const year = d.getFullYear()
  return day + '/' + month + '/' + year
}

// Format a timestamp/millis to DD/MM/YYYY HH:MM:SSAM/PM (e.g. 20/10/2026 02:30:45PM).
export function fmtDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(typeof ts.toMillis === 'function' ? ts.toMillis() : ts)
  if (isNaN(d.getTime())) return '—'
  const day = String(d.getDate()).padStart(2, '0')
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const month = monthNames[d.getMonth()]
  const year = d.getFullYear()
  const hh = d.getHours % 12 || 12
  const mm = String(d.getMinutes()).padStart(2, '0')
  const ss = String(d.getSeconds()).padStart(2, '0')
  const ampm = d.getHours >= 12 ? 'PM' : 'AM'
  return day + ' ' + month + ', ' + year + ' ' + hh + ':' + mm + ':' + ss + ampm
}
