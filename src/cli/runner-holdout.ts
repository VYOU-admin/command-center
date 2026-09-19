/**
 * `npm run runner-holdout` — 5C: DOES ANYTHING FROM 5B REPRODUCE OUT OF TIME?
 *
 * **ZERO RPC.** Every figure comes from `bot_runner_features` and `bot_runner_label`.
 *
 * ===========================================================================
 * THE SPLIT IS BY TIME, AND IT IS FIXED BEFORE ANY DELTA IS READ
 * ===========================================================================
 *
 * §6I's holdout was pool-id parity, which tests whether a result is an artefact of
 * *particular pools*. It cannot see a regime. **This splits at the median
 * initialization block: train on the earlier half, test on the later half**, exactly as
 * the brief specifies. The split point is derived from the data and printed before the
 * results.
 *
 * **AND IT IS A HARDER TEST THAN INTENDED, WHICH IS WORTH SAYING UP FRONT.** §6J located
 * a regime change at block ~62.2–63.1M — the ≥40% creator-share rate stepped from 0–9%
 * to 46–67% and held. That boundary falls **inside the earlier half**. So the early half
 * straddles two regimes and the late half is entirely inside the new one. A signal that
 * survives this survived a regime change; a signal that fails might have failed only
 * because the halves are not the same market.
 *
 * Both are therefore reported: the **median split the brief asked for**, and a
 * **within-new-regime split** that holds the regime constant. **Neither is presented as
 * the answer alone.**
 *
 * A signal REPRODUCES when the later half carries the **same sign** and clears the same
 * bar the training half was judged against (|δ| ≥ 0.15). Anything else is dropped and
 * said to be dropped.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';

const CHAIN = 'robinhood';
const RUNNER = 1.5;
const DELTA_BAR = 0.15;
/** §6J: the ≥40% creator-share rate steps up here and holds. */
const REGIME_BLOCK = 63_072_000;

interface Row {
  pool_id: string; init_block: number; hour_bucket: number; peak_mult: number;
  [k: string]: string | number | boolean | null;
}

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
/** Stratified by hour and pooled by pair count — the same estimator 5B used. */
function stratified(rows: Row[], get: (r: Row) => number | null): {
  d: number | null; nRun: number; nNon: number; mRun: number | null; mNon: number | null;
} {
  let num = 0; let den = 0;
  const runAll: number[] = []; const nonAll: number[] = [];
  for (const h of new Set(rows.map((r) => r.hour_bucket))) {
    const g = rows.filter((r) => r.hour_bucket === h);
    const run = g.filter((r) => r.peak_mult >= RUNNER).map(get)
      .filter((x): x is number => x !== null && Number.isFinite(x));
    const non = g.filter((r) => r.peak_mult < RUNNER).map(get)
      .filter((x): x is number => x !== null && Number.isFinite(x));
    if (run.length === 0 || non.length === 0) continue;
    runAll.push(...run); nonAll.push(...non);
    const { d, pairs } = cliff(run, non);
    num += d * pairs; den += pairs;
  }
  return { d: den === 0 ? null : num / den, nRun: runAll.length, nNon: nonAll.length,
    mRun: med(runAll), mNon: med(nonAll) };
}

