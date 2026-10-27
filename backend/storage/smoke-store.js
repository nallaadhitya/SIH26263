const { JsonStore } = require('./json-store');
const { createTestDatabase } = require('./test-database');
async function smokeStore(directory) {
  const driver=process.env.SMOKE_STORAGE_DRIVER || process.env.STORAGE_DRIVER || 'json';
  if(driver==='mysql')return createTestDatabase();
  if(driver!=='json')throw new Error('Unknown smoke storage driver');
  return {store:new JsonStore({dataDirectory:directory}),async cleanup(){}};
}
module.exports={smokeStore};
