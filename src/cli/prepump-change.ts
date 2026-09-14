/**
 * `npm run prepump-change -- <chain> --snapshot <label>`
 * `npm run prepump-change -- <chain> --report <label> [--top-percent 0.05]`
 *
 * Measures what a SCORING DEFINITION CHANGE moves, before any of it is written.
 * Built 2026-09-14 for metric 5 going from the mean over pumps to the maximum
 * (docs/ROBINHOOD.md step 13), and deliberately written to be reusable: it is
 * about comparing two definitions, not about that one metric.
 *
 * WHY A SNAPSHOT STEP EXISTS AT ALL. The `wallet-scores` monitor runs every 30
 * minutes AND on container boot, so the moment the new definition is deployed it
 * re-scores every window and the old values are gone. The "before" therefore has
 * to be captured into a table BEFORE the deploy -- a file under /app would not
 * survive the redeploy that ships the change, which section 3 records.
 *
 * WHY THE "AFTER" COMES FROM `scoreWindow` AND NOT FROM A LOCAL RECOMPUTATION.
 * Reimplementing the metric here to predict its effect would be a second
 * implementation of the rule being changed -- the trap step 7 records four times
 * -- and it would be wrong in exactly the case that matters, where the two
 * disagree. This runs the real scorer with `write: false` and reads its
 * per-wallet output.
 *
 * IT WRITES NOTHING except the snapshot table, and spends no compute units.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { scoreWindow } from '../scoring/run.js';

const SNAPSHOT_SCHEMA = `
create table if not exists score_definition_snapshots (
  label       text        not null,
  chain       text        not null,
  token       text        not null,
  tag         text        not null,
  wallet      text        not null,
  score       numeric,
  metric_raw  numeric,
  captured_at timestamptz not null default now(),
  primary key (label, chain, token, tag, wallet)
);
`;

/** The metric under comparison. Named once so the report cannot drift from it. */
const METRIC = 'prePumpShare';

interface Target { chain: string; token: string; tag: string }

async function targets(client: {
  query: (q: string, p: unknown[]) => Promise<{ rows: Target[] }>;
}, chain: string): Promise<Target[]> {
  /*
   * THE SAME ENUMERATION THE MONITOR USES: a window is scoreable when it has
   * both a cohort and a `token_windows` row. Selecting them any other way here
   * would compare a different set from the one that gets re-scored.
   */
  const r = await client.query(
    `select tk.chain as chain, g.mint as token, g.tag as tag
       from wallet_tags g
       join tokens tk on tk.mint = g.mint
       join token_windows w on w.mint = g.mint and w.tag = g.tag
      where tk.chain = $1
      group by 1, 2, 3
      order by 2, 3`,
    [chain],
  );
  return r.rows;
}

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo]! : sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (i - lo);
}

function describe(values: (number | null)[], pumps: number): Record<string, unknown> {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const sorted = [...present].sort((a, b) => a - b);
  const ceiling = pumps > 0 ? 1 / pumps : null;
  const EPS = 1e-12;
  return {
    n: values.length,
    null: values.length - present.length,
    zero: present.filter((v) => v === 0).length,
    min: sorted.length ? sorted[0] : null,
    max: sorted.length ? sorted[sorted.length - 1] : null,
    mean: present.length ? present.reduce((s, x) => s + x, 0) / present.length : null,
    p50: quantile(sorted, 0.5),
    p90: quantile(sorted, 0.9),
    p99: quantile(sorted, 0.99),
    // Reported for both definitions so the ceiling's disappearance is visible
    // rather than asserted.
    at_old_ceiling_1_over_n: ceiling === null
      ? null : present.filter((v) => Math.abs(v - ceiling) < EPS).length,
    above_old_ceiling_1_over_n: ceiling === null
      ? null : present.filter((v) => v > ceiling + EPS).length,
    at_1: present.filter((v) => Math.abs(v - 1) < EPS).length,
  };
}

