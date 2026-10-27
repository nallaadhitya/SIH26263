const fs = require('node:fs/promises');
const path = require('node:path');
const request = require('supertest');
const { JsonStore } = require('../storage/json-store');
const { createApp } = require('../server');
const { seedDemoAccounts } = require('../scripts/seed-accounts');
const { seedDemoData } = require('../scripts/seed-demo');
const { SigningKeys, ISSUER, LIFETIME_SECONDS, sign } = require('../verification/crypto');
const { VerificationService } = require('../verification/service');
const { StudentService } = require('../students/service');

const directory = path.resolve(__dirname, '.tmp-verification-api');
const base = '/api/v1/verification';
const password = 'fictional-test-password-only';
const key = Buffer.alloc(32, 23).toString('base64');
const id = '11111111-1111-4111-8111-111111111111';
const foreignId = '22222222-2222-4222-8222-222222222222';
let store; let users; let app; let clock; let session;
const signing = () => new SigningKeys({ keys: { test: key }, activeId: 'test', forbiddenSecrets: [] });
const student = (overrides = {}) => ({ id, apaarId: '000000000091', studentName: 'Fictional QR Learner',
  institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027',
  admissionYear: '2026', admissionCategory: 'general', status: 'active',
  createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z', ...overrides });
async function cleanup() {
  if (path.dirname(directory) !== path.resolve(__dirname) || !path.basename(directory).startsWith('.tmp-verification-')) throw new Error('Unsafe cleanup');
  await fs.rm(directory, { recursive: true, force: true });
}
async function login(email = 'admin@demo.example', target = app) {
  const agent = request.agent(target);
  const csrf = await agent.get('/api/auth/csrf');
  const response = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken).send({ email, password });
  expect(response.status).toBe(200); return { agent, token: response.body.csrfToken };
}
const issue = (body = { studentId: id }, client = session) => client.agent.post(`${base}/issue`).set('X-CSRF-Token', client.token).send(body);
const verify = payload => request(app).post(`${base}/verify`).send({ payload });
const revoke = (artifactId, client = session) => client.agent.post(`${base}/revoke`).set('X-CSRF-Token', client.token).send({ artifactId });

beforeAll(async () => {
  await cleanup(); const seed = new JsonStore({ dataDirectory: directory });
  await seedDemoAccounts({ store: seed, password }); users = await seed.readCollection('users');
});
beforeEach(async () => {
  await cleanup(); store = new JsonStore({ dataDirectory: directory });
  await seedDemoData(store); await store.writeCollection('users', users);
  await store.writeCollection('students', [student(), student({ id: foreignId, institutionId: 'DEMO-INST-002', programmeId: 'DEMO-PROG-002' })]);
  clock = Date.UTC(2026, 9, 27);
  app = createApp({ store, verificationOptions: { signing: signing(), now: () => clock } });
  session = await login();
});
afterAll(cleanup);

test('issues a PNG and private persisted snapshot; public verification exposes status only', async () => {
  const response = await issue(); expect(response.status).toBe(201);
  expect(response.body.qrDataUrl).toMatch(/^data:image\/png;base64,iVBOR/);
  const payload = JSON.parse(response.body.payload);
  expect(Object.keys(payload)).toEqual(['v', 'iss', 'kid', 'aid', 'rev', 'iat', 'exp', 'sig']);
  expect(payload.exp - payload.iat).toBe(LIFETIME_SECONDS);
  const checked = await verify(response.body.payload);
  expect(checked.status).toBe(200);
  expect(checked.body).toEqual({ status: 'valid', integrityValid: true, recordCurrent: true,
    checkedAt: new Date(clock).toISOString(), officialApaarAuthenticity: 'not_verified' });
  expect(checked.headers['cache-control']).toBe('no-store');
  for (const text of [JSON.stringify(response.body), JSON.stringify(checked.body)]) {
    for (const secret of [key, password, id, student().apaarId, student().studentName, 'passwordHash']) expect(text).not.toContain(secret);
  }
  const records = await store.readCollection('verification-records');
  expect(records[0]).toMatchObject({ studentId: id, status: 'active', issuedBy: 'DEMO-USER-ADMIN' });
  expect(JSON.stringify(records)).not.toContain(key);
  expect(JSON.stringify(records)).not.toContain(student().apaarId);
  expect(JSON.stringify(records)).not.toContain(student().studentName);
});

test('tampered, unsigned, unknown and malformed artifacts are invalid without record lookup', async () => {
  const issued = await issue();
  const changed = JSON.parse(issued.body.payload); changed.rev = foreignId;
  const read = jest.spyOn(store, 'readCollection'); read.mockClear();
  for (const payload of [JSON.stringify(changed), '{}', 'not JSON', 'a'.repeat(2049)]) {
    const result = await verify(payload); expect(result.body).toMatchObject({ status: 'invalid', integrityValid: false, recordCurrent: null });
  }
  expect(read).not.toHaveBeenCalled();
  const unknown = { v: 1, iss: ISSUER, kid: 'test', aid: foreignId, rev: id, iat: clock / 1000, exp: clock / 1000 + LIFETIME_SECONDS };
  expect((await verify(sign(unknown, signing()))).body.status).toBe('invalid');
});

test('expiry and idempotent revocation are distinct from a current record', async () => {
  const issued = (await issue()).body;
  clock += LIFETIME_SECONDS * 1000;
  expect((await verify(issued.payload)).body).toMatchObject({ status: 'expired', integrityValid: true, recordCurrent: null });
  expect((await revoke(issued.artifactId)).body.status).toBe('revoked');
  const records = await store.readCollection('verification-records');
  expect((await revoke(issued.artifactId)).status).toBe(200);
  expect(await store.readCollection('verification-records')).toEqual(records);
  expect((await verify(issued.payload)).body).toMatchObject({ status: 'revoked', integrityValid: true, recordCurrent: null });
});

test('API edits and edits restored to original values invalidate older artifacts, including legacy records', async () => {
  const issued = (await issue()).body;
  const patch = body => session.agent.patch(`/api/v1/students/${id}`).set('X-CSRF-Token', session.token).send(body);
  expect((await patch({ studentName: 'Fictional Changed Learner' })).status).toBe(200);
  expect((await verify(issued.payload)).body).toMatchObject({ status: 'outdated', integrityValid: true, recordCurrent: false });
  expect((await patch({ studentName: student().studentName })).status).toBe(200);
  expect((await verify(issued.payload)).body.status).toBe('outdated');
  expect((await verify((await issue()).body.payload)).body.status).toBe('valid');
});

test('no-op edits and audit-only timestamp changes preserve current status; deletion makes outdated', async () => {
  const issued = (await issue()).body;
  expect((await session.agent.patch(`/api/v1/students/${id}`).set('X-CSRF-Token', session.token).send({ studentName: student().studentName })).status).toBe(200);
  expect((await verify(issued.payload)).body.status).toBe('valid');
  await store.updateCollection('students', records => records.map(r => ({ ...r, updatedAt: '2026-10-27T01:00:00Z' })));
  expect((await verify(issued.payload)).body.status).toBe('valid');
  await store.updateCollection('students', records => records.filter(r => r.id !== id));
  expect((await verify(issued.payload)).body.status).toBe('outdated');
});

test('missing keys, malformed keys and unknown active key fail issuance explicitly, without affecting health', async () => {
  for (const config of [{ keys: '' }, { keys: { test: 'bad' } }, { keys: { test: key }, activeId: 'unknown' }]) {
    const target = createApp({ store, verificationOptions: { signing: new SigningKeys(config) } });
    const client = await login('admin@demo.example', target);
    const result = await issue(undefined, client); expect(result.status).toBe(503); expect(JSON.stringify(result.body)).not.toContain(key);
    expect((await request(target).get('/api/health')).status).toBe(200);
    if (config.activeId !== 'unknown') expect((await request(target).post(`${base}/verify`).send({ payload: '{}' })).status).toBe(503);
  }
  expect(await store.readCollection('verification-records', { initialize: false })).toEqual([]);
});

test('unauthenticated issuance, forged cookies and missing or foreign-origin CSRF are denied', async () => {
  expect((await request(app).post(`${base}/issue`).send({ studentId: id })).status).toBe(401);
  expect((await request(app).post(`${base}/issue`).set('Cookie', 'eduverify.sid=forged').send({ studentId: id })).status).toBe(401);
  expect((await session.agent.post(`${base}/issue`).send({ studentId: id })).status).toBe(403);
  expect((await session.agent.post(`${base}/issue`).set('X-CSRF-Token', session.token).set('Origin', 'http://other.example').send({ studentId: id })).status).toBe(403);
});

test.each(['reviewer@demo.example', 'verifier@demo.example'])('%s may verify publicly but cannot issue or revoke', async email => {
  const client = await login(email);
  expect((await issue(undefined, client)).status).toBe(403);
  expect((await revoke(id, client)).status).toBe(403);
  expect((await client.agent.post(`${base}/verify`).send({ payload: '{}' })).body.status).toBe('invalid');
});

test('institution operators may issue; foreign records and revocation attempts reveal no ownership', async () => {
  const operator = await login('operator@demo.example');
  expect((await issue(undefined, operator)).status).toBe(201);
  expect((await issue({ studentId: foreignId })).status).toBe(404);
  expect((await issue({ studentId: id, institutionId: 'DEMO-INST-002' })).status).toBe(400);
  const second = await login('admin2@demo.example');
  const artifact = await issue({ studentId: foreignId }, second);
  expect(artifact.status).toBe(201);
  expect((await revoke(artifact.body.artifactId)).status).toBe(404);
});

test.each([{ status: 'inactive' }, { apaarId: 'bad' }, { programmeId: 'DEMO-PROG-002' }])('invalid/inactive source refuses issuance %#', async change => {
  await store.updateCollection('students', records => records.map(r => r.id === id ? { ...r, ...change } : r));
  expect((await issue()).status).toBe(422);
});

test('duplicates refuse issuance; a valid active record need not have a compliance snapshot', async () => {
  expect((await issue()).status).toBe(201);
  await store.updateCollection('students', records => [...records, student({ id: '33333333-3333-4333-8333-333333333333' })]);
  expect((await issue()).status).toBe(422);
});

test('unknown request fields, path/query overrides and bad IDs are rejected', async () => {
  expect((await issue({ studentId: '../users.json' })).status).toBe(400);
  expect((await issue({ studentId: id, revision: 'client-value' })).status).toBe(400);
  expect((await request(app).post(`${base}/verify?studentId=${id}`).send({ payload: '{}' })).status).toBe(400);
  expect((await request(app).post(`${base}/verify`).send({ artifactId: id })).status).toBe(400);
});

test('public verification is bounded by rate limiting and never logs payloads or secrets', async () => {
  const target = createApp({ store, verificationOptions: { signing: signing(), verificationLimit: 2 } });
  const log = jest.spyOn(console, 'log').mockImplementation(() => {});
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const status of [200, 200, 429]) expect((await request(target).post(`${base}/verify`).send({ payload: key })).status).toBe(status);
    expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
  } finally { log.mockRestore(); error.mockRestore(); }
});

