const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const request = require('supertest');
const { JsonStore } = require('../storage/json-store');
const { createApp } = require('../server');
const { seedDemoData, DEMO_RECORDS } = require('../scripts/seed-demo');
const { seedDemoAccounts } = require('../scripts/seed-accounts');

const directory = path.resolve(__dirname, '.tmp-compliance-data');
const base = '/api/v1/compliance';
const password = randomBytes(20).toString('hex');
let fixtureUsers;
let store;
let app;
let client;

function student(overrides = {}) {
  return { id: randomUUID(), apaarId: '000000000001', studentName: 'Fictional Compliance Learner',
    institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027',
    admissionYear: '2026', admissionCategory: 'general', status: 'active',
    createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:00:00.000Z',
    createdBy: 'DEMO-USER-ADMIN', updatedBy: 'DEMO-USER-ADMIN', ...overrides };
}
async function cleanup() {
  if (path.dirname(directory) !== path.resolve(__dirname)) throw new Error('Unsafe test directory');
  await fs.rm(directory, { recursive: true, force: true });
}
async function login(email = 'admin@demo.example', target = app) {
  const agent = request.agent(target);
  const csrf = await agent.get('/api/auth/csrf');
  const response = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken).send({ email, password });
  expect(response.status).toBe(200);
  return { agent, token: response.body.csrfToken };
}
function evaluate(body = {}, session = client) {
  return session.agent.post(`${base}/evaluate`).set('X-CSRF-Token', session.token).send(body);
}

beforeAll(async () => {
  await cleanup();
  const fixtureStore = new JsonStore({ dataDirectory: directory });
  await seedDemoAccounts({ store: fixtureStore, password });
  fixtureUsers = await fixtureStore.readCollection('users');
});
beforeEach(async () => {
  await cleanup();
  store = new JsonStore({ dataDirectory: directory });
  await seedDemoData(store);
  await store.writeCollection('users', fixtureUsers);
  await store.writeCollection('students', [student()]);
  await store.updateCollection('approved-intakes', (intakes) => intakes.map((intake) => ({ ...intake, approvedSeats: 0 })));
  app = createApp({ store });
  client = await login();
});
afterAll(cleanup);

test('explicit evaluation persists latest findings and returns counts, filters, pagination and detail', async () => {
  const result = await evaluate();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ stale: false, freshness: 'matches_checked_inputs', authenticityVerified: false });
  expect(result.body.summary.totalRecordsEvaluated).toBe(1);
  expect(result.body.summary.findingsByRule.INTAKE_EXCEEDED).toBe(1);
  expect(result.body.summary.overIntake).toHaveLength(1);
  expect(result.headers['cache-control']).toBe('no-store');
  const finding = result.body.findings.find((entry) => entry.ruleCode === 'INTAKE_EXCEEDED');
  const list = await client.agent.get(`${base}/findings`).query({ severity: 'critical', ruleCode: 'INTAKE_EXCEEDED',
    kind: 'violation', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027', page: 1, pageSize: 1 });
  expect(list.status).toBe(200);
  expect(list.body.total).toBe(1);
  expect(list.body.findings).toEqual([finding]);
  const detail = await client.agent.get(`${base}/findings/${finding.id}`);
  expect(detail.body.finding).toEqual(finding);
  const summary = await client.agent.get(`${base}/summary`);
  expect(summary.body.summary).toEqual(result.body.summary);
  const snapshots = await store.readCollection('validation-issues');
  expect(snapshots).toHaveLength(1);
  expect(snapshots[0]).toMatchObject({ kind: 'compliance-evaluation', schemaVersion: 1, institutionId: 'DEMO-INST-001' });
  const again = await evaluate();
  expect(again.body.evaluation.id).not.toBe(result.body.evaluation.id);
  expect(again.body.findings.map(({ id }) => id)).toEqual(result.body.findings.map(({ id }) => id));
  expect(again.body.summary).toEqual(result.body.summary);
  expect(await store.readCollection('validation-issues')).toHaveLength(1);
});

