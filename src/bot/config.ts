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

/** Entry at +15 s, exit at +45 s, at the measured 0.1 s block time. */
export const BLOCKS_PER_SECOND = 10;
export const ENTRY_DELAY_BLOCKS = 15 * BLOCKS_PER_SECOND;
export const EXIT_DELAY_BLOCKS = 30 * BLOCKS_PER_SECOND;
/** Creation-to-first-swap gap the rule requires. */
export const GAP_MIN_BLOCKS = 11;
export const GAP_MAX_BLOCKS = 600;
/** Detection cadence. 5 s leaves ~10 s to act: the median launch first trades 0.8 s
 *  after creation and entry is +15 s after that. */
export const DETECT_INTERVAL_MS = 5000;
/** Prices are backfilled at these offsets from ENTRY regardless of when we exited,
 *  so the optimal hold can be re-derived from live data (LAUNCHBOT.md section 5). */
export const BACKFILL_OFFSETS_S = [30, 60, 120, 300] as const;
