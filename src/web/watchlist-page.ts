/**
 * /watchlist — every trade the watchlist wallets made, on any token.
 *
 * docs/ROBINHOOD.md step 14 and step 17. The Discord alert is aggregated by token
 * and capped at 20 lines because Discord rejects an embed over 4,096 characters;
 * this page is where the rest lives, one row per trade.
 *
 * IT DOES NOT EMBED AN UNBOUNDED NUMBER OF ROWS, and that is deliberate. 191,728
 * transaction rows once produced a 69.3 MB page (step 14). Filtering and the row
 * limit are applied in SQL, the limit is stated on the page, and the total matching
 * count is shown beside it -- so "showing 500 of 12,000" is visible rather than a
 * silent truncation that reads as "that is all that happened".
 *
 * FILTERS ARE SERVER-SIDE, by query string, so they scale past what a browser can
 * hold and a filtered view is a shareable URL.
 */

export interface WatchlistRow {
  wallet: string;
  token: string;
  name: string | null;
  symbol: string | null;
  side: 'buy' | 'sell';
  venue: string;
  tokenAmount: string;
  usdAmount: number | null;
  blockNumber: string;
  blockTime: string;
  txHash: string;
}

export interface WatchlistTokenOption {
  token: string; name: string | null; symbol: string | null; trades: number;
}

