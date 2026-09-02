/**
 * The watchlist: every Group 1 wallet across the six Robinhood tokens.
 *
 * DERIVED AT READ TIME, never stored. Group membership is rewritten wholesale
 * whenever run_token.py re-runs a token, so a stored copy would go stale silently.
 *
 * DEDUPLICATED, and that matters: the per-token counts sum to 2,991 but 35
 * wallets sit in two cohorts, so the real list is 2,956. Scanning the raw sum
 * would issue an extra chunk of requests for wallets already covered.
 *
 * NO PnL FILTER, unlike group2. Group 1 is "bought and never sold", so realized
 * PnL is zero or near it by definition -- filtering on it would empty the list.
 *
 * READ-ONLY on wallet_groups; this monitor never writes it.
 */
import type { Pool } from '../../store/db.js';

export async function loadWatchlist(
  db: Pool, chain: string, tokens: string[],
): Promise<string[]> {
  const { rows } = await db.query(
    `select distinct lower(wallet) as wallet
       from wallet_groups
      where group_no = 1 and chain = $1 and token = any($2::text[])
      order by 1`,
    [chain, tokens],
  );
  return rows.map((r: Record<string, unknown>) => String(r.wallet));
}
