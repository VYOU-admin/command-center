/**
 * Load CYBERLEEK per-wallet PnL into wallet_pnl with token='CYBERLEEK'.
 *
 * SAFETY, in order of how badly each would hurt:
 *
 *  - CATE ROWS ARE NEVER TOUCHED. Every statement is scoped to
 *    token='CYBERLEEK'. The table is keyed (wallet, token), so a wallet that
 *    traded both tokens gets a second row rather than overwriting its first.
 *
 *  - MANUAL TAGS SURVIVE. Tags are written only where tag_source is distinct
 *    from 'manual'. A hand-entered tag is never overwritten by a reload.
 *
 *  - GROUPS ARE NUMBERED INDEPENDENTLY as cl-grp-NN, so they cannot collide
 *    with CATE's grp-NN and cannot be confused for the same cohort.
 *
 * Grouping is mechanical: wallets sharing an exact first-buy second. Note this
 * is weaker evidence than it looks — Solana blockTime is per-slot, so wallets
 * in the same slot share a timestamp whether or not they are related.
 */

import { readFileSync } from 'node:fs';
import pg from 'pg';

const CSV = process.argv[2] ?? 'data/cyberleek_wallet_pnl.csv';
const TOKEN = 'CYBERLEEK';

function parseCsv(text) {
  const lines = text.trim().split('\n');
  const cols = lines[0].split(',');
  return lines.slice(1).map((line) => {
    // no quoted fields in this file: every value is a number, bool or base58
    const parts = line.split(',');
    return Object.fromEntries(cols.map((c, i) => [c, parts[i]]));
  });
}

const num = (v) => (v === '' || v === undefined ? null : Number(v));
const int = (v) => (v === '' || v === undefined ? null : Math.round(Number(v)));

const rows = parseCsv(readFileSync(CSV, 'utf8'));
console.log(`read ${rows.length} rows from ${CSV}`);

// mechanical groups on exact first-buy second, numbered independently
const bySecond = new Map();
for (const r of rows) {
  const k = r.first_buy_time;
  if (!bySecond.has(k)) bySecond.set(k, []);
  bySecond.get(k).push(r.wallet);
}
const groups = [...bySecond.entries()]
  .filter(([, ws]) => ws.length > 1)
  .sort((a, b) => Number(a[0]) - Number(b[0]));
const tagOf = new Map();
groups.forEach(([, ws], i) => {
  const tag = `cl-grp-${String(i + 1).padStart(2, '0')}`;
  for (const w of ws) tagOf.set(w, tag);
});
console.log(`${groups.length} groups formed, covering ${tagOf.size} of ${rows.length} wallets`);

const url = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!url) throw new Error('no DATABASE_URL in env');
const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await c.connect();

const before = await c.query(
  `select token, count(*)::int n from wallet_pnl group by token order by token`,
);
console.log('before:', JSON.stringify(before.rows));

await c.query('begin');
try {
  for (const r of rows) {
    await c.query(
      `insert into wallet_pnl (
         wallet, token, first_buy_time_utc, first_buy_mcap_usd, last_sell_time_utc,
         n_buys, n_sells, sol_in, sol_out, realized_pnl_sol, realized_pnl_usd,
         tokens_still_held, hold_min, sold_out, tag, tag_source)
       values ($1::text,$2::text,$3::text,$4::numeric,$5::text,
               $6::int,$7::int,$8::numeric,$9::numeric,$10::numeric,$11::numeric,
               $12::numeric,$13::numeric,$14::boolean,$15::text,$16::text)
       on conflict (wallet, token) do update set
         first_buy_time_utc = excluded.first_buy_time_utc,
         first_buy_mcap_usd = excluded.first_buy_mcap_usd,
         last_sell_time_utc = excluded.last_sell_time_utc,
         n_buys             = excluded.n_buys,
         n_sells            = excluded.n_sells,
         sol_in             = excluded.sol_in,
         sol_out            = excluded.sol_out,
         realized_pnl_sol   = excluded.realized_pnl_sol,
         realized_pnl_usd   = excluded.realized_pnl_usd,
         tokens_still_held  = excluded.tokens_still_held,
         hold_min           = excluded.hold_min,
         sold_out           = excluded.sold_out,
         -- a hand-entered tag is never clobbered by a reload
         tag        = case when wallet_pnl.tag_source is distinct from 'manual'
                           then excluded.tag else wallet_pnl.tag end,
         tag_source = case when wallet_pnl.tag_source is distinct from 'manual'
                           then excluded.tag_source else wallet_pnl.tag_source end`,
      [
        r.wallet, TOKEN, r.first_buy_time_utc, num(r.first_buy_mcap_usd),
        r.last_sell_time_utc === '' ? null : r.last_sell_time_utc,
        int(r.n_buys), int(r.n_sells), num(r.sol_in), num(r.sol_out),
        num(r.realized_pnl_sol), num(r.realized_pnl_usd), num(r.tokens_still_held),
        r.hold_minutes === '' ? null : num(r.hold_minutes),
        r.sold_out === 'True', tagOf.get(r.wallet) ?? null,
        tagOf.has(r.wallet) ? 'auto' : null,
      ],
    );
  }
  await c.query('commit');
} catch (e) {
  await c.query('rollback');
  throw e;
}

const after = await c.query(
  `select token, count(*)::int n,
          count(*) filter (where tag is not null)::int tagged,
          count(distinct tag)::int groups,
          count(*) filter (where tag_source='manual')::int manual
     from wallet_pnl group by token order by token`,
);
console.log('after:', JSON.stringify(after.rows));
const dupes = await c.query(
  `select count(*)::int n from (select wallet, token from wallet_pnl
     group by 1,2 having count(*)>1) s`,
);
console.log('duplicate (wallet,token):', dupes.rows[0].n);
await c.end();
