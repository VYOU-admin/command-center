/**
 * THE ONE IMPLEMENTATION OF THE SAFETY RAILS.
 *
 * Every rail is checked in one place, against Postgres, immediately before a trade is
 * committed to. Nothing else in the codebase may decide that a trade is permitted.
 *
 * WHY THE STATE IS READ RATHER THAN COUNTED IN MEMORY. A counter in a variable dies
 * with the container, and this project has had a container replaced out from under a
 * running job twice. A bot that restarts having forgotten it already lost $14 today
 * would happily lose $14 again. Every figure below is derived from `bot_trades` on the
 * connection passed in, so a restart inherits the day it actually had.
 *
 * A RAIL THAT CANNOT BE EVALUATED BLOCKS. If a count cannot be read the answer is not
 * "probably fine" -- it is the same failure ROBINHOOD.md records for a balance reader
 * that mapped an RPC error to a plausible 0.0.
 */
import { HELD, NON_TERMINAL, isHalted } from './state.js';
import { RAILS } from './config.js';
import type { PoolClient } from '../store/db.js';

export interface RailState {
  halted: boolean;
  haltReason: string;
  openPositions: number;
  /**
   * Cost basis of every position the wallet may still be HOLDING, summed — the `HELD`
   * set, which is wider than `openPositions` counts. The first term of `deployed`.
   */
  openCostBasisUsd: number;
  /**
   * HELD positions carrying a NULL `position_usd`. `sum()` skips them silently, so
   * without this count the cap would under-report exposure and read as a clean pass —
   * the failure shape ROBINHOOD.md records for a `balanceOf` reader that turned 490
   * HTTP 429s into plausible zero balances. Non-zero means `deployed` is UNKNOWN.
   */
  openPositionsUnknownBasis: number;
  tradesToday: number;
  realisedPnlTodayUsd: number;
  consecutiveReverts: number;
}

/**
 * THE DEPLOYED-CAPITAL FIGURE, AND THE ONE PLACE IT IS COMPUTED.
 *
 * `deployed = open cost basis + the day's realised LOSSES`.
 *
 * WHY LOSSES COUNT. Without the second term this is a concurrency limit denominated in
 * dollars, not a capital cap: a bot that loses $10 and reopens has the same open basis
 * and less money. Counting the day's losses makes the cap bound what the day can COST
 * rather than what happens to be open at an instant.
 *
 * WHY PROFIT CREATES NO HEADROOM. The term is `max(0, -pnl)`, so a profitable day leaves
 * the cap exactly where it was. A gain in the bot's ledger is not a mandate to risk more
 * of the operator's personal wallet, and the symmetric form would quietly turn one good
 * morning into a larger afternoon.
 */
export function deployedUsd(state: RailState): number {
  return state.openCostBasisUsd + Math.max(0, -state.realisedPnlTodayUsd);
}

export interface RailVerdict {
  allowed: boolean;
  /** EVERY breached rail, never just the first, so the log explains the whole stop. */
  blocked: string[];
  state: RailState;
}

/**
 * The trailing run of reverted simulations, derived from the table rather than a
 * variable, so it survives a restart. A clean trade anywhere in the run ends it.
 */
async function trailingReverts(c: PoolClient, chain: string, mode: string): Promise<number> {
  const r = await c.query<{ status: string }>(
    `select status from bot_trades
      where chain = $1 and mode = $2
      order by created_at desc, id desc limit 50`, [chain, mode]);
  let n = 0;
  for (const row of r.rows) {
    if (row.status === 'sim_reverted' || row.status === 'entry_reverted') n += 1;
    else break;
  }
  return n;
}

