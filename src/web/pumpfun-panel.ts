/**
 * pump.fun dashboard panels.
 *
 * Deliberately minimal, and deliberately NOT a ranked list of tokens. This
 * monitor exists to build a dataset, and a leaderboard of live launches would
 * invite exactly the reading the data cannot yet support — at a ~0.2%
 * graduation rate, any top-N drawn from a few days of collection is noise
 * wearing a ranking's clothes.
 *
 * So the panels answer one question only: is the stream working, and what has
 * it accumulated so far.
 */

import type { PanelContext } from '../adapters/types.js';
import { escapeHtml } from './views.js';

interface LaunchStats {
  launches_today: number;
  launches_total: number;
  instrumented_today: number;
  graduated_today: number;
  graduated_total: number;
  /** Graduations among launches we saw from t=0 — the only cohort a rate is valid over. */
  graduated_from_launch: number;
  resolved_total: number;
  pending_total: number;
  samples_total: number;
  samples_today: number;
  with_telegram: number;
  with_twitter: number;
  socials_known: number;
  last_launch_at: Date | null;
  last_graduation_at: Date | null;
}

interface DeployerRow {
  deployer: string;
  tokens_launched: number;
  graduations: number;
  deaths: number;
  graduation_rate: string | number | null;
  last_launch_at: Date | null;
}

