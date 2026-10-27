const fs = require('node:fs/promises');
const path = require('node:path');
const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { createApp } = require('../server');
const { createAuth } = require('../auth');
const { requirePermission, requireInstitution } = require('../auth/policy');
const { JsonStore } = require('../storage/json-store');
const { seedDemoAccounts, DEMO_ACCOUNTS } = require('../scripts/seed-accounts');

const directory = path.resolve(__dirname, '.tmp-auth-data');
// Generated fixture secret is never written to source or printed.
const password = require('node:crypto').randomBytes(20).toString('hex');
let initialUsers;
let institutions;
let store;
let app;

async function removeTestDirectory() {
  if (path.dirname(directory) !== path.resolve(__dirname)) throw new Error('Unsafe test directory');
  await fs.rm(directory, { recursive: true, force: true });
}

beforeAll(async () => {
  await removeTestDirectory();
  const fixtureStore = new JsonStore({ dataDirectory: directory });
  await seedDemoAccounts({ store: fixtureStore, password });
  initialUsers = await fixtureStore.readCollection('users');
  institutions = await fixtureStore.readCollection('institutions');
});
beforeEach(async () => {
  store = new JsonStore({ dataDirectory: directory });
  await store.writeCollection('users', structuredClone(initialUsers));
  await store.writeCollection('institutions', institutions);
  app = createApp({ store });
});
afterAll(removeTestDirectory);

async function login(target = app, email = 'admin@demo.example', suppliedPassword = password) {
  const agent = request.agent(target);
  const csrf = await agent.get('/api/auth/csrf');
  const response = await agent.post('/api/auth/login')
    .set('X-CSRF-Token', csrf.body.csrfToken).send({ email, password: suppliedPassword });
  return { agent, response, csrfToken: response.body.csrfToken, preLogin: csrf };
}

test('successful normalized login and me return only public account fields', async () => {
  const { agent, response } = await login(app, '  ADMIN@demo.example  ');
  expect(response.status).toBe(200);
  expect(response.body.user.email).toBe('admin@demo.example');
  expect(response.headers['set-cookie'][0]).toContain('HttpOnly');
  expect(response.headers['set-cookie'][0]).toContain('SameSite=Strict');
  expect(response.headers['cache-control']).toBe('no-store');
  const me = await agent.get('/api/auth/me');
  expect(me.status).toBe(200);
  expect(Object.keys(me.body.user).sort()).toEqual([
    'displayName', 'email', 'id', 'institutionId', 'role', 'status',
  ]);
  expect(JSON.stringify(response.body)).not.toContain(password);
  expect(JSON.stringify(response.body)).not.toContain('passwordHash');
});

test.each(['wrong-password', 'missing-user'])('failed login is generic: %s', async (scenario) => {
  const { response } = await login(app,
    scenario === 'missing-user' ? 'unknown@demo.example' : 'admin@demo.example',
    scenario === 'wrong-password' ? 'wrong' : password);
  expect(response.status).toBe(401);
  expect(response.body).toEqual({ error: 'Invalid email or password' });
});

test('inactive accounts cannot log in', async () => {
  await store.updateCollection('users', (users) => users.map((user) => ({ ...user, status: 'inactive' })));
  expect((await login()).response.status).toBe(401);
});

test('deactivation after login invalidates authentication', async () => {
  const { agent } = await login();
  await store.updateCollection('users', (users) => users.map((user) => ({ ...user, status: 'inactive' })));
  expect((await agent.get('/api/auth/me')).status).toBe(401);
});

test('institution accounts must reference an existing institution', async () => {
  await store.updateCollection('users', (users) => users.map((user) => ({ ...user, institutionId: null })));
  expect((await login()).response.status).toBe(401);
  await store.writeCollection('users', initialUsers);
  await store.writeCollection('institutions', []);
  expect((await login()).response.status).toBe(401);
});

test('missing and tampered authentication are rejected', async () => {
  expect((await request(app).get('/api/auth/me')).status).toBe(401);
  expect((await request(app).get('/api/auth/me').set('Cookie', 'eduverify.sid=forged')).status).toBe(401);
});

test('login rejects role/institution overrides and malformed request fields', async () => {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf')).body.csrfToken;
  for (const body of [
    { email: 'admin@demo.example', password, institutionId: 'DEMO-INST-002' },
    { email: 'admin@demo.example', password, role: 'regulatory_reviewer' },
    { email: [], password }, { email: 'invalid', password },
    { email: 'admin@demo.example', password: 'a'.repeat(73) },
  ]) {
    expect((await agent.post('/api/auth/login').set('X-CSRF-Token', csrf).send(body)).status).toBe(400);
  }
});

test('CSRF blocks missing, invalid, cross-session and cross-origin tokens', async () => {
  const agent = request.agent(app);
  const csrf = (await agent.get('/api/auth/csrf')).body.csrfToken;
  const credentials = { email: 'admin@demo.example', password };
  expect((await agent.post('/api/auth/login').send(credentials)).status).toBe(403);
  expect((await agent.post('/api/auth/login').set('X-CSRF-Token', 'bad').send(credentials)).status).toBe(403);
  expect((await request(app).post('/api/auth/login').set('X-CSRF-Token', csrf).send(credentials)).status).toBe(403);
  expect((await agent.post('/api/auth/login').set('X-CSRF-Token', csrf)
    .set('Origin', 'http://attacker.example').send(credentials)).status).toBe(403);
});

