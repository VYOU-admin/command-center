/**
 * BOOT RECONCILIATION. docs/LAUNCHBOT.md section 2.
 *
 * A container replaced between the buy and the sell leaves a position open with no
 * process tracking it, and a launched token is not something anyone comes back for.
 * ROBINHOOD.md records containers being replaced mid-job twice.
 *
 * THE CHAIN IS THE AUTHORITY, NOT THE ROW. A row says what we intended; the wallet's
 * token balance says what actually happened. Where they disagree the balance wins.
 */
import { id } from 'ethers';
import type { PoolClient } from '../store/db.js';
import { log } from '../logger.js';
import type { ReadOnlyRpc } from './rpc.js';
import { NON_TERMINAL, halt } from './state.js';
import { executeExit } from './exit-exec.js';
import type { ExitRpc } from './exit-exec.js';

const BALANCE_OF = id('balanceOf(address)').slice(0, 10);

export interface Reconciled {
  examined: number; resolved: number; stillHolding: number; unresolved: number;
}

/**
 * Reconcile every non-terminal row against the chain.
 *
 * A row that cannot be resolved HALTS the bot rather than being abandoned: the one
 * thing worse than a stuck position is a stuck position plus new ones.
 */
export async function reconcileOnBoot(
  c: PoolClient, rpc: ReadOnlyRpc, chain: string, wallet: string | null, mode: string,
): Promise<Reconciled> {
  const rows = await c.query<{
    id: string; token: string; status: string; entry_tx: string | null;
    exit_sim_from: string | null;
  }>(
    `select id::text, token, status, entry_tx, exit_sim_from from bot_trades
      where chain = $1 and mode = $2 and status = any($3)`,
    [chain, mode, NON_TERMINAL]);
  const out: Reconciled = { examined: rows.rowCount ?? 0, resolved: 0, stillHolding: 0, unresolved: 0 };
  if (out.examined === 0) {
    /* Reported, never omitted: zero open positions is a result. */
    log.info('boot reconciliation: no non-terminal rows', { chain, mode });
    return out;
  }
  if (!wallet) {
    /*
     * Without a wallet the balance cannot be read, so nothing can be adjudicated. That
     * is a halt, not a shrug -- exactly the case this routine exists for.
     */
    await halt(c, chain, 'boot reconciliation found open rows but no wallet is configured');
    out.unresolved = out.examined;
    return out;
  }
  for (const r of rows.rows) {
    try {
      /*
       * THE BALANCE IS READ FOR WHOEVER THE POSITION IS ATTRIBUTED TO.
       *
       * A live row is attributed to our wallet and has no `exit_sim_from`. A dry-run row
       * is attributed to the borrowed holder the sell would be simulated as, because in
       * dry run we hold nothing ourselves — so asking OUR balance would report every
       * hypothetical position as closed, which is a plausible answer and the wrong one.
       * Preferring the row's own attribution keeps one code path honest for both.
       */
      const holder = r.exit_sim_from ?? wallet;
      const data = BALANCE_OF + '0'.repeat(24) + holder.slice(2).toLowerCase();
      const res = await rpc.call('eth_call', [{ to: r.token, data }, 'latest']);
      const bal = BigInt(String(res));
      if (bal > 0n) {
        /* The buy landed and the sell did not. It is past its 45-second window by
         * definition, so it is exposure rather than a trade: exit it before arming. */
        out.stillHolding += 1;
        await c.query(
          `update bot_trades set status = 'needs_exit', note = 'boot: token balance > 0',
                  updated_at = now() where id = $1`, [r.id]);
      } else {
        out.resolved += 1;
        await c.query(
          `update bot_trades set status = 'closed_unfilled',
                  note = 'boot: zero token balance on chain', updated_at = now()
            where id = $1`, [r.id]);
      }
    } catch (err) {
      out.unresolved += 1;
      await halt(c, chain, `boot reconciliation could not resolve trade ${r.id}: `
        + (err as Error).message);
    }
  }
  return out;
}


/**
 * CLEAR EVERY `needs_exit` POSITION, AT BOOT, BEFORE THE BOT ARMS.
 *
 * `LAUNCHBOT.md` section 2 rule 3: *any position whose buy landed and whose sell did not
 * is EXITED IMMEDIATELY at boot, before the bot arms itself for new launches. It is past
 * its window by definition, so it is not a trade any more — it is an open exposure.*
 * Rule 4: *reconciliation failure halts the bot.*
 *
 * Until now `reconcileOnBoot` marked such a row `needs_exit` and **nothing acted on it**.
 * That is the state a container replacement actually produces, and this project has
 * produced one twice, so the row would have sat there while the bot went on opening new
 * positions beside it.
 *
 * **A POSITION THAT CANNOT BE EXITED HALTS THE BOT AND RAISES.** It does not return a
 * status, it does not log a warning and continue, and it does not arm. One stuck
 * position is bad; one stuck position plus a bot opening more is the thing rule 4
 * exists to prevent.
 */
