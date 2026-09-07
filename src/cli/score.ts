/**
 * Wallet scoring: `npm run score -- <chain> <token> [--tag PONS-P1] [--write]`
 *
 * READS THE DATABASE ONLY. No RPC, no external API, no network. Every input --
 * trades, cohort, pump points, current price -- is already stored.
 *
 * REPORT-ONLY BY DEFAULT. `--write` is required to persist anything, so running
 * it to look at the numbers cannot change them.
 */

import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { withTransaction } from '../store/db.js';
import {
  METRIC_ORDER,
  WEIGHTS,
  computeFacts,
  distribution,
  score,
  type Trade,
} from '../scoring/metrics.js';
import { FLAG_INFLATED_PNL, FLAG_LOW_WEIGHT, SCORES_SCHEMA } from '../scoring/schema.js';

/**
 * A wallet scored on less than this fraction of the total weight is not
 * comparable to one scored on all of it. 0.8 chosen against the PONS
 * distribution, which is bimodal: 12,296 wallets at 1.000, then 67 at 0.875,
 * 18 at 0.825 and 1 at 0.175. Thresholds of 0.5 and 0.8 make the same cut
 * there; 0.9 would additionally flag 85 wallets missing only earliness, which
 * is a question about cohort construction rather than data quality.
 */
const LOW_WEIGHT_DEFAULT = 0.8;

/**
 * Derive the low-weight cut from THIS token's weight distribution rather than
 * inheriting another token's number.
 *
 * The PONS distribution is bimodal -- 12,296 wallets at 1.000, then 67 at
 * 0.875, 18 at 0.825, 1 at 0.175 -- so 0.5 and 0.8 make the same cut there and
 * 0.9 catches 86. A token with a smoother distribution needs a different
 * number, and the point of the flag is comparability, not the constant.
 *
 * The rule: take the largest gap in the sorted distinct weights below 1.0 and
 * cut there. Fall back to the default when there is no gap to find, and say so.
 */
export function deriveLowWeightThreshold(
  weights: number[],
): { threshold: number; derived: boolean; reason: string } {
  const distinct = [...new Set(weights.filter((w) => w > 0 && w < 0.999))].sort((a, b) => a - b);
  if (distinct.length < 2) {
    return {
      threshold: LOW_WEIGHT_DEFAULT,
      derived: false,
      reason: `only ${distinct.length} distinct partial weight(s); no gap to cut at, ` +
        `so the ${LOW_WEIGHT_DEFAULT} default stands`,
    };
  }
  let bestGap = -1;
  let cut = LOW_WEIGHT_DEFAULT;
  for (let i = 1; i < distinct.length; i++) {
    const gap = distinct[i]! - distinct[i - 1]!;
    if (gap > bestGap) { bestGap = gap; cut = (distinct[i]! + distinct[i - 1]!) / 2; }
  }
  return {
    threshold: cut,
    derived: true,
    reason: `largest gap in the partial-weight distribution is ${bestGap.toFixed(3)}, ` +
      `cutting at ${cut.toFixed(3)} across ${distinct.length} distinct values`,
  };
}

/**
 * How negative a position has to be to count as acquisition we cannot see.
 *
 * NOT simply `< 0`. 589 PONS wallets are negative by less than a millionth of
 * a token -- the smallest by 3e-18, one wei -- which is rounding residue from
 * proportional allocation, not an off-market purchase. This is the same
 * materiality floor the row writer already applies to a token amount.
 */
