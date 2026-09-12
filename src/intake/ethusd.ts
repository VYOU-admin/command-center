/**
 * The chain's ETH/USD series, derived from the market that IS ETH/USD.
 *
 * docs/ROBINHOOD.md step 10. `native_usd_prices` used to exist only where a
 * TRACKED token happened to trade against both a native asset and USDG inside
 * one bucket, which made the chain's reference series an accident of which tokens
 * were loaded: it began at 5,363,150 -- the bucket of INDEX's first USDG swap --
 * and 6,052 INDEX rows below it had no USD.
 *
 * THE TICK IS CONVENTION-INDEPENDENT, which is what makes one derivation safe
 * across both venues. A tick is |usd side| / |native side|; absolute values mean
 * the v3 POOL perspective and the v4 SWAPPER perspective yield the same
 * magnitude. Step 6's conventions decide direction, and direction is not asked
 * for here.
 *
 * IT WRITES ONLY MISSING BUCKETS. "Never rewrite a bucket that is already
 * stored" is the older rule and it wins, so the insert is ON CONFLICT DO NOTHING
 * and the count skipped is reported rather than hidden. The single-tick buckets
 * at 5,363,150 and friends are left exactly as they are.
 */

import type { PoolClient } from '../store/db.js';
import type { RpcClient, LogEntry } from '../adapters/token-updates/rpc.js';
import {
  TOPICS, addressTopic, decodeInitializeV4, decodePoolCreatedV3,
} from '../adapters/token-updates/decode.js';
import { bucketOf } from '../adapters/token-updates/prices.js';
import { log } from '../logger.js';

export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

export const ETHUSD_SCHEMA = `
create table if not exists eth_usd_pools (
  chain        text     not null,
  venue        text     not null,
  pool         text     not null,
  created_block bigint  not null,
  currency0    text     not null,
  currency1    text     not null,
  /* Which currency index holds the NATIVE side. The other holds USDG. */
  native_side  smallint not null,
  primary key (chain, venue, pool)
);

create table if not exists eth_usd_market_swaps (
  chain        text    not null,
  venue        text    not null,
  pool         text    not null,
  block_number bigint  not null,
  log_index    bigint  not null,
  tx_hash      text    not null,
  amount0      numeric not null,
  amount1      numeric not null,
  primary key (chain, venue, pool, block_number, log_index)
);

create index if not exists eth_usd_market_swaps_block_idx
  on eth_usd_market_swaps (chain, block_number);

/*
 * PROVENANCE IN THE DATA, NOT ONLY IN PROSE. 'eth-usd-market' is a bucket derived
 * from the dedicated market; NULL is every bucket written before 2026-09-13, from
 * a tracked token's incidental both-sided ticks. The null is the older method,
 * not a missing value.
 */
alter table native_usd_prices add column if not exists source text;
`;

export interface EthUsdPool {
  venue: 'v3' | 'v4';
  pool: string;
  createdBlock: number;
  currency0: string;
  currency1: string;
  nativeSide: 0 | 1;
}

/**
 * Enumerate the market across the whole chain, both orderings of both pairs.
 *
 * Uniswap sorts a pool's currencies by address, and ASSUMING the order is how a
 * filter comes back empty while the pool exists. v3 pairs naming native ETH are
 * skipped rather than queried -- v3 has no native currency, so querying it would
 * return an empty result that reads like an answer.
 */
