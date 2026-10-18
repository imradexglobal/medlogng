// Bulk data schema registry — pure module (no Firebase imports), unit-testable.
//
// This is the single source of truth for the SQLite <-> Firestore mapping used
// by the admin "Data import / export" tab:
//   - generates the .db template (tables, keys, joins)
//   - exports Firestore docs into .db rows
//   - imports .db rows back into Firestore with the same doc shapes the
//     service modules write (patients + organization_patients mirror, embedded
//     JSON aggregates, kobo ints, etc.)
//
// Column types (SQLite side):
//   text  — TEXT            int  — INTEGER        real — REAL
//   bool  — INTEGER 0/1     json — TEXT (JSON)    ts   — TEXT (ISO-8601)
//
// The Firestore document id is the table's PRIMARY KEY (text column `id`).
// Relationships are expressed as foreign keys on the child table pointing at
// the parent's `id`. Timestamps stay ISO strings here; the service converts
// them to Firestore `Timestamp`s just before writing.

const PATIENT_BASE_COLS = [
  { name: 'surname', type: 'text', note: 'Required (Security Rules).' },
  { name: 'given_names', type: 'text' },
  { name: 'full_name', type: 'text' },
  { name: 'mrn', type: 'text', note: 'MRN written by the app (e.g. IMR-XXXXXX); auto-generated on import when blank.' },
  { name: 'phone', type: 'text' },
  { name: 'phone_key', type: 'text' },
  { name: 'sex', type: 'text' },
  { name: 'dob', type: 'text', note: 'YYYY-MM-DD' },
  { name: 'address', type: 'text' },
  { name: 'blood_group', type: 'text' },
  { name: 'genotype', type: 'text' },
  { name: 'payer', type: 'text', note: 'Payer name string.' },
  { name: 'allergy', type: 'json', note: 'Array or comma-separated text.' },
  { name: 'occupation', type: 'text' },
  { name: 'next_of_kin_first_name', type: 'text' },
  { name: 'next_of_kin_last_name', type: 'text' },
  { name: 'next_of_kin_phone', type: 'text' },
  { name: 'next_of_kin_phone_key', type: 'text' },
  { name: 'next_of_kin_address', type: 'text' },
  { name: 'status', type: 'text', note: "Defaults to 'active' (required by Security Rules)." },
  { name: 'created_by', type: 'text', note: 'Stamped with the admin uid when blank.' },
  { name: 'created_at', type: 'ts' },
  { name: 'updated_at', type: 'ts' },
]

