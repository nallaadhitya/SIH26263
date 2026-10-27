const fs=require('node:fs/promises');
const path=require('node:path');
const request=require('supertest');
const mysql=require('mysql2/promise');
const {randomUUID}=require('node:crypto');
const {spawn,execFile}=require('node:child_process');
const {promisify}=require('node:util');
const net=require('node:net');
const {createTestDatabase}=require('../storage/test-database');
const {MySqlStore,safeError}=require('../storage/mysql-store');
const {createStorage}=require('../storage');
const {migrate}=require('../storage/mysql-migrations');
const {createApp}=require('../server');
const {seedDemoAccounts}=require('../scripts/seed-accounts');
const {SigningKeys}=require('../verification/crypto');
const {backupJson,importJson}=require('../storage/json-import');
const {JsonStore,COLLECTIONS}=require('../storage/json-store');
const {assertCurrentAccess}=require('../auth/policy');
const {mysqlConfig}=require('../storage/mysql-config');

const enabled=process.env.ALLOW_MYSQL_TESTS==='1';
const suite=enabled?describe:describe.skip;
const password='fictional-mysql-test-password';
const root=path.resolve(__dirname,'../..');
const directory=path.join(__dirname,'.tmp-mysql-import');
const base='/api/v1/students';
const input=(extra={})=>({apaarId:'000000000071',studentName:'Fictional SQL Learner',programmeId:'DEMO-PROG-001',academicYear:'2026-2027',admissionYear:'2026',...extra});
let fixture,store,app,session;
async function login(email='admin@demo.example',target=app){const agent=request.agent(target);const csrf=await agent.get('/api/auth/csrf');
  const result=await agent.post('/api/auth/login').set('X-CSRF-Token',csrf.body.csrfToken).send({email,password});expect(result.status).toBe(200);return{agent,token:result.body.csrfToken};}
const post=(url,body,client=session)=>client.agent.post(url).set('X-CSRF-Token',client.token).send(body);
const create=(body=input(),client=session)=>post(base,body,client);
const verify=payload=>request(app).post('/api/v1/verification/verify').send({payload});
async function cleanupFiles(){if(path.dirname(directory)!==path.resolve(__dirname)||!path.basename(directory).startsWith('.tmp-mysql-'))throw new Error('Unsafe cleanup');await fs.rm(directory,{recursive:true,force:true});}

test('storage selection is explicit and errors never trigger a JSON fallback',()=>{
  expect(()=>createStorage({driver:'unknown'})).toThrow();
  expect(()=>mysqlConfig({})).toThrow();
  expect(safeError({code:'ER_LOCK_DEADLOCK'})).toMatchObject({status:503});
  expect(safeError({code:'ECONNREFUSED',message:'private password'}).message).not.toContain('private');
});

