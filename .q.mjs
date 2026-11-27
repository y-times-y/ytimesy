import pg from 'pg';
const c=new pg.Client({connectionString:process.env.PRODUCTION_DATABASE_POOLER_URL||process.env.PRODUCTION_DATABASE_URL,ssl:{rejectUnauthorized:false}});
await c.connect();
await c.query('set default_transaction_read_only=on');
const r=await c.query(process.argv[2]);
console.log(JSON.stringify(r.rows,null,0));
await c.end();
