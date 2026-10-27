const { CATEGORIES, STATUSES } = require('../students/validation');

const SPECIAL_CATEGORIES = Object.freeze(['nri', 'oci', 'foreign_national', 'supernumerary']);
const ALLOWED_CATEGORIES = Object.freeze([...CATEGORIES, ...SPECIAL_CATEGORIES]);

function validAcademicYear(year) {
  const match = typeof year === 'string' && /^(20\d{2})-(20\d{2})$/.exec(year);
  return Boolean(match && Number(match[2]) === Number(match[1]) + 1);
}

function readCountingPolicy(intake) {
  const policy = intake?.countingPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some((key) => !['includedStatuses', 'categoryTreatment', 'admissionYearRange'].includes(key))
    || !Array.isArray(policy.includedStatuses) || !policy.includedStatuses.length
    || new Set(policy.includedStatuses).size !== policy.includedStatuses.length
    || policy.includedStatuses.some((status) => !STATUSES.includes(status))
    || !policy.categoryTreatment || typeof policy.categoryTreatment !== 'object'
    || Array.isArray(policy.categoryTreatment) || !Object.keys(policy.categoryTreatment).length
    || Object.entries(policy.categoryTreatment).some(([category, treatment]) =>
      !ALLOWED_CATEGORIES.includes(category) || !['counted', 'excluded', 'review'].includes(treatment))) {
    return null;
  }
  const range = policy.admissionYearRange;
  const validRange = range && typeof range === 'object' && !Array.isArray(range)
    && Object.keys(range).length === 2 && /^20\d{2}$/.test(range.min) && /^20\d{2}$/.test(range.max)
    && typeof range.min === 'string' && typeof range.max === 'string' && range.min <= range.max
    && Number(range.max) <= Number(intake.academicYear.slice(0, 4));
  return { ...policy, admissionYearRange: validRange ? range : null };
}

module.exports = { SPECIAL_CATEGORIES, ALLOWED_CATEGORIES, validAcademicYear, readCountingPolicy };
