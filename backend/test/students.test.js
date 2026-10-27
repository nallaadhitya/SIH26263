const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../server');
const { JsonStore } = require('../storage/json-store');
const { seedDemoAccounts } = require('../scripts/seed-accounts');
const { FIELDS } = require('../students/validation');
const { MAX_FILE_BYTES, MAX_ROWS } = require('../students/csv');

const directory = path.resolve(__dirname, '.tmp-students-data');
const base = '/api/v1/students';
const password = randomBytes(20).toString('hex');
const headers = FIELDS.join(',');
let fixtureUsers;
let fixtureInstitutions;
let fixtureProgrammes;
let store;
let app;
let session;

// Synthetic numeric strings are format fixtures only, never official APAAR IDs.
function student(overrides = {}) {
  return { apaarId: '000000000001', studentName: 'Fictional Demo Learner',
    institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001',
    academicYear: '2026-2027', admissionYear: '2026', admissionCategory: 'general',
    status: 'active', ...overrides };
}

function csv(records = [student()]) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return `${headers}\n${records.map((record) => FIELDS.map((field) => quote(record[field])).join(',')).join('\n')}\n`;
}

async function cleanup() {
  if (path.dirname(directory) !== path.resolve(__dirname)) throw new Error('Unsafe test directory');
  await fs.rm(directory, { recursive: true, force: true });
}

async function login(email = 'admin@demo.example', target = app) {
  const agent = request.agent(target);
  const csrf = await agent.get('/api/auth/csrf');
  const response = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken)
    .send({ email, password });
  expect(response.status).toBe(200);
  return { agent, token: response.body.csrfToken };
}

function create(body = student(), client = session) {
  return client.agent.post(base).set('X-CSRF-Token', client.token).send(body);
}

function preview(text = csv(), client = session, filename = 'demo.csv', contentType = 'text/csv') {
  return client.agent.post(`${base}/import/preview`).set('X-CSRF-Token', client.token)
    .attach('file', Buffer.from(text), { filename, contentType });
}

function commit(previewToken, client = session, extra = {}) {
  return client.agent.post(`${base}/import/commit`).set('X-CSRF-Token', client.token)
    .send({ previewToken, ...extra });
}

beforeAll(async () => {
  await cleanup();
  const fixture = new JsonStore({ dataDirectory: directory });
  await seedDemoAccounts({ store: fixture, password });
  fixtureUsers = await fixture.readCollection('users');
  fixtureInstitutions = await fixture.readCollection('institutions');
  fixtureProgrammes = await fixture.readCollection('programmes');
});

beforeEach(async () => {
  await cleanup();
  store = new JsonStore({ dataDirectory: directory });
  await store.writeCollection('users', fixtureUsers);
  await store.writeCollection('institutions', fixtureInstitutions);
  await store.writeCollection('programmes', fixtureProgrammes);
  app = createApp({ store });
  session = await login();
});
afterAll(cleanup);

test('creates, gets and updates a scoped student, preserving leading zeroes and server metadata', async () => {
  const response = await create();
  expect(response.status).toBe(201);
  const saved = response.body.student;
  expect(saved.apaarId).toBe('000000000001');
  expect(saved.createdBy).toBe('DEMO-USER-ADMIN');
  expect(saved.updatedBy).toBe(saved.createdBy);
  expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
  expect(saved.createdAt).toEqual(expect.any(String));
  const get = await session.agent.get(`${base}/${saved.id}`);
  expect(get.status).toBe(200);
  expect(get.body.student).toEqual(saved);
  const operator = await login('operator@demo.example');
  const patch = await operator.agent.patch(`${base}/${saved.id}`).set('X-CSRF-Token', operator.token)
    .send({ studentName: 'Fictional Updated Learner' });
  expect(patch.status).toBe(200);
  expect(patch.body.student.createdBy).toBe('DEMO-USER-ADMIN');
  expect(patch.body.student.updatedBy).toBe('DEMO-USER-OPERATOR');
  expect(patch.body.student.createdAt).toBe(saved.createdAt);
});