test('concurrent issuance preserves every artifact and legacy collection entry', async () => {
  await store.writeCollection('verification-records', [{ kind: 'legacy', preserved: true }]);
  const results = await Promise.all(Array.from({ length: 4 }, () => issue()));
  expect(results.map(r => r.status)).toEqual([201, 201, 201, 201]);
  expect(new Set(results.map(r => r.body.artifactId)).size).toBe(4);
  expect(await store.readCollection('verification-records')).toHaveLength(5);
  for (const result of results) expect((await verify(result.body.payload)).body.status).toBe('valid');
});

test('queued edits cannot interleave with issuance; account changes during QR generation are rechecked', async () => {
  let entered; let release;
  const rendering = new Promise(resolve => { entered = resolve; });
  const gated = new Promise(resolve => { release = resolve; });
  const service = new VerificationService({ store, signing: signing(), now: () => clock,
    renderQr: async () => { entered(); await gated; return 'test-image'; } });
  const admin = users.find(u => u.email === 'admin@demo.example');
  const issuance = service.issue(admin, { studentId: id });
  await rendering;
  const edit = new StudentService({ store }).save(admin, { studentName: 'Fictional Queued Edit' }, id);
  release(); const artifact = await issuance; await edit;
  expect((await verify(artifact.payload)).body.status).toBe('outdated');
  service.renderQr = async () => { await store.updateCollection('users', rows => rows.map(u => u.id === admin.id ? { ...u, role: 'authorized_verifier' } : u)); return 'test-image'; };
  await expect(service.issue(admin, { studentId: id })).rejects.toMatchObject({ status: 403 });
  expect(await store.readCollection('verification-records')).toHaveLength(1);
});

