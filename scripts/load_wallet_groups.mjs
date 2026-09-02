/**
 * Group membership, keyed on (token, chain, wallet, group_no).
 *
 * A wallet that both sold and transferred out gets a row in group 2 AND group 3
 * -- the groups are behaviours, not a partition, so the key includes group_no.
 *
 * Membership is derived from transfer logs, which never reach Postgres, so this
 * table is the only durable record of it. The closest SQL-only proxy for group 1
 * returns 119 of 266 ODYSSEUS wallets, and the balance-shortfall rule for group 3
 * selects 32 wallets for 8 real members -- neither is usable, which is why the
 * derivation has to be stored rather than recomputed.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const P = JSON.parse(gunzipSync(Buffer.from(readFileSync('/app/_grp.b64','utf8'),'base64')).toString());
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p=[]) => (await c.query(s,p)).rows;
await c.query(`create table if not exists wallet_groups (
   token text not null, chain text not null, wallet text not null,
   group_no int not null, derived_at timestamptz not null, source text not null,
   primary key (token, chain, wallet, group_no))`);
await c.query(`create index if not exists wallet_groups_token_idx on wallet_groups (token, group_no)`);
console.log(`payload: ${P.token} ${P.rows.length} membership rows, derived_at ${P.derived_at}`);
await c.query('begin');
try {
  const del = await c.query(`delete from wallet_groups where token=$1 and chain=$2`, [P.token, P.chain]);
  let n = 0;
  for (let i = 0; i < P.rows.length; i += 300) {
    const b = P.rows.slice(i, i + 300);
    n += (await c.query(
      `insert into wallet_groups (token, chain, wallet, group_no, derived_at, source)
       select * from unnest($1::text[],$2::text[],$3::text[],$4::int[],$5::timestamptz[],$6::text[])
       on conflict (token, chain, wallet, group_no) do update set
         derived_at = excluded.derived_at, source = excluded.source`,
      [b.map(()=>P.token), b.map(()=>P.chain), b.map(x=>x.wallet), b.map(x=>x.group_no),
       b.map(()=>P.derived_at), b.map(()=>P.source)])).rowCount;
  }
  console.log(`replaced ${del.rowCount}, wrote ${n}`);
  const v = await q(`select group_no, count(*)::int n from wallet_groups
     where token=$1 group by 1 order by 1`, [P.token]);
  for (const r of v) console.log(`   group ${r.group_no}: ${r.n}`);
  const ov = (await q(`select count(*)::int n from (select wallet from wallet_groups
     where token=$1 and group_no in (2,3) group by wallet having count(*)=2) x`, [P.token]))[0].n;
  const cohort = (await q(`select count(*)::int n from wallet_pnl where token=$1`, [P.token]))[0].n;
  const covered = (await q(`select count(distinct wallet)::int n from wallet_groups where token=$1`, [P.token]))[0].n;
  console.log(`   overlap 2&3: ${ov}   distinct wallets ${covered} of cohort ${cohort} -> in no group ${cohort-covered}`);
  const ok = v.find(r=>r.group_no===1)?.n===266 && v.find(r=>r.group_no===2)?.n===406
          && v.find(r=>r.group_no===3)?.n===40 && ov===32 && cohort-covered===1;
  if (!ok) throw new Error('counts do not match 266/406/40, overlap 32, none 1');
  await c.query('commit'); console.log('COMMITTED — counts verified');
} catch(e){ await c.query('rollback'); console.log('ROLLED BACK: '+e.message); process.exitCode=1; }
await c.end();
