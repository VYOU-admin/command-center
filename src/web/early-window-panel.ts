/**
 * Early-window dashboard panel.
 *
 * Answers one question: of the tokens tracked in the last 24 hours, how many
 * were up and how many down at +20m, +1h, +3h and +6h, measured from their
 * price at 5 minutes.
 *
 * The 5-minute baseline matters. Measuring from launch would make almost
 * everything look enormous, because the first seconds include the deployer's
 * own opening buy; measuring from 5 minutes asks the question an observer could
 * actually have acted on.
 *
 * Every row states how many tokens reached the mark and how many died first.
 * A return distribution over survivors alone reads far better than reality, so
 * the deaths are shown next to it rather than in a footnote.
 */

import type { PanelContext } from '../adapters/types.js';
import { escapeHtml } from './views.js';

interface Row {
  mark: number;
  reached: number;
  died_before: number;
  up: number;
  down: number;
  flat: number;
  median_pct: string | number | null;
  p90_pct: string | number | null;
}

const MARKS: [number, string][] = [
  [1200, '+20m'],
  [3600, '+1h'],
  [10800, '+3h'],
  [21600, '+6h'],
];
/** Tolerance when matching a snapshot to a mark, in seconds. */
const TOL = 90;
const BASELINE = 300;

function n(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const p = typeof v === 'string' ? Number.parseFloat(v) : v;
  return Number.isFinite(p) ? p : null;
}

const pct = (v: number | null): string =>
  v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;

