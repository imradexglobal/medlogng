# MediLog NG UI/UX Audit Inventory

## Route Map (from router.js NAV array)
| Path | Label | Icon | Section |
|------|-------|------|---------|
| / | Dashboard | ▦ | Overview |
| /patients | Patients | ◉ | Patient registry & chart |
| /appointments | Appointments | ◷ | Appointment scheduling |
| /consultations | Consultations | ✚ | Encounter/consultation queue |
| /admissions | Admissions | ▤ | Ward/bed management |
| /laboratory | Laboratory | ♳ | Lab worklist & orders |
| /pharmacy | Pharmacy | 💊 | Medication dispensing |
| /billing | Billing | ₦ | Invoices & payments |
| /reports | Reports | 📊 | Reports & exports |
| /admin | Administration | ⚙ | Staff, org, devices, audit |

## 1. Access & Onboarding Screens

### LoginView (#/login)
- **Three modes**: Log in, Create hospital, Join hospital
- **Carousel** of 3 slides with Nigerian healthcare imagery
- **Google OAuth** sign-in option
- **Forgot password** flow opens in modal
- **Reset password** via OOB code link
- **New hospital registration**: name, type, state, LGA
- **Join hospital**: organization ID, role selection
- **Membership choice** when email exists but no active membership
- **Phone format**: `+234 803 123 4567` entry expected
- **Issues**: 
  - Right-side carousel takes significant screen real estate; on narrow screens may be cramped
  - Form fields in create/join modes are compact; labels stack but inputs could be wider
  - No visible focus indicators on form inputs when navigating via keyboard
  - Password toggle SVG arrows not clearly announced (aria-label present but visual only)

### HospitalChoiceView (if needed)
- Choosing between multiple hospitals for staff account
- **Issues**: Not yet examined in detail

### WelcomeView (post-login)
- Not a separate view; routes to dashboard or based on role
- **Issues**: Need to verify navigation after first login

## 2. Dashboard (#/)

### DashboardView
- **Layout**: Sidebar + top header + 2-column content grid
- **Stats row**: 4 cards (patients, queue, revenue, stock)
- **2x grid**: 
  - Left: Checked-in queue table (5 rows) + Bed occupancy + Pharmacy alerts + Recent billing
  - Right: Summary cards
- **Actions**: Buttons for opening appointments, patients, queue, wards, pharmacy, billing
- **Key features**:
  - Naira (₦) formatting for revenue
  - Status badges for queue items and invoice status
  - Live updates via Firestore subscriptions
  - Sync status in sidebar (online/offline with pending changes count)
- **Responsive**: Sidebar becomes drawer below 860px
- **Issues**:
  - Revenue/stock numbers may be too small on mobile; no scaling adjustment
  - Queue table has fixed 4 columns; on phone these become very narrow
  - "Low/out stock" alert shows only count, not which specific drugs
  - Bed occupancy shows active/discharged counts but no visual bed map on dashboard
  - Header subtitle "Today's operations at a glance" is generic; could be more specific per role
  - No indication of unsaved changes or pending sync on stat cards

## 3. Patients (#/patients)

### PatientsView
- **Layout**: Table with pagination/load-more, CSV export
- **Actions**: Register patient, search/filter
- **Patient search**: Filters by name, MRN, phone
- **CSV export** for patient registry
- **Issues**:
  - Table columns are dense; on phone width becomes unusable
  - No visible loading skeleton during initial fetch (just "Loading…")
  - Pagination controls not clearly labeled for screen readers
  - "No patients registered" empty state is minimal

### PatientDetailView (#/patients/:id)
- **Tabbed interface** with 12 tabs: Dashboard, Personal Data, Blood & Allergies, Next of Kin, Timeline, Encounters, Vitals, Diagnoses, Medications, Labs, Admissions, Documents
- **Header**: Patient photo/initials, name, MRN, age/sex, DOB, phone, payer, allergy badge, MRN/payer chips
- **Dashboard tab**: Vitals snapshot cards + clinical summary + progress feed (chat-style) + quick actions
- **Personal Data**: Surname, given names, sex, DOB, age, phone, occupation, address, payer
- **Blood & Allergies**: Blood group, allergy tags display + edit button
- **Next of Kin**: Emergency contact details
- **Timeline**: Chat-style feed of all clinical events, filterable
- **Encounters**: Table per encounter with status pills
- **Vitals**: Table with BP, pulse, temp, SpO2, by clinician
- **Diagnoses**: Condition, recorded date, status pill
- **Medications**: ONE row per prescription script, expandable to show all lines
  - Shows medicine, dosage, prescribed/issued/given/left, status pill
  - Clickable to expand/collapse detailed lines
