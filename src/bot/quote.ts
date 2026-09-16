/**
 * THE ONE QUOTE. Entry, exit, the retry ladder and the dry run all call `quote()`;
 * nothing else converts a size into an expected output. A change here is a change to
 * all four, which is the point.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: THE OLD QUOTE HAD NO PRICE-IMPACT TERM AND THAT CAUSED THE REVERTS
 * ---------------------------------------------------------------------------
 *
 * `expectedOut` was `amountIn x lastPrice` — the pool's most recent realised price,
 * extrapolated linearly to our size. `revert-decode` measured what that cost:
 * **11 of 12 dry-run reverts were `V4TooLittleReceived(uint256,uint256)`**, the v4
 * router reporting that OUR OWN `amountOutMinimum` rejected the trade, with a measured
 * distribution of (our bound / what the pool would actually pay):
 *
 *     min 1.0151   p25 1.0406   median 1.2248   p75 2.5432   p90 13.70   max 31.71
 *
 * A first trade of a few dollars sets a price; our $10 against the same liquidity moves
 * it far more than that price implies. The bound was never the cause — the quote was.
 *
 * ---------------------------------------------------------------------------
 * THE IMPACT TERM, DERIVED FROM THE POOL'S OWN SWAPS
 * ---------------------------------------------------------------------------
 *
 * **Reserves cannot be read.** `ROBINHOOD.md` establishes it: a v4 pool has no contract
 * of its own, the PoolManager holds every pool's liquidity in one balance, and no
 * reserve figure is stored anywhere. So impact is measured the same way that document
 * measured slippage — **every observed swap is a trade of known size that moved the
 * price by a known amount**, and the ratio of those two is the pool's depth:
 *
 *     for consecutive swaps i-1, i on this pool:
 *         relMove_i = | price_i / price_{i-1} - 1 |
 *         impact_i  = relMove_i / notional_i        (fractional move per raw unit)
 *
 * and our expected impact is `median(impact_i) x ourNotional`.
 *
 * **THE MEDIAN, NEVER THE MEAN.** `ROBINHOOD.md` measures 111 of 120,060 launch pools
 * spanning more than 10^6 in price — 0.092% — and records that they take a cell mean to
 * 1.06e24 while moving the median by 0.0001. One degenerate tick in a young pool's first
 * seconds would otherwise set the quote for the whole trade.
 *
 * **`notional` IS ALWAYS THE PRICING-ASSET SIDE**, for both directions, so a buy and a
 * sell are measured in the same unit and one median serves both. Mixing the token side
 * in would compare quantities whose scale differs by the price itself.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES TO DO, AND WHY REFUSING IS THE POINT
 * ---------------------------------------------------------------------------
 *
 * - **Too few observations to measure depth: it RAISES.** It does NOT fall back to the
 *   linear quote, because the linear quote is the defect being fixed and a silent
 *   fallback would reinstate it exactly where the pool is thinnest. A pool that has not
 *   traded enough to be measured is a pool we cannot size a trade into.
 * - **Impact at or above 1: it RAISES.** If our own trade is modelled to move the price
 *   by 100% the honest answer is that this pool cannot absorb this size, not a quote of
 *   zero. `ROBINHOOD.md`'s standing rule is that an error path emitting a plausible
 *   value is the worst defect shape on this project.
 *
 * Both refusals are COUNTED by the caller and reported, never swallowed — a launch that
 * cannot be quoted is a result, not a silent skip.
 */
import { IMPACT_MIN_OBSERVATIONS } from './config.js';

/** One observed swap on the pool: its price, and the pricing-asset size that moved it. */
export interface PoolTick {
  block: number;
  logIndex: number;
  /** Pricing units per token — the `bot/price.ts` convention, and the only one. */
  price: number;
  /** |pricing-asset side| in RAW units. Always the counter side, never the token. */
  notional: number;
}

export interface Depth {
  /** Median fractional price move per raw notional unit. */
  impactPerNotional: number;
  /** Consecutive pairs the median was taken over. */
  observations: number;
}

