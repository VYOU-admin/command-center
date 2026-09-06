/**
 * Turning swaps and transfers into wallet rows.
 *
 * DIRECTION COMES FROM THE TRANSFER, NOT FROM THE SWAP'S SIGN. The two venues
 * on this chain use OPPOSITE sign conventions -- v3 reports from the pool's
 * perspective, v4 from the swapper's -- measured unanimously over 1,595 swaps
 * inside and outside the cohort window. Reading direction from the sign would
 * have inverted every v4 buy into a sell across 480,924 rows, with plausible
 * totals throughout and nothing to indicate a problem. A wallet that received
 * the token bought; one that sent it sold. That is directly observable and does
 * not depend on getting a convention right.
 *
 * THE BUYER IS THE NON-POOL SIDE OF THE TRANSFER, not the swap's `sender` or
 * `recipient` topic, which is routinely a router.
 *
 * FOUR FLOORS, EACH CATCHING SOMETHING DIFFERENT. The token-amount floor is the
 * one that is easy to omit: a USD-only floor let through a row carrying 1.7e-6
 * tokens and $980,393.99 of allocated USD -- a price of $5.79e11 per token and
 * 0.87% of the token's entire USD volume, invented.
 *
 * ROWS WITH NULL USD ARE NEVER DROPPED BY THE USD FLOOR. Unpriced is not small;
 * two of the 2,266 unpriced PONS rows carried token amounts in the thousands.
 */

import type { UpdateConfig } from './config.js';
import type { SwapLog, TransferLog } from './decode.js';
import type { PoolRow } from './pools.js';
import { bucketOf } from './prices.js';
import { abs, formatUnits, toNumber } from './units.js';

export interface WalletRow {
  wallet: string;
  side: 'buy' | 'sell';
  txHash: string;
  pool: string;
  blockTime: Date;
  blockNumber: number;
  tokenAmount: string;
  usdAmount: number | null;
  priceUsd: number | null;
}

export interface RowStats {
  swapsConsidered: number;
  swapsBelowTokenRawFloor: number;
  swapsBelowPaidRawFloor: number;
  groups: number;
  groupsWithMultiplePools: number;
  groupsWithoutTransfers: number;
  candidateWallets: number;
  walletsExcludedInfrastructure: number;
  walletsExcludedIsPool: number;
  roundTrippers: number;
  rowsBelowTokenAmountFloor: number;
  rowsBelowUsdFloor: number;
  rowsOutsideCohort: number;
  rowsWithNullUsd: number;
  nullUsdBecauseNoBucketPrice: number;
}

interface Group {
  txHash: string;
  counterparty: string;
  pools: Set<string>;
  block: number;
  timestamp: number;
  tokenRaw: bigint;
  usd: number | null;
  /** True when at least one swap in the group could not be priced. */
  usdIncomplete: boolean;
}