- **Labs**: Table per lab order with test, stage, priority, date
- **Admissions**: Table per admission with ward/bed, since date, doctor, from encounter, status
- **Documents**: Table per document with file, type, added date
- **Quick actions bar**: Capability-gated buttons (start encounter, record vitals, add diagnosis, prescription, admission)
- **Key modals**:
  - Record vitals form
  - Add diagnosis form
  - New prescription form (with allergy safety check)
  - Adjust prescription form
  - Admit patient form (with ward selection, bed number, admission type)
  - Edit demographics/blood group/allergies/next of kin
  - Photo upload/remove
- **Issues**:
  - **CRITICAL**: Allergy tag display is small; on phone the allergy warning "always confirm before prescribing" may be missed
  - **CRITICAL**: Medication row per script vs per-line could be confusing; the "▸" caret indicator is tiny
  - **CRITICAL**: Timeline feed items have tiny typography; secondary info (clinician) may be missed
  - **CRITICAL**: Quick actions bar overlaps content on narrow screens; buttons may wrap unpredictably
  - **HIGH**: Personal Data section has 2-column grid that may be too tight on phone; some fields (address, occupation) are long text
  - **HIGH**: Blood group + allergies tab is narrow; blood group select + allergy tags in same real estate
  - **MEDIUM**: Timeline "Filter:" dropdown may be hard to interact with on touch
  - **MEDIUM**: Vitals snapshot cards have trend arrows (↑↓→) with color coding; may not be color-blind accessible
  - **MEDIUM**: No indication of unsaved changes when leaving a tab
  - **MEDIUM**: Document table has no inline preview; user must click to know content
  - **MEDIUM**: "No clinical events recorded yet" empty states are generic

### EditPatientView (#/patients/:id/edit)
- Form with demographic fields
- **Issues**: Need to verify field validation and error messaging

## 4. Appointments & Consultations (#/appointments, #/consultations)

### AppointmentsView (#/appointments)
- **Layout**: Day schedule, date + clinic filters, patient search, booking, status changes, no-show handling
- **Empty states**: When no appointments for selected date
- **Issues**: Not fully examined; appointment flow connects to consultation workspace

### ConsultationsView (#/consultations)
- **Layout**: Split into 2 columns (.consult-grid):
  - Left: Encounter queue table with search, status filter, waited clock
  - Right: Encounter workspace with tabbed interface
- **Queue table columns**: Patient, MRN·contact, Waited, Status + bed badge
- **Workspace tabs**: Overview (identity + flow + vitals), SOAP note, Treatment plan, Prescriptions, Lab orders
- **Key features**:
  - Wait time calculation and color coding (ok/warn/bad)
  - Status flow visualization with "done/now" highlights
  - Admit patient button linked to bed capacity
  - Advance button shows next status step
  - Delete only for closed encounters
  - Prescription forms: new, append, adjust
  - Lab order integration
  - Vital recording form
  - Diagnosis form
  - Plan form
  - Billing integration (from encounter)
- **Key modals**:
  - Give dose modal (with remaining quantity warning)
  - Open prescription form (new/append/adjust)
  - Add diagnosis form
  - Add plan form
  - Open lab order from encounter
  - Transfer/admission from encounter
- **Issues**:
  - **CRITICAL**: Queue "Waited" clock uses text format "1d:2h:3m:4s" which is hard to scan; numerical format would be faster
  - **CRITICAL**: Bed badge inside status cell uses very small text; ward·bed may be truncated
  - **CRITICAL**: SOAP note textarea has no character count or save indicator
  - **CRITICAL**: Plan box shows "No plan saved yet" but the "+ Plan" button is in the action bar, not contextual
  - **CRITICAL**: Prescription rows have tiny "▸"/"▾" caret for expand; hard to hit with touch
  - **CRITICAL**: "Given X of Y · Z to go" dose summary is small and may be missed
  - **HIGH**: Encounter status flow highlights only show 1 step as "now", others as "done"; clinician may lose track of full workflow
  - **HIGH**: Lab orders pane reads from encounter snapshot; may be stale if orders updated elsewhere
  - **HIGH**: Prescription "Open →" and "Adjust" buttons are tiny; hard to hit on phone
  - **HIGH**: Dose administration: "Give" button in kebab menu; may not be discoverable
  - **HIGH**: No visual indication which tab is "dirty" (unsaved changes)
  - **MEDIUM**: Search patient filter in queue uses MRN/name/phone; on phone the input may be obscured by keyboard
  - **MEDIUM**: Timeline/feed filter dropdown may not announce options well to screen readers
  - **MEDIUM**: No skeleton during initial load; just "Loading…" in table
  - **MEDIUM**: Action bar buttons (vitals, diagnosis, prescription, lab, plan, bill) are all same size; priority order not visually distinguished
  - **MEDIUM**: Encounter header "No encounter selected" state is minimal; doesn't guide user on next step

