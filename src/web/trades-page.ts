/**
 * /trades — what the launch bot did, or would have done.
 *
 * THE MODE IS THE MOST IMPORTANT THING ON THIS PAGE. In dry run every figure is
 * hypothetical: no transaction was broadcast, no money moved, and the PnL is what the
 * constructed trade would have produced. A tab that does not say so will be read as
 * real money a week from now, by someone who was not here today.
 *
 * So the mode appears in the header, in a banner, and as a COLUMN ON EVERY ROW, and
 * totals are computed PER MODE and never summed across modes. A dry-run gain and a live
 * gain are different quantities and adding them would produce a number that is true of
 * nothing.
 *
 * Follows the /watchlist conventions: the row cap and the filters are applied in SQL,
 * the page states "Showing N of M matching" so a truncation is visible rather than
 * reading as "that is all that happened", filters are query-string so a filtered view
 * is a shareable URL, and a MALFORMED filter is treated as NO filter rather than as an
 * error -- a filter that silently matches nothing is the failure shape this project
 * keeps hitting.
 */
export interface TradeRow {
  id: string; mode: string; createdAt: string; poolId: string; token: string;
  launchpad: string | null; fee: number | null; positionUsd: number | null;
  entryPrice: number | null; exitPrice: number | null; grossReturn: number | null;
  gasUsd: number | null; netPnlUsd: number | null; fillStatus: string | null;
  status: string;
  /* The exit leg's OWN outcome, distinct from the entry's. 'not attempted' is its
   * own value and must never render as a revert or as a blank success. */
  exitSimStatus: string | null;
  px30s: number | null; px300s: number | null;
}
/**
 * THE ONE PREDICATE for "is this mode hypothetical". Exported so a test can exercise it
 * and so no caller re-implements it as an equality check, which is how the banner came
 * to announce live trades over a dry run.
 */
export function isDryRunMode(mode: string): boolean {
  return mode === 'dry-run' || mode.startsWith('dry-run-');
}

export interface TradeTotals {
  mode: string; trades: number; wins: number; netPnl: number; gas: number;
}

