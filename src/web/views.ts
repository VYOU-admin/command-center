/**
 * Server-rendered dashboard. No build step, no client framework — the page is
 * one HTML string so the web sink stays a thin read over the same tables the
 * Discord sink reads.
 */

import type { MonitorHealth, HealthStatus } from '../health.js';
import type { StoredRecord } from '../store/records.js';

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only allow links we are willing to render as clickable. */
function safeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

const STATUS_LABEL: Record<HealthStatus, string> = {
  ok: 'OK',
  pending: 'Pending',
  degraded: 'Degraded',
  failing: 'Failing',
  stale: 'Stale',
  disabled: 'Disabled',
};

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}

function monitorCard(monitor: MonitorHealth): string {
  const problem =
    monitor.status === 'failing' || monitor.status === 'stale' || monitor.status === 'degraded';

  const errorBlock =
    problem && monitor.lastError
      ? `<p class="error">${escapeHtml(monitor.lastError)}</p>`
      : monitor.status === 'stale'
        ? `<p class="error">No successful run in longer than ${Math.round(monitor.staleAfterSeconds / 60)} minutes, and no errors reported — the monitor may not be running at all.</p>`
        : '';

  return `
    <article class="card status-${monitor.status}">
      <header>
        <h2>${escapeHtml(monitor.name)}</h2>
        <span class="pill pill-${monitor.status}">${STATUS_LABEL[monitor.status]}</span>
      </header>
      <dl>
        <div><dt>Last success</dt><dd${monitor.lastSuccessAt ? ` title="${escapeHtml(monitor.lastSuccessAt)}"` : ''}>${relative(monitor.lastSuccessAt)}</dd></div>
        <div><dt>Last run</dt><dd${monitor.lastRunAt ? ` title="${escapeHtml(monitor.lastRunAt)}"` : ''}>${relative(monitor.lastRunAt)}</dd></div>
        <div><dt>Next run</dt><dd>${monitor.nextRunAt ? escapeHtml(relativeFuture(monitor.nextRunAt)) : '—'}</dd></div>
        <div><dt>Last batch</dt><dd>${monitor.lastRecordCount ?? 0} seen · ${monitor.lastNewRecordCount ?? 0} new</dd></div>
        <div><dt>Total stored</dt><dd>${monitor.totalRecords.toLocaleString('en-US')}</dd></div>
        <div><dt>Runs</dt><dd>${monitor.totalRuns.toLocaleString('en-US')} · ${monitor.totalFailures} failed</dd></div>
      </dl>
      <p class="meta">source <code>${escapeHtml(monitor.source)}</code> · every ${escapeHtml(monitor.schedule)}${monitor.consecutiveFailures > 0 ? ` · <strong>${monitor.consecutiveFailures} consecutive failures</strong>` : ''}</p>
      ${errorBlock}
    </article>`;
}

function relativeFuture(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  return `in ${(seconds / 3600).toFixed(1)}h`;
}

function recordRow(record: StoredRecord): string {
  const href = safeUrl(record.url);
  const when = record.publishedAt ?? record.firstSeenAt;
  const title = escapeHtml(record.title);
  return `
    <li>
      <div class="record-head">
        <h3>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</h3>
        <time datetime="${escapeHtml(new Date(when).toISOString())}" title="${escapeHtml(new Date(when).toISOString())}">${relative(new Date(when).toISOString())}</time>
      </div>
      ${record.summary ? `<p class="summary">${escapeHtml(record.summary)}</p>` : ''}
      <p class="meta"><span class="badge">${escapeHtml(record.monitorName)}</span></p>
    </li>`;
}

