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
  const rows = await c.query<{ id: string; token: string; status: string; entry_tx: string | null }>(
    `select id::text, token, status, entry_tx from bot_trades
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
      const data = BALANCE_OF + '0'.repeat(24) + wallet.slice(2).toLowerCase();
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