export function renderTradesPage(args: {
  rows: TradeRow[]; totals: TradeTotals[]; shown: number; total: number;
  modes: string[]; launchpads: { addr: string; n: number }[];
  filterMode: string | null; filterLaunchpad: string | null; cap: number;
}): string {
  const { rows, totals, shown, total, modes, launchpads, filterMode, filterLaunchpad, cap } = args;
  const esc = (v: string): string => v
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const short = (a: string): string => (a.length <= 14 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`);
  const num = (x: number, d = 2): string =>
    x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const chart = (t: string): string => `https://dexscreener.com/robinhood/${t}`;
  const addrUrl = (a: string): string => `https://robinhoodchain.blockscout.com/address/${a}`;
  /* A null is never rendered as zero -- section 5 of ROBINHOOD.md, and the same rule
   * matters more here because a zero PnL reads as a flat trade rather than no data. */
  const money = (x: number | null): string => (x === null
    ? '<span class="nul" title="not recorded; never shown as zero">—</span>'
    : `<span class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '' : '−'}$${esc(num(Math.abs(x)))}</span>`);
  const pct = (x: number | null): string => (x === null
    ? '<span class="nul">—</span>'
    : `<span class="${x >= 0 ? 'up' : 'down'}">${x >= 0 ? '+' : '−'}${esc(num(Math.abs(x) * 100, 1))}%</span>`);

  /*
   * A MODE IS A DRY RUN WHEN IT STARTS WITH 'dry-run', NOT WHEN IT EQUALS IT.
   *
   * This was an exact-string test, and the moment `launchbot` gained a run label the
   * mode `dry-run-r3` stopped matching — so the page announced **"THIS PAGE CONTAINS
   * LIVE TRADES"** over 34 hypothetical rows. The banner exists precisely so nobody
   * reads a dry run as real money, and it said the opposite.
   *
   * `launchbot` guarantees the prefix: the label is a SUFFIX on the literal 'dry-run'
   * and cannot replace it, so a prefix test is sound rather than lenient. The ONE
   * predicate lives here and is used by the banner, the totals blocks and every row
   * chip, so those three can never disagree about what a mode is.
   */
  const anyLive = totals.some((t) => !isDryRunMode(t.mode) && t.trades > 0);
  const banner = anyLive
    ? `<div class="banner live">THIS PAGE CONTAINS LIVE TRADES. Totals are shown per mode
       and are never summed across modes.</div>`
    : `<div class="banner dry">DRY RUN — NO MONEY MOVED. Every figure below is
       hypothetical: these transactions were constructed and simulated, never broadcast.
       This build has no signing path.</div>`;

  const totalsHtml = totals.map((t) => `
    <div class="tot ${isDryRunMode(t.mode) ? 'dry' : 'live'}">
      <div class="totmode">${esc(t.mode)}</div>
      <div class="totgrid">
        <div><span>net pnl</span><b>${money(t.netPnl)}</b></div>
        <div><span>trades</span><b>${t.trades}</b></div>
        <div><span>win rate</span><b>${t.trades ? esc(num((t.wins / t.trades) * 100, 1)) : '—'}%</b></div>
        <div><span>gas paid</span><b>$${esc(num(t.gas, 4))}</b></div>
      </div>
    </div>`).join('') || '<div class="tot dry"><div class="totmode">no trades yet</div></div>';

  const body = rows.length === 0
    ? '<tr><td class="empty" colspan="14">No trades recorded.</td></tr>'
    : rows.map((r) => `
      <tr>
        <td class="t">${esc(r.createdAt.replace('T', ' ').slice(0, 19))}Z</td>
        <td><span class="mode ${isDryRunMode(r.mode) ? 'dry' : 'live'}">${esc(r.mode)}</span></td>
        <td><a href="${chart(r.token)}" target="_blank" rel="noopener noreferrer"
               title="${esc(r.token)}">${esc(short(r.token))}</a></td>
        <td>${r.launchpad
          ? `<a href="${addrUrl(r.launchpad)}" target="_blank" rel="noopener noreferrer"
                title="${esc(r.launchpad)}">${esc(short(r.launchpad))}</a>`
          : '<span class="nul">—</span>'}</td>
        <td class="n">${r.entryPrice === null ? '<span class="nul">—</span>' : esc(r.entryPrice.toPrecision(6))}</td>
        <td class="n">${r.exitPrice === null ? '<span class="nul">—</span>' : esc(r.exitPrice.toPrecision(6))}</td>
        <td class="n">${r.positionUsd === null ? '<span class="nul">—</span>' : `$${esc(num(r.positionUsd))}`}</td>
        <td class="n">${pct(r.grossReturn)}</td>
        <td class="n">${r.gasUsd === null ? '<span class="nul">—</span>' : `$${esc(num(r.gasUsd, 4))}`}</td>
        <td class="n">${money(r.netPnlUsd)}</td>
        <td>${esc(r.fillStatus ?? r.status)}</td>
        <td>${r.exitSimStatus === null
          ? '<span class="nul">—</span>'
          : `<span class="ex ${r.exitSimStatus === 'clean' ? 'ok'
            : r.exitSimStatus === 'reverted' ? 'bad' : 'na'}">${esc(r.exitSimStatus)}</span>`}</td>
        <td class="n">${r.px30s === null ? '<span class="nul">—</span>' : esc(r.px30s.toPrecision(4))}</td>
        <td class="n">${r.px300s === null ? '<span class="nul">—</span>' : esc(r.px300s.toPrecision(4))}</td>
      </tr>`).join('');

  const modeOpts = modes.map((m) =>
    `<option value="${esc(m)}"${m === filterMode ? ' selected' : ''}>${esc(m)}</option>`).join('');
  const padOpts = launchpads.map((l) =>
    `<option value="${esc(l.addr)}"${l.addr === filterLaunchpad ? ' selected' : ''}>`
    + `${esc(short(l.addr))} — ${l.n} trade${l.n === 1 ? '' : 's'}</option>`).join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>trades · command center</title>
<style>
 :root{--bg:#0f1216;--panel:#161b22;--panel2:#1b2129;--border:#2a323d;--text:#e6edf3;
   --muted:#8b98a5;--faint:#5f6b78;--accent:#4fb3bd;--ok:#57d9a3;--warn:#e0a458;--bad:#e08585}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);
   font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
 .wrap{max-width:1500px;margin:0 auto;padding:24px 20px 80px}
 h1{font-size:20px;margin:0 0 2px;font-weight:650}
 .sub{color:var(--muted);font-size:12px;margin:0 0 14px}
 .nav{display:flex;gap:6px;margin-bottom:16px}
 .nav a{padding:6px 14px;border:1px solid var(--border);border-radius:6px;
   background:var(--panel);color:var(--muted);text-decoration:none;font-size:13px}
 .nav a.on{background:var(--accent);border-color:var(--accent);color:#06222a;font-weight:600}
 .banner{border-radius:8px;padding:10px 14px;margin-bottom:14px;font-size:13px;font-weight:600}
 .banner.dry{background:#2a2410;border:1px solid var(--warn);color:var(--warn)}
 .banner.live{background:#2a1414;border:1px solid var(--bad);color:var(--bad)}
 .tots{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:14px}
 .tot{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 16px;min-width:330px}
 .tot.dry{border-left:3px solid var(--warn)} .tot.live{border-left:3px solid var(--bad)}
 .totmode{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);margin-bottom:8px}
 .totgrid{display:flex;gap:22px} .totgrid span{display:block;font-size:11px;color:var(--faint)}
 .totgrid b{font-size:16px;font-weight:650}
 form.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:end;background:var(--panel);
   border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px}
 .f{display:flex;flex-direction:column;gap:4px}
 .f label{font-size:11px;color:var(--faint);text-transform:uppercase}
 .ex{padding:1px 6px;border-radius:4px;font-size:11px}
 .ex.ok{background:#12351f;color:#7ee2a8}
 .ex.bad{background:#3a1720;color:#ff9aa8}
 /* NOT-ATTEMPTED IS ITS OWN COLOUR, neither pass nor fail. Rendering it as either
    would be the partial-check-reported-as-full failure this tab exists to avoid. */
 .ex.na{background:#2a2a33;color:#a9a9b8}
 .f select{background:var(--panel2);border:1px solid var(--border);border-radius:6px;
   color:var(--text);padding:6px 8px;font-size:13px;min-width:220px}
 button{background:var(--accent);border:1px solid var(--accent);border-radius:6px;
   color:#06222a;font-weight:600;padding:7px 16px;cursor:pointer;font-size:13px}
 a.clear{color:var(--muted);font-size:12px;align-self:center}
 table{width:100%;border-collapse:collapse;background:var(--panel);
   border:1px solid var(--border);border-radius:8px;overflow:hidden}
 th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--faint);
   text-align:left;padding:9px 10px;border-bottom:1px solid var(--border);background:var(--panel2)}
 td{padding:8px 10px;border-bottom:1px solid #20262e;font-size:13px}
 td.n{text-align:right;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 td.t{color:var(--muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
 td.empty{text-align:center;color:var(--faint);padding:26px}
 .up{color:var(--ok)} .down{color:var(--bad)} .nul{color:var(--faint)}
 .mode{font-size:11px;padding:2px 7px;border-radius:4px;font-weight:600}
 .mode.dry{background:#2a2410;color:var(--warn);border:1px solid var(--warn)}
 .mode.live{background:#2a1414;color:var(--bad);border:1px solid var(--bad)}
 a{color:var(--accent)}
</style></head><body><div class="wrap">
<div class="nav"><a href="/">tokens</a><a href="/watchlist">watchlist</a><a class="on" href="/trades">trades</a></div>
<h1>trades</h1>
<p class="sub">Launch bot. Totals are per mode and are never summed across modes.</p>
${banner}
<div class="tots">${totalsHtml}</div>
<form class="filters" method="get" action="/trades">
  <div class="f"><label for="mode">mode</label>
    <select id="mode" name="mode"><option value="">all modes</option>${modeOpts}</select></div>
  <div class="f"><label for="launchpad">launchpad</label>
    <select id="launchpad" name="launchpad"><option value="">all launchpads</option>${padOpts}</select></div>
  <button type="submit">filter</button>
  ${(filterMode ?? filterLaunchpad) ? '<a class="clear" href="/trades">clear</a>' : ''}
</form>
<p class="sub">Showing ${shown.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} matching
  ${total > cap ? `(capped at ${cap.toLocaleString('en-US')})` : ''}</p>
<table><thead><tr>
 <th>time</th><th>mode</th><th>token</th><th>launchpad</th><th>entry</th><th>exit</th>
 <th>size</th><th>gross</th><th>gas</th><th>net pnl</th><th>fill</th>
 <th>exit sim</th><th>px +30s</th><th>px +300s</th>
</tr></thead><tbody>${body}</tbody></table>
</div></body></html>`;
}
