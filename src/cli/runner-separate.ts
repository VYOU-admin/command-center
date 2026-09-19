/**
 * `npm run runner-separate` — 5B's scoring half. **ZERO RPC: every figure comes from
 * `bot_runner_features` and `bot_runner_label`.**
 *
 * ===========================================================================
 * STRATIFIED CLIFF'S DELTA, AND WHY NOT A p-VALUE
 * ===========================================================================
 *
 * Cliff's delta is `P(runner > non-runner) − P(runner < non-runner)`: −1 to +1, zero
 * meaning the two distributions are interchangeable. It is non-parametric, it belongs
 * with medians, and it is not moved by the extreme tails these quantities have — a
 * t-test on a distribution whose p99 is +1,381% would be reporting the tail.
 *
 * **IT IS COMPUTED WITHIN EACH HOUR AND THEN POOLED**, weighted by the pairs each hour
 * contributes. §6K.5 measured median swaps per launch moving 9 → 502 across these days,
 * so an unstratified comparison would let chain activity carry any signal it liked. A
 * feature scores here only if it separates launches that happened **alongside each
 * other**.
 *
 * Conventional reading: |δ| < 0.11 negligible, < 0.28 small, < 0.43 medium, else large.
 * **The bar for calling something a signal is set BEFORE the table is read: |δ| ≥ 0.15
 * AND a visible gap between the medians.** Anything below is reported as tested and
 * found nothing, because twenty tested with one survivor is a different result from one
 * tested with one survivor.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';

const CHAIN = 'robinhood';
/** §6K: a runner peaks at least +50% within fifteen minutes of a +15 s entry. */
const RUNNER = 1.5;
const DELTA_BAR = 0.15;

interface Row {
  pool_id: string; hour_bucket: number; peak_mult: number;
  [k: string]: string | number | boolean | null;
}

const med = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

/** Cliff's delta for one stratum, returned with its pair count for pooling. */
function cliff(a: number[], b: number[]): { d: number; pairs: number } {
  if (a.length === 0 || b.length === 0) return { d: 0, pairs: 0 };
  let gt = 0; let lt = 0;
  for (const x of a) for (const y of b) { if (x > y) gt += 1; else if (x < y) lt += 1; }
  const pairs = a.length * b.length;
  return { d: (gt - lt) / pairs, pairs };
}

