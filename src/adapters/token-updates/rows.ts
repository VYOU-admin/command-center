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

import type { Floors } from './config.js';
import type { SwapLog, TransferLog } from './decode.js';
import type { PoolRow } from './pools.js';
import { bucketOf } from './prices.js';
import { abs, formatUnits, toNumber } from './units.js';

/**
 * The slice of configuration row-building actually needs. Declared narrowly so
 * the hourly update job and the intake runner can both pass their own config
 * object without one importing the other's shape.
 */
export interface RowConfig {
  usdAsset: string;
  nativeAssets: string[];
  /**
   * Assets that are neither dollars nor the native asset, but whose own USD
   * price is derivable ON CHAIN from their pools against a pricing asset.
   * Pricing through one is the SECOND HOP: token -> bridge -> USD.
   */
  bridgeAssets: string[];
  v4PoolManager: string;
  bucketBlocks: number;
  bucketOrigin: number;
  floors: Floors;
}

/**
 * What one whole unit of a counter asset is worth in USD at a block, or null.
 *
 * ONE RESOLVER, so the pricing route is a lookup rather than a chain of
 * branches. USDG returns 1, WETH and native ETH return the derived native
 * price, a bridge asset returns its own derived price, and anything else
 * returns null -- which becomes a null usd_amount, never a zero.
 */
export type CounterUsdResolver = (counter: string, block: number) => number | null;

export interface WalletRow {
  wallet: string;
  side: 'buy' | 'sell' | 'transfer_in' | 'transfer_out';
  txHash: string;
  /** Null for a transfer: there is no pool. */
  pool: string | null;
  /** Set only for a transfer, where it is the other side of the movement. */
  counterparty?: string | null;
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
  /** Receipts rejected because the wallet gave up nothing in that transaction. */
  buysWithNoPayment: number;
}

/**
 * A single trade leg: one wallet, one direction, in one (transaction, pool)
 * group. THIS IS THE ONE IMPLEMENTATION of what counts as a trade.
 *
 * The cohort builder and the row writer both call `tradeLegs`. They used to
 * disagree: the row writer grouped by swaps and required one, while the cohort
 * builder read transfers alone and never joined the swap table, so a transfer
 * out of the PoolManager with no swap -- liquidity removal, for instance --
 * qualified a wallet for the cohort but produced no row. Two implementations of
 * one rule is a bug waiting to happen; this is the fix.
 */
/**
 * Membership test for "this wallet gave up value in transaction X".
 * A plain Set of `${txHash}:${wallet}` satisfies it.
 */
export type PaymentIndex = { has(key: string): boolean };

export interface TradeLeg {
  wallet: string;
  side: 'buy' | 'sell';
  /** Raw token units the wallet netted in this group. */
  raw: bigint;
  txHash: string;
  pool: string;
  counterparty: string;
  block: number;
  timestamp: number;
  /** Total raw token moved by ALL candidates in the group, for allocation. */
  groupTotalRaw: bigint;
  groupUsd: number | null;
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

/**
 * Derive every trade leg in a slice. Pure, and shared by the cohort builder and
 * the row writer so that "who traded" has exactly one definition.
 */
export function tradeLegs(
  swaps: { swap: SwapLog; pool: PoolRow }[],
  transfers: TransferLog[],
  cfg: RowConfig,
  counterUsd: CounterUsdResolver,
  exclusions: Set<string>,
  knownPools: Set<string>,
  /**
   * (tx, wallet) pairs where the wallet has been PROVEN to give up value, from
   * the transaction receipt plus `tx.value` -- see `intake/payment.ts`, which
   * is the single implementation. Null disables the check, and is correct only
   * for the first of the two passes that builds this index; it is not a
   * default, and no caller should pass null and then write the result.
   */
  payments: PaymentIndex | null,
): { legs: TradeLeg[]; stats: RowStats } {
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
    buysWithNoPayment: 0,
  };

