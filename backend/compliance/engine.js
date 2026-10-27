const { FIELDS, REQUIRED_FIELDS, CATEGORIES, STATUSES, MAX_FIELD_LENGTH } = require('../students/validation');
const { fingerprint, canonical } = require('./canonical');
const { validAcademicYear, readCountingPolicy } = require('./intake-policy');

const ENGINE_VERSION = '1.0.0';
const RULE_VERSION = '1.0.0';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const categoryFor = (record) => record.admissionCategory === undefined || record.admissionCategory === ''
  ? 'not_specified' : typeof record.admissionCategory === 'string' ? record.admissionCategory : '__invalid__';

// Pure evaluation: no filesystem, wall-clock reads, mutations, HTTP, or logging.
// The service supplies the observation timestamp; IDs are stable for a finding.
function evaluateCompliance({ institutionId, students = [], institutions = [], programmes = [],
  approvedIntakes = [], detectedAt }) {
  const records = students.filter((record) => record?.institutionId === institutionId)
    .map((record) => ({ record, invalid: false, duplicate: false }))
    .sort((left, right) => canonical(left.record).localeCompare(canonical(right.record)));
  const ownProgrammes = programmes.filter((programme) => programme?.institutionId === institutionId);
  const programmeIds = new Set(ownProgrammes.map((programme) => programme.id));
  const findings = [];
  const add = (ruleCode, severity, kind, explanation, recommendedAction, context = {}, affected = []) => {
    const recordIds = [...new Set(affected.map(({ record }) => record.id).filter((id) => typeof id === 'string' && UUID.test(id)))].sort();
    const scope = { institutionId,
      programmeId: programmeIds.has(context.programmeId) ? context.programmeId : null,
      academicYear: validAcademicYear(context.academicYear) ? context.academicYear : null,
      recordIds };
    findings.push({ id: `finding-${fingerprint({ ruleCode, ruleVersion: RULE_VERSION, ...scope }).slice(0, 32)}`,
      ruleCode, ruleVersion: RULE_VERSION, severity, kind, explanation, recommendedAction,
      ...scope, detectedAt });
  };
  const flagRecord = (state, code, explanation) => {
    state.invalid = true;
    add(code, 'warning', 'violation', explanation, 'Correct the stored record and run evaluation again.', state.record, [state]);
  };

  if (!institutions.some((institution) => institution?.id === institutionId)) {
    add('REFERENCE_INSTITUTION_INVALID', 'critical', 'violation', 'The evaluated institution is absent from reference data.',
      'Restore the institution reference before interpreting capacity results.', {}, records);
    records.forEach((state) => { state.invalid = true; });
  }
  for (const state of records) {
    const record = state.record;
    if (typeof record.id !== 'string' || !UUID.test(record.id)
      || REQUIRED_FIELDS.some((field) => typeof record[field] !== 'string' || !record[field].trim())
      || FIELDS.some((field) => record[field] !== undefined && (typeof record[field] !== 'string'
        || record[field].length > MAX_FIELD_LENGTH || /[\u0000-\u001f\u007f]/.test(record[field])))) {
      flagRecord(state, 'REQUIRED_FIELD_INVALID', 'A required field is missing, or a field has an invalid type, length, or control character.');
    }
    if (typeof record.apaarId !== 'string' || !/^[0-9]{12}$/.test(record.apaarId)) {
      flagRecord(state, 'APAAR_FORMAT_INVALID', 'APAAR must be a 12-digit string; format does not authenticate identity.');
    }
    if (!programmeIds.has(record.programmeId)) {
      flagRecord(state, 'REFERENCE_PROGRAMME_INVALID', 'The programme is unknown or does not belong to the evaluated institution.');
    }
    if (!validAcademicYear(record.academicYear)) {
      flagRecord(state, 'ACADEMIC_YEAR_INVALID', 'Academic year must contain consecutive years between 2000 and 2099.');
    }
    if (typeof record.admissionYear !== 'string' || !/^20\d{2}$/.test(record.admissionYear)
      || (validAcademicYear(record.academicYear) && record.admissionYear > record.academicYear.slice(0, 4))) {
      flagRecord(state, 'ADMISSION_YEAR_INVALID', 'Admission year is malformed or later than the academic start year.');
    }
    if (!STATUSES.includes(record.status)) flagRecord(state, 'RECORD_STATUS_INVALID', 'Record status is missing or unsupported.');
  }

  const duplicates = new Map();
  for (const state of records) {
    if (typeof state.record.apaarId !== 'string' || !/^[0-9]{12}$/.test(state.record.apaarId)) continue;
    const group = duplicates.get(state.record.apaarId) || [];
    group.push(state);
    duplicates.set(state.record.apaarId, group);
  }
  for (const group of duplicates.values()) {
    if (group.length < 2) continue;
    const signatures = new Set(group.map(({ record }) => canonical(Object.fromEntries(FIELDS.map((field) => [field, record[field]])))));
    group.forEach((state) => { state.duplicate = true; });
    const conflict = signatures.size > 1;
    add(conflict ? 'APAAR_CONFLICT' : 'APAAR_DUPLICATE', conflict ? 'critical' : 'warning',
      conflict ? 'requires_review' : 'violation',
      conflict ? 'Multiple institution records share an APAAR value but contain conflicting fields.' : 'Repeated institution records share an APAAR value and matching fields.',
      'Review and reconcile the records; no automatic overwrite or fraud determination is made.', {}, group);
  }

  // Include configured programme/year combinations even if they have zero records.
  const groups = new Map();
  const groupFor = (programmeId, academicYear) => {
    const key = JSON.stringify([programmeId, academicYear]);
    if (!groups.has(key)) groups.set(key, { programmeId, academicYear, states: [], intakes: [] });
    return groups.get(key);
  };
  for (const state of records) {
    if (programmeIds.has(state.record.programmeId) && validAcademicYear(state.record.academicYear)) {
      groupFor(state.record.programmeId, state.record.academicYear).states.push(state);
    }
  }
  for (const intake of approvedIntakes) {
    if (programmeIds.has(intake?.programmeId) && validAcademicYear(intake.academicYear)) {
      groupFor(intake.programmeId, intake.academicYear).intakes.push(intake);
    } else if (programmeIds.has(intake?.programmeId)) {
      add('INTAKE_REFERENCE_REVIEW', 'warning', 'requires_review',
        'An intake reference has a malformed academic year and cannot be matched safely.',
        'Correct the intake academic year before comparing enrolment.', { programmeId: intake.programmeId },
        records.filter(({ record }) => record.programmeId === intake.programmeId));
    }
  }

  const intakeComparisons = [];
  for (const group of [...groups.values()].sort((left, right) => canonical(left).localeCompare(canonical(right)))) {
    const { states, intakes } = group;
    const context = { programmeId: group.programmeId, academicYear: group.academicYear };
    const intake = intakes.length === 1 ? intakes[0] : null;
    const capacityValid = intake && Number.isSafeInteger(intake.approvedSeats) && intake.approvedSeats >= 0;
    const policy = capacityValid ? readCountingPolicy(intake) : null;
    const comparison = { institutionId, ...context, observedRecords: states.length,
      countedEnrolment: null, excludedRecords: 0, unresolvedRecords: states.length,
      approvedSeats: capacityValid ? intake.approvedSeats : null, comparison: 'requires_review' };
    if (!capacityValid) {
      add('INTAKE_REFERENCE_REVIEW', 'warning', 'requires_review',
        'Exactly one matching intake with a nonnegative integer approvedSeats is required.',
        'Supply or reconcile programme/year intake reference data.', context, states);
    } else if (!policy) {
      add('INTAKE_POLICY_REVIEW', 'warning', 'requires_review',
        'Intake capacity exists but its counting policy is absent or invalid.',
        'Configure includedStatuses and categoryTreatment from an approved policy.', context, states);
    }

    for (const state of states) {
      const category = categoryFor(state.record);
      const configured = policy && Object.hasOwn(policy.categoryTreatment, category);
      if (!CATEGORIES.includes(category) && !configured) {
        flagRecord(state, 'ADMISSION_CATEGORY_UNSUPPORTED', 'The admission category is unsupported by application or intake reference data.');
      }
    }
    if (policy) {
      if (!policy.admissionYearRange) {
        add('ADMISSION_POLICY_REVIEW', 'info', 'requires_review',
          'No valid explicit admission-year range is configured for this intake.',
          'Confirm applicable admission-year constraints; no additional age-of-admission rule was assumed.', context, states);
      }
      for (const state of states) {
        if (policy.admissionYearRange && typeof state.record.admissionYear === 'string'
          && /^20\d{2}$/.test(state.record.admissionYear)
          && (state.record.admissionYear < policy.admissionYearRange.min || state.record.admissionYear > policy.admissionYearRange.max)) {
          flagRecord(state, 'ADMISSION_YEAR_POLICY_VIOLATION', 'Admission year falls outside the explicitly configured intake range.');
        }
      }
      let counted = 0;
      let excluded = 0;
      const unresolved = [];
      const categoryReview = [];
      for (const state of states) {
        const category = categoryFor(state.record);
        const treatment = Object.hasOwn(policy.categoryTreatment, category) ? policy.categoryTreatment[category] : 'review';
        if (treatment === 'review' && policy.includedStatuses.includes(state.record.status)) categoryReview.push(state);
        if (state.invalid || state.duplicate) { unresolved.push(state); continue; }
        if (!policy.includedStatuses.includes(state.record.status)) { excluded += 1; continue; }
        if (treatment === 'review') { unresolved.push(state); continue; }
        if (treatment === 'excluded') { excluded += 1; continue; }
        counted += 1;
      }
      if (categoryReview.length) {
        add('CATEGORY_POLICY_REVIEW', 'warning', 'requires_review',
          'Admission-category counting or special-seat treatment is unspecified and requires review.',
          'Establish category rules, including any NRI, OCI, foreign-national or supernumerary policy, before counting these records.', context, categoryReview);
      }
      if (unresolved.some((state) => state.invalid || state.duplicate)) {
        add('INTAKE_COUNT_REVIEW', 'warning', 'requires_review',
          'Invalid or duplicate/conflicting records prevent a complete enrolment count.',
          'Reconcile record findings before interpreting intake totals.', context, unresolved);
      }
      comparison.countedEnrolment = counted;
      comparison.excludedRecords = excluded;
      comparison.unresolvedRecords = unresolved.length;
      comparison.comparison = counted > intake.approvedSeats ? 'exceeded'
        : unresolved.length ? 'requires_review' : 'not_exceeded';
      if (counted > intake.approvedSeats) {
        add('INTAKE_EXCEEDED', 'critical', 'violation',
          `Counted enrolment (${counted}) exceeds configured approved seats (${intake.approvedSeats}).`,
          'Review the institution programme/year intake and reconcile enrolment; this finding does not establish fraud.', context, states);
      }
    } else if (states.some(({ record }) => !CATEGORIES.includes(categoryFor(record)))) {
      add('CATEGORY_POLICY_REVIEW', 'warning', 'requires_review',
        'Special or unsupported admission categories lack an applicable counting policy.',
        'Confirm category-specific policy; no shared quota or exemption was assumed.', context, states);
    }
    intakeComparisons.push(comparison);
  }

  // Records with invalid programme/year still receive category validation.
  for (const state of records) {
    if ((!programmeIds.has(state.record.programmeId) || !validAcademicYear(state.record.academicYear))
      && !CATEGORIES.includes(categoryFor(state.record))) {
      flagRecord(state, 'ADMISSION_CATEGORY_UNSUPPORTED', 'The admission category is unsupported by application reference data.');
      add('CATEGORY_POLICY_REVIEW', 'warning', 'requires_review',
        'Applicable category policy cannot be established for this invalid programme/year reference.',
        'Correct programme/year references and confirm category-specific policy.', state.record, [state]);
    }
  }
  const uniqueFindings = [...new Map(findings.map((finding) => [finding.id, finding])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
  const findingsBySeverity = { info: 0, warning: 0, critical: 0 };
  const findingsByRule = {};
  for (const finding of uniqueFindings) {
    findingsBySeverity[finding.severity] += 1;
    findingsByRule[finding.ruleCode] = (findingsByRule[finding.ruleCode] || 0) + 1;
  }
  const flaggedIds = new Set(uniqueFindings.flatMap((finding) => finding.recordIds));
  return { engineVersion: ENGINE_VERSION, findings: uniqueFindings,
    summary: { totalRecordsEvaluated: records.length,
      recordsWithNoFindings: records.filter(({ record }) => typeof record.id === 'string' && UUID.test(record.id) && !flaggedIds.has(record.id)).length,
      findingsBySeverity, findingsByRule,
      manualReviewItems: uniqueFindings.filter((finding) => finding.kind === 'requires_review').length,
      violations: uniqueFindings.filter((finding) => finding.kind === 'violation').length,
      intakeComparisons, overIntake: intakeComparisons.filter((comparison) => comparison.comparison === 'exceeded') },
    authenticityVerified: false };
}

module.exports = { evaluateCompliance, ENGINE_VERSION, RULE_VERSION };
