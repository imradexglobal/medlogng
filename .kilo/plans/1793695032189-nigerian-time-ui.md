# Fix UI time to Nigerian time (Africa/Lagos)

## Problem
UI displays times/dates using `toLocaleString/Date/Time` and `toISOString().slice(...)` without a time zone, so they render in the host's (often UTC) locale instead of Nigerian time (WAT, UTC+1).

## Affected files
- `src/views/DashboardView.js` — `todayLabel`, `shortTime`, `today` (toISOString slice).
- `src/views/ReportsView.js` — generated timestamp (line 856), monthly bucketing (lines 213, 496, 1180), date range labels (1094, 1115).
- `src/views/AppointmentsView.js` — default date/time (lines 22, 26).
- `src/views/PatientsView.js` — CSV filename date (413).
- `src/views/PatientDetailView.js` — consent date default (1791).
- `src/views/AdminView.js` — last_seen display (534) lacks timeZone.
- `src/utils/format.js` — add a shared `formatDateTime` helper using `timeZone: 'Africa/Lagos'`.

## Approach
1. Add helper in `src/utils/format.js`: `formatDate`, `formatDateTime`, `formatTime`, and `lagosDateISO` (returns YYYY-MM-DD in Africa/Lagos) replacing `new Date().toISOString().slice(0,10)`.
2. Update all call sites to use the helper or pass `{ timeZone: 'Africa/Lagos' }`.
3. Monthly bucketing should key on Lagos month: use `toLocaleDateString('en-CA', { timeZone:'Africa/Lagos' })` slice, or `Intl.DateTimeFormat` with `timeZone`.

## Validation
- Run lint/typecheck.
- Manual: clock shows WAT for a known UTC timestamp.
