/**
 * Load several token payloads in ONE transaction, so the set lands or none does.
 * Scoped per token; other tokens are never in range of any statement.
 * --dry reports counts and rolls back.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const DRY = process.argv.includes('--dry');
const load = (p) => JSON.parse(gunzipSync(Buffer.from(readFileSync(p, 'utf8'), 'base64')).toString());
const PAYLOADS = ['/app/_p1.b64', '/app/_p2.b64', '/app/_p3.b64'].map(load);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (s, p = []) => (await c.query(s, p)).rows;

console.log(`${DRY ? 'DRY RUN' : 'LOAD'} — ${PAYLOADS.length} payloads`);
console.log('\n-- BEFORE');
const before = await q(`select token, count(*)::int n, round(sum(realized_pnl_usd)::numeric,2) real
                          from wallet_pnl group by 1 order by 1`);
for (const r of before) console.log(`   ${r.token.padEnd(11)}${String(r.n).padStart(6)}  $${r.real}`);
console.log('   TOTAL', (await q(`select count(*)::int n from wallet_pnl`))[0].n);
console.log(`   wallet_clusters ${(await q(`select count(*)::int n from wallet_clusters`))[0].n}`);
console.log(`   wallet_pnl_tokens ${(await q(`select count(*)::int n from wallet_pnl_tokens`))[0].n}`);

console.log('\n-- PER-TOKEN COUNTS TO WRITE');
for (const P of PAYLOADS) {
  const t = P.token.token;
  const existing = (await q(`select count(*)::int n from wallet_pnl where token=$1`, [t]))[0].n;
  const exCl = (await q(`select count(*)::int n from wallet_clusters where cluster_id like $1`,
    [t.toLowerCase() + '-%']))[0].n;
  const sig = P.clusters.filter(x => x.signal === 'shared_signer').length;
  const stx = P.clusters.filter(x => x.signal === 'same_transaction').length;
  console.log(`   ${t}: wallet_pnl ${P.rows.length} (existing ${existing}), `
    + `wallet_clusters ${P.clusters.length} [shared_signer ${sig}, same_transaction ${stx}]`
    + ` (existing ${exCl}), wallet_pnl_tokens 1`);
  if (stx === 0) console.log(`      same_transaction matched nothing for ${t} — zero, not omitted`);
}

const PCOLS = ['wallet','token','chain','quote_asset','tag','tag_source','first_buy_time_utc',
  'last_sell_time_utc','n_buys','n_sells','sol_in','sol_out','realized_pnl_sol','realized_pnl_usd',
  'tokens_still_held','hold_min','sold_out','pre_window_entry','first_buy_mcap_usd','rate_basis',
  'tokens_bought','tokens_sold','implied_balance','onchain_balance','balance_delta','balance_match',
  'boundary_balance','boundary_delta','unrealized_pnl_usd','still_holding','has_off_pool_activity',
  'price_usd','price_block','balance_block'];
await c.query('begin');
try {
  for (const P of PAYLOADS) {
    const t = P.token.token;
    const stale = await c.query(
      `delete from wallet_pnl where token=$1 and not (lower(wallet)=any($2::text[]))`,
      [t, P.rows.map(r => r.wallet.toLowerCase())]);
    let ins = 0;
    for (let i = 0; i < P.rows.length; i += 200) {
      const b = P.rows.slice(i, i + 200), vals = [], ph = [];
      b.forEach((r, k) => {
        ph.push('(' + PCOLS.map((_, j) => `$${k * PCOLS.length + j + 1}`).join(',') + ')');
        for (const col of PCOLS) vals.push(r[col] ?? null);
      });
      ins += (await c.query(`insert into wallet_pnl (${PCOLS.join(',')}) values ${ph.join(',')}
        on conflict (wallet, token) do update set ${PCOLS.filter(x=>x!=='wallet'&&x!=='token'&&x!=='tag')
          .map(x=>`${x}=excluded.${x}`).join(',')},
          tag = case when wallet_pnl.tag_source is distinct from 'manual' then excluded.tag else wallet_pnl.tag end`,
        vals)).rowCount;
    }
    const delc = await c.query(`delete from wallet_clusters where cluster_id like $1`,
      [t.toLowerCase() + '-%']);
    let cins = 0;
    for (let i = 0; i < P.clusters.length; i += 200) {
      const b = P.clusters.slice(i, i + 200);
      cins += (await c.query(
        `insert into wallet_clusters (chain,wallet,cluster_id,signal,evidence,confidence,cluster_size,created_at)
         select *, now() from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::int[])
         on conflict (chain,wallet,signal,cluster_id) do update set evidence=excluded.evidence,
           confidence=excluded.confidence, cluster_size=excluded.cluster_size`,
        [b.map(x=>x.chain),b.map(x=>x.wallet),b.map(x=>x.cluster_id),b.map(x=>x.signal),
         b.map(x=>x.evidence),b.map(x=>x.confidence),b.map(x=>x.cluster_size)])).rowCount;
    }
    const TC = Object.keys(P.token);
    const tk = await c.query(
      `insert into wallet_pnl_tokens (${TC.join(',')}) values (${TC.map((_,i)=>`$${i+1}`).join(',')})
       on conflict (token,chain) do update set ${TC.filter(x=>x!=='token'&&x!=='chain').map(x=>`${x}=excluded.${x}`).join(',')}, updated_at=now()`,
      TC.map(k => P.token[k]));
    console.log(`   ${t}: stale removed ${stale.rowCount}, upserted ${ins}, clusters ${delc.rowCount} removed / ${cins} inserted, token record ${tk.rowCount}`);
  }
  console.log('\n-- AFTER (in transaction)');
  for (const r of await q(`select token, count(*)::int n, round(sum(realized_pnl_usd)::numeric,2) real
                             from wallet_pnl group by 1 order by 1`))
    console.log(`   ${r.token.padEnd(11)}${String(r.n).padStart(6)}  $${r.real}`);
  const u = (await q(`select count(*)::int t, count(distinct (wallet,token))::int d from wallet_pnl`))[0];
  console.log(`   union invariant ${u.t} = ${u.d}  ${u.t===u.d?'OK':'*** FAN-OUT ***'}`);
  if (DRY) { await c.query('rollback'); console.log('\nROLLED BACK (dry run)'); }
  else { await c.query('commit'); console.log('\nCOMMITTED'); }
} catch (e) { await c.query('rollback'); console.log('ROLLED BACK: '+e.message); process.exitCode=1; }
await c.end();
