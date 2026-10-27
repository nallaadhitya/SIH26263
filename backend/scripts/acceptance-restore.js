// Real dump/restore of two newly generated, disposable test schemas only.
// No normal application configuration, data or credentials are used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomBytes } = require('node:crypto');
const request = require('supertest');
const { createTestDatabase } = require('../storage/test-database');
const { COLLECTIONS } = require('../storage/json-store');
const { seedDemoAccounts } = require('./seed-accounts');
const { createApp } = require('../server');
const { SigningKeys } = require('../verification/crypto');

const project = path.resolve(__dirname, '../..');
let directory;
const fixtures = [];
async function main() {
  assert.equal(process.env.ALLOW_MYSQL_TESTS, '1', 'Explicit test authorization required');
  const source = await createTestDatabase(); fixtures.push(source);
  const target = await createTestDatabase(); fixtures.push(target);
  for (const fixture of fixtures) {
    assert.match(fixture.database, /^eduverify_test_[a-f0-9]{16}$/);
    const [[row]] = await fixture.admin.query('SELECT @@datadir AS directory');
    assert.equal(path.resolve(row.directory), path.join(project, '.local/mysql/data'));
  }
  assert.notEqual(source.database, target.database);
  const password = randomBytes(24).toString('hex');
  await seedDemoAccounts({ store: source.store, password });
  await source.store.updateCollection('approved-intakes', rows => rows.map(row => ({ ...row, approvedSeats: 0 })));
  const signingKey = randomBytes(32).toString('base64');
  const signing = new SigningKeys({ keys: { drill: signingKey }, activeId: 'drill', forbiddenSecrets: [] });
  const app = createApp({ store: source.store, verificationOptions: { signing } });
  const agent = request.agent(app);
  const csrf = await agent.get('/api/auth/csrf');
  const login = await agent.post('/api/auth/login').set('X-CSRF-Token', csrf.body.csrfToken)
    .send({ email: 'admin@demo.example', password });
  assert.equal(login.status, 200);
  const post = (url, body) => agent.post(url).set('X-CSRF-Token', login.body.csrfToken).send(body);
  const created = await post('/api/v1/students', { apaarId: '000000000091', studentName: 'Fictional Restore Learner',
    programmeId: 'DEMO-PROG-001', academicYear: '2026-2027', admissionYear: '2026' });
  assert.equal(created.status, 201);
  const studentId = created.body.student.id;
  const issue = async () => {
    const result = await post('/api/v1/verification/issue', { studentId });
    assert.equal(result.status, 201); return result.body;
  };
  const revoked = await issue(); const outdated = await issue();
  assert.equal((await post('/api/v1/verification/revoke', { artifactId: revoked.artifactId })).status, 200);
  assert.equal((await agent.patch(`/api/v1/students/${studentId}`).set('X-CSRF-Token', login.body.csrfToken)
    .send({ studentName: 'Fictional Restored Revision' })).status, 200);
  const valid = await issue();
  const evaluation = await post('/api/v1/compliance/evaluate', {});
  assert.equal(evaluation.status, 200);
  assert.equal(evaluation.body.summary.findingsByRule.INTAKE_EXCEEDED, 1);

  // CLI credentials are read from a mode-600 ignored option file, never argv/stdout.
  await fs.mkdir(path.join(project, '.local'), { recursive: true });
  directory = await fs.mkdtemp(path.join(project, '.local/restore-drill-'));
  const configPath = path.resolve(project, process.env.MYSQL_TEST_CONFIG || '.local/mysql/test-config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.match(config.adminPassword, /^[a-f0-9]{64}$/);
  assert.equal(config.port, 33307);
  const options = path.join(directory, 'client.cnf');
  const dump = path.join(directory, 'fictional.sql');
  await fs.writeFile(options, `[client]\nhost=127.0.0.1\nport=33307\nuser=root\npassword=${config.adminPassword}\n`, { mode: 0o600, flag: 'wx' });
  await promisify(execFile)('mysqldump', [`--defaults-extra-file=${options}`, '--single-transaction', '--no-tablespaces',
    '--set-gtid-purged=OFF', `--result-file=${dump}`, source.database], { windowsHide: true });
  assert((await fs.stat(dump)).size > 0);
  const dumpText = await fs.readFile(dump, 'utf8');
  for (const secret of [password, signingKey, config.adminPassword, config.appPassword]) {
    assert(!dumpText.includes(secret), 'Secrets must not be stored in a database dump');
  }
  await new Promise((resolve, reject) => {
    const child = spawn('mysql', [`--defaults-extra-file=${options}`, '--binary-mode', target.database],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const stream = createReadStream(dump);
    const fail = error => { stream.destroy(); child.kill(); reject(error); };
    stream.once('error', fail); child.once('error', fail); child.stdin.once('error', fail);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Restore CLI failed')));
    stream.pipe(child.stdin);
  });
  await target.store.ready(); // Restored checksummed migration ledger.
  const counts = {};
  for (const collection of COLLECTIONS) {
    const original = await source.store.readCollection(collection);
    assert.deepEqual(await target.store.readCollection(collection), original);
    counts[collection] = original.length;
  }
  const tables = ['institutions', 'programmes', 'approved_intakes', 'users', 'students', 'compliance_evaluations',
    'compliance_findings', 'verification_records', 'legacy_records', 'json_imports', 'schema_migrations', 'storage_mutex'];
  const sqlCounts = {};
  for (const table of tables) {
    const [[before]] = await source.store.pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    const [[after]] = await target.store.pool.query(`SELECT COUNT(*) AS total FROM ${table}`);
    assert.equal(after.total, before.total); sqlCounts[table] = after.total;
  }
  const [[orphans]] = await target.store.pool.query(`SELECT COUNT(*) AS total FROM students s
    LEFT JOIN programmes p ON p.id=s.programme_id AND p.institution_id=s.institution_id
    LEFT JOIN users u ON u.id=s.created_by WHERE p.id IS NULL OR u.id IS NULL`);
  assert.equal(orphans.total, 0);
  const [[artifactOrphans]] = await target.store.pool.query(`SELECT COUNT(*) AS total FROM verification_records v
    LEFT JOIN students s ON s.id=v.student_id LEFT JOIN institutions i ON i.id=v.institution_id
    WHERE s.id IS NULL OR i.id IS NULL`);
  assert.equal(artifactOrphans.total, 0);
  const restoredApp = createApp({ store: target.store, verificationOptions: { signing } });
  for (const [artifact, status] of [[valid, 'valid'], [outdated, 'outdated'], [revoked, 'revoked']]) {
    const response = await request(restoredApp).post('/api/v1/verification/verify').send({ payload: artifact.payload });
    assert.equal(response.status, 200); assert.equal(response.body.status, status);
  }
  const restoredAgent = request.agent(restoredApp);
  const restoredCsrf = await restoredAgent.get('/api/auth/csrf');
  assert.equal((await restoredAgent.post('/api/auth/login').set('X-CSRF-Token', restoredCsrf.body.csrfToken)
    .send({ email: 'admin@demo.example', password })).status, 200);
  const summary = await restoredAgent.get('/api/v1/compliance/summary');
  assert.equal(summary.status, 200); assert.equal(summary.body.stale, false);
  assert.equal(summary.body.evaluation.id, evaluation.body.evaluation.id);
  assert.equal(summary.body.summary.findingsByRule.INTAKE_EXCEEDED, 1);
  return { collections: counts, tables: sqlCounts };
}

(async () => {
  let result;
  try { result = await main(); }
  finally {
    for (const fixture of fixtures.reverse()) await fixture.cleanup();
    if (directory) {
      assert.equal(path.dirname(directory), path.join(project, '.local'));
      assert(path.basename(directory).startsWith('restore-drill-'));
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  console.log(`PASS: real mysqldump/mysql restore, exact collection/table counts, relationships, fresh compliance and valid/outdated/revoked QR states; isolated databases/files cleaned. ${JSON.stringify(result)}`);
})().catch(() => {
  console.error('Restore acceptance failed. No SQL contents, credentials or private keys displayed. Check local prerequisites and rerun.');
  process.exitCode = 1;
});
