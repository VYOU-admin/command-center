/**
 * `npm run daily-loss-derive` — WHAT SHOULD `MAX_DAILY_LOSS_USD` BE?
 *
 * $15 was sized before the strategy's loss distribution had ever been measured. It is
 * 1.5 positions at `MAX_POSITION_USD` = $10, so **two total losses breach it** — and
 * `exit-simulate` then measured the total-loss rate at 11.5%-27.8% depending on the
 * window. A rail that halts a mode with positive expectation on a routine pair of losses
 * is mis-sized, not conservative.
 *
 * This derives the value from the measured distribution rather than taking one as given,
 * by bootstrapping trading days out of the 1,046 simulated round trips in `bot_exit_sim`
 * and asking, for each candidate threshold, **what fraction of days it would halt.**
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DRAWN, AND WHY IT IS THE REAL DISTRIBUTION RATHER THAN A FITTED ONE
 * ---------------------------------------------------------------------------
 *
 * Each draw is one launch's actual simulated round trip at $10 — our own buy and our own
 * sell, at our own size, at the historical entry and exit blocks — converted to dollars
 * and charged the measured $0.0967 of round-trip gas. **No distribution is fitted and no
 * parameter is estimated**; the bootstrap resamples the measured outcomes themselves, so
 * the -100% tail enters at exactly the rate it was observed at.
 *
 * A day is `MAX_TRADES_PER_DAY` draws walked in order, and the rail fires the first time
 * cumulative net PnL reaches -X. **It is the RUNNING minimum that matters, not the day's
 * final total** — a day that ends at +$40 having passed through -$55 was halted at -$55,
 * and scoring it on its close would report a rail that never fires when it does.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS CANNOT SEE, STATED SO THE NUMBER IS NOT OVER-TRUSTED
 * ---------------------------------------------------------------------------
 *
 * - **Trades are drawn INDEPENDENTLY.** Real launches cluster: one launchpad shipping a
 *   bad template produces correlated losses, and correlation makes a run of losses more
 *   likely than this reports. **So every halt probability here is a FLOOR.**
 * - **`fill-not-modelled` is unchanged.** Every draw assumes we won the fill.
 * - The bootstrap is over three windows of ~28 hours each, not over a year.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RAILS } from '../bot/config.js';

/** Measured: buy + sell from other traders' receipts, both approvals from ours. */
const GAS_ROUND_TRIP_USD = 0.0967;
const CANDIDATES = [15, 20, 25, 30, 40, 50, 60, 75, 100];
const DAYS = 20000;