test('failed artifact writes preserve prior bytes and release no usable artifact; retry succeeds', async () => {
  const issued = (await issue()).body;
  const file = path.join(directory, 'verification-records.json');
  const before = await fs.readFile(file, 'utf8');
  const rename = store.fileSystem.rename;
  store.fileSystem = { ...fs, rename: async (from, to) => { if (to === file) throw new Error('private path/write failure'); return rename(from, to); } };
  const failure = await issue(); expect(failure.status).toBe(500); expect(failure.body).toEqual({ error: 'Internal server error' });
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  expect((await revoke(issued.artifactId)).status).toBe(500);
  expect(await fs.readFile(file, 'utf8')).toBe(before);
  store.fileSystem = fs;
  expect((await issue()).status).toBe(201);
  expect((await verify(issued.payload)).body.status).toBe('valid');
});

test('corrupted JSON and invalid persisted state return service errors rather than valid', async () => {
  const issued = (await issue()).body;
  await store.updateCollection('verification-records', entries => entries.map(entry => ({ ...entry, status: 'unknown' })));
  expect((await verify(issued.payload)).status).toBe(503);
  await fs.writeFile(path.join(directory, 'verification-records.json'), '{bad', 'utf8');
  expect((await verify(issued.payload)).status).toBe(500);
  expect(await fs.readFile(path.join(directory, 'verification-records.json'), 'utf8')).toBe('{bad');
});

