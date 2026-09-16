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
 * TWO TERMS, AND THE EXACT ONE TURNED OUT TO BE THE BIG ONE
 * ---------------------------------------------------------------------------
 *
 * The first version of this file carried the impact term alone, on the reasoning that
 * linear extrapolation was what the reverts proved wrong. `quote-check` measured it
 * against ground truth and **the reasoning was right and the term was the wrong one**:
 *
 *     measured impact           median 0.17%   p90 0.37%
 *     measured OVER-QUOTE       median 2.50%   p90 16.0%   97.4% of trades over-quoted
 *
 * Impact is an order of magnitude too small to explain the shortfall. **The missing
 * term was the pool's OWN LP FEE**, which is taken off every swap before anything else
 * and is stated exactly in the pool key we already carry: `fee` is in hundredths of a
 * basis point, so 10000 is 1% and 500 is 0.05%. On a 1% pool the last realised price
 * already implies 1% more output than a trader can get, every time, deterministically.
 *
 * So the quote is `linear x (1 - fee) x (1 - impact)`:
 *
 *   - **the FEE term is EXACT** — read from the pool key, no estimation, no observations
 *     needed, and it is the dominant correction;
 *   - **the IMPACT term is MEASURED** — small, real, and the only thing that catches a
 *     pool where our own size is the problem (one pool measured 47.4%).
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
 * - **Too few observations to measure depth: the FEE term still applies and the impact
 *   term is reported as UNMEASURED.** The first version raised here, and `quote-check`
 *   showed that refusing **26 of 40** trades to avoid a 0.17%-median correction is a
 *   worse outcome than the defect. The argument that a fallback reinstates the defect
 *   was about falling back to the FULLY linear quote; falling back to a quote carrying
 *   the exact fee — the dominant term — is a different thing, and the measurement is
 *   what separates them. **The basis is on every quote and is counted per run**, so a
 *   run where most quotes are fee-only is visible rather than inferred.
 * - **Impact at or above 1: it RAISES.** If our own trade is modelled to move the price
 *   by 100% the honest answer is that this pool cannot absorb this size, not a quote of
 *   zero. `ROBINHOOD.md`'s standing rule is that an error path emitting a plausible
 *   value is the worst defect shape on this project.
 *
 * Both refusals are COUNTED by the caller and reported, never swallowed — a launch that
 * cannot be quoted is a result, not a silent skip.
 */
import { IMPACT_MIN_OBSERVATIONS } from './config.js';

/**
 * Uniswap's fee unit: hundredths of a basis point. 10000 = 1%, 500 = 0.05%, 100 = 0.01%.
 * `ROBINHOOD.md` records the Initialize event's `fee` word directly, so this is the
 * pool's own declared fee and not a figure anybody chose.
 */
const FEE_DENOMINATOR = 1_000_000;

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
  /** What we expect to receive, fee and impact included. This is the number to bound. */
  expectedOut: bigint;
  /** The old linear quote, kept so the correction is visible rather than implied. */
  linearOut: bigint;
  /** The pool's own declared fee, as a fraction. EXACT. */
  feeFraction: number;
  /** The measured price impact of our own size, as a fraction. 0 when unmeasured. */
  impactFraction: number;
  /**
   * `fee+impact` when the pool had enough observations, `fee-only` when it did not.
   * Counted per run so a run dominated by fee-only quotes is visible.
   */
  basis: 'fee+impact' | 'fee-only';
  depth: Depth | null;
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
  /** The pool's DECLARED fee, in hundredths of a basis point, from its own pool key. */
  fee: number;
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

  /*
   * THE FEE, FIRST AND EXACTLY. Taken off every swap before any curve arithmetic, and
   * stated in the pool key, so it needs no observation and admits no estimate.
   */
  if (!Number.isFinite(p.fee) || p.fee < 0 || p.fee >= FEE_DENOMINATOR) {
    throw new Error(`pool fee ${p.fee} is not a usable fraction of ${FEE_DENOMINATOR}; `
      + 'refusing to quote rather than assuming a tier');
  }
  const feeFraction = p.fee / FEE_DENOMINATOR;

  const depth = poolDepth(p.ticks);
  const impactFraction = depth === null
    ? 0
    : depth.impactPerNotional * (p.side === 'buy' ? Number(p.amountIn) : linear);

  if (!Number.isFinite(impactFraction) || impactFraction < 0) {
    throw new Error(`impact is not a usable number (${impactFraction}); refusing to quote`);
  }
  if (impactFraction >= 1) {
    throw new Error(`this size is modelled to move the pool ${(impactFraction * 100)
      .toFixed(1)}% — at or past 100%. The pool cannot absorb it, and a quote of zero `
      + 'would be a plausible value on an error path rather than an answer');
  }

  const out = BigInt(Math.floor(linear * (1 - feeFraction) * (1 - impactFraction)));
  if (out <= 0n) {
    throw new Error(`corrected quote rounds to ${out}; refusing to bound it`);
  }
  return {
    expectedOut: out,
    linearOut: BigInt(Math.floor(linear)),
    feeFraction,
    impactFraction,
    basis: depth === null ? 'fee-only' : 'fee+impact',
    depth,
  };
}
