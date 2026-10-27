require('dotenv').config({quiet:true});
const mysql=require('mysql2/promise');
const {mysqlConfig}=require('../storage/mysql-config');
const {migrate}=require('../storage/mysql-migrations');
async function main(){
  const config=mysqlConfig({...process.env,MYSQL_USER:process.env.MYSQL_MIGRATION_USER||process.env.MYSQL_USER,
    MYSQL_PASSWORD:process.env.MYSQL_MIGRATION_PASSWORD||process.env.MYSQL_PASSWORD});
  const pool=mysql.createPool(config);
  try {const applied=await migrate(pool); console.log(JSON.stringify({migrations:applied,status:'ready'}));}
  finally {await pool.end();}
}
main().catch(()=>{console.error('Database migration failed; check configuration/schema with your local administrator.');process.exitCode=1;});
