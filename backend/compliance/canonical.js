const { createHash } = require('node:crypto');

// Input collections have set semantics. Canonicalization ignores object-key and
// collection ordering but preserves repeated entries, so duplicates still matter.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function fingerprint(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

module.exports = { canonical, fingerprint };
