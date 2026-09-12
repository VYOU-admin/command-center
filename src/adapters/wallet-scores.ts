/**
 * Recurring wallet scoring, EVERY token and EVERY window.
 *
 * WHY ITS OWN MONITOR RATHER THAN THE HOURLY JOB.
 *
 *   - The hourly job is per TOKEN and cursor-driven; scoring is per (token,
 *     window) and has no cursor. One hourly monitor per token would leave a
 *     token with no monitor unscored -- which is exactly how AI went a month
 *     without one.
 *   - Scoring must cover every window. A token-scoped job cannot see the
 *     others, and thresholds are per window, not per token.
 *   - It reads the database only. Coupling it to a job that spends CU means a
 *     rate limit or a ceiling stops scoring too, and a scoring bug fails row
 *     ingestion.
 *   - Scores depend on rows from ALL of a token's monitors having landed. A
 *     separate pass runs after them rather than racing inside one.
 *
 * IT WRITES `wallet_scores` AND REBUILDS `wallet_watchlist`. Rows, tags, cursors
 * and prices are untouched.
 *
 * THE WATCHLIST REBUILD LIVES HERE RATHER THAN IN ITS OWN MONITOR, for the same
 * reasons scoring is separate from the hourly job, applied one level up: it has
 * no cursor, it reads the database only, it must cover every window, and it
 * changes exactly when a score changes and at no other time. A monitor on its own
 * clock would either trail the scores or recompute an unchanged list, and could
 * read `wallet_scores` in the middle of the transaction where scoring deletes
 * orphans and re-asserts rows. See docs/ROBINHOOD.md step 17.
 *
 * The WATCHER -- what those wallets then do on the chain -- is a separate monitor,
 * for the opposite reason: it is cursor-driven and it spends compute units, and
 * coupling a free job to a metered one means a ceiling stops the free one too.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { SCORES_SCHEMA } from '../scoring/schema.js';
import { scoreWindow, type ScoreResult } from '../scoring/run.js';
import { WATCHLIST_SCHEMA, rebuildWatchlist } from '../scoring/watchlist.js';

/**
 * The cut, as a fraction. Not measured and not measurable -- there is no natural
 * break in the score distribution -- so it is an operator preference with a
 * default, set per monitor in YAML.
 */
const DEFAULT_TOP_PERCENT = 0.05;

const pending = new Map<string, ScoreResult[]>();

