/**
 * The watchlist, derived from wallet_pnl and wallet_clusters at read time.
 *
 * READ-ONLY on both tables; this monitor never writes to them.
 *
 * THREE SOURCES, UNIONED. The third is not redundant: 20 wallets appear in two
 * or more robinhood cohorts while having no positive realized PnL and no
 * cluster membership, so the first two rules drop exactly the wallets whose
 * cross-token presence makes them most interesting.
 */
import type { Pool } from '../../store/db.js';

export interface WatchWallet {
  wallet: string;
  cohorts: number;
  totalRealizedUsd: number;
  crossToken: boolean;
}

export async function loadWatchlist(db: Pool, chain: string): Promise<WatchWallet[]> {
  const { rows } = await db.query(
    `with pnl_positive as (
       select lower(wallet) w from wallet_pnl
        where chain = $1 and realized_pnl_usd > 0),
     clustered as (
       select lower(wallet) w from wallet_clusters where chain = $1),
     agg as (
       select lower(wallet) w, count(distinct token)::int cohorts,
              sum(realized_pnl_usd) total
         from wallet_pnl where chain = $1 group by 1),
     cross_token as (
       select w from agg where cohorts >= 2),
     wl as (
       select w from pnl_positive
       union select w from clustered
       union select w from cross_token)
     select wl.w as wallet,
            coalesce(a.cohorts, 0)::int as cohorts,
            coalesce(a.total, 0)::float8 as total,
            (coalesce(a.cohorts, 0) >= 2) as cross_token
       from wl left join agg a on a.w = wl.w
      order by wl.w`,
    [chain],
  );
  return rows.map((r: Record<string, unknown>) => ({
    wallet: String(r.wallet),
    cohorts: Number(r.cohorts ?? 0),
    totalRealizedUsd: Number(r.total ?? 0),
    crossToken: r.cross_token === true,
  }));
}
