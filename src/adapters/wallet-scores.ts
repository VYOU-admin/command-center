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
 * IT WRITES ONLY `wallet_scores`. Rows, tags, cursors and prices are untouched.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { SCORES_SCHEMA } from '../scoring/schema.js';
import { scoreWindow, type ScoreResult } from '../scoring/run.js';

const pending = new Map<string, ScoreResult[]>();

const adapter: SourceAdapter<ScoreResult> = {
  type: 'wallet-scores',

  /* Nothing to configure: it scores every token and window it finds. A typo in
   * options would otherwise pass silently, so unknown keys are rejected. */
  validate(options, monitorId) {
    const keys = Object.keys(options ?? {});
    if (keys.length > 0) {
      throw new Error(
        `${monitorId}: wallet-scores takes no options, got ${keys.join(', ')}. `
        + 'It scores every token and window that has both a cohort and a window row.',
      );
    }
  },

  async migrate(client) {
    await client.query(SCORES_SCHEMA);
  },

  async fetch(ctx: AdapterContext): Promise<ScoreResult[]> {
    /*
     * EVERY (token, window) THAT HAS BOTH A COHORT AND A WINDOW ROW. A tag with
     * no `token_windows` row cannot be scored at all -- metric 3 needs its
     * bounds -- and a window row with no tagged wallet is a cohort that matched
     * nothing. Both are reported rather than skipped silently.
     */
    const client = await ctx.db.connect();
    let targets: { chain: string; token: string; tag: string; wallets: number }[];
    let orphanTags: string[];
    let orphanWindows: string[];
    try {
      const rows = await client.query<{
        chain: string; token: string; tag: string; wallets: string; has_window: boolean;
      }>(
        `select coalesce(tk.chain, 'robinhood') as chain,
                g.mint as token, g.tag,
                count(*)::text as wallets,
                (w.tag is not null) as has_window
           from wallet_tags g
           left join token_windows w on w.mint = g.mint and w.tag = g.tag
           left join tokens tk on tk.mint = g.mint
          group by 1, 2, 3, 5
          order by 2, 3`,
      );
      targets = rows.rows.filter((r) => r.has_window).map((r) => ({
        chain: r.chain, token: r.token, tag: r.tag, wallets: Number(r.wallets),
      }));
      orphanTags = rows.rows.filter((r) => !r.has_window).map((r) => `${r.token}/${r.tag}`);
      const wins = await client.query<{ mint: string; tag: string }>(
        `select w.mint, w.tag from token_windows w
          where not exists (select 1 from wallet_tags g
                             where g.mint = w.mint and g.tag = w.tag)`,
      );
      orphanWindows = wins.rows.map((r) => `${r.mint}/${r.tag}`);
    } finally {
      client.release();
    }

    ctx.log.info('scoring targets', {
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
      ctx.queueAlert({
        title: `${ctx.monitorName}: ${failures.length} window(s) could not be scored`,
        description: failures.map((f) => `${f.token} / ${f.tag}: ${f.error}`).join('\n\n')
          + `\n\n${out.length} window(s) scored successfully and were written.`,
        level: 'warning',
      }, 'system');
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
