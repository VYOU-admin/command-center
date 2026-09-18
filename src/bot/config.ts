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
  /**
   * **$1, DOWN FROM $10, OPERATOR-INSTRUCTED 2026-09-17 AFTER THE LIVE RUN LOST $120.**
   *
   * The purpose of the next live test is to OBSERVE SELLING across many tokens at a
   * size where being wrong costs nothing. It is instrumentation, not a profit attempt —
   * and section 6A is explicit that no hold time on the measured population is positive,
   * so a larger size would only buy a more expensive version of the same answer.
   */
  MAX_POSITION_USD: 1,
  /** 5 x $1 = $5 of open basis, and the arming gate is that same $5. */
  MAX_CONCURRENT: 5,
  /**
   * **A PER-RUN CAP, WHICH IS NOT THE SAME RAIL AS THE PER-DAY ONE.**
   * `MAX_TRADES_PER_DAY` bounds a day and survives a restart; this bounds ONE
   * invocation, so a run that is going wrong stops at ten trades whatever the day's
   * budget still allows. The live run made twelve buys in about fifteen minutes with
   * every capital rail blinded — a per-run cap is the one bound that a status bug
   * cannot route around, because it is counted in the process rather than read from a
   * status.
   */
  MAX_TRADES_PER_RUN: 10,
  /**
   * THE HARD CAPITAL CAP. LAUNCHBOT.md section 4.
   *
   * THE BALANCE IS NOT A BUDGET. The arming gate asks whether the wallet can cover
   * `MAX_CONCURRENT x MAX_POSITION_USD` = $50, and that question has no upper side —
   * a wallet holding $5,000 passes it with a factor of a hundred to spare. Nothing
   * else in this bot bounded the total; the "$100 capital approved" in LAUNCHBOT.md
   * section 0 was a sentence in a document, enforced by no code. This is the
   * enforcement.
   *
   * IT IS NOT A RISK CALCULATION. This is the operator's PERSONAL wallet, not an
   * account funded for the bot, and the bot is entitled to a stated amount of it and
   * no more — whatever the wallet happens to hold on any given day. A limit derived
   * from the balance would rise every time the operator was paid, which is backwards:
   * a bot's mandate must not grow because its owner's savings did.
   *
   * WHAT IT BOUNDS: the cost basis of every OPEN position plus the day's realised
   * LOSSES. A trade is admitted only when `deployed + MAX_POSITION_USD <= this`.
   * See `rails.ts` for why it is forward-looking, why losses count, why profit
   * creates no headroom, and why an unknown basis blocks.
   *
   * IT CANNOT BIND UNDER THE RAILS ABOVE, AND THAT IS DELIBERATE. MAX_CONCURRENT 5 x
   * $10 = $50 open plus MAX_DAILY_LOSS_USD $15 caps `deployed` at $65. This is a
   * BACKSTOP against those being raised, not a constraint that fires today — which is
   * exactly why `rail-drill` trips it on purpose rather than waiting for it.
   */
  /**
   * **$15, DOWN FROM $100, RE-DERIVED TO THE NEW SIZE 2026-09-17.**
   *
   * At $1 a position and ten trades a run the maximum basis a run can put out is $10,
   * so a $100 cap could never bind and a rail that cannot bind is not a rail. $15 is
   * that $10 plus headroom for the realised-loss term, which the cap also counts.
   */
  MAX_DEPLOYED_USD: 15,
  /** ~8% of the 485/day available in the SELLOFF window. A bounded first exposure. */
  MAX_TRADES_PER_DAY: 40,
  /**
   * **RAISED FROM $15 TO $50 ON 2026-09-17, OPERATOR-APPROVED, ON A MEASUREMENT THAT DID
   * NOT EXIST WHEN $15 WAS CHOSEN.** Halts for the day; it does not skip.
   *
   * $15 was "15% of the $100 capital" — an arithmetic relationship to another rail,
   * chosen before the strategy's loss distribution had ever been observed. It is 1.5
   * positions at `MAX_POSITION_USD`, so **two total losses breach it**, and
   * `exit-simulate` then measured the total-loss rate at 13.3%-29.0% by window.
   *
   * `daily-loss-derive` bootstrapped 20,000 trading days of `MAX_TRADES_PER_DAY` draws
   * from the 1,046 measured round trips and asked what fraction of days each candidate
   * would halt. **The rail was firing on a third of ordinary days:**
   *
   *     threshold    POOLED     SELLOFF (worst window)
   *        $15        33.3%          45.5%
   *        $25        19.0%          30.1%
   *        $40         7.7%          15.5%
   *      **$50**     **4.0%**      **9.9%**
   *        $75         0.7%           2.7%
   *
   * **THE DATA OFFERS NO NATURAL BREAK** — the curve is smooth from 33% to 0.1% — so
   * this is an operator preference informed by the rate rather than a value the
   * distribution identifies, exactly as `watchlist.top_percent` is in ROBINHOOD.md. What
   * the measurement DOES settle is that $15 was wrong: a rail that stops a positive-
   * expectation mode on one day in three is not protecting against a bad day, it is
   * mistaking an ordinary one for a bad day.
   *
   * **EVERY FIGURE ABOVE IS A FLOOR.** The bootstrap draws trades independently, and real
   * launches correlate — one launchpad shipping a bad template produces a run of losses
   * more readily than independence implies. So the true halt rate at any threshold is at
   * least the one shown.
   *
   * **AND `MAX_DEPLOYED_USD` SHADOWS IT WHENEVER POSITIONS ARE OPEN.** `deployed` is open
   * basis plus the day's realised losses, admitted while `deployed + MAX_POSITION_USD <=
   * MAX_DEPLOYED_USD`, so with concurrency full ($50 open) only **$40** of losses is
   * admitted before the cap blocks — below this rail. The cap was NOT raised with this:
   * the operator approved a larger daily loss, not a larger total exposure, and $100
   * remains the outer bound on both.
   */
  /**
   * **$5, DOWN FROM $50, DERIVED FROM THE MEASURED LOSS RATE 2026-09-17.**
   *
   * The $50 value was derived from `daily-loss-derive`'s bootstrap at a $10 position,
   * and section 6A.2 failure 8 records that the bootstrap assumed independent draws
   * while six of twelve live buys were one actor. It is superseded rather than rescaled.
   *
   * **THE MEASURED PER-TRADE OUTCOME ON THE LIVE POPULATION IS 11 OF 12 AT -100% AND 1
   * AT -1.6%**, so the expected loss per $1 trade is about $0.92 and a run losing
   * systematically reaches $5 after five or six trades — half the run's ten-trade
   * budget. That is the derivation: **halt a run at the point where the measured
   * failure rate says the remaining budget will also be lost.**
   */
  MAX_DAILY_LOSS_USD: 5,
  /** A broken calldata shape shows up as reverts and must stop at once. */
  /**
   * =====================================================================
   * THE STOP LOSS — 2B, and the measurement says a PRICE stop is the wrong instrument
   * =====================================================================
   *
   * There was no stop loss at all before 2026-09-17. This adds one, and the honest
   * derivation is uncomfortable: **the measured population contains no gradual
   * declines to derive a value from.**
   *
   * `decay-trajectory` walked every one of the twelve live positions from the buy block
   * to +300 s, taking the price AND executability at each step. The result:
   *
   * ```
   * became unsellable within +5 s      7 of 12
   *                   within +10 s     3 of 12
   *                   within +20 s     2 of 12
   *                   never             1 of 12   (798, flat at -1.6% out to +300 s)
   * worst price seen WHILE STILL SELLABLE   median -2.0%, min -2.0%
   * ```
   *
   * **-2.0% IS THE LP FEE.** Every position went from a normal price to unsellable in
   * one step, so the only decline a price stop could ever have fired on is the fee
   * itself. A stop tighter than the fee fires on every trade instantly; a stop looser
   * than it fires on none of the twelve. **There is no value in between that the data
   * supports, and inventing one would be exactly the reasoning-from-a-model this pass
   * exists to stop.**
   *
   * So the value below is chosen to be **PROVABLY INERT on the measured population** —
   * 10x the widest observed non-fatal decline — so it can only fire on something the
   * twelve never produced and cannot make the next run worse. **MEASURED: it would have
   * fired on 0 of 12.** It is a backstop against a decline shape nobody has yet
   * observed, not a mechanism against the one that was.
   *
   * **THE INSTRUMENT THE DATA DOES SUPPORT IS `SELLABILITY_STOP`, below.**
   */
  STOP_LOSS_BPS: 2000,

  /**
   * =====================================================================
   * THE SELLABILITY STOP — what the measurement actually supports
   * =====================================================================
   *
   * Poll whether our own sell would EXECUTE, every tick, and exit the instant it stops
   * executing rather than waiting for the horizon. This is the only stop that addresses
   * the measured failure, because the failure is a step change in executability and not
   * a price move.
   *
   * **AND ITS LIMIT IS MEASURED AND MUST BE STATED: 7 OF 12 DIED WITHIN 5 SECONDS.**
   * The loop ticks at roughly 5 s, so even a perfect poll running every tick would have
   * caught at most 5 of the 12. **The only thing that catches the other 7 is not holding
   * at all**, and that is an operator decision about `EXIT_DELAY_BLOCKS` rather than
   * something a stop can fix. Recorded so the poll is not mistaken for a solution.
   *
   * It uses a REACHABLE bound, per section 6A.3: an unreachable one short-circuits
   * before the settle and reports a healthy price on a token that refuses transfers.
   */
  SELLABILITY_STOP: true,

  /**
   * =====================================================================
   * WHEN A POSITION IS CALLED A LOSER — 2D
   * =====================================================================
   *
   * **1,200 blocks = 2 minutes, the operator's value, kept as a BACKSTOP rather than as
   * the mechanism — and the measurement says why.** 11 of 12 positions were already
   * unsellable within 20 seconds, so a 2-minute deadline would have changed the outcome
   * of exactly none of them. It is six to twenty-four times slower than the decisive
   * window.
   *
   * It is still worth having: it bounds the case where a position is neither sellable
   * nor resolvable, which is how the live run left five rows stranded. What actually
   * calls the losers on this population is `SELLABILITY_STOP` above.
   *
   * On expiry: stop trying, mark the position a loss, and **add its template to the
   * run's blocklist** so the bot does not buy the same thing again — 6 of 12 live buys
   * were one actor and five were bought AFTER the first had already failed.
   */
  LOSER_DEADLINE_BLOCKS: 1200,   /* 120 s at the measured 10 blocks/s */

  MAX_CONSECUTIVE_REVERTS: 3,
} as const;

