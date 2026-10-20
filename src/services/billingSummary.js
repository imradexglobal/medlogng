// Shared billing aggregation used by BillingView stats cards and ReportsView
// revenue card. Keeps the billed / collected / outstanding math in one place.
export function billingSummary(invoices) {
  const billed = invoices.reduce((s, i) => s + (i.total || 0), 0)
  const collected = invoices.reduce((s, i) => s + (i.paid || 0), 0)
  const outstanding = billed - collected
  const rate = billed ? Math.round((collected / billed) * 100) : 0
  const open = invoices.filter((i) => (i.status || 'unpaid') !== 'paid').length
  return { billed, collected, outstanding, rate, open, count: invoices.length }
}
