/**
 * Every safety rail, hard-coded. docs/LAUNCHBOT.md section 4.
 *
 * THESE ARE NOT CONFIGURATION AND MUST NOT BECOME CONFIGURATION. ROBINHOOD.md records
 * that monitor options are persisted into `monitors.config`, so a YAML value is a
 * database value and a database value is editable by anything with a connection. A
 * limit that can be loosened without a code review, a build and a deploy is not a limit.
 */

/** The verified execution path. See LAUNCHBOT.md section 2. */
export const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3';
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/**
 * Launchpads the rule fires on. PRIMARY FILTER -- see LAUNCHBOT.md section 3.
 *
 * READ FROM `v4_pool_creator`, NOT TRANSCRIBED. The first build carried
 * `0x58daec3116aa2cc3c60f7c1bdf9c895f7d1d0e35`, whose leading twelve characters came
 * from a truncated `0x58daec3116aa...` in this project's own notes and whose remaining
 * twenty-eight were INVENTED. It matched nothing, so every launch was rejected with
 * "launchpad not in the list" and the bot would have traded none of them -- the
 * fabricated-constant failure ROBINHOOD.md records for a topic hash, repeated with an
 * address. A truncation in a document is not an identifier.
 */
export const LAUNCHPADS = [
  /** 1,580 of the rule pools measured. */
  '0x58daec3116aae6d93017baaea7749052e8a04fa7',
  /** 726 -- direct creation against the PoolManager itself. */
  POOL_MANAGER,
] as const;

/** Fee tiers, RECORDED but never depended on: collinear with the launchpad today. */
export const FEE_TIERS_OBSERVED = [500, 10000] as const;

/**
 * THE FEE SANITY CHECK. An ALLOW-LIST, not a magnitude bound, and the data is the
 * reason it is not a bound.
 *
 * MEASURED 2026-09-16 on 1,070 rule-qualifying launches whose Initialize target is
 * one of `LAUNCHPADS`, in blocks 63,216,393..64,216,393. The launchpad attribution
 * cost 752 `eth_getTransactionByHash` reads -- 11,280 CU, $0.00508. "Exit available"
 * is at least one swap in the pool between +150 and +450 blocks of the first swap,
 * which is the window this bot would have to sell into.
 *
 *   allow-list {100,500,10000}   n=574  53.6% of pop   exit 88.3%   median +0.144
 *   bound fee <= 10000           n=696  65.0% of pop   exit 76.7%   median +0.100
 *
 * THE BOUND IS WORSE THAN THE ALLOW-LIST, which is the finding. The 122 extra pools
 * a `<= 10000` bound admits are dominated by two arithmetic runs from a single
 * launchpad -- 9111,9121,...,9841 and 10881,10891,...,11201, each stepping by 10,
 * one pool per tier, and ZERO of the 33 in the second run had an exit available.
 * A factory that walks the fee integer cannot be separated by magnitude, because it
 * deliberately sits just under whatever round number a bound would pick. Membership
 * of the three tiers real launchpads actually use is what separates them.
 *
 * WHY 100 IS IN THE LIST despite not appearing in `FEE_TIERS_OBSERVED`: it is the
 * third real tier, n=58, exit 86.2%, median +0.150 -- indistinguishable from 500 and
 * 10000 and clearly unlike the tail. It was absent from the earlier figure only
 * because `v4_pool_creator` was itself fee-filtered; see LAUNCHBOT.md section 7.
 *
 * THIS IS A SANITY CHECK, NOT THE RULE. The launchpad remains the primary filter.
 * This exists to reject the fee=803369 pools that launchpad `0x58daec...` also
 * emits, all three of which reverted in dry run 1.
 */
export const ALLOWED_FEES: readonly number[] = [100, 500, 10000];

export const RAILS = {
  /** Operator-approved 2026-09-16. */
  MAX_POSITION_USD: 10,
  /** $50 of $100 at risk, leaving headroom for a stuck exit. */
  MAX_CONCURRENT: 5,
  /** ~8% of the 485/day available in the SELLOFF window. A bounded first exposure. */
  MAX_TRADES_PER_DAY: 40,
  /** 15% of the $100 capital. Halts for the day. */
  MAX_DAILY_LOSS_USD: 15,
  /** A broken calldata shape shows up as reverts and must stop at once. */
  MAX_CONSECUTIVE_REVERTS: 3,
} as const;