async function main(): Promise<void> {
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = (await c.query<Row>(
      `select f.*, f.init_block::float8 as init_block, l.peak_mult::float8 as peak_mult
         from bot_runner_features f
         join bot_runner_label l on l.chain = f.chain and l.pool_id = f.pool_id
        where f.chain = $1`, [CHAIN])).rows;

    const blocks = rows.map((r) => Number(r.init_block)).sort((a, b) => a - b);
    const SPLIT = blocks[Math.floor(blocks.length / 2)]!;

    const early = rows.filter((r) => Number(r.init_block) < SPLIT);
    const late = rows.filter((r) => Number(r.init_block) >= SPLIT);
    const newRegime = rows.filter((r) => Number(r.init_block) >= REGIME_BLOCK);
    const nrBlocks = newRegime.map((r) => Number(r.init_block)).sort((a, b) => a - b);
    const NR_SPLIT = nrBlocks.length > 0 ? nrBlocks[Math.floor(nrBlocks.length / 2)]! : 0;
    const nrEarly = newRegime.filter((r) => Number(r.init_block) < NR_SPLIT);
    const nrLate = newRegime.filter((r) => Number(r.init_block) >= NR_SPLIT);

    const rate = (g: Row[]): string => g.length === 0 ? 'n/a'
      : `${(100 * g.filter((r) => r.peak_mult >= RUNNER).length / g.length).toFixed(1)}%`;

    log.info('5C  THE SPLIT, FIXED BEFORE ANY DELTA IS READ', {
      pools: rows.length,
      split_block: SPLIT,
      early: `${early.length} pools, runner rate ${rate(early)}`,
      late: `${late.length} pools, runner rate ${rate(late)}`,
      regime_change_block: REGIME_BLOCK,
      WARNING: 'the §6J regime boundary falls INSIDE the early half, so the early half '
        + 'straddles two regimes and the late half is entirely in the new one. A signal '
        + 'that survives this survived a regime change; one that fails may have failed '
        + 'only because the halves are different markets.',
      within_new_regime_split_block: NR_SPLIT,
      nr_early: `${nrEarly.length} pools, runner rate ${rate(nrEarly)}`,
      nr_late: `${nrLate.length} pools, runner rate ${rate(nrLate)}`,
      bar: `|delta| >= ${DELTA_BAR} AND the same sign as the training half`,
    });

    /*
     * THE REPRESENTATIVE OF THE COLLINEAR GROUP IS `creator_eth`. §6L.2 measured
     * creator_eth == largest_buy_15s on 93.7% of records, so testing all four would be
     * testing one thing four times and would inflate the survivor count.
     */
    const FEATURES: Array<[string, (r: Row) => number | null]> = [
      ['creator ETH into creation tx  [the 5B signal]', (r) => r['creator_eth'] === null ? null : Number(r['creator_eth'])],
      ['  (collinear) creator supply share', (r) => r['creator_share'] === null ? null : Number(r['creator_share'])],
      ['  (collinear) largest buy by +15 s', (r) => r['largest_buy_15s'] === null ? null : Number(r['largest_buy_15s'])],
      ['  (collinear) total ETH in by +15 s', (r) => r['eth_in_15s'] === null ? null : Number(r['eth_in_15s'])],
      ['has emoji  [small 5B signal]', (r) => r['has_emoji'] === null ? null : (r['has_emoji'] ? 1 : 0)],
      ['distinct buyers by +5 s  [small 5B signal]', (r) => r['buyers_5s'] === null ? null : Number(r['buyers_5s'])],
      ['distinct buyers by +10 s  [control, failed 5B]', (r) => r['buyers_10s'] === null ? null : Number(r['buyers_10s'])],
      ['pool liquidity at init  [control, failed 5B]', (r) => r['pool_liquidity'] === null ? null : Number(r['pool_liquidity'])],
      ['token name length  [control, failed 5B]', (r) => r['name_len'] === null ? null : Number(r['name_len'])],
    ];

    const table = (a: Row[], b: Row[], la: string, lb: string): string[] => {
      const out: string[] = [];
      out.push(`feature                                        d(${la.padEnd(5)})  `
        + `d(${lb.padEnd(5)})   med(run/non) late       verdict`);
      for (const [name, get] of FEATURES) {
        const A = stratified(a, get); const B = stratified(b, get);
        if (A.d === null || B.d === null) {
          out.push(`${name.padEnd(46)} RETURNED NO ROWS`); continue;
        }
        const trained = Math.abs(A.d) >= DELTA_BAR;
        const held = Math.abs(B.d) >= DELTA_BAR && Math.sign(B.d) === Math.sign(A.d);
        const verdict = !trained ? 'not a signal to begin with'
          : held ? 'REPRODUCES' : 'DROPPED — does not hold';
        out.push(`${name.padEnd(46)} ${A.d.toFixed(3).padStart(8)} ${B.d.toFixed(3).padStart(8)}   `
          + `${(B.mRun === null ? 'n/a' : B.mRun.toPrecision(4)).padStart(9)} / `
          + `${(B.mNon === null ? 'n/a' : B.mNon.toPrecision(4)).padStart(9)}  ${verdict}`);
      }
      return out;
    };

    log.info('*** 5C  PRIMARY — MEDIAN TIME SPLIT, AS THE BRIEF SPECIFIES ***', {
      train: `blocks < ${SPLIT}  (n=${early.length})`,
      test: `blocks >= ${SPLIT}  (n=${late.length})`,
      table: table(early, late, 'early', 'late'),
    });
    log.info('*** 5C  SECONDARY — WITHIN THE NEW REGIME ONLY ***', {
      note: 'holds the §6J regime constant, so a failure above cannot be blamed on the '
        + 'halves being different markets. Smaller n, and reported for that reason.',
      train: `${REGIME_BLOCK} <= blocks < ${NR_SPLIT}  (n=${nrEarly.length})`,
      test: `blocks >= ${NR_SPLIT}  (n=${nrLate.length})`,
      table: table(nrEarly, nrLate, 'nr-A', 'nr-B'),
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('runner-holdout failed', errorFields(e)); process.exit(1); });
