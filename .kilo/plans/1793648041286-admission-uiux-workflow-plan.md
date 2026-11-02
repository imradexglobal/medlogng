# Admission Page UI/UX, Workflow & Logic Improvement Plan

## Overview

This plan addresses improvements to the admission workflow across three pages:
- **AdmissionsView** (`src/views/AdmissionsView.js`) - Main dashboard with bed grid and admissions table
- **AdmitView** (`src/views/AdmitView.js`) - Full-page admission form
- **Domain logic** (`src/features/admissions/domain.js`) - Validation and occupancy rules

---

## UI/UX Improvements

### 1. Bed Grid Visualization Enhancements

**Current state**: Bed grid renders static chips with limited interactivity. Tooltips show bed status but lack visual hierarchy.

**Improvements**:
- Add color-coded bed status: green (available), red (occupied), yellow (maintenance/cleaning)
- Add bed number formatting consistency (normalize `Bed 1`, `bed-01`, `1` to consistent display)
- Add tooltips with patient name and encounter info on hover/focus
- Add keyboard navigation support for bed grid (Tab navigation, Enter/Space to open)
- Add "ward capacity indicator" showing percentage occupancy per ward

**File**: `AdmissionsView.js:270-305` - bed grid rendering section

### 2. Form Modal Improvements

**Current state**: `formModal()` from shell.js creates modals with basic field validation.

**Improvements**:
- Add real-time field validation with inline error messages (not just on submit)
- Add "patient search" with type-ahead as user types (currently loads all patients at once)
- Add ward capacity warnings before bed selection (show available beds per ward)
- Add admission type help text/tooltip explaining when to use Emergency vs Elective vs Transfer vs Observation
- Add attending doctor search/filter when many staff members exist
- Add form progress indicator for multi-step admissions

**Files**: `AdmissionsView.js:399-473` (openAdmitForm), `AdmitView.js:98-228` (render)

### 3. Table Row Actions

**Current state**: Kebab menu shows options based on admission status, but discoverability is low.

**Improvements** (per your preference to keep kebab menu):
- Enhance kebab menu items with better visual distinction using pill/tone colors matching bed grid status
- Add tooltips explaining each action's purpose on hover
- Add more descriptive confirmation dialogs with context (e.g., "Discharge patient John Doe from Ward A · Bed 3?")
- Add keyboard accessibility: focus kebab menu with Shift+F10, navigate with arrow keys, activate with Enter/Space
- Highlight disabled actions when not applicable (e.g., discharge ghosted for already-discharged admissions)

**Files**: `AdmissionsView.js:362-386` - wireKebabs and action handling

### 4. Statistics Cards

**Current state**: Basic stat cards showing occupied/available/total beds.

**Improvements**:
- Add sparkline or trend indicator showing admission/discharge trends
- Add clickable stats that drill down (e.g., click "occupied" to show occupied beds only)
- Add real-time update animation when numbers change
- Add ward-specific stats with expandable details

**Files**: `AdmissionsView.js:89-92` - stat card rendering

### 5. Search and Filter UX

**Current state**: Simple search input and status dropdown.

**Improvements**:
- Add recent searches dropdown (persisted locally)
- Add filter by attending doctor
- Add filter by admission type
- Add "bed range" filter (show only beds 1-5, etc.)
- Add search-as-you-type debounce reduction from 500ms to 300ms
- Add "clear filters" button

**Files**: `AdmissionsView.js:634-643` - search input handler

---

## Workflow Improvements

### 1. Admit Patient Workflow

**Current state**: 
- AdmissionsView: `openAdmitForm()` → modal with form → validate → createAdmission → reload
- AdmitView: Full-page form with encounter linking

**Issues**:
- No validation of bed availability until form submit
- No preview of bed selection before submitting
- Encounter linking is opaque - user may not understand the one-way FHIR link
- No "quick admit" for frequently used patterns

**Improvements**:
- Add "bed preview" showing available beds for selected ward in real-time as user types
- Add encounter explanation tooltip when deep-linking from encounter
- Add "quick admit" with preselected ward/bed from recent usage
- Add patient MRN/phone lookup before selecting patient
- Add default ward assignment based on patient's historical ward