/**
 * THE SLIPPAGE BOUND, AND IT IS OURS RATHER THAN THEIRS.
 *
 * Measured: `amountOutMinimum` was 0 in 9 of 9 native-ETH buys observed on this chain.
 * Those buyers take NO protection. That is not copied -- an unprotected buy into a pool
 * that moves against us is how a $10 position becomes $3.
 *
 * Derivation, from figures already in LAUNCHBOT.md section 1:
 *   p90 ROUND-TRIP slippage at $10   1.085% HOLDOUT / 0.350% CALM / 0.549% SELLOFF
 *   per leg, roughly half            0.18% .. 0.54%
 *   observed per-tick price movement ~0.8%  (~30 ticks carrying +27% over 450 blocks)
 *   detection runs at 5 s, so several ticks can pass between the last observed trade
 *   and ours landing -- allow three
 *     0.54% + 3 x 0.8% = 2.94%  ->  300 bps
 *
 * IT IS A FIRST VALUE, NOT A MEASUREMENT OF ITSELF. Every trade logs its realised
 * slippage precisely so this can be re-derived from live data rather than argued.
 */
export const SLIPPAGE_BPS = 300;

/**
 * THE MINIMUM CONSECUTIVE SWAPS NEEDED TO MEASURE A POOL'S DEPTH.
 *
 * Impact is the median fractional price move per unit of notional across CONSECUTIVE
 * observed swaps, so n swaps give n-1 pairs and a median over fewer than three pairs is
 * one or two numbers wearing a median's name. Three is the smallest count at which the
 * median is not simply an observation — it is the first value where a single degenerate
 * tick cannot BE the answer, which is the property `ROBINHOOD.md` chooses medians for.
 *
 * **A pool below this is REFUSED, not quoted linearly.** The linear quote is the defect
 * being fixed; falling back to it exactly where the pool is thinnest would reinstate it
 * in the worst case. The count of launches refused for this reason is reported on every
 * run, so the cost of the refusal is visible rather than inferred.
 */
export const IMPACT_MIN_OBSERVATIONS = 3;

/**
 * EXIT RETRY. An exit that reverts leaves the bot holding a token with no way out,
 * which is the worst outcome available to it — worse than a bad fill, because a
 * position that cannot be sold is not a loss of some size, it is an unbounded one.
 *
 * EVERY NUMBER HERE IS DERIVED FROM THE 11 DECODED ENTRY REVERTS OF 2026-09-16, not
 * picked. `revert-decode` established that 11 of 12 dry-run reverts were
 * `V4TooLittleReceived(uint256,uint256)` — the v4 router reporting that OUR OWN
 * `amountOutMinimum` rejected the trade — and the error's two words state what bound
 * would have cleared. The measured distribution of (our bound / what the pool would
 * actually have paid):
 *
 *     min 1.0151   p25 1.0406   median 1.2248   p75 2.5432   p90 13.70   max 31.71
 *
 * which is an implied one-leg slippage of 1.49% / 3.90% / 18.35% / 60.7% / 92.7% / 96.85%.
 *
 * THE LADDER IS THOSE QUANTILES, IN ORDER. Each attempt clears the cases up to its own
 * quantile and no more, so the schedule is the data rather than a doubling:
 *
 *     attempt 1   300 bps   the configured bound (p90 round-trip slippage + drift)
 *     attempt 2   400 bps   the measured p25 shortfall, 3.90%, rounded up
 *     attempt 3 1,835 bps   the measured MEDIAN shortfall — half of all observed
 *                           rejections clear here
 *     attempt 4 6,070 bps   the measured p75 shortfall — the last rung worth climbing
 *
 * **IT STOPS AT THE p75 DELIBERATELY.** The p90 is 92.7%, which is indistinguishable
 * from giving the tokens away, and the measured median gross return at the horizons
 * this bot trades is +16% (recent era) to +56% (corpus era) — so a bound past the p75
 * guarantees a loss larger than the position's whole expected gain. A rung that can
 * only ever turn a small loss into a total one is not a rescue.
 *
 * **n IS 11.** That is a thin base for a four-rung ladder and it is stated rather than
 * buried; these values are a first schedule to be re-derived from logged live exits,
 * exactly as SLIPPAGE_BPS is.
 *
 * THE INTERVAL IS 5 SECONDS, from the measured median exit fill delay of 1.1–4.5 s
 * across all ten horizons in the 2026-09-16 grid: long enough that a new trade has
 * landed and the quote has genuinely moved, so a retry is a fresh attempt rather than
 * the same one repeated. Four attempts therefore complete within ~15 s.
 */
