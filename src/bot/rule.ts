/**
 * THE ONE IMPLEMENTATION of the entry rule, position sizing and the slippage bound.
 *
 * Nothing else decides whether a launch qualifies, how large the position is, or what
 * bound protects it. ROBINHOOD.md records five occasions where two implementations of
 * one rule drifted, most recently with the weaker copy in the running path.
 *
 * THE LAUNCHPAD IS THE PRIMARY FILTER. THE FEE TIER IS A SANITY CHECK ONLY.
 * They are collinear today -- fee=10000 is essentially always one launchpad and fee=500
 * essentially always direct creation -- but the launchpad is what decayed: its share of
 * rule pools fell 73.3% to 28.8% across the test windows while its median return fell
 * +0.296 to +0.056. A fee-only filter breaks silently the moment a launchpad changes
 * its default. The tier is recorded on every trade so the collinearity can be watched.
 *
 * As of 2026-09-16 the tier also carries a narrow allow-list, added because the same
 * launchpad that emits the productive tiers ALSO emits pools at fee=803369, and all
 * three of those in dry run 1 reverted. That check rejects a known-bad tail; it does
 * not select launches, and removing the launchpad filter in favour of it would be the
 * silent break described above.
 */
import {
  ALLOWED_FEES, GAP_MAX_BLOCKS, GAP_MIN_BLOCKS, LAUNCHPADS, RAILS, SLIPPAGE_BPS,
} from './config.js';

export interface LaunchCandidate {
  poolId: string;
  launchpad: string | null;
  fee: number;
  tickSpacing: number;
  hooks: string;
  initBlock: number;
  firstSwapBlock: number | null;
  counterIsPricingAsset: boolean;
}

export interface Verdict { qualifies: boolean; reasons: string[] }

/** Every rejection reason is returned, never just the first, so the log explains itself. */
export function qualifies(c: LaunchCandidate): Verdict {
  const reasons: string[] = [];
  if (!c.counterIsPricingAsset) reasons.push('counter is not a recognised pricing asset');
  if (c.firstSwapBlock === null) reasons.push('no first swap yet');
  else {
    const gap = c.firstSwapBlock - c.initBlock;
    if (gap < GAP_MIN_BLOCKS) reasons.push(`gap ${gap} < ${GAP_MIN_BLOCKS}`);
    if (gap > GAP_MAX_BLOCKS) reasons.push(`gap ${gap} > ${GAP_MAX_BLOCKS}`);
  }
  const pad = (c.launchpad ?? '').toLowerCase();
  if (!LAUNCHPADS.some((l) => l.toLowerCase() === pad)) {
    reasons.push(`launchpad ${c.launchpad ?? 'unknown'} not in the list`);
  }
  /*
   * THE FEE SANITY CHECK, secondary to the launchpad and never a substitute for it.
   * An allow-list rather than a bound, because the tail that has to be rejected is a
   * factory walking the fee integer in steps of 10 just under any round threshold.
   * Provenance and the measured alternative are in config.ts on ALLOWED_FEES.
   */
  if (!ALLOWED_FEES.includes(c.fee)) {
    reasons.push(`fee ${c.fee} is not one of ${ALLOWED_FEES.join(', ')}`);
  }
  return { qualifies: reasons.length === 0, reasons };
}

/**
 * Position size in wei. Hard-capped, and the cap is the rail rather than a suggestion.
 * A missing ETH price RAISES: sizing a trade against an unknown rate is how a $10
 * position becomes an unintended one.
 */
export function positionWei(ethUsd: number): bigint {
  if (!Number.isFinite(ethUsd) || ethUsd <= 0) {
    throw new Error(`cannot size a position without an ETH/USD rate (got ${ethUsd})`);
  }
  const eth = RAILS.MAX_POSITION_USD / ethUsd;
  return BigInt(Math.floor(eth * 1e18));
}

/**
 * The bound OUR trade carries, on BOTH legs. See config.SLIPPAGE_BPS for the
 * derivation from measured p90 slippage plus observed per-tick drift.
 */
export function minOut(expectedOut: bigint): bigint {
  if (expectedOut <= 0n) throw new Error('expected output must be positive to bound it');
  const out = (expectedOut * BigInt(10000 - SLIPPAGE_BPS)) / 10000n;
  /* Never zero, whatever rounding does to a tiny quote. */
  return out > 0n ? out : 1n;
}

/** Expected output from the pool's last traded price. A quote, never a guarantee. */
export function expectedOut(amountIn: bigint, lastPriceOutPerIn: number): bigint {
  if (!Number.isFinite(lastPriceOutPerIn) || lastPriceOutPerIn <= 0) {
    throw new Error('no usable last price for this pool; refusing to quote');
  }
  return BigInt(Math.floor(Number(amountIn) * lastPriceOutPerIn));
}
