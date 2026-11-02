import assert from 'node:assert/strict'
import {
  normalizeBedId, normalizeWardId, validateAdmissionInput, occupancySummary,
} from '../../src/features/admissions/domain.js'

assert.equal(normalizeBedId('1'), 'Bed 1')
assert.equal(normalizeBedId('Bed 01'), 'Bed 1')
assert.equal(normalizeWardId(' Female Ward '), 'female ward')

const wards = [{ id: 'w1', name: 'Female Ward', totalBeds: 2 }, { id: 'w2', name: 'Overflow', totalBeds: 0 }]
const admissions = [
  { id: 'a1', patientId: 'p1', patientName: 'Patient One', wardName: 'female ward', bedNumber: 'Bed 1', status: 'active' },
  { id: 'a2', patientId: 'p2', wardName: 'Overflow', bedNumber: '1', status: 'active' },
]
assert.match(validateAdmissionInput({ patient_id: 'p3', ward_name: 'Female Ward', bed_number: '1' }, { wards, admissions }), /already occupied/)
assert.match(validateAdmissionInput({ patient_id: 'p3', ward_name: 'Female Ward', bed_number: 'Bed 01' }, { wards, admissions }), /already occupied/)
assert.match(validateAdmissionInput({ patient_id: 'p1', ward_name: 'Female Ward', bed_number: '2' }, { wards, admissions }), /already holds a bed/)
assert.equal(validateAdmissionInput({ patient_id: 'p3', ward_name: 'Female Ward', bed_number: 'Bed 2' }, { wards, admissions }), null)

const summary = occupancySummary(admissions, wards)
assert.equal(summary.totalBeds, 2)
assert.equal(summary.free, 1, 'unconfigured occupancy must not reduce configured available beds')
assert.equal(summary.active, 2)
assert.equal(summary.unconfiguredOccupied, 1)
assert.equal(summary.occupancyPct, 50)

console.log('Admissions domain tests passed')