/**
 * THE SLIPPAGE BOUND. **CHANGED 2026-09-16 FROM 300 TO 1000 bps, OPERATOR-APPROVED, ON
 * MEASURED EVIDENCE.** LAUNCHBOT.md section 4 and section 6 carry the whole derivation.
 *
 * WHY IT MOVED, AND IT IS NOT A TUNED CONSTANT. `revert-economics` priced every launch
 * the bot has ever simulated against the router's own output — an unreachable
 * `amountOutMinimum` makes `V4TooLittleReceived` report what the pool would actually have
 * paid — and then asked what the refused trades would have DONE:
 *
 *   post-corpus, n=1,388   ACCEPTED median +0.000   REFUSED median +0.439
 *   bot ground truth n=100 ACCEPTED median +0.202   REFUSED median +0.462
 *
 * **THE BOUND WAS SELECTING AGAINST POOLS THAT WERE TRADING.** Refused trades had BETTER
 * exit availability than accepted ones in all four historical windows, and accepted
 * exit-availability rose monotonically as the bound widened. The bound fires when a pool's
 * price moved away from our quote, and a pool whose price is moving is a pool that is
 * trading — so at 300 bps it was refusing 34 tradeable launches to avoid 3 dead ones.
 *
 * WHY 1000 AND NOT MORE. The measured defensible range is 1,000–1,600 bps. Above roughly
 * 1,600 the accepted haircut exceeds the recent-era median gross return of +0.157–0.180,
 * at which point a filled trade loses more than the trade makes — the same reasoning that
 * stops the retry ladder. **1,000 is the conservative end of the range and is taken for
 * that reason**, exactly as +90 s was taken over +180 s for the exit horizon.
 *
 * WHY NOT THE OBJECTIVE'S OWN ARGMAX. Maximising median return over all launches says
 * 1,350 bps on the bot set and 3,800 post-corpus — but the objective is FLAT from there to
 * 9,400, so it does not identify a bound at all, and its answer is arithmetic rather than
 * economic: over half of launches score zero, so the median jumps when the zero mass
 * crosses the 50th percentile. A plateau is a tie, not a finding.
 *
 * IT REMAINS OURS AND NOT THEIRS. The 9 of 9 native-ETH buys observed on this chain set
 * `amountOutMinimum` to 0 and take no protection whatever; that is still not copied.
 * `buildSwap` still REFUSES a non-positive bound rather than defaulting it.
 *
 * WHAT WOULD MOVE IT AGAIN: logged LIVE slippage, which no trade has yet produced. Every
 * figure behind this number is a simulation against historical state.
 */
