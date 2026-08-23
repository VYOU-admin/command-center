/**
 * Solana top-N dashboard panel.
 *
 * Every figure is shown as first-seen -> now, because trajectory is the signal:
 * a token at $40k liquidity that started at $20k and one that started at $200k
 * are opposite stories that a snapshot renders identically.
 */

import type { PanelContext } from '../adapters/types.js';
import { escapeHtml } from './views.js';

interface TopRow {
  mint: string;
  symbol: string | null;
  name: string | null;
  pair_url: string | null;
  launch_at: Date | null;
  first_seen_at: Date;
  score: number;
  scored_at: Date;
  checked_at: Date;
  age_hours: string | null;
  liquidity_usd: string | null;
  volume_24h: string | null;
  mcap: string | null;
  txns_1h: number | null;
  holders: number | null;
  top10_pct: string | null;
  insider_pct: string | null;
  lp_locked_pct: string | null;
  mint_authority_renounced: boolean | null;
  freeze_authority_renounced: boolean | null;
  usd_per_holder: string | null;
  completeness: string | null;
  first_liquidity: string | null;
  first_volume: string | null;
  first_checked_at: Date;
  first_holders: number | null;
}

export const TOP_QUERY = `
with latest as (
  select distinct on (mint) *
    from solana_token_observations
   where monitor_id = $1
   order by mint, checked_at desc
),
latest_scored as (
  select distinct on (mint) mint, score, checked_at as scored_at, holders, top10_pct,
         insider_pct, lp_locked_pct, mint_authority_renounced,
         freeze_authority_renounced, usd_per_holder, completeness
    from solana_token_observations
   where monitor_id = $1 and score is not null
   order by mint, checked_at desc
),
firsts as (
  select distinct on (mint) mint, checked_at as first_checked_at,
         liquidity_usd as first_liquidity, volume_24h as first_volume
    from solana_token_observations
   where monitor_id = $1
   order by mint, checked_at asc
),
first_holders as (
  select distinct on (mint) mint, holders as first_holders
    from solana_token_observations
   where monitor_id = $1 and holders is not null
   order by mint, checked_at asc
)
select s.score, s.scored_at, s.holders, s.top10_pct, s.insider_pct, s.lp_locked_pct,
       s.mint_authority_renounced, s.freeze_authority_renounced, s.usd_per_holder,
       s.completeness,
       l.checked_at, l.liquidity_usd, l.volume_24h, l.mcap, l.txns_1h, l.age_hours,
       f.first_checked_at, f.first_liquidity, f.first_volume,
       h.first_holders,
       t.mint, t.symbol, t.name, t.pair_url, t.launch_at, t.first_seen_at
  from latest_scored s
  join latest l on l.mint = s.mint
  join firsts f on f.mint = s.mint
  left join first_holders h on h.mint = s.mint
  join solana_tokens t on t.monitor_id = $1 and t.mint = s.mint
 order by s.score desc
 limit $2
`;