/** Rank exactly as the watchlist does: score desc, NULLS LAST, nulls excluded. */
function ranked(rows: { wallet: string; score: number | null }[]): Map<string, number> {
  const scored = rows.filter((r) => r.score !== null)
    .sort((a, b) => (b.score! - a.score!) || a.wallet.localeCompare(b.wallet));
  const out = new Map<string, number>();
  scored.forEach((r, i) => out.set(r.wallet, i + 1));
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const chain = args.find((a) => !a.startsWith('--')) ?? 'robinhood';
  const flag = (f: string): string | undefined => {
    const i = args.indexOf(f);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const snapshotLabel = flag('--snapshot');
  const reportLabel = flag('--report');
  const topPercent = Number(flag('--top-percent') ?? '0.05');
  if (!snapshotLabel && !reportLabel) {
    throw new Error('usage: prepump-change <chain> --snapshot <label> | --report <label>');
  }
  if (!(topPercent > 0 && topPercent <= 1)) {
    throw new Error(`--top-percent must be in (0, 1]; got ${topPercent}`);
  }

  const app = await bootstrap();
  const client = await app.pool.connect();
  try {
    await client.query(SNAPSHOT_SCHEMA);
    const list = await targets(client as never, chain);
    if (list.length === 0) {
      throw new Error(
        `no (token, window) pair on chain "${chain}" has both a cohort and a window `
        + 'row. A target list matching nothing is a suspected defect, not an empty set.',
      );
    }
    log.info('windows', { chain, windows: list.length, list: list.map((t) => t.tag) });

    /* ---------------- snapshot: capture the CURRENT stored scores --------- */
    if (snapshotLabel) {
      let total = 0;
      for (const t of list) {
        const r = await client.query(
          `insert into score_definition_snapshots
             (label, chain, token, tag, wallet, score, metric_raw)
           select $1, chain, token, tag, wallet, score,
                  (metrics->'raw'->>$5)::numeric
             from wallet_scores
            where chain = $2 and token = $3 and tag = $4
           on conflict (label, chain, token, tag, wallet) do update
             set score = excluded.score, metric_raw = excluded.metric_raw,
                 captured_at = now()`,
          [snapshotLabel, t.chain, t.token, t.tag, METRIC],
        );
        total += r.rowCount ?? 0;
        log.info('snapshot', { tag: t.tag, rows: r.rowCount ?? 0 });
      }
      /*
       * A snapshot of nothing would make every later comparison read "no
       * change". It is a defect, not a clean pass.
       */
      if (total === 0) {
        throw new Error(
          `snapshot "${snapshotLabel}" captured 0 rows across ${list.length} windows. `
          + 'wallet_scores is empty for this chain, which is a defect, not an empty result.',
        );
      }
      log.info('SNAPSHOT STORED', {
        label: snapshotLabel, windows: list.length, rows: total, metric: METRIC,
        note: 'this is the BEFORE. Deploy the new definition, then --report the same label.',
      });
      return;
    }

    /* ---------------- report: run the real scorer, write nothing ---------- */
    const label = reportLabel!;
    const perWindow: Record<string, unknown>[] = [];
    let entersAll = 0;
    let leavesAll = 0;

    for (const t of list) {
      const beforeRows = await client.query<{ wallet: string; score: string | null;
        metric_raw: string | null }>(
        `select wallet, score::text, metric_raw::text
           from score_definition_snapshots
          where label = $1 and chain = $2 and token = $3 and tag = $4`,
        [label, t.chain, t.token, t.tag],
      );
      if (beforeRows.rowCount === 0) {
        throw new Error(
          `snapshot "${label}" holds no rows for ${t.tag}. Comparing against a missing `
          + 'baseline would report "nothing moved" for a window nobody measured.',
        );
      }

      const after = await scoreWindow(app.pool, t.chain, t.token, t.tag,
        { write: false, top: 0, detail: true });
      if (!after.wallets) throw new Error('scoreWindow returned no per-wallet detail');

      const pumpsRow = await client.query<{ n: string }>(
        `select count(*)::text n from token_events
          where chain = $1 and token = $2 and kind = 'pump'`,
        [t.chain, t.token],
      );
      const pumps = Number(pumpsRow.rows[0]!.n);

      const beforeByWallet = new Map(beforeRows.rows.map((r) => [r.wallet, r]));
      const afterByWallet = new Map(after.wallets.map((w) => [w.wallet, w]));

      /*
       * Compare over the wallets present in BOTH. A cohort change between the
       * snapshot and now would otherwise read as a rank change caused by this
       * definition, which it is not -- so the count of wallets on only one side
       * is reported rather than quietly dropped.
       */
      const common = [...afterByWallet.keys()].filter((w) => beforeByWallet.has(w));
      const onlyBefore = beforeRows.rows.length - common.length;
      const onlyAfter = after.wallets.length - common.length;

      const bMetric = common.map((w) => {
        const v = beforeByWallet.get(w)!.metric_raw;
        return v === null ? null : Number(v);
      });
      const aMetric = common.map((w) => afterByWallet.get(w)!.raw.prePumpShare);

      const bRank = ranked(common.map((w) => ({
        wallet: w,
        score: beforeByWallet.get(w)!.score === null
          ? null : Number(beforeByWallet.get(w)!.score),
      })));
      const aRank = ranked(common.map((w) => ({
        wallet: w, score: afterByWallet.get(w)!.score,
      })));

      let moved = 0;
      let movedOver10 = 0;
      let maxMove = 0;
      for (const w of common) {
        const b = bRank.get(w);
        const a = aRank.get(w);
        if (b === undefined || a === undefined) continue;
        const d = Math.abs(a - b);
        if (d > 0) moved += 1;
        if (d > 10) movedOver10 += 1;
        if (d > maxMove) maxMove = d;
      }

      // The cut, exactly as watchlist.ts takes it: ceil(cohort * pct) over the
      // wallets that have a score, ordered desc nulls last.
      const slots = Math.ceil(common.length * topPercent);
      const cutoffOf = (rk: Map<string, number>,
        scoreOf: (w: string) => number | null): number | null => {
        const at = common.find((w) => rk.get(w) === slots);
        return at === undefined ? null : scoreOf(at);
      };
      const bCut = cutoffOf(bRank, (w) => {
        const v = beforeByWallet.get(w)!.score; return v === null ? null : Number(v);
      });
      const aCut = cutoffOf(aRank, (w) => afterByWallet.get(w)!.score);

      const bTop = new Set(common.filter((w) => (bRank.get(w) ?? Infinity) <= slots));
      const aTop = new Set(common.filter((w) => (aRank.get(w) ?? Infinity) <= slots));
      const enters = [...aTop].filter((w) => !bTop.has(w));
      const leaves = [...bTop].filter((w) => !aTop.has(w));
      entersAll += enters.length;
      leavesAll += leaves.length;

      const row = {
        tag: t.tag,
        token: t.token,
        pumps,
        wallets_compared: common.length,
        in_snapshot_only: onlyBefore,
        in_cohort_only: onlyAfter,
        metric_before: describe(bMetric, pumps),
        metric_after: describe(aMetric, pumps),
        wallets_whose_metric_changed: common.filter((_w, i) => {
          const b = bMetric[i] ?? null;
          const a = aMetric[i] ?? null;
          if (b === null && a === null) return false;
          if (b === null || a === null) return true;
          return Math.abs(a - b) > 1e-12;
        }).length,
        rank_changed: moved,
        rank_changed_by_more_than_10: movedOver10,
        largest_rank_move: maxMove,
        slots_at_top_percent: slots,
        cutoff_before: bCut,
        cutoff_after: aCut,
        cutoff_delta: bCut !== null && aCut !== null ? aCut - bCut : null,
        top_slice_enters: enters.length,
        top_slice_leaves: leaves.length,
        enters_list: enters.slice(0, 20),
        leaves_list: leaves.slice(0, 20),
      };
      perWindow.push(row);
      log.info('window compared', row);
    }

    /*
     * Reported even when every figure is zero: a window where nothing moves is a
     * result, and an omitted line is indistinguishable from a window nobody
     * measured.
     */
    log.info('TOTAL', {
      windows: perWindow.length,
      top_percent: topPercent,
      predicted_watchlist_enters: entersAll,
      predicted_watchlist_leaves: leavesAll,
      note: 'PREDICTED from the per-window cut. The watchlist proper is a UNION across '
        + 'windows, so a wallet leaving one window and holding another is still on the '
        + 'list -- compare wallet_watchlist before and after the rebuild for the truth.',
      wrote: 'nothing',
    });
  } finally {
    client.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('prepump-change failed', errorFields(err));
  process.exit(1);
});
