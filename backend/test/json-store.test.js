const fs = require('node:fs/promises');
const path = require('node:path');
const { DataCorruptionError, JsonStore, UnknownCollectionError } = require('../storage/json-store');

const testDataDirectory = path.join(__dirname, '.tmp-data');

async function resetTestData() {
  await fs.rm(testDataDirectory, { recursive: true, force: true });
}

beforeEach(resetTestData);
afterAll(resetTestData);

describe('JsonStore', () => {
  test('initializes a missing collection as an empty JSON array', async () => {
    const store = new JsonStore({ dataDirectory: testDataDirectory });

    await expect(store.readCollection('users')).resolves.toEqual([]);
    await expect(fs.readFile(path.join(testDataDirectory, 'users.json'), 'utf8')).resolves.toBe('[]\n');
  });

  test('reads and writes collection records', async () => {
    const store = new JsonStore({ dataDirectory: testDataDirectory });
    const records = [{ id: 'DEMO-USER-001', displayName: 'Demo User' }];

    await store.writeCollection('users', records);

    await expect(store.readCollection('users')).resolves.toEqual(records);
  });

  test('serializes concurrent updates to the same collection', async () => {
    const store = new JsonStore({ dataDirectory: testDataDirectory });

    await Promise.all(
      Array.from({ length: 20 }, (_, index) => store.updateCollection('audit-logs', (records) => [
        ...records,
        { id: `DEMO-AUDIT-${index}` },
      ])),
    );

    const records = await store.readCollection('audit-logs');
    expect(records).toHaveLength(20);
    expect([...new Set(records.map((record) => record.id))]).toHaveLength(20);
  });

  test('rejects malformed JSON without replacing the corrupted file', async () => {
    const store = new JsonStore({ dataDirectory: testDataDirectory });
    await fs.mkdir(testDataDirectory, { recursive: true });
    const filePath = path.join(testDataDirectory, 'students.json');
    await fs.writeFile(filePath, '{not valid JSON', 'utf8');

    await expect(store.readCollection('students')).rejects.toBeInstanceOf(DataCorruptionError);
    await expect(fs.readFile(filePath, 'utf8')).resolves.toBe('{not valid JSON');
  });

  test('preserves the last completed file if an interrupted write leaves a temporary file', async () => {
    const store = new JsonStore({ dataDirectory: testDataDirectory });
    await store.writeCollection('institutions', [{ id: 'DEMO-INST-OLD' }]);
    await fs.writeFile(path.join(testDataDirectory, '.institutions.json.interrupted.tmp'), '[{', 'utf8');

    await expect(store.readCollection('institutions')).resolves.toEqual([{ id: 'DEMO-INST-OLD' }]);
  });

  test('rejects unknown collections', async () => {
    const store = new JsonStore({ dataDirectory: testDataDirectory });

    await expect(store.readCollection('../outside-project')).rejects.toBeInstanceOf(UnknownCollectionError);
  });
});
