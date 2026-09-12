/**
 * `npm run eth-usd-series -- <config.yaml> --from N --to M [--commit] [--ceiling C]`
 *
 * Derives the chain's ETH/USD series from the WETH/USDG and ETH/USDG market and
 * fills the buckets `native_usd_prices` is MISSING. docs/ROBINHOOD.md step 10.
 *
 * DRY RUN BY DEFAULT: enumerates, sweeps, derives and reports, writing buckets
 * only with `--commit`. The sweep itself always writes -- collected logs are
 * stored progressively so a run that dies leaves a truthful partial record, and
 * re-running resumes because the row key is unique.
 *
 * The config supplies the chain, the venues, the pricing assets and their
 * decimals, and the BUCKET GRID. The grid matters more than anything else here: a
 * series written on the wrong residue matches no lookup and prices every row null
 * while appearing to have worked. Pass the config of a token that READS the series
 * -- intake/index.yaml or intake/pons.yaml, residue 3150 -- not AI's.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { bucketOf } from '../adapters/token-updates/prices.js';
import {
  ETHUSD_SCHEMA, NATIVE_ETH, deriveEthUsd, enumerateEthUsdPools, persistEthUsd,
  persistEthUsdPools, sweepEthUsdSwaps,
} from '../intake/ethusd.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: eth-usd-series <config.yaml> --from N --to M');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const ceiling = num('--ceiling', 200000);
  const commit = args.includes('--commit');
  if (!from || !to || to <= from) throw new Error('--from and --to are required');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  const weth = cfg.nativeAssets.map((a) => a.toLowerCase()).find((a) => a !== NATIVE_ETH);
  if (!weth) throw new Error('no non-native native_asset configured');
  const usdg = cfg.usdAsset.toLowerCase();

  const c = await app.pool.connect();
  try {
    await c.query(ETHUSD_SCHEMA);

    /*
     * THE WORK SET IS THE BUCKETS THAT ARE MISSING, stated before the first
     * request. Sizing this from a token's life instead was a 9.6x overshoot on
     * PONS (step 9), and sizing a sweep from the wrong population has been wrong
     * by 16x and 27% here (step 5).
     */
    const missing = await c.query<{ n: string; lo: string | null; hi: string | null }>(
      `select count(*)::text n, min(b)::text lo, max(b)::text hi from (
         select distinct ${bucketExpr(cfg.bucketOrigin, cfg.bucketBlocks)} as b
           from wallet_transactions w
          where w.chain = $1 and w.side in ('buy','sell') and w.usd_amount is null
            and w.block_number between $2 and $3
       ) x where not exists (
         select 1 from native_usd_prices n where n.chain = $1 and n.block_number = x.b)`,
      [cfg.chain, from, to],
    );
    log.info('BEFORE THE FIRST REQUEST', {
      range: `${from}..${to}`, blocks: to - from + 1,
      grid: { bucket_blocks: cfg.bucketBlocks, bucket_origin: cfg.bucketOrigin,
        residue: cfg.bucketOrigin % cfg.bucketBlocks },
      buckets_missing_in_range: Number(missing.rows[0]!.n),
      missing_from: missing.rows[0]!.lo, missing_to: missing.rows[0]!.hi,
      estimated_cu: 480 + Math.ceil((to - from + 1) / 3_700_000 * 10_080),
      ceiling, commit,
      writes: commit ? 'market swaps AND native_usd_prices buckets'
        : 'market swaps only -- buckets are a dry run',
    });

    const head = await c.query<{ hi: string }>(
      `select max(block_number)::text hi from block_times where chain = $1`, [cfg.chain]);
    const pools = await enumerateEthUsdPools(rpc, cfg, weth, usdg,
      Math.max(to, Number(head.rows[0]?.hi ?? to)));
    const newPools = await persistEthUsdPools(c, cfg.chain, pools);
    log.info('market enumerated', {
      pools: pools.length, newly_stored: newPools,
      v4: pools.filter((p) => p.venue === 'v4').length,
      v3: pools.filter((p) => p.venue === 'v3').length,
      earliest_creation: pools[0]?.createdBlock ?? null,
      created_at_or_before_range_start: pools.filter((p) => p.createdBlock <= from).length,
      cu_so_far: rpc.cuSpent,
    });
    /*
     * NO POOL IS AN ANSWER AND IT IS REPORTED AS ONE, not as an empty series.
     */
    if (pools.length === 0) {
      throw new Error(
        'no WETH/USDG or ETH/USDG pool exists on this chain. That is not an empty '
        + 'result to carry forward -- it contradicts the probe that found 48.',
      );
    }

    const swept = await sweepEthUsdSwaps(c, rpc, cfg.chain, cfg, pools, from, to);
    log.info('market swept', {
      ...swept, range: `${from}..${to}`, cu_so_far: rpc.cuSpent,
      dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
    });
    if (swept.v3 + swept.v4 === 0) {
      throw new Error(
        `the market has ${pools.length} pools but returned NO swaps over ${from}..${to}. `
        + 'A zero here is a suspected defect, not a clean pass.',
      );
    }

    const derived = await deriveEthUsd(
      c, cfg.chain,
      { bucketBlocks: cfg.bucketBlocks, bucketOrigin: cfg.bucketOrigin },
      cfg.nativeFenceMultiple, 18, 6, from, to,
    );
    const values = derived.buckets.map((b) => b.ethUsd);
    log.info(commit ? 'DERIVED, WRITING' : 'DERIVED, DRY RUN', {
      buckets: derived.buckets.length,
      ticks_kept: derived.ticks,
      ticks_discarded_by_fence: derived.discarded,
      fence: cfg.nativeFenceMultiple,
      eth_usd_min: values.length ? Math.min(...values).toFixed(2) : null,
      eth_usd_max: values.length ? Math.max(...values).toFixed(2) : null,
      eth_usd_median: values.length ? median(values).toFixed(2) : null,
      median_ticks_per_bucket: derived.buckets.length
        ? median(derived.buckets.map((b) => b.ticks)) : null,
    });

    if (!commit) {
      log.info('nothing written to native_usd_prices; pass --commit', {});
    } else {
      const w = await persistEthUsd(c, cfg.chain, derived.buckets);
      log.info('buckets written', {
        ...w,
        note: 'already-present buckets are NEVER rewritten; the skipped count is '
          + 'reported so added coverage is distinguishable from silent agreement',
      });
    }

    log.info('cost', {
      cu_spent: rpc.cuSpent, dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
      ceiling, calls: rpc.callCounts(),
    });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

const bucketExpr = (origin: number, size: number): string =>
  `(${origin} + floor((w.block_number - ${origin})/${size}.0)*${size})::bigint`;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

void bucketOf;

main().catch((err) => { log.error('eth-usd-series failed', errorFields(err)); process.exit(1); });
