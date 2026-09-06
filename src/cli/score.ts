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
import { SCORES_SCHEMA } from '../scoring/schema.js';

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
    for (const w of result.wallets) {
      const res = await c.query(
        `insert into wallet_scores
           (chain, token, tag, wallet, score, weight_used, metrics, computed_at)
         values ($1,$2,$3,$4,$5,$6,$7::jsonb, now())
         on conflict (chain, token, tag, wallet) do update
           set score = excluded.score,
               weight_used = excluded.weight_used,
               metrics = excluded.metrics,
               computed_at = now()`,
        [
          chain, token, tag, w.wallet, w.score, w.weightUsed,
          JSON.stringify({ raw: w.raw, normalised: w.normalised, weights: WEIGHTS }),
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
