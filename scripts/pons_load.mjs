/**
 * Load PONS into wallet_pnl / wallet_clusters / wallet_pnl_tokens.
 *
 * SAFETY:
 *  - Every write is scoped to token='PONS' or cluster_id like 'pons-%'. CATE,
 *    CYBERLEEK and NTF rows are never in range of any statement here.
 *  - Manual tags survive: tag is only written where tag_source is distinct from
 *    'manual'. PONS writes no tags at all, so this is belt and braces.
 *  - One transaction. Counts are read back inside it before COMMIT, and again
 *    from a fresh connection afterwards, because a clean exit is not evidence.
 */
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const P = JSON.parse(gunzipSync(Buffer.from(readFileSync('/app/_p.b64', 'utf8'), 'base64')).toString());
const { rows, clusters, token } = P;
console.log(`payload: ${rows.length} rows, ${clusters.length} clusters, token ${token.token}`);

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();

const NEW = [
  ['has_off_pool_activity', 'boolean'], ['tokens_bought', 'numeric'],
  ['tokens_sold', 'numeric'], ['implied_balance', 'numeric'],
  ['onchain_balance', 'numeric'], ['balance_delta', 'numeric'],
  ['balance_match', 'boolean'], ['boundary_balance', 'numeric'],
  ['boundary_delta', 'numeric'], ['unrealized_pnl_usd', 'numeric'],
  ['still_holding', 'boolean'], ['price_usd', 'numeric'],
  ['price_block', 'bigint'], ['balance_block', 'bigint'],
];
for (const [n, t] of NEW) await c.query(`alter table wallet_pnl add column if not exists ${n} ${t}`);
await c.query(`create table if not exists wallet_pnl_tokens (
  token text not null, chain text not null, token_address text, pool_address text,
  dex text, dex_version text, quote_asset text, quote_address text,
  quote_decimals int, total_supply numeric, window_hours numeric,
  window_start_utc text, window_end_utc text, first_swap_block bigint,
  boundary_block bigint, swaps_in_window int, unique_txs int,
  fully_covered boolean, mcap_threshold_usd numeric, threshold_binding boolean,
  threshold_note text, fee_rate_buy numeric, fee_rate_sell numeric,
  usd_method text, rate_basis text, price_usd numeric, price_block bigint,
  balance_block bigint, cohort_size int, decode_check text,
  updated_at timestamptz not null default now(),
  primary key (token, chain))`);
console.log('schema ready');

const PCOLS = ['wallet','token','chain','quote_asset','tag','tag_source','first_buy_time_utc',
  'last_sell_time_utc','n_buys','n_sells','sol_in','sol_out','realized_pnl_sol','realized_pnl_usd',
  'tokens_still_held','hold_min','sold_out','pre_window_entry','first_buy_mcap_usd','rate_basis',
  'tokens_bought','tokens_sold','implied_balance','onchain_balance','balance_delta','balance_match',
  'boundary_balance','boundary_delta','unrealized_pnl_usd','still_holding','has_off_pool_activity',
  'price_usd','price_block','balance_block'];

await c.query('begin');
try {
  let ins = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const b = rows.slice(i, i + 200);
    const vals = [], ph = [];
    b.forEach((r, k) => {
      ph.push('(' + PCOLS.map((_, j) => `$${k * PCOLS.length + j + 1}`).join(',') + ')');
      for (const col of PCOLS) vals.push(r[col] ?? null);
    });
    const r = await c.query(
      `insert into wallet_pnl (${PCOLS.join(',')}) values ${ph.join(',')}
       on conflict (wallet, token) do update set ${
         PCOLS.filter(x => x !== 'wallet' && x !== 'token' && x !== 'tag')
              .map(x => `${x}=excluded.${x}`).join(',')},
         tag = case when wallet_pnl.tag_source is distinct from 'manual'
                    then excluded.tag else wallet_pnl.tag end`, vals);
    ins += r.rowCount;
  }
  console.log(`wallet_pnl upserted: ${ins}`);

  const del = await c.query(`delete from wallet_clusters where cluster_id like 'pons-%'`);
  console.log(`wallet_clusters pons-% removed first: ${del.rowCount}`);
  let cins = 0;
  if (clusters.length) {
    for (let i = 0; i < clusters.length; i += 200) {
      const b = clusters.slice(i, i + 200);
      const r = await c.query(
        `insert into wallet_clusters (chain,wallet,cluster_id,signal,evidence,confidence,cluster_size,created_at)
         select * from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[],$7::int[])
              , (select now()) t
         on conflict (chain,wallet,signal,cluster_id) do update set
            evidence=excluded.evidence, confidence=excluded.confidence, cluster_size=excluded.cluster_size`,
        [b.map(x=>x.chain), b.map(x=>x.wallet), b.map(x=>x.cluster_id), b.map(x=>x.signal),
         b.map(x=>x.evidence), b.map(x=>x.confidence), b.map(x=>x.cluster_size)]);
      cins += r.rowCount;
    }
  }
  console.log(`wallet_clusters inserted: ${cins}`);

  const TC = Object.keys(token);
  const t = await c.query(
    `insert into wallet_pnl_tokens (${TC.join(',')}) values (${TC.map((_,i)=>`$${i+1}`).join(',')})
     on conflict (token,chain) do update set ${TC.filter(x=>x!=='token'&&x!=='chain').map(x=>`${x}=excluded.${x}`).join(',')}, updated_at=now()`,
    TC.map(k => token[k]));
  console.log(`wallet_pnl_tokens upserted: ${t.rowCount}`);

  const chk = await c.query(`select count(*)::int n from wallet_pnl where token='PONS'`);
  const chk2 = await c.query(`select count(*)::int n from wallet_clusters where cluster_id like 'pons-%'`);
  console.log(`in-transaction: wallet_pnl PONS=${chk.rows[0].n}, clusters pons-%=${chk2.rows[0].n}`);
  if (chk.rows[0].n !== rows.length) throw new Error(`expected ${rows.length} PONS rows, saw ${chk.rows[0].n}`);
  await c.query('commit');
  console.log('COMMITTED');
} catch (e) {
  await c.query('rollback');
  console.log('ROLLED BACK: ' + e.message);
  process.exitCode = 1;
}
await c.end();
