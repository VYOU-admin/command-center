/**
 * Prices, derived from the token itself.
 *
 * There is no ETH/USD feed in this system. A token/USDG swap gives the token in
 * dollars, a token/WETH swap gives it in ETH, and the ratio of the two is
 * ETH/USD. Same technique the Solana procedure uses for SOL.
 *
 * BUCKETED MEDIANS, NOT PER-TICK PAIRING. Both series are bucketed by block
 * (10,000 blocks is about 17 minutes on this chain), the median of each side is
 * taken per bucket, and the medians are divided. A single bad tick cannot move a
 * median; pairing individual ticks lets it straight through.
 *
 * GAPS STAY GAPS. A bucket with no USDG trade produces no price, and swaps
 * landing in it store a NULL usd_amount. Nothing is interpolated and nothing is
 * carried forward. Of 4,655 buckets across PONS's life, 62 had no price, and
 * those 62 are the honest answer for that period.
 *
 * WHY THE CURSOR LANDS ON A BUCKET BOUNDARY. A run that ended mid-bucket would
 * write rows priced from a partial bucket, and the completed bucket computed by
 * the next run would never be applied to them. Clamping the cursor to a boundary
 * means every row written falls inside a bucket this run saw in full.
 */

/** The configuration price derivation needs, narrow enough for both callers. */
export interface PriceConfig {
  chain: string;
  usdAsset: string;
  nativeAssets: string[];
  bucketBlocks: number;
  bucketOrigin: number;
  tickFenceMultiple: number;
  nativeFenceMultiple: number;
  tokenUsdTable: string;
  nativeUsdTable: string;
}
import type { SwapLog } from './decode.js';
import type { PoolRow } from './pools.js';
import { abs, median, toNumber } from './units.js';
import type { PoolClient } from '../../store/db.js';

export interface PriceSeries {
  /** bucket start block -> token price in USD */
  tokenUsd: Map<number, { price: number; ticks: number }>;
  /** bucket start block -> native asset price in USD */
  nativeUsd: Map<number, { price: number; usdTicks: number; ethTicks: number }>;
  stats: {
    bucketsSeen: number;
    /** Buckets only partly inside the range read, so deliberately not written. */
    bucketsPartial: number;
    tokenUsdTicks: number;
    tokenUsdDiscarded: number;
    tokenNativeTicks: number;
    tokenNativeDiscarded: number;
    nativeDerived: number;
    nativeDiscarded: number;
    bucketsWithoutUsdSide: number;
    bucketsWithoutNativeSide: number;
  };
}

/**
 * The bucket a block falls in, anchored at `origin`.
 *
 * The anchor matters. This token's stored buckets are anchored at its first
 * swap block, so they all sit at `... 3150`. A function anchored at zero
 * produces boundaries 3,150 blocks away from every stored one -- lookups match
 * nothing and writes land between the existing rows rather than on them.
 */
export const bucketOf = (block: number, size: number, origin = 0): number =>
  origin + Math.floor((block - origin) / size) * size;

/**
 * Median of a bucket's ticks, discarding anything outside `fence` times the
 * first-pass median. Returns the count discarded so it can be reported: a fence
 * that silently drops half its input is a defect, and one that drops nothing is
 * the signal the derivation is sound.
 */
function fencedMedian(
  ticks: number[],
  fence: number,
): { value: number | null; kept: number; discarded: number } {
  const first = median(ticks);
  if (first === null || first <= 0) return { value: null, kept: 0, discarded: ticks.length };
  const lo = first / fence;
  const hi = first * fence;
  const kept = ticks.filter((t) => t >= lo && t <= hi);
  return {
    value: median(kept),
    kept: kept.length,
    discarded: ticks.length - kept.length,
  };
}

function push(into: Map<number, number[]>, key: number, value: number): void {
  const list = into.get(key);
  if (list) list.push(value);
  else into.set(key, [value]);
}