async function main(): Promise<void> {
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = (await c.query<Row>(
      `select f.*, l.peak_mult::float8 as peak_mult
         from bot_runner_features f
         join bot_runner_label l on l.chain = f.chain and l.pool_id = f.pool_id
        where f.chain = $1`, [CHAIN])).rows;

    /* Within-sample repeat creators. A creator's launches OUTSIDE this sample are
     * invisible, so this UNDERCOUNTS and is labelled as a lower bound. */
    const creatorCount = new Map<string, number>();
    for (const r of rows) {
      const cr = r['creator'] as string | null;
      if (cr !== null) creatorCount.set(cr, (creatorCount.get(cr) ?? 0) + 1);
    }

    const FEATURES: Array<[string, (r: Row) => number | null]> = [
      ['creator supply share', (r) => r['creator_share'] === null ? null : Number(r['creator_share'])],
      ['creator ETH into creation tx', (r) => r['creator_eth'] === null ? null : Number(r['creator_eth'])],
      ['pool liquidity at init', (r) => r['pool_liquidity'] === null ? null : Number(r['pool_liquidity'])],
      ['token name length', (r) => r['name_len'] === null ? null : Number(r['name_len'])],
      ['token symbol length', (r) => r['symbol_len'] === null ? null : Number(r['symbol_len'])],
      ['description length', (r) => r['desc_len'] === null ? null : Number(r['desc_len'])],
      ['has emoji (0/1)', (r) => r['has_emoji'] === null ? null : (r['has_emoji'] ? 1 : 0)],
      ['description empty (0/1)', (r) => r['desc_empty'] === null ? null : (r['desc_empty'] ? 1 : 0)],
      ['symbol collides with a known token (0/1)', (r) => r['symbol_collision'] === null ? null : (r['symbol_collision'] ? 1 : 0)],
      ['distinct buyers by +5 s', (r) => r['buyers_5s'] === null ? null : Number(r['buyers_5s'])],
      ['distinct buyers by +10 s', (r) => r['buyers_10s'] === null ? null : Number(r['buyers_10s'])],
      ['distinct buyers by +15 s', (r) => r['buyers_15s'] === null ? null : Number(r['buyers_15s'])],
      ['total ETH in by +15 s', (r) => r['eth_in_15s'] === null ? null : Number(r['eth_in_15s'])],
      ['largest single buy by +15 s', (r) => r['largest_buy_15s'] === null ? null : Number(r['largest_buy_15s'])],
      ['swaps by +15 s', (r) => r['swaps_15s'] === null ? null : Number(r['swaps_15s'])],
      ['sells by +15 s', (r) => r['sells_15s'] === null ? null : Number(r['sells_15s'])],
      ['sell/swap ratio by +15 s', (r) => {
        const s = Number(r['swaps_15s'] ?? 0);
        return s === 0 ? null : Number(r['sells_15s'] ?? 0) / s;
      }],
      ['a SCORED wallet bought by +15 s (0/1)', (r) => r['scored_buyer_hits'] === null ? null : (Number(r['scored_buyer_hits']) > 0 ? 1 : 0)],
      ['best scored-wallet score by +15 s', (r) => r['best_buyer_score'] === null ? null : Number(r['best_buyer_score'])],
      ['someone sold inside +15 s (0/1)', (r) => r['creator_sold_by_15s'] === null ? null : (r['creator_sold_by_15s'] ? 1 : 0)],
      ['creator appears >1x in sample (0/1)', (r) => {
        const cr = r['creator'] as string | null;
        return cr === null ? null : ((creatorCount.get(cr) ?? 0) > 1 ? 1 : 0);
      }],
    ];

    const hours = [...new Set(rows.map((r) => r.hour_bucket))];
    const out: string[] = [];
    out.push('feature                                     n_run  n_non   med(run)  med(non)'
      + '   delta  hours   verdict');
    const survivors: string[] = [];

    for (const [name, get] of FEATURES) {
      let num = 0; let den = 0; let usedHours = 0;
      const runAll: number[] = []; const nonAll: number[] = [];
      for (const h of hours) {
        const g = rows.filter((r) => r.hour_bucket === h);
        const run = g.filter((r) => r.peak_mult >= RUNNER)
          .map(get).filter((x): x is number => x !== null && Number.isFinite(x));
        const non = g.filter((r) => r.peak_mult < RUNNER)
          .map(get).filter((x): x is number => x !== null && Number.isFinite(x));
        if (run.length === 0 || non.length === 0) continue;
        usedHours += 1;
        runAll.push(...run); nonAll.push(...non);
        const { d, pairs } = cliff(run, non);
        num += d * pairs; den += pairs;
      }
      if (den === 0) {
        out.push(`${name.padEnd(42)} RETURNED NO ROWS — no hour has both classes`);
        continue;
      }
      const delta = num / den;
      const mr = med(runAll); const mn = med(nonAll);
      const gap = mr !== null && mn !== null && Math.abs(mr - mn) > 1e-12;
      const isSignal = Math.abs(delta) >= DELTA_BAR && gap;
      if (isSignal) survivors.push(`${name} (delta ${delta.toFixed(3)})`);
      out.push(`${name.padEnd(42)} ${String(runAll.length).padStart(5)} `
        + `${String(nonAll.length).padStart(6)} `
        + `${(mr === null ? 'n/a' : mr.toPrecision(4)).padStart(10)} `
        + `${(mn === null ? 'n/a' : mn.toPrecision(4)).padStart(9)} `
        + `${delta.toFixed(3).padStart(7)} ${String(usedHours).padStart(6)}   `
        + `${isSignal ? 'SIGNAL' : 'nothing'}`);
    }

    log.info('*** 5B  RUNNERS vs NON-RUNNERS, SAME HOUR ***', {
      pools: rows.length,
      runners: rows.filter((r) => r.peak_mult >= RUNNER).length,
      non_runners: rows.filter((r) => r.peak_mult < RUNNER).length,
      hour_buckets: hours.length,
      runner_definition: 'peak >= +50% within 15 min of a +15 s entry (§6K)',
      effect_size: "stratified Cliff's delta, pooled by pair count. |d|<0.11 negligible, "
        + '<0.28 small, <0.43 medium, else large.',
      bar_set_BEFORE_reading: `|delta| >= ${DELTA_BAR} AND a visible median gap`,
      features_tested: FEATURES.length,
      features_that_SEPARATE: survivors.length,
      survivors: survivors.length === 0
        ? ['NONE — every quantity tested is interchangeable between the two groups']
        : survivors,
      table: out,
      caveat_creator_repeats: 'repeat-creator counts are WITHIN THIS SAMPLE only; '
        + 'launches by the same creator outside it are invisible, so that feature is a '
        + 'LOWER BOUND and a null there is weak evidence',
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('runner-separate failed', errorFields(e)); process.exit(1); });