function n(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : value;
  return Number.isFinite(parsed) ? parsed : null;
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function pct(value: number | null, digits = 2): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

function ago(date: Date | null): string {
  if (!date) return 'never';
  const s = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172_800) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86_400).toFixed(1)}d ago`;
}

function short(address: string): string {
  return address.length <= 12 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

export async function renderPumpFunPanel(ctx: PanelContext): Promise<string> {
  const result = await ctx.db.query(
    `select
       (select count(*)::int from pump_launches
         where monitor_id = $1 and launched_at > now() - interval '24 hours'
           and observed_from_launch)                                     as launches_today,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and observed_from_launch)                 as launches_total,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and instrumented
           and launched_at > now() - interval '24 hours')                as instrumented_today,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and outcome = 'graduated'
           and graduated_at > now() - interval '24 hours')               as graduated_today,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and outcome = 'graduated')                as graduated_total,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and outcome = 'graduated'
           and observed_from_launch)                                     as graduated_from_launch,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and outcome <> 'pending'
           and observed_from_launch)                                     as resolved_total,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and outcome = 'pending')                  as pending_total,
       (select count(*)::int from pump_curve_samples where monitor_id = $1) as samples_total,
       (select count(*)::int from pump_curve_samples
         where monitor_id = $1 and observed_at > now() - interval '24 hours') as samples_today,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and has_telegram)                         as with_telegram,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and has_twitter)                          as with_twitter,
       (select count(*)::int from pump_launches
         where monitor_id = $1 and socials_fetched)                      as socials_known,
       (select max(launched_at) from pump_launches where monitor_id = $1) as last_launch_at,
       (select max(graduated_at) from pump_launches where monitor_id = $1) as last_graduation_at`,
    [ctx.monitorId],
  );

  const s = (result.rows[0] ?? {}) as Partial<LaunchStats>;
  const resolved = int(s.resolved_total);
  const graduatedTotal = int(s.graduated_total);
  const graduatedFromLaunch = int(s.graduated_from_launch);

  // Numerator and denominator must describe the SAME population, which is why
  // both are restricted to launches observed from t=0.
  //
  // The migration feed is platform-wide, so most graduations seen early on are
  // for tokens that launched before this monitor existed. Counting those in the
  // numerator while the denominator only holds launches we witnessed produced a
  // rate above 100% — 15 graduations over 12 resolved launches.
  //
  // Restricting to resolved launches also matters in the other direction:
  // dividing by every launch ever seen would understate the rate, because the
  // newest launches have not had time to graduate and would all count as
  // failures.
  const observedRate = resolved > 0 ? graduatedFromLaunch / resolved : null;
  const socialsKnown = int(s.socials_known);
  const telegramShare = socialsKnown > 0 ? int(s.with_telegram) / socialsKnown : null;
  const twitterShare = socialsKnown > 0 ? int(s.with_twitter) / socialsKnown : null;

  const tiles: [string, string, string][] = [
    ['Launches (24h)', int(s.launches_today).toLocaleString('en-US'), `${int(s.launches_total).toLocaleString('en-US')} total`],
    ['Instrumented (24h)', int(s.instrumented_today).toLocaleString('en-US'), 'curve subscribed'],
    ['Graduations (24h)', int(s.graduated_today).toLocaleString('en-US'), `${graduatedTotal.toLocaleString('en-US')} total, all sources`],
    ['Graduation rate', pct(observedRate), `${graduatedFromLaunch}/${resolved.toLocaleString('en-US')} launches seen from t=0`],
    ['Trade samples', int(s.samples_total).toLocaleString('en-US'), `${int(s.samples_today).toLocaleString('en-US')} in 24h`],
    ['Telegram / Twitter', `${pct(telegramShare, 1)} / ${pct(twitterShare, 1)}`, `of ${socialsKnown.toLocaleString('en-US')} with metadata`],
    ['Last launch', ago(s.last_launch_at ?? null), 'stream liveness'],
    ['Last graduation', ago(s.last_graduation_at ?? null), 'migration feed'],
  ];

  const cards = tiles
    .map(
      ([label, value, sub]) =>
        `<article class="card"><h3>${escapeHtml(label)}</h3>` +
        `<p class="big">${escapeHtml(value)}</p>` +
        `<p class="panel-meta">${escapeHtml(sub)}</p></article>`,
    )
    .join('');

  const pending = int(s.pending_total);

  return (
    `<h2 class="section">${escapeHtml(ctx.monitorName)}</h2>` +
    `<p class="panel-meta">Dataset collection — launches, per-trade curve samples, and outcomes. ` +
    `Not a ranked list and not a buy signal: at a ~0.2% graduation rate the useful ` +
    `output of this monitor is the accumulated table, not any live ordering of it. ` +
    `${pending.toLocaleString('en-US')} launches still pending an outcome.</p>` +
    `<div class="cards stats">${cards}</div>`
  );
}

export async function renderDeployerPanel(ctx: PanelContext): Promise<string> {
  const sourceMonitor = (ctx.options['launch_monitor_id'] as string) || ctx.monitorId;
  const minLaunches = (() => {
    const value = ctx.options['dashboard_min_launches'];
    return typeof value === 'number' && value > 0 ? value : 3;
  })();

  const result = await ctx.db.query(
    `select deployer, tokens_launched, graduations, deaths, graduation_rate, last_launch_at
       from pump_deployer_stats
      where monitor_id = $1 and tokens_launched >= $2 and graduations > 0
      order by graduation_rate desc nulls last, graduations desc
      limit 15`,
    [sourceMonitor, minLaunches],
  );

  const rows = result.rows as DeployerRow[];

  const header =
    `<h2 class="section">${escapeHtml(ctx.monitorName)} · top deployers</h2>` +
    `<p class="panel-meta">Wallets with at least ${minLaunches} launches and at least one ` +
    `graduation, by graduation rate over resolved launches. This is the one signal here ` +
    `that does not depend on low latency, which is what makes it the most reliable.</p>`;

  if (rows.length === 0) {
    return (
      header +
      `<p class="empty">No deployer has graduated a token yet. At roughly 0.2% platform-wide, ` +
      `this table needs days of collection before it says anything.</p>`
    );
  }

  const body = rows
    .map((r) => {
      const rate = n(r.graduation_rate);
      return (
        `<tr><td><code>${escapeHtml(short(r.deployer))}</code></td>` +
        `<td>${r.tokens_launched.toLocaleString('en-US')}</td>` +
        `<td>${r.graduations.toLocaleString('en-US')}</td>` +
        `<td>${r.deaths.toLocaleString('en-US')}</td>` +
        `<td><span class="d-pct ${rate !== null && rate > 0.01 ? 'up' : 'flat'}">${pct(rate)}</span></td>` +
        `<td>${escapeHtml(ago(r.last_launch_at))}</td></tr>`
      );
    })
    .join('');

  return (
    header +
    `<div class="table-wrap"><table class="tokens" style="min-width:640px">` +
    `<thead><tr><th>Deployer</th><th>Launched</th><th>Graduated</th><th>Died</th>` +
    `<th>Rate</th><th>Last launch</th></tr></thead>` +
    `<tbody>${body}</tbody></table></div>`
  );
}
