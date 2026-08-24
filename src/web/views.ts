/**
 * Dashboard shell. The spine renders monitor status; each adapter renders its
 * own panel, because a token time series and an article feed have nothing
 * useful in common as a view.
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

function relativeFuture(iso: string): string {
  const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'due now';
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.round(seconds / 60)}m`;
  return `in ${(seconds / 3600).toFixed(1)}h`;
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
        <div><dt>Last success</dt><dd>${relative(monitor.lastSuccessAt)}</dd></div>
        <div><dt>Last run</dt><dd>${relative(monitor.lastRunAt)}</dd></div>
        <div><dt>Next run</dt><dd>${monitor.nextRunAt ? escapeHtml(relativeFuture(monitor.nextRunAt)) : '—'}</dd></div>
        <div><dt>Last batch</dt><dd>${monitor.lastRecordCount ?? 0} seen · ${monitor.lastNewRecordCount ?? 0} new</dd></div>
        <div><dt>Total stored</dt><dd>${monitor.totalRecords.toLocaleString('en-US')}</dd></div>
        <div><dt>Runs</dt><dd>${monitor.totalRuns.toLocaleString('en-US')} · ${monitor.totalFailures} failed</dd></div>
      </dl>
      <p class="meta">source <code>${escapeHtml(monitor.source)}</code> · every ${escapeHtml(monitor.schedule)}${monitor.consecutiveFailures > 0 ? ` · <strong>${monitor.consecutiveFailures} consecutive failures</strong>` : ''}</p>
      ${errorBlock}
    </article>`;
}

/** The default panel: a reverse-chronological record list, used by RSS. */
export function renderRecordListPanel(args: {
  monitorName: string;
  records: StoredRecord[];
  windowHours: number;
}): string {
  const { monitorName, records, windowHours } = args;

  if (records.length === 0) {
    return (
      `<h2 class="section">${escapeHtml(monitorName)} · last ${windowHours}h</h2>` +
      `<p class="empty">Nothing ingested in the last ${windowHours} hours. If that looks wrong, check the monitor status above.</p>`
    );
  }

  const rows = records
    .map((record) => {
      const href = safeUrl(record.url);
      const when = new Date(record.publishedAt ?? record.firstSeenAt).toISOString();
      const title = escapeHtml(record.title);
      return `
      <li>
        <div class="record-head">
          <h3>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${title}</a>` : title}</h3>
          <time datetime="${escapeHtml(when)}">${relative(when)}</time>
        </div>
        ${record.summary ? `<p class="summary">${escapeHtml(record.summary)}</p>` : ''}
      </li>`;
    })
    .join('');

  return (
    `<h2 class="section">${escapeHtml(monitorName)} · last ${windowHours}h · ${records.length} record${records.length === 1 ? '' : 's'}</h2>` +
    `<ul class="records">${rows}</ul>`
  );
}

export function renderDashboard(args: {
  monitors: MonitorHealth[];
  panels: string[];
  overall: 'ok' | 'degraded';
  generatedAt: Date;
}): string {
  const { monitors, panels, overall, generatedAt } = args;

  const banner =
    overall === 'degraded'
      ? `<div class="banner">One or more monitors need attention — see the cards below.</div>`
      : '';

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
    --bg:#0e1116; --panel:#161b22; --border:#262d38; --text:#e6edf3;
    --muted:#8b949e; --link:#6cb6ff;
    --ok:#2ecc71; --warn:#f2a33c; --bad:#ff6b6b; --idle:#6e7681;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --border:#d8dee4; --text:#1f2328; --muted:#636c76; --link:#0969da; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1200px; margin:0 auto; padding:32px 20px 64px; }
  header.top { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:24px; }
  h1 { font-size:20px; margin:0; letter-spacing:-0.01em; }
  h1 span { color:var(--muted); font-weight:400; }
  .generated { color:var(--muted); font-size:13px; }
  .banner { background:rgba(255,107,107,.12); border:1px solid var(--bad); padding:10px 14px; border-radius:8px; margin-bottom:20px; font-size:14px; }
  h2.section { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:34px 0 10px; font-weight:600; }
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
  dt { color:var(--muted); font-size:11px; text-transform:uppercase; letter-spacing:.04em; }
  dd { margin:1px 0 0; font-size:14px; font-variant-numeric:tabular-nums; }
  .meta { color:var(--muted); font-size:12px; margin:0; }
  .panel-meta { color:var(--muted); font-size:12px; margin:0 0 10px; }
  /* stat tiles: a compact card whose whole job is one number */
  .cards.stats { grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }
  .card h3 { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); margin:0 0 6px; font-weight:600; }
  .card p.big { font-size:24px; font-variant-numeric:tabular-nums; margin:0 0 4px; font-weight:600; }
  .card p.panel-meta { margin:0; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .error { margin:10px 0 0; padding:8px 10px; background:rgba(255,107,107,.1); border-left:3px solid var(--bad); border-radius:4px; font-size:13px; word-break:break-word; }
  ul.records { list-style:none; margin:0; padding:0; border:1px solid var(--border); border-radius:10px; overflow:hidden; background:var(--panel); }
  ul.records li { padding:14px 16px; border-bottom:1px solid var(--border); }
  ul.records li:last-child { border-bottom:none; }
  .record-head { display:flex; align-items:baseline; justify-content:space-between; gap:14px; }
  .record-head h3 { font-size:15px; font-weight:600; margin:0; line-height:1.4; }
  .record-head time { color:var(--muted); font-size:12px; white-space:nowrap; }
  a { color:var(--link); text-decoration:none; }
  a:hover { text-decoration:underline; }
  .summary { color:var(--muted); font-size:13px; margin:5px 0 0; }
  .empty { color:var(--muted); background:var(--panel); border:1px dashed var(--border); border-radius:10px; padding:24px; text-align:center; }

  /* token table */
  .table-wrap { overflow-x:auto; border:1px solid var(--border); border-radius:10px; background:var(--panel); }
  table.tokens { border-collapse:collapse; width:100%; font-size:13px; min-width:1050px; }
  table.tokens th, table.tokens td { padding:9px 11px; text-align:left; border-bottom:1px solid var(--border); white-space:nowrap; }
  table.tokens thead th { font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; }
  .th-sub { display:block; text-transform:none; letter-spacing:0; font-weight:400; opacity:.75; font-size:10px; }
  table.tokens tbody tr:last-child td { border-bottom:none; }
  table.tokens tbody tr:hover { background:rgba(127,127,127,.06); }
  td.rank { color:var(--muted); font-variant-numeric:tabular-nums; }
  td.num { font-variant-numeric:tabular-nums; }
  .tok-name { font-weight:600; }
  .tok-mint { color:var(--muted); font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; }
  .score { display:inline-block; min-width:34px; text-align:center; padding:2px 7px; border-radius:6px; font-weight:700; color:#0b0e13; }
  .score.hi { background:var(--ok); } .score.mid { background:var(--warn); } .score.lo { background:var(--idle); color:#fff; }
  .cov { font-size:10px; color:var(--muted); margin-top:3px; white-space:nowrap; }
  .cov.good { color:var(--ok); } .cov.bad { color:var(--warn); }
  .d-from { color:var(--muted); }
  .d-arrow { color:var(--muted); margin:0 4px; }
  .d-now { font-weight:600; }
  .d-pct { margin-left:6px; font-size:11px; font-weight:600; }
  .d-pct.up { color:var(--ok); } .d-pct.down { color:var(--bad); } .d-pct.flat { color:var(--muted); }
  .flag { display:inline-block; font-size:10px; padding:1px 5px; border-radius:4px; margin-right:4px; border:1px solid var(--border); }
  .flag.good { color:var(--ok); border-color:var(--ok); }
  .flag.bad { color:var(--bad); border-color:var(--bad); }
  .flag.unknown { color:var(--muted); }
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

  ${panels.join('\n')}

  <footer>
    Machine-readable status at <a href="/health">/health</a> ·
    <a href="/api/monitors">/api/monitors</a> ·
    <a href="/api/records">/api/records</a>
  </footer>
</div>
<script>
  for (const el of document.querySelectorAll('time[datetime]')) {
    el.title = new Date(el.dateTime).toLocaleString();
  }
</script>
</body>
</html>`;
}