export async function readRailState(
  c: PoolClient, chain: string, mode: string,
): Promise<RailState> {
  const kill = await isHalted(c, chain, mode);
  const r = await c.query<{
    open: string; today: string; pnl: string | null; basis: string; nobasis: string;
  }>(
    `select
       (select count(*) from bot_trades
         where chain = $1 and mode = $2 and status = any($3))::text as open,
       (select count(*) from bot_trades
         where chain = $1 and mode = $2 and created_at >= date_trunc('day', now()))::text as today,
       (select coalesce(sum(net_pnl_usd), 0) from bot_trades
         where chain = $1 and mode = $2
           and created_at >= date_trunc('day', now()))::text as pnl,
       (select coalesce(sum(position_usd), 0) from bot_trades
         where chain = $1 and mode = $2 and status = any($4))::text as basis,
       (select count(*) from bot_trades
         where chain = $1 and mode = $2 and status = any($4)
           and position_usd is null)::text as nobasis`,
    /*
     * THE CAP'S TWO FIGURES USE $4 = `HELD`, WHICH IS WIDER THAN $3 = `NON_TERMINAL`.
     * A position the exit ladder failed to sell is still money in a token; it is simply
     * outside the set boot reconciliation sweeps. Using one set for both questions would
     * let stuck positions read as $0 deployed. See state.ts.
     */
    [chain, mode, NON_TERMINAL, HELD]);
  const row = r.rows[0];
  if (!row) {
    throw new Error('rail state query returned no row; refusing to trade against an '
      + 'unknown state rather than assuming the rails are clear');
  }
  return {
    halted: kill.halted,
    haltReason: kill.reason,
    openPositions: Number(row.open),
    openCostBasisUsd: Number(row.basis),
    openPositionsUnknownBasis: Number(row.nobasis),
    tradesToday: Number(row.today),
    realisedPnlTodayUsd: Number(row.pnl ?? 0),
    consecutiveReverts: await trailingReverts(c, chain, mode),
  };
}

/** Pure, so every rail can be exercised in a test without a database. */
export function evaluateRails(state: RailState): string[] {
  const blocked: string[] = [];
  if (state.halted) blocked.push(`kill switch: ${state.haltReason || 'halted'}`);
  if (state.openPositions >= RAILS.MAX_CONCURRENT) {
    blocked.push(`MAX_CONCURRENT: ${state.openPositions} open >= ${RAILS.MAX_CONCURRENT}`);
  }
  if (state.tradesToday >= RAILS.MAX_TRADES_PER_DAY) {
    blocked.push(`MAX_TRADES_PER_DAY: ${state.tradesToday} >= ${RAILS.MAX_TRADES_PER_DAY}`);
  }
  /*
   * A LOSS IS A NEGATIVE PnL, and the comparison is on the loss magnitude. Writing
   * this as `pnl <= -MAX` rather than `abs(pnl) >= MAX` matters: a PROFITABLE day of
   * +$15 must not halt the bot, and the absolute-value form would.
   */
  if (state.realisedPnlTodayUsd <= -RAILS.MAX_DAILY_LOSS_USD) {
    blocked.push(`MAX_DAILY_LOSS_USD: ${state.realisedPnlTodayUsd.toFixed(2)} <= `
      + `-${RAILS.MAX_DAILY_LOSS_USD}`);
  }
  if (state.consecutiveReverts >= RAILS.MAX_CONSECUTIVE_REVERTS) {
    blocked.push(`MAX_CONSECUTIVE_REVERTS: ${state.consecutiveReverts} >= `
      + `${RAILS.MAX_CONSECUTIVE_REVERTS}`);
  }
  /*
   * THE HARD CAPITAL CAP. Checked LAST because it is the backstop, and reported with
   * both of its terms so the log says WHY it bound rather than only that it did.
   *
   * AN UNKNOWN BASIS BLOCKS BEFORE THE ARITHMETIC IS TRUSTED. An open row with a null
   * `position_usd` contributes nothing to `sum()`, so the cap would under-report real
   * exposure and pass. Unknown is not zero -- the standing rule on this project, and
   * the one an error path that emits a plausible value always breaks.
   */
  if (state.openPositionsUnknownBasis > 0) {
    blocked.push(`MAX_DEPLOYED_USD: deployed capital is UNKNOWN -- `
      + `${state.openPositionsUnknownBasis} open position(s) carry a null position_usd, `
      + 'which sum() would silently treat as $0');
  } else {
    /*
     * FORWARD-LOOKING, AND IT HAS TO BE. Testing `deployed >= cap` after the fact would
     * admit the trade that takes it to $110. The prospective size is exactly
     * MAX_POSITION_USD because `positionWei()` sizes every position at it.
     */
    const deployed = deployedUsd(state);
    const after = deployed + RAILS.MAX_POSITION_USD;
    if (after > RAILS.MAX_DEPLOYED_USD) {
      blocked.push(`MAX_DEPLOYED_USD: $${deployed.toFixed(2)} deployed `
        + `(open basis $${state.openCostBasisUsd.toFixed(2)} + realised losses `
        + `$${Math.max(0, -state.realisedPnlTodayUsd).toFixed(2)}) + `
        + `$${RAILS.MAX_POSITION_USD} = $${after.toFixed(2)} > `
        + `$${RAILS.MAX_DEPLOYED_USD}`);
    }
  }
  return blocked;
}