test('login rotates session and CSRF; logout destroys the session and prevents replay', async () => {
  const { agent, response, preLogin, csrfToken } = await login();
  const oldCookie = preLogin.headers['set-cookie'][0].split(';')[0];
  const cookie = response.headers['set-cookie'][0].split(';')[0];
  expect(cookie).not.toBe(oldCookie);
  expect(csrfToken).not.toBe(preLogin.body.csrfToken);
  expect((await request(app).get('/api/auth/me').set('Cookie', oldCookie)).status).toBe(401);
  expect((await agent.post('/api/auth/logout')).status).toBe(403);
  expect((await agent.get('/api/auth/me')).status).toBe(200);
  expect((await agent.post('/api/auth/logout').set('X-CSRF-Token', csrfToken)).status).toBe(204);
  expect((await agent.get('/api/auth/me')).status).toBe(401);
  expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).status).toBe(401);
});

test('sessions expire at an absolute deadline', async () => {
  let clock = Date.now();
  const target = createApp({ store, authOptions: { now: () => clock } });
  const { agent } = await login(target);
  clock += 30 * 60 * 1000 + 1;
  expect((await agent.get('/api/auth/me')).status).toBe(401);
});

test('login requests are rate limited', async () => {
  const target = createApp({ store, authOptions: { loginLimit: 2 } });
  const agent = request.agent(target);
  const csrf = (await agent.get('/api/auth/csrf')).body.csrfToken;
  for (let index = 0; index < 2; index += 1) {
    expect((await agent.post('/api/auth/login').set('X-CSRF-Token', csrf)
      .send({ email: 'admin@demo.example', password: 'wrong' })).status).toBe(401);
  }
  expect((await agent.post('/api/auth/login').set('X-CSRF-Token', csrf)
    .send({ email: 'admin@demo.example', password: 'wrong' })).status).toBe(429);
});

// Test-only resources exercise real middleware without adding future feature APIs.
function policyApp() {
  const target = express();
  target.use(express.json());
  const auth = createAuth({ store });
  target.use('/api/auth', auth.router);
  target.use(auth.sessionMiddleware, auth.requireAuthentication, auth.requireCsrf);
  target.post('/institutions/:institutionId/manage', requirePermission('institution:manage'),
    requireInstitution(), (req, res) => res.json({ institutionId: req.params.institutionId }));
  target.get('/institutions/:institutionId/read', requirePermission('institution:read'),
    requireInstitution(), (req, res) => res.json({ institutionId: req.params.institutionId }));
  target.get('/regulatory-summary', requirePermission('regulatory:summary'), (req, res) => res.json({ permitted: true }));
  target.get('/students', requirePermission('student:read'), (req, res) => res.json([]));
  return target;
}

test.each([
  ['admin@demo.example', 200, 200, 403],
  ['operator@demo.example', 200, 403, 403],
  ['reviewer@demo.example', 403, 403, 200],
  ['verifier@demo.example', 403, 403, 403],
])('permission matrix for %s', async (email, read, manage, summary) => {
  const { agent, csrfToken } = await login(policyApp(), email);
  expect((await agent.get('/institutions/DEMO-INST-001/read')).status).toBe(read);
  expect((await agent.post('/institutions/DEMO-INST-001/manage').set('X-CSRF-Token', csrfToken)).status).toBe(manage);
  expect((await agent.get('/regulatory-summary')).status).toBe(summary);
  expect((await agent.get('/students')).status).toBe(403);
});

test.each(['admin@demo.example', 'operator@demo.example', 'admin2@demo.example'])(
  '%s cannot change institution IDs to cross the institution boundary', async (email) => {
    const { agent, csrfToken } = await login(policyApp(), email);
    const own = email.startsWith('admin2') ? 'DEMO-INST-002' : 'DEMO-INST-001';
    const other = own === 'DEMO-INST-001' ? 'DEMO-INST-002' : 'DEMO-INST-001';
    expect((await agent.get(`/institutions/${own}/read`)).status).toBe(200);
    expect((await agent.get(`/institutions/${other}/read`).query({ institutionId: own })).status).toBe(403);
    expect((await agent.post(`/institutions/${other}/manage`).set('X-CSRF-Token', csrfToken)
      .send({ institutionId: own })).status).toBe(403);
    const me = await agent.get('/api/auth/me');
    expect(me.body.user.institutionId).toBe(own);
  },
);

test('account seed uses hashes and is idempotent without resetting credentials', async () => {
  await seedDemoAccounts({ store, password: `${password}new` });
  const users = await store.readCollection('users');
  expect(users).toEqual(initialUsers);
  expect(users).toHaveLength(DEMO_ACCOUNTS.length);
  for (const user of users) {
    expect(user).not.toHaveProperty('password');
    expect(user.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(await bcrypt.compare(password, user.passwordHash)).toBe(true);
    expect(user.createdAt).toBe(user.updatedAt);
  }
});

test('corrupt user storage returns a safe 500 and preserves the file', async () => {
  await fs.writeFile(path.join(directory, 'users.json'), '{broken');
  const { response } = await login();
  expect(response.status).toBe(500);
  expect(response.body).toEqual({ error: 'Internal server error' });
  expect(await fs.readFile(path.join(directory, 'users.json'), 'utf8')).toBe('{broken');
});