// Registry entries in import order (parents first so children always reference
// an id the pusher has already written).
export const IMPORT_ORDER_TABLES = [
  {
    table: 'payers', collection: 'payers', label: 'Payment types (global)',
    scope: 'global',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'name', type: 'text', note: 'Required.' },
      { name: 'category', type: 'text', note: 'e.g. nhia, hmo, self, corporate, other.' },
      { name: 'code', type: 'text' },
      { name: 'sort_order', type: 'int' },
      { name: 'active', type: 'bool' },
      { name: 'organization_id', type: 'text', note: 'Provenance org — written by the admin even though payers are global.' },
    ],
    required: ['name'],
    rulesRequired: ['name'],
  },
  {
    table: 'wards', collection: 'wards', label: 'Wards & beds',
    scope: 'org',
    capability: 'beds.manage',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'name', type: 'text', note: 'Required, unique per hospital.' },
      { name: 'total_beds', type: 'int', note: 'At least 1.' },
      { name: 'created_by', type: 'text', note: 'Stamped with the admin uid when blank.' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['name'],
    rulesRequired: ['name'],
  },
  {
    table: 'patients', collection: 'patients', label: 'Patients',
    scope: 'org', capability: 'patient.create',
    columns: [{ name: 'id', type: 'text', note: 'Firestore document id (pid). Blank = auto-generate (children cannot then link to it).' }, ...PATIENT_BASE_COLS],
    required: ['surname', 'given_names'],
    rulesRequired: ['surname', 'status'],
    defaultStatus: 'active',
    importMirror: { table: 'organization_patients', collection: 'organization_patients', orgKeyed: true },
  },
  {
    table: 'organization_patients', collection: 'organization_patients', label: 'Organization patient links',
    scope: 'org', capability: 'patient.create',
    derived: true, orgKeyed: true,
    note: 'Mirror of patients scoped to the hospital. Automatically written when "patients" is imported; included here for export/edit round-trips.',
    columns: [
      { name: 'id', type: 'text', note: 'Document id {orgId}_{pid}.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      ...PATIENT_BASE_COLS,
    ],
    required: ['patient_id'],
    rulesRequired: ['patient_id', 'status'],
    defaultStatus: 'active',
  },
  {
    table: 'stock_lots', collection: 'stock_lots', label: 'Pharmacy stock',
    scope: 'org', capability: 'prescription.dispense',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'name', type: 'text' },
      { name: 'drug_code', type: 'text', note: '3–6 alphanumeric chars. Part of SKU.' },
      { name: 'strength', type: 'text', note: 'e.g. 500mg. Part of SKU.' },
      { name: 'pack_size', type: 'text', note: 'Positive integer. Part of SKU.' },
      { name: 'sku', type: 'text', note: 'Auto-generated: DRUGCODE-STRENGTH-PACKSIZE.' },
      { name: 'unit', type: 'text' },
      { name: 'stock', type: 'int' },
      { name: 'price', type: 'real', note: 'Price per unit (kobo in the app).' },
      { name: 'batch', type: 'text' },
      { name: 'expiry', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'supplier', type: 'text' },
      { name: 'created_by', type: 'text' },
      { name: 'created_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
  },
  {
    table: 'encounters', collection: 'encounters', label: 'Encounters (consultations)',
    scope: 'org', capability: 'encounter.create',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'appointment_id', type: 'text' },
      { name: 'status', type: 'text', note: "e.g. arrived, in-consultation, closed." },
      { name: 'type', type: 'text', note: 'Encounter type / clinic.' },
      { name: 'clinician', type: 'text' },
      { name: 'chief_complaint', type: 'text' },
      { name: 'vitals', type: 'json', note: 'Object, e.g. {"BP":"120/80","Pulse":"72"}.' },
      { name: 'diagnoses', type: 'json', note: 'Array of {condition, added_at}.' },
      { name: 'diagnosis', type: 'text' },
      { name: 'treatment_plan', type: 'text' },
      { name: 'prescription', type: 'json', note: 'Object — `items` holds every line of the script (medicine/dosage/qty/instructions).' },
      { name: 'lab_orders', type: 'json', note: 'Array of lab order objects.' },
      { name: 'created_by', type: 'text' },
      { name: 'created_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id'],
    rulesRequired: ['patient_id'],
  },
  {
    table: 'admissions', collection: 'admissions', label: 'Admissions',
    scope: 'org', capability: 'beds.manage',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'encounter_id', type: 'text', fk: { table: 'encounters', col: 'id' }, note: 'One-way link back to the triggering encounter.' },
      { name: 'ward_name', type: 'text' },
      { name: 'bed_number', type: 'text' },
      { name: 'admission_type', type: 'text' },
      { name: 'admission_reason', type: 'text' },
      { name: 'attending_provider', type: 'text' },
      { name: 'status', type: 'text', note: "'active' or 'discharged'. Defaults to 'active'." },
      { name: 'session_no', type: 'int', note: 'Human‑readable session number (count of patient admissions in this org + 1).' },
      { name: 'discharge_date', type: 'ts' },
      { name: 'discharge_reason', type: 'text' },
      { name: 'discharge_notes', type: 'text' },
      { name: 'discharged_by', type: 'text' },
      { name: 'discharged_by_name', type: 'text' },
      { name: 'created_by', type: 'text' },
      { name: 'created_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id'],
    rulesRequired: ['patient_id'],
    defaultStatus: 'active',
  },
  {
    table: 'admission_plan_items', collection: 'admission_plan_items', label: 'Admission plan items',
    scope: 'org', capability: 'encounter.edit',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'admission_session_id', type: 'text', note: 'The admission session this item belongs to.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'encounter_id', type: 'text', note: 'The encounter that triggered the admission (optional).' },
      { name: 'round', type: 'int', note: 'Clinical review round number (1 = initial plan, 2 = first review, etc.).' },
      { name: 'type', type: 'text', note: 'One of: assessment, investigation, imaging, treatment, medication, monitoring, nursing, diet, activity, referral, followup, other.' },
      { name: 'status', type: 'text', note: "planned | in-progress | completed | cancelled | removed. Defaults to 'planned'." },
      { name: 'text', type: 'text', note: 'The plan item description.' },
      { name: 'revisions', type: 'json', note: 'Array of {text, by, at} — edit history, never overwrites.' },
      { name: 'created_by', type: 'text' },
      { name: 'created_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id', 'round', 'type', 'text'],
    rulesRequired: ['patient_id'],
    defaultStatus: 'planned',
  },
  {
    table: 'appointments', collection: 'appointments', label: 'Appointments',
    scope: 'org', capability: 'appointment.create',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'time', type: 'text', note: 'Required date-time string.' },
      { name: 'clinic', type: 'text', note: 'Required clinic/department.' },
      { name: 'doctor', type: 'text' },
      { name: 'type', type: 'text' },
      { name: 'reason', type: 'text' },
      { name: 'status', type: 'text', note: "scheduled | checked-in | completed | cancelled | no-show. Defaults to 'scheduled'." },
      { name: 'checkedIn', type: 'bool' },
      { name: 'created_by', type: 'text' },
      { name: 'created_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id', 'time', 'clinic'],
    rulesRequired: ['patient_id'],
    defaultStatus: 'scheduled',
  },
  {
    table: 'vitals', collection: 'vitals', label: 'Vitals',
    scope: 'org', capability: 'vitals.create',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'encounter_id', type: 'text', fk: { table: 'encounters', col: 'id' } },
      { name: 'bp_systolic', type: 'int' },
      { name: 'bp_diastolic', type: 'int' },
      { name: 'pulse', type: 'int' },
      { name: 'temp_c', type: 'real' },
      { name: 'spo2', type: 'int' },
      { name: 'note', type: 'text' },
      { name: 'created_by', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id'],
    rulesRequired: ['patient_id'],
  },
  {
    table: 'diagnoses', collection: 'diagnoses', label: 'Diagnoses',
    scope: 'org', capability: 'diagnosis.create',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'encounter_id', type: 'text', fk: { table: 'encounters', col: 'id' } },
      { name: 'condition', type: 'text', note: 'Required.' },
      { name: 'icd_code', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'created_by', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id', 'condition'],
    rulesRequired: ['patient_id'],
  },
  {
    table: 'allergies', collection: 'allergies', label: 'Allergies',
    scope: 'org', capability: 'diagnosis.create',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'allergy', type: 'text', note: 'Required.' },
      { name: 'severity', type: 'text' },
      { name: 'note', type: 'text' },
      { name: 'status', type: 'text' },
      { name: 'created_by', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id', 'allergy'],
    rulesRequired: ['patient_id'],
  },
  {
    table: 'medication_requests', collection: 'medication_requests', label: 'Medication requests',
    scope: 'org', capability: 'prescription.create',
    // One row is one PRESCRIPTION SCRIPT for a patient/encounter, holding every
    // medicine the prescriber wrote in `items`. Each item carries its own
    // dispensed_qty so the pharmacy can issue part of a script. Legacy rows
    // written before this model hold a single drug at the top level instead;
    // they still read correctly and are migrated to `items` on first dispense.
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text', note: 'Denormalised so the pharmacy queue does not need a patient join per row.' },
      { name: 'encounter_id', type: 'text', fk: { table: 'encounters', col: 'id' }, note: 'Prescriptions for one encounter form one script.' },
      { name: 'admission_session_id', type: 'text', note: 'Links to the admission session (doc id).' },
      { name: 'items', type: 'json', note: 'The script. Each line: {line_id, drug_id, sku, medicine, unit, dosage, quantity, instructions, dispensed_qty, external}. external:true = bought outside the hospital; excluded from stock and dispensing.' },
      { name: 'status', type: 'text', note: "Requested | Partially dispensed | Dispensed | Declined | External (all lines external)." },
      { name: 'dispensed_at', type: 'ts', note: 'Set when the last line is issued.' },
      { name: 'created_by', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id', 'medicine'],
    rulesRequired: ['patient_id'],
    defaultStatus: 'Requested',
  },
  {
    table: 'lab_orders', collection: 'lab_orders', label: 'Lab orders',
    scope: 'org', capability: 'lab.order',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'encounter_id', type: 'text', fk: { table: 'encounters', col: 'id' } },
      { name: 'admission_session_id', type: 'text', note: 'Links to the admission session (doc id).' },
      { name: 'order_no', type: 'text', note: 'Human-readable order number (LAB-YY-XXXXXX).' },
      { name: 'source', type: 'text', note: "hospital | standalone. Defaults by context at order time." },
      { name: 'test_panel', type: 'text', note: 'Required. Denormalised summary of the tests.' },
      { name: 'tests', type: 'json', note: 'Array of individual tests for a multi-test order; test_panel holds the joined summary.' },
      { name: 'items', type: 'json', note: 'Per-test LIMS items (status, frozen config snapshot, result, collection). Legacy orders may be empty.' },
      { name: 'total_kobo', type: 'int', note: 'Sum of item price snapshots (kobo).' },
      { name: 'invoice_id', type: 'text', note: 'Stamped when the order is invoiced.' },
      { name: 'billing_status', type: 'text', note: "unbilled | invoiced." },
      { name: 'note', type: 'text' },
      { name: 'facility', type: 'text', note: "internal | external. External orders are printed for the patient to take to an outside lab." },
      { name: 'priority', type: 'text' },
      { name: 'status', type: 'text', note: "order | accepted | specimen-collected | processing | completed | verified | cancelled. Defaults to 'order'." },
      { name: 'ordered_by', type: 'text' },
      { name: 'ordered_by_name', type: 'text' },
      { name: 'ordered_at', type: 'ts' },
      { name: 'accepted_at', type: 'ts' },
      { name: 'collected_at', type: 'ts' },
      { name: 'processing_at', type: 'ts' },
      { name: 'processed_at', type: 'ts' },
      { name: 'completed_at', type: 'ts' },
      { name: 'verified_at', type: 'ts' },
      { name: 'cancelled_at', type: 'ts' },
      { name: 'verified_by', type: 'text' },
      { name: 'verified_by_name', type: 'text' },
      { name: 'result', type: 'json', note: 'Object of result values.' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id', 'test_panel'],
    rulesRequired: ['patient_id'],
    defaultStatus: 'order',
  },
  {
    table: 'lab_test_catalogue', collection: 'lab_test_catalogue', label: 'Lab test catalogue',
    scope: 'org', capability: 'lab.catalogue.manage',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'code', type: 'text', note: 'Short code (e.g. FBC); unique per organisation by convention.' },
      { name: 'name', type: 'text', note: 'Required. Display name.' },
      { name: 'category', type: 'text' },
      { name: 'specimen_type', type: 'text' },
      { name: 'price_kobo', type: 'int', note: 'Price in kobo. Orders freeze a snapshot; changing this never rewrites history.' },
      { name: 'turnaround_hours', type: 'int' },
      { name: 'active', type: 'int', note: '1 = orderable. 0 = hidden from pickers but kept for history.' },
      { name: 'sort_order', type: 'int' },
      { name: 'components', type: 'json', note: 'Structured result components (id, name, result_type, unit, reference config…).' },
      { name: 'created_by', type: 'text' },
      { name: 'created_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['name'],
    rulesRequired: ['name'],
  },
  {
    table: 'lab_settings', collection: 'lab_settings', label: 'Lab settings',
    scope: 'org', capability: 'lab.catalogue.manage',
    columns: [
      { name: 'organization_id', type: 'text', note: 'Document id = organization_id. Required.' },
      { name: 'categories', type: 'json' },
      { name: 'specimen_types', type: 'json' },
      { name: 'report', type: 'json', note: 'Report header: lab_name, address, contact, footer, signatory.' },
      { name: 'accession_prefix', type: 'text' },
      { name: 'updated_by', type: 'text' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['organization_id'],
    rulesRequired: ['organization_id'],
  },
  {
    table: 'invoices', collection: 'invoices', label: 'Invoices',
    scope: 'org', capability: 'billing.invoice',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'invoice_id', type: 'text' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'admission_session_id', type: 'text', note: 'Links to the admission session (doc id).' },
      { name: 'encounter_id', type: 'text', note: 'Links to the encounter that generated this charge.' },
      { name: 'payer', type: 'text' },
      { name: 'items', type: 'text' },
      { name: 'lines', type: 'json', note: 'Optional structured lines (LIMS); `items` TEXT stays the legacy summary.' },
      { name: 'source_type', type: 'text', note: 'e.g. lab_order when raised from the laboratory module.' },
      { name: 'source_id', type: 'text', note: 'Source document id (e.g. the lab order id).' },
      { name: 'total_kobo', type: 'int', note: 'Amount in kobo (precision).' },
      { name: 'paid_kobo', type: 'int', note: 'Amount in kobo.' },
      { name: 'status', type: 'text', note: 'unpaid | part-paid | paid.' },
      { name: 'date', type: 'text' },
      { name: 'created_by', type: 'text' },
      { name: 'created_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id'],
    rulesRequired: ['patient_id'],
  },
  {
    table: 'imaging_orders', collection: 'imaging_orders', label: 'Imaging orders',
    scope: 'org', capability: 'lab.order',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'organization_id', type: 'text', note: 'Provenance org.' },
      { name: 'admission_session_id', type: 'text', note: 'Links to the admission session (doc id).' },
      { name: 'encounter_id', type: 'text', note: 'The encounter that triggered the order.' },
      { name: 'modality', type: 'text', note: 'Primary modality (first of `modalities`). One of: X-ray, Ultrasound, CT, MRI, PET, Other.' },
      { name: 'modalities', type: 'json', note: 'Distinct modalities requested by the order.' },
      { name: 'study', type: 'text', note: 'Denormalised summary of the studies / body parts.' },
      { name: 'studies', type: 'json', note: 'Array of individual studies; study holds the joined summary.' },
      { name: 'items', type: 'json', note: 'The requests. Each item: {modality, study}. One order may mix modalities (e.g. X-ray + MRI).' },
      { name: 'facility', type: 'text', note: "internal | external. External orders are printed for the patient to take to an outside facility." },
      { name: 'priority', type: 'text' },
      { name: 'status', type: 'text', note: "order | accepted | in-progress | completed | verified | cancelled. Defaults to 'order'." },
      { name: 'indication', type: 'text', note: 'Clinical indication.' },
      { name: 'ordered_by', type: 'text' },
      { name: 'ordered_by_name', type: 'text' },
      { name: 'ordered_at', type: 'ts' },
      { name: 'completed_at', type: 'ts' },
      { name: 'verified_at', type: 'ts' },
      { name: 'verified_by', type: 'text' },
      { name: 'verified_by_name', type: 'text' },
      { name: 'result', type: 'json', note: 'Object of result values.' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id', 'modality', 'study'],
    rulesRequired: ['patient_id'],
    defaultStatus: 'order',
  },
  {
    table: 'invoices', collection: 'invoices', label: 'Invoices',
    table: 'payments', collection: 'payments', label: 'Payments',
    scope: 'org', capability: 'billing.payment', appendOnly: true,
    note: 'Append-only in Firestore (no update). Rows with an existing id are reported as skipped rather than overwritten.',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'invoice_id', type: 'text', fk: { table: 'invoices', col: 'id' }, note: 'Required.' },
      { name: 'invoice_number', type: 'text' },
      { name: 'amount_kobo', type: 'int', note: 'Required, must be a positive integer (Security Rules).' },
      { name: 'amount_naira', type: 'int' },
      { name: 'method', type: 'text' },
      { name: 'receipt_number', type: 'text' },
      { name: 'paid_by', type: 'text' },
      { name: 'paid_at', type: 'ts' },
      { name: 'notes', type: 'text' },
    ],
    required: ['invoice_id', 'amount_kobo'],
    rulesRequired: ['invoice_id', 'amount_kobo'],
  },
  {
    table: 'dispensations', collection: 'dispensations', label: 'Dispensations',
    scope: 'org', capability: 'prescription.dispense', appendOnly: true,
    note: 'Append-only in Firestore (no update). Rows with an existing id are reported as skipped rather than overwritten.',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'patient_name', type: 'text' },
      { name: 'items', type: 'text' },
      { name: 'by', type: 'text' },
      { name: 'status', type: 'text', note: "Defaults to 'pending'." },
      { name: 'time', type: 'ts' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id'],
    rulesRequired: ['patient_id'],
    defaultStatus: 'pending',
  },
  {
    table: 'documents', collection: 'documents', label: 'Patient documents (metadata)',
    scope: 'org', capability: 'documents.upload',
    note: 'Metadata only — file blobs are out of scope here.',
    columns: [
      { name: 'id', type: 'text', note: 'Firestore document id; blank = auto-generate.' },
      { name: 'patient_id', type: 'text', fk: { table: 'patients', col: 'id' }, note: 'Required.' },
      { name: 'name', type: 'text' },
      { name: 'document_type', type: 'text' },
      { name: 'description', type: 'text' },
      { name: 'url', type: 'text' },
      { name: 'storage_path', type: 'text' },
      { name: 'uploaded_by', type: 'text' },
      { name: 'uploaded_by_name', type: 'text' },
      { name: 'created_at', type: 'ts' },
      { name: 'updated_at', type: 'ts' },
    ],
    required: ['patient_id'],
    rulesRequired: ['patient_id'],
  },
]