/**
 * DOES A BREACHED CAPITAL CAP STOP THE DAY, OR ONLY THIS LAUNCH?
 *
 * It depends on which term breached it, and the two behave differently:
 *
 *   - OPEN BASIS clears by itself. Positions close, `deployed` falls, and the next
 *     launch is admissible. That is an ordinary capacity limit and correctly SKIPS.
 *   - REALISED LOSSES never fall within a day. If the loss term ALONE leaves no room
 *     for one more position, no amount of waiting helps and every further candidate
 *     would re-run the same refusal for hours. That HALTS, exactly as
 *     MAX_DAILY_LOSS_USD does and for the same reason.
 *   - AN UNKNOWN BASIS halts too: it is a defect in the stored state, not a capacity
 *     condition, and it cannot resolve on its own.
 *
 * Under today's rails neither halting branch is reachable -- MAX_DAILY_LOSS_USD stops
 * the day at $15, far below the $90 of losses this would need. It is written for the
 * case the cap exists for: the other rails being raised.
 */
export function deployedCapIsTerminal(state: RailState): boolean {
  if (state.openPositionsUnknownBasis > 0) return true;
  const losses = Math.max(0, -state.realisedPnlTodayUsd);
  return losses + RAILS.MAX_POSITION_USD > RAILS.MAX_DEPLOYED_USD;
}

export async function checkRails(
  c: PoolClient, chain: string, mode: string,
): Promise<RailVerdict> {
  const state = await readRailState(c, chain, mode);
  const blocked = evaluateRails(state);
  return { allowed: blocked.length === 0, blocked, state };
}

/*
 * ======================================================================
 * THE IN-PROCESS RAILS AND THE STOPS -- PURE PREDICATES, SO THE DRILL CAN TRIP THEM
 * ======================================================================
 *
 * These are not database rails and they are deliberately not part of `checkRails`.
 * They are here, as pure functions, for one reason: **a guard that cannot be trip[ped
 * by the drill is a guard nobody has exercised.** The live run's cost was not an absent
 * limit -- it was four limits that had never fired in anger. Written inline in
 * `launchbot.ts` these would be untestable arithmetic inside a 1,300-line loop.
 *
 * `rail-drill` calls each one at the threshold and one below it. A guard that fires in
 * both cases is an outage, not a guard, and the one-below case is what separates them.
 */

/**
 * THE PER-RUN TRADE CAP -- 2A.
 *
 * Counted in the process rather than queried, because the $120 loss was caused by a
 * status defect (`closed_unsimulatable`) that made every open position invisible to the
 * queries `MAX_CONCURRENT`, `MAX_DEPLOYED_USD` and `MAX_DAILY_LOSS_USD` all read from.
 * All three reported a clean slate simultaneously. **A counter held in the loop cannot
 * be routed around by a wrong status**, which is what makes this a second KIND of limit
 * rather than a duplicate of the first.
 *
 * It counts BROADCASTS, not fills: a buy that reverted still spent gas and still used
 * one of the run's attempts.
 */
export function runCapReached(tradesThisRun: number): boolean {
  return tradesThisRun >= RAILS.MAX_TRADES_PER_RUN;
}

/**
 * THE PRICE STOP -- 2B.
 *
 * **MEASURED: THIS WOULD HAVE FIRED ON 0 OF THE 12 LIVE POSITIONS.** `decay-trajectory`
 * walked each one from its buy block to +300 s: the worst price seen while a position
 * was still sellable was -2.0%, which IS the LP fee. Every position went from a normal
 * price to unsellable in a single step, with no decline in between for a price stop to
 * catch. `STOP_LOSS_BPS` is therefore set to a value provably inert on that population
 * -- it is a backstop against a decline shape nobody has observed, and the instrument
 * the measurement supports is the sellability poll.
 *
 * Measured against what was PAID (`position_wei`) and never against the quote: a quote
 * is what we expected and a fill is what happened.
 *
 * A mark that cannot be read returns `fires: false` with `declineBps: null` -- UNKNOWN
 * is not a decline, and an error path that emitted a plausible number here would sell
 * every position on a transport hiccup.
 */
