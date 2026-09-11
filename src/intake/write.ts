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
import { poolKey, type PoolRow } from '../adapters/token-updates/pools.js';
import type { SwapLog, TransferLog } from '../adapters/token-updates/decode.js';
import {
  buildRows, buildTransferRows, tradeLegs,
  type RowStats, type WalletRow,
} from '../adapters/token-updates/rows.js';
import {
  counterUsdResolver,
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
 * THE ONE DERIVATION of which blocks need a timestamp.
 *
 * Both the plan and the fetch call this. They used to be two separate queries
 * that were supposed to agree and did not: the plan scoped its count to
 * transactions involving cohort wallets and the fetch selected every block in
 * `token_swap_logs`, so the plan printed a small number and the fetch would
 * have done a much larger job. That is docs/ROBINHOOD.md step 9 -- the work-set rule -- a work set
 * derived from the wrong population -- reappearing inside the code written to
 * prevent them. On PONS the same distinction was 144,073 blocks against
 * 1,379,236, and roughly 7,000,000 compute units.
 *
 * There is now one SQL text. A future edit cannot move one copy and leave the
 * other behind, because there is no other copy.
 */
export const NEEDED_BLOCKS_SQL = `
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
     )`;

export async function planTimestamps(
  client: PoolClient,
  cfg: IntakeConfig,
): Promise<TimestampPlan> {
  const res = await client.query<{ needed: number; stored: number }>(
    `with needed as (${NEEDED_BLOCKS_SQL})
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
 * it stopped. Uses NEEDED_BLOCKS_SQL, the same derivation planTimestamps
 * counted, and asserts the two agree before spending anything.
 */
export async function fetchTimestamps(
  client: PoolClient,
  rpc: RpcClient,
  cfg: IntakeConfig,
  ceilingCu: number,
  onProgress?: (done: number, total: number) => void,
): Promise<{ fetched: number; remaining: number; stoppedAtCeiling: boolean }> {
  const plan = await planTimestamps(client, cfg);
  const missing = await client.query<{ block_number: number }>(
    `with needed as (${NEEDED_BLOCKS_SQL})
     select n.block_number from needed n
       left join block_times b on b.chain = $1 and b.block_number = n.block_number
      where b.block_number is null
      order by n.block_number`,
    [cfg.chain, cfg.token],
  );
  const blocks = missing.rows.map((r) => Number(r.block_number));

  /*
   * The plan is what was reported and possibly approved; the fetch is what is
   * about to be paid for. If they disagree, the job stops rather than spending
   * against a number nobody saw.
   */
  if (blocks.length !== plan.toFetch) {
    throw new Error(
      `the timestamp plan and the fetch disagree: plan said ${plan.toFetch} blocks, ` +
        `the fetch found ${blocks.length}. Refusing to spend against an unreported figure.`,
    );
  }

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
 * Swaps and transfers for a range, WITHOUT timestamps.
 *
 * The cohort phase runs before the timestamp phase, so it cannot require
 * block_times. It only needs to know who traded, and a trade leg does not
 * depend on the clock. Rows do, and `loadSlice` below refuses to build one
 * without a timestamp.
 */
export async function loadLegsInput(
  client: PoolClient,
  cfg: IntakeConfig,
  pools: Map<string, PoolRow>,
  fromBlock: number,
  toBlock: number,
): Promise<Slice> {
  const swapRows = await client.query<{
    venue: string; pool: string; block_number: number; log_index: number;
    tx_hash: string; amount0: string; amount1: string;
  }>(
    `select venue, pool, block_number, log_index, tx_hash, amount0::text, amount1::text
       from token_swap_logs
      where chain = $1 and token = $2 and block_number between $3 and $4`,
    [cfg.chain, cfg.token, fromBlock, toBlock],
  );
  const swaps: Slice['swaps'] = [];
  for (const r of swapRows.rows) {
    const venue = r.venue === 'v4' ? 'v4' : 'v3';
    const pool = pools.get(poolKey(venue, r.pool.toLowerCase()));
    if (!pool) continue;
    swaps.push({
      pool,
      swap: {
        venue, pool: r.pool.toLowerCase(), txHash: r.tx_hash.toLowerCase(),
        block: Number(r.block_number), logIndex: Number(r.log_index),
        timestamp: 0, // deliberately absent; legs do not use it
        amount0: BigInt(r.amount0), amount1: BigInt(r.amount1),
      },
    });
  }
  const transferRows = await client.query<{
    block_number: number; log_index: number; tx_hash: string;
    from_addr: string; to_addr: string; amount: string;
  }>(
    `select block_number, log_index, tx_hash, from_addr, to_addr, amount::text
       from token_transfer_logs
      where chain = $1 and token = $2 and block_number between $3 and $4`,
    [cfg.chain, cfg.token, fromBlock, toBlock],
  );
  const transfers: TransferLog[] = transferRows.rows.map((r) => ({
    from: r.from_addr.toLowerCase(), to: r.to_addr.toLowerCase(),
    amount: BigInt(r.amount), txHash: r.tx_hash.toLowerCase(),
    block: Number(r.block_number), logIndex: Number(r.log_index), timestamp: 0,
  }));
  return { swaps, transfers };
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
    const pool = pools.get(poolKey(venue, r.pool.toLowerCase()));
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
): Promise<{ series: PriceSeries[]; buckets: number }> {
  const sliceBlocks = cfg.sliceBlocks;
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


/** Store a bridge series, and read one back for the pricing resolver. */
export async function persistBridgeUsd(
  client: PoolClient,
  cfg: IntakeConfig,
  bridge: string,
  series: Map<number, { price: number; ticks: number }>,
): Promise<{ inserted: number; alreadyPresent: number }> {
  let inserted = 0;
  for (const [bucket, v] of series) {
    const res = await client.query(
      `insert into bridge_usd_prices (chain, bridge, bucket_block, usd, ticks)
       values ($1,$2,$3,$4,$5) on conflict do nothing`,
      [cfg.chain, bridge.toLowerCase(), bucket, v.price, v.ticks],
    );
    inserted += res.rowCount ?? 0;
  }
  return { inserted, alreadyPresent: series.size - inserted };
}

export async function loadBridgeUsd(
  client: PoolClient,
  cfg: IntakeConfig,
): Promise<Map<string, Map<number, { price: number }>>> {
  const out = new Map<string, Map<number, { price: number }>>();
  if (cfg.bridgeAssets.length === 0) return out;
  const res = await client.query<{ bridge: string; bucket_block: number; usd: string }>(
    `select bridge, bucket_block, usd::text from bridge_usd_prices
      where chain = $1 and bridge = any($2::text[])`,
    [cfg.chain, cfg.bridgeAssets.map((a) => a.toLowerCase())],
  );
  for (const r of res.rows) {
    const price = Number(r.usd);
    if (!Number.isFinite(price) || price <= 0) continue;
    let m = out.get(r.bridge);
    if (!m) { m = new Map(); out.set(r.bridge, m); }
    m.set(Number(r.bucket_block), { price });
  }
  return out;
}

/**
 * ROBINHOOD.md step 10: stored prices must fall inside the range of the ticks
 * they came from. Anything outside it is a defect to explain, not an outlier to
 * accept -- a stored range of 1.2e-14..0.25 against a tick range of
 * 0.065..0.102 is what exposed 89 invented buyer rows once.
 */
export async function checkPricesAgainstTicks(
  client: PoolClient,
  cfg: IntakeConfig,
): Promise<{ tickLo: number; tickHi: number; storedLo: number; storedHi: number; outside: number }> {
  const t = await client.query<{ lo: string; hi: string }>(
    `select min(pons_usd)::text lo, max(pons_usd)::text hi
       from ${cfg.tokenUsdTable} where chain = $1`,
    [cfg.chain],
  );
  const r = await client.query<{ lo: string; hi: string; outside: number }>(
    `select min(price_usd)::text lo, max(price_usd)::text hi,
            count(*) filter (
              where price_usd < (select min(pons_usd) from ${cfg.tokenUsdTable} where chain = $1)
                 or price_usd > (select max(pons_usd) from ${cfg.tokenUsdTable} where chain = $1)
            )::int as outside
       from wallet_transactions
      where chain = $1 and token = $2 and price_usd is not null`,
    [cfg.chain, cfg.token],
  );
  return {
    tickLo: Number(t.rows[0]?.lo ?? NaN), tickHi: Number(t.rows[0]?.hi ?? NaN),
    storedLo: Number(r.rows[0]?.lo ?? NaN), storedHi: Number(r.rows[0]?.hi ?? NaN),
    outside: r.rows[0]?.outside ?? 0,
  };
}

/**
 * ROBINHOOD.md step 11: sanity-check the USD total against market cap divided
 * by supply before reporting it. A sum is the cheapest tripwire there is -- one
 * window once totalled $136,522,225,213,212,380 on a token worth $0.095.
 */
export function checkUsdTotal(
  totalUsd: number,
  totalTokens: number,
  totalSupply: number,
  impliedPriceCeiling: number,
): { impliedPrice: number; absurd: boolean; reason: string } {
  const impliedPrice = totalTokens > 0 ? totalUsd / totalTokens : NaN;
  const absurd = !Number.isFinite(impliedPrice) || impliedPrice > impliedPriceCeiling;
  return {
    impliedPrice,
    absurd,
    reason: absurd
      ? `implied price ${impliedPrice} exceeds the ceiling ${impliedPriceCeiling}; ` +
        `total supply ${totalSupply} -- stop rather than report this`
      : 'within the ceiling',
  };
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
  /** Trade rows only. Transfers are counted separately, never folded in. */
  tradeRows: number;
  /** Movements that changed a position without being a trade. */
  transfersWritten: number;
  transfersSkippedAsTrades: number;
  transfersBelowFloor: number;
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
    tradeRows: 0,
    transfersWritten: 0,
    transfersSkippedAsTrades: 0,
    transfersBelowFloor: 0,
  };
}

function fold(plan: WritePlan, rows: WalletRow[], stats: RowStats, wallets: Set<string>): void {
  plan.rows += rows.length;
  plan.tradeRows += rows.filter((r) => r.side === 'buy' || r.side === 'sell').length;
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
  bridgeUsd: Map<string, Map<number, { price: number }>> = new Map(),
  /**
   * Correction mode. Deletes this token's rows in the range before reinserting,
   * scoped to (chain, token) and the block range -- NEVER wider. Without it a
   * re-run cannot fix a bad run: `on conflict do nothing` leaves the wrong rows
   * exactly where they are. The caller must have reported the dry-run counts,
   * including the zeros, before setting this.
   */
  reinsert = false,
): Promise<{ plan: WritePlan; stored: number; deleted: number }> {
  const sliceBlocks = cfg.sliceBlocks;
  let deleted = 0;
  if (commit && reinsert) {
    const res = await client.query(
      `delete from wallet_transactions
        where chain = $1 and token = $2 and block_number between $3 and $4`,
      [cfg.chain, cfg.token, firstBlock, lastBlock],
    );
    deleted = res.rowCount ?? 0;
  }
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

    const resolver = counterUsdResolver(cfg, nativeUsd, bridgeUsd);
    // Rows are NOT payment-proven -- that is settled; see docs/ROBINHOOD.md
    // step 7 and step 11. Proof happens once per wallet at cohort time.
    const { legs } = tradeLegs(
      slice.swaps, slice.transfers, cfg, resolver, exclusions, knownPools,
    );
    const { rows: tRows, skippedBecauseTraded, skippedBelowFloor } = buildTransferRows(
      slice.transfers, legs, cfg, tokenDecimals, exclusions, knownPools, cohort,
    );
    plan.transfersWritten += tRows.length;
    plan.transfersSkippedAsTrades += skippedBecauseTraded;
    plan.transfersBelowFloor += skippedBelowFloor;

    const { rows, stats } = buildRows(
      slice.swaps,
      slice.transfers,
      cfg,
      tokenDecimals,
      resolver,
      exclusions,
      knownPools,
      cohort,
    );
    fold(plan, rows.concat(tRows), stats, wallets);

    if (commit) {
      for (const r of rows.concat(tRows)) {
        const res = await client.query(
          `insert into wallet_transactions
             (chain, token, wallet, side, counterparty, tx_hash, pool,
              block_time, block_number, token_amount, usd_amount, price_usd)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           on conflict do nothing`,
          [
            cfg.chain, cfg.token, r.wallet, r.side, r.counterparty ?? null,
            r.txHash, r.pool,
            r.blockTime, r.blockNumber, r.tokenAmount, r.usdAmount, r.priceUsd,
          ],
        );
        stored += res.rowCount ?? 0;
      }
    }
  }

  plan.wallets = wallets.size;
  return { plan, stored, deleted };
}