export const TABLES = IMPORT_ORDER_TABLES

export const TABLE_BY_TABLE = Object.fromEntries(TABLES.map((e) => [e.table, e]))
export const TABLE_BY_COLLECTION = Object.fromEntries(TABLES.map((e) => [e.collection, e]))

export const TABLE_NAMES = TABLES.map((e) => e.table)

// Firestore ids referenced by children — used for FK-integrity warnings.
export function fkTargets(entry) {
  const out = []
  for (const c of entry.columns) {
    if (c.fk) out.push({ column: c.name, table: c.fk.table, col: c.fk.col })
  }
  return out
}

export function hasColumn(entry, name) {
  return entry.columns.some((c) => c.name === name)
}

export function tsColumns(entry) {
  return entry.columns.filter((c) => c.type === 'ts')
}

// ---- SQL template ----------------------------------------------------------

export function buildCreateTableSql(entry) {
  const columnLines = entry.columns.map((c) =>
    '"' + c.name + '" ' + (c.name === 'id' ? 'TEXT NOT NULL' : sqlType(c.type)),
  )
  const fkLines = entry.columns
    .filter((c) => c.fk)
    .map((c) => 'FOREIGN KEY ("' + c.name + '") REFERENCES "' + c.fk.table + '"("' + c.fk.col + '") ON DELETE SET NULL')
  return 'CREATE TABLE IF NOT EXISTS "' + entry.table + '" (\n  ' + [...columnLines, 'PRIMARY KEY ("id")', ...fkLines].join(',\n  ') + '\n);'
}