/**
 * @param minCompleteBucket Buckets starting before this were only partly inside
 * the range read, so their median would be computed from a fraction of their
 * ticks. They are skipped entirely rather than written: overwriting a bucket
 * that an earlier run saw in full with a partial recomputation would silently
 * degrade a price that was already correct.
 */
export function derivePrices(
  swaps: { swap: SwapLog; pool: PoolRow }[],
  cfg: PriceConfig,
  tokenDecimals: number,
  reference: number[],
  minCompleteBucket: number,
): PriceSeries {
  const usdAsset = cfg.usdAsset.toLowerCase();
  const nativeAssets = new Set(cfg.nativeAssets.map((a) => a.toLowerCase()));

  const usdTicks = new Map<number, number[]>();
  const nativeTicks = new Map<number, number[]>();
  const buckets = new Set<number>();

  for (const { swap, pool } of swaps) {
    const bucket = bucketOf(swap.block, cfg.bucketBlocks, cfg.bucketOrigin);
    buckets.add(bucket);

    const rawToken = pool.tokenSide === 0 ? swap.amount0 : swap.amount1;
    const rawCounter = pool.tokenSide === 0 ? swap.amount1 : swap.amount0;
    const tokenAmount = toNumber(abs(rawToken), tokenDecimals);
    const counterAmount = toNumber(abs(rawCounter), pool.counterDec);
    if (tokenAmount <= 0 || counterAmount <= 0) continue;

    const tick = counterAmount / tokenAmount;
    if (!Number.isFinite(tick) || tick <= 0) continue;

    if (pool.counter === usdAsset) push(usdTicks, bucket, tick);
    else if (nativeAssets.has(pool.counter)) push(nativeTicks, bucket, tick);
  }

  const tokenUsd = new Map<number, { price: number; ticks: number }>();
  const stats: PriceSeries['stats'] = {
    bucketsSeen: buckets.size,
    bucketsPartial: 0,
    tokenUsdTicks: 0,
    tokenUsdDiscarded: 0,
    tokenNativeTicks: 0,
    tokenNativeDiscarded: 0,
    nativeDerived: 0,
    nativeDiscarded: 0,
    bucketsWithoutUsdSide: 0,
    bucketsWithoutNativeSide: 0,
  };

  const nativeUsd = new Map<number, { price: number; usdTicks: number; ethTicks: number }>();
  const candidates: { bucket: number; price: number; usdTicks: number; ethTicks: number }[] = [];

  for (const bucket of [...buckets].sort((a, b) => a - b)) {
    if (bucket < minCompleteBucket) {
      stats.bucketsPartial += 1;
      continue;
    }
    const u = usdTicks.get(bucket) ?? [];
    const n = nativeTicks.get(bucket) ?? [];
    stats.tokenUsdTicks += u.length;
    stats.tokenNativeTicks += n.length;

    const usd = fencedMedian(u, cfg.tickFenceMultiple);
    const nat = fencedMedian(n, cfg.tickFenceMultiple);
    stats.tokenUsdDiscarded += usd.discarded;
    stats.tokenNativeDiscarded += nat.discarded;

    if (usd.value === null) {
      stats.bucketsWithoutUsdSide += 1;
    } else {
      tokenUsd.set(bucket, { price: usd.value, ticks: usd.kept });
    }
    if (nat.value === null) stats.bucketsWithoutNativeSide += 1;

    if (usd.value !== null && nat.value !== null && nat.value > 0) {
      const derived = usd.value / nat.value;
      if (Number.isFinite(derived) && derived > 0) {
        candidates.push({
          bucket,
          price: derived,
          usdTicks: usd.kept,
          ethTicks: nat.kept,
        });
      }
    }
  }

  /*
   * The native price is fenced against the median of this batch PLUS recently
   * stored values. A run covers only three or four buckets, which is too few to
   * form a trustworthy median on their own -- fencing a batch against itself
   * would let a uniformly wrong batch through unchallenged.
   */
  const referenceMedian = median([...reference, ...candidates.map((c) => c.price)]);
  for (const c of candidates) {
    if (
      referenceMedian !== null &&
      (c.price > referenceMedian * cfg.nativeFenceMultiple ||
        c.price < referenceMedian / cfg.nativeFenceMultiple)
    ) {
      stats.nativeDiscarded += 1;
      continue;
    }
    stats.nativeDerived += 1;
    nativeUsd.set(c.bucket, { price: c.price, usdTicks: c.usdTicks, ethTicks: c.ethTicks });
  }

  return { tokenUsd, nativeUsd, stats };
}

