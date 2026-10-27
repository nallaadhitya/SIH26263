// Exercise the real Vite proxy and Express contracts with isolated fictional data.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs/promises';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { metadataShape, findingsShape, studentsShape, previewShape } from '../src/contracts.js';

const require = createRequire(import.meta.url);
const { createApp } = require('../../backend/server');
const { JsonStore } = require('../../backend/storage/json-store');
const { seedDemoAccounts } = require('../../backend/scripts/seed-accounts');
const { SigningKeys } = require('../../backend/verification/crypto');
const { smokeStore } = require('../../backend/storage/smoke-store');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const directory = await fs.mkdtemp(path.join(root, '.tmp-smoke-'));
let backend;
let vite;
let fixture;
try {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const password = randomBytes(24).toString('hex');
  fixture=await smokeStore(directory);
  const {store}=fixture;
  await seedDemoAccounts({ store, password });
  const signing = new SigningKeys({ keys: { smoke: randomBytes(32).toString('base64') }, activeId: 'smoke', forbiddenSecrets: [] });
  backend = createApp({ store, authOptions: { origin }, verificationOptions: { signing }, mlOptions: { client: { predict: async () => { throw new Error('Unavailable in frontend smoke'); } } } }).listen(0, '127.0.0.1');
  await new Promise(resolve => backend.once('listening', resolve));
  vite = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${backend.address().port}`, changeOrigin: false } } } });
  await vite.listen();
  assert.equal((await fetch(origin)).status, 200);
  let cookie;
  let csrf;
  async function call(endpoint, method = 'GET', body) {
    const headers = { Origin: origin, 'Sec-Fetch-Site': 'same-origin' };
    if (cookie) headers.Cookie = cookie;
    if (csrf) headers['X-CSRF-Token'] = csrf;
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const result = await fetch(`${origin}/api${endpoint}`, { method, headers,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const updated = result.headers.getSetCookie()[0];
    if (updated) { assert.match(updated, /HttpOnly/i); cookie = updated.split(';')[0]; }
    return { status: result.status, data: result.status === 204 ? null : await result.json() };
  }
  csrf = (await call('/auth/csrf')).data.csrfToken;
  const login = await call('/auth/login', 'POST', { email: 'admin@demo.example', password });
  assert.equal(login.status, 200); csrf = login.data.csrfToken;
  assert.equal((await call('/auth/me')).data.user.role, 'institution_admin');
  const student = { studentName: 'Fictional UI Smoke Learner', apaarId: '000000000091', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027', admissionYear: '2026', admissionCategory: 'general', status: 'active' };
  const created = await call('/v1/students', 'POST', student);
  assert.equal(created.status, 201);
  assert.equal((await call(`/v1/students/${created.data.student.id}`, 'PATCH', { studentName: 'Fictional Updated Learner' })).status, 200);
  assert.equal((await call(`/v1/students/${created.data.student.id}`)).data.student.studentName, 'Fictional Updated Learner');
  const issued = await call('/v1/verification/issue', 'POST', { studentId: created.data.student.id });
  assert.equal(issued.status, 201);
  assert.match(issued.data.qrDataUrl, /^data:image\/png;base64,iVBOR/);
  const authenticatedCookie = cookie;
  cookie = undefined;
  const checked = await call('/v1/verification/verify', 'POST', { payload: issued.data.payload });
  assert.equal(checked.data.status, 'valid');
  assert.equal(checked.data.recordCurrent, true);
  assert.deepEqual(Object.keys(checked.data).sort(), ['status', 'integrityValid', 'recordCurrent', 'checkedAt', 'officialApaarAuthenticity'].sort());
  cookie = authenticatedCookie;
  const list = await call('/v1/students?page=1&pageSize=20');
  assert(studentsShape(list.data)); assert.equal(list.data.total, 1);
  const form = new FormData();
  form.append('file', new Blob(['apaarId,studentName,institutionId,programmeId,academicYear,admissionYear\n000000000092,Fictional Imported Learner,DEMO-INST-001,DEMO-PROG-001,2026-2027,2026'], { type: 'text/csv' }), 'fictional.csv');
  const preview = await call('/v1/students/import/preview', 'POST', form);
  assert.equal(preview.status, 200); assert(previewShape(preview.data));
  assert.equal((await call('/v1/students/import/commit', 'POST', { previewToken: preview.data.previewToken })).data.imported, 1);
  assert.equal((await call('/v1/students/import/commit', 'POST', { previewToken: preview.data.previewToken })).status, 409);
  const evaluation = await call('/v1/compliance/evaluate', 'POST', {});
  assert.equal(evaluation.status, 200); assert(metadataShape(evaluation.data));
  assert(findingsShape((await call('/v1/compliance/findings')).data));
  await call(`/v1/students/${created.data.student.id}`, 'PATCH', { status: 'inactive' });
  assert.equal((await call('/v1/compliance/summary')).data.stale, true);
  assert.equal((await call('/v1/verification/verify', 'POST', { payload: issued.data.payload })).data.status, 'outdated');
  assert.equal((await call('/v1/verification/revoke', 'POST', { artifactId: issued.data.artifactId })).data.status, 'revoked');
  assert.equal((await call('/v1/verification/verify', 'POST', { payload: issued.data.payload })).data.status, 'revoked');
  assert((await call('/v1/ml/evaluate', 'POST', {})).status >= 500);
  assert.equal((await call('/auth/logout', 'POST')).status, 204);
  assert.equal((await call('/auth/me')).status, 401);
  csrf = (await call('/auth/csrf')).data.csrfToken;
  const reviewer = await call('/auth/login', 'POST', { email: 'reviewer@demo.example', password });
  csrf = reviewer.data.csrfToken;
  assert.equal((await call('/v1/students')).status, 403);
  assert.equal((await call('/v1/verification/issue', 'POST', { studentId: created.data.student.id })).status, 403);
  console.log('PASS: real Vite proxy, cookie/CSRF login, create/edit/detail/list, CSV preview/commit/replay, compliance/staleness, ML failure, QR PNG issuance/public verify/outdated/revoke, logout and reviewer denial.');
} finally {
  if (vite) await vite.close();
  if (backend) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
  if(fixture)await fixture.cleanup();
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith('.tmp-smoke-')) throw new Error('Unsafe cleanup target');
  await fs.rm(directory, { recursive: true, force: true });
}
