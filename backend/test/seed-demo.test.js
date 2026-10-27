const fs = require('node:fs/promises');
const path = require('node:path');
const { JsonStore } = require('../storage/json-store');
const { seedDemoData } = require('../scripts/seed-demo');

const testDataDirectory = path.join(__dirname, '.tmp-seed-data');

beforeEach(async () => {
  await fs.rm(testDataDirectory, { recursive: true, force: true });
});

afterAll(async () => {
  await fs.rm(testDataDirectory, { recursive: true, force: true });
});

test('demo seed is repeatable and only creates fictional reference data', async () => {
  const store = new JsonStore({ dataDirectory: testDataDirectory });

  await seedDemoData(store);
  await seedDemoData(store);

  await expect(store.readCollection('institutions')).resolves.toHaveLength(2);
  await expect(store.readCollection('programmes')).resolves.toHaveLength(2);
  await expect(store.readCollection('approved-intakes')).resolves.toHaveLength(2);
});
