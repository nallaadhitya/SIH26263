// Real browser + Vite + Express + Python review. No mocks, runtime data or real credentials.
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { createApp } = require('../../backend/server');
const { JsonStore } = require('../../backend/storage/json-store');
const { seedDemoAccounts } = require('../../backend/scripts/seed-accounts');
const { SigningKeys } = require('../../backend/verification/crypto');
const { MlClient } = require('../../backend/ml/client');
const { smokeStore } = require('../../backend/storage/smoke-store');
const { MySqlStore } = require('../../backend/storage/mysql-store');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.dirname(root);
const directory = await fs.mkdtemp(path.join(root, '.tmp-e2e-'));
let backend; let vite; let python; let context; let stage = 'setup';
let completed = false;
let fixture; let restartedStore;
let timeOffset = 0;
let verificationOffset = 0;
const password = randomBytes(24).toString('hex');
const key = randomBytes(32).toString('hex');
const signing = new SigningKeys({ keys: { review: randomBytes(32).toString('base64') }, activeId: 'review', forbiddenSecrets: [] });

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve)); return port;
}
async function stopPython() {
  const child = python;
  python = null;
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
}
async function stopBackend() {
  if (backend) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); backend = null; }
}
try {
  fixture=await smokeStore(path.join(directory,'data'));
  const {store}=fixture;
  await seedDemoAccounts({ store, password });
  await seedDemoAccounts({ store, password }); // Repeat seeding must preserve accounts/reference rows.
  assert.equal((await store.readCollection('users')).length, 5);
  await store.updateCollection('approved-intakes', rows => rows.map(row => row.programmeId === 'DEMO-PROG-001' ? { ...row, approvedSeats: 1 } : row));
  const mlPort = await freePort(); const uiPort = await freePort();
  const origin = `http://127.0.0.1:${uiPort}`;
  const pythonBinary = path.join(project, 'ml-service/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await fs.access(pythonBinary); await fs.access(path.join(project, 'ml-service/artifacts/model.joblib'));
  async function startPython() {
  python = spawn(pythonBinary, ['-m', 'uvicorn', 'ml_app.api:app', '--host', '127.0.0.1', '--port', String(mlPort), '--no-access-log'], {
    cwd: path.join(project, 'ml-service'), windowsHide: true, stdio: 'ignore',
    env: { ...process.env, ML_SERVICE_KEY: key, ML_MODEL_DIR: 'ml-service/artifacts', TEMP: directory, TMP: directory },
  });
  let childError;
  python.once('error', error => { childError = error; });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    if (childError || python.exitCode !== null) throw new Error('Python startup failed');
    try { ready = (await fetch(`http://127.0.0.1:${mlPort}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* bounded startup wait */ }
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, 'Python not ready');
  }
  await startPython();
  const forwardedFeatures = [];
  const client = new MlClient({ url: `http://127.0.0.1:${mlPort}`, key, timeoutMs: 10000,
    fetchImpl: async (url, options) => { forwardedFeatures.push(JSON.parse(options.body)); return fetch(url, options); } });
  const appOptions = { store, authOptions: { origin, now: () => Date.now() + timeOffset }, verificationOptions: { signing, now: () => Date.now() + verificationOffset }, mlOptions: { client } };
  backend = createApp(appOptions).listen(0, '127.0.0.1');
  await new Promise(resolve => backend.once('listening', resolve));
  const backendPort = backend.address().port;
  vite = await createServer({ root, cacheDir: path.join(directory, 'node_modules/.vite'), server: { host: '127.0.0.1', port: uiPort, strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false } } } });
  await vite.listen();
  context = await chromium.launchPersistentContext(path.join(directory, 'browser-profile'), {
    channel: process.env.E2E_BROWSER_CHANNEL || 'chrome', headless: true, viewport: { width: 1280, height: 900 },
    downloadsPath: path.join(directory, 'downloads'), env: { ...process.env, TEMP: directory, TMP: directory },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).origin === origin || route.request().url().startsWith('data:') ? route.continue() : route.abort());
  await page.goto(origin);
  async function login(email) {
    await page.getByLabel('Email', { exact: true }).fill(email);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
  }
  const nav = name => page.getByRole('navigation').getByRole('button', { name, exact: true }).click();
  async function api(endpoint, method = 'GET', data) {
    const headers = {};
    if (method !== 'GET') headers['X-CSRF-Token'] = (await (await context.request.get(`${origin}/api/auth/csrf`)).json()).csrfToken;
    return context.request.fetch(`${origin}/api${endpoint}`, { method, headers, data });
  }
  const verify = async payload => (await api('/v1/verification/verify', 'POST', { payload })).json();
  stage = 'login and keyboard';
  await page.getByLabel('Email', { exact: true }).fill('admin@demo.example');
  await page.getByLabel('Password', { exact: true }).fill('fictional-wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Invalid email or password');
  await login('admin@demo.example');
  await page.keyboard.press('Tab'); // Visible keyboard focus must exist on an interactive element.
  assert(await page.evaluate(() => ['BUTTON', 'A', 'INPUT', 'SELECT'].includes(document.activeElement.tagName)));
  await nav('Students'); await page.getByRole('button', { name: 'Create student', exact: true }).click();
  stage = 'student create/edit';
  await page.getByLabel('Student name', { exact: true }).fill('Fictional Browser Learner');
  await page.getByLabel('APAAR (12-digit fictional text)', { exact: true }).fill('000000000081');
  await page.getByLabel('Programme ID', { exact: true }).fill('DEMO-PROG-001');
  await page.getByLabel('Academic year (YYYY-YYYY)', { exact: true }).fill('2026-2027');
  await page.getByLabel('Admission year', { exact: true }).fill('2026');
  await page.getByRole('button', { name: 'Save student', exact: true }).click();
  await expect(page.getByText('Student saved.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'View Fictional Browser Learner', exact: true }).click();
  await page.getByRole('button', { name: 'Edit student', exact: true }).click();
  await page.getByLabel('Student name', { exact: true }).fill('Fictional Edited Learner');
  await page.getByRole('button', { name: 'Save student', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View Fictional Edited Learner' })).toBeVisible();
  const record = (await (await api('/v1/students')).json()).records[0];
  assert.equal((await (await api(`/v1/students/${record.id}`)).json()).student.studentName, 'Fictional Edited Learner');
  stage = 'CSV invalid preview, modal and commit';
  await nav('CSV import');
  const header = 'apaarId,studentName,institutionId,programmeId,academicYear,admissionYear\n';
  const file = text => ({ name: 'fictional.csv', mimeType: 'text/csv', buffer: Buffer.from(header + text) });
  await page.getByLabel('CSV file', { exact: true }).setInputFiles(file('bad,Fictional Invalid,DEMO-INST-001,DEMO-PROG-001,2026-2027,2026'));
  await page.getByRole('button', { name: 'Preview CSV', exact: true }).click();
  await expect(page.getByText('invalid', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review and commit' })).toHaveCount(0);
  await page.getByLabel('CSV file', { exact: true }).setInputFiles(file('000000000082,Fictional Imported Learner,DEMO-INST-001,DEMO-PROG-001,2026-2027,2026'));
  await page.getByRole('button', { name: 'Preview CSV', exact: true }).click();
  await page.getByRole('button', { name: 'Review and commit', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm import' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Review and commit', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Review and commit', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm import', exact: true }).click();
  await expect(page.getByText('Import confirmed by server:', { exact: false })).toBeVisible();
  assert.equal((await (await api('/v1/students')).json()).total, 2);
  stage = 'compliance and real ML';
  await nav('Compliance'); await expect(page.getByText('Not evaluated.', { exact: false })).toBeVisible();
  stage = 'compliance evaluation';
  const evaluationResponse = page.waitForResponse(response => response.url().endsWith('/api/v1/compliance/evaluate'));
  await page.getByRole('button', { name: 'Evaluate institution', exact: true }).click();
  const evaluatedResponse = await evaluationResponse;
  assert.equal(evaluatedResponse.status(), 200);
  // Inspect the real saved result independently so a UI contract failure can be
  // distinguished from a missing rule outcome without logging any student data.
  const observedFindings = await (await api('/v1/compliance/findings')).json();
  assert(observedFindings.findings.some(f => f.ruleCode === 'INTAKE_EXCEEDED'), `Expected configured capacity finding absent; codes=${observedFindings.findings.map(f => f.ruleCode).join(',')}`);
  await expect(page.getByRole('cell').filter({ hasText: 'INTAKE_EXCEEDED' })).toBeVisible();
  assert((await (await api('/v1/compliance/findings')).json()).findings.some(f => f.ruleCode === 'INTAKE_EXCEEDED'));
  stage = 'real ML success';
  await nav('ML review'); await page.getByRole('button', { name: 'Run ML analysis', exact: true }).click();
  await expect(page.getByText('ML analysis completed.', { exact: false })).toBeVisible();
  assert(forwardedFeatures.length > 0);
  for (const body of forwardedFeatures) for (const row of body.records) {
    assert.deepEqual(Object.keys(row), ['active_record_count', 'intake_ratio', 'year_over_year_change', 'admission_year_concentration']);
    assert(Object.values(row).every(value => value === null || typeof value === 'number'));
  }
  await stopPython();
  stage = 'stopped ML failure';
  await page.getByRole('button', { name: 'Run ML analysis', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('ML service unavailable');
  await expect(page.getByText('Below model threshold', { exact: true })).toHaveCount(0);
  assert.equal((await api('/v1/ml/evaluate', 'POST', {})).status(), 503);
  stage = 'restored ML service';
  await startPython();
  await page.getByRole('button', { name: 'Run ML analysis', exact: true }).click();
  await expect(page.getByText('ML analysis completed.', { exact: false })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  stage = 'QR issue/download/revoke/outdated';
  await nav('Students'); await page.getByRole('button', { name: 'View Fictional Edited Learner', exact: true }).click();
  await page.getByRole('button', { name: 'Issue QR artifact', exact: true }).click();
  stage = 'first QR payload rendering';
  const payloadInput = page.getByRole('textbox', { name: /^Signed QR payload \(copy as text\)/ });
  await expect(payloadInput).toBeVisible(); const revokedPayload = await payloadInput.inputValue();
  assert.equal((await verify(revokedPayload)).status, 'valid');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download QR PNG' }).click();
  const download = await downloadEvent; await download.saveAs(path.join(directory, 'artifact.png'));
  assert.equal((await fs.readFile(path.join(directory, 'artifact.png'))).subarray(1, 4).toString(), 'PNG');
  await page.getByRole('button', { name: 'Revoke this artifact', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm revocation', exact: true }).click();
  stage = 'QR revocation confirmation';
  await expect(page.getByText('Artifact revoked. Do not share this QR.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Issue QR artifact', exact: true }).click();
  stage = 'second QR payload rendering';
  await expect(payloadInput).toBeVisible(); const outdatedPayload = await payloadInput.inputValue();
  async function checkInUi(payload, status) {
    stage = `QR public ${status}`;
    await nav('Verification'); await page.getByRole('textbox', { name: /^QR payload/ }).fill(payload);
    await page.getByRole('button', { name: 'Verify artifact', exact: true }).click();
    await expect(page.getByText(`Artifact status: ${status}`, { exact: true })).toBeVisible();
  }
  await checkInUi(revokedPayload, 'revoked'); await checkInUi(outdatedPayload, 'valid');
  verificationOffset += 25 * 60 * 60 * 1000;
  await checkInUi(outdatedPayload, 'expired'); verificationOffset = 0;
  const tampered = JSON.parse(outdatedPayload); tampered.iss = 'untrusted';
  await checkInUi(JSON.stringify(tampered), 'invalid');
  await nav('Students'); await page.getByRole('button', { name: 'View Fictional Edited Learner', exact: true }).click();
  await page.getByRole('button', { name: 'Edit student', exact: true }).click();
  await page.getByLabel('Student name', { exact: true }).fill('Fictional Revised Learner');
  await page.getByRole('button', { name: 'Save student', exact: true }).click();
  await expect(page.getByText('Student saved.', { exact: false })).toBeVisible();
  await checkInUi(outdatedPayload, 'outdated');
  await nav('Compliance'); await expect(page.getByText('Stale — reevaluation required.', { exact: false })).toBeVisible();
  stage = 'responsive and role isolation';
  await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test-results/review-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const tableRegion = page.getByRole('region', { name: 'Programme / year data table' });
  await tableRegion.focus();
  await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
  await expect(tableRegion).toBeFocused();
  assert(await tableRegion.evaluate(element => element.scrollWidth > element.clientWidth));
  assert(await tableRegion.evaluate(element => getComputedStyle(element).outlineStyle !== 'none'));
  await page.screenshot({ path: path.join(root, 'test-results/review-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const cookies = await context.cookies();
  assert(cookies.some(cookie => cookie.name === 'eduverify.sid' && cookie.httpOnly && cookie.sameSite === 'Strict'));
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  assert.equal((await api('/v1/students')).status(), 401);
  for (const [email, role] of [['operator@demo.example', 'institution_operator'], ['reviewer@demo.example', 'regulatory_reviewer'], ['verifier@demo.example', 'authorized_verifier'], ['admin2@demo.example', 'institution_admin']]) {
    await login(email);
    if (role === 'institution_operator') assert.equal((await (await api('/v1/students')).json()).total, 2);
    else if (email === 'admin2@demo.example') {
      assert.equal((await (await api('/v1/students')).json()).total, 0);
      assert.equal((await api(`/v1/students/${record.id}`)).status(), 404);
      assert.equal((await api('/v1/students?institutionId=DEMO-INST-001')).status(), 403);
      assert.equal((await api('/v1/verification/issue', 'POST', { studentId: record.id })).status(), 404);
    } else {
      await expect(page.getByRole('navigation').getByRole('button', { name: 'Students', exact: true })).toHaveCount(0);
      for (const endpoint of ['/v1/students', '/v1/compliance/summary']) assert.equal((await api(endpoint)).status(), 403);
      assert.equal((await api('/v1/ml/evaluate', 'POST', {})).status(), 403);
      assert.equal((await api('/v1/verification/issue', 'POST', { studentId: record.id })).status(), 403);
    }
    await page.getByRole('button', { name: 'Logout', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  }
  stage = 'expiry and restart recovery';
  await login('admin@demo.example');
  await expect(page.getByText('Student records', { exact: true })).toBeVisible();
  timeOffset += 31 * 60 * 1000;
  await nav('Students'); await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByText('Session expired. Please sign in again.', { exact: true })).toBeVisible();
  await stopBackend();
  restartedStore=fixture.config?new MySqlStore({config:fixture.config}):new JsonStore({dataDirectory:path.join(directory,'data')});
  backend = createApp({ ...appOptions, store:restartedStore }).listen(backendPort, '127.0.0.1');
  await new Promise(resolve => backend.once('listening', resolve));
  assert.equal((await api('/auth/me')).status(), 401);
  assert.equal((await verify(revokedPayload)).status, 'revoked');
  assert.equal((await verify(outdatedPayload)).status, 'outdated');
  assert.equal((await restartedStore.readCollection('students')).length, 2);
  assert.deepEqual(pageErrors, []);
  completed = true;
} catch (error) {
  const summary = error.message.split('\n')[0].replaceAll(password, '[redacted]').replaceAll(key, '[redacted]');
  if (stage === 'compliance evaluation' && context) {
    const failurePage = context.pages().at(-1);
    const alerts = await failurePage.getByRole('alert').allTextContents();
    console.error(`Compliance UI alerts: ${JSON.stringify(alerts)}`);
  }
  console.error(`Browser review failed at: ${stage}. ${error.name}: ${summary}. No credentials or request bodies logged.`);
  if (context) {
    await fs.mkdir(path.join(root, 'test-results'), { recursive: true });
    await context.pages().at(-1).screenshot({ path: path.join(root, 'test-results/review-failure.png'), fullPage: true }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  if (context) await context.close();
  if (vite) await vite.close();
  await stopBackend(); await stopPython();
  if(restartedStore?.close)await restartedStore.close();
  if(fixture)await fixture.cleanup();
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith('.tmp-e2e-')) throw new Error('Unsafe cleanup target');
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
if (completed) console.log('PASS: real browser + Vite + Express + Python; all roles, forms, CSV, compliance/staleness, ML success/stopped-service failure/recovery, QR PNG/tampering/expiry/revocation/outdated, keyboard/modal, mobile layout, expiry/logout, restart persistence and cleanup.');
