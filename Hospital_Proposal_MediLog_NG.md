# MediLog NG — EMR Proposal for [Hospital Name]

**Prepared for:** [Hospital Leadership Team]  
**Prepared by:** Imradex Global  
**Date:** October 2026  
**Version:** 1.0 — Confidential

---

## 1. Executive Summary

MediLog NG is a modern, offline-first Electronic Medical Records (EMR) platform built specifically for Nigerian hospitals. It delivers full clinical, administrative, and financial management at a fraction of the cost of legacy systems — while meeting national EMR standards and integrating with existing workflows.

We propose a **2-month no-risk pilot** during which your team shapes the system to your exact needs, followed by a transparent **₦30,000/month** subscription with no hidden fees, no per-user licenses, and no long-term lock-in.

---

## 2. The Problem: Current EMR Landscape

| Challenge | Impact on Hospital |
|-----------|-------------------|
| **High licensing costs** | ₦500K–₦2M+ annually for legacy vendors |
| **Rigid, foreign-built systems** | Poor fit for Nigerian clinical workflows, NHIA, local payer logic |
| **No offline capability** | Downtime = lost revenue, patient safety risks |
| **Per-seat pricing** | Discourages adoption across clinical staff |
| **Slow customization cycles** | Months to add a ward, clinic, or report |
| **Vendor lock-in** | Data export difficult; migration costly |

---

## 3. Our Solution: MediLog NG

### Core Modules (Included)
- **Patient Registry** — Demographics, MRN, allergy/medication history, NHIA enrollment
- **Appointments & Scheduling** — Multi-clinic, doctor calendars, check-in queue, SMS-ready reminders
- **Consultations / Encounters** — SOAP notes, vitals, diagnoses (ICD-10), prescriptions, lab/imaging orders
- **Billing & Invoicing** — Kobo-safe ₦ pricing, payer management (NHIA, HMO, self-pay), price catalogue, payment recording, collection analytics
- **Pharmacy** — Drug formulary, stock tracking, dispensing, low-stock alerts, batch/expiry management
- **Laboratory** — Test catalogue, sample tracking, results entry, reference ranges, report printing
- **Admissions / Wards** — Bed management, nursing notes, discharge summaries, occupancy dashboard
- **Reports & Analytics** — Revenue, patient flow, drug utilization, NHIA claims export, custom queries
- **Administration** — Role-based access (RBAC), audit trails, hospital/org settings, multi-facility support

### Technical Differentiators
| Feature | Benefit |
|---------|---------|
| **Offline-first (PWA + Electron)** | Works during internet outages; syncs automatically when online |
| **Multi-platform** | Web, Android tablets, Windows/macOS desktop — single codebase |
| **Firebase/Firestore backend** | Real-time collaboration, automatic scaling, 99.95% SLA |
| **Nigerian-first design** | ₦ currency, +234 phone, Nigerian clinics, NHIA logic built-in |
| **Role-based capabilities** | Granular permissions (patient.create, billing.invoice, pharmacy.dispense, etc.) |
| **Audit logging** | Every write tracked for compliance and accountability |

---

## 4. Pilot Program: 2 Months, Zero Risk

| Phase | Duration | Activities |
|-------|----------|------------|
| **Onboarding** | Week 1 | Data migration (patients, price list, users), staff training (2 half-day sessions), go-live on 1–2 clinics |
| **Co-Design Sprint** | Weeks 2–4 | Your clinical leads request custom forms, workflows, reports, or integrations — we build them *during* the pilot |
| **Full Deployment** | Weeks 5–8 | Roll out to all departments; weekly check-ins; SLA monitoring |
| **Review & Decision** | End of Month 2 | Joint review: adoption metrics, custom features delivered, ROI assessment → proceed or walk away |

**During the pilot:** No charges. Full access. All custom work included. Source of truth: your feedback shapes the roadmap.

---

## 5. Commercial Terms (Post-Pilot)

| Item | Terms |
|------|-------|
| **Monthly subscription** | ₦30,000 / hospital / month |
| **Includes** | Unlimited users, unlimited patients, all modules, cloud hosting, backups, security patches, email support |
| **Excludes** | SMS gateway credits (pay-as-you-go), custom hardware, on-site training beyond pilot |
| **Contract** | Month-to-month; cancel with 30 days' notice |
| **Data ownership** | 100% yours — export anytime (JSON, CSV, FHIR) |
| **SLA** | 99.5% uptime; <4 hr critical issue response; <24 hr bug fix deployment |
| **Custom development** | Quoted separately; typical turnaround 2–4 weeks |

**Comparison:** Typical legacy EMR = ₦1.2M–₦3M/year + implementation fees + per-user licenses.  
**MediLog NG** = ₦360,000/year, all-inclusive, no per-user fees.

---

## 6. Implementation Timeline (Post-Pilot)

| Week | Milestone |
|------|-----------|
| 1 | Kickoff, data audit, infrastructure provisioning |
| 2 | Patient & provider data migration; user provisioning |
| 3 | Clinical workflow configuration (clinics, wards, formularies) |
| 4 | Go-live: OPD + Billing + Pharmacy (parallel run 1 week) |
| 5 | Go-live: Labs, Admissions, Consultations |
| 6 | Staff competency sign-off; transition to BAU support |

---

## 7. Security & Compliance

- **Data residency:** Firebase regions (can pin to EU/US; local hosting option available)
- **Encryption:** TLS 1.3 in transit; AES-256 at rest
- **Access control:** MFA enforced; RBAC with capability model; session timeouts
- **Audit trail:** Immutable write logs (Firestore + Cloud Functions)
- **Standards alignment:** NDHIS/NHIA claim formats; ICD-10; FHIR R4 export ready
- **Backup:** Automated daily snapshots; point-in-time recovery (7 days)

---

## 8. Why Imradex Global?

- **Local team** — Built in Nigeria, for Nigerian hospitals
- **Clinical advisory** — Practicing physicians on product council
- **Proven stack** — React + Vite + Electron + Capacitor + Firebase (modern, maintainable)
- **Transparent pricing** — No surprises, no hidden modules
- **Partnership mindset** — We succeed when you succeed; your feature requests drive our roadmap

---

## 9. Next Steps

1. **Introductory call** (30 min) — Walkthrough demo, Q&A
2. **Technical deep-dive** (60 min) — IT/clinical leads review architecture, integration points
3. **Pilot agreement** — Simple MoU (2 pages); no legal fees
4. **Kickoff** — Target start within 2 weeks of signing

---

## 10. Contact

**Imradex Global**  
📧 hello@imradex.com | 📞 +234‑XXX‑XXXXXX  
🌐 imradex.com/medilog-ng  
📍 Ikeja, Lagos

---

*This proposal is valid for 60 days. All pricing in NGN (₦). Custom development and third-party integrations scoped separately. MediLog NG is a registered trademark of Imradex Global.*