export function buildRows(
  swaps: { swap: SwapLog; pool: PoolRow }[],
  transfers: TransferLog[],
  cfg: UpdateConfig,
  tokenDecimals: number,
  nativeUsd: Map<number, { price: number }>,
  exclusions: Set<string>,
  knownPools: Set<string>,
  cohort: Set<string>,
): { rows: WalletRow[]; stats: RowStats } {
  const usdAsset = cfg.usdAsset.toLowerCase();
  const nativeAssets = new Set(cfg.nativeAssets.map((a) => a.toLowerCase()));
  const poolManager = cfg.v4PoolManager.toLowerCase();

  const stats: RowStats = {
    swapsConsidered: swaps.length,
    swapsBelowTokenRawFloor: 0,
    swapsBelowPaidRawFloor: 0,
    groups: 0,
    groupsWithMultiplePools: 0,
    groupsWithoutTransfers: 0,
    candidateWallets: 0,
    walletsExcludedInfrastructure: 0,
    walletsExcludedIsPool: 0,
    roundTrippers: 0,
    rowsBelowTokenAmountFloor: 0,
    rowsBelowUsdFloor: 0,
    rowsOutsideCohort: 0,
    rowsWithNullUsd: 0,
    nullUsdBecauseNoBucketPrice: 0,
  };

  /* ---- 1. group swaps by transaction and counterparty --------------------- */
  const groups = new Map<string, Group>();
  for (const { swap, pool } of swaps) {
    const tokenRaw = abs(pool.tokenSide === 0 ? swap.amount0 : swap.amount1);
    const counterRaw = abs(pool.tokenSide === 0 ? swap.amount1 : swap.amount0);

    // Floors 1 and 2, at raw-unit resolution, per swap. The paid-side floor
    // catches what the token-side floor does not: a leg where the wallet
    // received real tokens and gave up float residue.
    if (tokenRaw < BigInt(Math.trunc(cfg.floors.tokenRawUnits))) {
      stats.swapsBelowTokenRawFloor += 1;
      continue;
    }
    if (counterRaw < BigInt(Math.trunc(cfg.floors.paidRawUnits))) {
      stats.swapsBelowPaidRawFloor += 1;
      continue;
    }

    const counterparty = swap.venue === 'v3' ? pool.pool : poolManager;
    const key = `${swap.txHash}:${counterparty}`;

    let usd: number | null = null;
    const counterAmount = toNumber(counterRaw, pool.counterDec);
    if (pool.counter === usdAsset) {
      usd = counterAmount;
    } else if (nativeAssets.has(pool.counter)) {
      const price = nativeUsd.get(bucketOf(swap.block, cfg.bucketBlocks));
      usd = price ? counterAmount * price.price : null;
    }

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        txHash: swap.txHash,
        counterparty,
        pools: new Set([pool.pool]),
        block: swap.block,
        timestamp: swap.timestamp,
        tokenRaw,
        usd,
        usdIncomplete: usd === null,
      });
    } else {
      existing.pools.add(pool.pool);
      existing.tokenRaw += tokenRaw;
      existing.block = Math.max(existing.block, swap.block);
      if (usd === null) existing.usdIncomplete = true;
      existing.usd = existing.usd === null ? null : existing.usd + (usd ?? 0);
    }
  }

  /* ---- 2. index transfers by transaction ---------------------------------- */
  const byTx = new Map<string, TransferLog[]>();
  for (const t of transfers) {
    const list = byTx.get(t.txHash);
    if (list) list.push(t);
    else byTx.set(t.txHash, [t]);
  }

  /* ---- 3. attribute each group to wallets --------------------------------- */
  const rows: WalletRow[] = [];
  for (const group of groups.values()) {
    stats.groups += 1;
    if (group.pools.size > 1) stats.groupsWithMultiplePools += 1;

    /*
     * One row per (tx, wallet, side, pool) is what the unique key allows, and
     * the historical rows carry one specific pool. When a transaction touched
     * several v4 pools the flow through the PoolManager cannot be split between
     * them without inventing a split, so the pool recorded is the lowest id in
     * the group. Deterministic on purpose: a re-run picks the same one and
     * collides with the existing row instead of duplicating it.
     */
    const representativePool = [...group.pools].sort()[0]!;

    const txTransfers = byTx.get(group.txHash) ?? [];
    const received = new Map<string, bigint>();
    const sent = new Map<string, bigint>();
    for (const t of txTransfers) {
      if (t.from === group.counterparty && t.to !== group.counterparty) {
        received.set(t.to, (received.get(t.to) ?? 0n) + t.amount);
      } else if (t.to === group.counterparty && t.from !== group.counterparty) {
        sent.set(t.from, (sent.get(t.from) ?? 0n) + t.amount);
      }
    }
    if (received.size === 0 && sent.size === 0) {
      stats.groupsWithoutTransfers += 1;
      continue;
    }

    interface Candidate {
      wallet: string;
      side: 'buy' | 'sell';
      raw: bigint;
    }
    const candidates: Candidate[] = [];
    for (const wallet of new Set([...received.keys(), ...sent.keys()])) {
      if (exclusions.has(wallet)) {
        stats.walletsExcludedInfrastructure += 1;
        continue;
      }
      if (knownPools.has(wallet)) {
        stats.walletsExcludedIsPool += 1;
        continue;
      }
      const gotRaw = received.get(wallet) ?? 0n;
      const gaveRaw = sent.get(wallet) ?? 0n;
      if (gotRaw > 0n && gaveRaw > 0n) {
        // Both directions against the same pool in one transaction: a fee
        // recipient or arbitrage hop, not a trade to attribute.
        stats.roundTrippers += 1;
        continue;
      }
      candidates.push({
        wallet,
        side: gotRaw > 0n ? 'buy' : 'sell',
        raw: gotRaw > 0n ? gotRaw : gaveRaw,
      });
    }
    stats.candidateWallets += candidates.length;

    /*
     * The denominator spans EVERY candidate, including wallets outside the
     * cohort. Allocating only across cohort wallets would hand them dollars
     * that belonged to someone else in the same transaction.
     */
    const totalRaw = candidates.reduce((sum, c) => sum + c.raw, 0n);
    if (totalRaw === 0n) continue;

    for (const c of candidates) {
      /*
       * Cohort membership is checked BEFORE the floors so the floor counts
       * describe rows that would otherwise have been written. Counting floors
       * over every wallet on the chain would drown the number that matters.
       */
      if (!cohort.has(c.wallet)) {
        stats.rowsOutsideCohort += 1;
        continue;
      }

      const tokenAmount = formatUnits(c.raw, tokenDecimals);
      if (Number(tokenAmount) < cfg.floors.tokenAmount) {
        stats.rowsBelowTokenAmountFloor += 1;
        continue;
      }

      const share = Number(c.raw) / Number(totalRaw);
      const usd =
        group.usd === null || group.usdIncomplete ? null : group.usd * share;

      // A null-USD row is unpriced, not small. The USD floor must not touch it.
      if (usd !== null && usd < cfg.floors.usd) {
        stats.rowsBelowUsdFloor += 1;
        continue;
      }
      if (usd === null) {
        stats.rowsWithNullUsd += 1;
        if (group.usdIncomplete) stats.nullUsdBecauseNoBucketPrice += 1;
      }

      const amountNumber = Number(tokenAmount);
      rows.push({
        wallet: c.wallet,
        side: c.side,
        txHash: group.txHash,
        pool: representativePool,
        blockTime: new Date(group.timestamp * 1000),
        blockNumber: group.block,
        tokenAmount,
        usdAmount: usd,
        priceUsd: usd !== null && amountNumber > 0 ? usd / amountNumber : null,
      });
    }
  }

  return { rows, stats };
}
