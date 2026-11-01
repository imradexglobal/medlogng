# Agent Prompt: Fix PatientDetailView (Patient 360 Page) — 100% Complete

## Context
User encountered: **"Could not load dashboard: Not allowed — your role does not have this capability. Ask an administrator."** when selecting a patient from the Patients list.

## Root Cause
The **Dashboard tab** in `PatientDetailView` calls `loadDashboardData()` which fetches from multiple Firestore collections via `listPatientDocs()`:
- `vitals` ✅ (read: signedIn)
- `encounters` ✅ (read: signedIn)
- `diagnoses` ✅ (read: signedIn)
- `medication_requests` ❌ **requires `prescription.dispense` OR `medication.administer`** (firestore.rules:298)
- `lab_orders` ✅ (read: signedIn)
- `admissions` ✅ (read: signedIn)
- `documents` ✅ (read: signedIn)
- `medication_administrations` ❌ **requires `prescription.dispense` OR `medication.administer`** (firestore.rules:322)

When the user lacks pharmacy/nurse capabilities, **the entire dashboard fails** because `Promise.all` rejects on the first permission-denied error.

---

## Your Task
Fix `src/views/PatientDetailView.js` **completely** — UI/UX, Logic, Workflow, Performance, Accessibility. Every tab, every interaction, every edge case.

---

## Requirements

### 1. Fix the Dashboard Permission Crash (Critical)
- **Graceful degradation**: Each collection fetch must be independent. A failed read (permission-denied) must not crash the whole dashboard — show "No data (insufficient permissions)" for that section only.
- Replace `Promise.all` with individual `try/catch` per collection.
- Use `friendlyPatientError()` to detect permission errors and render a clear notice instead of toasting an error.

### 2. Dashboard Tab — UI/UX Overhaul
**Current issues:**
- Vital cards: no trend icons for first reading, hardcoded primary only on BP
- Timeline filter: resets on tab switch, no URL persistence
- Feed items: no click action, no kebab for clinical actions
- Clinical summary cards: no empty-state actions for roles that CAN create
- Quick actions: duplicate buttons (also in header), no loading state

**Fix:**
- **Vital cards**: Show trend vs previous reading (↑/↓/→) with color coding. All vitals get trend, not just BP.
- **Timeline filter**: Persist selection in `sessionStorage` keyed by patient ID. Add "All Clinical Events" as default.
- **Feed items**: Make clickable — click opens the source record (encounter → consultations, vitals → vitals tab, lab → lab order, etc.)
- **Clinical summary**: Each card shows inline "Add" button ONLY if user has capability (`canDx`, `canRx`, `canVitals`, `canEncounter`, `canAdmit`).
- **Quick actions bar**: Remove duplicate header buttons. Single source of truth. Show loading spinner on click.

### 3. All Tabs — Consistent Patterns
Each tab must follow this pattern:
```
┌─────────────────────────────────────────────────────────────┐
│ Tab Header (already rendered in renderHeader)               │
├─────────────────────────────────────────────────────────────┤
│ Toolbar: [Filter/Chips] [Search] [+ Action if permitted]    │
├─────────────────────────────────────────────────────────────┤
│ Content: Table / Cards / Timeline / Empty State             │
│   - Empty state: icon + message + [Action button if can]    │
│   - Row click: navigates to detail / opens modal            │
│   - Kebab menu: Edit / Delete / Print / View (capability)   │
└─────────────────────────────────────────────────────────────┘
```

**Tab-specific fixes:**

| Tab | Current Issue | Fix |
|-----|---------------|-----|
| **Personal Data** | Billing section loads invoices but no error handling; consent button does nothing | Add error boundary for invoices. Implement consent modal (record consent type + date + witness). |
| **Blood & Allergies** | Genotype/blood group edit buttons use generic `data-edit-pane` | Wire proper edit modals for blood group & allergies separately. |
| **Next of Kin** | Single edit button for all fields | Split: Edit contact, Edit address. |
| **Timeline** | Duplicate of Dashboard feed, no filter | Merge into Dashboard feed. **Remove Timeline tab** — redundant. |
| **Encounters** | Clickable rows but no click handler; kebab only has Delete | Click → open encounter in ConsultationsView. Kebab: View, Print Summary, Edit (if `encounter.edit`), Delete (if `data.delete`). |
| **Vitals** | No chart/trend view; table only | Add **Chart toggle** (table ↔ line chart for BP, Pulse, Temp, SpO₂, Weight). Keep table for data entry. |
| **Diagnoses** | No ICD-11 search; status badge not clickable | Add ICD-11 autocomplete on condition field. Click status → cycle Active→Resolved→Chronic (if `diagnosis.create`). |
| **Medications** | Complex expandable rows; print uses different template | Simplify: One row per prescription. Click → modal with full script (print, adjust, discontinue). Print uses `prescriptionHtml`. |
| **Labs** | Stage badge only; no result preview | Click row → open LabOrderView. Show result snippet if verified. |
| **Admissions** | Discharge button inline; no ward/bed visual | Card layout: Ward · Bed badge, Admitting Dr, Status pill. Discharge in kebab. |
| **Documents** | Table only; no preview/upload | Add upload button (if `documents.upload`). Click row → preview/download. |

