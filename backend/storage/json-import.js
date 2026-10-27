const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { COLLECTIONS } = require('./json-store');
const { MODELS, encode } = require('./mysql-model');

const project = path.resolve(__dirname,'../..');
const IMPORT_ORDER=['institutions','programmes','approved-intakes','users','students','enrolments','validation-issues','verification-records','audit-logs'];
const digest = value => createHash('sha256').update(value).digest('hex');
function localPath(value) {
  if(typeof value!=='string' || !value || path.isAbsolute(value)) throw new Error('Use an explicit project-relative directory');
  const result=path.resolve(project,value);
  if(!result.startsWith(`${project}${path.sep}`)) throw new Error('Directory must remain inside project');
  return result;
}
function stable(value) {
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value && typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function sourceFiles(source) {
  const directory=localPath(source); const files={};
  for(const name of COLLECTIONS) {
    try {files[name]=await fs.readFile(path.join(directory,`${name}.json`));}
    catch(error) {if(error.code!=='ENOENT')throw error; files[name]=null;}
  }
  return files;
}
async function backupJson({source,backup}) {
  const sourcePath=localPath(source); const destination=localPath(backup);
  if(destination===sourcePath || destination.startsWith(`${sourcePath}${path.sep}`))throw new Error('Backup must be separate from source');
  const files=await sourceFiles(source);
  await fs.mkdir(destination,{recursive:false});
  const hashes={};
  for(const [name,bytes] of Object.entries(files)) {
    hashes[name]=bytes===null?null:digest(bytes);
    if(bytes!==null)await fs.writeFile(path.join(destination,`${name}.json`),bytes,{flag:'wx',mode:0o600});
  }
  await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify({schemaVersion:1,hashes},null,2),{flag:'wx',mode:0o600});
  return {status:'backup_created',files:Object.values(hashes).filter(Boolean).length};
}
async function importJson({store,source,backup,apply=false,fictional=false}) {
  if(apply && !fictional)throw new Error('Explicit fictional-data confirmation required');
  const files=await sourceFiles(source); const backupPath=localPath(backup);
  if(backupPath===localPath(source))throw new Error('Separate verified backup required');
  const manifest=JSON.parse(await fs.readFile(path.join(backupPath,'manifest.json'),'utf8'));
  if(manifest.schemaVersion!==1)throw new Error('Unsupported backup manifest');
  const records={}; const hashes={}; const summary={}; const rejected=[];
  for(const [name,bytes] of Object.entries(files)) {
    hashes[name]=bytes===null?null:digest(bytes);
    if(manifest.hashes?.[name]!==hashes[name])throw new Error('Backup does not match source');
    if(bytes!==null && digest(await fs.readFile(path.join(backupPath,`${name}.json`)))!==hashes[name])throw new Error('Backup bytes do not match');
    const rows=bytes===null?[]:JSON.parse(bytes.toString('utf8'));
    if(!Array.isArray(rows))throw new Error('Source collection must contain an array');
    records[name]=rows;
    summary[name]={imported:0,wouldImport:0,skipped:0,rejected:0};
    const model=MODELS[name]; const ids=new Set();
    for(const [index,row] of rows.entries()) {
      try {
        if(!row || typeof row!=='object' || Array.isArray(row))throw new Error();
        if(model && (!model.kind || row.kind===model.kind)) {
          const allowed=[...model.fields.map(field=>field.name),...(name==='validation-issues'?['findings']:[])];
          if(Object.keys(row).some(key=>!allowed.includes(key)) || ids.has(row.id))throw new Error();
          ids.add(row.id); encode(row,model);
        }
      } catch {summary[name].rejected+=1;rejected.push({collection:name,row:index+1,reason:'invalid_shape_or_duplicate_identifier'});}
    }
  }
  if(rejected.length)return {status:'rejected',summary,rejected};
  const sourceDigest=digest(stable(hashes));
  try {
    await store.transaction(async()=>{
      for(const name of IMPORT_ORDER) {
        const existing=await store.readCollection(name);
        const model=MODELS[name]; const result=[...existing];
        for(const [index,row] of records[name].entries()) {
          const normalized={...row};
          if(model && (!model.kind || row.kind===model.kind))for(const field of model.fields) {
            if(['date','nullableDate'].includes(field.type) && normalized[field.name]!=null)normalized[field.name]=new Date(normalized[field.name]).toISOString();
          }
          const found=existing.find(entry=>row.id!==undefined?entry.id===row.id:stable(entry)===stable(normalized));
          if(found) {
            if(stable(found)!==stable(normalized))throw new Error('Target conflict');
            summary[name].skipped+=1;
          } else {result.push(normalized);summary[name][apply?'imported':'wouldImport']+=1;}
        }
        await store.writeCollection(name,result);
      }
      if(apply)await store.connection().execute('INSERT IGNORE INTO json_imports (source_digest,imported_at,counts) VALUES (?,UTC_TIMESTAMP(3),?)',[sourceDigest,JSON.stringify(summary)]);
    },{rollbackOnly:!apply});
    return {status:apply?'imported':'dry_run',summary,rejected:[]};
  } catch {
    for(const name of COLLECTIONS)summary[name]={imported:0,wouldImport:0,skipped:0,rejected:records[name].length};
    return {status:'rejected',summary,rejected:[{reason:'batch_rolled_back_target_conflict_or_constraint_failure'}]};
  }
}
module.exports={backupJson,importJson,stable,localPath};
