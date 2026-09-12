/**
 * The watchlist: the top N% of every scored window, merged into one cross-token
 * wallet list for the chain. docs/ROBINHOOD.md step 17.
 *
 * READS `wallet_scores` ONLY, AND IS REBUILT INSIDE THE SCORING RUN. It has no
 * cursor, spends nothing, and changes exactly when a score changes -- so a
 * separate schedule would either trail the scores or recompute an unchanged
 * list, and a separate reader could land inside the transaction where scoring
 * deletes orphans and re-asserts rows.
 *
 * THE CUT IS PER WINDOW AND THE MERGE IS A UNION, NEVER A RE-RANKING. Scores are
 * min-maxed within their own cohort, so they do not compare across windows, and
 * the 5% cut proves it: INDEX-P1's cutoff of 0.6689 is ABOVE PONS-P1's maximum
 * of 0.6025, while AI-P1's cutoff of 0.2644 is BELOW PONS-P1's median of 0.3440.
 * Sorting the merged list by score, or taking a global top N%, would rank
 * quantities that have no common scale.
 *
 * A NULL SCORE IS NEVER ELIGIBLE, AND THE ORDERING HAS TO SAY SO TWICE.
 * `order by score desc` is NULLS FIRST in Postgres, so the null-score wallets
 * occupy ranks 1..n of every window -- PONS's 88 nulls take ranks 1-88 of 13,823
 * and would fill 12.7% of its allocation, displacing 88 genuine top scorers. The
 * ranking therefore excludes null scores outright AND orders NULLS LAST, and the
 * count excluded is reported. A null score means every metric was null; that is
 * an unmeasured wallet, not a top one.
 *
 * THE DENOMINATOR IS THE WHOLE COHORT, not the scored subset. "Top 5% of the
 * cohort" is what was asked for, so the slot count is `ceil(cohort * pct)` and
 * the slots are filled from the wallets that have a score. Today nulls are far
 * fewer than the slots in every window, so the two readings coincide -- but they
 * would not on a cohort that was mostly unscoreable, and then the cohort is the
 * honest denominator.
 *
 * FLAGGED WALLETS ARE KEPT AND LABELLED. `inflated-pnl` usually means a transfer
 * has not been collected yet and clears itself once it is; `low-weight` is a
 * statement about our data, not about the wallet. Dropping either would be wrong
 * in both directions. But 166 of the 169 low-weight entries are INDEX-P1, whose
 * whole top 5% rests on 30% of the weight because its window spans the era where
 * 6,052 INDEX rows have no USD -- so a list that did not carry the flag would
 * present that artefact as signal.
 */

import type { PoolClient } from '../store/db.js';

export const WATCHLIST_SCHEMA = `
create table if not exists wallet_watchlist (
  chain          text        not null,
  wallet         text        not null,
  token          text        not null,
  tag            text        not null,
  score          numeric     not null,
  rank_in_window integer     not null,
  cohort_size    integer     not null,
  slots          integer     not null,
  weight_used    numeric,
  flags          text[]      not null default '{}',
  top_percent    numeric     not null,
  qualified_at   timestamptz not null default now(),
  primary key (chain, wallet, token, tag)
);

create index if not exists wallet_watchlist_chain_wallet_idx
  on wallet_watchlist (chain, wallet);
`;

export interface WatchlistWindow {
  token: string;
  tag: string;
  cohortSize: number;
  scored: number;
  nullScores: number;
  slots: number;
  admitted: number;
  cutoffScore: number | null;
  maxScore: number | null;
  lowWeight: number;
  inflatedPnl: number;
}

export interface WatchlistReport {
  topPercent: number;
  windows: WatchlistWindow[];
  qualifyingRows: number;
  distinctWallets: number;
  inTwoOrMoreWindows: number;
  inTwoOrMoreTokens: number;
  removed: number;
  added: number;
}

/**
 * Rebuild the chain's watchlist from the scores as they stand.
 *
 * Runs in one transaction. A membership that no longer qualifies is DELETED, not
 * left behind: this is the fourth table derived from a cohort membership, and the
 * three before it -- `wallet_tags`, `wallet_scores` and the rows for dropped
 * wallets -- were all upsert-only and all kept members the cohort no longer had.
 */