test.each(['apaarId', 'studentName', 'institutionId', 'programmeId', 'academicYear', 'admissionYear', 'admissionCategory', 'status'])('changes to %s invalidate signed snapshots', async field => {
  const issued = (await issue()).body;
  await store.updateCollection('students', records => records.map(r => r.id === id ? { ...r, [field]: 'different-fictional-value' } : r));
  expect((await verify(issued.payload)).body).toMatchObject({ status: 'outdated', recordCurrent: false });
});

test('QR rendering failure persists nothing and contains no key or payload in the error response', async () => {
  const target = createApp({ store, verificationOptions: { signing: signing(), renderQr: async () => { throw new Error(`private ${key}`); } } });
  const client = await login('admin@demo.example', target);
  const result = await issue(undefined, client);
  expect(result.status).toBe(500); expect(result.body).toEqual({ error: 'Internal server error' });
  expect(await store.readCollection('verification-records', { initialize: false })).toEqual([]);
});

test('verification waits for queued student writes and cannot report the previous version as current', async () => {
  const issued = (await issue()).body;
  const update = store.updateCollection('students', async records => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return records.map(record => record.id === id ? { ...record, status: 'withdrawn' } : record);
  });
  const result = await verify(issued.payload); await update;
  expect(result.body.status).toBe('outdated');
});