const adapter: SourceAdapter<ScoreResult> = {
  type: 'wallet-scores',

  /*
   * CHAIN IS REQUIRED, NOT DEFAULTED.
   *
   * The first version scored every token that had a cohort and a window row,
   * with `coalesce(tk.chain, 'robinhood')` -- so it scored MOS and USELESS,
   * which are SOLANA tokens, from a Robinhood monitor. They raised for want of
   * pump points and that was recorded as "correct". It was not: line 7 of
   * ROBINHOOD.md says Solana is a different chain and nothing here applies to
   * it. A scoping defect had been written down as correct behaviour.
   *
   * The chain is now explicit, so a Solana scoring monitor is a second config
   * rather than an accident of a default.
   */
  validate(options, monitorId) {
    const chain = options?.['chain'];
    if (typeof chain !== 'string' || chain.trim() === '') {
      throw new Error(
        `${monitorId}: wallet-scores requires a "chain" option. Scoring every token `
        + 'that happens to have a cohort crosses chains silently.',
      );
    }
    const pct = options?.['watchlist_top_percent'];
    if (pct !== undefined) {
      const n = Number(pct);
      if (!Number.isFinite(n) || n <= 0 || n > 1) {
        throw new Error(
          `${monitorId}: watchlist_top_percent must be a fraction in (0, 1]; got `
          + `${String(pct)}. 5% is 0.05, not 5.`,
        );
      }
    }
    const known = new Set(['chain', 'watchlist_top_percent']);
    const extra = Object.keys(options ?? {}).filter((k) => !known.has(k));
    if (extra.length > 0) {
      throw new Error(`${monitorId}: unexpected option(s) ${extra.join(', ')}`);
    }
  },

  async migrate(client) {
    await client.query(SCORES_SCHEMA);
    await client.query(WATCHLIST_SCHEMA);
  },

  async fetch(ctx: AdapterContext): Promise<ScoreResult[]> {
    /*
     * EVERY (token, window) THAT HAS BOTH A COHORT AND A WINDOW ROW. A tag with
     * no `token_windows` row cannot be scored at all -- metric 3 needs its
     * bounds -- and a window row with no tagged wallet is a cohort that matched
     * nothing. Both are reported rather than skipped silently.
     */
    const chain = String(ctx.options['chain']);
    const client = await ctx.db.connect();
    let targets: { chain: string; token: string; tag: string; wallets: number }[];
    let orphanTags: string[];
    let orphanWindows: string[];
    try {
      const rows = await client.query<{
        chain: string; token: string; tag: string; wallets: string; has_window: boolean;
      }>(
        `select tk.chain as chain, g.mint as token, g.tag,
                count(*)::text as wallets,
                (w.tag is not null) as has_window
           from wallet_tags g
           join tokens tk on tk.mint = g.mint
           left join token_windows w on w.mint = g.mint and w.tag = g.tag
          where tk.chain = $1
          group by 1, 2, 3, 5
          order by 2, 3`,
        [chain],
      );
      targets = rows.rows.filter((r) => r.has_window).map((r) => ({
        chain: r.chain, token: r.token, tag: r.tag, wallets: Number(r.wallets),
      }));
      orphanTags = rows.rows.filter((r) => !r.has_window).map((r) => `${r.token}/${r.tag}`);
      const wins = await client.query<{ mint: string; tag: string }>(
        `select w.mint, w.tag from token_windows w
           join tokens tk on tk.mint = w.mint
          where tk.chain = $1
            and not exists (select 1 from wallet_tags g
                             where g.mint = w.mint and g.tag = w.tag)`,
        [chain],
      );
      orphanWindows = wins.rows.map((r) => `${r.mint}/${r.tag}`);
    } finally {
      client.release();
    }

    ctx.log.info('scoring targets', {
      chain,
      windows: targets.length,
      tokens: new Set(targets.map((t) => t.token)).size,
      tags_without_a_window_row: orphanTags.length,
      tags_without_a_window_row_list: orphanTags,
      window_rows_with_no_tagged_wallet: orphanWindows.length,
      window_rows_with_no_tagged_wallet_list: orphanWindows,
    });
    if (targets.length === 0) {
      throw new Error(
        'no (token, window) pair has both a cohort and a window row. Scoring every '
        + 'token cannot mean scoring none; this is a defect, not an empty result.',
      );
    }

    /*
     * ONE UNSCOREABLE WINDOW MUST NOT BLOCK THE REST, AND MUST NOT BE SWALLOWED.
     * MOS and USELESS carry cohorts and window rows from the first intake but no
     * pump points, so scoreWindow raises for them -- correctly, since metrics 5
     * and 6 are defined against pump points. Letting that abort the pass left
     * every other token stale, which is the fault this monitor exists to fix.
     *
     * So: each window is scored independently, every failure is recorded with
     * its reason, and the RUN still fails at the end if any did. Nothing is
     * counted as zero and nothing is hidden.
     */
    const out: ScoreResult[] = [];
    const failures: { token: string; tag: string; error: string }[] = [];
    for (const t of targets) {
      /*
       * The threshold is RE-DERIVED per window on every run, and both quality
       * flags are recomputed and REPLACED. A flag whose condition no longer
       * holds has to disappear: `inflated-pnl` must clear itself once the
       * transfers that explain a negative position are collected.
       */
      try {
        const r = await scoreWindow(ctx.db as never, t.chain, t.token, t.tag,
          { write: true, top: 0 });
        out.push(r);
        ctx.log.info('scored', {
          token: t.token, tag: t.tag, cohort: r.cohort, written: r.written,
          low_weight_threshold: r.lowWeightThreshold, derived: r.lowWeightDerived,
          flags: r.flags,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ token: t.token, tag: t.tag, error: message });
        ctx.log.error('window could not be scored', { token: t.token, tag: t.tag, error: message });
      }
    }

    ctx.log.info('scoring pass complete', {
      windows_scored: out.length,
      windows_failed: failures.length,
      failures,
    });
    if (failures.length > 0) {
      /*
       * AND THE RUN FAILS. Queueing an alert and returning normally left
       * last_status = "success" while windows went unscored -- the comment above
       * said the run fails and the code did not, which is the same
       * document-says-one-thing shape this file exists to avoid. The successful
       * windows are already written; throwing after them loses nothing.
       */
      ctx.queueAlert({
        title: `${ctx.monitorName}: ${failures.length} window(s) could not be scored`,
        description: failures.map((f) => `${f.token} / ${f.tag}: ${f.error}`).join('\n\n')
          + `\n\n${out.length} window(s) scored successfully and were written.`,
        level: 'warning',
      }, 'system');
      throw new Error(
        `${failures.length} of ${targets.length} window(s) could not be scored: `
        + failures.map((f) => `${f.token}/${f.tag}`).join(', ')
        + `. ${out.length} were scored and written.`,
      );
    }
    /*
     * THE WATCHLIST IS REBUILT ONLY AFTER EVERY WINDOW SCORED. It is a cut across
     * all of them, so building it while one window still carries stale scores
     * would silently mix a fresh cut with an old one. The throw above already
     * guarantees we only reach here when none failed; this comment records that
     * the ordering is deliberate rather than incidental.
     */
    const topPercent = ctx.options['watchlist_top_percent'] === undefined
      ? DEFAULT_TOP_PERCENT
      : Number(ctx.options['watchlist_top_percent']);
    const wlClient = await ctx.db.connect();
    try {
      const wl = await rebuildWatchlist(wlClient, chain, topPercent);
      ctx.log.info('watchlist rebuilt', {
        top_percent: wl.topPercent,
        qualifying_rows: wl.qualifyingRows,
        distinct_wallets: wl.distinctWallets,
        in_two_or_more_windows: wl.inTwoOrMoreWindows,
        in_two_or_more_tokens: wl.inTwoOrMoreTokens,
        memberships_added: wl.added,
        memberships_removed: wl.removed,
        note: 'the cut is per window; the merge is a union, never a re-ranking -- '
          + 'scores are min-maxed within a cohort and do not compare across windows',
        windows: wl.windows,
      });
    } finally {
      wlClient.release();
    }

    pending.set(ctx.monitorId, out);
    return out;
  },

  /* The scoring pass writes wallet_scores itself; nothing further to persist. */
  async persist(ctx): Promise<number> {
    const done = pending.get(ctx.monitorId) ?? [];
    pending.delete(ctx.monitorId);
    return done.reduce((n, r) => n + r.written, 0);
  },
};

export default adapter;
