// Real HTTP integration using temporary fictional data and ephemeral credentials.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const { randomBytes, randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { createApp } = require('../server');
const { MlClient } = require('../ml/client');
const { JsonStore } = require('../storage/json-store');
const { seedDemoAccounts } = require('./seed-accounts');
const { smokeStore } = require('../storage/smoke-store');

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const projectRoot = path.resolve(__dirname, '../..');
  const testRoot = path.join(projectRoot, 'backend/test');
  const directory = await fs.mkdtemp(path.join(testRoot, '.tmp-ml-smoke-'));
  const key = randomBytes(32).toString('hex');
  const password = randomBytes(20).toString('hex');
  const port = await availablePort();
  let child;
  let server;
  let fixture;
  try {
    const python = path.join(projectRoot, 'ml-service/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    await fs.access(python);
    child = spawn(python, ['-m', 'uvicorn', 'ml_app.api:app', '--host', '127.0.0.1', '--port', String(port), '--no-access-log'],
      { cwd: path.join(projectRoot, 'ml-service'), windowsHide: true,
        env: { ...process.env, ML_SERVICE_KEY: key, ML_MODEL_DIR: 'ml-service/artifacts' }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.resume();
    let spawnError;
    child.once('error', (error) => { spawnError = error; });
    const mlUrl = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (spawnError || child.exitCode !== null) throw new Error('ML service failed to start; check environment and trained artifacts');
      try { ready = (await fetch(`${mlUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { /* Wait for local startup. */ }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert(ready, 'ML health did not become ready');
    const headers = { 'X-ML-Service-Key': key, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${mlUrl}/model/info`, { headers })).status, 200);
    const records = [{ active_record_count: 80, intake_ratio: 0.72, year_over_year_change: 0.03, admission_year_concentration: 0.8 },
      { active_record_count: 4000, intake_ratio: 5, year_over_year_change: 2, admission_year_concentration: 0.1 }];
    assert.equal((await fetch(`${mlUrl}/predict`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) })).status, 401);
    const prediction = await fetch(`${mlUrl}/predict`, { method: 'POST', headers, body: JSON.stringify({ records }) });
    assert.equal(prediction.status, 200);
    const predicted = await prediction.json();
    assert.equal(predicted.results[0].review_flag, false);
    assert.equal(predicted.results[1].review_flag, true);

    fixture=await smokeStore(directory);
    const {store}=fixture;
    await seedDemoAccounts({ store, password });
    await store.writeCollection('students', [{ id: randomUUID(), apaarId: '000000000001', studentName: 'Fictional Smoke Learner',
      institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027',
      admissionYear: '2026', admissionCategory: 'general', status: 'active', createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),createdBy:'DEMO-USER-ADMIN',updatedBy:'DEMO-USER-ADMIN' }]);
    server = createApp({ store, mlOptions: { client: new MlClient({ key, url: mlUrl, timeoutMs: 10000 }) } }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const csrfResponse = await fetch(`${base}/api/auth/csrf`);
    let cookie = csrfResponse.headers.getSetCookie()[0].split(';')[0];
    const csrf = await csrfResponse.json();
    const loggedIn = await fetch(`${base}/api/auth/login`, { method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrfToken },
      body: JSON.stringify({ email: 'admin@demo.example', password }) });
    assert.equal(loggedIn.status, 200);
    cookie = loggedIn.headers.getSetCookie()[0].split(';')[0];
    const auth = await loggedIn.json();
    const evaluated = await fetch(`${base}/api/v1/ml/evaluate`, { method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': auth.csrfToken }, body: '{}' });
    assert.equal(evaluated.status, 200);
    const body = await evaluated.json();
    assert.equal(body.source, 'ml_anomaly');
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].institutionId, 'DEMO-INST-001');
    assert.equal(body.stale, false);
    console.log(JSON.stringify({ smoke: 'passed', health: 'ok', privateApi: 'enforced',
      syntheticNormalFlag: predicted.results[0].review_flag, syntheticUnusualFlag: predicted.results[1].review_flag,
      expressGroupsEvaluated: body.results.length, modelVersion: body.modelVersion }));
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    if (child && child.exitCode === null) {
      await new Promise((resolve) => { child.once('exit', resolve); child.kill(); });
    }
    if(fixture)await fixture.cleanup();
    if (path.dirname(directory) !== testRoot || !path.basename(directory).startsWith('.tmp-ml-smoke-')) throw new Error('Unsafe cleanup target');
    await fs.rm(directory, { recursive: true, force: true });
  }
}

main().catch(() => { console.error('ML smoke test failed; check Python setup, training and local service availability.'); process.exitCode = 1; });
