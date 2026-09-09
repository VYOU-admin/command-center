/**
 * `npm run derive-prices -- <config.yaml> --from N --to M [--commit]`
 *
 * The prices step, on its own. Derives each bridge asset's USD series first,
 * then the token's own, from swaps already in the database. NO NETWORK.
 *
 * WHY SEPARATELY FROM THE INTAKE. The runner reaches its prices phase only past
 * the cohort STOP, and prices are wanted for review BEFORE a cohort is built --
 * step 10 stops there for exactly that reason. Every derivation, fence and
 * persist below is the same function the intake phase calls; only the phase
 * wiring differs.
 *
 * DRY RUN BY DEFAULT. `--commit` writes.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { loadPools } from '../adapters/token-updates/pools.js';
import {
  derivePricesForLife, loadLegsInput, persistAllPrices, persistBridgeUsd,
} from '../intake/write.js';
import { deriveBridgeUsd } from '../adapters/token-updates/prices.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: derive-prices <config.yaml> --from N --to M');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const commit = args.includes('--commit');
  if (!from || !to || to <= from) throw new Error('--from and --to are required');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const pools = await loadPools(c, cfg.chain, cfg.token);
    if (pools.size === 0) throw new Error('no in-scope pools stored; run the scope phase');
    const decimals = (await c.query<{ decimals: number }>(
      `select decimals from tokens where mint=$1`, [cfg.token])).rows[0]?.decimals;
    if (typeof decimals !== 'number') throw new Error('token decimals unknown');

    /*
     * THE TOKEN'S USD TABLE IS PER TOKEN AND IS CREATED BY NOTHING. The schema
     * hardcodes `pons_usd_prices`, named for the first token loaded, and the
     * insert templates the configured name -- so a second token writes into a
     * table that does not exist. The column is still `pons_usd` because
     * renaming it is a migration, not a config change; step 12 records that.
     */
    if (!/^[a-z][a-z0-9_]*$/.test(cfg.tokenUsdTable)) {
      throw new Error(`refusing to create a table named ${cfg.tokenUsdTable}`);
    }
    await c.query(
      `create table if not exists ${cfg.tokenUsdTable} (
         chain        text    not null,
         bucket_block bigint  not null,
         pons_usd     numeric not null,
         ticks        integer not null,
         primary key (chain, bucket_block)
       )`,
    );

    log.info('deriving', {
      token: cfg.token, ticker: cfg.ticker, blocks: `${from}..${to}`,
      bucket_blocks: cfg.bucketBlocks, bucket_origin: cfg.bucketOrigin,
      bucket_residue: cfg.bucketOrigin % cfg.bucketBlocks,
      bridges: cfg.bridgeAssets, in_scope_pools: pools.size, commit,
    });

    /* ---- the second hop, one level deeper --------------------------------- */
    const bridgeReport: Record<string, unknown> = {};
    for (const bridge of cfg.bridgeAssets) {
      const bridgePools = await loadPools(c, cfg.chain, bridge);
      if (bridgePools.size === 0) {
        bridgeReport[bridge] = 'NO IN-SCOPE POOLS STORED -- nothing derivable';
        continue;
      }
      const slice = await loadLegsInput(c, { ...cfg, token: bridge }, bridgePools, from, to);
      const bdec = (await c.query<{ decimals: number }>(
        `select decimals from tokens where mint=$1`, [bridge])).rows[0]?.decimals;
      if (typeof bdec !== 'number') {
        throw new Error(`bridge ${bridge} has no decimals recorded; it cannot be valued`);
      }
      const firstComplete = cfg.bucketOrigin
        + Math.ceil((from - cfg.bucketOrigin) / cfg.bucketBlocks) * cfg.bucketBlocks;
      const d = deriveBridgeUsd(slice.swaps, cfg, bdec, firstComplete);
      const written = commit ? await persistBridgeUsd(c, cfg, bridge, d.series) : null;
      bridgeReport[bridge] = {
        decimals: bdec, in_scope_pools: bridgePools.size, swaps_read: slice.swaps.length,
        buckets_with_ticks: d.buckets, buckets_priced: d.series.size,
        ticks_discarded_by_fence: d.discarded,
        first_complete_bucket: firstComplete, written,
      };
    }
    log.info('bridge series', bridgeReport);

    /* ---- the token's own series ------------------------------------------ */
    const { series } = await derivePricesForLife(c, cfg, pools, decimals, from, to);
    const totals = series.reduce((a, s) => ({
      usdTicks: a.usdTicks + s.stats.tokenUsdTicks,
      usdDiscarded: a.usdDiscarded + s.stats.tokenUsdDiscarded,
      natTicks: a.natTicks + s.stats.tokenNativeTicks,
      natDiscarded: a.natDiscarded + s.stats.tokenNativeDiscarded,
      derived: a.derived + s.stats.nativeDerived,
      nativeDiscarded: a.nativeDiscarded + s.stats.nativeDiscarded,
      noUsdSide: a.noUsdSide + s.stats.bucketsWithoutUsdSide,
      noNativeSide: a.noNativeSide + s.stats.bucketsWithoutNativeSide,
    }), { usdTicks: 0, usdDiscarded: 0, natTicks: 0, natDiscarded: 0, derived: 0,
      nativeDiscarded: 0, noUsdSide: 0, noNativeSide: 0 });
    const written = commit ? await persistAllPrices(c, cfg, series) : null;

    log.info('token series', { ...totals, slices: series.length, written });
    if (!commit) log.info('dry run only; pass --commit to write', {});
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('derive-prices failed', errorFields(err)); process.exit(1); });
