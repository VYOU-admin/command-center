import pg from 'pg';
import { readFileSync } from 'node:fs';
for (const l of readFileSync('.env','utf8').split('\n')) { const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/); if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g,''); }
const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();
for (const t of ['wallet_pnl', 'wallet_clusters']) {
  const r = await c.query(
    `select column_name, data_type, is_nullable from information_schema.columns
      where table_name=$1 order by ordinal_position`, [t]);
  console.log(`== ${t}`);
  for (const x of r.rows) console.log(`   ${x.column_name.padEnd(28)}${x.data_type.padEnd(20)}${x.is_nullable}`);
  const n = await c.query(`select count(*)::int n from ${t}`);
  console.log(`   ROWS ${n.rows[0].n}`);
  const i = await c.query(`select indexdef from pg_indexes where tablename=$1`, [t]);
  for (const x of i.rows) console.log(`   IDX ${x.indexdef.slice(0, 160)}`);
}
const g = await c.query(`select token, chain, count(*)::int n from wallet_pnl group by 1,2 order by 1`);
console.log('== wallet_pnl by token');
for (const x of g.rows) console.log(`   ${String(x.token).padEnd(14)}${String(x.chain).padEnd(12)}${x.n}`);
const cl = await c.query(`select chain, signal, count(*)::int n from wallet_clusters group by 1,2 order by 1,2`);
console.log('== wallet_clusters by chain/signal');
for (const x of cl.rows) console.log(`   ${String(x.chain).padEnd(12)}${String(x.signal).padEnd(22)}${x.n}`);
await c.end();