export async function clearNeedsExit(
  c: PoolClient, rpc: ExitRpc, chain: string, mode: string,
  /*
   * `broadcaster` IS FORWARDED RATHER THAN CREATED HERE. `createBroadcaster` is the only
   * way to obtain one and it refuses outside live mode, so this module cannot acquire the
   * ability to send — it can only pass on what the boot sequence already decided. That
   * keeps the boot sweep and the in-loop exit on ONE executor with one submission path.
   */
  ctx: {
    forceOptimism?: number;
    wait?: (ms: number) => Promise<void>;
    broadcaster?: import('./signer.js').Broadcaster | null;
  } = {},
): Promise<{ found: number; exited: number; filledOn: number[] }> {
  const rows = await c.query<{
    id: string; pool_id: string; token: string; counter: string; fee: number;
    tick_spacing: number; hooks: string; first_swap_block: string;
    exit_sim_from: string | null; quoted_out: string | null;
  }>(
    `select id::text, pool_id, token, counter, fee, tick_spacing, hooks,
            first_swap_block::text, exit_sim_from, quoted_out::text
       from bot_trades
      where chain = $1 and mode = $2 and status = 'needs_exit'
      order by id`, [chain, mode]);

  const found = rows.rowCount ?? 0;
  if (found === 0) {
    /* Reported, never omitted: zero stuck positions is a result. */
    log.info('boot: no needs_exit positions', { chain, mode });
    return { found: 0, exited: 0, filledOn: [] };
  }

  log.warn('BOOT: STUCK POSITIONS FOUND — EXITING BEFORE ARMING', { chain, mode, found });
  const filledOn: number[] = [];
  let exited = 0;

  for (const r of rows.rows) {
    /*
     * WITH A BROADCASTER, THE SELLER IS US — not the stored borrowed holder.
     *
     * `exit_sim_from` is the address the dry-run simulation borrowed because we hold
     * nothing of the token. On a live path the balance to read and the account to sign as
     * are both ours, and `executeExit` refuses if the two disagree — so getting this
     * wrong would stop the boot sweep rather than sell someone else's position.
     */
    const sellFrom = ctx.broadcaster?.address ?? r.exit_sim_from;
    if (!sellFrom) {
      /* No address to sell as is not a reason to skip — it is a reason to stop. */
      await halt(c, chain, `needs_exit trade ${r.id} has no address to exit from`);
      throw new Error(`BOOT EXIT IMPOSSIBLE: trade ${r.id} is needs_exit and carries no `
        + 'address to sell from. THE POSITION IS STILL OPEN and the bot has not armed.');
    }
    /* THE AMOUNT IS THE BALANCE ACTUALLY HELD, read from the chain, never the quote. */
    const data = BALANCE_OF + '0'.repeat(24) + sellFrom.slice(2).toLowerCase();
    const bal = BigInt(String(await rpc.call('eth_call', [{ to: r.token, data }, 'latest'])));
    if (bal === 0n) {
      /* The chain says the position is gone. That is resolution, not an exit. */
      await c.query(
        `update bot_trades set status = 'closed_unfilled',
                note = 'boot: needs_exit but balance is now zero', updated_at = now()
          where id = $1`, [r.id]);
      log.info('boot: needs_exit row now holds nothing on chain', { trade: r.id });
      continue;
    }

    let outcome;
    try {
      outcome = await executeExit(
        { rpc, client: c, ...ctx },
        {
          tradeId: r.id, poolId: r.pool_id, token: r.token, counter: r.counter,
          fee: r.fee, tickSpacing: r.tick_spacing, hooks: r.hooks,
          amountIn: bal, firstSwapBlock: Number(r.first_swap_block), sellFrom,
        },
      );
    } catch (err) {
      /*
       * THE LADDER EXHAUSTED. Halt and RAISE — the bot must not arm with an open
       * position it cannot close.
       */
      await halt(c, chain, `boot exit exhausted on trade ${r.id}: `
        + (err as Error).message.slice(0, 160));
      await c.query(
        `update bot_trades set note = $2, updated_at = now() where id = $1`,
        [r.id, `boot exit EXHAUSTED: ${(err as Error).message.slice(0, 200)}`]);
      throw new Error(`BOOT EXIT EXHAUSTED on trade ${r.id}. THE POSITION IS STILL OPEN `
        + `and the bot has NOT armed. ${(err as Error).message.slice(0, 200)}`);
    }

    exited += 1;
    if (outcome.filledOn !== null) filledOn.push(outcome.filledOn);
    await c.query(
      `update bot_trades
          set status = 'closed', exit_attempts = $2, exit_filled_on = $3,
              note = 'boot: exited a stuck position before arming', updated_at = now()
        where id = $1`,
      [r.id, outcome.attempts.length, outcome.filledOn]);
  }

  log.info('BOOT EXIT COMPLETE', {
    found, exited, filled_on_attempts: filledOn,
    note: 'every needs_exit row is resolved; the bot may now arm',
  });
  return { found, exited, filledOn };
}
