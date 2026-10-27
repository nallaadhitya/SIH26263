const { evaluateCompliance, ENGINE_VERSION } = require('../compliance/engine');
const { DEMO_RECORDS } = require('../scripts/seed-demo');

const detectedAt = '2026-10-26T00:00:00.000Z';
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
function student(number = 1, overrides = {}) {
  return { id: uuid(number), apaarId: String(number).padStart(12, '0'),
    studentName: 'Fictional Demo Learner', institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001',
    academicYear: '2026-2027', admissionYear: '2026', admissionCategory: 'general', status: 'active', ...overrides };
}
function fixture(students = [student()], intakeOverrides = {}) {
  return { institutionId: 'DEMO-INST-001', students,
    institutions: structuredClone(DEMO_RECORDS.institutions), programmes: structuredClone(DEMO_RECORDS.programmes),
    approvedIntakes: [{ ...structuredClone(DEMO_RECORDS['approved-intakes'][0]), approvedSeats: 1, ...intakeOverrides }], detectedAt };
}
const hasRule = (result, code) => result.findings.find((finding) => finding.ruleCode === code);
const comparison = (result) => result.summary.intakeComparisons.find((entry) => entry.programmeId === 'DEMO-PROG-001' && entry.academicYear === '2026-2027');

test.each([0, 1, 2])('capacity boundary: %i records against one configured seat', (count) => {
  const result = evaluateCompliance(fixture(Array.from({ length: count }, (_, index) => student(index + 1))));
  expect(comparison(result).countedEnrolment).toBe(count);
  expect(comparison(result).comparison).toBe(count > 1 ? 'exceeded' : 'not_exceeded');
  expect(Boolean(hasRule(result, 'INTAKE_EXCEEDED'))).toBe(count > 1);
  expect(result.summary.totalRecordsEvaluated).toBe(count);
  expect(result.summary.recordsWithNoFindings).toBe(count > 1 ? 0 : count);
  if (count > 1) {
    expect(hasRule(result, 'INTAKE_EXCEEDED')).toMatchObject({ severity: 'critical', kind: 'violation', ruleVersion: '1.0.0' });
    expect(result.summary.overIntake).toHaveLength(1);
  }
});

test('zero capacity is a valid boundary, not missing intake', () => {
  const result = evaluateCompliance(fixture([student()], { approvedSeats: 0 }));
  expect(hasRule(result, 'INTAKE_EXCEEDED')).toBeDefined();
  expect(hasRule(result, 'INTAKE_REFERENCE_REVIEW')).toBeUndefined();
});

test('institution, programme, academic year and configured statuses are matched exactly', () => {
  const inputs = fixture([
    student(), student(2, { status: 'inactive' }),
    student(3, { institutionId: 'DEMO-INST-002', programmeId: 'DEMO-PROG-002' }),
    student(4, { academicYear: '2025-2026', admissionYear: '2025' }),
  ]);
  inputs.approvedIntakes.push({ ...structuredClone(DEMO_RECORDS['approved-intakes'][1]), approvedSeats: 0 });
  const result = evaluateCompliance(inputs);
  expect(comparison(result)).toMatchObject({ observedRecords: 2, countedEnrolment: 1, excludedRecords: 1, comparison: 'not_exceeded' });
  expect(result.summary.totalRecordsEvaluated).toBe(3);
  expect(result.summary.intakeComparisons.every((entry) => entry.institutionId === 'DEMO-INST-001' && entry.programmeId === 'DEMO-PROG-001')).toBe(true);
  expect(result.findings.some((finding) => finding.ruleCode === 'INTAKE_REFERENCE_REVIEW' && finding.academicYear === '2025-2026')).toBe(true);
});

test.each([
  ['required name', { studentName: '' }, 'REQUIRED_FIELD_INVALID'],
  ['missing internal ID', { id: undefined }, 'REQUIRED_FIELD_INVALID'],
  ['oversized field', { studentName: 'x'.repeat(257) }, 'REQUIRED_FIELD_INVALID'],
  ['control character', { studentName: 'Fictional\u0000' }, 'REQUIRED_FIELD_INVALID'],
  ['numeric APAAR', { apaarId: 1 }, 'APAAR_FORMAT_INVALID'],
  ['malformed APAAR', { apaarId: 'DEMO-APAAR-1' }, 'APAAR_FORMAT_INVALID'],
  ['unknown programme', { programmeId: 'UNKNOWN' }, 'REFERENCE_PROGRAMME_INVALID'],
  ['other institution programme', { programmeId: 'DEMO-PROG-002' }, 'REFERENCE_PROGRAMME_INVALID'],
  ['nonconsecutive year', { academicYear: '2026-2028' }, 'ACADEMIC_YEAR_INVALID'],
  ['out-of-range year', { academicYear: '1999-2000' }, 'ACADEMIC_YEAR_INVALID'],
  ['invalid admission', { admissionYear: 'twenty' }, 'ADMISSION_YEAR_INVALID'],
  ['future admission', { admissionYear: '2027' }, 'ADMISSION_YEAR_INVALID'],
  ['unknown category', { admissionCategory: 'unsupported' }, 'ADMISSION_CATEGORY_UNSUPPORTED'],
  ['unknown status', { status: 'unsupported' }, 'RECORD_STATUS_INVALID'],
])('deterministic field rule: %s', (name, overrides, code) => {
  const result = evaluateCompliance(fixture([student(1, overrides)]));
  expect(hasRule(result, code)).toMatchObject({ severity: 'warning', kind: 'violation' });
  expect(result.summary.recordsWithNoFindings).toBe(0);
});