export const SLIPPAGE_BPS = 1000;

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
 * EXIT RETRY. An exit that reverts leaves the bot holding a token with no way out, which
 * is the worst outcome available to it — worse than a bad fill, because a position that
 * cannot be sold is not a loss of some size, it is an unbounded one.
 *
 * **RE-DERIVED 2026-09-16 WHEN THE BOUND MOVED TO 1000 bps, AND IT GOT SHORTER RATHER
 * THAN RESCALED.** The rungs are the shortfall over the launches the FIRST rung still
 * misses, and that set is a function of the first rung — so a ladder calibrated against
 * 300 bps was answering "what clears the trades 300 bps missed" while the bot now misses
 * a different and much smaller set. It was `[300, 449, 608, 1343]`; two of those rungs are
 * now BELOW the entry bound and subsumed by it.
 *
 * **THE NEW LADDER IS A NATURAL BREAK, NOT A QUANTILE, AND THAT IS WHY IT IS TWO RUNGS.**
 * At a 1,000 bps first rung exactly 7 of 100 oracle-priced launches still miss, and they
 * split perfectly:
 *
 *     4 launches need EXACTLY 1343 bps   — all four have an exit, all return +138.4%
 *     3 launches need 6067 / 6401 / 8445 — all three have NO EXIT AT ALL
 *
 * There is a clean gap between 1,343 and 6,067 bps and **it coincides exactly with the
 * dead-pool boundary**. Every launch a third rung could reach is a pool nothing will buy
 * at any price, which is the finding the drill and the boot fixture both produced from the
 * other direction: a retry ladder rescues a mispriced quote, not a dead pool.
 *
 * **THE STOPPING RULE IS UNCHANGED IN INTENT AND SHARPER IN EFFECT.** It stopped at the
 * p75 because a rung past it accepts a haircut larger than the position's whole expected
 * gain. Here the p75 is 6,234 bps — a 62% haircut against a recent-era median gross of
 * +16-18% — so the p75 and the economic rule now DISAGREE, and the economic rule wins
 * because it is the reason the p75 rule existed. 1,343 bps sits just under the median
 * gross; 6,234 is four times above it.
 *
 * **THE NAIVE QUANTILES WOULD HAVE PRODUCED A DEFECT.** p25 and median are both 1,343 at
 * n=7, so the mechanical derivation gives `[1000, 1343, 1343, 6234]` — a DUPLICATE rung,
 * which `exitWithRetry`'s own contract calls one attempt logged twice, plus a final rung
 * past the stopping rule. Reading the individual launches rather than an interpolated
 * quantile is what caught it.
 *
 * **n IS 4 FOR THE SECOND RUNG.** Thinner than the 11 the old ladder rested on, and
 * stated rather than buried: these are a schedule to be re-derived from logged LIVE exits,
 * exactly as SLIPPAGE_BPS is.
 *
 * THE INTERVAL IS 5 SECONDS, from the measured median exit fill delay of 1.1-4.5 s: long
 * enough that a new trade has landed and the quote has genuinely moved, so a retry is a
 * fresh attempt rather than the same one repeated. Two attempts complete within ~5 s.
 */
