require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createStorage } = require('../storage');
const { seedDemoData } = require('./seed-demo');

const DEMO_ACCOUNTS = Object.freeze([
  { id: 'DEMO-USER-ADMIN', displayName: 'Fictional Institution Admin', email: 'admin@demo.example', role: 'institution_admin', institutionId: 'DEMO-INST-001' },
  { id: 'DEMO-USER-OPERATOR', displayName: 'Fictional Institution Operator', email: 'operator@demo.example', role: 'institution_operator', institutionId: 'DEMO-INST-001' },
  { id: 'DEMO-USER-ADMIN-2', displayName: 'Fictional Second Institution Admin', email: 'admin2@demo.example', role: 'institution_admin', institutionId: 'DEMO-INST-002' },
  { id: 'DEMO-USER-REVIEWER', displayName: 'Fictional Regulatory Reviewer', email: 'reviewer@demo.example', role: 'regulatory_reviewer', institutionId: null },
  { id: 'DEMO-USER-VERIFIER', displayName: 'Fictional Authorized Verifier', email: 'verifier@demo.example', role: 'authorized_verifier', institutionId: null },
]);

async function seedDemoAccounts({ store = createStorage(), password = process.env.DEMO_ACCOUNT_PASSWORD } = {}) {
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password) > 72) {
    throw new Error('Set DEMO_ACCOUNT_PASSWORD locally to a password of 12 characters minimum and 72 bytes maximum.');
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const operation=async()=>{
  await seedDemoData(store);
  await store.updateCollection('users', (users) => {
    const timestamp = new Date().toISOString();
    const result = [...users];
    for (const account of DEMO_ACCOUNTS) {
      const existing = result.find((user) => user.id === account.id || user.email === account.email);
      if (existing) {
        if (existing.id !== account.id || existing.email !== account.email) {
          throw new Error('Demo account identifier conflict; existing users were preserved.');
        }
        continue;
      }
      result.push({ ...account, passwordHash, status: 'active', createdAt: timestamp, updatedAt: timestamp });
    }
    return result;
  });
  };
  return store.transaction?store.transaction(operation):operation();
}

if (require.main === module) {
  const store=createStorage();
  seedDemoAccounts({store}).then(() => console.log('Fictional demo accounts seeded; existing accounts preserved.'))
    .catch(() => {
      console.error('Account seed failed. Check local DEMO_ACCOUNT_PASSWORD configuration and data integrity.');
      process.exitCode = 1;
    }).finally(async()=>{if(store.close)await store.close();});
}

module.exports = { DEMO_ACCOUNTS, seedDemoAccounts };
