const fs = require('node:fs/promises');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { randomBytes } = require('node:crypto');
const { MySqlStore } = require('./mysql-store');
const { migrate } = require('./mysql-migrations');

async function createTestDatabase() {
  if (process.env.ALLOW_MYSQL_TESTS !== '1') throw new Error('Set ALLOW_MYSQL_TESTS=1 explicitly');
  const project=path.resolve(__dirname,'../..');
  const configPath=path.resolve(project,process.env.MYSQL_TEST_CONFIG || '.local/mysql/test-config.json');
  if(!configPath.startsWith(`${project}${path.sep}`)) throw new Error('Test configuration must be inside project');
  const config=JSON.parse(await fs.readFile(configPath,'utf8'));
  const admin=await mysql.createConnection({host:'127.0.0.1',port:config.port,user:'root',password:config.adminPassword});
  const database=`eduverify_test_${randomBytes(8).toString('hex')}`;
  let store;let created=false;let granted=false;
  try {
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin`);
  created=true;
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${database}\`.* TO 'eduverify_app'@'localhost'`);
  granted=true;
  const adminPool=mysql.createPool({host:'127.0.0.1',port:config.port,user:'root',password:config.adminPassword,database});
  try { await migrate(adminPool); } finally { await adminPool.end(); }
  const connection={host:'127.0.0.1',port:config.port,user:'eduverify_app',password:config.appPassword,database,
    dateStrings:true,charset:'UTF8MB4_BIN',timezone:'Z',connectionLimit:6,connectTimeout:3000};
  store=new MySqlStore({config:connection}); await store.ready();
  return {store,config:connection,admin,database,
    async cleanup(){await store.close(); if(!/^eduverify_test_[a-f0-9]{16}$/.test(database))throw new Error('Unsafe database cleanup');
      await admin.query(`REVOKE SELECT,INSERT,UPDATE,DELETE ON \`${database}\`.* FROM 'eduverify_app'@'localhost'`);
      await admin.query(`DROP DATABASE \`${database}\``); await admin.end();}};
  } catch(error) {
    if(store)await store.close().catch(()=>{});
    if(granted)await admin.query(`REVOKE SELECT,INSERT,UPDATE,DELETE ON \`${database}\`.* FROM 'eduverify_app'@'localhost'`).catch(()=>{});
    if(created)await admin.query(`DROP DATABASE IF EXISTS \`${database}\``).catch(()=>{});
    await admin.end().catch(()=>{});
    throw error;
  }
}
module.exports={createTestDatabase};