const INFLATED_POSITION_FLOOR = -0.001;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const chain = positional[0];
  const token = positional[1];
  const tagIndex = args.indexOf('--tag');
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  const write = args.includes('--write');
  const topIndex = args.indexOf('--top');
  const top = topIndex >= 0 ? Number.parseInt(args[topIndex + 1] ?? '20', 10) : 20;

  if (!chain || !token || !tag) {
    throw new Error('usage: score <chain> <token> --tag <TAG> [--write] [--top N]');
  }

  const app = await bootstrap();
  await withTransaction(app.pool, (c) => c.query(SCORES_SCHEMA).then(() => undefined));

  /* ---- cohort ---------------------------------------------------------- */
  const cohortRows = await app.pool.query<{ wallet: string }>(
    `select distinct wallet from wallet_tags where mint = $1 and tag = $2 order by wallet`,
    [token, tag],
  );
  const cohort = cohortRows.rows.map((r) => r.wallet.toLowerCase());
  if (cohort.length === 0) {
    // A cohort that matched nothing would make every downstream count zero and
    // look like a clean run.
    throw new Error(
      `no wallets carry tag "${tag}" for ${token}. A cohort matching nothing is a ` +
        'suspected defect, not an empty result.',
    );
  }

  /* ---- window the cohort was selected by ------------------------------- */
  const windowRow = await app.pool.query<{ s: string; e: string }>(
    `select extract(epoch from window_start)::text s, extract(epoch from window_end)::text e
       from token_windows where mint = $1 and tag = $2`,
    [token, tag],
  );
  if (windowRow.rowCount === 0) {
    throw new Error(`no row in token_windows for ${token} / ${tag}; metric 3 needs its bounds`);
  }
  const windowStart = Number(windowRow.rows[0]!.s);
  const windowEnd = Number(windowRow.rows[0]!.e);

  /* ---- pump points ----------------------------------------------------- */
  const pumpRows = await app.pool.query<{ ts: string; label: string | null }>(
    `select extract(epoch from event_at)::text ts, label
       from token_events
      where chain = $1 and token = $2 and kind = 'pump'
      order by event_at`,
    [chain, token],
  );
  const pumps = pumpRows.rows.map((r) => Number(r.ts));
  if (pumps.length === 0) {
    throw new Error(
      `no pump events stored for ${token}. Metrics 5 and 6 are defined against ` +
        'pump points; running without them would silently score two metrics null.',
    );
  }

  /* ---- trades ---------------------------------------------------------- */
  const tradeRows = await app.pool.query<{
    wallet: string; side: string; ts: string; token_amount: string; usd_amount: string | null;
  }>(
    `select wallet, side, extract(epoch from block_time)::text ts,
            token_amount::text, usd_amount::text
       from wallet_transactions
      where chain = $1 and token = $2
      order by block_time`,
    [chain, token],
  );
  const trades: Trade[] = tradeRows.rows.map((r) => ({
    wallet: r.wallet.toLowerCase(),
    side: r.side as Trade['side'],
    ts: Number(r.ts),
    tokenAmount: Number(r.token_amount),
    usd: r.usd_amount === null ? null : Number(r.usd_amount),
  }));

  /* ---- current price, for valuing what is still held ------------------- */
  const priceRow = await app.pool.query<{ price_usd: string; observed: string }>(
    `select price_usd::text, observed_at::text as observed
       from token_prices where mint = $1 order by observed_at desc limit 1`,
    [token],
  );
  const currentPrice = priceRow.rowCount ? Number(priceRow.rows[0]!.price_usd) : null;

  /* ---- inception: the token's first observed trade --------------------- */
  const inceptionRow = await app.pool.query<{ ts: string }>(
    `select extract(epoch from min(block_time))::text ts
       from wallet_transactions where chain = $1 and token = $2`,
    [chain, token],
  );
  const inception = Number(inceptionRow.rows[0]?.ts ?? windowStart);

  const now = Math.floor(Date.now() / 1000);

  log.info('scoring inputs', {
    chain,
    token,
    tag,
    cohort: cohort.length,
    trades: trades.length,
    trades_unpriced: trades.filter((t) => t.usd === null).length,
    trades_by_side: countBy(trades.map((t) => t.side)),
    pumps: pumpRows.rows.map((r, i) => ({
      n: i + 1,
      at: new Date(Number(r.ts) * 1000).toISOString(),
      label: r.label,
    })),
    window: {
      start: new Date(windowStart * 1000).toISOString(),
      end: new Date(windowEnd * 1000).toISOString(),
    },
    inception: new Date(inception * 1000).toISOString(),
    current_price_usd: currentPrice,
    price_observed_at: priceRow.rows[0]?.observed ?? null,
  });

  /*
   * ---- score-quality flags ---------------------------------------------
   *
   * THE POSITION IS COMPUTED IN SQL, IN NUMERIC. Summing it as JavaScript
   * doubles gave 2,098 negative wallets where numeric gives 2,682 -- a
   * 584-wallet difference produced entirely by float error on quantities with
   * 18 decimals. A materiality floor evaluated in double precision is not a
   * materiality floor.
   *
   * The sides include transfers, so once transfer rows are collected the
   * position stops being negative for wallets that acquired off-market and the
   * flag simply is not re-applied on the next run.
   */
  const negativeRows = await app.pool.query<{ wallet: string; position: string }>(
    `select wallet,
            (coalesce(sum(token_amount) filter (where side in ('buy','transfer_in')), 0)
           - coalesce(sum(token_amount) filter (where side in ('sell','transfer_out')), 0))::text
              as position
       from wallet_transactions
      where chain = $1 and token = $2
      group by wallet
     having coalesce(sum(token_amount) filter (where side in ('buy','transfer_in')), 0)
          - coalesce(sum(token_amount) filter (where side in ('sell','transfer_out')), 0)
            < $3::numeric`,
    [chain, token, String(INFLATED_POSITION_FLOOR)],
  );
  const inflated = new Set(negativeRows.rows.map((r) => r.wallet.toLowerCase()));

  /* ---- compute --------------------------------------------------------- */
  const facts = computeFacts({
    trades,
    cohort,
    windowStart,
    windowEnd,
    pumps,
    inception,
    currentPrice,
    now,
  });
  const result = score(facts, cohort);

  /* ---- report ---------------------------------------------------------- */
  const scored = result.wallets.filter((w) => w.score !== null);
  log.info('score distribution', {
    cohort: cohort.length,
    scored: scored.length,
    unscored_every_metric_null: cohort.length - scored.length,
    wallets_with_no_rows: result.walletsWithNoRows,
    ...distribution(scored.map((w) => w.score!)),
  });

  /*
   * 3.4: how many wallets are null on ANY metric, and on which. The per-metric
   * counts below say how often each metric was uncomputable; this says how much
   * of the cohort is scored on less than the full weight.
   */
  const anyNull = result.wallets.filter((w) =>
    METRIC_ORDER.some((m) => w.normalised[m] === null),
  );
  const weightBuckets: Record<string, number> = {};
  for (const w of result.wallets) {
    const k = w.weightUsed.toFixed(3);
    weightBuckets[k] = (weightBuckets[k] ?? 0) + 1;
  }
  log.info('wallets scored on less than the full weight', {
    cohort: cohort.length,
    wallets_with_at_least_one_null_metric: anyNull.length,
    wallets_on_full_weight: cohort.length - anyNull.length,
    weight_used_distribution: weightBuckets,
  });

  for (const s of result.summaries) {
    log.info('metric', {
      metric: s.metric,
      weight: s.weight,
      normalisation: s.normalised,
      present: s.present,
      null: s.nullCount,
      min: s.min,
      max: s.max,
      degenerate_dropped_for_everyone: s.degenerate,
      ...distribution(
        cohort
          .map((w) => facts.get(w)?.raw[s.metric])
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)),
      ),
    });
  }

  /*
   * Transfer exposure, reported beside every PnL figure.
   *
   * A count of zero here means no transfer rows were COLLECTED, not that no
   * transfers happened. NEGATIVE POSITIONS ARE THE EVIDENCE: a wallet that sold
   * more than it bought must have acquired the difference some other way, and
   * with transfers uncollected that acquisition is invisible while its proceeds
   * are not. Those wallets' PnL is overstated by the value of tokens they never
   * paid for, and the count below is the honest measure of how much of the
   * cohort that touches.
   */
  const withTransfers = [...facts.values()].filter((f) => f.transferInShare > 0);
  const negative = [...facts.values()].filter((f) => f.position < -1e-9);
  log.info('transfer exposure of the PnL figures', {
    transfer_rows_collected: trades.filter(
      (t) => t.side === 'transfer_in' || t.side === 'transfer_out',
    ).length,
    wallets_with_any_transfer_in: withTransfers.length,
    max_transfer_in_share: withTransfers.length
      ? Math.max(...withTransfers.map((f) => f.transferInShare))
      : 0,
    wallets_with_a_negative_position: negative.length,
    share_of_cohort_with_negative_position: (negative.length / cohort.length).toFixed(4),
    most_negative_position: negative.length
      ? Math.min(...negative.map((f) => f.position))
      : 0,
    note:
      'A negative position means the wallet sold more than it bought, so it ' +
      'acquired the difference off-market. With no transfer rows collected that ' +
      'acquisition is invisible while its proceeds are counted, which overstates ' +
      "those wallets' PnL.",
  });

  const lowWeight = deriveLowWeightThreshold(result.wallets.map((w) => w.weightUsed));
  log.info('low-weight threshold', { ...lowWeight });

  /* Flags are rebuilt from scratch every run; nothing is accumulated. */
  const flagsFor = (w: { wallet: string; score: number | null; weightUsed: number }): string[] => {
    const f: string[] = [];
    // Only a SCORED wallet can be low-weight: an unscored one already reads as
    // unscored, and flagging it adds nothing.
    if (w.score !== null && w.weightUsed < lowWeight.threshold) f.push(FLAG_LOW_WEIGHT);
    // Applied regardless of scored status: it is a fact about the wallet.
    if (inflated.has(w.wallet)) f.push(FLAG_INFLATED_PNL);
    return f;
  };
  const flagged = result.wallets.map((w) => ({ w, f: flagsFor(w) }));
  const withLow = flagged.filter((x) => x.f.includes(FLAG_LOW_WEIGHT));
  const withInf = flagged.filter((x) => x.f.includes(FLAG_INFLATED_PNL));
  log.info('score-quality flags', {
    low_weight_threshold: lowWeight.threshold,
    low_weight_threshold_derived: lowWeight.derived,
    inflated_position_floor: INFLATED_POSITION_FLOOR,
    wallets_negative_in_sql_numeric: inflated.size,
    'low-weight': withLow.length,
    'inflated-pnl': withInf.length,
    both: flagged.filter((x) => x.f.length === 2).length,
    neither: flagged.filter((x) => x.f.length === 0).length,
    'inflated-pnl_scored': withInf.filter((x) => x.w.score !== null).length,
    'inflated-pnl_unscored': withInf.filter((x) => x.w.score === null).length,
    total: flagged.length,
  });

  const ranked = scored.sort((a, b) => b.score! - a.score!).slice(0, top);
  for (const [i, w] of ranked.entries()) {
    const f = facts.get(w.wallet)!;
    log.info('top wallet', {
      rank: i + 1,
      wallet: w.wallet,
      score: Number(w.score!.toFixed(6)),
      weight_used: w.weightUsed,
      buys: f.buys,
      sells: f.sells,
      usd_in: f.usdIn,
      usd_out: f.usdOut,
      position: f.position,
      transfer_in_share: f.transferInShare,
      raw: w.raw,
      normalised: w.normalised,
    });
  }

  if (!write) {
    log.warn('REPORT ONLY. Nothing was written. Pass --write to persist these scores.');
    await app.pool.end();
    process.exit(0);
  }

  const stored = await withTransaction(app.pool, async (c) => {
    let n = 0;
    for (const { w, f } of flagged) {
      const res = await c.query(
        `insert into wallet_scores
           (chain, token, tag, wallet, score, weight_used, metrics, flags, computed_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[], now())
         on conflict (chain, token, tag, wallet) do update
           set score = excluded.score,
               weight_used = excluded.weight_used,
               metrics = excluded.metrics,
               -- REPLACED, never appended. A flag whose condition no longer
               -- holds has to disappear, or inflated-pnl would outlive the
               -- transfer collection that resolves it.
               flags = excluded.flags,
               computed_at = now()`,
        [
          chain, token, tag, w.wallet, w.score, w.weightUsed,
          JSON.stringify({ raw: w.raw, normalised: w.normalised, weights: WEIGHTS }),
          f,
        ],
      );
      n += res.rowCount ?? 0;
    }
    return n;
  });
  log.info('scores written', { rows: stored, metrics: METRIC_ORDER });

  await app.pool.end();
  process.exit(0);
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

main().catch((err) => {
  log.error('score failed', errorFields(err));
  process.exit(1);
});