test('before evaluation, read-only endpoints return not_evaluated without initializing findings', async () => {
  const response = await client.agent.get(`${base}/findings`);
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ evaluation: null, stale: true, freshness: 'not_evaluated', summary: null, findings: [] });
  await expect(fs.access(path.join(directory, 'validation-issues.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

test('missing/invalid authentication and missing CSRF cannot evaluate or read findings', async () => {
  for (const url of ['/summary', '/findings', `/findings/finding-${'a'.repeat(32)}`]) {
    expect((await request(app).get(base + url)).status).toBe(401);
    expect((await request(app).get(base + url).set('Cookie', 'eduverify.sid=forged')).status).toBe(401);
  }
  expect((await request(app).post(`${base}/evaluate`).send({})).status).toBe(401);
  expect((await client.agent.post(`${base}/evaluate`).send({})).status).toBe(403);
});

test.each(['admin@demo.example', 'operator@demo.example'])(
  '%s can evaluate and read own-institution results', async (email) => {
    const session = await login(email);
    expect((await evaluate({}, session)).status).toBe(200);
    expect((await session.agent.get(`${base}/findings`)).status).toBe(200);
    expect((await session.agent.get(`${base}/summary`)).status).toBe(200);
  },
);

test.each(['reviewer@demo.example', 'verifier@demo.example'])(
  '%s cannot evaluate, see findings or infer granular aggregates', async (email) => {
    const result = await evaluate();
    const session = await login(email);
    expect((await evaluate({}, session)).status).toBe(403);
    for (const path of ['/findings', '/summary', `/findings/${result.body.findings[0].id}`]) {
      const response = await session.agent.get(base + path);
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: 'Access denied' });
    }
  },
);

test('institution ID body/query tampering and foreign finding IDs cannot cross institution scope', async () => {
  const result = await evaluate();
  const session = await login('admin2@demo.example');
  const own = await evaluate({}, session);
  expect(own.status).toBe(200);
  expect(own.body.summary.totalRecordsEvaluated).toBe(0);
  expect(own.body.summary.overIntake).toHaveLength(0);
  expect((await session.agent.get(`${base}/findings/${result.body.findings[0].id}`)).status).toBe(404);
  expect((await evaluate({ institutionId: 'DEMO-INST-002' })).status).toBe(403);
  for (const path of ['/findings', '/summary', `/findings/${result.body.findings[0].id}`]) {
    expect((await client.agent.get(base + path).query({ institutionId: 'DEMO-INST-002' })).status).toBe(403);
  }
  expect((await client.agent.get(`${base}/findings`).query({ programmeId: 'DEMO-PROG-002' })).body.total).toBe(0);
  expect(await store.readCollection('validation-issues')).toHaveLength(2);
});

test.each([
  ['student change', async () => store.updateCollection('students', (records) => records.map((record) => ({ ...record, status: 'inactive' })))],
  ['intake change', async () => store.updateCollection('approved-intakes', (records) => records.map((record) => ({ ...record, approvedSeats: 20 })))],
  ['programme change', async () => store.updateCollection('programmes', (records) => records.map((record) => ({ ...record, name: 'Fictional Updated Programme' })))],
  ['institution change', async () => store.updateCollection('institutions', (records) => records.map((record) => ({ ...record, name: 'Fictional Updated Institution' })))],
])('saved findings become stale after relevant %s', async (label, change) => {
  const result = await evaluate();
  await change();
  const response = await client.agent.get(`${base}/summary`);
  expect(response.status).toBe(200);
  expect(response.body.stale).toBe(true);
  expect(response.body.freshness).toBe('stale');
  expect(response.body.evaluation.id).toBe(result.body.evaluation.id);
  expect((await client.agent.get(`${base}/findings`)).body.stale).toBe(true);
  expect((await client.agent.get(`${base}/findings/${result.body.findings[0].id}`)).body.stale).toBe(true);
  expect((await evaluate()).body.stale).toBe(false);
});

test('other-institution edits and input reordering do not stale or change the own-institution summary', async () => {
  await evaluate();
  await store.updateCollection('students', (records) => [...records, student({ institutionId: 'DEMO-INST-002', programmeId: 'DEMO-PROG-002' })]);
  await store.updateCollection('approved-intakes', (records) => records.map((record) => record.programmeId === 'DEMO-PROG-002' ? { ...record, approvedSeats: 999 } : record).reverse());
  await store.updateCollection('programmes', (records) => records.reverse());
  expect((await client.agent.get(`${base}/summary`)).body.stale).toBe(false);
});

test('engine version changes stale persisted findings and GET never writes a replacement', async () => {
  await evaluate();
  await store.updateCollection('validation-issues', (entries) => entries.map((entry) => ({ ...entry, engineVersion: 'old-version' })));
  const update = jest.spyOn(store, 'updateCollection');
  expect((await client.agent.get(`${base}/summary`)).body.stale).toBe(true);
  expect(update).not.toHaveBeenCalled();
});

test('evaluation reports stale if student inputs change while findings are being persisted', async () => {
  const originalUpdate = store.updateCollection.bind(store);
  const update = jest.spyOn(store, 'updateCollection').mockImplementation(async (name, operation) => {
    const result = await originalUpdate(name, operation);
    if (name === 'validation-issues') {
      await originalUpdate('students', (records) => records.map((record) => ({ ...record, status: 'inactive' })));
    }
    return result;
  });
  try {
    const response = await evaluate();
    expect(response.status).toBe(200);
    expect(response.body.stale).toBe(true);
  } finally { update.mockRestore(); }
});

test('legacy intake JSON is preserved by repeated seeding and yields review instead of invented policy', async () => {
  const legacy = structuredClone(DEMO_RECORDS['approved-intakes']);
  legacy.forEach((intake) => { delete intake.countingPolicy; });
  await store.writeCollection('approved-intakes', legacy);
  const original = await fs.readFile(path.join(directory, 'approved-intakes.json'), 'utf8');
  await seedDemoData(store);
  await seedDemoData(store);
  expect(await fs.readFile(path.join(directory, 'approved-intakes.json'), 'utf8')).toBe(original);
  const response = await evaluate();
  expect(response.status).toBe(200);
  expect(response.body.summary.findingsByRule.INTAKE_POLICY_REVIEW).toBe(1);
  expect(response.body.summary.overIntake).toHaveLength(0);
  expect(response.body.summary.manualReviewItems).toBeGreaterThan(0);
});

test('unrelated legacy validation-issues entries survive evaluation', async () => {
  const legacy = { id: 'DEMO-LEGACY-ISSUE', message: 'Fictional preserved issue' };
  await store.writeCollection('validation-issues', [legacy]);
  expect((await evaluate()).status).toBe(200);
  expect((await store.readCollection('validation-issues'))[0]).toEqual(legacy);
});

test('failed persistence preserves previous findings and student bytes; retry succeeds', async () => {
  await evaluate();
  const original = await fs.readFile(path.join(directory, 'validation-issues.json'), 'utf8');
  const students = await fs.readFile(path.join(directory, 'students.json'), 'utf8');
  const rename = jest.spyOn(store.fileSystem, 'rename').mockRejectedValueOnce(new Error('Private filesystem path'));
  try {
    const response = await evaluate();
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Internal server error' });
    expect(await fs.readFile(path.join(directory, 'validation-issues.json'), 'utf8')).toBe(original);
    expect(await fs.readFile(path.join(directory, 'students.json'), 'utf8')).toBe(students);
    expect((await fs.readdir(directory)).some((name) => name.endsWith('.tmp'))).toBe(false);
    expect((await evaluate()).status).toBe(200);
  } finally { rename.mockRestore(); }
});

test('malformed references or findings return safe 500 errors without replacing corrupted data', async () => {
  await fs.writeFile(path.join(directory, 'approved-intakes.json'), '{broken');
  expect((await evaluate()).body).toEqual({ error: 'Internal server error' });
  expect(await fs.readFile(path.join(directory, 'approved-intakes.json'), 'utf8')).toBe('{broken');
  // Explicit fixture repair: normal adapter writes now preserve corrupt files.
  await fs.writeFile(path.join(directory, 'approved-intakes.json'), JSON.stringify(DEMO_RECORDS['approved-intakes']));
  await fs.writeFile(path.join(directory, 'validation-issues.json'), '{broken-findings');
  const response = await client.agent.get(`${base}/findings`);
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: 'Internal server error' });
  expect(await fs.readFile(path.join(directory, 'validation-issues.json'), 'utf8')).toBe('{broken-findings');
});

