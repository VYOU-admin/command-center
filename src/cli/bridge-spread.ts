/**
 * `npm run bridge-spread -- <config.yaml>`
 *
 * Step 4's required measurement for any token priced through a bridge:
 *
 *   "Two bucketed medians multiplied compound their error. Report the spread
 *    against direct token/USD trades in the same buckets rather than assuming it
 *    small."
 *
 * TWO INDEPENDENT ROUTES TO ONE NUMBER, COMPARED ONLY WHERE BOTH EXIST:
 *
 *   bridge route   median(|bridge side| / |token side|) over the token's pools
 *                  against the bridge, x the bridge's own USD price for that
 *                  bucket                                  -- TWO medians
 *   direct route   the token's own USD series, derived from its token/USDG
 *                  ticks                                   -- ONE median
 *
 * The direct route is what `<token>_usd_prices` already holds, so this reads it
 * rather than re-deriving it: a second derivation of a stored number is the
 * two-implementations trap, and it would be comparing this file's arithmetic
 * against itself rather than the pipeline's.
 *
 * IT WRITES NOTHING and spends no compute units. Read-only, on stored logs.
 *
 * WHY IT IS A COMMITTED TOOL AND NOT A QUERY. Step 4 requires this of EVERY
 * bridge, and there will be a third. It is also the measurement that could not
 * be taken at BONER's step 7 stop, which is the whole reason the bridge path has
 * a STOP in it at all.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

async function main(): Promise<void> {
  const configPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: bridge-spread <config.yaml>');
  const cfg = await loadIntakeConfig(configPath);

  if (cfg.bridgeAssets.length === 0) {
    throw new Error(
      `${cfg.ticker} declares no bridge_assets, so there is no second hop to measure. `
      + 'This tool exists for step 4\'s compounded-error check and has nothing to do here.',
    );
  }

  const app = await bootstrap();
  const client = await app.pool.connect();
  try {
    /*
     * THE TOKEN'S DECIMALS ARE READ, NEVER ASSUMED (step 1). They scale the
     * raw-amount ratio into whole units, so a wrong value here is the factor-of-
     * 10^12 error this document names twice. `tokens.decimals` is written by the
     * identity phase from the contract itself.
     */
    const dec = await client.query<{ decimals: number | null }>(
      'select decimals from tokens where lower(mint) = lower($1)', [cfg.token],
    );
    const tokenDecimals = dec.rows[0]?.decimals;
    if (typeof tokenDecimals !== 'number') {
      throw new Error(
        `no decimals stored for ${cfg.token}. Run the identity phase first; an `
        + 'unreadable decimals is unknown, never 18.',
      );
    }
    for (const bridge of cfg.bridgeAssets) {
      /*
       * THE BRIDGE ROUTE, PER BUCKET. The token's swaps on pools whose counter IS
       * the bridge, bucketed on the token's grid -- the same grid deriveBridgeUsd
       * ran on, because it is called with this token's config.
       *
       * Decimals come from `pool_meta.counter_dec`, read from the bridge's own
       * contract at scope time. Never defaulted: step 1's rule, and the reason a
       * bridge's `?? 18` was a 10^12 error waiting to happen.
       */
      const bucketExpr = `(${cfg.bucketOrigin} + floor((s.block_number - ${cfg.bucketOrigin})`
        + `/${cfg.bucketBlocks}.0)*${cfg.bucketBlocks})::bigint`;
      const rows = await client.query<{
        bucket: string; bridge_route: string; direct: string; ticks: string;
        bridge_ticks: string;
      }>(
        `with t as (
           select ${bucketExpr} as bucket,
                  abs(case when m.pons_side = 0 then s.amount1 else s.amount0 end)
                    / nullif(abs(case when m.pons_side = 0 then s.amount0 else s.amount1 end), 0)
                    * power(10::numeric, $4 - m.counter_dec) as tick
             from token_swap_logs s
             join pool_meta m
               on m.chain = s.chain and m.token = s.token and m.pool = s.pool
            where s.chain = $1 and s.token = $2 and lower(m.counter) = lower($3)
         ), med as (
           select bucket,
                  percentile_cont(0.5) within group (order by tick) as tick_med,
                  count(*)::text as ticks
             from t where tick is not null and tick > 0 group by bucket
         )
         select med.bucket::text,
                (med.tick_med * b.usd)::text as bridge_route,
                d.pons_usd::text            as direct,
                med.ticks,
                b.ticks::text               as bridge_ticks
           from med
           join bridge_usd_prices b
             on b.chain = $1 and lower(b.bridge) = lower($3) and b.bucket_block = med.bucket
           join ${cfg.tokenUsdTable} d
             on d.chain = $1 and d.bucket_block = med.bucket
          order by med.bucket`,
        [cfg.chain, cfg.token, bridge, tokenDecimals],
      );

      /*
       * A COMPARISON THAT MATCHES NOTHING IS A SUSPECTED DEFECT, NOT A CLEAN
       * PASS. It would mean the two series share no bucket -- a grid mismatch,
       * which is the failure the anchor rule exists to prevent -- and reporting
       * "no disagreement" would be the worst possible way to say it.
       */
      if (rows.rowCount === 0) {
        const counts = await client.query<{ a: string; b: string }>(
          `select (select count(*)::text from bridge_usd_prices
                    where chain = $1 and lower(bridge) = lower($2)) as a,
                  (select count(*)::text from ${cfg.tokenUsdTable} where chain = $1) as b`,
          [cfg.chain, bridge],
        );
        throw new Error(
          `${cfg.ticker}/${bridge}: NO BUCKET carries both a bridge-route price and a `
          + `direct one. bridge_usd_prices holds ${counts.rows[0]!.a} buckets and `
          + `${cfg.tokenUsdTable} holds ${counts.rows[0]!.b}. A comparison matching `
          + 'nothing is a suspected grid mismatch, not agreement.',
        );
      }

      const diffs = rows.rows.map((r) => {
        const br = Number(r.bridge_route);
        const di = Number(r.direct);
        return { bucket: r.bucket, br, di, pct: Math.abs(br - di) / di * 100 };
      }).filter((d) => Number.isFinite(d.pct) && d.di > 0);
      const sorted = [...diffs.map((d) => d.pct)].sort((a, b) => a - b);
      const worst = [...diffs].sort((a, b) => b.pct - a.pct).slice(0, 5);

      log.info('BRIDGE SPREAD, two routes compared per bucket', {
        token: cfg.ticker,
        bridge,
        grid: { bucket_origin: cfg.bucketOrigin, bucket_blocks: cfg.bucketBlocks,
          residue: cfg.bucketOrigin % cfg.bucketBlocks },
        buckets_compared: diffs.length,
        mean_pct: diffs.length
          ? (diffs.reduce((s, d) => s + d.pct, 0) / diffs.length).toFixed(2) : null,
        median_pct: quantile(sorted, 0.5)?.toFixed(2) ?? null,
        p90_pct: quantile(sorted, 0.9)?.toFixed(2) ?? null,
        max_pct: sorted.length ? sorted[sorted.length - 1]!.toFixed(2) : null,
        within_5pct: diffs.filter((d) => d.pct <= 5).length,
        within_10pct: diffs.filter((d) => d.pct <= 10).length,
        over_10pct: diffs.filter((d) => d.pct > 10).length,
        worst_buckets: worst.map((d) => ({
          bucket: d.bucket,
          bridge_route: d.br.toPrecision(6),
          direct: d.di.toPrecision(6),
          apart_pct: d.pct.toFixed(1),
        })),
        note: 'bridge route = median(bridge per token) x the bridge USD bucket -- TWO '
          + 'medians multiplied. direct = the token\'s own USD series from its USDG '
          + 'ticks -- ONE median. Step 4 requires this spread reported rather than '
          + 'assumed small.',
      });
    }
  } finally {
    client.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('bridge-spread failed', errorFields(err));
  process.exit(1);
});