### 4. Tab Navigation — Fix Architecture
**Current**: Tabs rendered as raw buttons in `renderHeader()`, pane swapped in `render()`.
**Problems**: No keyboard navigation, no ARIA, no URL sync, no deep-link to tab.

**Fix:**
- Use semantic `<nav role="tablist">` with `<button role="tab">` + `<div role="tabpanel">`
- Sync active tab to URL hash: `#/patients/{id}?tab=dashboard`
- Restore tab on reload/navigation
- Keyboard: ←/→ to switch, Home/End, Enter/Space to activate

### 5. Patient Header — Fixes
- **Photo upload**: Currently uses `formModal` but no drag-drop, no crop, no progress. Use `<input type="file">` with preview, client-side resize (max 800px), upload to Storage (or base64 in doc if no Storage).
- **MRN/Payer**: Payer should be editable inline (select from `payerOptions`).
- **Allergy banner**: Red background, icon, dismissible only if `patient.demographics.update`.
- **Status badge**: `Active`/`Inactive`/`Merged` — color coded.

### 6. Data Loading — Performance & Caching
- **Cache per tab**: `loadCache` exists but cleared on every tab switch. Keep cache for session lifetime.
- **Stale-while-revalidate**: Show cached data immediately, fetch fresh in background, swap on success.
- **Skeleton screens**: Already present — keep but ensure they match final layout (no layout shift).
- **AbortController**: Cancel in-flight fetches when tab changes or component unmounts.

### 7. Error Handling — Comprehensive
Every async operation must:
- Catch `permission-denied` → show inline "You don't have permission to view this" (not toast)
- Catch `unavailable`/offline → show "Offline — showing cached data" with retry button
- Catch index errors → show "Index needed" with console link (dev only)
- Never leave UI in loading state indefinitely

### 8. Accessibility (WCAG 2.1 AA)
- All interactive elements: focus-visible, keyboard operable
- Tables: `<th scope="col">`, `<caption>` for screen readers
- Modals: trap focus, `aria-modal="true"`, ESC to close
- Status messages: `aria-live="polite"` for toasts, `aria-live="assertive"` for errors
- Color contrast: verify all pills, badges, trend indicators
- Tab panel: `aria-labelledby` linking tab to panel

### 9. Workflow Integration
- **Start Encounter** (header + dashboard): Opens `/encounters/new?pid={id}` — deep link to consultation workspace
- **Record Vitals** (dashboard + vitals tab): Opens vitals modal → on save, refreshes Vitals tab AND Dashboard
- **Add Diagnosis** (dashboard + diagnoses tab): Opens diagnosis modal → refreshes both
- **New Prescription** (dashboard + medications tab): Opens prescription modal → refreshes both
- **Admit Patient** (dashboard + admissions tab): Opens admission modal → refreshes both
- **Upload Document** (documents tab): Opens file picker → uploads → refreshes tab

### 10. Code Quality
- **No inline styles** — use CSS classes from `app.css`/`styles.css`
- **No magic strings** — constants for tab names, capability keys, collection names
- **TypeScript-style JSDoc** for all functions (params, returns, throws)
- **Extract helpers**: `renderVitalCard()`, `renderFeedItem()`, `renderSummaryCard()`, `openTabModal()`
- **Remove dead code**: `buildUnifiedTimeline` duplicate logic, unused `paneHtml` branches

---

## Files to Modify
1. **Primary**: `src/views/PatientDetailView.js` — complete rewrite
2. **Styles**: `src/app.css` or `src/styles.css` — add dashboard, feed, chart, tab styles
3. **Router**: `src/router.js` — add tab parameter handling (optional, can be in view)

---

## Testing Checklist
- [ ] Login as **Doctor** — all tabs work, all actions available
- [ ] Login as **Nurse** — vitals, doses, encounters (status advance), admissions work; prescriptions read-only
- [ ] Login as **Pharmacist** — medications tab shows dispense actions; dashboard shows meds but no prescribe button
- [ ] Login as **Receptionist** — personal data, appointments, billing; no clinical tabs
- [ ] Login as **Lab Scientist** — labs tab full; dashboard shows lab orders
- [ ] Login as **Billing Officer** — billing in Personal Data; no clinical data
- [ ] **Offline mode** — cached data shows, mutations queue
- [ ] **Permission denied** — graceful empty states, no toasts
- [ ] **Keyboard only** — full navigation, modals trap focus
- [ ] **Screen reader** — NVDA/VoiceOver reads tabs, tables, status
- [ ] **Mobile** — tabs scroll horizontally, cards stack, modals full-screen

---

## Deliverable
A single, complete `PatientDetailView.js` that:
1. Never crashes on permission errors
2. Provides excellent UX for every role
3. Follows consistent patterns across all tabs
4. Is accessible, performant, and maintainable
5. Integrates seamlessly with the rest of the app

**Do not create new files.** Edit `PatientDetailView.js` in place. Add styles to existing CSS files.