const { randomUUID } = require('node:crypto');
const { canAccessInstitution, assertCurrentAccess } = require('../auth/policy');
const { FIELDS } = require('../students/validation');
const { fingerprint } = require('./canonical');
const { evaluateCompliance, ENGINE_VERSION } = require('./engine');

class ComplianceError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class ComplianceService {
  constructor({ store, now = Date.now }) {
    this.store = store;
    this.now = now;
  }

  async inputs(institutionId) {
    const [students, institutions, programmes, approvedIntakes] = await Promise.all(
      ['students', 'institutions', 'programmes', 'approved-intakes']
        .map((collection) => this.store.readCollection(collection, { initialize: false })),
    );
    const ownProgrammes = programmes.filter((record) => record?.institutionId === institutionId);
    const ids = new Set(ownProgrammes.map((record) => record.id));
    return { institutionId,
      students: students.filter((record) => record?.institutionId === institutionId)
        .map((record) => Object.fromEntries(['id', ...FIELDS].filter((field) => Object.hasOwn(record, field))
          .map((field) => [field, record[field]]))),
      institutions: institutions.filter((record) => record?.id === institutionId),
      programmes: ownProgrammes,
      approvedIntakes: approvedIntakes.filter((record) => ids.has(record?.programmeId)),
    };
  }

  validateScope(user, values = {}, allowed = []) {
    if (!values || typeof values !== 'object' || Array.isArray(values)
      || Object.keys(values).some((key) => !['institutionId', ...allowed].includes(key))) {
      throw new ComplianceError(400, 'Invalid compliance request fields');
    }
    if (values.institutionId !== undefined && !canAccessInstitution(user, values.institutionId)) {
      throw new ComplianceError(403, 'Access denied');
    }
  }

  async evaluate(user, body = {}) {
    if(this.store.transaction) return this.store.transaction(()=>this.evaluateSnapshot(user,body));
    return this.evaluateSnapshot(user,body);
  }

  async evaluateSnapshot(user, body = {}) {
    this.validateScope(user, body);
    const inputs = await this.inputs(user.institutionId);
    const evaluatedAt = new Date(this.now()).toISOString();
    const result = evaluateCompliance({ ...inputs, detectedAt: evaluatedAt });
    const snapshot = { kind: 'compliance-evaluation', schemaVersion: 1,
      id: randomUUID(), institutionId: user.institutionId,
      evaluatedAt, evaluatedBy: user.id, inputFingerprint: fingerprint(inputs), ...result };
    // One replacement of the existing findings collection; never couple a student
    // write to a second file. Retain only the latest evaluation per institution.
    await this.store.updateCollection('validation-issues', async entries => {
      await assertCurrentAccess(this.store, user, 'compliance:evaluate:own');
      return [...entries.filter(entry => entry?.kind !== snapshot.kind || entry.institutionId !== user.institutionId), snapshot];
    });
    return { ...await this.metadata(snapshot), findings: snapshot.findings };
  }

  async metadata(snapshot) {
    if (!snapshot) return { evaluation: null, stale: true, freshness: 'not_evaluated', summary: null, authenticityVerified: false };
    const currentInputs = await this.inputs(snapshot.institutionId);
    const stale = snapshot.engineVersion !== ENGINE_VERSION || snapshot.inputFingerprint !== fingerprint(currentInputs);
    return { evaluation: { id: snapshot.id, engineVersion: snapshot.engineVersion,
      evaluatedAt: snapshot.evaluatedAt, evaluatedBy: snapshot.evaluatedBy, checkedAt: new Date(this.now()).toISOString() },
    stale, freshness: stale ? 'stale' : 'matches_checked_inputs', summary: snapshot.summary,
    authenticityVerified: false };
  }

  async latest(user) {
    const entries = await this.store.readCollection('validation-issues', { initialize: false });
    return entries.find((entry) => entry?.kind === 'compliance-evaluation' && entry.institutionId === user.institutionId);
  }

  async list(user, query) {
    this.validateScope(user, query, ['page', 'pageSize', 'severity', 'ruleCode', 'kind', 'programmeId', 'academicYear']);
    if (Object.values(query).some((value) => typeof value !== 'string' || value.length > 128)
      || (query.severity && !['info', 'warning', 'critical'].includes(query.severity))
      || (query.kind && !['violation', 'requires_review'].includes(query.kind))) {
      throw new ComplianceError(400, 'Invalid compliance filters');
    }
    const page = query.page === undefined ? 1 : Number(query.page);
    const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new ComplianceError(400, 'Invalid compliance pagination');
    }
    const snapshot = await this.latest(user);
    const findings = (snapshot?.findings || []).filter((finding) =>
      ['severity', 'ruleCode', 'kind', 'programmeId', 'academicYear'].every((key) => !query[key] || finding[key] === query[key]));
    return { ...await this.metadata(snapshot), findings: findings.slice((page - 1) * pageSize, page * pageSize),
      total: findings.length, page, pageSize };
  }

  async detail(user, id, query) {
    this.validateScope(user, query);
    if (!/^finding-[a-f0-9]{32}$/.test(id)) throw new ComplianceError(400, 'Invalid finding ID');
    const snapshot = await this.latest(user);
    const finding = snapshot?.findings.find((entry) => entry.id === id);
    if (!finding) throw new ComplianceError(404, 'Finding not found');
    return { ...await this.metadata(snapshot), finding };
  }

  async summary(user, query) {
    this.validateScope(user, query);
    return this.metadata(await this.latest(user));
  }
}

module.exports = { ComplianceService, ComplianceError };
