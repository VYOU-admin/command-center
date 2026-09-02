/**
 * The watchlist: Group 2 wallets with realized PnL at or above a threshold.
 *
 * DERIVED AT READ TIME, never stored. Group membership and PnL both change when
 * a token is re-run, and a stored copy would silently go stale.
 *
 * READ-ONLY on wallet_groups and wallet_pnl; this monitor never writes them.
 *
 * REALIZED, NOT TOTAL. Group 2 is "bought and sold", so realized PnL describes
 * what these wallets actually did; unrealized PnL is a mark on whatever they
 * still hold, which is a different claim. At $1,000 the choice is 334 rows
 * against 422 on a realized+unrealized basis, so it is not cosmetic.
 */
import type { Pool } from '../../store/db.js';

export async function loadWatchlist(
  db: Pool, chain: string, minRealizedUsd: number,
): Promise<string[]> {
  const { rows } = await db.query(
    `select distinct lower(p.wallet) as wallet
       from wallet_groups g
       join wallet_pnl p on p.token = g.token and p.wallet = g.wallet
      where g.group_no = 2 and g.chain = $1 and p.realized_pnl_usd >= $2
      order by 1`,
    [chain, minRealizedUsd],
  );
  return rows.map((r: Record<string, unknown>) => String(r.wallet));
}
