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
import { NON_TERMINAL, isHalted } from './state.js';
import { RAILS } from './config.js';
import type { PoolClient } from '../store/db.js';

export interface RailState {
  halted: boolean;
  haltReason: string;
  openPositions: number;
  tradesToday: number;
  realisedPnlTodayUsd: number;
  consecutiveReverts: number;
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
  const r = await c.query<{ open: string; today: string; pnl: string | null }>(
    `select
       (select count(*) from bot_trades
         where chain = $1 and mode = $2 and status = any($3))::text as open,
       (select count(*) from bot_trades
         where chain = $1 and mode = $2 and created_at >= date_trunc('day', now()))::text as today,
       (select coalesce(sum(net_pnl_usd), 0) from bot_trades
         where chain = $1 and mode = $2
           and created_at >= date_trunc('day', now()))::text as pnl`,
    [chain, mode, NON_TERMINAL]);
  const row = r.rows[0];
  if (!row) {
    throw new Error('rail state query returned no row; refusing to trade against an '
      + 'unknown state rather than assuming the rails are clear');
  }
  return {
    halted: kill.halted,
    haltReason: kill.reason,
    openPositions: Number(row.open),
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
  return blocked;
}

export async function checkRails(
  c: PoolClient, chain: string, mode: string,
): Promise<RailVerdict> {
  const state = await readRailState(c, chain, mode);
  const blocked = evaluateRails(state);
  return { allowed: blocked.length === 0, blocked, state };
}