  /* ---- 1. group swaps by transaction and counterparty --------------------- */
  const groups = new Map<string, Group>();
  for (const { swap, pool } of swaps) {
    const tokenRaw = abs(pool.tokenSide === 0 ? swap.amount0 : swap.amount1);
    const counterRaw = abs(pool.tokenSide === 0 ? swap.amount1 : swap.amount0);

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

    const counterAmount = toNumber(counterRaw, pool.counterDec);
    const rate = counterUsd(pool.counter, swap.block);
    const usd = rate === null ? null : counterAmount * rate;

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        txHash: swap.txHash, counterparty, pools: new Set([pool.pool]),
        block: swap.block, timestamp: swap.timestamp, tokenRaw,
        usd, usdIncomplete: usd === null,
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

  /* ---- 3. one leg per wallet per group ------------------------------------ */
  const legs: TradeLeg[] = [];
  for (const group of groups.values()) {
    stats.groups += 1;
    if (group.pools.size > 1) stats.groupsWithMultiplePools += 1;
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

    const candidates: { wallet: string; side: 'buy' | 'sell'; raw: bigint }[] = [];
    for (const wallet of new Set([...received.keys(), ...sent.keys()])) {
      if (exclusions.has(wallet)) { stats.walletsExcludedInfrastructure += 1; continue; }
      if (knownPools.has(wallet)) { stats.walletsExcludedIsPool += 1; continue; }
      const gotRaw = received.get(wallet) ?? 0n;
      const gaveRaw = sent.get(wallet) ?? 0n;
      // Both directions against the same pool in one TRANSACTION: a fee
      // recipient or arbitrage hop, not a trade to attribute.
      if (gotRaw > 0n && gaveRaw > 0n) { stats.roundTrippers += 1; continue; }
      const side: 'buy' | 'sell' = gotRaw > 0n ? 'buy' : 'sell';
      /*
       * THE SECOND HALF OF A BUY. Receiving the token is not buying it: the
       * wallet must have given up value in the same transaction. Testing only
       * the receipt classified 159 of 1,395 legs -- 11% -- as purchases where
       * the wallet paid nothing, and on this chain 38 of 40 sampled router-fed
       * recipients were funded by someone else.
       *
       * The index consulted here is built from RECEIPTS, not from transfers to
       * a pool. Asking whether the wallet itself sent a pricing asset to a pool
       * rejected 39 of 40 decoded buys, all of which had paid, because the
       * normal path on this chain is native ETH to a router, the router wraps
       * it, and the POOL receives WETH from the router.
       *
       * A SELL needs no such test: the wallet gave up the token itself.
       */
      if (side === 'buy' && payments !== null
          && !payments.has(`${group.txHash}:${wallet}`)) {
        stats.buysWithNoPayment += 1;
        continue;
      }
      candidates.push({
        wallet, side, raw: gotRaw > 0n ? gotRaw : gaveRaw,
      });
    }
    stats.candidateWallets += candidates.length;

    const totalRaw = candidates.reduce((sum, c) => sum + c.raw, 0n);
    if (totalRaw === 0n) continue;

    for (const c of candidates) {
      legs.push({
        wallet: c.wallet, side: c.side, raw: c.raw,
        txHash: group.txHash, pool: representativePool, counterparty: group.counterparty,
        block: group.block, timestamp: group.timestamp,
        groupTotalRaw: totalRaw,
        groupUsd: group.usd === null || group.usdIncomplete ? null : group.usd,
      });
    }
  }
  return { legs, stats };
}

export function buildRows(
  swaps: { swap: SwapLog; pool: PoolRow }[],
  transfers: TransferLog[],
  cfg: RowConfig,
  tokenDecimals: number,
  counterUsd: CounterUsdResolver,
  exclusions: Set<string>,
  knownPools: Set<string>,
  payments: PaymentIndex | null,
  /** Null accepts every wallet -- used by the cohort builder, which is deciding
   *  membership rather than filtering by it. */
  cohort: Set<string> | null,
): { rows: WalletRow[]; stats: RowStats } {
  const { legs, stats } = tradeLegs(
    swaps, transfers, cfg, counterUsd, exclusions, knownPools, payments,
  );
  const rows: WalletRow[] = [];

  for (const leg of legs) {
    if (cohort !== null && !cohort.has(leg.wallet)) {
      stats.rowsOutsideCohort += 1;
      continue;
    }
    const tokenAmount = formatUnits(leg.raw, tokenDecimals);
    if (Number(tokenAmount) < cfg.floors.tokenAmount) {
      stats.rowsBelowTokenAmountFloor += 1;
      continue;
    }
    const share = Number(leg.raw) / Number(leg.groupTotalRaw);
    const usd = leg.groupUsd === null ? null : leg.groupUsd * share;
    // A null-USD row is unpriced, not small. The USD floor must not touch it.
    if (usd !== null && usd < cfg.floors.usd) {
      stats.rowsBelowUsdFloor += 1;
      continue;
    }
    if (usd === null) {
      stats.rowsWithNullUsd += 1;
      stats.nullUsdBecauseNoBucketPrice += 1;
    }
    const amountNumber = Number(tokenAmount);
    rows.push({
      wallet: leg.wallet, side: leg.side, txHash: leg.txHash, pool: leg.pool,
      counterparty: null,
      blockTime: new Date(leg.timestamp * 1000), blockNumber: leg.block,
      tokenAmount, usdAmount: usd,
      priceUsd: usd !== null && amountNumber > 0 ? usd / amountNumber : null,
    });
  }
  return { rows, stats };
}

/**
 * TRANSFERS THAT ARE NOT TRADES.
 *
 * A cohort wallet can gain or lose the token without a swap -- someone sends it
 * some, it moves funds between its own addresses, it is paid a referral. Those
 * movements change a position and must be recorded, or the position is wrong:
 * 2,682 PONS cohort wallets show a NEGATIVE position, having sold more than
 * they bought, purely because acquisition off the market was never written.
 * That is what the inflated-pnl flag exists to mark, and it is a symptom of
 * this gap rather than a fact about those wallets.
 *
 * A transfer becomes a row only when it is NOT part of a trade for that wallet
 * in that transaction. Otherwise the same movement is counted twice, once as a
 * buy and once as a transfer_in, and every position doubles.
 *
 * A transfer row carries a NULL usd_amount, always. It is an acquisition or a
 * disposal at an unknown cost, and that is exactly what null means -- pricing
 * it at the market rate would invent a basis the wallet never paid.
 */
export function buildTransferRows(
  transfers: TransferLog[],
  legs: TradeLeg[],
  cfg: RowConfig,
  tokenDecimals: number,
  exclusions: Set<string>,
  knownPools: Set<string>,
  cohort: Set<string> | null,
): { rows: WalletRow[]; skippedBecauseTraded: number; skippedBelowFloor: number } {
  const traded = new Set(legs.map((l) => `${l.txHash}:${l.wallet}`));
  const rows: WalletRow[] = [];
  let skippedBecauseTraded = 0;
  let skippedBelowFloor = 0;

  for (const t of transfers) {
    const sides: readonly (readonly [string, 'transfer_in' | 'transfer_out'])[] = [
      [t.to, 'transfer_in'],
      [t.from, 'transfer_out'],
    ];
    for (const [wallet, side] of sides) {
      if (exclusions.has(wallet) || knownPools.has(wallet)) continue;
      if (cohort !== null && !cohort.has(wallet)) continue;
      if (traded.has(`${t.txHash}:${wallet}`)) {
        skippedBecauseTraded += 1;
        continue;
      }
      const amount = formatUnits(t.amount, tokenDecimals);
      if (Number(amount) < cfg.floors.tokenAmount) {
        skippedBelowFloor += 1;
        continue;
      }
      rows.push({
        wallet,
        side,
        txHash: t.txHash,
        // A transfer has no pool. The unique key treats nulls as not distinct,
        // so the counterparty is what separates two transfers in one tx.
        pool: null,
        counterparty: side === 'transfer_in' ? t.from : t.to,
        blockTime: new Date(t.timestamp * 1000),
        blockNumber: t.block,
        tokenAmount: amount,
        usdAmount: null,
        priceUsd: null,
      });
    }
  }
  return { rows, skippedBecauseTraded, skippedBelowFloor };
}