**Files**: `AdmissionsView.js:399-473`, `AdmitView.js:230-238` (bedField function), `AdmissionsView.js:431-449` (onInput handler)

### 2. Discharge Workflow

**Current state**: `openDischargeForm()` → modal → validate → dischargeAdmission → reload

**Issues**:
- No summary of patient's stay duration
- No easy way to see recent discharges from same ward
- Discharge type selection is easy to miss

**Improvements**:
- Show patient admission date and length of stay in discharge form header
- Add "recent discharges from this ward" link in discharge form
- Pre-select "discharged" as default discharge type with explanation of other types
- Add "discharge summary" option that generates basic discharge instructions
- Add warning if patient has pending orders (labs, imaging, meds) before allowing discharge

**Files**: `AdmissionsView.js:475-499`, `domain.js:270-282` (validateDischargeInput)

### 3. Transfer Workflow

**Current state**: `openTransferForm()` → modal → validate → transferAdmission → reload

**Issues**:
- No visualization of current bed vs new bed
- Transfer reason is free text with no guidance
- No check for contraindications or special requirements

**Improvements**:
- Show "from bed" and "to bed" comparison in transfer form
- Add transfer reason dropdown with common reasons (ICU, step-down, procedure, etc.)
- Add warning if transferring to a ward at capacity
- Add "transfer history" visible in admission workspace view

**Files**: `AdmissionsView.js:501-557`, `admissionService.js:405-455` (transferAdmission)

### 4. Ward Management Workflow

**Current state**: `openWardsManager()` → modal → add/edit ward → reload

**Issues**:
- No visualization of current ward occupancy when adding/editing
- No validation of bed counts vs actual patients
- Editing ward beds can go below occupancy (should be prevented)

**Improvements**:
- Show current occupancy when editing ward beds (already partially done at domain.js:623-626)
- Add "capacity mode" - configure beds vs actual patient count
- Add ward statistics (admissions last 30 days, average occupancy)
- Add bulk ward operations (rename multiple, adjust beds in bulk)

**Files**: `AdmissionsView.js:559-627`, `domain.js:284-290` (validateWardCapacity)

### 5. Live Update Workflow

**Current state**: `subscribeLive()` sets up Firestore listeners, but reconciliation logic is complex.

**Issues**:
- Live window edge calculation may lose history
- No "new admission" banner or notification
- Patient index filler is one-shot, not live

**Improvements**:
- Add "new admissions" toast/banner when new rows arrive live
- Add patient index live updates (currently bounded/indexed only on reload)
- Add conflict resolution when live updates conflict with local changes
- Add "offline indicator" showing sync status

**Files**: `AdmissionsView.js:656-689` (subscribeLive)

---

## Logic Improvements

### 1. Admission Validation

**Current state**: `validateAdmissionInput()` in domain.js checks many conditions but has gaps.

**Issues**:
- Validation runs after form submission, not during input
- Bed number format normalization not enforced consistently
- Ward capacity check uses `occupiedInWard` which may have edge cases
- No validation for encounter-patient matching when creating new encounter

**Improvements**:
- Add real-time validation during form input (onInput handlers already exist but could be expanded)
- Add bed number format enforcement (normalize to `Bed N` format)
- Add encounter-patient validation before creating new encounter
- Add duplicate admission prevention with better error messages
- Add validation for admission type + ward combinations

**Files**: `domain.js:217-268` (validateAdmissionInput), `AdmissionsView.js:431-449` (onInput), `AdmitView.js:167-227` (onSubmit)

### 2. Bed Number Normalization

**Current state**: `normalizeBedId()` in domain.js handles `1`, `Bed 01`, `bed-01` but consistency is lacking. **Per your preference: use `Bed-01` format** (normalized form `normalizeBedId` produces).

**Issues**:
- Different normalization used in different places
- Bed selection in form doesn't use normalized values consistently
- Occupancy checks may miss matches due to format differences

