const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

async function migrationFiles() {
  const directory = path.join(__dirname,'migrations');
  return Promise.all((await fs.readdir(directory)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort().map(async name => {
    const sql = await fs.readFile(path.join(directory,name),'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}
async function verifyMigrations(connection) {
  const [rows] = await connection.query('SELECT name,checksum FROM schema_migrations ORDER BY name');
  const files = await migrationFiles();
  if (rows.length !== files.length || files.some((file,index) => rows[index].name !== file.name || rows[index].checksum !== file.checksum)) throw new Error('Schema migration mismatch');
}
async function migrate(pool) {
  const connection = await pool.getConnection();
  let locked = false;
  try {
    const [[database]]=await connection.query('SELECT @@collation_database AS collation_name');
    if(database.collation_name!=='utf8mb4_0900_bin')throw new Error('Create database with utf8mb4_0900_bin collation');
    const [locks] = await connection.query("SELECT GET_LOCK(CONCAT('eduverify:',LEFT(SHA2(DATABASE(),256),40)),10) AS acquired");
    if (locks[0].acquired !== 1) throw new Error('Migration lock unavailable'); locked = true;
    await connection.query('CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(128) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at DATETIME(3) NOT NULL) ENGINE=InnoDB');
    const [rows] = await connection.query('SELECT name,checksum FROM schema_migrations ORDER BY name');
    const files = await migrationFiles();
    if (rows.some((row,index) => files[index]?.name !== row.name || files[index]?.checksum !== row.checksum)) throw new Error('Applied migrations differ from source');
    for (const file of files.slice(rows.length)) {
      // DDL implicitly commits in MySQL. Each statement is restartable; the
      // ledger is written only after the whole ordered migration succeeds.
      for (const statement of file.sql.split(';').map(value => value.trim()).filter(Boolean)) await connection.query(statement);
      await connection.execute('INSERT INTO schema_migrations (name,checksum,applied_at) VALUES (?,?,UTC_TIMESTAMP(3))', [file.name,file.checksum]);
    }
    await verifyMigrations(connection);
    return files.map(file => file.name);
  } finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK(CONCAT('eduverify:',LEFT(SHA2(DATABASE(),256),40)))").catch(() => {});
    connection.release();
  }
}
module.exports = { migrate, verifyMigrations, migrationFiles };