export async function enumerateEthUsdPools(
  rpc: RpcClient,
  cfg: {
    v3Factory: string; v4PoolManager: string;
    sparseLogSpanBlocks: number; minLogSpanBlocks: number;
  },
  weth: string,
  usdg: string,
  toBlock: number,
): Promise<EthUsdPool[]> {
  const pairs: [string, string][] = [
    [weth, usdg], [usdg, weth],
    [NATIVE_ETH, usdg], [usdg, NATIVE_ETH],
  ];
  const found = new Map<string, EthUsdPool>();
  const natives = new Set([weth, NATIVE_ETH]);

  for (const [c0, c1] of pairs) {
    const v4 = await rpc.getLogs(
      {
        address: cfg.v4PoolManager,
        topics: [TOPICS.initializeV4, null, addressTopic(c0), addressTopic(c1)],
      },
      0, toBlock, cfg.sparseLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    for (const l of v4) {
      const p = decodeInitializeV4(l);
      add(found, natives, 'v4', p.pool, p.currency0, p.currency1, p.block);
    }
    if (c0 === NATIVE_ETH || c1 === NATIVE_ETH) continue;
    const v3 = await rpc.getLogs(
      {
        address: cfg.v3Factory,
        topics: [TOPICS.poolCreatedV3, addressTopic(c0), addressTopic(c1)],
      },
      0, toBlock, cfg.sparseLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    for (const l of v3) {
      const p = decodePoolCreatedV3(l);
      add(found, natives, 'v3', p.pool, p.currency0, p.currency1, p.block);
    }
  }
  return [...found.values()].sort((a, b) => a.createdBlock - b.createdBlock);
}

function add(
  into: Map<string, EthUsdPool>, natives: Set<string>,
  venue: 'v3' | 'v4', pool: string, c0: string, c1: string, block: number,
): void {
  const a0 = c0.toLowerCase(); const a1 = c1.toLowerCase();
  const side: 0 | 1 | null = natives.has(a0) ? 0 : natives.has(a1) ? 1 : null;
  /*
   * A pool matching the filter must have a native side. If neither currency is
   * one, the filter and the decode disagree -- raise rather than guess a side and
   * invert every tick from this pool.
   */
  if (side === null) {
    throw new Error(
      `pool ${pool} matched a WETH/USDG filter but neither currency (${a0}, ${a1}) `
      + 'is a native asset. Refusing to guess which side is ETH.',
    );
  }
  into.set(`${venue}:${pool}`, {
    venue, pool, createdBlock: block, currency0: a0, currency1: a1, nativeSide: side,
  });
}

export async function persistEthUsdPools(
  client: PoolClient, chain: string, pools: EthUsdPool[],
): Promise<number> {
  let n = 0;
  for (const p of pools) {
    const r = await client.query(
      `insert into eth_usd_pools
         (chain, venue, pool, created_block, currency0, currency1, native_side)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (chain, venue, pool) do update
         set created_block = excluded.created_block,
             native_side   = excluded.native_side
       returning (xmax = 0) as inserted`,
      [chain, p.venue, p.pool, p.createdBlock, p.currency0, p.currency1, p.nativeSide],
    );
    if ((r.rows[0] as { inserted: boolean } | undefined)?.inserted) n += 1;
  }
  return n;
}

/**
 * Sweep the market's swaps over a range, storing progressively.
 *
 * v4 pool ids go in `topics[1]` and are CHUNKED AT 500 -- a 540-entry array is
 * accepted and 5,024 hangs with no answer and no refusal (step 5). v3 pools go in
 * `address`, which takes a list.
 */
export async function sweepEthUsdSwaps(
  client: PoolClient,
  rpc: RpcClient,
  chain: string,
  cfg: { v4PoolManager: string; maxLogSpanBlocks: number; minLogSpanBlocks: number },
  pools: EthUsdPool[],
  fromBlock: number,
  toBlock: number,
): Promise<{ v4: number; v3: number; stamps: number }> {
  const v4 = pools.filter((p) => p.venue === 'v4').map((p) => p.pool);
  const v3 = pools.filter((p) => p.venue === 'v3').map((p) => p.pool);
  let v4Rows = 0; let v3Rows = 0; let stamps = 0;

  const store = async (venue: 'v3' | 'v4', logs: LogEntry[]): Promise<number> => {
    let n = 0;
    for (const l of logs) {
      const pool = venue === 'v4' ? l.topics[1]!.toLowerCase() : l.address.toLowerCase();
      const body = l.data.replace(/^0x/, '');
      const a0 = signed(body.slice(0, 64));
      const a1 = signed(body.slice(64, 128));
      const block = Number(BigInt(l.blockNumber));
      await client.query(
        `insert into eth_usd_market_swaps
           (chain, venue, pool, block_number, log_index, tx_hash, amount0, amount1)
         values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
        [chain, venue, pool, block, Number(BigInt(l.logIndex)), l.transactionHash,
          a0.toString(), a1.toString()],
      );
      n += 1;
      /*
       * The timestamp rides with the log on Alchemy and is free. A ZERO IS NOT A
       * TIMESTAMP -- the public RPC returns 0x0 for every log's blockTimestamp,
       * so a zero here means the wrong endpoint, not midnight 1970.
       */
      if (l.blockTimestamp && l.blockTimestamp !== '0x0') {
        const ts = Number(BigInt(l.blockTimestamp));
        const r = await client.query(
          `insert into block_times (chain, block_number, block_time)
           values ($1,$2,to_timestamp($3)) on conflict do nothing`,
          [chain, block, ts],
        );
        stamps += r.rowCount ?? 0;
      }
    }
    return n;
  };

  for (let i = 0; i < v4.length; i += 500) {
    const chunk = v4.slice(i, i + 500);
    const logs = await rpc.getLogs(
      { address: cfg.v4PoolManager, topics: [TOPICS.swapV4, chunk] },
      fromBlock, toBlock, cfg.maxLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    v4Rows += await store('v4', logs);
  }
  if (v3.length) {
    const logs = await rpc.getLogs(
      { address: v3, topics: [TOPICS.swapV3] },
      fromBlock, toBlock, cfg.maxLogSpanBlocks, cfg.minLogSpanBlocks,
    );
    v3Rows += await store('v3', logs);
  }
  return { v4: v4Rows, v3: v3Rows, stamps };
}

function signed(hex: string): bigint {
  let v = BigInt('0x' + hex);
  if (v >= 1n << 255n) v -= 1n << 256n;
  return v;
}

export interface DerivedBucket {
  bucket: number;
  ethUsd: number;
  ticks: number;
  discarded: number;
}

/**
 * Bucketed fenced median of |usd| / |native|, on the given grid.
 *
 * Whole buckets only: a bucket straddling the edge of the range read would be
 * computed from a fraction of its ticks.
 */
export async function deriveEthUsd(
  client: PoolClient,
  chain: string,
  grid: { bucketBlocks: number; bucketOrigin: number },
  fence: number,
  nativeDecimals: number,
  usdDecimals: number,
  fromBlock: number,
  toBlock: number,
): Promise<{ buckets: DerivedBucket[]; ticks: number; discarded: number; swaps: number }> {
  const rows = await client.query<{
    block_number: string; amount0: string; amount1: string; native_side: number;
  }>(
    `select s.block_number::text, s.amount0::text, s.amount1::text, p.native_side
       from eth_usd_market_swaps s
       join eth_usd_pools p
         on p.chain = s.chain and p.venue = s.venue and p.pool = s.pool
      where s.chain = $1 and s.block_number between $2 and $3`,
    [chain, fromBlock, toBlock],
  );

  const nativeScale = 10 ** nativeDecimals;
  const usdScale = 10 ** usdDecimals;
  const byBucket = new Map<number, number[]>();
  for (const r of rows.rows) {
    const a0 = BigInt(r.amount0); const a1 = BigInt(r.amount1);
    const nat = r.native_side === 0 ? a0 : a1;
    const usd = r.native_side === 0 ? a1 : a0;
    // Absolute values: the ratio is the same under either venue's convention.
    const n = Math.abs(Number(nat)) / nativeScale;
    const u = Math.abs(Number(usd)) / usdScale;
    if (!(n > 0) || !(u > 0)) continue;
    const tick = u / n;
    if (!Number.isFinite(tick) || tick <= 0) continue;
    const b = bucketOf(Number(r.block_number), grid.bucketBlocks, grid.bucketOrigin);
    const list = byBucket.get(b);
    if (list) list.push(tick); else byBucket.set(b, [tick]);
  }

  const buckets: DerivedBucket[] = [];
  let ticks = 0; let discarded = 0;
  for (const [bucket, list] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    // Only whole buckets.
    if (bucket < fromBlock || bucket + grid.bucketBlocks - 1 > toBlock) continue;
    const first = median(list);
    if (first === null || first <= 0) { discarded += list.length; continue; }
    const kept = list.filter((t) => t >= first / fence && t <= first * fence);
    const value = median(kept);
    if (value === null) { discarded += list.length; continue; }
    ticks += kept.length;
    discarded += list.length - kept.length;
    buckets.push({ bucket, ethUsd: value, ticks: kept.length, discarded: list.length - kept.length });
  }
  log.info('eth/usd derived', {
    swaps_read: rows.rowCount, buckets: buckets.length, ticks, discarded,
  });
  return { buckets, ticks, discarded, swaps: rows.rowCount ?? 0 };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Write the buckets that are MISSING, and report what was skipped.
 *
 * `on conflict do nothing` because a stored bucket was computed by a run that saw
 * the whole bucket. The skipped count is reported rather than hidden: it is the
 * difference between "this added coverage" and "this quietly agreed with what was
 * already there".
 */
export async function persistEthUsd(
  client: PoolClient, chain: string, buckets: DerivedBucket[],
): Promise<{ inserted: number; alreadyPresent: number }> {
  let inserted = 0;
  for (const b of buckets) {
    const r = await client.query(
      `insert into native_usd_prices
         (chain, block_number, eth_usd, usd_ticks, eth_ticks, source)
       values ($1,$2,$3,$4,$5,'eth-usd-market')
       on conflict do nothing`,
      [chain, b.bucket, b.ethUsd, b.ticks, b.ticks],
    );
    inserted += r.rowCount ?? 0;
  }
  return { inserted, alreadyPresent: buckets.length - inserted };
}