export const EXIT_RETRY = {
  MAX_ATTEMPTS: 2,
  INTERVAL_MS: 5000,
  /** One bound per attempt. Length MUST equal MAX_ATTEMPTS; asserted at load. */
  BOUND_BPS: [1000, 1343],
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

/**
 * THE RECEIPT WAIT, SHARED BY EVERY PATH THAT BROADCASTS.
 *
 * These two figures were literals in `exit-exec.ts` AND in `approve-setup.ts`, with a
 * comment in the second saying it used "the same figures exit-exec uses". Two copies of
 * one constant is the trap this project records eight times, and the loop was about to
 * become a third copy — so they are here, and every broadcasting path imports them.
 *
 * The derivation is `exit-exec`'s header and LAUNCHBOT.md: receipt AVAILABILITY measured
 * at 60 of 60 on the first ask with a 36 ms maximum, and INCLUSION measured for the first
 * time by the two real approvals of 2026-09-16 at 20 ms and 16 ms, both on the first poll.
 * So 60 s is roughly 3,000x the observed total, kept deliberately: firing early stops a
 * ladder and leaves a position for a human, firing late makes the bot wait on $10.
 */
export const RECEIPT_TIMEOUT_MS = 60_000;
/** 1 s against a measured 100.52 ms block interval; a finer poll bought nothing. */
export const RECEIPT_POLL_MS = 1_000;

/**
 * HOW LONG A PERMIT2 GRANT LIVES. One hour.
 *
 * A Permit2 allowance carries an EXPIRY as well as an amount, which is the one way it
 * differs from a plain ERC-20 allowance and the one a check written from the ERC-20 shape
 * misses. It is short on purpose: the grant exists to cover ONE position for ONE hold of
 * ~90 seconds, and a grant that outlives its position is a standing claim on a launch-
 * minute contract nobody has read. An hour is ~40x the hold, which absorbs a stuck
 * position being retried at the next boot without becoming open-ended.
 *
 * It is a constant here rather than a literal at two call sites because `approve-setup`
 * and the loop must grant the same thing; the value that matters is that it is bounded.
 */
export const APPROVAL_TTL_SECONDS = 3600;

/**
 * THE ROUND TRIP'S GAS, PER LEG, WITH EACH FIGURE'S PROVENANCE.
 *
 * Kept here so the loop can REPORT a complete round-trip cost rather than the document
 * carrying a table nothing can read back. LAUNCHBOT.md section 6 holds the derivations.
 *
 * **ONE OF THESE IS OURS AND THE REST ARE OTHER PEOPLE'S**, which is the distinction that
 * matters and the reason they are labelled individually rather than summed into a constant:
 *
 *   approvals  MEASURED ON OUR OWN TWO RECEIPTS, 2026-09-16 — 0x999fdb79… and 0x178977d3…,
 *              57,892 + 47,554 gas at ~50 gwei-equivalent = 0.00000527312716 ETH = $0.0128
 *              for the PAIR. The external estimate those receipts replaced was $0.015, so
 *              it was 17% high. This is the first gas figure this project has from a
 *              transaction it actually paid for.
 *   buy / sell ESTIMATED, from 200 real receipts per era belonging to other traders. The
 *              buy range is the CALM-to-SELLOFF spread; the sell is a single median.
 *
 * `gas_usd` is still NULL on every stored row: no trade of ours has been broadcast, so
 * nothing here has been checked against our own buy or sell. These are the figures a run
 * reports, not measurements of it.
 */
export const ROUND_TRIP_GAS_USD = {
  /** MEASURED, ours. Both approvals, one token, one trade. */
  APPROVALS: 0.0128,
  /** Estimated, other people's receipts. SELLOFF era. */
  BUY_LOW: 0.0279,
  /** Estimated, other people's receipts. CALM era. */
  BUY_HIGH: 0.0405,
  /** Estimated, other people's receipts, median of 40 sampled sells. */
  SELL: 0.04339,
} as const;