export interface QuoteResult {
  /** What we expect to receive, impact included. This is the number to bound. */
  expectedOut: bigint;
  /** The old linear quote, kept so the correction is visible rather than implied. */
  linearOut: bigint;
  /** The haircut applied, 0..1. */
  impactFraction: number;
  depth: Depth;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) / 2;
  return s.length % 2 ? s[i]! : (s[Math.floor(i)]! + s[Math.ceil(i)]!) / 2;
}

/**
 * The pool's depth, from consecutive observed swaps. Ticks must be in chain order.
 * Returns null when there are not enough usable pairs — the caller decides, and the
 * only caller (`quote`) refuses.
 */
export function poolDepth(ticks: PoolTick[]): Depth | null {
  const impacts: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const prev = ticks[i - 1]!;
    const cur = ticks[i]!;
    /* A zero or non-finite side cannot produce a ratio. Skipped, never defaulted. */
    if (!(prev.price > 0) || !(cur.price > 0) || !(cur.notional > 0)) continue;
    const rel = Math.abs(cur.price / prev.price - 1);
    if (!Number.isFinite(rel)) continue;
    const per = rel / cur.notional;
    if (!Number.isFinite(per) || per < 0) continue;
    impacts.push(per);
  }
  if (impacts.length < IMPACT_MIN_OBSERVATIONS) return null;
  return { impactPerNotional: median(impacts), observations: impacts.length };
}

export interface QuoteParams {
  /** What we are putting in, in raw units of the input currency. */
  amountIn: bigint;
  /** Output per input, in raw units — `bot/price.ts` `quoteRate` for a buy. */
  rateOutPerIn: number;
  /** Which leg. Decides which side of the trade carries the notional. */
  side: 'buy' | 'sell';
  /** The pool's observed swaps, in chain order, at quote time. */
  ticks: PoolTick[];
}

/**
 * THE QUOTE. Linear extrapolation minus the pool's own measured impact.
 */
export function quote(p: QuoteParams): QuoteResult {
  if (!Number.isFinite(p.rateOutPerIn) || p.rateOutPerIn <= 0) {
    throw new Error('no usable last price for this pool; refusing to quote');
  }
  if (p.amountIn <= 0n) throw new Error('cannot quote a non-positive input');

  const linear = Number(p.amountIn) * p.rateOutPerIn;
  if (!Number.isFinite(linear) || linear <= 0) {
    throw new Error(`linear quote is not a usable number (${linear}); refusing to quote`);
  }

  const depth = poolDepth(p.ticks);
  if (depth === null) {
    throw new Error(`pool has fewer than ${IMPACT_MIN_OBSERVATIONS} usable consecutive `
      + `swaps (${p.ticks.length} ticks); its depth cannot be measured and this quote `
      + 'will NOT fall back to the linear one that caused 11 of 12 reverts');
  }

  /*
   * THE NOTIONAL IS THE PRICING-ASSET SIDE OF OUR OWN TRADE.
   * On a buy we spend it, so it is `amountIn`. On a sell we receive it, so the linear
   * output is the best available estimate of it — a first-order correction, which is
   * what this whole term is.
   */
  const ourNotional = p.side === 'buy' ? Number(p.amountIn) : linear;
  const impactFraction = depth.impactPerNotional * ourNotional;

  if (!Number.isFinite(impactFraction) || impactFraction < 0) {
    throw new Error(`impact is not a usable number (${impactFraction}); refusing to quote`);
  }
  if (impactFraction >= 1) {
    throw new Error(`this size is modelled to move the pool ${(impactFraction * 100)
      .toFixed(1)}% — at or past 100%. The pool cannot absorb it, and a quote of zero `
      + 'would be a plausible value on an error path rather than an answer');
  }

  const out = BigInt(Math.floor(linear * (1 - impactFraction)));
  if (out <= 0n) {
    throw new Error(`impact-corrected quote rounds to ${out}; refusing to bound it`);
  }
  return {
    expectedOut: out,
    linearOut: BigInt(Math.floor(linear)),
    impactFraction,
    depth,
  };
}