### New Encounter Form
- Shared form for every entry point (queue, patient list, patient chart)
- Same fields, same duplicate guard, deep-links into new encounter workspace
- **Issues**: Need to verify form validation and duplicate detection messaging

## 5. Admissions (#/admissions)

### AdmissionsView
- **Layout**: 4 stat cards (occupied, available, total beds, discharged) + wards grid + admissions table
- **Wards grid**: Visual bed map with occupied (colored) vs free beds per ward
- **Admissions table columns**: Patient, Ward·Bed, Admitted, Doctor, From encounter, Actions
- **Actions per row**: Workspace, Transfer, Delete (for discharged)
- **Key modals**:
  - Admit patient form (with patient select, ward, bed, admission type, reason, attending doctor)
  - Discharge form (reason, notes, discharge type)
  - Transfer form (new ward, new bed, reason)
  - Manage wards (add ward with total beds)
  - Edit ward beds
- **Key features**:
  - Occupancy percentage per ward with color pill (bad > 80%, warn, info)
  - Readmission history per patient (stay numbers, days since last discharge)
  - Bed claims management (old bed released, new bed claimed)
  - Deep link from encounter: #/admissions?enc=<id>&new=1
  - Search by patient, ward, bed, doctor, MRN
  - Debounced search input (500ms)
- **Issues**:
  - **CRITICAL**: Visual bed map uses single-char classes ("o" for occupied, "v" for free) with only color distinction; not color-blind accessible
  - **CRITICAL**: Bed numbers in map are tiny; may be hard to read at a glance
  - **CRITICAL**: Admission type select (ADMISSION_TYPES) may have options that are not intuitive
  - **CRITICAL**: Readmission history pills use "neutral" color; may not convey meaning quickly
  - **HIGH**: Search field debounces 500ms; user may think search isn't working
  - **HIGH**: Ward occupancy % uses color only; need text label too
  - **HIGH**: No indication of unsaved changes when opening admission workspace
  - **HIGH**: "Delete" action only for discharged admissions; no confirmation for active admission transfer
  - **MEDIUM**: Wards manager modal: current ward list injected at top; may push form fields off-screen
  - **MEDIUM**: No skeleton during initial load; just "Loading…" in table
  - **MEDIUM**: "No wards configured yet" message could be more helpful with CTA
  - **MEDIUM**: Discharge type select may have options not clearly explained
  - **MEDIUM**: Transfer form: no validation that new bed is different from old bed (service may reject)

### Open Admit Form Sub-components
- Patient select with searchable options
- Ward select with live bed-range hint
- Bed number input with hint (1 – totalBeds)
- Admission type select
- Attending doctor select
- Reason textarea
- **Issues**:
  - Bed number hint only appears when ward with capacity is selected; otherwise no guidance
  - No visual indication if bed number is valid until user tabs out

## 6. Laboratory (#/laboratory)

### LaboratoryView
- **Layout**: 4 stat cards (ordered, in lab, needs sign-off, released) + flow visualization + toolbar + lab orders table
- **Stage chips**: All, Awaiting collection, In lab, Processing, Awaiting validation, Released, Cancelled
- **Patient filter**: Input with debounce; locks patient filter when MRN/name matched
- **Table columns**: Order, Patient, Tests, Stage, Priority, Billing, Date, Actions
- **Key features**:
  - Overdue detection with "Overdue" badge and red styling
  - Priority pills (STAT=bad, Urgent=warn, Routine=default)
  - Billing status (Invoiced=ok, Unbilled=warn)
  - Live updates via subscription
  - Load more for pagination
  - Empty state with "+ New lab order" CTA
