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
  const kill = await isHalted(c, chain);
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
