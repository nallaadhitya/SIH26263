const { createHash } = require('node:crypto');

// Explicit mappings keep SQL identifiers independent of request/source input.
const field = (name, column, type = 'text', optional = false) => ({ name, column, type, optional });
const f = field;
const common = [f('createdAt','created_at','date'), f('updatedAt','updated_at','date')];
const MODELS = {
  institutions: { table: 'institutions', fields: [f('id','id'),f('name','name'),f('city','city'),f('status','status')] },
  programmes: { table: 'programmes', fields: [f('id','id'),f('institutionId','institution_id'),f('name','name'),f('level','level')] },
  'approved-intakes': { table: 'approved_intakes', fields: [f('id','id'),f('programmeId','programme_id'),f('academicYear','academic_year'),f('approvedSeats','approved_seats','number'),f('countingPolicy','counting_policy','json',true)] },
  users: { table: 'users', fields: [f('id','id'),f('displayName','display_name'),f('email','email'),f('passwordHash','password_hash'),f('role','role'),f('institutionId','institution_id','nullable'),f('status','status'),...common] },
  students: { table: 'students', fields: [f('id','id'),f('institutionId','institution_id'),f('programmeId','programme_id'),f('apaarId','apaar_id'),f('studentName','student_name'),f('academicYear','academic_year'),f('admissionYear','admission_year'),f('admissionCategory','admission_category'),f('status','status'),f('verificationRevision','verification_revision','text',true),...common,f('createdBy','created_by'),f('updatedBy','updated_by')] },
  'validation-issues': { table: 'compliance_evaluations', kind: 'compliance-evaluation', fields: [f('id','id'),f('kind','kind'),f('schemaVersion','schema_version','number'),f('institutionId','institution_id'),f('evaluatedAt','evaluated_at','date'),f('evaluatedBy','evaluated_by'),f('inputFingerprint','input_fingerprint'),f('engineVersion','engine_version'),f('summary','summary','json')] },
  'verification-records': { table: 'verification_records', kind: 'verification-artifact', fields: [f('id','id'),f('kind','kind'),f('schemaVersion','schema_version','number'),f('studentId','student_id'),f('institutionId','institution_id'),f('recordVersion','record_version'),f('claims','claims','json'),f('issuedBy','issued_by'),f('issuedAt','issued_at','date'),f('status','status'),f('revokedAt','revoked_at','nullableDate'),f('revokedBy','revoked_by','nullable')] },
};
const json = value => typeof value === 'string' ? JSON.parse(value) : value;
function decode(row, model) {
  return Object.fromEntries(model.fields.flatMap(({ name, column, type, optional }) => {
    const value = row[column];
    if (optional && value === null) return [];
    return [[name, type === 'json' ? json(value) : ['date','nullableDate'].includes(type) && value !== null
      ? new Date(`${value.replace(' ', 'T')}Z`).toISOString() : value]];
  }));
}
function encode(record, model) {
  if(model.kind && record.schemaVersion!==1)throw new TypeError('Unsupported stored schema version');
  if(model===MODELS.students && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.id||''))throw new TypeError('Student UUID required');
  return model.fields.map(({ name, type, optional }) => {
    const value = record[name];
    if (optional && value === undefined) return null;
    if (['nullable','nullableDate'].includes(type) && value === null) return null;
    if (type === 'json') { if (!value || typeof value !== 'object') throw new TypeError('Invalid structured record field'); return JSON.stringify(value); }
    if (type === 'number') { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid numeric record field'); return value; }
    if (['date','nullableDate'].includes(type)) {
      if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new TypeError('Invalid timestamp');
      return new Date(value).toISOString().slice(0,23).replace('T',' ');
    }
    if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Invalid text record field');
    return value;
  });
}
function legacyKey(record) { return createHash('sha256').update(JSON.stringify(record)).digest('hex'); }
function assertNoSecrets(value) {
  const forbidden=[process.env.MYSQL_PASSWORD,process.env.SESSION_SECRET,process.env.ML_SERVICE_KEY].filter(Boolean);
  try{forbidden.push(...Object.values(JSON.parse(process.env.QR_SIGNING_KEYS||'{}')));}catch{/* Invalid QR config is handled by QR issuance. */}
  const walk=item=>{
    if(typeof item==='string' && forbidden.includes(item))throw new TypeError('Secret material cannot be persisted');
    if(item && typeof item==='object')for(const [key,child] of Object.entries(item)){
      if(/^(password|sessionsecret|sessionid|csrftoken|signingkey|qrsigningkeys?|mlservicekey|mysqlpassword)$/i.test(key.replace(/[_-]/g,'')))throw new TypeError('Secret field cannot be persisted');
      walk(child);
    }
  };
  walk(value);
}
module.exports = { MODELS, decode, encode, json, legacyKey, assertNoSecrets };