export function renderDashboard(args: {
  monitors: MonitorHealth[];
  records: StoredRecord[];
  windowHours: number;
  overall: 'ok' | 'degraded';
  generatedAt: Date;
}): string {
  const { monitors, records, windowHours, overall, generatedAt } = args;

  const banner =
    overall === 'degraded'
      ? `<div class="banner">One or more monitors need attention — see the cards below.</div>`
      : '';

  const recordsSection = records.length
    ? `<ul class="records">${records.map(recordRow).join('')}</ul>`
    : `<p class="empty">Nothing ingested in the last ${windowHours} hours. If that looks wrong, check the monitor status above.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="120">
<title>command center</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #0e1116; --panel: #161b22; --border: #262d38; --text: #e6edf3;
    --muted: #8b949e; --link: #6cb6ff;
    --ok: #2ecc71; --warn: #f2a33c; --bad: #ff6b6b; --idle: #6e7681;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --border:#d8dee4; --text:#1f2328; --muted:#636c76; --link:#0969da; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width: 940px; margin: 0 auto; padding: 32px 20px 64px; }
  header.top { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:24px; }
  h1 { font-size:20px; margin:0; letter-spacing:-0.01em; }
  h1 span { color:var(--muted); font-weight:400; }
  .generated { color:var(--muted); font-size:13px; }
  .banner { background:rgba(255,107,107,.12); border:1px solid var(--bad); color:var(--text); padding:10px 14px; border-radius:8px; margin-bottom:20px; font-size:14px; }
  h2.section { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:32px 0 12px; font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:14px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:16px; }
  .card.status-failing, .card.status-stale { border-color:var(--bad); }
  .card.status-degraded { border-color:var(--warn); }
  .card header { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:12px; }
  .card h2 { font-size:16px; margin:0; }
  .pill { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.05em; padding:3px 9px; border-radius:999px; white-space:nowrap; color:#0b0e13; }
  .pill-ok { background:var(--ok); } .pill-degraded { background:var(--warn); }
  .pill-failing, .pill-stale { background:var(--bad); }
  .pill-pending, .pill-disabled { background:var(--idle); color:#fff; }
  dl { display:grid; grid-template-columns:1fr 1fr; gap:8px 16px; margin:0 0 12px; }
  dl div { min-width:0; }
  dt { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  dd { margin:1px 0 0; font-size:14px; font-variant-numeric:tabular-nums; }
  .meta { color:var(--muted); font-size:12px; margin:0; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .error { margin:10px 0 0; padding:8px 10px; background:rgba(255,107,107,.1); border-left:3px solid var(--bad); border-radius:4px; font-size:13px; word-break:break-word; }
  ul.records { list-style:none; margin:0; padding:0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--panel); }
  ul.records li { padding:14px 16px; border-bottom:1px solid var(--border); }
  ul.records li:last-child { border-bottom:none; }
  .record-head { display:flex; align-items:baseline; justify-content:space-between; gap:14px; }
  .record-head h3 { font-size:15px; font-weight:600; margin:0; line-height:1.4; }
  .record-head time { color:var(--muted); font-size:12px; white-space:nowrap; font-variant-numeric:tabular-nums; }
  a { color:var(--link); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .summary { color:var(--muted); font-size:13px; margin:5px 0 6px; }
  .badge { display:inline-block; font-size:11px; color:var(--muted); border:1px solid var(--border); border-radius:4px; padding:1px 6px; }
  .empty { color:var(--muted); background:var(--panel); border:1px dashed var(--border); border-radius:10px; padding:24px; text-align:center; }
  footer { margin-top:36px; color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <h1>command center <span>/ monitoring spine</span></h1>
    <span class="generated">updated ${escapeHtml(generatedAt.toISOString().replace('T', ' ').slice(0, 19))} UTC</span>
  </header>

  ${banner}

  <h2 class="section">Monitors</h2>
  <div class="cards">${monitors.map(monitorCard).join('')}</div>

  <h2 class="section">Last ${windowHours} hours · ${records.length} record${records.length === 1 ? '' : 's'}</h2>
  ${recordsSection}

  <footer>
    Machine-readable status at <a href="/health">/health</a> ·
    <a href="/api/monitors">/api/monitors</a> ·
    <a href="/api/records">/api/records</a>
  </footer>
</div>
<script>
  // Render timestamps in the viewer's timezone; the server renders UTC.
  for (const el of document.querySelectorAll('time[datetime]')) {
    el.title = new Date(el.dateTime).toLocaleString();
  }
</script>
</body>
</html>`;
}