/**
 * Native prices already stored for a span of buckets.
 *
 * Used to price rows that fall in a bucket this run only partly covered: the
 * stored value came from a run that saw the whole bucket, so it is better than
 * anything this run could derive, and it is not rewritten.
 */
export async function loadNativeForRange(
  client: PoolClient,
  table: string,
  chain: string,
  fromBucket: number,
  toBucket: number,
): Promise<Map<number, { price: number }>> {
  const res = await client.query<{ block_number: number; eth_usd: number }>(
    `select block_number, eth_usd from ${table}
      where chain = $1 and block_number >= $2 and block_number <= $3`,
    [chain, fromBucket, toBucket],
  );
  const out = new Map<number, { price: number }>();
  for (const r of res.rows) {
    const price = Number(r.eth_usd);
    if (Number.isFinite(price) && price > 0) out.set(Number(r.block_number), { price });
  }
  return out;
}

/** The last stored native prices, as a fencing reference for a new batch. */
export async function loadNativeReference(
  client: PoolClient,
  table: string,
  chain: string,
  limit = 200,
): Promise<number[]> {
  const res = await client.query<{ eth_usd: number }>(
    `select eth_usd from ${table} where chain = $1 order by block_number desc limit $2`,
    [chain, limit],
  );
  return res.rows.map((r) => Number(r.eth_usd)).filter((v) => Number.isFinite(v) && v > 0);
}

/**
 * Write the derived buckets.
 *
 * `do nothing`, NOT `do update`. A bucket already stored was computed by a run
 * that saw the same whole bucket, so recomputing it gains nothing and rewriting
 * it silently replaces history that was already reviewed. The intake's native
 * series already extends past this job's backlog, so an upsert here would have
 * rewritten roughly 55 existing buckets on the way through -- it rewrote 3
 * before this was caught. The count left alone is returned so it can be
 * reported rather than inferred from a row count that did not move.
 */
export async function persistPrices(
  client: PoolClient,
  cfg: PriceConfig,
  series: PriceSeries,
): Promise<{
  tokenUsdInserted: number;
  tokenUsdAlreadyPresent: number;
  nativeUsdInserted: number;
  nativeUsdAlreadyPresent: number;
}> {
  let tokenUsdInserted = 0;
  for (const [bucket, v] of series.tokenUsd) {
    const res = await client.query(
      `insert into ${cfg.tokenUsdTable} (chain, bucket_block, pons_usd, ticks)
       values ($1, $2, $3, $4)
       on conflict (chain, bucket_block) do nothing`,
      [cfg.chain, bucket, v.price, v.ticks],
    );
    tokenUsdInserted += res.rowCount ?? 0;
  }
  let nativeUsdInserted = 0;
  for (const [bucket, v] of series.nativeUsd) {
    const res = await client.query(
      `insert into ${cfg.nativeUsdTable} (chain, block_number, eth_usd, usd_ticks, eth_ticks)
       values ($1, $2, $3, $4, $5)
       on conflict (chain, block_number) do nothing`,
      [cfg.chain, bucket, v.price, v.usdTicks, v.ethTicks],
    );
    nativeUsdInserted += res.rowCount ?? 0;
  }
  return {
    tokenUsdInserted,
    tokenUsdAlreadyPresent: series.tokenUsd.size - tokenUsdInserted,
    nativeUsdInserted,
    nativeUsdAlreadyPresent: series.nativeUsd.size - nativeUsdInserted,
  };
}
