/**
 * Phases 8-11: block timestamps, native price derivation, the dry run, and the
 * write.
 *
 * THE TIMESTAMP WORK SET COMES FROM THE ROWS THAT WILL BE WRITTEN, not from
 * every block in the swap table. On PONS that distinction was a 9.6x overshoot
 * -- 1,379,236 blocks fetched where 51,475 were needed -- and roughly 7,000,000
 * compute units. The count is derived and reported BEFORE the first request,
 * and the phase stops at its ceiling regardless of progress.
 */

import type { IntakeConfig } from './plan.js';
import type { RpcClient } from '../adapters/token-updates/rpc.js';
import type { PoolRow } from '../adapters/token-updates/pools.js';
import type { SwapLog, TransferLog } from '../adapters/token-updates/decode.js';
import { buildRows, type RowStats, type WalletRow } from '../adapters/token-updates/rows.js';
import {
  derivePrices,
  loadNativeReference,
  persistPrices,
  type PriceSeries,
} from '../adapters/token-updates/prices.js';
import type { PoolClient } from '../store/db.js';

/* ------------------------------------------------------------- timestamps */

export interface TimestampPlan {
  /** Distinct blocks the rows to be written actually need. */
  needed: number;
  alreadyStored: number;
  toFetch: number;
  /** Sub-calls this would cost, stated before any are made. */
  estimatedCalls: number;
  estimatedCu: number;
}

/**
 * Which blocks need a timestamp, derived from the swaps that will produce rows
 * for cohort wallets -- not from every swap block.
 */
export async function planTimestamps(
  client: PoolClient,
  cfg: IntakeConfig,
): Promise<TimestampPlan> {
  const res = await client.query<{ needed: number; stored: number }>(
    `with needed as (
       select distinct s.block_number
         from token_swap_logs s
         join pool_meta m
           on m.chain = $1 and m.token = $2 and m.venue = s.venue and m.pool = s.pool
        where s.chain = $1 and s.token = $2
          and exists (
            select 1 from token_transfer_logs t
             where t.chain = s.chain and t.token = s.token and t.tx_hash = s.tx_hash
               and (t.to_addr in (select wallet from wallet_tags where mint = $2)
                 or t.from_addr in (select wallet from wallet_tags where mint = $2))
          )
     )
     select count(*)::int as needed,
            count(b.block_number)::int as stored
       from needed n
       left join block_times b on b.chain = $1 and b.block_number = n.block_number`,
    [cfg.chain, cfg.token],
  );
  const needed = res.rows[0]?.needed ?? 0;
  const alreadyStored = res.rows[0]?.stored ?? 0;
  const toFetch = needed - alreadyStored;
  return {
    needed,
    alreadyStored,
    toFetch,
    estimatedCalls: toFetch,
    // eth_getBlockByNumber is 20 CU per sub-call at the provider's published rate.
    estimatedCu: toFetch * 20,
  };
}

/**
 * Fetch the missing timestamps, stopping at the phase ceiling and saying where
 * it stopped rather than running to completion regardless.
 */
export async function fetchTimestamps(
  client: PoolClient,
  rpc: RpcClient,
  cfg: IntakeConfig,
  ceilingCu: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ fetched: number; remaining: number; stoppedAtCeiling: boolean }> {
  const missing = await client.query<{ block_number: number }>(
    `with needed as (
       select distinct s.block_number
         from token_swap_logs s
         join pool_meta m
           on m.chain = $1 and m.token = $2 and m.venue = s.venue and m.pool = s.pool
        where s.chain = $1 and s.token = $2
     )
     select n.block_number from needed n
       left join block_times b on b.chain = $1 and b.block_number = n.block_number
      where b.block_number is null
      order by n.block_number`,
    [cfg.chain, cfg.token],
  );

  const blocks = missing.rows.map((r) => Number(r.block_number));
  const startCu = rpc.cuSpent;
  let fetched = 0;
  for (const block of blocks) {
    if (rpc.cuSpent - startCu >= ceilingCu) {
      return { fetched, remaining: blocks.length - fetched, stoppedAtCeiling: true };
    }
    const ts = await rpc.getBlockTimestamp(block);
    await client.query(
      `insert into block_times (chain, block_number, block_time)
       values ($1, $2, to_timestamp($3))
       on conflict do nothing`,
      [cfg.chain, block, ts],
    );
    fetched += 1;
    if (onProgress && fetched % 500 === 0) onProgress(fetched, blocks.length);
  }
  return { fetched, remaining: 0, stoppedAtCeiling: false };
}

/* ------------------------------------------------------- loading a slice */

export interface Slice {
  swaps: { swap: SwapLog; pool: PoolRow }[];
  transfers: TransferLog[];
}

/**
 * Read one block range back out of the stored logs, joined to their timestamps.
 * A block with no stored timestamp is an error, not a row with a null time:
 * `block_time` is NOT NULL and a missing timestamp means phase 8 was incomplete.
 */