export const EXIT_RETRY = {
  MAX_ATTEMPTS: 4,
  INTERVAL_MS: 5000,
  /** One bound per attempt. Length MUST equal MAX_ATTEMPTS; asserted at load. */
  BOUND_BPS: [300, 400, 1835, 6070],
} as const;

if (EXIT_RETRY.BOUND_BPS.length !== EXIT_RETRY.MAX_ATTEMPTS) {
  /* A ladder shorter than the attempt count would silently reuse its last rung. */
  throw new Error(`EXIT_RETRY.BOUND_BPS has ${EXIT_RETRY.BOUND_BPS.length} rungs for `
    + `${EXIT_RETRY.MAX_ATTEMPTS} attempts`);
}

/** Entry at +15 s, at the measured 0.1 s block time. */
export const BLOCKS_PER_SECOND = 10;
export const ENTRY_DELAY_BLOCKS = 15 * BLOCKS_PER_SECOND;

/**
 * THE EXIT HORIZON. CHANGED 2026-09-16 FROM +30 s TO +90 s, on operator approval, on
 * holdout evidence. This is a DECISION ON MEASURED EVIDENCE, not a tuned constant, and
 * the distinction matters enough to record here rather than only in the document.
 *
 * WHAT IT WAS: 30 s (300 blocks), inherited from the offline backtest's best cell.
 * WHAT IT IS:  90 s (900 blocks).
 *
 * THE EVIDENCE. `exit-horizon` swept ten horizons out to +600 s across all four swept
 * windows, on the pre-committed `md5(pool_id)` split that `launch-search.ts` fixed
 * before any hypothesis was formed (`bot/holdout.ts`). Per window and per half, with
 * no-fill and no-exit scored zero over EVERY rule launch:
 *
 *   window     half      +30 s    +90 s    +180 s
 *   MIDPOINT   search    0.000    0.022    0.002
 *   MIDPOINT   holdout   0.001    0.008    0.000
 *   CALM       search    0.164    0.268    0.092
 *   CALM       holdout   0.202    0.323    0.339
 *   SELLOFF    search    0.104    0.204    0.296
 *   SELLOFF    holdout   0.089    0.199    0.372
 *
 * **+90 s beats +30 s in 6 of 6 window×half combinations. +180 s beats it in only 4 of
 * 6**, failing in MIDPOINT on both halves and in CALM on the search half. Pooled across
 * all four windows the peak is +180 s (search 0.674, holdout 0.676, reproducing cell for
 * cell) — but 94.5% of that pooled population is the corpus era, which `ROBINHOOD.md`
 * establishes as the anomaly.
 *
 * **THE BAND'S UPPER END IS UNRESOLVED AT n≈700.** On the recent windows alone the
 * search half peaks at +90 s and the holdout half at +180 s. The two halves disagree
 * about where inside 90–180 s the optimum sits, and at that sample size that
 * disagreement IS the measurement's noise. +90 s is the conservative end of the band —
 * the point that survives everywhere — and is taken for that reason.
 *
 * WHAT WOULD MOVE IT: a window nobody has looked at, or the nightly check reaching its
 * 140-trade minimum on the bot's own trades. `nightly-check` will alert; it cannot and
 * must not write this value.
 */
export const EXIT_DELAY_BLOCKS = 90 * BLOCKS_PER_SECOND;
/** Creation-to-first-swap gap the rule requires. */
export const GAP_MIN_BLOCKS = 11;
export const GAP_MAX_BLOCKS = 600;
/** Detection cadence. 5 s leaves ~10 s to act: the median launch first trades 0.8 s
 *  after creation and entry is +15 s after that. */
export const DETECT_INTERVAL_MS = 5000;
/** Prices are backfilled at these offsets from ENTRY regardless of when we exited,
 *  so the optimal hold can be re-derived from live data (LAUNCHBOT.md section 5). */
export const BACKFILL_OFFSETS_S = [30, 60, 120, 300] as const;
