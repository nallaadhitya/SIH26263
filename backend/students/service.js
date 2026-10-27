const { randomUUID, randomBytes } = require('node:crypto');
const { assertBody, assertScope, reviewRows, FIELDS } = require('./validation');
const { StudentError } = require('./errors');
const { assertCurrentAccess } = require('../auth/policy');

class StudentService {
  constructor({ store, now = Date.now }) {
    this.store = store;
    this.now = now;
    this.previews = new Map();
  }

  async references() {
    const [institutions, programmes] = await Promise.all([
      this.store.readCollection('institutions', { initialize: false }),
      this.store.readCollection('programmes', { initialize: false }),
    ]);
    return { institutions, programmes };
  }

  async list(user, query) {
    const allowed = ['page', 'pageSize', 'programmeId', 'academicYear', 'status', 'institutionId'];
    if (Object.keys(query).some((key) => !allowed.includes(key))
      || Object.values(query).some((value) => typeof value !== 'string' || value.length > 256)) {
      throw new StudentError(400, 'Unsupported filter');
    }
    assertScope(query.institutionId, user);
    const page = query.page === undefined ? 1 : Number(query.page);
    const pageSize = query.pageSize === undefined ? 20 : Number(query.pageSize);
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new StudentError(400, 'Invalid pagination; pageSize must be 1 to 100');
    }
    const records = (await this.store.readCollection('students', { initialize: false }))
      .filter((record) => record.institutionId === user.institutionId
        && ['programmeId', 'academicYear', 'status'].every((key) => !query[key] || record[key] === query[key]));
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return { records: records.slice((page - 1) * pageSize, page * pageSize).map(publicStudent),
      page, pageSize, total: records.length };
  }

  async get(user, id) {
    const record = (await this.store.readCollection('students', { initialize: false }))
      .find((entry) => entry.id === id && entry.institutionId === user.institutionId);
    if (!record) throw new StudentError(404, 'Student record not found');
    return record;
  }

  async save(user, body, id) {
    assertBody(body);
    assertScope(body.institutionId, user);
    let saved;
    await this.store.updateCollection('students', async (existing) => {
      const previous = id ? existing.find((record) => record.id === id && record.institutionId === user.institutionId) : null;
      if (id && !previous) throw new StudentError(404, 'Student record not found');
      const input = id ? { ...Object.fromEntries(FIELDS.map((field) => [field, previous[field]])), ...body } : body;
      const report = reviewRows([{ input, rowNumber: 1 }], user, await this.references(), existing, id);
      if (report.summary.valid !== 1) throw new StudentError(
        report.summary.duplicate || report.summary.conflict ? 409 : 422,
        'Student record requires correction or review', responseReport(report),
      );
      await assertCurrentAccess(this.store, user, 'student:write:own');
      const timestamp = new Date(this.now()).toISOString();
      saved = { ...report.records[0], id: previous?.id || randomUUID(),
        // Activate the private marker on an actual edit, preserving the original
        // creation/import shape. A later edit-back receives another marker.
        ...(previous ? { verificationRevision: FIELDS.every(field => previous[field] === report.records[0][field])
          ? previous.verificationRevision : randomUUID() } : {}),
        createdAt: previous?.createdAt || timestamp, createdBy: previous?.createdBy || user.id,
        updatedAt: timestamp, updatedBy: user.id };
      return id ? existing.map((record) => record.id === id ? saved : record) : [...existing, saved];
    });
    return publicStudent(saved);
  }

  async preview(user, sessionId, rows) {
    const report = reviewRows(rows, user, await this.references(),
      await this.store.readCollection('students', { initialize: false }));
    const result = responseReport(report);
    if (report.summary.valid === report.summary.total) {
      for (const [token, entry] of this.previews) {
        if (entry.expiresAt <= this.now()) this.previews.delete(token);
      }
      // Bound retained import contents to limit memory use, independently of IP limits.
      if (this.previews.size >= 100) throw new StudentError(429, 'Too many pending previews; try again later');
      const token = randomBytes(32).toString('hex');
      const expiresAt = this.now() + 10 * 60 * 1000;
      this.previews.set(token, { rows: structuredClone(rows), userId: user.id,
        institutionId: user.institutionId, sessionId, expiresAt, busy: false });
      return { ...result, previewToken: token, expiresAt: new Date(expiresAt).toISOString() };
    }
    return result;
  }

  async commit(user, sessionId, body) {
    assertBody(body, ['previewToken']);
    const token = body.previewToken;
    const preview = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && this.previews.get(token);
    if (!preview || preview.expiresAt <= this.now() || preview.userId !== user.id
      || preview.institutionId !== user.institutionId || preview.sessionId !== sessionId) {
      throw new StudentError(409, 'Preview is unavailable; create a new preview');
    }
    if (preview.busy) throw new StudentError(409, 'Import is already being committed');
    preview.busy = true;
    let inserted;
    try {
      await this.store.updateCollection('students', async (existing) => {
        const report = reviewRows(preview.rows, user, await this.references(), existing);
        if (report.summary.valid !== report.summary.total) {
          throw new StudentError(409, 'Import changed; create a corrected preview', responseReport(report));
        }
        await assertCurrentAccess(this.store, user, 'student:import:own');
        const timestamp = new Date(this.now()).toISOString();
        inserted = report.records.map((record) => ({ ...record, id: randomUUID(),
          createdAt: timestamp, updatedAt: timestamp, createdBy: user.id, updatedBy: user.id }));
        // One atomic collection replacement: never write one import row at a time.
        return [...existing, ...inserted];
      });
      this.previews.delete(token);
      return { imported: inserted.length };
    } finally {
      preview.busy = false;
    }
  }
}

function publicStudent(record) {
  return Object.fromEntries([...FIELDS, 'id', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']
    .map((field) => [field, record[field]]));
}

function responseReport({ summary, rows }) {
  return { summary, rows, authenticityVerified: false };
}

module.exports = { StudentService, publicStudent };