/** Deterministic, so the figure reproduces. Mulberry32. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function main(): Promise<void> {
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const rows = await c.query<{ window_name: string; pnl: string }>(`
      select window_name,
             (case when buy_status='reverted' then 0.0
                   when sell_status='ok' then (eth_out/amount_in_wei - 1)
                   else -1.0 end) * $1 - $2 as pnl
        from bot_exit_sim where size_usd = $1`, [RAILS.MAX_POSITION_USD, GAS_ROUND_TRIP_USD]);
    if (rows.rowCount === 0) {
      throw new Error('bot_exit_sim RETURNED NO ROWS -- run exit-simulate first');
    }

    /*
     * A BUY THAT COULD NOT EXECUTE COSTS NOTHING AND IS NOT A TRADE.
     * It is removed from the draw rather than entered as a zero: the bot never opens
     * that position, so it never consumes one of the day's 40 and never moves PnL.
     * Leaving it in would dilute the loss rate with non-events and understate every
     * halt probability -- the opposite of the error this rail must not make.
     */
    const all = rows.rows.map((r) => Number(r.pnl));
    const byWindow = new Map<string, number[]>();
    for (const r of rows.rows) {
      const arr = byWindow.get(r.window_name) ?? [];
      arr.push(Number(r.pnl));
      byWindow.set(r.window_name, arr);
    }
    const traded = (xs: number[]): number[] =>
      xs.filter((x) => Math.abs(x - (0 - GAS_ROUND_TRIP_USD)) > 1e-9);

    const describe = (name: string, xs: number[]): void => {
      const t = traded(xs);
      const sorted = [...t].sort((a, b) => a - b);
      const q = (p: number): number => sorted[Math.floor(p * (sorted.length - 1))] ?? 0;
      log.info(`${name} PER-TRADE NET PnL, $${RAILS.MAX_POSITION_USD} position`, {
        launches_total: xs.length, trades_actually_opened: t.length,
        never_entered: xs.length - t.length,
        total_losses: t.filter((x) => x <= -RAILS.MAX_POSITION_USD + 0.001).length,
        total_loss_rate: `${(100 * t.filter((x) => x <= -RAILS.MAX_POSITION_USD + 0.001).length / t.length).toFixed(1)}%`,
        min: q(0).toFixed(2), p25: q(0.25).toFixed(2), median: q(0.5).toFixed(2),
        p75: q(0.75).toFixed(2), max: q(1).toFixed(2),
        mean: (t.reduce((a, b) => a + b, 0) / t.length).toFixed(3),
      });
    };
    describe('POOLED', all);
    for (const [w, xs] of byWindow) describe(w, xs);

    /* THE DERIVATION. Worst window first: a rail is sized for the bad day. */
    for (const [name, xs] of [...byWindow, ['POOLED', all] as [string, number[]]]) {
      const pool = traded(xs);
      const r = rng(20260917);
      const halted = new Map<number, number>(CANDIDATES.map((x) => [x, 0]));
      const tradesBefore = new Map<number, number>(CANDIDATES.map((x) => [x, 0]));
      let finals = 0;
      for (let d = 0; d < DAYS; d++) {
        let cum = 0;
        const firstHit = new Map<number, number>();
        for (let i = 0; i < RAILS.MAX_TRADES_PER_DAY; i++) {
          const pick = pool[Math.floor(r() * pool.length)];
          cum += pick ?? 0;
          for (const x of CANDIDATES) {
            if (!firstHit.has(x) && cum <= -x) firstHit.set(x, i + 1);
          }
        }
        finals += cum;
        for (const x of CANDIDATES) {
          const h = firstHit.get(x);
          if (h !== undefined) {
            halted.set(x, (halted.get(x) ?? 0) + 1);
            tradesBefore.set(x, (tradesBefore.get(x) ?? 0) + h);
          }
        }
      }
      log.info(`${name} — FRACTION OF DAYS EACH THRESHOLD WOULD HALT`, {
        days_simulated: DAYS, trades_per_day: RAILS.MAX_TRADES_PER_DAY,
        mean_day_pnl_if_never_halted: `$${(finals / DAYS).toFixed(2)}`,
        table: CANDIDATES.map((x) => ({
          max_daily_loss: `$${x}`,
          pct_of_days_halted: `${(100 * (halted.get(x) ?? 0) / DAYS).toFixed(1)}%`,
          median_trades_before_halt: (halted.get(x) ?? 0) > 0
            ? ((tradesBefore.get(x) ?? 0) / (halted.get(x) ?? 1)).toFixed(0) : '-',
        })),
      });
    }

    /*
     * THE OTHER RAIL IS PART OF THE ANSWER, AND IT BINDS FIRST.
     * `deployed = open basis + the day's realised LOSSES`, admitted while
     * `deployed + MAX_POSITION_USD <= MAX_DEPLOYED_USD`. With concurrency full that
     * leaves far less room for losses than the daily-loss rail nominally allows.
     */
    const openFull = RAILS.MAX_CONCURRENT * RAILS.MAX_POSITION_USD;
    log.info('THE CAPITAL CAP BINDS BEFORE A LARGE DAILY-LOSS RAIL, and by how much', {
      max_deployed_usd: RAILS.MAX_DEPLOYED_USD,
      open_basis_when_concurrency_is_full: openFull,
      losses_admitted_with_concurrency_FULL:
        RAILS.MAX_DEPLOYED_USD - openFull - RAILS.MAX_POSITION_USD,
      losses_admitted_with_NOTHING_open:
        RAILS.MAX_DEPLOYED_USD - RAILS.MAX_POSITION_USD,
      note: 'a daily-loss rail above the first figure is shadowed by the cap whenever '
        + 'positions are open; the cap SKIPS on open basis and HALTS on losses alone',
    });
  } catch (err) {
    log.error('daily-loss-derive failed', errorFields(err));
    process.exitCode = 1;
  } finally {
    c.release();
    await app.pool.end();
  }
}

void main();
