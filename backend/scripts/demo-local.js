// Disposable SIH demo. Only generated test schemas and owned child processes.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const net = require('node:net');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { createTestDatabase } = require('../storage/test-database');
const { seedDemoAccounts } = require('./seed-accounts');

const project = path.resolve(__dirname, '../..');
const children = new Map();
let fixture; let input;
let failure = false;
async function stop(name) {
  const child = children.get(name); children.delete(name);
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => { child.once('exit', resolve); child.kill(); });
  }
}
async function cleanup() {
  if (input) input.close();
  for (const name of ['frontend', 'backend', 'python']) await stop(name);
  if (fixture) { const owned = fixture; fixture = null; await owned.cleanup(); }
}
async function availablePort(port) {
  const probe = net.createServer();
  await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(port, '127.0.0.1', resolve); });
  await new Promise(resolve => probe.close(resolve));
}
async function start(name, binary, args, cwd, env, health) {
  await stop(name);
  const child = spawn(binary, args, { cwd, env, windowsHide: true, stdio: 'ignore' });
  children.set(name, child);
  let spawnError;
  child.once('error', error => { spawnError = error; });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawnError || child.exitCode !== null) throw new Error('Demo service startup failed');
    try {
      const response = await fetch(health, { signal: AbortSignal.timeout(500) });
      if (response.ok) { console.log(`${name}: ready`); return; }
    } catch { /* Bounded readiness polling, no success fallback. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Demo service readiness failed');
}
async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Unknown demo option');
  const check = process.argv.includes('--check');
  await Promise.all([5000, 5173, 8000].map(availablePort));
  const python = path.join(project, 'ml-service/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await fs.access(python); await fs.access(path.join(project, 'ml-service/artifacts/model.joblib'));
  fixture = await createTestDatabase();
  const password = check ? randomBytes(24).toString('hex') : process.env.DEMO_ACCOUNT_PASSWORD;
  await seedDemoAccounts({ store: fixture.store, password });
  await seedDemoAccounts({ store: fixture.store, password });
  assert.equal((await fixture.store.readCollection('users')).length, 5);
  await fixture.store.updateCollection('approved-intakes', rows => rows.map(row => row.programmeId === 'DEMO-PROG-001'
    ? { ...row, approvedSeats: 1 } : row));
  const env = { ...process.env, NODE_ENV: 'development', STORAGE_DRIVER: 'mysql',
    MYSQL_HOST: fixture.config.host, MYSQL_PORT: String(fixture.config.port), MYSQL_DATABASE: fixture.database,
    MYSQL_USER: fixture.config.user, MYSQL_PASSWORD: fixture.config.password,
    PORT: '5000', APP_ORIGIN: 'http://127.0.0.1:5173', COOKIE_SECURE: 'false',
    SESSION_SECRET: randomBytes(32).toString('hex'), ML_SERVICE_KEY: randomBytes(32).toString('hex'),
    ML_SERVICE_URL: 'http://127.0.0.1:8000', ML_MODEL_DIR: 'ml-service/artifacts',
    QR_ACTIVE_KEY_ID: 'demo', QR_SIGNING_KEYS: JSON.stringify({ demo: randomBytes(32).toString('base64') }) };
  // Migration/root credentials and the supplied demo password are not needed by services.
  delete env.MYSQL_MIGRATION_USER; delete env.MYSQL_MIGRATION_PASSWORD; delete env.DEMO_ACCOUNT_PASSWORD;
  const startPython = () => start('python', python,
    ['-m', 'uvicorn', 'ml_app.api:app', '--host', '127.0.0.1', '--port', '8000', '--no-access-log'],
    path.join(project, 'ml-service'), env, 'http://127.0.0.1:8000/health');
  const startBackend = () => start('backend', process.execPath, ['server.js'], path.join(project, 'backend'), env,
    'http://127.0.0.1:5000/api/health');
  await startPython(); await startBackend();
  await start('frontend', process.execPath, [path.join(project, 'frontend/node_modules/vite/bin/vite.js'),
    '--host', '127.0.0.1', '--port', '5173', '--strictPort'], path.join(project, 'frontend'), env, 'http://127.0.0.1:5173');
  if (check) {
    await stop('python');
    await assert.rejects(fetch('http://127.0.0.1:8000/health', { signal: AbortSignal.timeout(1000) }));
    await startPython(); await startBackend();
    assert.equal((await fixture.store.readCollection('users')).length, 5);
    console.log('Demo startup, ML stop/recovery and Express restart checks completed.');
    return;
  }
  console.log('Fictional MySQL demo ready: http://127.0.0.1:5173. Use your locally supplied password.');
  console.log('Commands: ml-stop | ml-start | restart | stop. Stop deletes only this disposable demo schema.');
  input = readline.createInterface({ input: process.stdin, output: process.stdout });
  // Serial command handling prevents overlapping stop/restart operations.
  for await (const line of input) {
    switch (line.trim()) {
      case 'ml-stop': await stop('python'); console.log('Python stopped; ML requests must fail explicitly.'); break;
      case 'ml-start': await startPython(); break;
      case 'restart': await startBackend(); console.log('Express restarted; sign in again. MySQL records retained.'); break;
      case 'stop': return;
      default: console.log('Commands: ml-stop | ml-start | restart | stop.');
    }
  }
}
// Signals close input, allowing the serialized command loop to finish and clean up.
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  if (input) input.close();
  else { failure = true; cleanup().finally(() => process.exit(1)); }
});
(async () => {
  try { await main(); }
  catch { failure = true; console.error('Demo failed. Check free ports 5000/5173/8000, test MySQL, Python/model, dependencies and local password. No secrets displayed.'); }
  finally { await cleanup(); }
  if (failure) process.exitCode = 1;
  else console.log('Demo finished; owned services and disposable database cleaned.');
})().catch(() => { console.error('Demo cleanup failed; inspect the isolated test instance before rerunning.'); process.exitCode = 1; });