test('unknown institution is a critical reference violation', () => {
  const inputs = fixture();
  inputs.institutions = [];
  expect(hasRule(evaluateCompliance(inputs), 'REFERENCE_INSTITUTION_INVALID')).toMatchObject({ severity: 'critical', kind: 'violation' });
});

test('leading zeroes are accepted without claiming identity authenticity', () => {
  const result = evaluateCompliance(fixture());
  expect(hasRule(result, 'APAAR_FORMAT_INVALID')).toBeUndefined();
  expect(result.authenticityVerified).toBe(false);
});

test('duplicates and conflicting records are separate findings and are not counted twice', () => {
  const duplicate = evaluateCompliance(fixture([student(1), student(2, { apaarId: student(1).apaarId })]));
  expect(hasRule(duplicate, 'APAAR_DUPLICATE')).toMatchObject({ severity: 'warning', kind: 'violation', recordIds: [uuid(1), uuid(2)] });
  expect(comparison(duplicate)).toMatchObject({ countedEnrolment: 0, unresolvedRecords: 2, comparison: 'requires_review' });
  const conflict = evaluateCompliance(fixture([student(1), student(2, { apaarId: student(1).apaarId, studentName: 'Fictional Changed Name' })]));
  expect(hasRule(conflict, 'APAAR_CONFLICT')).toMatchObject({ severity: 'critical', kind: 'requires_review' });
  expect(hasRule(conflict, 'INTAKE_COUNT_REVIEW')).toBeDefined();
});

test('unchanged records across institutions do not generate cross-institution duplicate findings', () => {
  const inputs = fixture([student(), student(2, { apaarId: student().apaarId, institutionId: 'DEMO-INST-002' })]);
  expect(hasRule(evaluateCompliance(inputs), 'APAAR_DUPLICATE')).toBeUndefined();
});

test.each([undefined, null, -1, 1.5, '60'])('invalid or missing approvedSeats produces review: %s', (approvedSeats) => {
  const result = evaluateCompliance(fixture([student()], { approvedSeats }));
  expect(hasRule(result, 'INTAKE_REFERENCE_REVIEW')).toMatchObject({ severity: 'warning', kind: 'requires_review' });
  expect(hasRule(result, 'INTAKE_EXCEEDED')).toBeUndefined();
});

test('missing or multiple matching intake rows are not guessed or summed', () => {
  const inputs = fixture();
  inputs.approvedIntakes = [];
  expect(hasRule(evaluateCompliance(inputs), 'INTAKE_REFERENCE_REVIEW')).toBeDefined();
  inputs.approvedIntakes = [structuredClone(DEMO_RECORDS['approved-intakes'][0]), structuredClone(DEMO_RECORDS['approved-intakes'][0])];
  expect(hasRule(evaluateCompliance(inputs), 'INTAKE_REFERENCE_REVIEW')).toBeDefined();
});

test('malformed academic years in scoped intake references require review rather than being ignored', () => {
  const inputs = fixture([], { academicYear: '2026-2028' });
  expect(hasRule(evaluateCompliance(inputs), 'INTAKE_REFERENCE_REVIEW')).toMatchObject({ kind: 'requires_review', academicYear: null });
});

test('malformed category objects produce findings without coercion errors', () => {
  const inputs = fixture([student(1, { admissionCategory: { toString: [] } })]);
  expect(hasRule(evaluateCompliance(inputs), 'REQUIRED_FIELD_INVALID')).toBeDefined();
});

test.each([
  undefined, {}, { includedStatuses: ['active'], categoryTreatment: {} },
  { includedStatuses: ['unsupported'], categoryTreatment: { general: 'counted' } },
  { includedStatuses: ['active'], categoryTreatment: { general: 'invented' } },
])('legacy or malformed counting policy requires review', (countingPolicy) => {
  const result = evaluateCompliance(fixture([student()], { countingPolicy }));
  expect(hasRule(result, 'INTAKE_POLICY_REVIEW')).toMatchObject({ kind: 'requires_review' });
  expect(comparison(result).countedEnrolment).toBeNull();
});