export function priceStopFires(
  paidWei: bigint, markWei: bigint | null,
): { fires: boolean; declineBps: number | null } {
  if (markWei === null || paidWei <= 0n) return { fires: false, declineBps: null };
  const declineBps = Number(((paidWei - markWei) * 10000n) / paidWei);
  return { fires: declineBps >= RAILS.STOP_LOSS_BPS, declineBps };
}

/**
 * THE LOSER DEADLINE -- 2D.
 *
 * The operator's 2-minute value, and **MEASURED: it would have changed the outcome of
 * none of the twelve.** 11 of 12 were already unsellable within 20 seconds, so a
 * 1,200-block deadline is six to twenty-four times slower than the decisive window. It
 * is kept as a backstop for the case it does address -- a position that is neither
 * sellable nor resolvable, which is how five rows were left stranded -- and not as the
 * mechanism that calls losers.
 *
 * A row with no `entry_block` returns false: we do not know when it started, and
 * guessing would either abandon a fresh position or hold a dead one forever.
 */
export function loserDeadlineFires(
  entryBlock: number | null, head: number,
): { fires: boolean; blocksHeld: number | null } {
  if (entryBlock === null) return { fires: false, blocksHeld: null };
  const blocksHeld = head - entryBlock;
  return { fires: blocksHeld >= RAILS.LOSER_DEADLINE_BLOCKS, blocksHeld };
}

/**
 * WHICH OF THE FOUR TRIGGERS CALLS A POSITION, AND IN WHAT ORDER.
 *
 * Extracted from `launchbot.ts` for the same reason as the predicates above: the
 * ORDERING is the part that matters and it was unreachable by any drill while it lived
 * inline in a 1,300-line loop. Ordering is not cosmetic here --
 *
 *   - `sellability_stop` must beat `horizon`, or a position that has become unsellable
 *     inside its 90-second hold is recorded as an ordinary planned exit and **its
 *     template is never blocked**, which is how five of the six `Fly` buys happened.
 *   - `sellability_stop` must beat `price_stop`, because a position that cannot be sold
 *     at all has no meaningful mark and reporting a price decline for it would attribute
 *     the loss to the wrong cause.
 *   - `horizon` must beat `loser_deadline`, because a position reaching its planned exit
 *     is a normal close and must not be recorded as a loser or blocklist its template.
 *
 * `sellable` is the poll's three-state answer and the third state is load-bearing:
 * `null` means the probe could not be read, and it must trigger NOTHING. An unreadable
 * probe is not evidence a position is fine and not evidence it is dead, and a default
 * either way is the error-path-emits-a-plausible-value shape that has already cost this
 * project a full investigation.
 */
export type ExitTrigger = 'sellability_stop' | 'price_stop' | 'horizon' | 'loser_deadline';

export function decideExitTrigger(args: {
  sellable: boolean | null;
  paidWei: bigint;
  markWei: bigint | null;
  entryBlock: number | null;
  dueBlock: number | null;
  head: number;
}): { trigger: ExitTrigger | null; detail: string } {
  if (args.sellable === false) {
    return { trigger: 'sellability_stop', detail: 'our own sell no longer executes' };
  }
  if (args.sellable === true) {
    const ps = priceStopFires(args.paidWei, args.markWei);
    if (ps.fires) {
      return { trigger: 'price_stop',
        detail: `mark ${String(ps.declineBps)} bps below fill, limit ${RAILS.STOP_LOSS_BPS}` };
    }
  }
  if (args.dueBlock !== null && args.dueBlock <= args.head) {
    return { trigger: 'horizon',
      detail: `exit_due_block ${args.dueBlock} <= head ${args.head}` };
  }
  const ld = loserDeadlineFires(args.entryBlock, args.head);
  if (ld.fires) {
    return { trigger: 'loser_deadline',
      detail: `${String(ld.blocksHeld)} blocks since entry, limit ${RAILS.LOSER_DEADLINE_BLOCKS}` };
  }
  return { trigger: null, detail: 'nothing calls it this tick' };
}

/**
 * DOES THIS TRIGGER BLOCK THE TEMPLATE FOR THE REST OF THE RUN?
 *
 * Everything except a clean `horizon` exit. A position that reached its planned exit is
 * an ordinary close and says nothing about the actor who deployed it; the other three
 * each say the template produced something we could not get out of.
 */
export function triggerBlocksTemplate(trigger: ExitTrigger): boolean {
  return trigger !== 'horizon';
}