export async function loadSlice(
  client: PoolClient,
  cfg: IntakeConfig,
  pools: Map<string, PoolRow>,
  fromBlock: number,
  toBlock: number,
): Promise<Slice> {
  const swapRows = await client.query<{
    venue: string; pool: string; block_number: number; log_index: number;
    tx_hash: string; amount0: string; amount1: string; ts: string | null;
  }>(
    `select s.venue, s.pool, s.block_number, s.log_index, s.tx_hash,
            s.amount0::text, s.amount1::text,
            extract(epoch from b.block_time)::text as ts
       from token_swap_logs s
       left join block_times b on b.chain = s.chain and b.block_number = s.block_number
      where s.chain = $1 and s.token = $2 and s.block_number between $3 and $4`,
    [cfg.chain, cfg.token, fromBlock, toBlock],
  );

  const swaps: Slice['swaps'] = [];
  for (const r of swapRows.rows) {
    const venue = r.venue === 'v4' ? 'v4' : 'v3';
    const pool = pools.get(`${venue}:${r.pool.toLowerCase()}`);
    if (!pool) continue; // out of scope; not an error
    if (r.ts === null) {
      throw new Error(
        `block ${r.block_number} has no stored timestamp but carries a swap that ` +
          'would become a row. Phase 8 did not complete for this range.',
      );
    }
    swaps.push({
      pool,
      swap: {
        venue,
        pool: r.pool.toLowerCase(),
        txHash: r.tx_hash.toLowerCase(),
        block: Number(r.block_number),
        logIndex: Number(r.log_index),
        timestamp: Math.floor(Number(r.ts)),
        amount0: BigInt(r.amount0),
        amount1: BigInt(r.amount1),
      },
    });
  }

  const transferRows = await client.query<{
    block_number: number; log_index: number; tx_hash: string;
    from_addr: string; to_addr: string; amount: string; ts: string | null;
  }>(
    `select t.block_number, t.log_index, t.tx_hash, t.from_addr, t.to_addr, t.amount::text,
            extract(epoch from b.block_time)::text as ts
       from token_transfer_logs t
       left join block_times b on b.chain = t.chain and b.block_number = t.block_number
      where t.chain = $1 and t.token = $2 and t.block_number between $3 and $4`,
    [cfg.chain, cfg.token, fromBlock, toBlock],
  );

  const transfers: TransferLog[] = transferRows.rows.map((r) => ({
    from: r.from_addr.toLowerCase(),
    to: r.to_addr.toLowerCase(),
    amount: BigInt(r.amount),
    txHash: r.tx_hash.toLowerCase(),
    block: Number(r.block_number),
    logIndex: Number(r.log_index),
    timestamp: r.ts === null ? 0 : Math.floor(Number(r.ts)),
  }));

  return { swaps, transfers };
}

/* ------------------------------------------------------------- price phase */

export async function derivePricesForLife(
  client: PoolClient,
  cfg: IntakeConfig,
  pools: Map<string, PoolRow>,
  tokenDecimals: number,
  firstBlock: number,
  lastBlock: number,
  sliceBlocks = 500_000,
): Promise<{ series: PriceSeries[]; buckets: number }> {
  const reference = await loadNativeReference(client, cfg.nativeUsdTable, cfg.chain);
  const series: PriceSeries[] = [];
  let buckets = 0;
  for (let from = firstBlock; from <= lastBlock; from += sliceBlocks) {
    const to = Math.min(from + sliceBlocks - 1, lastBlock);
    const slice = await loadSlice(client, cfg, pools, from, to);
    // Only whole buckets: a bucket straddling the slice boundary would be
    // computed from part of its ticks.
    const firstComplete =
      cfg.bucketOrigin +
      Math.ceil((from - cfg.bucketOrigin) / cfg.bucketBlocks) * cfg.bucketBlocks;
    const s = derivePrices(slice.swaps, cfg, tokenDecimals, reference, firstComplete);
    series.push(s);
    buckets += s.nativeUsd.size;
  }
  return { series, buckets };
}

export async function persistAllPrices(
  client: PoolClient,
  cfg: IntakeConfig,
  series: PriceSeries[],
): Promise<{ tokenUsdInserted: number; nativeUsdInserted: number; alreadyPresent: number }> {
  let tokenUsdInserted = 0;
  let nativeUsdInserted = 0;
  let alreadyPresent = 0;
  for (const s of series) {
    const r = await persistPrices(client, cfg, s);
    tokenUsdInserted += r.tokenUsdInserted;
    nativeUsdInserted += r.nativeUsdInserted;
    alreadyPresent += r.tokenUsdAlreadyPresent + r.nativeUsdAlreadyPresent;
  }
  return { tokenUsdInserted, nativeUsdInserted, alreadyPresent };
}

/* --------------------------------------------------------- dry run + write */

