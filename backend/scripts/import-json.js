require('dotenv').config({quiet:true});
const {createStorage}=require('../storage');
const {backupJson,importJson}=require('../storage/json-import');
async function main(){
  const args=process.argv.slice(2);const value=flag=>args[args.indexOf(flag)+1];
  if((args.includes('--apply')&&args.includes('--dry-run')) || (args.includes('--create-backup')&&args.includes('--apply')))throw new Error('Conflicting import modes');
  for(const flag of ['--source','--backup','--create-backup','--apply','--dry-run','--fictional-data'])if(args.filter(item=>item===flag).length>1)throw new Error('Duplicate option');
  if(!args.includes('--source')||!args.includes('--backup'))throw new Error('Source and backup required');
  if(args.includes('--create-backup')){console.log(JSON.stringify(await backupJson({source:value('--source'),backup:value('--backup')})));return;}
  if(process.env.STORAGE_DRIVER!=='mysql')throw new Error('MySQL must be selected');
  const store=createStorage();
  try{await store.ready();const report=await importJson({store,source:value('--source'),backup:value('--backup'),apply:args.includes('--apply'),fictional:args.includes('--fictional-data')});
    console.log(JSON.stringify(report));if(report.status==='rejected')process.exitCode=1;
  }finally{await store.close();}
}
main().catch(()=>{console.error('JSON import/backup failed. Check explicit paths, verified backup, source schema and MySQL configuration. Source files were not modified.');process.exitCode=1;});
