const { evaluateCompliance } = require('../compliance/engine');
const { validAcademicYear } = require('../compliance/intake-policy');
const { fingerprint } = require('../compliance/canonical');

const FEATURE_VERSION = 'aggregate-features-1.0.0';

function buildFeatures(inputs) {
  const owned = new Set(inputs.programmes.map((programme) => programme.id));
  const groups = new Map();
  let skippedRecords = 0;
  for (const record of inputs.students) {
    if (!owned.has(record.programmeId) || !validAcademicYear(record.academicYear)) {
      skippedRecords += 1;
      continue;
    }
    const key = JSON.stringify([record.programmeId, record.academicYear]);
    if (!groups.has(key)) groups.set(key, { programmeId: record.programmeId, academicYear: record.academicYear, records: [] });
    groups.get(key).records.push(record);
  }
  // Reuse Phase 4's approved counting methodology, not its finding/severity labels.
  const counts = evaluateCompliance({ ...inputs, detectedAt: 'feature-extraction' }).summary.intakeComparisons;
  const readyCount = (entry) => entry && entry.countedEnrolment !== null && entry.unresolvedRecords === 0;
  const policyFor = (programmeId, year) => inputs.approvedIntakes.find((entry) => entry.programmeId === programmeId && entry.academicYear === year)?.countingPolicy;
  const output = [...groups.values()].sort((left, right) =>
    left.programmeId.localeCompare(right.programmeId) || left.academicYear.localeCompare(right.academicYear))
    .map((group) => {
      const active = group.records.filter((record) => record.status === 'active');
      const current = counts.find((entry) => entry.programmeId === group.programmeId && entry.academicYear === group.academicYear);
      const start = Number(group.academicYear.slice(0, 4));
      const previousYear = `${start - 1}-${start}`;
      const previous = counts.find((entry) => entry.programmeId === group.programmeId && entry.academicYear === previousYear);
      const currentPolicy = policyFor(group.programmeId, group.academicYear);
      const previousPolicy = policyFor(group.programmeId, previousYear);
      const countingBasis = (policy) => policy && ({ includedStatuses: policy.includedStatuses, categoryTreatment: policy.categoryTreatment });
      const comparable = readyCount(current) && readyCount(previous) && previous.countedEnrolment > 0
        && fingerprint(countingBasis(currentPolicy)) === fingerprint(countingBasis(previousPolicy));
      const admissionYears = new Map();
      for (const record of active) admissionYears.set(record.admissionYear, (admissionYears.get(record.admissionYear) || 0) + 1);
      const concentration = active.length && active.every((record) => typeof record.admissionYear === 'string' && /^20\d{2}$/.test(record.admissionYear))
        ? Math.max(...admissionYears.values()) / active.length : null;
      return { programmeId: group.programmeId, academicYear: group.academicYear,
        features: {
          active_record_count: active.length,
          intake_ratio: readyCount(current) && current.approvedSeats > 0 ? current.countedEnrolment / current.approvedSeats : null,
          year_over_year_change: comparable ? (current.countedEnrolment - previous.countedEnrolment) / previous.countedEnrolment : null,
          admission_year_concentration: concentration,
        } };
    });
  return { groups: output, skippedRecords };
}

module.exports = { buildFeatures, FEATURE_VERSION };
