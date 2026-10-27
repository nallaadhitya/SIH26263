const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const request = require('supertest');
const { createApp } = require('../server');
const { JsonStore } = require('../storage/json-store');
const { seedDemoAccounts } = require('../scripts/seed-accounts');
const { seedDemoData } = require('../scripts/seed-demo');
const { MlClient, MlError, MODEL_VERSION } = require('../ml/client');

const directory = path.resolve(__dirname, '.tmp-ml-data');
const base = '/api/v1/ml/evaluate';
const password = randomBytes(20).toString('hex');
let users;
let store;
let app;
let session;
let fetchImpl;
let fakeClient;

function student(overrides = {}) {
  return { id: randomUUID(), apaarId: '000000000001', studentName: 'Fictional ML Learner',
    institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027',
    admissionYear: '2026', admissionCategory: 'general', status: 'active', ...overrides };
}
async function cleanup() {
  if (path.dirname(directory) !== path.resolve(__dirname)) throw new Error('Unsafe test directory');
  await fs.rm(directory, { recursive: true, force: true });
}
async function login(email = 'admin@demo.example', target = app) {
  const agent = request.agent(target);
  const csrf = await agent.get('/api/auth/csrf');
  const result = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken).send({ email, password });
  expect(result.status).toBe(200);
  return { agent, token: result.body.csrfToken };
}
function evaluate(body = {}, client = session) {
  return client.agent.post(base).set('X-CSRF-Token', client.token).send(body);
}

beforeAll(async () => {
  await cleanup();
  const seed = new JsonStore({ dataDirectory: directory });
  await seedDemoAccounts({ store: seed, password });
  users = await seed.readCollection('users');
});
beforeEach(async () => {
  await cleanup();
  store = new JsonStore({ dataDirectory: directory });
  await seedDemoData(store);
  await store.writeCollection('users', users);
  await store.writeCollection('students', [student(), student({ institutionId: 'DEMO-INST-002', programmeId: 'DEMO-PROG-002' })]);
  fetchImpl = jest.fn(async (url, options) => {
    const { records } = JSON.parse(options.body);
    return Response.json({ model_version: MODEL_VERSION, source: 'ml_anomaly', threshold: 0.6,
      results: records.map((record, index) => ({ index, anomaly_score: 0.4, review_flag: false,
        missing_features: ['intake_ratio', 'year_over_year_change', 'admission_year_concentration'].filter((key) => record[key] === null) })) });
  });
  fakeClient = new MlClient({ key: randomBytes(32).toString('hex'), fetchImpl });
  app = createApp({ store, mlOptions: { client: fakeClient } });
  session = await login();
});
afterAll(cleanup);

