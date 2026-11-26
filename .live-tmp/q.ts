import pg from "pg";
import { supabaseCertificate } from "../scripts/supabase-certificate";
const url = process.env.DATABASE_URL as string;
const client = new pg.Client({ connectionString: url.replace(/[?&]sslrootcert=[^&]*/, "").replace(/[?&]sslmode=[^&]*/, ""), ssl: { ca: supabaseCertificate(process.env, ".secrets/supabase-ca.crt"), rejectUnauthorized: true } });
await client.connect();
console.log((await client.query("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid='agent_session'::regclass and contype='c' and pg_get_constraintdef(oid) like '%chat_role%'")).rows);
console.log((await client.query("select statements, name from supabase_migrations.schema_migrations where version='20261126120000'")).rows);
await client.end();
