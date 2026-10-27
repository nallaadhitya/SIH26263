const fs = require('node:fs/promises');
const path = require('node:path');
const { JsonStore, DataCorruptionError } = require('../storage/json-store');
const request = require('supertest');
const { createApp } = require('../server');
const { seedDemoAccounts } = require('../scripts/seed-accounts');

const directory = path.resolve(__dirname, '.tmp-review-data');
async function cleanup() {
  if (path.dirname(directory) !== path.resolve(__dirname) || path.basename(directory) !== '.tmp-review-data') throw new Error('Unsafe cleanup');
  await fs.rm(directory, { recursive: true, force: true });
}
beforeEach(cleanup);
afterAll(cleanup);

test('a delayed first-read initializer cannot erase a completed concurrent write', async () => {
  let enter; let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  let initialWrites = 0;
  const store = new JsonStore({ dataDirectory: directory });
  const atomicWrite = store._atomicWrite.bind(store);
  store._atomicWrite = async (file, records) => {
    if (!records.length) {
      initialWrites += 1;
      if (initialWrites === 1) { enter(); await blocked; }
    }
    return atomicWrite(file, records);
  };
  const read = store.readCollection('students');
  await entered;
  const write = store.updateCollection('students', rows => [...rows, { id: 'fictional-saved-record' }]);
  // Let the concurrent initializer run, if present, before releasing the first.
  await new Promise(resolve => setTimeout(resolve, 30));
  release(); await Promise.all([read, write]);
  expect(await store.readCollection('students')).toEqual([{ id: 'fictional-saved-record' }]);
  expect(initialWrites).toBe(1);
});

test('explicit replacement refuses corrupted JSON and preserves original bytes', async () => {
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'students.json');
  await fs.writeFile(file, '{malformed legacy file', 'utf8');
  const store = new JsonStore({ dataDirectory: directory });
  await expect(store.writeCollection('students', [])).rejects.toBeInstanceOf(DataCorruptionError);
  expect(await fs.readFile(file, 'utf8')).toBe('{malformed legacy file');
});

test('failed initialization can be retried and does not poison the collection queue', async () => {
  const store = new JsonStore({ dataDirectory: directory });
  const original = store._atomicWrite.bind(store);
  let fail = true;
  store._atomicWrite = async (...args) => { if (fail) { fail = false; throw new Error('Injected initialization failure'); } return original(...args); };
  await expect(store.readCollection('students')).rejects.toThrow('Injected');
  await store.updateCollection('students', rows => [...rows, { id: 'fictional-retry' }]);
  expect(await store.readCollection('students')).toEqual([{ id: 'fictional-retry' }]);
});

test.each([
  [{ status: 'inactive' }, 401],
  [{ role: 'authorized_verifier', institutionId: null }, 403],
  [{ institutionId: 'DEMO-INST-002' }, 403],
])('queued student writes recheck account changes %#', async (changes, expectedStatus) => {
  const store = new JsonStore({ dataDirectory: directory });
  const password = 'fictional-review-password';
  await seedDemoAccounts({ store, password });
  const app = createApp({ store });
  const agent = request.agent(app);
  const csrf = await agent.get('/api/auth/csrf');
  const loggedIn = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken)
    .send({ email: 'admin@demo.example', password });
  expect(loggedIn.status).toBe(200);
  let release; let notifyQueued;
  const blocked = new Promise(resolve => { release = resolve; });
  const held = store.withCollectionLock('students', () => blocked);
  const queued = new Promise(resolve => { notifyQueued = resolve; });
  const run = store._runWrite.bind(store);
  const spy = jest.spyOn(store, '_runWrite').mockImplementation((collection, operation) => {
    if (collection === 'students') notifyQueued();
    return run(collection, operation);
  });
  const pending = agent.post('/api/v1/students').set('X-CSRF-Token', loggedIn.body.csrfToken)
    .send({ studentName: 'Fictional Queued Learner', apaarId: '000000000098', programmeId: 'DEMO-PROG-001',
      academicYear: '2026-2027', admissionYear: '2026' }).then(result => result);
  await queued;
  await store.updateCollection('users', rows => rows.map(user => user.email === 'admin@demo.example' ? { ...user, ...changes } : user));
  release(); await held;
  const result = await pending; spy.mockRestore();
  expect(result.status).toBe(expectedStatus);
  expect(await store.readCollection('students', { initialize: false })).toEqual([]);
});

test.each(['csv', 'compliance'])('queued %s mutations recheck deactivation before persistence', async operation => {
  const store = new JsonStore({ dataDirectory: directory });
  const password = 'fictional-review-password';
  await seedDemoAccounts({ store, password });
  const app = createApp({ store }); const agent = request.agent(app);
  const csrf = await agent.get('/api/auth/csrf');
  const loggedIn = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken).send({ email: 'admin@demo.example', password });
  let preview;
  if (operation === 'csv') preview = await agent.post('/api/v1/students/import/preview').set('X-CSRF-Token', loggedIn.body.csrfToken)
    .attach('file', Buffer.from('apaarId,studentName,institutionId,programmeId,academicYear,admissionYear\n000000000097,Fictional Queued Import,DEMO-INST-001,DEMO-PROG-001,2026-2027,2026'), { filename: 'fictional.csv', contentType: 'text/csv' });
  const collection = operation === 'csv' ? 'students' : 'validation-issues';
  let release; let notify;
  const blocked = new Promise(resolve => { release = resolve; });
  const held = store.withCollectionLock(collection, () => blocked);
  const queued = new Promise(resolve => { notify = resolve; });
  const run = store._runWrite.bind(store);
  const spy = jest.spyOn(store, '_runWrite').mockImplementation((name, fn) => { if (name === collection) notify(); return run(name, fn); });
  const pending = agent.post(operation === 'csv' ? '/api/v1/students/import/commit' : '/api/v1/compliance/evaluate')
    .set('X-CSRF-Token', loggedIn.body.csrfToken).send(operation === 'csv' ? { previewToken: preview.body.previewToken } : {}).then(result => result);
  await queued;
  await store.updateCollection('users', rows => rows.map(user => ({ ...user, status: 'inactive' })));
  release(); await held;
  const result = await pending; spy.mockRestore();
  expect(result.status).toBe(401);
  expect(await store.readCollection(collection, { initialize: false })).toEqual([]);
});
