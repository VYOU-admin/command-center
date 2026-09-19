/**
 * `npm run loser-separate` — 9A/9B scoring. **ZERO RPC.**
 *
 * Within the §7 population only (`creator_share >= 40%` AND `sold-by-90s < 25%`), deep
 * losers at the 215 s exit against the rest. Outcome comes from `bot_timing_path`:
 * tokens-per-ETH at 115 s over tokens-per-ETH at 215 s, already paid for in §8A.
 *
 * Same estimator as 5B — **stratified Cliff's delta, pooled by pair count, bar set
 * before reading (|δ| ≥ 0.15 plus a visible median gap)** — because a t-test on these
 * distributions reports the tail. Controls that should find nothing are carried through:
 * if a control "separates", the estimator is inventing structure and the table is void.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';

const CHAIN = 'robinhood';
const DEEP = -0.70;
const BAR = 0.15;

interface Row { pool_id: string; hour_bucket: number; ret: number;
  [k: string]: string | number | boolean | null }

const med = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
function cliff(a: number[], b: number[]): { d: number; pairs: number } {
  if (a.length === 0 || b.length === 0) return { d: 0, pairs: 0 };
  let gt = 0; let lt = 0;
  for (const x of a) for (const y of b) { if (x > y) gt += 1; else if (x < y) lt += 1; }
  return { d: (gt - lt) / (a.length * b.length), pairs: a.length * b.length };
}

async function main(): Promise<void> {
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = (await c.query<Row>(
      `with o as (
         select a.pool_id,
                max(case when t.t_seconds = 115 then t.eth_out end)::float8 tin,
                max(case when t.t_seconds = 215 then t.eth_out end)::float8 tout
           from bot_timing_path t
           join bot_entry_state a on a.chain = t.chain and a.pool_id = t.pool_id
          where t.chain = $1 group by 1
       )
       select e.*, f.creator_share::float8 as creator_share,
              f.creator_eth::float8 as creator_eth,
              f.buyers_15s, f.eth_in_15s::float8 as eth_in_15s,
              (e.init_block/36000)::int as hour_bucket,
              case when o.tout is null or o.tout <= 0 then -1
                   else o.tin/o.tout - 1 end as ret
         from bot_entry_state e
         join o on o.pool_id = e.pool_id
         join bot_runner_features f on f.chain = e.chain and f.pool_id = e.pool_id
         join bot_sell_profile p on p.chain = e.chain and p.pool_id = e.pool_id
        where e.chain = $1 and f.creator_share >= 0.40 and p.sold_90 < 0.25
          and o.tin is not null and o.tin > 0`, [CHAIN])).rows;

    const deep = rows.filter((r) => r.ret <= DEEP);
    const rest = rows.filter((r) => r.ret > DEEP);

    const num = (k: string) => (r: Row): number | null =>
      r[k] === null || r[k] === undefined ? null : Number(r[k]);
    const bool = (k: string) => (r: Row): number | null =>
      r[k] === null || r[k] === undefined ? null : (r[k] ? 1 : 0);

    const FEATURES: Array<[string, (r: Row) => number | null]> = [
      /* ---- 9B: THE OVERHANG ---- */
      ['** top non-pool holder share @115s', num('top_holder_share')],
      ['** holders over 5% of supply @115s', num('holders_over_5pct')],
      ['** creator still holds @115s', num('creator_holds')],
      ['** top holder IS the creator', bool('top_holder_is_creator')],
      /* ---- 9A: flow ---- */
      ['cumulative sold by +30 s', num('sold_30')],
      ['cumulative sold by +60 s', num('sold_60')],
      ['cumulative sold by +90 s', num('sold_90')],
      ['cumulative sold by +115 s', num('sold_115')],
      ['largest single sell so far', num('largest_sell')],
      ['number of sells so far', num('n_sells')],
      ['seconds since the last sell', num('secs_since_last_sell')],
      ['sells in 90-115 s bucket', num('sells_90_115')],
      ['buys in 90-115 s bucket', num('buys_90_115')],
      ['buys 0-30 s', num('buys_0_30')],
      ['buys 30-60 s', num('buys_30_60')],
      ['buys 60-90 s', num('buys_60_90')],
      /* ---- 9A: price shape ---- */
      ['price multiple at entry vs launch', num('price_mult_115')],
      ['peak multiple before entry', num('price_peak_mult')],
      ['faded from its own peak by entry', num('faded_from_peak')],
      /* ---- 9A: depth and participation ---- */
      ['ETH into the pool, total', num('eth_in_total')],
      ['ETH in during 90-115 s', num('eth_in_90_115')],
      ['net ETH in the pool at entry', num('pool_eth')],
      ['distinct buyer transactions', num('distinct_buyers')],
      ['top buyer share of buy volume', num('top_buyer_share')],
      /* ---- continuous forms of the gates ---- */
      ['creator supply share (continuous)', num('creator_share')],
      ['creator ETH (continuous)', num('creator_eth')],
      /* ---- CONTROLS: should find nothing ---- */
      ['CONTROL buyers by +15 s', num('buyers_15s')],
      ['CONTROL ETH in by +15 s', num('eth_in_15s')],
      ['CONTROL init block parity', (r) => Number(r['init_block']) % 2],
    ];

    const hours = [...new Set(rows.map((r) => r.hour_bucket))];
    const out: string[] = [];
    out.push('feature                                  n_deep  n_rest   med(deep)  med(rest)'
      + '   delta   verdict');
    const hits: string[] = [];
    for (const [name, get] of FEATURES) {
      let numer = 0; let den = 0;
      const dA: number[] = []; const rA: number[] = [];
      for (const h of hours) {
        const g = rows.filter((r) => r.hour_bucket === h);
        const a = g.filter((r) => r.ret <= DEEP).map(get)
          .filter((x): x is number => x !== null && Number.isFinite(x));
        const b = g.filter((r) => r.ret > DEEP).map(get)
          .filter((x): x is number => x !== null && Number.isFinite(x));
        if (a.length === 0 || b.length === 0) continue;
        dA.push(...a); rA.push(...b);
        const { d, pairs } = cliff(a, b);
        numer += d * pairs; den += pairs;
      }
      if (den === 0) { out.push(`${name.padEnd(40)} RETURNED NO ROWS`); continue; }
      const delta = numer / den;
      const md = med(dA); const mr = med(rA);
      const gap = md !== null && mr !== null && Math.abs(md - mr) > 1e-12;
      const sig = Math.abs(delta) >= BAR && gap;
      if (sig) hits.push(`${name.trim()} (delta ${delta.toFixed(3)})`);
      out.push(`${name.padEnd(40)} ${String(dA.length).padStart(6)} ${String(rA.length).padStart(7)} `
        + `${(md === null ? 'n/a' : md.toPrecision(4)).padStart(11)} `
        + `${(mr === null ? 'n/a' : mr.toPrecision(4)).padStart(10)} `
        + `${delta.toFixed(3).padStart(7)}   ${sig ? 'SEPARATES' : 'nothing'}`);
    }

    log.info('*** 9A/9B  DEEP LOSERS vs THE REST, WITHIN THE §7 POPULATION ***', {
      population: 'creator_share >= 40% AND sold-by-90s < 25%',
      n: rows.length,
      deep_losers: `${deep.length} (${(100 * deep.length / rows.length).toFixed(1)}%)`,
      rest: rest.length,
      hour_buckets_with_both: hours.filter((h) => {
        const g = rows.filter((r) => r.hour_bucket === h);
        return g.some((r) => r.ret <= DEEP) && g.some((r) => r.ret > DEEP);
      }).length,
      features_tested: FEATURES.length,
      features_that_SEPARATE: hits.length,
      survivors: hits.length === 0
        ? ['NONE — every quantity observable at +115 s is interchangeable between '
          + 'the deep losers and the rest']
        : hits,
      bar: `|delta| >= ${BAR} AND a visible median gap, set before reading`,
      table: out,
    });

    /* 9B threshold sweep — the most mechanically plausible filter. */
    const sweep: string[] = [];
    sweep.push('keep only if top holder share <=   n   deep%   mean   SUM   win%   kept%');
    for (const th of [0.20, 0.30, 0.40, 0.50, 0.55, 0.60, 1.01]) {
      const g = rows.filter((r) => r['top_holder_share'] !== null
        && Number(r['top_holder_share']) <= th);
      if (g.length === 0) { sweep.push(`${(100 * th).toFixed(0).padStart(3)}%  RETURNED NO ROWS`); continue; }
      const rs = g.map((r) => r.ret);
      const sum = rs.reduce((a, b) => a + b, 0);
      sweep.push(`${(100 * th).toFixed(0).padStart(3)}%${' '.repeat(28)}${String(g.length).padStart(4)} `
        + `${(100 * rs.filter((x) => x <= DEEP).length / rs.length).toFixed(0).padStart(6)}% `
        + `${(100 * sum / rs.length).toFixed(1).padStart(6)}% ${sum.toFixed(2).padStart(6)} `
        + `${(100 * rs.filter((x) => x > 0).length / rs.length).toFixed(0).padStart(5)}% `
        + `${(100 * g.length / rows.length).toFixed(0).padStart(6)}%`);
    }
    log.info('9B  THRESHOLD SWEEP ON THE OVERHANG', {
      note: 'EXPLORATORY on training data. Nothing here may be adopted without being '
        + 'committed to git and scored on a window it has not seen.',
      table: sweep,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('loser-separate failed', errorFields(e)); process.exit(1); });