function sqlType(t) {
  if (t === 'int') return 'INTEGER'
  if (t === 'real') return 'REAL'
  if (t === 'bool') return 'INTEGER'
  if (t === 'json') return 'TEXT'
  if (t === 'ts') return 'TEXT'
  return 'TEXT'
}

export const REFERENCE_TABLE_DDL =
  'CREATE TABLE IF NOT EXISTS "schema_reference" (\n' +
  '  "table_name" TEXT NOT NULL,\n' +
  '  "column_name" TEXT NOT NULL,\n' +
  '  "type" TEXT,\n' +
  '  "required" INTEGER DEFAULT 0,\n' +
  '  "references" TEXT,\n' +
  '  "note" TEXT\n' +
  ');'

export const META_TABLE_DDL =
  'CREATE TABLE IF NOT EXISTS "__meta" (\n' +
  '  "key" TEXT NOT NULL PRIMARY KEY,\n' +
  '  "value" TEXT\n' +
  ');'

// ---- row <-> doc coercion (pure, string-based timestamps) ------------------

export function rowToDoc(entry, row) {
  const out = {}
  for (const c of entry.columns) {
    if (c.name === 'id') continue // doc id, never a stored field
    const v = row[c.name]
    if (v === undefined || v === null) {
      out[c.name] = ''
      continue
    }
    switch (c.type) {
      case 'int':
        out[c.name] = Number(v) || 0
        break
      case 'real':
        out[c.name] = Number(v) || 0
        break
      case 'bool':
        out[c.name] = String(v) === '1' || String(v).toLowerCase() === 'true'
        break
      case 'json': {
        let parsed = null
        try { parsed = JSON.parse(String(v)) } catch { parsed = null }
        out[c.name] = parsed !== null ? parsed : String(v).trim()
        break
      }
      case 'ts':
        out[c.name] = String(v)
        break
      default:
        out[c.name] = String(v)
    }
  }
  return out
}