function n(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function usd(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(0)}`;
}

/** first -> now, with the percentage move that matters more than either figure. */
function delta(first: number | null, now: number | null, fmt: (v: number | null) => string): string {
  const a = fmt(first);
  const b = fmt(now);
  if (first === null || now === null || first === 0) {
    return `<span class="d-from">${a}</span><span class="d-arrow">→</span><span class="d-now">${b}</span>`;
  }
  const pct = ((now - first) / Math.abs(first)) * 100;
  const cls = pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat';
  const sign = pct > 0 ? '+' : '';
  return (
    `<span class="d-from">${a}</span><span class="d-arrow">→</span><span class="d-now">${b}</span>` +
    `<span class="d-pct ${cls}">${sign}${pct.toFixed(0)}%</span>`
  );
}

function countDelta(first: number | null, now: number | null): string {
  if (now === null) return '—';
  if (first === null) return now.toLocaleString('en-US');
  const diff = now - first;
  const cls = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
  const sign = diff > 0 ? '+' : '';
  return (
    `<span class="d-now">${now.toLocaleString('en-US')}</span>` +
    `<span class="d-pct ${cls}">${sign}${diff.toLocaleString('en-US')}</span>`
  );
}

function age(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function flag(ok: boolean | null, label: string): string {
  if (ok === null) return `<span class="flag unknown">${label}?</span>`;
  return ok
    ? `<span class="flag good">${label} ✓</span>`
    : `<span class="flag bad">${label} ✗</span>`;
}

export async function renderSolanaPanel(ctx: PanelContext): Promise<string> {
  const topN = (() => {
    const alerts = ctx.options['alerts'];
    if (alerts && typeof alerts === 'object' && !Array.isArray(alerts)) {
      const value = (alerts as Record<string, unknown>)['top_n'];
      if (typeof value === 'number' && value > 0) return Math.min(value, 100);
    }
    return 20;
  })();

  const [top, totals] = await Promise.all([
    ctx.db.query(TOP_QUERY, [ctx.monitorId, topN]),
    ctx.db.query(
      `select
         (select count(*)::int from solana_tokens where monitor_id = $1) as tracked,
         (select count(*)::int from solana_token_observations where monitor_id = $1) as observations,
         (select count(*)::int from solana_token_observations
           where monitor_id = $1 and checked_at > now() - interval '25 hours') as obs_24h`,
      [ctx.monitorId],
    ),
  ]);

  const stats = totals.rows[0] ?? { tracked: 0, observations: 0, obs_24h: 0 };
  const rows = top.rows as TopRow[];

  const summary =
    `<p class="panel-meta">${stats.tracked.toLocaleString('en-US')} tokens tracked · ` +
    `${stats.observations.toLocaleString('en-US')} observations stored ` +
    `(${stats.obs_24h.toLocaleString('en-US')} in 24h) · append-only time series</p>`;

  if (rows.length === 0) {
    return (
      `<h2 class="section">${escapeHtml(ctx.monitorName)} · top ${topN}</h2>` +
      summary +
      `<p class="empty">No tokens have been scored yet. Tokens must be 6h–7d old and clear every hard floor before they are enriched and scored.</p>`
    );
  }

  const body = rows
    .map((r, i) => {
      const label = r.symbol?.trim() || r.mint.slice(0, 6);
      const link = r.pair_url
        ? `<a href="${escapeHtml(r.pair_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
        : escapeHtml(label);
      const scoreClass = r.score >= 80 ? 'hi' : r.score >= 60 ? 'mid' : 'lo';
      const cov = n(r.completeness);
      // A score computed from half the signals must not look like a full one.
      const covPct = cov === null ? null : Math.round(cov * 100);
      const covClass = covPct === null ? 'unknown' : covPct >= 90 ? 'good' : covPct >= 60 ? '' : 'bad';
      return `
      <tr>
        <td class="rank">${i + 1}</td>
        <td class="tok">
          <div class="tok-name">${link}</div>
          <div class="tok-mint" title="${escapeHtml(r.mint)}">${escapeHtml(r.mint.slice(0, 10))}…</div>
        </td>
        <td>
          <span class="score ${scoreClass}">${r.score}</span>
          <div class="cov ${covClass}" title="Fraction of scoring weight that was measurable">${covPct === null ? '—' : `${covPct}% signal`}</div>
        </td>
        <td class="num">${age(n(r.age_hours))}</td>
        <td class="num">${delta(n(r.first_liquidity), n(r.liquidity_usd), usd)}</td>
        <td class="num">${delta(n(r.first_volume), n(r.volume_24h), usd)}</td>
        <td class="num">${usd(n(r.mcap))}</td>
        <td class="num">${countDelta(r.first_holders, r.holders)}</td>
        <td class="num">${r.top10_pct === null ? '—' : `${n(r.top10_pct)!.toFixed(1)}%`}</td>
        <td class="num">${r.lp_locked_pct === null ? '—' : `${n(r.lp_locked_pct)!.toFixed(0)}%`}</td>
        <td class="flags">${flag(r.mint_authority_renounced, 'mint')}${flag(r.freeze_authority_renounced, 'freeze')}</td>
      </tr>`;
    })
    .join('');

  return `
  <h2 class="section">${escapeHtml(ctx.monitorName)} · top ${topN} by score</h2>
  ${summary}
  <div class="table-wrap">
    <table class="tokens">
      <thead>
        <tr>
          <th>#</th><th>Token</th><th>Score</th><th>Age</th>
          <th>Liquidity <span class="th-sub">first → now</span></th>
          <th>24h volume <span class="th-sub">first → now</span></th>
          <th>MCap</th>
          <th>Holders <span class="th-sub">now / Δ</span></th>
          <th>Top-10</th><th>LP&nbsp;lock</th><th>Authorities</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
  </div>`;
}
