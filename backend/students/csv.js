const { parse } = require('csv-parse/sync');
const { TextDecoder } = require('node:util');
const { REQUIRED_FIELDS, FIELDS, MAX_FIELD_LENGTH } = require('./validation');
const { StudentError } = require('./errors');

const MAX_FILE_BYTES = 256 * 1024;
const MAX_ROWS = 500;

function parseCsv(buffer) {
  if (!buffer?.length || buffer.length > MAX_FILE_BYTES) throw new StudentError(413, 'CSV must be nonempty and at most 256 KiB');
  let parsed;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    parsed = parse(text, { bom: true, relax_column_count: true,
      max_record_size: 4096, skip_empty_lines: false });
  } catch {
    throw new StudentError(400, 'Malformed CSV, invalid UTF-8, or record exceeds 4096 characters');
  }
  const headers = parsed.shift();
  if (!headers || new Set(headers).size !== headers.length
    || headers.some((header) => !FIELDS.includes(header))
    || REQUIRED_FIELDS.some((field) => !headers.includes(field))) {
    throw new StudentError(400, 'CSV headers must be unique supported fields and include all required fields');
  }
  if (!parsed.length || parsed.length > MAX_ROWS) throw new StudentError(400, 'CSV must contain 1 to 500 data rows');
  return parsed.map((values, index) => {
    const structuralErrors = [];
    if (values.length !== headers.length) {
      structuralErrors.push({ field: 'row', code: 'column_count', message: 'Column count does not match the header' });
    }
    if (values.some((value) => value.length > MAX_FIELD_LENGTH)) {
      structuralErrors.push({ field: 'row', code: 'field_length', message: `Fields must not exceed ${MAX_FIELD_LENGTH} characters` });
    }
    return { input: Object.fromEntries(headers.map((header, column) => [header, values[column] ?? ''])),
      rowNumber: index + 2, structuralErrors };
  });
}

module.exports = { parseCsv, MAX_FILE_BYTES, MAX_ROWS };