suite('real isolated MySQL',()=>{
  beforeEach(async()=>{fixture=await createTestDatabase();store=fixture.store;await seedDemoAccounts({store,password});
    app=createApp({store,verificationOptions:{signing:new SigningKeys({keys:{test:Buffer.alloc(32,31).toString('base64')},activeId:'test',forbiddenSecrets:[]})}});session=await login();});
  afterEach(async()=>{if(fixture)await fixture.cleanup();fixture=null;await cleanupFiles();});

  test('ordered checksummed migrations are repeatable; application has no DDL privilege',async()=>{
    const pool=mysql.createPool({...fixture.config,user:'root',password:JSON.parse(await fs.readFile(path.join(root,'.local/mysql/test-config.json'),'utf8')).adminPassword});
    try{expect(await migrate(pool)).toEqual(['001_core.sql','002_evaluations_artifacts.sql']);await migrate(pool);}finally{await pool.end();}
    expect((await store.pool.query('SELECT name FROM schema_migrations'))[0]).toHaveLength(2);
    await expect(store.pool.query('CREATE TABLE forbidden_table (id INT)')).rejects.toMatchObject({code:'ER_TABLEACCESS_DENIED_ERROR'});
    const created=(await create()).body.student;
    expect(created.apaarId).toBe('000000000071');
    const restarted=new MySqlStore({config:fixture.config});
    try{await restarted.ready();expect((await restarted.readCollection('students'))[0].id).toBe(created.id);}finally{await restarted.close();}
    await fixture.admin.execute(`UPDATE ${fixture.database}.schema_migrations SET checksum=? WHERE name=?`,['0'.repeat(64),'001_core.sql']);
    await expect(store.ready()).rejects.toThrow('migration mismatch');
  });

  test('real backend startup selects MySQL from explicit production environment configuration',async()=>{
    const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
    const child=spawn(process.execPath,['server.js'],{cwd:path.resolve(__dirname,'..'),windowsHide:true,stdio:'ignore',env:{...process.env,NODE_ENV:'production',STORAGE_DRIVER:'mysql',MYSQL_HOST:fixture.config.host,MYSQL_PORT:String(fixture.config.port),MYSQL_DATABASE:fixture.config.database,MYSQL_USER:fixture.config.user,MYSQL_PASSWORD:fixture.config.password,PORT:String(port)}});
    let spawnError;child.once('error',error=>{spawnError=error;});
    try{
      let ready=false;
      for(let i=0;i<100;i+=1){if(spawnError||child.exitCode!==null)break;try{ready=(await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(500)})).ok;}catch{}if(ready)break;await new Promise(resolve=>setTimeout(resolve,100));}
      expect(ready).toBe(true);
      const csrf=await fetch(`http://127.0.0.1:${port}/api/auth/csrf`);const token=(await csrf.json()).csrfToken;const cookie=csrf.headers.getSetCookie()[0].split(';')[0];
      const loggedIn=await fetch(`http://127.0.0.1:${port}/api/auth/login`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token,Cookie:cookie},body:JSON.stringify({email:'admin@demo.example',password})});
      expect(loggedIn.status).toBe(200);expect((await loggedIn.json()).user.id).toBe('DEMO-USER-ADMIN');
    }finally{if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{child.once('exit',resolve);child.kill();});}
  });

  test('reference constraints and parameterization preserve ownership and literal input',async()=>{
    expect((await create(input({programmeId:'DEMO-PROG-002'}))).status).toBe(422);
    const literal="Fictional '; DROP TABLE users; --";
    expect((await create(input({studentName:literal}))).status).toBe(201);
    expect((await session.agent.get(base)).body.records[0].studentName).toBe(literal);
    await expect(store.pool.execute('INSERT INTO programmes (id,institution_id,name,level,position) VALUES (?,?,?,?,?)',['DEMO-BAD','missing','Fictional','undergraduate',9])).rejects.toMatchObject({sqlState:'23000'});
    const row=(await store.readCollection('students'))[0];
    await expect(store.updateCollection('students',rows=>[...rows,{...row,id:randomUUID()}])).rejects.toMatchObject({status:409});
    expect(await store.readCollection('students')).toHaveLength(1);
  });

  test('two adapters cannot concurrently create duplicate institution APAAR records',async()=>{
    const second=new MySqlStore({config:fixture.config});
    try{const client=await login('admin@demo.example',createApp({store:second}));
      const responses=await Promise.all([create(),create(input(),client)]);
      expect(responses.map(result=>result.status).sort()).toEqual([201,409]);expect(await store.readCollection('students')).toHaveLength(1);
      const id=(await store.readCollection('students'))[0].id;
      await Promise.all([session.agent.patch(`${base}/${id}`).set('X-CSRF-Token',session.token).send({studentName:'Fictional Concurrent Name'}),client.agent.patch(`${base}/${id}`).set('X-CSRF-Token',client.token).send({status:'inactive'})]);
      expect((await store.readCollection('students'))[0]).toMatchObject({studentName:'Fictional Concurrent Name',status:'inactive'});
    }finally{await second.close();}
  });

  test('CSV commits roll back a mid-batch SQL failure and retry atomically',async()=>{
    const text='apaarId,studentName,institutionId,programmeId,academicYear,admissionYear\n000000000072,Fictional One,DEMO-INST-001,DEMO-PROG-001,2026-2027,2026\n000000000073,Fictional Two,DEMO-INST-001,DEMO-PROG-001,2026-2027,2026';
    const preview=await session.agent.post(`${base}/import/preview`).set('X-CSRF-Token',session.token).attach('file',Buffer.from(text),{filename:'fictional.csv',contentType:'text/csv'});
    expect(preview.status).toBe(200);
    await fixture.admin.query(`CREATE TRIGGER ${fixture.database}.fail_second BEFORE INSERT ON ${fixture.database}.students FOR EACH ROW BEGIN IF NEW.apaar_id='000000000073' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Injected failure'; END IF; END`);
    const failed=await post(`${base}/import/commit`,{previewToken:preview.body.previewToken});expect(failed.status).toBe(503);expect(await store.readCollection('students')).toEqual([]);
    await fixture.admin.query(`DROP TRIGGER ${fixture.database}.fail_second`);
    expect((await post(`${base}/import/commit`,{previewToken:preview.body.previewToken})).body.imported).toBe(2);
    expect((await post(`${base}/import/commit`,{previewToken:preview.body.previewToken})).status).toBe(409);
  });

  test('compliance snapshots and findings commit together, preserve previous state on failure and become stale',async()=>{
    await create();await store.updateCollection('approved-intakes',rows=>rows.map(row=>({...row,approvedSeats:0})));
    const first=await post('/api/v1/compliance/evaluate',{});expect(first.status).toBe(200);expect(first.body.summary.findingsByRule.INTAKE_EXCEEDED).toBe(1);
    await fixture.admin.query(`CREATE TRIGGER ${fixture.database}.fail_finding BEFORE INSERT ON ${fixture.database}.compliance_findings FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Injected failure'`);
    expect((await post('/api/v1/compliance/evaluate',{})).status).toBe(503);
    expect((await session.agent.get('/api/v1/compliance/summary')).body.evaluation.id).toBe(first.body.evaluation.id);
    await fixture.admin.query(`DROP TRIGGER ${fixture.database}.fail_finding`);
    const id=(await store.readCollection('students'))[0].id;
    await session.agent.patch(`${base}/${id}`).set('X-CSRF-Token',session.token).send({status:'inactive'});
    expect((await session.agent.get('/api/v1/compliance/findings')).body.stale).toBe(true);
  });

  test('QR issuance/revocation failures roll back; edit-back stays outdated and restarts preserve revocation',async()=>{
    const id=(await create()).body.student.id;
    await fixture.admin.query(`CREATE TRIGGER ${fixture.database}.fail_issue BEFORE INSERT ON ${fixture.database}.verification_records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Injected failure'`);
    const failed=await post('/api/v1/verification/issue',{studentId:id});expect(failed.status).toBe(503);expect(failed.body).not.toHaveProperty('payload');
    await fixture.admin.query(`DROP TRIGGER ${fixture.database}.fail_issue`);
    const issued=await post('/api/v1/verification/issue',{studentId:id});expect(issued.status).toBe(201);expect((await verify(issued.body.payload)).body.status).toBe('valid');
    for(const studentName of ['Fictional Changed',input().studentName])await session.agent.patch(`${base}/${id}`).set('X-CSRF-Token',session.token).send({studentName});
    expect((await verify(issued.body.payload)).body).toMatchObject({status:'outdated',integrityValid:true,recordCurrent:false});
    await fixture.admin.query(`CREATE TRIGGER ${fixture.database}.fail_revoke BEFORE UPDATE ON ${fixture.database}.verification_records FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Injected failure'`);
    expect((await post('/api/v1/verification/revoke',{artifactId:issued.body.artifactId})).status).toBe(503);
    expect((await verify(issued.body.payload)).body.status).toBe('outdated');
    await fixture.admin.query(`DROP TRIGGER ${fixture.database}.fail_revoke`);
    expect((await post('/api/v1/verification/revoke',{artifactId:issued.body.artifactId})).status).toBe(200);
    const reopened=new MySqlStore({config:fixture.config});try{expect((await reopened.readCollection('verification-records'))[0].status).toBe('revoked');}finally{await reopened.close();}
    const tampered=JSON.parse(issued.body.payload);tampered.v=9;expect((await verify(JSON.stringify(tampered))).body.status).toBe('invalid');
  });

  test('deactivation, role changes and institution isolation retain API authorization',async()=>{
    const id=(await create()).body.student.id;
    const second=await login('admin2@demo.example');expect((await second.agent.get(`${base}/${id}`)).status).toBe(404);
    expect((await second.agent.get(`${base}?institutionId=DEMO-INST-001`)).status).toBe(403);
    expect((await post('/api/v1/verification/issue',{studentId:id},second)).status).toBe(404);
    for(const email of ['reviewer@demo.example','verifier@demo.example']){const client=await login(email);expect((await client.agent.get(base)).status).toBe(403);expect((await post('/api/v1/compliance/evaluate',{},client)).status).toBe(403);}
    await store.updateCollection('users',rows=>rows.map(user=>user.email==='admin@demo.example'?{...user,role:'authorized_verifier',institutionId:null}:user));
    expect((await session.agent.get(base)).status).toBe(403);
    await store.updateCollection('users',rows=>rows.map(user=>({...user,status:'inactive'})));expect((await session.agent.get('/api/auth/me')).status).toBe(401);
  });

  test('account permission rows stay locked until a related transaction commits',async()=>{
    const admin=(await store.readCollection('users')).find(user=>user.email==='admin@demo.example');
    let pending;let settled=false;
    await store.transaction(async()=>{
      await assertCurrentAccess(store,admin,'student:write:own');
      pending=fixture.admin.execute(`UPDATE ${fixture.database}.users SET status=? WHERE id=?`,['inactive',admin.id]);
      pending.then(()=>{settled=true;});
      await new Promise(resolve=>setTimeout(resolve,50));expect(settled).toBe(false);
    });
    await pending;expect((await session.agent.get(base)).status).toBe(401);
  });

  test('secret fields cannot enter opaque legacy/audit persistence',async()=>{
    await expect(store.writeCollection('audit-logs',[{id:'fictional',signingKey:'test-key-not-stored'}])).rejects.toMatchObject({status:422});
    expect(await store.readCollection('audit-logs')).toEqual([]);
  });

  test('connection loss rolls back and a fresh pooled connection works without JSON fallback',async()=>{
    await expect(store.transaction(async()=>{
      await store.writeCollection('audit-logs',[{id:'fictional-rollback'}]);
      const thread=store.connection().threadId;if(!Number.isInteger(thread))throw new Error('Invalid thread');
      await fixture.admin.query(`KILL CONNECTION ${thread}`);
      await store.readCollection('audit-logs');
    })).rejects.toMatchObject({status:503});
    expect(await store.readCollection('audit-logs')).toEqual([]);expect((await create()).status).toBe(201);
    const offline=new MySqlStore({config:{...fixture.config,port:33308,connectTimeout:250}});
    try{const target=createApp({store:offline});const client=request.agent(target);const csrf=await client.get('/api/auth/csrf');const result=await client.post('/api/auth/login').set('X-CSRF-Token',csrf.body.csrfToken).send({email:'admin@demo.example',password});
      expect(result.status).toBe(503);expect(result.body.error).not.toContain(fixture.config.password);
    }finally{await offline.close();}
  });

  test('real lock timeout is safe and retry works after releasing the transaction gate',async()=>{
    const blocked=new MySqlStore({config:{...fixture.config,connectionLimit:1}});
    try{await blocked.pool.query('SET SESSION innodb_lock_wait_timeout=1');
      await fixture.admin.query(`USE ${fixture.database}`);await fixture.admin.beginTransaction();await fixture.admin.query('SELECT id FROM storage_mutex WHERE id=1 FOR UPDATE');
      await expect(blocked.writeCollection('audit-logs',[{id:'fictional'}])).rejects.toMatchObject({status:503});
      await fixture.admin.rollback();await blocked.writeCollection('audit-logs',[{id:'fictional'}]);expect(await blocked.readCollection('audit-logs')).toHaveLength(1);
    }finally{await fixture.admin.rollback();await blocked.close();}
  });

  test('verified-backup import dry-runs roll back, imports preserve IDs/hashes, reruns skip and conflicts reject',async()=>{
    const student=(await create()).body.student;
    await store.updateCollection('approved-intakes',rows=>rows.map(row=>({...row,approvedSeats:0})));
    expect((await post('/api/v1/compliance/evaluate',{})).status).toBe(200);
    const artifact=await post('/api/v1/verification/issue',{studentId:student.id});expect(artifact.status).toBe(201);
    await fs.mkdir(directory,{recursive:true});const source=path.relative(root,path.join(directory,'source'));const backup=path.relative(root,path.join(directory,'backup'));
    const jsonStore=new JsonStore({dataDirectory:source});
    for(const name of COLLECTIONS)await jsonStore.writeCollection(name,await store.readCollection(name));
    await fs.writeFile(path.join(root,source,'unrelated-generated-data.json'),'not application data');
    const before=await fs.readFile(path.join(root,source,'users.json'),'utf8');
    const cli=async(extra,config)=>JSON.parse((await promisify(execFile)(process.execPath,['scripts/import-json.js','--source',source,'--backup',backup,...extra],{cwd:path.resolve(__dirname,'..'),windowsHide:true,
      env:{...process.env,STORAGE_DRIVER:'mysql',MYSQL_HOST:config?.host,MYSQL_PORT:String(config?.port||33307),MYSQL_DATABASE:config?.database,MYSQL_USER:config?.user,MYSQL_PASSWORD:config?.password}})).stdout);
    expect((await cli(['--create-backup'])).status).toBe('backup_created');
    const target=await createTestDatabase();
    try{
      const dry=await importJson({store:target.store,source,backup});expect(dry.status).toBe('dry_run');expect(dry.summary.users.wouldImport).toBe(5);expect(await target.store.readCollection('users')).toEqual([]);
      expect((await cli(['--dry-run'],target.config)).status).toBe('dry_run');
      expect(dry.summary.students.wouldImport).toBe(1);expect(await target.store.readCollection('institutions')).toEqual([]);
      const applied=await cli(['--apply','--fictional-data'],target.config);expect(applied.status).toBe('imported');expect(applied.summary.users.imported).toBe(5);
      expect(await target.store.readCollection('users')).toEqual(await store.readCollection('users'));
      expect((await target.store.readCollection('students'))[0].id).toBe(student.id);
      expect((await target.store.readCollection('validation-issues'))[0].findings[0].ruleCode).toBe('INTAKE_EXCEEDED');
      const restoredApp=createApp({store:target.store,verificationOptions:{signing:new SigningKeys({keys:{test:Buffer.alloc(32,31).toString('base64')},activeId:'test',forbiddenSecrets:[]})}});
      expect((await request(restoredApp).post('/api/v1/verification/verify').send({payload:artifact.body.payload})).body.status).toBe('valid');
      const repeated=await importJson({store:target.store,source,backup,apply:true,fictional:true});expect(repeated.summary.users.skipped).toBe(5);expect(repeated.summary.users.imported).toBe(0);
      await target.store.updateCollection('institutions',rows=>rows.map(row=>({...row,city:'Fictional changed city'})));
      expect((await importJson({store:target.store,source,backup,apply:true,fictional:true})).status).toBe('rejected');
      expect(await fs.readFile(path.join(root,source,'users.json'),'utf8')).toBe(before);
    }finally{await target.cleanup();}
  });

  test('import rejects changed backups, invalid references, duplicate IDs and plaintext passwords without partial writes',async()=>{
    await fs.mkdir(directory,{recursive:true});const source=path.relative(root,path.join(directory,'source'));
    const jsonStore=new JsonStore({dataDirectory:source});
    const users=await store.readCollection('users');
    const cases=[
      {users:[{...users[0],id:'DEMO-BAD',email:'bad@demo.example',passwordHash:'plaintext'}]},
      {users:[users[0],{...users[0],email:'another@demo.example'}]},
      {users:[{...users[0],id:'DEMO-BAD',email:'bad@demo.example',institutionId:'missing'}]},
      {students:[{...input(),id:'invalid-student-id',institutionId:'DEMO-INST-001',status:'active',admissionCategory:'not_specified',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),createdBy:users[0].id,updatedBy:users[0].id}]},
    ];
    let backup;
    for(const [index,rows] of cases.entries()){
      await jsonStore.writeCollection('users',rows.users||[]);await jsonStore.writeCollection('students',rows.students||[]);
      backup=path.relative(root,path.join(directory,`backup-${index}`));await backupJson({source,backup});
      const result=await importJson({store,source,backup,apply:true,fictional:true});expect(result.status).toBe('rejected');expect(await store.readCollection('users')).toEqual(users);expect(await store.readCollection('students')).toEqual([]);
    }
    await fs.writeFile(path.join(root,backup,'students.json'),'[]');await expect(importJson({store,source,backup})).rejects.toThrow('Backup bytes');
  });
});