export function renderWatchlistPage(args: {
  rows: WatchlistRow[];
  tokens: WatchlistTokenOption[];
  total: number;
  limit: number;
  filterToken: string;
  filterWallet: string;
  walletCount: number;
  generatedAt: Date;
}): string {
  const {
    rows, tokens, total, limit, filterToken, filterWallet, walletCount, generatedAt,
  } = args;
  const esc = (v: string): string => v
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const short = (a: string): string => (a.length <= 14 ? a : `${a.slice(0, 6)}…${a.slice(-4)}`);
  const num = (x: number, d = 0): string =>
    x.toLocaleString('en-US', { maximumFractionDigits: d });

  /*
   * A DEXSCREENER LINK IS BUILT ONLY FOR THE CHAIN WE KNOW THE SLUG FOR. The rule
   * in step 14 is that a chain absent from the link table gets NO link rather than
   * a guessed one -- a dead link that looks live is the same shape of failure as a
   * filter matching nothing. Everything here is Robinhood Chain.
   */
  const chart = (t: string): string => `https://dexscreener.com/robinhood/${t}`;
  const explorerTx = (h: string): string => `https://robinhoodchain.blockscout.com/tx/${h}`;
  const explorerAddr = (a: string): string =>
    `https://robinhoodchain.blockscout.com/address/${a}`;

  const label = (r: { name: string | null; symbol: string | null; token: string }): string => {
    /*
     * A SYMBOL IS A LABEL, NOT AN IDENTITY -- two tokens on this chain both answer
     * symbol() with "NVDA" -- so the address is always shown too, and a token that
     * answers neither name() nor symbol() shows its address rather than a label
     * somebody invented for it.
     */
    if (r.symbol && r.name && r.symbol !== r.name) {
      return `<strong>${esc(r.symbol)}</strong> <span class="nm">${esc(r.name)}</span>`;
    }
    if (r.symbol) return `<strong>${esc(r.symbol)}</strong>`;
    if (r.name) return `<strong>${esc(r.name)}</strong>`;
    return `<span class="nm">unnamed</span>`;
  };

  const body = rows.length === 0
    ? `<tr><td colspan="7" class="empty">No trades match this filter.
         ${total === 0 ? 'The watcher has stored nothing yet.' : ''}</td></tr>`
    /*
     * THE TOKEN NAME IS THE DEXSCREENER LINK, the same URL the alert renders, so the
     * two surfaces send a reader to the same place.
     *
     * THE SEPARATE "chart" LINK IS REMOVED and that is the only thing removed: it
     * pointed at this identical URL, so leaving it would be two links to one
     * destination. The ADDRESS link stays -- it goes to Blockscout, a different
     * destination -- and so does the transaction link.
     */
    : rows.map((r) => `<tr>
        <td class="tk"><a href="${chart(r.token)}" target="_blank"
             rel="noopener noreferrer">${label(r)}</a>
          <div class="addr"><a href="${explorerAddr(r.token)}" target="_blank"
               rel="noopener noreferrer"
               title="${esc(r.token)}">${esc(short(r.token))}</a></div></td>
        <td><a href="${explorerAddr(r.wallet)}" target="_blank" rel="noopener noreferrer"
               title="${esc(r.wallet)}">${esc(short(r.wallet))}</a></td>
        <td class="${r.side}">${r.side}</td>
        <td class="n">${esc(num(Math.abs(Number(r.tokenAmount)), 4))}</td>
        <td class="n">${r.usdAmount === null
          ? '<span class="nul" title="no price could be derived; never shown as zero">unpriced</span>'
          : `$${esc(num(r.usdAmount, 2))}`}</td>
        <td class="t">${esc(r.blockTime.replace('T', ' ').slice(0, 19))}Z
          <div class="addr">${esc(r.blockNumber)}</div></td>
        <td><a href="${explorerTx(r.txHash)}" target="_blank" rel="noopener noreferrer"
               title="${esc(r.txHash)}">${esc(short(r.txHash))}</a></td>
      </tr>`).join('');

  const options = tokens.map((t) => {
    const name = t.symbol ?? t.name ?? short(t.token);
    return `<option value="${esc(t.token)}"${t.token === filterToken ? ' selected' : ''}>`
      + `${esc(name)} — ${t.trades} trade${t.trades === 1 ? '' : 's'}</option>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>watchlist · command center</title>
<style>
  :root{
    --bg:#0f1216; --panel:#161b22; --panel2:#1b2129; --border:#2a323d;
    --text:#e6edf3; --muted:#8b98a5; --faint:#5f6b78;
    --accent:#4fb3bd; --ok:#57d9a3; --warn:#e0a458; --bad:#e08585;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
  .wrap{max-width:1500px;margin:0 auto;padding:24px 20px 80px}
  h1{font-size:20px;margin:0 0 2px;font-weight:650;letter-spacing:-.01em}
  .sub{color:var(--muted);font-size:12px;margin:0 0 18px}
  .nav{display:flex;gap:6px;margin-bottom:16px}
  .nav a{padding:6px 14px;border:1px solid var(--border);border-radius:6px;
    background:var(--panel);color:var(--muted);text-decoration:none;font-size:13px}
  .nav a.on{background:var(--accent);border-color:var(--accent);color:#06222a;font-weight:600}
  form.filters{display:flex;gap:10px;flex-wrap:wrap;align-items:end;
    background:var(--panel);border:1px solid var(--border);border-radius:8px;
    padding:12px 14px;margin-bottom:14px}
  .f{display:flex;flex-direction:column;gap:4px}
  .f label{font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.04em}
  .f select,.f input{background:var(--panel2);border:1px solid var(--border);border-radius:6px;
    color:var(--text);padding:6px 8px;font:13px ui-sans-serif,-apple-system,sans-serif;min-width:190px}
  .f input{min-width:320px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  button{background:var(--accent);border:1px solid var(--accent);border-radius:6px;
    color:#06222a;font-weight:600;padding:7px 16px;cursor:pointer;font-size:13px}
  button:focus-visible,.nav a:focus-visible,select:focus-visible,input:focus-visible{
    outline:2px solid var(--accent);outline-offset:2px}
  a.clear{color:var(--muted);font-size:12px;text-decoration:none;padding:7px 4px}
  .count{background:var(--panel);border:1px solid var(--border);border-radius:8px;
    padding:10px 14px;margin-bottom:12px;font-size:13px;color:var(--muted)}
  .count strong{color:var(--text)}
  .capped{color:var(--warn)}
  table{width:100%;border-collapse:collapse;background:var(--panel);
    border:1px solid var(--border);border-radius:8px;overflow:hidden}
  th,td{padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);
    vertical-align:top;font-size:13px}
  th{background:var(--panel2);color:var(--faint);font-size:11px;text-transform:uppercase;
    letter-spacing:.04em;font-weight:600;position:sticky;top:0}
  tr:last-child td{border-bottom:none}
  td.n{text-align:right;font-variant-numeric:tabular-nums;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  td.t{white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--muted);font-size:12px}
  td.buy{color:var(--ok);font-weight:600}
  td.sell{color:var(--bad);font-weight:600}
  .nm{color:var(--muted);font-weight:400}
  .addr{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;
    color:var(--faint);margin-top:2px}
  .addr a{color:var(--faint);margin-right:8px}
  a{color:var(--accent)}
  td.tk > a{color:var(--text);text-decoration:none}
  td.tk > a:hover{color:var(--accent);text-decoration:underline}
  .nul{color:var(--faint);font-style:italic}
  td.empty{text-align:center;color:var(--muted);padding:28px}
  .wrapx{overflow-x:auto}
</style>
</head>
<body>
<div class="wrap">
  <h1>watchlist activity</h1>
  <p class="sub">Every trade by a watchlist wallet, on any token on Robinhood Chain.
    Generated ${esc(generatedAt.toISOString().replace('T', ' ').slice(0, 19))}Z</p>
  <nav class="nav">
    <a href="/">monitors</a>
    <a href="/tokens">tokens</a>
    <a href="/watchlist" class="on">watchlist</a>
  </nav>

  <form class="filters" method="get" action="/watchlist">
    <div class="f">
      <label for="token">token</label>
      <select id="token" name="token">
        <option value=""${filterToken === '' ? ' selected' : ''}>all tokens</option>
        ${options}
      </select>
    </div>
    <div class="f">
      <label for="wallet">wallet</label>
      <input id="wallet" name="wallet" type="text" placeholder="0x…"
             value="${esc(filterWallet)}">
    </div>
    <div class="f">
      <label for="limit">rows</label>
      <select id="limit" name="limit">
        ${[100, 500, 2000, 5000].map((n) =>
          `<option value="${n}"${n === limit ? ' selected' : ''}>${n}</option>`).join('')}
      </select>
    </div>
    <button type="submit">apply</button>
    ${filterToken || filterWallet ? '<a class="clear" href="/watchlist">clear</a>' : ''}
  </form>

  <div class="count">
    Showing <strong>${esc(num(rows.length))}</strong> of
    <strong>${esc(num(total))}</strong> matching trade${total === 1 ? '' : 's'}
    across <strong>${esc(num(walletCount))}</strong> wallet${walletCount === 1 ? '' : 's'}.
    ${rows.length < total
      ? `<span class="capped">Capped at ${esc(num(limit))} rows — raise the row count or
         narrow the filter to see the rest.</span>`
      : ''}
  </div>

  <div class="wrapx">
  <table>
    <thead><tr>
      <th>token</th><th>wallet</th><th>side</th><th>token amount</th>
      <th>usd</th><th>time · block</th><th>tx</th>
    </tr></thead>
    <tbody>${body}</tbody>
  </table>
  </div>
</div>
</body>
</html>`;
}