export async function renderEarlyWindowPanel(ctx: PanelContext): Promise<string> {
  const result = await ctx.db.query(
    `with tracked as (
       select mint, launched_at, died, died_at, graduated, sample_reason
         from early_tokens
        where monitor_id = $1 and launched_at > now() - interval '24 hours'
     ),
     base as (
       select distinct on (s.mint) s.mint, s.price_sol
         from early_snapshots s
         join tracked t on t.mint = s.mint
        where s.monitor_id = $1
          and s.seconds_since_launch between $2::numeric - $3::numeric and $2::numeric + $3::numeric
          and s.price_sol > 0
        order by s.mint, abs(s.seconds_since_launch - $2::numeric)
     ),
     marks as (select * from unnest($4::numeric[]) as m(mark)),
     matched as (
       select t.mint, m.mark, b.price_sol as base_price,
              (select s.price_sol from early_snapshots s
                where s.monitor_id = $1 and s.mint = t.mint
                  and s.seconds_since_launch between m.mark - $3::numeric and m.mark + $3::numeric
                order by abs(s.seconds_since_launch - m.mark) limit 1) as mark_price,
              -- Reaching the mark means the token was still alive then, whether
              -- or not a snapshot happens to exist for it.
              (t.died and t.died_at is not null
                 and t.died_at < t.launched_at + (m.mark::text || ' seconds')::interval) as died_first
         from tracked t
         cross join marks m
         join base b on b.mint = t.mint
     )
     select mark::int,
            count(*) filter (where mark_price is not null)::int reached,
            count(*) filter (where died_first)::int died_before,
            count(*) filter (where mark_price is not null and mark_price > base_price * 1.001)::int up,
            count(*) filter (where mark_price is not null and mark_price < base_price * 0.999)::int down,
            count(*) filter (where mark_price is not null
                             and mark_price between base_price * 0.999 and base_price * 1.001)::int flat,
            percentile_cont(0.5) within group (
              order by case when mark_price is not null then (mark_price / base_price - 1) * 100 end
            ) median_pct,
            percentile_cont(0.9) within group (
              order by case when mark_price is not null then (mark_price / base_price - 1) * 100 end
            ) p90_pct
       from matched group by mark order by mark`,
    [ctx.monitorId, BASELINE, TOL, MARKS.map((m) => m[0])],
  );

  const totals = await ctx.db.query(
    `select count(*)::int tracked,
            count(*) filter (where sample_reason = 'random')::int random,
            count(*) filter (where sample_reason = 'graduate')::int graduate,
            count(*) filter (where graduated)::int graduated,
            count(*) filter (where died)::int died,
            count(*) filter (where tracking_stopped_at is null)::int still_tracking,
            (select count(*)::int from early_snapshots
              where monitor_id = $1 and snapshot_at > now() - interval '24 hours') snapshots,
            (select count(*)::int from early_snapshots
              where monitor_id = $1 and mcap_sol is null) mcap_missing
       from early_tokens where monitor_id = $1 and launched_at > now() - interval '24 hours'`,
    [ctx.monitorId],
  );

  const t = totals.rows[0] ?? {};
  const rows = result.rows as Row[];
  const byMark = new Map(rows.map((r) => [Number(r.mark), r]));

  const header =
    `<h2 class="section">${escapeHtml(ctx.monitorName)}</h2>` +
    `<p class="panel-meta">Tokens tracked in the last 24h, measured from their price at ` +
    `<strong>5 minutes</strong> — not from launch, which would fold in the deployer's own ` +
    `opening buy. Collection only: nothing here is scored, filtered or alerted on.</p>`;

  const summary =
    `<div class="cards stats">` +
    ([
      ['Tracked (24h)', String(t.tracked ?? 0), `${t.random ?? 0} sampled · ${t.graduate ?? 0} graduates`],
      ['Still tracking', String(t.still_tracking ?? 0), 'window open'],
      ['Graduated', String(t.graduated ?? 0), `${t.died ?? 0} died`],
      ['Snapshots (24h)', Number(t.snapshots ?? 0).toLocaleString('en-US'), `${t.mcap_missing ?? 0} missing mcap`],
    ] as [string, string, string][])
      .map(
        ([label, value, sub]) =>
          `<article class="card"><h3>${escapeHtml(label)}</h3>` +
          `<p class="big">${escapeHtml(value)}</p>` +
          `<p class="panel-meta">${escapeHtml(sub)}</p></article>`,
      )
      .join('') +
    `</div>`;

  if (!rows.some((r) => r.reached > 0)) {
    return (
      header +
      summary +
      `<p class="empty">No token has reached the 5-minute baseline and a later mark yet. ` +
      `The first +20m figures appear about 25 minutes after the monitor starts.</p>`
    );
  }

  const body = MARKS.map(([mark, label]) => {
    const r = byMark.get(mark);
    if (!r || r.reached === 0) {
      return (
        `<tr><td>${label}</td><td>0</td><td>${r?.died_before ?? 0}</td>` +
        `<td colspan="4" style="color:var(--muted)">not reached yet</td></tr>`
      );
    }
    const upPct = (100 * r.up) / r.reached;
    const cls = upPct >= 50 ? 'up' : 'down';
    return (
      `<tr><td>${label}</td>` +
      `<td>${r.reached}</td>` +
      `<td>${r.died_before}</td>` +
      `<td><span class="d-pct ${cls}">${upPct.toFixed(0)}%</span> <span style="color:var(--muted)">(${r.up})</span></td>` +
      `<td>${(100 - upPct - (100 * r.flat) / r.reached).toFixed(0)}% <span style="color:var(--muted)">(${r.down})</span></td>` +
      `<td>${pct(n(r.median_pct))}</td>` +
      `<td>${pct(n(r.p90_pct))}</td></tr>`
    );
  }).join('');

  return (
    header +
    summary +
    `<p class="panel-meta" style="margin-top:18px">Return from the 5-minute price. ` +
    `"Died before" counts tokens that stopped trading before the mark — read it next to ` +
    `"reached", because the survivors alone always look better than the sample.</p>` +
    `<div class="table-wrap"><table class="tokens" style="min-width:620px">` +
    `<thead><tr><th>Mark</th><th>Reached</th><th>Died before</th><th>Up</th><th>Down</th>` +
    `<th>Median</th><th>p90</th></tr></thead><tbody>${body}</tbody></table></div>`
  );
}
