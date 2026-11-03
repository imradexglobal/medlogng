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

// Format a timestamp/millis to "dd mmm, yyyy" in Nigerian time (Africa/Lagos).
export function fmtDate(ts) {
  if (!ts) return '—'
  const d = new Date(typeof ts.toMillis === 'function' ? ts.toMillis() : ts)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric' }).replace(/ (\d{4})$/, ', $1')
}

// Format a timestamp/millis to "dd mmm, yyyy HH:MM:SSAM/PM" in Nigerian time (Africa/Lagos).
export function fmtDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(typeof ts.toMillis === 'function' ? ts.toMillis() : ts)
  if (isNaN(d.getTime())) return '—'
  const date = d.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: '2-digit', month: 'short', year: 'numeric' })
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
  return date + ' ' + time
}

// Return YYYY-MM-DD for "today" in Nigerian time (Africa/Lagos).
export function lagosDateISO() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' })
}

// Return YYYY-MM for a timestamp in Nigerian time (Africa/Lagos).
export function lagosMonthISO(ts) {
  const d = new Date(typeof ts?.toMillis === 'function' ? ts.toMillis() : (ts || Date.now()))
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' }).slice(0, 7)
}
