const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('node:async_hooks');
const { COLLECTIONS, UnknownCollectionError } = require('./json-store');
const { MODELS, decode, encode, json, legacyKey, assertNoSecrets } = require('./mysql-model');
const { mysqlConfig } = require('./mysql-config');

class StorageError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
function safeError(error) {
  if (error instanceof StorageError) return error;
  if (error.code === 'ER_DUP_ENTRY') return new StorageError(409, 'Duplicate record conflicts with stored data');
  if (['ER_NO_REFERENCED_ROW','ER_NO_REFERENCED_ROW_2','ER_ROW_IS_REFERENCED','ER_ROW_IS_REFERENCED_2','ER_CHECK_CONSTRAINT_VIOLATED','ER_DATA_TOO_LONG','ER_BAD_NULL_ERROR','ER_TRUNCATED_WRONG_VALUE'].includes(error.code)
    || error instanceof TypeError) return new StorageError(422, 'Stored record fields or references are invalid');
  if (['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT'].includes(error.code)) return new StorageError(503, 'Storage is busy; inspect state before retrying');
  // Preserve domain errors thrown by callbacks without exposing driver messages.
  if (Number.isInteger(error.status) && error.status >= 400 && error.status < 600) return error;
  return new StorageError(503, 'MySQL storage unavailable; inspect state before retrying');
}

class MySqlStore {
  constructor({ config = mysqlConfig(), pool } = {}) {
    this.pool = pool || mysql.createPool(config);
    this.context = new AsyncLocalStorage();
    this.driver = 'mysql';
  }
  assertCollection(name) { if (!COLLECTIONS.includes(name)) throw new UnknownCollectionError(name); }
  connection() { return this.context.getStore()?.connection || this.pool; }
  async ready() {
    const { verifyMigrations } = require('./mysql-migrations');
    await verifyMigrations(this.pool);
  }
  async close() { await this.pool.end(); }
  async transaction(operation, { rollbackOnly = false } = {}) {
    if (this.context.getStore()) return operation();
    let connection;
    try {
      connection = await this.pool.getConnection();
      await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await connection.beginTransaction();
      // One database-wide gate deliberately preserves the prototype's array
      // callback contract across processes, including cross-collection checks.
      const [gate] = await connection.query('SELECT id FROM storage_mutex WHERE id=1 FOR UPDATE');
      if (gate.length !== 1) throw new Error('Missing storage gate');
      const result = await this.context.run({ connection }, operation);
      if (rollbackOnly) await connection.rollback();
      else await connection.commit();
      return result;
    } catch (error) {
      if (connection) await connection.rollback().catch(() => {});
      throw safeError(error);
    } finally { if (connection) connection.release(); }
  }
  async withCollectionLock(name, operation) { this.assertCollection(name); return this.transaction(operation); }
  async readCollection(name) {
    this.assertCollection(name);
    if (MODELS[name]?.kind && !this.context.getStore()) return this.transaction(()=>this.readCollection(name));
    try {
      const model = MODELS[name];
      const result = [];
      if (model) {
        const [rows] = await this.connection().query(`SELECT * FROM ${model.table} ORDER BY position,id${this.context.getStore()?' FOR SHARE':''}`);
        for (const row of rows) {
          const record = decode(row, model);
          if (name === 'validation-issues') {
            const [findings] = await this.connection().execute('SELECT document FROM compliance_findings WHERE evaluation_id=? ORDER BY position,id FOR SHARE', [row.id]);
            record.findings = findings.map(finding => json(finding.document));
          }
          result.push({ position: row.position, record });
        }
      }
      if (!model || model.kind) {
        const [rows] = await this.connection().execute('SELECT document,position FROM legacy_records WHERE collection=? ORDER BY position,record_key', [name]);
        result.push(...rows.map(row => ({ position: row.position, record: json(row.document) })));
      }
      return result.sort((a,b) => a.position-b.position).map(entry => entry.record);
    } catch (error) { throw safeError(error); }
  }
  async writeCollection(name, records) { return this.updateCollection(name, () => records); }
  async updateCollection(name, operation) {
    this.assertCollection(name);
    if (typeof operation !== 'function') throw new TypeError('operation must be a function');
    return this.transaction(async () => {
      const previous = await this.readCollection(name);
      const next = await operation(previous);
      if (!Array.isArray(next)) throw new TypeError('Collection must be an array');
      next.forEach(assertNoSecrets);
      const model = MODELS[name];
      const modeled = model ? next.filter(record => !model.kind || record?.kind === model.kind) : [];
      const ids = modeled.map(record => record?.id);
      if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new TypeError('Unique stable record identifiers required');
      if (model) {
        const [existing] = await this.connection().query(`SELECT id FROM ${model.table}`);
        const currentIds = new Set(existing.map(row => row.id));
        // Remove replaced evaluation envelopes before inserting their successors.
        for (const row of existing) if (!ids.includes(row.id)) await this.connection().execute(`DELETE FROM ${model.table} WHERE id=?`, [row.id]);
        for (const record of modeled) {
          const values = [...encode(record, model), next.indexOf(record)];
          const columns = [...model.fields.map(field => field.column), 'position'];
          if (currentIds.has(record.id)) {
            await this.connection().execute(`UPDATE ${model.table} SET ${columns.slice(1).map(column => `${column}=?`).join(',')} WHERE id=?`, [...values.slice(1), record.id]);
          } else {
            await this.connection().execute(`INSERT INTO ${model.table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, values);
          }
          if (name === 'validation-issues') await this.saveFindings(record);
        }
      }
      if (!model || model.kind) {
        await this.connection().execute('DELETE FROM legacy_records WHERE collection=?', [name]);
        const legacy = next.filter(record => !model || record?.kind !== model.kind);
        const keys = legacy.map(legacyKey);
        if (new Set(keys).size !== keys.length) throw new TypeError('Duplicate legacy records require review');
        for (const record of legacy) await this.connection().execute('INSERT INTO legacy_records (collection,record_key,document,position) VALUES (?,?,?,?)', [name,legacyKey(record),JSON.stringify(record),next.indexOf(record)]);
      }
      return next;
    });
  }
  async saveFindings(evaluation) {
    if (!Array.isArray(evaluation.findings)) throw new TypeError('Findings array required');
    await this.connection().execute('DELETE FROM compliance_findings WHERE evaluation_id=?', [evaluation.id]);
    for (const [position,finding] of evaluation.findings.entries()) {
      const allowed=['id','ruleCode','ruleVersion','severity','kind','explanation','recommendedAction','institutionId','programmeId','academicYear','recordIds','detectedAt'];
      if(!finding || Object.keys(finding).some(key=>!allowed.includes(key)) || finding.institutionId!==evaluation.institutionId
        || !Array.isArray(finding.recordIds) || finding.recordIds.some(id=>typeof id!=='string')
        || !['violation','requires_review'].includes(finding.kind))throw new TypeError('Invalid finding envelope');
      await this.connection().execute('INSERT INTO compliance_findings (evaluation_id,id,rule_code,severity,institution_id,programme_id,academic_year,document,position) VALUES (?,?,?,?,?,?,?,?,?)',
        [evaluation.id,finding.id,finding.ruleCode,finding.severity,finding.institutionId,finding.programmeId,finding.academicYear,JSON.stringify(finding),position]);
    }
  }
}
module.exports = { MySqlStore, StorageError, safeError };