- **Key modals/links**:
  - Open lab order detail page (#/laboratory/orders/:id)
  - Create new lab order
  - Bill lab order (creates invoice)
  - Delete lab order
- **Issues**:
  - **CRITICAL**: "Overdue" badge only appears on individual rows; not visible in summary stats
  - **CRITICAL**: Stage filter chips are small; hard to hit with touch; no keyboard focus outline difference
  - **CRITICAL**: Patient filter input may be obscured by software keyboard on phone
  - **CRITICAL**: "Invoiced"/"Unbilled" billing pills use color only; need text
  - **HIGH**: Lab order "Open" link navigates to separate page; losing queue context
  - **HIGH**: Priority pill colors (bad/warn/ok) may not be distinguished by color-blind users
  - **HIGH**: Billing status pills use color only; need icon or text
  - **HIGH**: No skeleton during load; just "Loading…" in table
  - **HIGH**: Empty state is minimal (🧪 icon + text); could offer "+ New lab order" more prominently
  - **MEDIUM**: Turnaround time calculation (isOverdue) uses hardcoded hours; may not match facility policy
  - **MEDIUM**: Patient filter locks patient but doesn't visually indicate which order belongs to which patient beyond name
  - **MEDIUM**: No indication of pending sync when offline
  - **MEDIUM**: Lab order number (orderNo) may be truncated in table cell

### Lab Order Detail (#/laboratory/orders/:id)
- **Per-test workflow**: collect → receive → result → validate → release
- **Each test item** has its own stage tracking, priority, result entry, reference ranges, flags, attachments, camera capture
- **Payment gates** for some tests
- **Result drafts** that can be saved and released later
- **Flags/reference ranges** per test
- **Result attachments** and camera capture
- **Print** of result certificate
- **Error/empty states** for each workflow stage
- **Issues**: Not fully examined; this is a complex nested workflow

## 7. Pharmacy (#/pharmacy)

### PharmacyView
- **Tabs**: Inventory, Receive & dispense, Dispensing, Batches & expiry
- **Stats**: Awaiting dispense, SKUs, Low stock, Out of stock, Stock value (₦)
- **Receive & dispense tab**: Prescriptions awaiting dispensing, one row per script
  - Shows patient name, medicines (first 2 + "+N more"), line count, issued/dispensed/given, status, actions (Open →, View →, Delete Admin)
  - **History**: Recently dispensed scripts (last 10)
  - Bed claim management on dispense
- **Inventory tab**: Drug catalogue with stock, expiry, cost/sell/margin
  - Edit/delete actions per drug
  - Low stock detection (stock < 20)
  - Margin calculation
- **Dispensing tab**: Dispense records (tickets) with items, staff, status
- **Batches & expiry tab**: Batch-numbered drugs with stock and expiry
- **Key modals**:
  - Receive batch form (with live bed-range hint when ward selected)
  - Add drug form
  - Walk-in sale modal
  - Delete confirmations
- **Issues**:
  - **CRITICAL**: "Walk-in Sale" button has green background (#0d9488) with white text; may not have sufficient contrast for some users
  - **CRITICAL**: Receive batch form: bed number hint only appears when ward with capacity selected; otherwise no guidance
  - **CRITICAL**: Low stock count (stock < 20) uses color only; need text label
  - **CRITICAL**: Margin percentage displayed; may be misleading if cost is 0
  - **HIGH**: Dispensing records: items column shows parsed JSON; may be malformed if data corrupted
  - **HIGH**: "Awaiting dispense" count only counts open requests; all-external scripts ride along but not counted
  - **HIGH**: No skeleton during initial load; just "Loading…" in stats and table
  - **HIGH**: Empty states are minimal; no CTA in many cases
  - **HIGH**: Medication row in "Receive & dispense" has tiny medicine names (first 2 only); rest truncated with "+N more"
  - **HIGH**: "Open →" and "View →" buttons are tiny; hard to hit on touch
  - **HIGH**: History "Recently dispensed" table has no pagination; may be very long
  - **MEDIUM**: No indication of pending sync when offline
  - **MEDIUM**: Stock value calculation may be confusing; "cost ₦" line added recently but may not be understood
  - **MEDIUM**: "Receive batch" form: live bed-range hint appears and disappears dynamically; may disorient user
  - **MEDIUM**: No visual distinction between "inventory" (catalogue) and "receive & dispense" (working queue) at a glance

### Pharmacy Receive (#/pharmacy/receive)
- **Receive batch form**: Medicine select, batch number, expiry date, quantity, total cost
- **Live bed-range hint** when ward with capacity is selected
- **Issues**:
  - Medicine select may be very long list; no search/filter
  - Expiry date input: no min/max validation
  - Quantity: no max validation against available stock

## 8. Billing (#/billing)

### BillingView
- **Tabs**: Invoices, Payments, Price catalogue
- **Stats**: Billed ₦, Collected ₦, Outstanding ₦, Open invoices count
- **Invoices tab**: Filter by search, status, payer, date; table with invoice ID, patient, payer, total, status, actions
  - Per-invoice actions: Record payment, Delete (if unpaid)
- **Payments tab**: Filter by search, method; table with receipt #, invoice, patient, amount, method, ref, date, by, actions (print receipt, edit)
  - Shift reconciliation modal (daily/shift cashier)
  - Print receipt per payment
  - Daily/Shift reconciliation with breakdown by payment method
- **Price catalogue tab**: Filter by search, category; table with service/item, category, price, actions (edit/delete price)
  - Add new price form
  - Zero-price items flagged with warning
- **Key modals**:
  - New invoice form (patient select, payer, PA code, line items)
  - Payment form (amount, method: Cash/Transfer/POS/NHIA, reference, notes)
  - Edit payment form
  - Shift reconciliation modal
  - Price edit form inline
- **Key features**:
  - Naira (₦) with kobo precision (maximumFractionDigits: 0)
  - PA code field for HMO/NHIA claims
  - Searchable patient select in invoice form
  - Line item management (add/remove rows, per-item quantity/price)
  - Total calculation displays as naira
  - Payment methods include NHIA (special handling)
  - Shift reconciliation prints handover report
- **Issues**:
  - **CRITICAL**: Naira formatting uses `toLocaleString('en-NG')`; ensures correct locale but may have issues if locale not supported
  - **CRITICAL**: Payment method filter includes "NHIA" but may not show relevant fields (PA code) conditionally
  - **CRITICAL**: "Collection rate" calculation; need to verify formula is correct and displayed properly
  - **CRITICAL**: kobo precision: all money stored in kobo (integer), divided by 100 for display; need to ensure no rounding errors
  - **HIGH**: Invoice form: patient filter/search may not find patient if past initial page of registry
  - **HIGH**: Invoice line items: price input has step="0.01" min="0"; user may enter kobo amount instead of naira
  - **HIGH**: "Total" in invoice footer may not update reactively when line items change
  - **HIGH**: Payment form: amount field may accept both naira and kobo formats inconsistently
  - **HIGH**: No skeleton during initial load; just "Loading…"
  - **HIGH**: Empty states are minimal; no CTA in many places
  - **HIGH**: Price catalogue: zero-price items shown with warning pill; but the pill says "This item has a zero price — please update it" which is good
  - **HIGH**: Shift reconciliation: only shows today's payments; no way to select date range
  - **MEDIUM**: No indication of pending sync when offline
  - **MEDIUM**: Search fields in all three tabs may not clear properly when filter reset clicked
  - **MEDIUM**: "No matching invoices" empty state could offer "+ Create invoice" CTA more prominently
  - **MEDIUM**: Payment method "POS" and "Transfer" may need additional explanation for staff
  - **MEDIUM**: Price catalogue edit: no confirmation before deleting price that is in use

### Open Invoice Form
- Patient select, payer select, PA code
- Line items: item select, qty, price (₦)
- Auto-updating total
- **Issues**:
  - Line item price may be entered as kobo or naira inconsistently
  - No validation that at least one item has a valid price
  - Patient may not be in the initial loaded list

### Open Payment Form
- Invoice select, amount, method (Cash/Transfer/POS/NHIA), reference, notes
- **Issues**:
  - Amount field: may need to accept both naira and kobo; no guidance on format
  - NHIA payments may need PA code validation

## 9. Reports (#/reports)
- Not fully examined; likely contains date-range filters, charts/tables, print/CSV export
- **Issues**: Need to examine

## 10. Administration (#/admin)
- Staff & roles, organization, devices, audit trail, laboratory configuration, data import/export
- **Issues**: Not fully examined

## Design System Foundations

### Colors (from shell.js statusBadge and other pills)
- `ok`: green-ish (used for Paid, Dispensed, Verified, Completed, Active, OK)
- `warn`: yellow-ish/orange (used for Low, Part-paid, Pending, Ready, Partially dispensed, With vitals, Low stock, Overdue, etc.)
- `bad`: red-ish (used for Unpaid, Out, Expiring, Overdue, Cancelled, Rejected, short, etc.)
- `info`: blue-ish (used for In consultation, Confirmed, External, Scheduled, NHIA claim, etc.)
- `neutral`: gray (used for readmission stay numbers)
- Note: These are CSS classes; actual colors defined in app.css (not examined yet)

### Typography & Spacing
- Uses CSS variables from desktop theme; not explicitly defined in source examined
- Font sizes appear to use relative units (rem, em) or small px values
- Spacing: appears to use margins/paddings of 8px, 12px, 16px multiples

### Status Pill Pattern
- `<span class="pill CLASS">TEXT</span>`
- CLASS determines color (ok/warn/bad/info/neutral)
- Used extensively for: encounter status, medication status, lab stage, billing status, drug status, etc.
- **Issue**: Color is the ONLY indicator; no text alternative for color-blind users in some cases

### Form Modal Pattern (formModal in shell.js)
- Fields: label + input/select/textarea, required marker *, hints, preview fields, tags (allergy)
- Live preview of computed fields
- Inline validation (oninput/onblur)
- Save/cancel buttons
- Focus first control on open
- Escape/close behavior
- **Issue**: Some modals may not properly restore focus on close

### Table Pattern
- `<table class="tbl">` with `<thead>` and `<tbody>`
- Rows with `<tr>` and cells `<td>`
- Action cells use `kebabCell` for menu of actions (print, adjust, delete, etc.)
- Some tables have "empty state" when no data
- **Issue**: Many tables have fixed column counts that don't reflow on narrow screens

### Empty States
- Vary from minimal text to icon + text + CTA
- Consistency varies by screen
- Some offer next permitted action, some don't

### Offline/Sync Status
- Sidebar shows: "Online · Firestore" or "Offline · local cache"
- Dot color: green (online, 0 pending), yellow (online, pending), red (offline)
- Detail text: varies based on mode and pending changes count
- **Issue**: May not be visible or understandable during clinical tasks

## Responsive Breakpoints
- **Desktop**: >860px - full sidebar visible
- **Tablet/Mobile**: <860px - sidebar becomes off-canvas drawer
- **Menu button**: ☰ only visible below 860px
- **Scrim**: dims content when drawer open
- **Body lock**: `nav-open` class freezes page scrolling when drawer open

## Key Friction Points Identified

1. **Color-only status indicators** - several screens use pill colors without text alternatives
2. **Small touch targets** - many buttons, carets, and icons are difficult to hit on touch
3. **Poor scannability on narrow screens** - tables with 4-8 columns become unusable; no reflow
4. **Inconsistent empty states** - some offer CTA, some don't; varied messaging
5. **No skeleton loading states** - many screens show "Loading…" without visual filler
6. **Unclear workflow progression** - encounter flow, admission stages, lab workflow not always obvious
7. **Missing context preservation** - when navigating between screens, patient identity may be lost or hard to confirm
8. **Inconsistent form patterns** - modals have slight variations in field layout, validation, save behavior
9. **No reduced-motion preference** - animations may play without respecting user preferences
10. **Phone keyboard obstruction** - form inputs may be hidden by software keyboard; no persistent labels

## Prioritized Improvements

### Phase 1: Critical Safety (immediate)
1. Add text alternatives to all color-coded status pills (e.g., "Paid • ok" or restructure to always show text + color)
2. Ensure all touch targets are minimum 44x44px (inspect button sizes)
3. Add skeleton loading states to all tables/grids on initial fetch
4. Make bed map in admissions color-blind accessible (add text labels, not just colors)
5. Ensure all "empty states" offer the next permitted action

### Phase 2: Usability (next sprint)
1. Reflow tables for narrow screens (column prioritization, horizontal scroll, or summary views)
2. Improve medication/prescription row scannability (larger text, better hierarchy)
3. Add trend arrow color-blind alternatives (text + symbol, not just color)
4. Improve form modals: consistent focus management, restore focus on close
5. Add patient identity persistence across navigation (breadcrumb or persistent header)

### Phase 3: Polish (later)
1. Full design system implementation (typography scale, spacing scale, color palette)
2. Reduced-motion support
3. Advanced responsive patterns (card-based layouts on phone, summary views)
4. Keyboard navigation improvements (focus order, skip links, modal dialog navigation)
5. Print style optimization for all report types