test('derives institution and defaults when omitted; list pagination and filters are scoped', async () => {
  const body = student();
  delete body.institutionId;
  delete body.status;
  delete body.admissionCategory;
  const first = await create(body);
  expect(first.status).toBe(201);
  expect(first.body.student.institutionId).toBe('DEMO-INST-001');
  expect(first.body.student.admissionCategory).toBe('not_specified');
  await create(student({ apaarId: '000000000002', status: 'inactive' }));
  const page = await session.agent.get(base).query({ pageSize: 1, page: 2 });
  expect(page.status).toBe(200);
  expect(page.body.total).toBe(2);
  expect(page.body.records).toHaveLength(1);
  const filtered = await session.agent.get(base).query({ status: 'inactive', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027' });
  expect(filtered.body.records).toHaveLength(1);
  expect(filtered.body.records[0].apaarId).toBe('000000000002');
  expect((await session.agent.get(base).query({ pageSize: 101 })).status).toBe(400);
  expect((await session.agent.get(base).query({ page: -1 })).status).toBe(400);
  expect((await session.agent.get(base).query({ arbitraryPath: '../users' })).status).toBe(400);
});

test('missing authentication, invalid sessions, and missing CSRF cannot access student operations', async () => {
  const id = randomUUID();
  for (const url of [base, `${base}/${id}`]) {
    expect((await request(app).get(url)).status).toBe(401);
    expect((await request(app).get(url).set('Cookie', 'eduverify.sid=forged')).status).toBe(401);
  }
  for (const url of [base, `${base}/import/preview`, `${base}/import/commit`]) {
    expect((await request(app).post(url).send({})).status).toBe(401);
    expect((await session.agent.post(url).send({})).status).toBe(403);
  }
  expect((await request(app).patch(`${base}/${id}`).send({})).status).toBe(401);
});

test.each(['reviewer@demo.example', 'verifier@demo.example'])(
  '%s cannot list, retrieve, create, update, preview, or commit students', async (email) => {
    const saved = (await create()).body.student;
    const client = await login(email);
    expect((await client.agent.get(base)).status).toBe(403);
    expect((await client.agent.get(`${base}/${saved.id}`)).status).toBe(403);
    expect((await create(student(), client)).status).toBe(403);
    expect((await client.agent.patch(`${base}/${saved.id}`).set('X-CSRF-Token', client.token)
      .send({ studentName: 'Other' })).status).toBe(403);
    expect((await preview(csv(), client)).status).toBe(403);
    expect((await commit('a'.repeat(64), client)).status).toBe(403);
  },
);

test('institution operator can create, read, update, preview and commit own records', async () => {
  const operator = await login('operator@demo.example');
  const saved = await create(student(), operator);
  expect(saved.status).toBe(201);
  expect((await operator.agent.get(`${base}/${saved.body.student.id}`)).status).toBe(200);
  expect((await operator.agent.get(base)).body.total).toBe(1);
  expect((await operator.agent.patch(`${base}/${saved.body.student.id}`).set('X-CSRF-Token', operator.token)
    .send({ status: 'inactive' })).status).toBe(200);
  const report = await preview(csv([student({ apaarId: '000000000002' })]), operator);
  expect(report.status).toBe(200);
  expect((await commit(report.body.previewToken, operator)).status).toBe(201);
});

test('institution isolation resists URL, query, JSON body, and CSV institution tampering', async () => {
  const other = await login('admin2@demo.example');
  const saved = await create(student({ institutionId: 'DEMO-INST-002', programmeId: 'DEMO-PROG-002' }), other);
  expect(saved.status).toBe(201);
  const id = saved.body.student.id;
  expect((await session.agent.get(`${base}/${id}`)).status).toBe(404);
  expect((await session.agent.patch(`${base}/${id}`).set('X-CSRF-Token', session.token)
    .send({ institutionId: 'DEMO-INST-001' })).status).toBe(404);
  expect((await session.agent.get(base)).body.total).toBe(0);
  expect((await session.agent.get(base).query({ institutionId: 'DEMO-INST-002' })).status).toBe(403);
  expect((await create(student({ institutionId: 'DEMO-INST-002' }))).status).toBe(403);
  expect((await preview(csv([student({ institutionId: 'DEMO-INST-002' })]))).status).toBe(403);
  const own = (await create()).body.student;
  expect((await session.agent.patch(`${base}/${own.id}`).set('X-CSRF-Token', session.token)
    .send({ institutionId: 'DEMO-INST-002' })).status).toBe(403);
  expect((await other.agent.get(`${base}/${own.id}`)).status).toBe(404);
  expect((await other.agent.get(base)).body.total).toBe(1);
});

test.each([
  ['missing name', { studentName: '' }], ['missing APAAR', { apaarId: undefined }],
  ['numeric APAAR', { apaarId: 1 }], ['eleven digits', { apaarId: '00000000001' }],
  ['non-digits', { apaarId: 'DEMO-APAAR-1' }], ['unknown programme', { programmeId: 'UNKNOWN' }],
  ['other institution programme', { programmeId: 'DEMO-PROG-002' }],
  ['invalid year', { academicYear: '2026-2028' }], ['future admission', { admissionYear: '2027' }],
  ['unsupported category', { admissionCategory: 'unsupported' }], ['unsupported status', { status: 'approved' }],
  ['long field', { studentName: 'a'.repeat(257) }], ['control character', { studentName: 'bad\u0000name' }],
])('rejects invalid student fields: %s', async (label, override) => {
  const response = await create(student(override));
  expect(response.status).toBe(422);
  expect(response.body.details.summary.invalid).toBe(1);
  expect((await store.readCollection('students')).length).toBe(0);
});

test('rejects unknown institution, body properties and malformed path parameters', async () => {
  expect((await create(student({ institutionId: 'UNKNOWN' }))).status).toBe(403);
  expect((await create(student({ institutionId: '' }))).status).toBe(422);
  expect((await create(student({ createdBy: 'attacker' }))).status).toBe(400);
  expect((await create([])).status).toBe(400);
  expect((await session.agent.get(`${base}/not-a-uuid`)).status).toBe(400);
  expect((await session.agent.get(`${base}/${randomUUID()}`)).status).toBe(404);
});

test('duplicate and conflicting creates are rejected without overwriting records', async () => {
  const saved = (await create()).body.student;
  const duplicate = await create();
  expect(duplicate.status).toBe(409);
  expect(duplicate.body.details.summary.duplicate).toBe(1);
  const conflict = await create(student({ studentName: 'Fictional Different Learner' }));
  expect(conflict.status).toBe(409);
  expect(conflict.body.details.summary.conflict).toBe(1);
  expect((await store.readCollection('students'))).toEqual([saved]);
  const other = await create(student({ apaarId: '000000000002' }));
  const patch = await session.agent.patch(`${base}/${other.body.student.id}`).set('X-CSRF-Token', session.token)
    .send({ apaarId: saved.apaarId });
  expect(patch.status).toBe(409);
});

test('duplicate checking reveals nothing about other institutions', async () => {
  const other = await login('admin2@demo.example');
  expect((await create(student({ institutionId: 'DEMO-INST-002', programmeId: 'DEMO-PROG-002' }), other)).status).toBe(201);
  expect((await create()).status).toBe(201);
});

test('concurrent creates enforce uniqueness inside the shared collection queue', async () => {
  const responses = await Promise.all([create(), create()]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
  expect(await store.readCollection('students')).toHaveLength(1);
});

test('preview creates no collection and invokes no storage writes', async () => {
  const write = jest.spyOn(store, 'writeCollection');
  const update = jest.spyOn(store, 'updateCollection');
  const atomic = jest.spyOn(store, '_atomicWrite');
  const response = await preview();
  expect(response.status).toBe(200);
  expect(response.body.summary).toEqual({ total: 1, valid: 1, invalid: 0, duplicate: 0, conflict: 0 });
  expect(response.body.authenticityVerified).toBe(false);
  expect(response.body.rows[0].rowNumber).toBe(2);
  expect(write).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
  expect(atomic).not.toHaveBeenCalled();
  await expect(fs.access(path.join(directory, 'students.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('quoted commas and quotes, BOM and CRLF are parsed, and bulk commit writes once', async () => {
  const text = `\ufeff${csv([student({ studentName: 'Fictional, "Demo" Learner' }), student({ apaarId: '000000000002' })])}`.replaceAll('\n', '\r\n');
  const report = await preview(text);
  expect(report.status).toBe(200);
  expect(report.body.summary.valid).toBe(2);
  // Preinitialize to count the collection replacement rather than initialization.
  await store.readCollection('students');
  const atomic = jest.spyOn(store, '_atomicWrite');
  const response = await commit(report.body.previewToken);
  expect(response.status).toBe(201);
  expect(response.body.imported).toBe(2);
  expect(atomic).toHaveBeenCalledTimes(1);
  const records = await store.readCollection('students');
  expect(records[0].studentName).toBe('Fictional, "Demo" Learner');
  expect(records.every((record) => record.createdBy === 'DEMO-USER-ADMIN')).toBe(true);
});

test('duplicate, conflicting, invalid and existing rows are classified; no token or partial import is allowed', async () => {
  await create();
  const report = await preview(csv([
    student(), student({ apaarId: '000000000002' }), student({ apaarId: '000000000002' }),
    student({ apaarId: '000000000003' }), student({ apaarId: '000000000003', studentName: 'Fictional Other' }),
    student({ apaarId: 'bad' }), student({ apaarId: '000000000004' }),
  ]));
  expect(report.status).toBe(200);
  expect(report.body.summary).toEqual({ total: 7, valid: 1, invalid: 1, duplicate: 3, conflict: 2 });
  expect(report.body.previewToken).toBeUndefined();
  expect((await commit('a'.repeat(64))).status).toBe(409);
  expect(await store.readCollection('students')).toHaveLength(1);
});

test('blank rows, extra columns, unknown references, multiline and long fields are reported rather than discarded', async () => {
  const valid = csv().trim();
  const blank = await preview(`${valid}\n\n`);
  expect(blank.body.summary.invalid).toBe(1);
  expect(blank.body.summary.total).toBe(2);
  const extra = await preview(`${valid},extra\n`);
  expect(extra.body.summary.invalid).toBe(1);
  const report = await preview(csv([
    student({ programmeId: 'UNKNOWN' }), student({ apaarId: '000000000002', studentName: 'a'.repeat(257) }),
    student({ apaarId: '000000000003', studentName: 'Fictional\nMultiline' }),
    student({ apaarId: '000000000004', institutionId: '' }),
  ]));
  expect(report.body.summary.invalid).toBe(4);
  expect(report.body.previewToken).toBeUndefined();
});

test.each([
  ['malformed quoting', `${headers}\n"unclosed`],
  ['duplicate headers', `apaarId,apaarId\n1,2`],
  ['missing headers', 'apaarId,studentName\n000000000001,Fictional'],
  ['unexpected headers', `${headers},passwordHash\n`],
  ['no data', `${headers}\n`],
])('rejects structurally unusable CSV: %s', async (label, text) => {
  expect((await preview(text)).status).toBe(400);
});

test('upload type, file count, field name, UTF-8, file size and row limits are enforced', async () => {
  expect((await preview(csv(), session, 'demo.txt', 'text/plain')).status).toBe(415);
  expect((await preview('x'.repeat(MAX_FILE_BYTES + 1))).status).toBe(413);
  const manyRows = csv(Array.from({ length: MAX_ROWS + 1 }, (_, index) => student({ apaarId: String(index).padStart(12, '0') })));
  expect((await preview(manyRows)).status).toBe(400);
  expect((await session.agent.post(`${base}/import/preview`).set('X-CSRF-Token', session.token)).status).toBe(400);
  expect((await session.agent.post(`${base}/import/preview`).set('X-CSRF-Token', session.token)
    .attach('wrongField', Buffer.from(csv()), { filename: 'demo.csv', contentType: 'text/csv' })).status).toBe(400);
  expect((await session.agent.post(`${base}/import/preview`).set('X-CSRF-Token', session.token)
    .attach('file', Buffer.from([0xff, 0xfe]), { filename: 'demo.csv', contentType: 'text/csv' })).status).toBe(400);
  expect((await session.agent.post(`${base}/import/preview`).set('X-CSRF-Token', session.token)
    .attach('file', Buffer.from(csv()), { filename: 'demo.csv', contentType: 'text/csv' })
    .attach('file', Buffer.from(csv()), { filename: 'demo2.csv', contentType: 'text/csv' })).status).toBe(400);
});

test('commit revalidates against records created after preview and imports nothing on conflict', async () => {
  const report = await preview(csv([student(), student({ apaarId: '000000000002' })]));
  await create();
  const response = await commit(report.body.previewToken);
  expect(response.status).toBe(409);
  expect(response.body.details.summary.duplicate).toBe(1);
  expect(await store.readCollection('students')).toHaveLength(1);
});

test('commit revalidates programme references changed after preview', async () => {
  const report = await preview();
  await store.writeCollection('programmes', []);
  expect((await commit(report.body.previewToken)).status).toBe(409);
  expect(await store.readCollection('students')).toEqual([]);
});

test.each([
  ['reviewer role', { role: 'regulatory_reviewer' }, 403],
  ['inactive status', { status: 'inactive' }, 401],
  ['changed institution', { institutionId: 'DEMO-INST-002' }, 409],
])('commit rejects changed permissions: %s', async (label, changes, status) => {
  const report = await preview();
  await store.updateCollection('users', (users) => users.map((user) => user.id === 'DEMO-USER-ADMIN' ? { ...user, ...changes } : user));
  expect((await commit(report.body.previewToken)).status).toBe(status);
  expect(await store.readCollection('students')).toEqual([]);
});

test('preview tokens reject another user, another session, fabricated results and expired previews', async () => {
  const report = await preview();
  const operator = await login('operator@demo.example');
  expect((await commit(report.body.previewToken, operator)).status).toBe(409);
  const anotherSession = await login();
  expect((await commit(report.body.previewToken, anotherSession)).status).toBe(409);
  expect((await commit(report.body.previewToken, session, { records: [student()] })).status).toBe(400);
  expect((await commit('forged')).status).toBe(409);
  let now = Date.now();
  const target = createApp({ store, studentOptions: { now: () => now } });
  const client = await login('admin@demo.example', target);
  const expiring = await preview(csv(), client);
  now += 10 * 60 * 1000 + 1;
  expect((await commit(expiring.body.previewToken, client)).status).toBe(409);
});

test('concurrent duplicate commits and different previews cannot create duplicate records', async () => {
  const first = await preview();
  const second = await preview();
  const responses = await Promise.all([
    commit(first.body.previewToken), commit(first.body.previewToken), commit(second.body.previewToken),
  ]);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
  expect((await commit(first.body.previewToken)).status).toBe(409);
  expect(await store.readCollection('students')).toHaveLength(1);
});

test('failed atomic bulk write preserves the prior file and permits safe retry without partial records', async () => {
  await create();
  const original = await fs.readFile(path.join(directory, 'students.json'), 'utf8');
  const report = await preview(csv([student({ apaarId: '000000000002' }), student({ apaarId: '000000000003' })]));
  const rename = jest.spyOn(store.fileSystem, 'rename').mockRejectedValueOnce(new Error('Sensitive path must never escape'));
  try {
    const failed = await commit(report.body.previewToken);
    expect(failed.status).toBe(500);
    expect(failed.body).toEqual({ error: 'Internal server error' });
    expect(await fs.readFile(path.join(directory, 'students.json'), 'utf8')).toBe(original);
    expect((await fs.readdir(directory)).some((file) => file.endsWith('.tmp'))).toBe(false);
    expect((await commit(report.body.previewToken)).status).toBe(201);
    expect(await store.readCollection('students')).toHaveLength(3);
  } finally {
    rename.mockRestore();
  }
});

test('student API responses omit sensitive internal fields and errors never echo APAAR IDs or paths', async () => {
  const saved = (await create()).body.student;
  await store.updateCollection('students', (records) => records.map((record) => ({ ...record, passwordHash: 'private', session: 'private' })));
  const response = await session.agent.get(`${base}/${saved.id}`);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.student).not.toHaveProperty('passwordHash');
  expect(response.body.student).not.toHaveProperty('session');
  expect((await session.agent.get(base)).body.records[0]).not.toHaveProperty('passwordHash');
  const duplicate = await create();
  expect(JSON.stringify(duplicate.body)).not.toContain(saved.apaarId);
  await fs.writeFile(path.join(directory, 'students.json'), '{broken');
  const error = await session.agent.get(base);
  expect(error.status).toBe(500);
  expect(error.body).toEqual({ error: 'Internal server error' });
  expect(await fs.readFile(path.join(directory, 'students.json'), 'utf8')).toBe('{broken');
});

test('import preview and commit share an enforced rate limit', async () => {
  const target = createApp({ store, studentOptions: { importLimit: 2 } });
  const client = await login('admin@demo.example', target);
  expect((await preview(csv(), client)).status).toBe(200);
  expect((await preview(csv(), client)).status).toBe(200);
  expect((await commit('a'.repeat(64), client)).status).toBe(429);
});
