const { MlClient, MlError, MODEL_VERSION } = require('../ml/client');
const { buildFeatures } = require('../ml/features');
const { DEMO_RECORDS } = require('../scripts/seed-demo');
const { randomBytes, randomUUID } = require('node:crypto');

const key = randomBytes(32).toString('hex');
const normal = { active_record_count: 80, intake_ratio: 0.8, year_over_year_change: null, admission_year_concentration: 1 };
const result = (records) => ({ model_version: MODEL_VERSION, source: 'ml_anomaly', threshold: 0.6,
  results: records.map((record, index) => ({ index, anomaly_score: 0.4, review_flag: false,
    missing_features: ['intake_ratio', 'year_over_year_change', 'admission_year_concentration'].filter((name) => record[name] === null) })) });

test('adapter sends only feature records with private key and validates the response', async () => {
  const fetchImpl = jest.fn(async () => Response.json(result([normal])));
  const client = new MlClient({ key, fetchImpl });
  expect(await client.predict([normal])).toEqual(result([normal]));
  const [url, options] = fetchImpl.mock.calls[0];
  expect(url.href).toBe('http://127.0.0.1:8000/predict');
  expect(options.headers['X-ML-Service-Key']).toBe(key);
  expect(JSON.parse(options.body)).toEqual({ records: [normal] });
  expect(options.redirect).toBe('error');
});

test('timeouts are explicit failures, never normal predictions', async () => {
  const fetchImpl = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await expect(new MlClient({ key, timeoutMs: 10, fetchImpl }).predict([normal])).rejects.toMatchObject({ status: 504 });
});

test('unavailability, non-success statuses and invalid content types fail safely', async () => {
  await expect(new MlClient({ key, fetchImpl: async () => { throw new Error('Private hostname'); } }).predict([normal]))
    .rejects.toMatchObject({ status: 503, message: 'ML service is unavailable' });
  for (const [response, status] of [[new Response('private', { status: 503 }), 503],
    [new Response('private', { status: 500 }), 502], [new Response('plain'), 502]]) {
    await expect(new MlClient({ key, fetchImpl: async () => response }).predict([normal])).rejects.toMatchObject({ status });
  }
});

test.each([
  { model_version: 'wrong' }, { source: 'compliance' }, { threshold: null }, { results: [] },
  { passwordHash: 'private' },
  { results: [{ index: 1, anomaly_score: 0.4, review_flag: false, missing_features: [] }] },
  { results: [{ index: 0, anomaly_score: 0.7, review_flag: false, missing_features: ['year_over_year_change'] }] },
  { results: [{ index: 0, anomaly_score: -1, review_flag: false, missing_features: [] }] },
])('malformed model response is rejected: %j', async (override) => {
  const client = new MlClient({ key, fetchImpl: async () => Response.json({ ...result([normal]), ...override }) });
  await expect(client.predict([normal])).rejects.toBeInstanceOf(MlError);
});

test('invalid JSON and oversized responses are bounded', async () => {
  for (const text of ['{broken', 'x'.repeat(64 * 1024 + 1)]) {
    const client = new MlClient({ key, fetchImpl: async () => new Response(text, { headers: { 'content-type': 'application/json' } }) });
    await expect(client.predict([normal])).rejects.toMatchObject({ status: 502 });
  }
});

test('untrusted remote URLs, missing configuration, and out-of-range features fail before network access', async () => {
  const fetchImpl = jest.fn();
  for (const url of ['https://example.com', 'http://192.168.1.1:8000', 'http://user@127.0.0.1', 'http://127.0.0.1/x', 'not-url']) {
    await expect(new MlClient({ key, url, fetchImpl }).predict([normal])).rejects.toMatchObject({ status: 503 });
  }
  await expect(new MlClient({ key: '', fetchImpl }).predict([normal])).rejects.toMatchObject({ status: 503 });
  for (const records of [[], [normal, ...Array(100).fill(normal)], [{ ...normal, intake_ratio: 21 }]]) {
    await expect(new MlClient({ key, fetchImpl }).predict(records)).rejects.toMatchObject({ status: 422 });
  }
  expect(fetchImpl).not.toHaveBeenCalled();
});

function fixture() {
  const row = { id: randomUUID(), apaarId: '000000000001', studentName: 'Fictional Learner',
    institutionId: 'DEMO-INST-001', programmeId: 'DEMO-PROG-001', academicYear: '2026-2027',
    admissionYear: '2026', admissionCategory: 'general', status: 'active' };
  return { institutionId: 'DEMO-INST-001', students: [row],
    institutions: structuredClone(DEMO_RECORDS.institutions), programmes: structuredClone(DEMO_RECORDS.programmes),
    approvedIntakes: structuredClone(DEMO_RECORDS['approved-intakes']) };
}

test('intake ratio is absent without explicit policy, complete counts, or positive capacity', () => {
  const inputs = fixture();
  expect(buildFeatures(inputs).groups[0].features.intake_ratio).toBeCloseTo(1 / 60);
  delete inputs.approvedIntakes[0].countingPolicy;
  expect(buildFeatures(inputs).groups[0].features.intake_ratio).toBeNull();
  inputs.approvedIntakes = structuredClone(DEMO_RECORDS['approved-intakes']);
  inputs.approvedIntakes[0].approvedSeats = 0;
  expect(buildFeatures(inputs).groups[0].features.intake_ratio).toBeNull();
  inputs.approvedIntakes[0].approvedSeats = 60;
  inputs.students.push({ ...inputs.students[0], id: randomUUID() });
  expect(buildFeatures(inputs).groups[0].features.intake_ratio).toBeNull();
});

test('history requires consecutive years, known positive previous counts and comparable policies', () => {
  const inputs = fixture();
  expect(buildFeatures(inputs).groups[0].features.year_over_year_change).toBeNull();
  inputs.students.push({ ...inputs.students[0], id: randomUUID(), apaarId: '000000000002', academicYear: '2025-2026', admissionYear: '2025' });
  const previous = structuredClone(inputs.approvedIntakes[0]);
  previous.id = 'DEMO-PREVIOUS';
  previous.academicYear = '2025-2026';
  previous.countingPolicy.admissionYearRange = { min: '2025', max: '2025' };
  inputs.approvedIntakes.push(previous);
  const current = () => buildFeatures(inputs).groups.find((group) => group.academicYear === '2026-2027').features;
  expect(current().year_over_year_change).toBe(0);
  previous.countingPolicy.includedStatuses = ['inactive'];
  expect(current().year_over_year_change).toBeNull();
});

test('concentration handles missing admission years and invalid groups are reported', () => {
  const inputs = fixture();
  inputs.students[0].admissionYear = null;
  inputs.students.push({ ...inputs.students[0], programmeId: 'UNKNOWN' });
  const output = buildFeatures(inputs);
  expect(output.skippedRecords).toBe(1);
  expect(output.groups[0].features.admission_year_concentration).toBeNull();
  expect(Object.keys(output.groups[0].features)).toEqual([
    'active_record_count', 'intake_ratio', 'year_over_year_change', 'admission_year_concentration',
  ]);
});