test('Express sends only scoped numeric aggregates, maps group results locally and writes no findings', async () => {
  const write = jest.spyOn(store, 'updateCollection');
  const response = await evaluate();
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ source: 'ml_anomaly', modelVersion: MODEL_VERSION, stale: false, status: 'evaluated' });
  expect(response.body.results).toHaveLength(1);
  expect(response.body.results[0]).toMatchObject({ institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001', anomalyScore: 0.4, reviewFlag: false });
  const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
  expect(sent.records).toHaveLength(1);
  expect(sent.records[0].active_record_count).toBe(1);
  expect(Object.keys(sent.records[0])).toHaveLength(4);
  for (const forbidden of ['apaarId', 'studentName', 'institutionId', 'programmeId', 'id', 'passwordHash']) {
    expect(sent.records[0]).not.toHaveProperty(forbidden);
  }
  expect(write).not.toHaveBeenCalled();
  await expect(fs.access(path.join(directory, 'validation-issues.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(response.headers['cache-control']).toBe('no-store');
});

test('missing authentication, invalid sessions and CSRF block inference before any Python request', async () => {
  expect((await request(app).post(base).send({})).status).toBe(401);
  expect((await request(app).post(base).set('Cookie', 'eduverify.sid=forged').send({})).status).toBe(401);
  expect((await session.agent.post(base).send({})).status).toBe(403);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each(['reviewer@demo.example', 'verifier@demo.example'])('%s cannot access ML aggregates', async (email) => {
  const denied = await login(email);
  expect((await evaluate({}, denied)).status).toBe(403);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('operator and second institution admin are scoped to their own data', async () => {
  const operator = await login('operator@demo.example');
  expect((await evaluate({}, operator)).status).toBe(200);
  const second = await login('admin2@demo.example');
  const response = await evaluate({}, second);
  expect(response.status).toBe(200);
  expect(response.body.results[0].institutionId).toBe('DEMO-INST-002');
  expect((await evaluate({ institutionId: 'DEMO-INST-002' })).status).toBe(403);
  expect((await evaluate({ programmeId: 'DEMO-PROG-002' })).body.status).toBe('no_data');
});

test('frontend-supplied features, model URLs and query scope overrides are rejected', async () => {
  expect((await evaluate({ records: [] })).status).toBe(400);
  expect((await evaluate({ url: 'http://attacker.example' })).status).toBe(400);
  expect((await session.agent.post(`${base}?institutionId=DEMO-INST-002`).set('X-CSRF-Token', session.token).send({})).status).toBe(400);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test.each([503, 504, 502])('ML failure %i never becomes a normal or empty evaluated result', async (status) => {
  jest.spyOn(fakeClient, 'predict').mockRejectedValueOnce(new MlError(status, 'ML service failed safely'));
  const response = await evaluate();
  expect(response.status).toBe(status);
  expect(response.body).toEqual({ error: 'ML service failed safely' });
});

test('changing source data during inference marks the returned scores stale', async () => {
  const original = fakeClient.predict.bind(fakeClient);
  jest.spyOn(fakeClient, 'predict').mockImplementation(async (records) => {
    const result = await original(records);
    await store.updateCollection('students', (rows) => rows.map((row) => ({ ...row, status: 'inactive' })));
    return result;
  });
  const response = await evaluate();
  expect(response.status).toBe(200);
  expect(response.body.stale).toBe(true);
  expect(response.body.freshness).toBe('stale');
});

test.each([
  [{ status: 'inactive' }, 401], [{ role: 'authorized_verifier' }, 403], [{ institutionId: 'DEMO-INST-002' }, 403],
])('permissions are checked again before releasing results: %j', async (changes, status) => {
  const original = fakeClient.predict.bind(fakeClient);
  jest.spyOn(fakeClient, 'predict').mockImplementation(async (records) => {
    const result = await original(records);
    await store.updateCollection('users', (rows) => rows.map((row) => row.id === 'DEMO-USER-ADMIN' ? { ...row, ...changes } : row));
    return result;
  });
  expect((await evaluate()).status).toBe(status);
});

test('deterministic compliance snapshots and ML results remain separate', async () => {
  await store.updateCollection('approved-intakes', (intakes) => intakes.map((entry) => ({ ...entry, approvedSeats: 0 })));
  const compliance = await session.agent.post('/api/v1/compliance/evaluate').set('X-CSRF-Token', session.token).send({});
  expect(compliance.status).toBe(200);
  expect(compliance.body.summary.findingsByRule.INTAKE_EXCEEDED).toBe(1);
  const original = await fs.readFile(path.join(directory, 'validation-issues.json'), 'utf8');
  const ml = await evaluate();
  expect(ml.status).toBe(200);
  expect(ml.body.source).toBe('ml_anomaly');
  expect(ml.body).not.toHaveProperty('findings');
  expect(await fs.readFile(path.join(directory, 'validation-issues.json'), 'utf8')).toBe(original);
});

test('empty data is explicitly unevaluated and corrupted storage returns safe errors', async () => {
  await store.writeCollection('students', []);
  const empty = await evaluate();
  expect(empty.body).toMatchObject({ status: 'no_data', modelVersion: null, results: [] });
  expect(fetchImpl).not.toHaveBeenCalled();
  await fs.writeFile(path.join(directory, 'students.json'), '{broken');
  const response = await evaluate();
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: 'Internal server error' });
});

test('ML operations are rate limited', async () => {
  const limited = createApp({ store, mlOptions: { client: fakeClient, evaluationLimit: 1 } });
  const client = await login('admin@demo.example', limited);
  expect((await evaluate({}, client)).status).toBe(200);
  expect((await evaluate({}, client)).status).toBe(429);
});
