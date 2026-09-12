/**
 * `npm run eth-usd-probe -- <config.yaml> --from N --to M [--ceiling C]`
 *
 * READS ONLY. Writes nothing, to any table. It answers one question:
 *
 *   does a WETH/USDG or ETH/USDG market exist on this chain in a block range,
 *   so that ETH/USD can be dated there at all?
 *
 * WHY IT EXISTS. `native_usd_prices` is a chain-level quantity but is derived
 * PER TOKEN -- it exists only where some tracked token traded against both a
 * native asset and USDG inside one bucket. So it begins at block 5,363,150, the
 * bucket holding INDEX's first USDG swap, and INDEX's 6,052 null-USD trade rows
 * all sit below that. See the INDEX findings in docs/ROBINHOOD.md.
 *
 * THE DATABASE CANNOT ANSWER THIS, AND THAT IS THE POINT. `v4_swaps_all` returns
 * zero swaps before 5,371,436, but it spans only 15,115,267..42,695,454 -- it was
 * built for PONS's window. That zero is a COVERAGE ARTEFACT, not evidence the era
 * had no market, and reading it as evidence is the standing
 * filter-matched-nothing trap. Only the chain settles it.
 *
 * Cost, estimated before it runs and reported against the estimate: one sparse
 * enumeration per pair per venue (~60 CU each; a single call has returned 4,615
 * Initialize logs across 40,000,000 blocks) plus a dense Swap sweep over the
 * range for whatever pools it finds.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import {
  TOPICS, addressTopic, decodeInitializeV4, decodePoolCreatedV3,
} from '../adapters/token-updates/decode.js';

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

interface Found {
  venue: 'v3' | 'v4';
  pool: string;
  currency0: string;
  currency1: string;
  createdBlock: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: eth-usd-probe <config.yaml> --from N --to M');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const ceiling = num('--ceiling', 200000);
  if (!from || !to || to <= from) throw new Error('--from and --to are required');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  const weth = cfg.nativeAssets.map((a) => a.toLowerCase())
    .find((a) => a !== NATIVE_ETH);
  const usdg = cfg.usdAsset.toLowerCase();
  if (!weth) throw new Error('no non-native native_asset configured; nothing to pair');

  /*
   * BOTH ORDERINGS OF EVERY PAIR. Uniswap sorts a pool's currencies by address,
   * and assuming the order is how a filter comes back empty while the pool
   * exists. Querying both costs one extra sparse call and removes the
   * assumption.
   */
  const pairs: [string, string][] = [
    [weth, usdg], [usdg, weth],
    [NATIVE_ETH, usdg], [usdg, NATIVE_ETH],
  ];

  log.info('BEFORE THE FIRST REQUEST', {
    question: 'does a WETH/USDG or ETH/USDG market exist in this range',
    blocks: `${from}..${to}`,
    weth, usdg, native: NATIVE_ETH,
    enumeration_calls: pairs.length * 2,
    estimated_enumeration_cu: pairs.length * 2 * 60,
    note: 'the Swap sweep is sized only after the pools are known',
    ceiling,
    writes: 'NONE -- this probe writes to no table',
  });

  const found: Found[] = [];

  /*
   * Enumerate across the WHOLE CHAIN, not just the range asked about. A pool
   * created before `from` and still trading inside it would be missed by a
   * range-limited enumeration, and that is the likeliest shape for an early
   * market.
   */
  for (const [c0, c1] of pairs) {
    const v4 = await rpc.getLogs(
      {
        address: cfg.v4PoolManager,
        topics: [TOPICS.initializeV4, null, addressTopic(c0), addressTopic(c1)],
      },
      0, to, cfg.sparseLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    for (const l of v4) {
      const p = decodeInitializeV4(l);
      found.push({ venue: 'v4', pool: p.pool, currency0: p.currency0,
        currency1: p.currency1, createdBlock: p.block });
    }
    // v3 has no native ETH; skip the pairs that name it rather than pretend.
    if (c0 === NATIVE_ETH || c1 === NATIVE_ETH) continue;
    const v3 = await rpc.getLogs(
      {
        address: cfg.v3Factory,
        topics: [TOPICS.poolCreatedV3, addressTopic(c0), addressTopic(c1)],
      },
      0, to, cfg.sparseLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    for (const l of v3) {
      const p = decodePoolCreatedV3(l);
      found.push({ venue: 'v3', pool: p.pool, currency0: p.currency0,
        currency1: p.currency1, createdBlock: p.block });
    }
  }

  const unique = [...new Map(found.map((f) => [`${f.venue}:${f.pool}`, f])).values()]
    .sort((a, b) => a.createdBlock - b.createdBlock);

  log.info('pools enumerated', {
    pairs_queried: pairs.length,
    pools_found: unique.length,
    created_at_or_before_range_end: unique.filter((p) => p.createdBlock <= to).length,
    created_before_range_start: unique.filter((p) => p.createdBlock < from).length,
    earliest_creation: unique[0]?.createdBlock ?? null,
    pools: unique.map((p) => ({
      venue: p.venue, pool: p.pool, created: p.createdBlock,
      pair: `${p.currency0} / ${p.currency1}`,
    })),
    cu_so_far: rpc.cuSpent,
  });

  /*
   * NO POOL IS AN ANSWER, AND IT IS REPORTED AS ONE. A zero here, from a query
   * that covered the whole chain for both orderings of both pairs, is evidence
   * -- unlike the zero the database gave.
   */
  const eligible = unique.filter((p) => p.createdBlock <= to);
  if (eligible.length === 0) {
    log.warn('NO WETH/USDG OR ETH/USDG POOL EXISTS AT OR BEFORE THIS RANGE', {
      conclusion: 'ETH/USD is not derivable in this range from any such market. '
        + 'The null rows are genuinely underivable and must stay null.',
      cu_spent: rpc.cuSpent,
      dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
      calls: rpc.callCounts(),
    });
    await app.pool.end();
    process.exit(0);
  }

  const v4Pools = eligible.filter((p) => p.venue === 'v4').map((p) => p.pool);
  const v3Pools = eligible.filter((p) => p.venue === 'v3').map((p) => p.pool);
  log.info('sweeping Swap logs for the pools found', {
    range: `${from}..${to}`, blocks: to - from + 1,
    v4_pools: v4Pools.length, v3_pools: v3Pools.length,
    estimated_dense_requests: Math.ceil((to - from + 1) / cfg.maxLogSpanBlocks),
    estimated_cu: Math.ceil((to - from + 1) / cfg.maxLogSpanBlocks) * 60
      * ((v4Pools.length ? 1 : 0) + (v3Pools.length ? 1 : 0)),
  });

  let v4Swaps = 0; let v3Swaps = 0;
  let firstSwap: number | null = null; let lastSwap: number | null = null;
  const note = (block: number): void => {
    if (firstSwap === null || block < firstSwap) firstSwap = block;
    if (lastSwap === null || block > lastSwap) lastSwap = block;
  };

  if (v4Pools.length) {
    const logs = await rpc.getLogs(
      { address: cfg.v4PoolManager, topics: [TOPICS.swapV4, v4Pools] },
      from, to, cfg.maxLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    v4Swaps = logs.length;
    for (const l of logs) note(Number(BigInt(l.blockNumber)));
  }
  if (v3Pools.length) {
    const logs = await rpc.getLogs(
      { address: v3Pools, topics: [TOPICS.swapV3] },
      from, to, cfg.maxLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    v3Swaps = logs.length;
    for (const l of logs) note(Number(BigInt(l.blockNumber)));
  }

  const total = v4Swaps + v3Swaps;
  log.info('PROBE RESULT', {
    range: `${from}..${to}`,
    v4_swaps: v4Swaps,
    v3_swaps: v3Swaps,
    total_swaps: total,
    first_swap_in_range: firstSwap,
    last_swap_in_range: lastSwap,
    conclusion: total === 0
      ? 'the pools exist but did not trade in this range: ETH/USD is still not '
        + 'derivable here, and the null rows must stay null'
      : 'a USD-denominated ETH market DID trade in this range, so ETH/USD is '
        + 'derivable and the null rows are recoverable',
    cu_spent: rpc.cuSpent,
    dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
    calls: rpc.callCounts(),
    wrote: 'nothing',
  });

  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('eth-usd-probe failed', errorFields(err)); process.exit(1); });
