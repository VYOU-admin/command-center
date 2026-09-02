/** Load group membership for several tokens in one transaction, verifying each. */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const PS = JSON.parse(gunzipSync(Buffer.from(readFileSync('/app/_g5.b64','utf8'),'base64')).toString());
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s,p=[]) => (await c.query(s,p)).rows;
await c.query('begin');
try {
  for (const P of PS) {
    await c.query(`delete from wallet_groups where token=$1 and chain=$2`, [P.token, P.chain]);
    let n = 0;
    for (let i = 0; i < P.rows.length; i += 300) {
      const b = P.rows.slice(i, i + 300);
      n += (await c.query(
        `insert into wallet_groups (token, chain, wallet, group_no, derived_at, source)
         select * from unnest($1::text[],$2::text[],$3::text[],$4::int[],$5::timestamptz[],$6::text[])
         on conflict (token, chain, wallet, group_no) do update
           set derived_at=excluded.derived_at, source=excluded.source`,
        [b.map(()=>P.token), b.map(()=>P.chain), b.map(x=>x.wallet), b.map(x=>x.group_no),
         b.map(()=>P.derived_at), b.map(()=>P.source)])).rowCount;
    }
    const v = Object.fromEntries((await q(`select group_no, count(*)::int n from wallet_groups
       where token=$1 group by 1`, [P.token])).map(r=>[r.group_no, r.n]));
    const ov = (await q(`select count(*)::int n from (select wallet from wallet_groups
       where token=$1 and group_no in (2,3) group by wallet having count(*)=2) x`, [P.token]))[0].n;
    const cohort = (await q(`select count(*)::int n from wallet_pnl where token=$1`, [P.token]))[0].n;
    const cov = (await q(`select count(distinct wallet)::int n from wallet_groups where token=$1`, [P.token]))[0].n;
    console.log(`   ${P.token.padEnd(9)} wrote ${String(n).padStart(5)}  G1 ${v[1]} G2 ${v[2]} G3 ${v[3]}  `
      + `overlap ${ov}  none ${cohort-cov}  cohort ${cohort}`);
    if (v[1]!==P.expect.g1 || v[2]!==P.expect.g2 || v[3]!==P.expect.g3)
      throw new Error(`${P.token}: loaded counts do not match the derivation`);
    if (v[1]+v[2]+v[3]-ov+(cohort-cov) !== cohort)
      throw new Error(`${P.token}: does not reconcile to the cohort`);
  }
  const all = await q(`select token, count(*)::int n from wallet_groups group by 1 order by 1`);
  console.log('   all tokens in wallet_groups: ' + all.map(r=>`${r.token}=${r.n}`).join(' '));
  await c.query('commit'); console.log('COMMITTED — every token reconciles');
} catch(e){ await c.query('rollback'); console.log('ROLLED BACK: '+e.message); process.exitCode=1; }
await c.end();
