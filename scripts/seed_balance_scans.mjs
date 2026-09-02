/**
 * One-time seed of the window-close baseline into token_balance_scans.
 *
 * These rows also DEFINE THE SCANNER'S SCOPE: Group 1 membership depends on
 * transfer logs that are not in Postgres, so the seed is the only record of who
 * belongs. Marked scan_kind='window_close' to keep them distinguishable from
 * later passes. Append-only, and refuses to run twice for the same token.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const P = JSON.parse(gunzipSync(Buffer.from(readFileSync('/app/_seed.b64','utf8'),'base64')).toString());
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p=[]) => (await c.query(s,p)).rows;
const existing = (await q(`select count(*)::int n from token_balance_scans
   where token=$1 and scan_kind='window_close'`, [P.token]))[0].n;
console.log(`seed payload: ${P.token} ${P.rows.length} wallets at block ${P.block} (${P.read_at})`);
console.log(`existing window_close rows for ${P.token}: ${existing}`);
if (existing > 0) { console.log('ALREADY SEEDED — refusing to insert again'); process.exit(0); }
await c.query('begin');
try {
  const b = P.rows;
  const res = await c.query(
    `insert into token_balance_scans (token, chain, wallet, block, read_at, balance_raw, status, scan_kind)
     select * from unnest($1::text[],$2::text[],$3::text[],$4::bigint[],$5::timestamptz[],
                          $6::numeric[],$7::text[],$8::text[])`,
    [b.map(()=>P.token), b.map(()=>P.chain), b.map(x=>x.wallet), b.map(()=>P.block),
     b.map(()=>P.read_at), b.map(x=>x.balance_raw), b.map(x=>x.status), b.map(()=>'window_close')]);
  console.log(`inserted ${res.rowCount} window_close rows`);
  const chk = await q(`select count(*)::int n, count(balance_raw)::int withbal,
     count(*) filter (where status<>'ok')::int errs from token_balance_scans
     where token=$1 and scan_kind='window_close'`, [P.token]);
  console.log(`verify: ${chk[0].n} rows, ${chk[0].withbal} with a balance, ${chk[0].errs} non-ok`);
  await c.query('commit'); console.log('COMMITTED');
} catch(e){ await c.query('rollback'); console.log('ROLLED BACK: '+e.message); process.exitCode=1; }
await c.end();