test('missing or invalid admission-year constraints require review; explicit bounds are inclusive', () => {
  const inputs = fixture();
  delete inputs.approvedIntakes[0].countingPolicy.admissionYearRange;
  expect(hasRule(evaluateCompliance(inputs), 'ADMISSION_POLICY_REVIEW')).toMatchObject({ severity: 'info', kind: 'requires_review' });
  inputs.approvedIntakes[0].countingPolicy.admissionYearRange = { min: '2025', max: '2026' };
  for (const year of ['2025', '2026']) {
    inputs.students[0].admissionYear = year;
    expect(hasRule(evaluateCompliance(inputs), 'ADMISSION_YEAR_POLICY_VIOLATION')).toBeUndefined();
  }
  inputs.students[0].admissionYear = '2024';
  expect(hasRule(evaluateCompliance(inputs), 'ADMISSION_YEAR_POLICY_VIOLATION')).toMatchObject({ kind: 'violation' });
  inputs.approvedIntakes[0].countingPolicy.admissionYearRange = { min: '2027', max: '2025' };
  expect(hasRule(evaluateCompliance(inputs), 'ADMISSION_POLICY_REVIEW')).toBeDefined();
});

test.each(['nri', 'oci', 'foreign_national', 'supernumerary'])('%s has no invented exemption or quota', (admissionCategory) => {
  const inputs = fixture([student(1, { admissionCategory })]);
  let result = evaluateCompliance(inputs);
  expect(hasRule(result, 'CATEGORY_POLICY_REVIEW')).toBeDefined();
  expect(comparison(result).comparison).toBe('requires_review');
  // Only an explicit reference treatment can exclude it from the base capacity.
  inputs.approvedIntakes[0].countingPolicy.categoryTreatment[admissionCategory] = 'excluded';
  result = evaluateCompliance(inputs);
  expect(hasRule(result, 'ADMISSION_CATEGORY_UNSUPPORTED')).toBeUndefined();
  expect(comparison(result)).toMatchObject({ countedEnrolment: 0, excludedRecords: 1, unresolvedRecords: 0 });
});

test('counted/review category treatment is explicit; unresolved rows cannot imply compliance', () => {
  const inputs = fixture([student(), student(2, { admissionCategory: 'obc' })]);
  inputs.approvedIntakes[0].countingPolicy.categoryTreatment.obc = 'review';
  const result = evaluateCompliance(inputs);
  expect(comparison(result)).toMatchObject({ countedEnrolment: 1, unresolvedRecords: 1, comparison: 'requires_review' });
  expect(hasRule(result, 'CATEGORY_POLICY_REVIEW')).toBeDefined();
});

test('a known overage remains a deterministic finding even with additional unresolved records', () => {
  const inputs = fixture([student(), student(2), student(3, { apaarId: 'bad' })]);
  const result = evaluateCompliance(inputs);
  expect(comparison(result)).toMatchObject({ countedEnrolment: 2, unresolvedRecords: 1, comparison: 'exceeded' });
  expect(hasRule(result, 'INTAKE_EXCEEDED')).toBeDefined();
});

test('evaluation is reproducible, order-independent, does not mutate input and generates structured IDs', () => {
  const inputs = fixture([student(), student(2)]);
  const original = structuredClone(inputs);
  const result = evaluateCompliance(inputs);
  expect(inputs).toEqual(original);
  inputs.students.reverse();
  inputs.institutions.reverse();
  inputs.programmes.reverse();
  expect(evaluateCompliance(inputs)).toEqual(result);
  expect(result.engineVersion).toBe(ENGINE_VERSION);
  for (const finding of result.findings) {
    expect(finding.id).toMatch(/^finding-[a-f0-9]{32}$/);
    expect(finding).toEqual(expect.objectContaining({ detectedAt, ruleVersion: '1.0.0', recommendedAction: expect.any(String), explanation: expect.any(String) }));
  }
  const later = evaluateCompliance({ ...inputs, detectedAt: '2026-10-27T00:00:00.000Z' });
  expect(later.findings.map(({ id }) => id)).toEqual(result.findings.map(({ id }) => id));
  expect(later.summary).toEqual(result.summary);
});

test('findings contain no names or APAAR values and no foreign institution programme references', () => {
  const inputs = fixture([student(1, { programmeId: 'DEMO-PROG-002' })]);
  const result = evaluateCompliance(inputs);
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain('Fictional Demo Learner');
  expect(serialized).not.toContain('"apaarId"');
  expect(serialized).not.toContain('DEMO-PROG-002');
});
