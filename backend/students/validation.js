const { StudentError } = require('./errors');
const { canAccessInstitution } = require('../auth/policy');

const REQUIRED_FIELDS = Object.freeze([
  'apaarId', 'studentName', 'institutionId', 'programmeId', 'academicYear', 'admissionYear',
]);
const OPTIONAL_FIELDS = Object.freeze(['admissionCategory', 'status']);
const FIELDS = Object.freeze([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);
const CATEGORIES = Object.freeze(['general', 'obc', 'sc', 'st', 'ews', 'other', 'not_specified']);
const STATUSES = Object.freeze(['active', 'inactive', 'graduated', 'withdrawn']);
const MAX_FIELD_LENGTH = 256;

function assertBody(body, allowed = FIELDS) {
  if (!body || Array.isArray(body) || typeof body !== 'object' || !Object.keys(body).length
    || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw new StudentError(400, 'Invalid request fields');
  }
}

function assertScope(institutionId, user) {
  if (institutionId !== undefined && institutionId !== '' && !canAccessInstitution(user, institutionId)) {
    throw new StudentError(403, 'Access denied');
  }
}

function validateStudent(input, user, references) {
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });
  const record = {};
  for (const field of FIELDS) {
    const value = input[field];
    if (value !== undefined && (typeof value !== 'string' || value.length > MAX_FIELD_LENGTH
      || /[\u0000-\u001f\u007f]/.test(value))) {
      add(field, 'invalid_field', `Must be text of at most ${MAX_FIELD_LENGTH} characters without control characters`);
    }
    record[field] = typeof value === 'string' ? value.trim() : '';
  }
  if (input.institutionId === undefined) record.institutionId = user.institutionId;
  if (!record.admissionCategory) record.admissionCategory = 'not_specified';
  if (!record.status) record.status = 'active';
  for (const field of REQUIRED_FIELDS) {
    if (!record[field]) add(field, 'required', 'Required field');
  }
  if (!/^[0-9]{12}$/.test(record.apaarId)) add('apaarId', 'invalid_format', 'Must be exactly 12 digits stored as text; authenticity is not verified');
  if (!references.institutions.some((institution) => institution.id === record.institutionId)) {
    add('institutionId', 'unknown_institution', 'Unknown institution');
  }
  const programme = references.programmes.find((entry) => entry.id === record.programmeId);
  if (!programme || programme.institutionId !== user.institutionId) {
    add('programmeId', 'invalid_programme', 'Programme must belong to your institution');
  }
  const yearMatch = /^(20[0-9]{2})-(20[0-9]{2})$/.exec(record.academicYear);
  if (!yearMatch || Number(yearMatch[2]) !== Number(yearMatch[1]) + 1) {
    add('academicYear', 'invalid_year', 'Use consecutive years in YYYY-YYYY format (2000-2099)');
  }
  if (!/^20[0-9]{2}$/.test(record.admissionYear)
    || (yearMatch && Number(record.admissionYear) > Number(yearMatch[1]))) {
    add('admissionYear', 'invalid_year', 'Use a four-digit admission year not later than the academic start year');
  }
  if (!CATEGORIES.includes(record.admissionCategory)) add('admissionCategory', 'unsupported_category', 'Unsupported admission category');
  if (!STATUSES.includes(record.status)) add('status', 'unsupported_status', 'Unsupported record status');
  return { record, errors };
}

function sameRecord(left, right) {
  return FIELDS.every((field) => left[field] === right[field]);
}

function reviewRows(rows, user, references, existing, excludeId) {
  const results = rows.map(({ input, rowNumber, structuralErrors = [] }) => {
    assertScope(input.institutionId, user);
    const { record, errors } = validateStudent(input, user, references);
    return { rowNumber, record, errors: [...structuralErrors, ...errors], classification: 'valid' };
  });
  const byApaar = new Map();
  for (const result of results) {
    if (/^[0-9]{12}$/.test(result.record.apaarId)) {
      const group = byApaar.get(result.record.apaarId) || [];
      group.push(result);
      byApaar.set(result.record.apaarId, group);
    }
  }
  for (const result of results) {
    const group = byApaar.get(result.record.apaarId) || [];
    const prior = existing.find((record) => record.id !== excludeId
      && record.institutionId === user.institutionId && record.apaarId === result.record.apaarId);
    const conflict = (prior && !sameRecord(prior, result.record))
      || group.some((entry) => !sameRecord(entry.record, result.record));
    if (group.length > 1 || prior) {
      result.errors.push({ field: 'apaarId', code: conflict ? 'potential_conflict' : 'duplicate',
        message: conflict ? 'Conflicting records require review' : 'Duplicate within this institution or import' });
    }
    result.classification = result.errors.some((error) => !['duplicate', 'potential_conflict'].includes(error.code))
      ? 'invalid' : conflict ? 'conflict' : (group.length > 1 || prior) ? 'duplicate' : 'valid';
  }
  const summary = { total: results.length, valid: 0, invalid: 0, duplicate: 0, conflict: 0 };
  for (const result of results) summary[result.classification] += 1;
  // Responses contain only row positions and static messages, never echoed identifiers.
  return {
    summary,
    rows: results.map(({ rowNumber, classification, errors }) => ({ rowNumber, classification, errors })),
    records: results.map((result) => result.record),
  };
}

module.exports = { REQUIRED_FIELDS, FIELDS, CATEGORIES, STATUSES, MAX_FIELD_LENGTH,
  assertBody, assertScope, reviewRows };