export interface WritePlan {
  rows: number;
  bySide: Record<string, number>;
  wallets: number;
  usdNull: number;
  totals: { tokenAmount: number; usd: number };
  floors: {
    swapsBelowTokenRaw: number;
    swapsBelowPaidRaw: number;
    rowsBelowTokenAmount: number;
    rowsBelowUsd: number;
  };
  excluded: {
    infrastructure: number;
    isAPool: number;
    roundTrippers: number;
    outsideCohort: number;
  };
  groupsWithoutTransfers: number;
  groupsWithMultiplePools: number;
}

function emptyPlan(): WritePlan {
  return {
    rows: 0,
    bySide: { buy: 0, sell: 0 },
    wallets: 0,
    usdNull: 0,
    totals: { tokenAmount: 0, usd: 0 },
    floors: {
      swapsBelowTokenRaw: 0,
      swapsBelowPaidRaw: 0,
      rowsBelowTokenAmount: 0,
      rowsBelowUsd: 0,
    },
    excluded: { infrastructure: 0, isAPool: 0, roundTrippers: 0, outsideCohort: 0 },
    groupsWithoutTransfers: 0,
    groupsWithMultiplePools: 0,
  };
}

function fold(plan: WritePlan, rows: WalletRow[], stats: RowStats, wallets: Set<string>): void {
  plan.rows += rows.length;
  for (const r of rows) {
    plan.bySide[r.side] = (plan.bySide[r.side] ?? 0) + 1;
    wallets.add(r.wallet);
    plan.totals.tokenAmount += Number(r.tokenAmount);
    if (r.usdAmount === null) plan.usdNull += 1;
    else plan.totals.usd += r.usdAmount;
  }
  plan.floors.swapsBelowTokenRaw += stats.swapsBelowTokenRawFloor;
  plan.floors.swapsBelowPaidRaw += stats.swapsBelowPaidRawFloor;
  plan.floors.rowsBelowTokenAmount += stats.rowsBelowTokenAmountFloor;
  plan.floors.rowsBelowUsd += stats.rowsBelowUsdFloor;
  plan.excluded.infrastructure += stats.walletsExcludedInfrastructure;
  plan.excluded.isAPool += stats.walletsExcludedIsPool;
  plan.excluded.roundTrippers += stats.roundTrippers;
  plan.excluded.outsideCohort += stats.rowsOutsideCohort;
  plan.groupsWithoutTransfers += stats.groupsWithoutTransfers;
  plan.groupsWithMultiplePools += stats.groupsWithMultiplePools;
}

/**
 * Build every row the write would produce and report the counts. WRITES
 * NOTHING. `commit` turns the same pass into the write, so the dry run and the
 * write cannot drift apart -- they are the same code path.
 */
export async function planOrWrite(
  client: PoolClient,
  cfg: IntakeConfig,
  pools: Map<string, PoolRow>,
  tokenDecimals: number,
  cohort: Set<string>,
  exclusions: Set<string>,
  firstBlock: number,
  lastBlock: number,
  commit: boolean,
  sliceBlocks = 500_000,
): Promise<{ plan: WritePlan; stored: number }> {
  const plan = emptyPlan();
  const wallets = new Set<string>();
  const knownPools = new Set([...pools.values()].map((p) => p.pool));
  let stored = 0;

  for (let from = firstBlock; from <= lastBlock; from += sliceBlocks) {
    const to = Math.min(from + sliceBlocks - 1, lastBlock);
    const slice = await loadSlice(client, cfg, pools, from, to);

    const nativeRows = await client.query<{ block_number: number; eth_usd: string }>(
      `select block_number, eth_usd::text from ${cfg.nativeUsdTable}
        where chain = $1 and block_number between $2 and $3`,
      [cfg.chain, from - cfg.bucketBlocks, to],
    );
    const nativeUsd = new Map<number, { price: number }>();
    for (const r of nativeRows.rows) {
      const price = Number(r.eth_usd);
      if (Number.isFinite(price) && price > 0) {
        nativeUsd.set(Number(r.block_number), { price });
      }
    }

    const { rows, stats } = buildRows(
      slice.swaps,
      slice.transfers,
      cfg,
      tokenDecimals,
      nativeUsd,
      exclusions,
      knownPools,
      cohort,
    );
    fold(plan, rows, stats, wallets);

    if (commit) {
      for (const r of rows) {
        const res = await client.query(
          `insert into wallet_transactions
             (chain, token, wallet, side, counterparty, tx_hash, pool,
              block_time, block_number, token_amount, usd_amount, price_usd)
           values ($1, $2, $3, $4, null, $5, $6, $7, $8, $9, $10, $11)
           on conflict do nothing`,
          [
            cfg.chain, cfg.token, r.wallet, r.side, r.txHash, r.pool,
            r.blockTime, r.blockNumber, r.tokenAmount, r.usdAmount, r.priceUsd,
          ],
        );
        stored += res.rowCount ?? 0;
      }
    }
  }

  plan.wallets = wallets.size;
  return { plan, stored };
}