export function tsToIso(v) {
  if (v === undefined || v === null || v === '') return ''
  if (typeof v === 'string') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? v : d.toISOString()
  }
  if (v instanceof Date) {
    return isNaN(v.getTime()) ? '' : v.toISOString()
  }
  if (typeof v.toMillis === 'function') return new Date(v.toMillis()).toISOString()
  if (typeof v === 'number') {
    const d = new Date(v)
    return isNaN(d.getTime()) ? '' : d.toISOString()
  }
  return String(v)
}

// Firestore doc -> SQLite row (id handled separately by the exporter).
export function docToRow(entry, doc) {
  const row = {}
  for (const c of entry.columns) {
    if (c.name === 'id') continue
    const v = doc[c.name]
    if (v === undefined || v === null) {
      row[c.name] = ''
      continue
    }
    switch (c.type) {
      case 'int':
        row[c.name] = Number(v) || 0
        break
      case 'real':
        row[c.name] = Number(v) || 0
        break
      case 'bool':
        row[c.name] = v ? 1 : 0
        break
      case 'json':
        row[c.name] = typeof v === 'string' ? v : JSON.stringify(v)
        break
      case 'ts':
        row[c.name] = tsToIso(v)
        break
      default:
        row[c.name] = typeof v === 'string' ? v : String(v)
    }
  }
  return row
}

export function validateRow(entry, data) {
  for (const f of entry.rulesRequired || []) {
    const v = data[f]
    const blank = v === undefined || v === null || String(v).trim() === ''
    if (blank) return 'Missing required field "' + f + '"'
  }
  if (entry.table === 'payments') {
    const n = Number(data.amount_kobo)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return 'amount_kobo must be a positive integer (Security Rules)'
    }
    data.amount_kobo = n
  }
  if (entry.table === 'wards') {
    const beds = Number(data.total_beds)
    if (!Number.isFinite(beds) || beds < 1) return 'total_beds must be at least 1'
    data.total_beds = beds
  }
  return null
}