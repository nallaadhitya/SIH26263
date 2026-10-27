require('dotenv').config({quiet:true});
const { createStorage } = require('../storage');

// Fictional demonstration policy only; not a statement of government/quota rules.
const DEMO_COUNTING_POLICY = {
  includedStatuses: ['active'],
  categoryTreatment: { general: 'counted', obc: 'counted', sc: 'counted', st: 'counted',
    ews: 'counted', other: 'counted', not_specified: 'counted' },
  admissionYearRange: { min: '2026', max: '2026' },
};

const DEMO_RECORDS = {
  institutions: [
    {
      id: 'DEMO-INST-001',
      name: 'Riverdale Institute of Technology',
      city: 'Example Nagar',
      status: 'active',
    },
    {
      id: 'DEMO-INST-002',
      name: 'Meadowbrook College of Arts',
      city: 'Samplepur',
      status: 'active',
    },
  ],
  programmes: [
    {
      id: 'DEMO-PROG-001',
      institutionId: 'DEMO-INST-001',
      name: 'Bachelor of Technology in Computing',
      level: 'undergraduate',
    },
    {
      id: 'DEMO-PROG-002',
      institutionId: 'DEMO-INST-002',
      name: 'Bachelor of Arts in Communication',
      level: 'undergraduate',
    },
  ],
  'approved-intakes': [
    {
      id: 'DEMO-INTAKE-001',
      programmeId: 'DEMO-PROG-001',
      academicYear: '2026-2027',
      approvedSeats: 60,
      countingPolicy: DEMO_COUNTING_POLICY,
    },
    {
      id: 'DEMO-INTAKE-002',
      programmeId: 'DEMO-PROG-002',
      academicYear: '2026-2027',
      approvedSeats: 40,
      countingPolicy: DEMO_COUNTING_POLICY,
    },
  ],
};

async function seedDemoData(store = createStorage()) {
  const operation=async()=>{
  for (const [collection, demoRecords] of Object.entries(DEMO_RECORDS)) {
    await store.updateCollection(collection, (existingRecords) => {
      const existingIds = new Set(existingRecords.map((record) => record.id));
      return [...existingRecords, ...demoRecords.filter((record) => !existingIds.has(record.id))];
    });
  }
  };
  return store.transaction?store.transaction(operation):operation();
}

if (require.main === module) {
  const store=createStorage();
  seedDemoData(store)
    .then(() => console.log('Fictional demo data seeded successfully.'))
    .catch((error) => {
      console.error('Demo seed failed; check local storage configuration and references.');
      process.exitCode = 1;
    }).finally(async()=>{if(store.close)await store.close();});
}

module.exports = { DEMO_RECORDS, seedDemoData };