export async function rebuildWatchlist(
  client: PoolClient,
  chain: string,
  topPercent: number,
): Promise<WatchlistReport> {
  if (!(topPercent > 0 && topPercent <= 1)) {
    throw new Error(
      `watchlist top_percent must be in (0, 1]; got ${topPercent}. It is a fraction, `
      + 'not a percentage.',
    );
  }

  await client.query('begin');
  try {
    /*
     * The eligible set, materialised. Every figure reported below and every row
     * written comes from this one table, so the report cannot describe a
     * different set from the one stored -- the two-derivations fault step 9
     * records.
     */
    await client.query(`
      create temp table _wl as
      with cohort as (
        select token, tag, count(*)::int as cohort_size,
               count(score)::int as scored,
               (count(*) - count(score))::int as null_scores
          from wallet_scores where chain = $1
         group by token, tag
      ), ranked as (
        select s.token, s.tag, s.wallet, s.score, s.weight_used,
               coalesce(s.flags, '{}'::text[]) as flags,
               row_number() over (
                 partition by s.token, s.tag order by s.score desc nulls last
               )::int as rnk
          from wallet_scores s
         where s.chain = $1 and s.score is not null
      )
      select r.token, r.tag, r.wallet, r.score, r.weight_used, r.flags, r.rnk,
             c.cohort_size, c.scored, c.null_scores,
             ceil(c.cohort_size * $2::numeric)::int as slots
        from ranked r
        join cohort c on c.token = r.token and c.tag = r.tag
       where r.rnk <= ceil(c.cohort_size * $2::numeric)::int
    `, [chain, topPercent]);
    await client.query('create index on _wl (token, tag)');
    await client.query('analyze _wl');

    const before = await client.query<{ n: string }>(
      'select count(*)::text n from wallet_watchlist where chain = $1', [chain],
    );

    const removed = await client.query(
      `delete from wallet_watchlist w
        where w.chain = $1
          and not exists (
            select 1 from _wl x
             where x.wallet = w.wallet and x.token = w.token and x.tag = w.tag
          )`,
      [chain],
    );

    const added = await client.query(
      `insert into wallet_watchlist
         (chain, wallet, token, tag, score, rank_in_window, cohort_size, slots,
          weight_used, flags, top_percent)
       select $1, wallet, token, tag, score, rnk, cohort_size, slots,
              weight_used, flags, $2::numeric
         from _wl
       on conflict (chain, wallet, token, tag) do update
         set score          = excluded.score,
             rank_in_window = excluded.rank_in_window,
             cohort_size    = excluded.cohort_size,
             slots          = excluded.slots,
             weight_used    = excluded.weight_used,
             flags          = excluded.flags,
             top_percent    = excluded.top_percent
       returning (xmax = 0) as inserted`,
      [chain, topPercent],
    );

    const windows = await client.query<{
      token: string; tag: string; cohort_size: number; scored: number;
      null_scores: number; slots: number; admitted: number;
      cutoff: string | null; max: string | null; low_weight: number; inflated: number;
    }>(`
      select token, tag,
             max(cohort_size)::int as cohort_size,
             max(scored)::int      as scored,
             max(null_scores)::int as null_scores,
             max(slots)::int       as slots,
             count(*)::int         as admitted,
             min(score)::text      as cutoff,
             max(score)::text      as max,
             count(*) filter (where 'low-weight'   = any(flags))::int as low_weight,
             count(*) filter (where 'inflated-pnl' = any(flags))::int as inflated
        from _wl group by token, tag order by token, tag
    `);

    const merged = await client.query<{
      rows: string; wallets: string; two_windows: string; two_tokens: string;
    }>(`
      select count(*)::text as rows,
             count(distinct wallet)::text as wallets,
             (select count(*)::text from (
                select wallet from _wl group by wallet having count(*) > 1) a) as two_windows,
             (select count(*)::text from (
                select wallet from _wl group by wallet
                 having count(distinct token) > 1) b) as two_tokens
        from _wl
    `);

    /*
     * VERIFY INSIDE THE TRANSACTION. The statements having run is not evidence
     * the table holds the list; this is the record the alert and the dashboard
     * read. A mismatch rolls the whole rebuild back.
     */
    const stored = await client.query<{ n: string }>(
      'select count(*)::text n from wallet_watchlist where chain = $1', [chain],
    );
    const expect = Number(merged.rows[0]!.rows);
    if (Number(stored.rows[0]!.n) !== expect) {
      throw new Error(
        `after rebuilding the watchlist the table holds ${stored.rows[0]!.n} rows for `
        + `${chain} but the computed list has ${expect}. Rolling back.`,
      );
    }

    await client.query('drop table _wl');
    await client.query('commit');

    const insertedCount = added.rows.filter((r) => (r as { inserted: boolean }).inserted).length;
    return {
      topPercent,
      windows: windows.rows.map((w) => ({
        token: w.token, tag: w.tag,
        cohortSize: w.cohort_size, scored: w.scored, nullScores: w.null_scores,
        slots: w.slots, admitted: w.admitted,
        cutoffScore: w.cutoff === null ? null : Number(w.cutoff),
        maxScore: w.max === null ? null : Number(w.max),
        lowWeight: w.low_weight, inflatedPnl: w.inflated,
      })),
      qualifyingRows: expect,
      distinctWallets: Number(merged.rows[0]!.wallets),
      inTwoOrMoreWindows: Number(merged.rows[0]!.two_windows),
      inTwoOrMoreTokens: Number(merged.rows[0]!.two_tokens),
      removed: removed.rowCount ?? 0,
      added: insertedCount,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  }
}
