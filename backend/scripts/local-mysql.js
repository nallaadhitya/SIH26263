// Optional isolated test instance using an already-installed mysqld binary.
// Never starts/stops the machine's normal MySQL service or uses its data files.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const mysql = require('mysql2/promise');
const project = path.resolve(__dirname,'../..');
const directory = path.join(project,'.local/mysql');
const configFile = path.join(directory,'test-config.json');
async function main() {
  if (process.argv[2] === 'stop') {
    const config = JSON.parse(await fs.readFile(configFile,'utf8'));
    const connection = await mysql.createConnection({ host: '127.0.0.1', port: config.port, user:'root',password:config.adminPassword });
    const [[row]] = await connection.query('SELECT @@datadir AS directory');
    if (path.resolve(row.directory) !== path.join(directory,'data')) throw new Error('Unexpected server data directory');
    await connection.query('SHUTDOWN'); await connection.end(); console.log('Project test MySQL stopped.'); return;
  }
  await fs.mkdir(path.join(directory,'tmp'),{recursive:true}); await fs.mkdir(path.join(directory,'files'),{recursive:true});
  let config;
  try { config = JSON.parse(await fs.readFile(configFile,'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    config = { port:33307, adminPassword:randomBytes(32).toString('hex'), appPassword:randomBytes(32).toString('hex') };
    await fs.writeFile(configFile,JSON.stringify(config),{flag:'wx',mode:0o600});
  }
  if(config.port!==33307 || !/^[a-f0-9]{64}$/.test(config.adminPassword) || !/^[a-f0-9]{64}$/.test(config.appPassword))throw new Error('Invalid private test configuration');
  const binary = process.env.MYSQLD_PATH || execFileSync(process.platform === 'win32' ? 'where.exe' : 'which',['mysqld'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0];
  const base = path.dirname(path.dirname(binary));
  const common = ['--no-defaults',`--basedir=${base}`,`--datadir=${path.join(directory,'data')}`,`--tmpdir=${path.join(directory,'tmp')}`,`--log-error=${path.join(directory,'mysql.err')}`];
  try { await fs.access(path.join(directory,'data/mysql')); }
  catch {
    const initialize = spawn(binary,[...common,'--initialize-insecure'],{windowsHide:true,stdio:'ignore'});
    const code = await new Promise((resolve,reject) => {initialize.once('error',reject); initialize.once('exit',resolve);});
    if (code !== 0) throw new Error('MySQL initialization failed');
  }
  // Generated secrets exist only in this ignored file/environment. The init
  // script sets credentials before the new instance is available for tests.
  const initFile = path.join(directory,'bootstrap.sql');
  await fs.writeFile(initFile,`ALTER USER 'root'@'localhost' IDENTIFIED BY '${config.adminPassword}';\nCREATE USER IF NOT EXISTS 'eduverify_app'@'localhost' IDENTIFIED BY '${config.appPassword}';\n`,{mode:0o600});
  const child = spawn(binary,[...common,`--port=${config.port}`,'--bind-address=127.0.0.1','--mysqlx=0','--skip-log-bin','--local-infile=0',`--secure-file-priv=${path.join(directory,'files')}`,`--pid-file=${path.join(directory,'mysqld.pid')}`,`--init-file=${initFile}`],{windowsHide:true,detached:true,stdio:'ignore'});
  let spawnError; child.once('error',error => {spawnError=error;}); child.unref();
  let ready=false;
  for(let i=0;i<100;i+=1) {
    if(spawnError) throw spawnError;
    try { const c=await mysql.createConnection({host:'127.0.0.1',port:config.port,user:'root',password:config.adminPassword,connectTimeout:1000});
      const [[row]]=await c.query('SELECT @@datadir AS directory'); await c.end();
      if(path.resolve(row.directory)!==path.join(directory,'data')) throw new Error('Unexpected instance'); ready=true; break;
    } catch { await new Promise(resolve=>setTimeout(resolve,200)); }
  }
  if(!ready) throw new Error('Test MySQL did not become ready');
  await fs.unlink(initFile);
  console.log('Project test MySQL ready on loopback port 33307. Credentials remain in ignored .local/mysql/test-config.json.');
}
main().catch(()=>{console.error('Local test MySQL setup failed. Check installed binary and ignored project-local logs; no credentials displayed.');process.exitCode=1;});