test('request fields, query parameters, finding IDs and evaluation rates are validated', async () => {
  expect((await evaluate({ students: [] })).status).toBe(400);
  expect((await evaluate([])).status).toBe(400);
  for (const query of [{ pageSize: 101 }, { page: -1 }, { severity: 'secret' }, { kind: 'fraud' }, { unknown: 'x' }]) {
    expect((await client.agent.get(`${base}/findings`).query(query)).status).toBe(400);
  }
  expect((await client.agent.get(`${base}/findings/bad-id`)).status).toBe(400);
  expect((await client.agent.get(`${base}/findings/finding-${'a'.repeat(32)}`)).status).toBe(404);
  const target = createApp({ store, complianceOptions: { evaluationLimit: 1 } });
  const limited = await login('admin@demo.example', target);
  expect((await evaluate({}, limited)).status).toBe(200);
  expect((await evaluate({}, limited)).status).toBe(429);
});

test('results never expose names, APAAR values, credentials, session state or fingerprints', async () => {
  const response = await evaluate();
  const text = JSON.stringify(response.body);
  expect(text).not.toContain('Fictional Compliance Learner');
  for (const key of ['apaarId', 'studentName', 'passwordHash', 'csrfToken', 'sessionID', 'inputFingerprint', directory]) {
    expect(text).not.toContain(key);
  }
});