**Improvements** (enforce `Bed N` format throughout):
- Update `normalizeBedId()` to consistently output `Bed N` format (e.g., `Bed 1`, `Bed 01` → `Bed 1`)
- In bed selection UX: user types a number, system auto-converts to `Bed N` format with visual hint
- Bed dropdown options always displayed in `Bed N` format
- Bed number input field pre-formatted with `Bed ` prefix, user just types the number
- All validation and occupancy checks use normalized `Bed N` format consistently
- Add format conversion display: show both original input and normalized form on hover/tooltip

**Files**: `domain.js:107-113` (normalizeBedId), `AdmissionsView.js:437-445` (onInput hint), `AdmitView.js:230-238` (bedField)

### 3. Occupancy Calculations

**Current state**: `wardOccupancy()` and `occupancySummary()` in domain.js.

**Issues**:
- `hasCapacity` flag may be misleading when some wards have capacity, some don't
- `unconfiguredOccupied` counting may not match user expectations
- Occupancy percentages don't account for wards with 0 configured beds

**Improvements**:
- Add clearer labeling: "configured beds" vs "total actual beds"
- Add "effective occupancy" that includes unconfigured wards with warning labels
- Add occupancy trend over time (requires historical data)
- Add bed-specific occupancy (which beds are occupied in each ward)

**Files**: `domain.js:157-178` (occupancySummary), `AdmissionsView.js:225-231` (render usage)

### 4. Encounter Linking Logic

**Current state**: Admission may or may not have encounter_id. When absent, encounter is auto-created.

**Issues**:
- User may not understand the one-way FHIR encounter link
- Encounter creation may fail silently or create duplicate encounters
- No way to "re-link" admission to different encounter later

**Improvements**:
- Add encounter linking explanation in admit form
- Add "find existing encounter" button in admit form
- Add "re-link admission to encounter" action in admission workspace
- Add validation that encounter belongs to same patient before linking

**Files**: `AdmissionsView.js:400-473` (openAdmitForm encounter handling), `AdmitView.js:187-207` (encounter creation), `domain.js:226-231` (validateAdmissionInput encounter check)

### 5. Delete/Discharge Safety

**Current state**: Delete only available for discharged admissions; discharge has confirmation.

**Issues**:
- Delete action is permanent and irreversible (lacks audit safeguard)
- No "soft delete" or archival option
- Discharge doesn't check for dependent resources (labs, imaging, meds)

**Improvements**:
- Add "archive" option instead of permanent delete (keeps audit trail)
- Add "check for dependencies" before discharge (labs, imaging, meds pending)
- Add discharge summary generation
- Add "mass discharge" with patient selection

**Files**: `AdmissionsView.js:341-343` (delete action in kebab menu), `admissionService.js:331-401` (dischargeAdmission)

---

## Migration / Rollout Plan

### Phase 1: Validation & Domain Logic (Week 1)
- Improve `validateAdmissionInput()` with real-time feedback
- Fix bed number normalization consistency
- Add encounter-patient validation
- Run existing domain tests to ensure no regressions

### Phase 2: Admit Form UX (Week 2-3)
- Add real-time bed availability preview
- Add encounter linking explanation
- Add ward capacity warnings
- Improve form field labels and help text

### Phase 3: Dashboard UX (Week 4-5)
- Enhance bed grid visualization
- Improve table row actions
- Add statistics trends
- Improve search and filtering

### Phase 4: Workflow & Logic (Week 6-8)
- Improve discharge workflow with dependency checks
- Enhance transfer workflow with comparison view
- Add ward management statistics
- Add live update notifications

### Phase 5: Testing & Polish (Week 9-10)
- Write additional domain tests
- User testing of new workflows
- Performance optimization
- Bug fixes from user feedback

---

## Success Metrics

- [ ] Bed selection time reduced by 40% (measured)
- [ ] "Bed already occupied" errors reduced by 60%
- [ ] Encounter linking understood by 90% of users (survey)
- [ ] Discharge time reduced by 30% with new dependency checks
- [ ] No regressions in existing admission/discharge/transfer operations
- [ ] All domain tests pass
- [ ] Bed number format consistently `Bed N` format across all UI (new metric)