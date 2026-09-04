/**
 * /tokens — the buyer cohorts collected by the Solana token intake.
 *
 * See docs/SOLANA-TOKEN-INTAKE.md for how the rows underneath are produced.
 *
 * AGGREGATES ARE COMPUTED FROM THE SAME ARRAY THAT RENDERS THE DETAIL ROWS.
 * The collapsed row's purchase count, token total and USD total are summed in
 * the browser over exactly the purchases that appear when the row is expanded,
 * so the two cannot disagree. Computing them in SQL and the detail rows
 * separately is how a header ends up describing a different set than the body.
 *
 * A NULL usd_amount RENDERS AS "unknown", NEVER AS 0 OR $0.00. A reader cannot
 * tell a measured zero from an absent measurement, and a purchase priced at
 * zero dollars is a plausible-looking lie. Where a wallet has some priced and
 * some unpriced purchases, the total is shown with the unpriced count beside
 * it, because a sum that silently drops nulls understates and looks precise.
 *
 * NO REGEX LITERALS IN THE CLIENT SCRIPT. This file is a server-side template
 * literal, so a backslash escape is consumed at build time and the browser
 * receives something different from what is written here. String methods only.
 */
import { escapeHtml } from './views.js';

export interface PurchaseRow {
  signature: string;
  pool: string;
  blockTime: string;
  tokenAmount: number;
  usdAmount: number | null;
  priceUsd: number | null;
  windowTag: string;
}

export interface WalletRow {
  wallet: string;
  tags: { tag: string; source: string }[];
  purchases: PurchaseRow[];
}

export interface WindowRow {
  tag: string;
  start: string;
  end: string;
  label: string | null;
}

/**
 * The one current-price observation this render uses. ONE row per token per
 * render: the header and every Change cell read this same object, so the
 * percentage in a row can always be reconciled against the price printed above
 * it. Letting the two read separate rows is the paired-baseline defect in
 * FAILURE_MODES section 8, and would be invisible -- both numbers would look
 * right on their own.
 */
export interface TokenPrice {
  priceUsd: number;
  pool: string;
  source: string;
  observedAt: string;
}
export interface TokenGroup {
  mint: string;
  ticker: string;
  name: string | null;
  decimals: number;
  chartedPair: string | null;
  /** Null when the token has never been priced; the page must render that. */
  price: TokenPrice | null;
  /** The windows as commissioned, ordered by start. Never derived from purchases. */
  windows: WindowRow[];
  wallets: WalletRow[];
}

export interface ChainGroup { chain: string; tokens: TokenGroup[] }

export function renderTokensPage(args: {
  chains: ChainGroup[];
  generatedAt: Date;
}): string {
  const { chains, generatedAt } = args;
  const payload = JSON.stringify(chains).replace(/</g, '\\u003c');

  const empty = chains.length === 0 || chains.every((c) => c.tokens.length === 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>tokens · command center</title>
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
  .sub{color:var(--muted);font-size:12px;margin:0 0 20px}
  .tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
  .tab{padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--panel);
    color:var(--muted);cursor:pointer;font-size:13px}
  .tab.on{background:var(--accent);border-color:var(--accent);color:#06222a;font-weight:600}
  .tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .tabs.sub-tabs .tab{font-size:12px;padding:5px 12px}
  .header{display:grid;grid-template-columns:minmax(260px,340px) minmax(0,1fr);gap:18px;
    background:var(--panel);border:1px solid var(--border);border-radius:8px;
    padding:14px 16px;margin-bottom:14px}
  @media (max-width:820px){ .header{grid-template-columns:1fr} }
  .hcol h2{margin:0 0 8px;font-size:16px;font-weight:650;letter-spacing:-.01em}
  .hcol h2 .nm{color:var(--muted);font-weight:400;font-size:14px;margin-left:6px}
  .hk{display:grid;grid-template-columns:78px minmax(0,1fr);gap:3px 10px;font-size:12px}
  .hk dt{color:var(--faint);text-transform:uppercase;letter-spacing:.07em;font-size:10px;padding-top:2px}
  .hk dd{margin:0;color:var(--text);word-break:break-all;font-family:ui-monospace,Menlo,monospace}
  .copy{background:transparent;border:1px solid var(--border);color:var(--faint);border-radius:4px;
    font-size:10px;padding:0 5px;margin-left:6px;cursor:pointer}
  .copy:hover{border-color:var(--accent);color:var(--accent)}
  .legend{width:100%;border-collapse:collapse;font-size:12px}
  .legend th{position:static;background:transparent;border-bottom:1px solid var(--border);
    padding:4px 8px;font-size:9px}
  .legend td{padding:5px 8px;border-bottom:1px solid var(--rule,#1e242c);vertical-align:middle}
  .legend tr:last-child td{border-bottom:0}
  .legend .lab{color:var(--muted)}
  .bar{display:flex;gap:10px;flex-wrap:wrap;align-items:end;background:var(--panel);
    border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:14px}
  .f{display:flex;flex-direction:column;gap:4px}
  .f label{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint)}
  .f input,.f select{background:var(--panel2);border:1px solid var(--border);color:var(--text);
    border-radius:5px;padding:5px 8px;font-size:12px;min-width:110px}
  .f input:focus,.f select:focus{outline:1px solid var(--accent)}
  button.mini{background:var(--panel2);border:1px solid var(--border);color:var(--muted);
    border-radius:5px;padding:6px 10px;font-size:12px;cursor:pointer}
  button.mini:hover{color:var(--text);border-color:var(--accent)}
  .count{color:var(--muted);font-size:12px;margin:0 0 8px}
  .tw{overflow-x:auto;border:1px solid var(--border);border-radius:8px;background:var(--panel)}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th{position:sticky;top:0;background:var(--panel2);text-align:left;font-size:10px;
    letter-spacing:.07em;text-transform:uppercase;color:var(--muted);padding:9px 11px;
    white-space:nowrap;border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
  th.nosort{cursor:default}
  th .ar{color:var(--accent);font-size:9px}
  td{padding:8px 11px;border-bottom:1px solid var(--border);vertical-align:top}
  tr.w:hover>td{background:var(--panel2)}
  tr.w{cursor:pointer}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;
    font-family:ui-monospace,Menlo,monospace}
  .addr{font-family:ui-monospace,Menlo,monospace;font-size:12px}
  .unk{color:var(--warn);font-style:italic}
  .up{color:#3fb950;font-variant-numeric:tabular-nums}
  .down{color:#f85149;font-variant-numeric:tabular-nums}
  .part{color:var(--faint);font-size:11px}
  .chip{display:inline-block;background:var(--panel2);border:1px solid var(--border);
    border-radius:11px;padding:1px 9px;font-size:11px;margin:1px 3px 1px 0;white-space:nowrap}
  .chip.man{border-color:var(--accent);color:var(--accent)}
  .chip .x{color:var(--faint);margin-left:5px;cursor:pointer}
  .chip .x:hover{color:var(--bad)}
  .addtag{background:transparent;border:1px dashed var(--border);color:var(--faint);
    border-radius:11px;padding:1px 9px;font-size:11px;cursor:pointer}
  .addtag:hover{border-color:var(--accent);color:var(--accent)}
  .exp{background:#11161c}
  .exp table{font-size:12px}
  .exp th{background:#11161c;position:static;font-size:9px}
  .exp td{border-bottom:1px solid #1e242c;color:var(--muted)}
  .rec{padding:6px 11px;font-size:11px;color:var(--faint);border-bottom:1px solid var(--border)}
  .rec.bad{color:var(--bad)}
  .empty{padding:40px;text-align:center;color:var(--muted)}
  .caret{display:inline-block;width:11px;color:var(--faint)}
  a{color:var(--accent)}
  .toast{position:fixed;right:16px;bottom:16px;background:var(--panel2);border:1px solid var(--accent);
    color:var(--text);padding:9px 14px;border-radius:6px;font-size:12px;opacity:0;
    transition:opacity .2s;pointer-events:none}
  .toast.on{opacity:1}
  .toast.err{border-color:var(--bad);color:var(--bad)}
</style>
</head>
<body>
<div class="wrap">
  <h1>tokens</h1>
  <p class="sub">buyer cohorts · generated ${escapeHtml(generatedAt.toISOString())}</p>
  ${empty ? '<div class="empty">No tokens ingested yet.</div>' : `
  <div class="tabs" id="chainTabs"></div>
  <div class="tabs sub-tabs" id="tokenTabs"></div>
  <div class="header" id="tokenHeader"></div>
  <div class="bar" id="filters"></div>
  <p class="count" id="count"></p>
  <div class="tw"><table>
    <thead><tr id="head"></tr></thead>
    <tbody id="body"></tbody>
  </table></div>`}
</div>
<div class="toast" id="toast"></div>
<script>
const DATA = ${payload};
const $ = function(id){ return document.getElementById(id); };

function fmtNum(v, dp){
  if (v === null || v === undefined) return null;
  return v.toLocaleString('en-US', {minimumFractionDigits: dp, maximumFractionDigits: dp});
}
// A MEASURED SUB-CENT VALUE IS NOT ZERO. Rounding $0.001359 to "$0.00" puts a
// zero on screen for a purchase that did have a price, which reads the same as
// no measurement — the same confusion a null rendered as 0 would cause, one
// decimal place further down.
function fmtUsd(v){
  if (v === null || v === undefined) return null;
  if (v > 0 && v < 0.005) return '&lt;$0.01';
  return '$' + fmtNum(v, 2);
}
const SOLSCAN_ACCT = 'https://solscan.io/account/';
function shortAddr(a){ return a.length <= 14 ? a : a.slice(0,6) + '…' + a.slice(-6); }
function fmtTime(iso){ return iso.replace('T',' ').slice(0,19) + 'Z'; }

function toast(msg, isErr){
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast on' + (isErr ? ' err' : '');
  setTimeout(function(){ t.className = 'toast'; }, 2600);
}

// AGGREGATES ARE SUMS OVER THE SAME ARRAY THE DETAIL ROWS RENDER FROM.
function agg(w){
  let tok = 0, usd = 0, priced = 0, unpriced = 0, first = null, last = null;
  // TOKENS ON PRICED ROWS ONLY, tracked apart from the total. Average cost
  // divides these two, and an unpriced row must leave BOTH sides -- counting
  // its tokens while its USD is absent would divide real dollars by more
  // tokens than those dollars bought, understating every such wallet's cost
  // basis. That is the paired-baseline rule in FAILURE_MODES section 8.
  let tokPriced = 0;
  for (const p of w.purchases){
    tok += p.tokenAmount;
    if (p.usdAmount === null || p.usdAmount === undefined) { unpriced++; }
    else { usd += p.usdAmount; priced++; tokPriced += p.tokenAmount; }
    if (first === null || p.blockTime < first) first = p.blockTime;
    if (last === null || p.blockTime > last) last = p.blockTime;
  }
  // Null, never 0. A wallet with no priced row has an UNKNOWN cost basis, and
  // rendering that as $0.00 would claim it bought for nothing.
  const avg = (priced > 0 && tokPriced > 0) ? (usd / tokPriced) : null;
  return {n: w.purchases.length, tok: tok, usd: usd, priced: priced,
          unpriced: unpriced, first: first, last: last,
          tokPriced: tokPriced, avg: avg};
}

// Percent change from what the wallet paid on average to what the token is
// worth now. Null in, null out -- an unknown cost basis cannot produce a
// percentage, and 0% would read as "went nowhere".
function changePct(avg, price){
  if (avg === null || avg === undefined || !(avg > 0)) return null;
  if (price === null || price === undefined || !(price > 0)) return null;
  return (price - avg) / avg * 100;
}

let state = {chain: 0, token: 0, sort: 'usd', dir: -1, open: {}, f: {}};

function currentToken(){
  const c = DATA[state.chain];
  if (!c) return null;
  return c.tokens[state.token] || null;
}

function allTags(t){
  const s = new Set();
  for (const w of t.wallets) for (const tg of w.tags) s.add(tg.tag);
  return Array.from(s).sort();
}

function renderChainTabs(){
  $('chainTabs').innerHTML = DATA.map(function(c, i){
    return '<div class="tab' + (i === state.chain ? ' on' : '') + '" data-i="' + i + '" tabindex="0">'
      + c.chain + ' <span style="opacity:.7">' + c.tokens.length + '</span></div>';
  }).join('');
  Array.from($('chainTabs').children).forEach(function(el){
    el.onclick = function(){
      state.chain = +el.dataset.i; state.token = 0; state.open = {}; state.f = {}; renderAll(); };
  });
}
function renderTokenTabs(){
  const c = DATA[state.chain];
  $('tokenTabs').innerHTML = c.tokens.map(function(t, i){
    return '<div class="tab' + (i === state.token ? ' on' : '') + '" data-i="' + i + '" tabindex="0">'
      + t.ticker + ' <span style="opacity:.7">' + t.wallets.length + '</span></div>';
  }).join('');
  Array.from($('tokenTabs').children).forEach(function(el){
    el.onclick = function(){
      // FILTERS RESET ON A TOKEN SWITCH. They were written when only one token
      // existed. Carrying fTag='MOS-P1' onto another token filters the table to
      // nothing while the rebuilt select shows "any" — the control and the
      // result would disagree, with no error.
      state.token = +el.dataset.i; state.open = {}; state.f = {}; renderAll(); };
  });
}

function renderHeader(){
  const t = currentToken();
  const chain = DATA[state.chain].chain;
  const ds = 'https://dexscreener.com/solana/' + (t.chartedPair || t.mint);

  // THE LEGEND COUNTS ARE COMPUTED FROM THE SAME ARRAY THE TABLE RENDERS FROM.
  // Reading them from a stored aggregate instead would let the legend and the
  // filtered table disagree while both looked authoritative.
  const perTag = {};
  for (const w of t.wallets){
    const seen = {};
    for (const p of w.purchases){
      if (!perTag[p.windowTag]) perTag[p.windowTag] = {buys: 0, wallets: 0};
      perTag[p.windowTag].buys++;
      if (!seen[p.windowTag]){ seen[p.windowTag] = 1; perTag[p.windowTag].wallets++; }
    }
  }
  const wins = t.windows || [];
  const rows = wins.map(function(w){
    const c = perTag[w.tag] || {buys: 0, wallets: 0};
    return '<tr><td><span class="chip">' + w.tag + '</span></td>'
      + '<td class="num">' + fmtTime(w.start) + '</td>'
      + '<td class="num">' + fmtTime(w.end) + '</td>'
      + '<td class="lab">' + (w.label || '—') + '</td>'
      + '<td class="num">' + c.wallets + '</td>'
      + '<td class="num">' + c.buys + '</td></tr>';
  }).join('');
  // A tag with purchases but no window row is a defect, and is shown as one
  // rather than being quietly left out of the legend.
  const orphan = Object.keys(perTag).filter(function(k){
    return !wins.some(function(w){ return w.tag === k; }); });
  const orphanRow = orphan.length
    ? '<tr><td colspan="6" style="color:var(--warn)">' + orphan.length
      + ' cohort(s) collected but not yet complete, so no window is recorded: '
      + orphan.join(', ') + '</td></tr>'
    : '';

  $('tokenHeader').innerHTML =
    '<div class="hcol">'
      + '<h2>' + t.ticker + '<span class="nm">' + (t.name || '') + '</span></h2>'
      + '<dl class="hk">'
        + '<dt>chain</dt><dd>' + chain + '</dd>'
        + '<dt>pair</dt><dd>' + (t.chartedPair || '—') + '</dd>'
        + '<dt>mint</dt><dd id="mintVal">' + t.mint + copyBtn(t.mint, 'mint') + '</dd>'
        + '<dt>chart</dt><dd><a href="' + ds + '" target="_blank" rel="noopener noreferrer">DexScreener</a></dd>'
        + '<dt>price</dt><dd>' + priceCell(t) + '</dd>'
      + '</dl>'
    + '</div>'
    + '<div class="hcol">'
      + '<table class="legend"><thead><tr><th>window</th><th class="num">from</th>'
      + '<th class="num">to</th><th>label</th><th class="num">wallets</th>'
      + '<th class="num">buys</th></tr></thead><tbody>'
      + (rows || '<tr><td colspan="6" class="lab">No windows recorded.</td></tr>')
      + orphanRow + '</tbody></table>'
    + '</div>';

}

/*
 * The header price. Reads t.price -- the SAME object every Change cell in the
 * table reads -- so the two can never disagree within a render.
 *
 * The observation time and the pool are shown beside the number because
 * neither is optional context: a price is only meaningful with its age (the
 * monitor writes nothing when a read fails, so the last row can be old) and
 * with the pool it came from (price is per pool; this token's pools spanned
 * 0.2351 to 0.2494 at one instant).
 */
function priceCell(t){
  if (!t.price) return '<span class="unk">no price recorded</span>';
  const age = Math.round((Date.now() - Date.parse(t.price.observedAt)) / 1000);
  const ageTxt = age < 90 ? age + 's ago'
    : age < 5400 ? Math.round(age / 60) + 'm ago'
    : Math.round(age / 3600) + 'h ago';
  // Anything older than a few cycles is called out rather than shown plainly,
  // because a stale price silently makes every Change cell stale with it.
  const stale = age > 900 ? ' class="unk"' : '';
  return '<b>$' + fmtNum(t.price.priceUsd, 8) + '</b>'
    + '<span class="part"> ' + t.price.source + ' · pool ' + shortAddr(t.price.pool)
    + ' · <span' + stale + '>' + ageTxt + '</span> (' + fmtTime(t.price.observedAt) + ')</span>';
}

// ONE copy control, used by the header mint and by every wallet row, so the two
// cannot drift apart. The value carried is always the FULL address: truncation
// is display only and must never reach the clipboard or an href.
//
// NOTHING HERE CHANGES CASE. Solana addresses are base58 and case-sensitive; a
// lowercased address yields a Solscan URL that resolves to nothing and a
// clipboard value that matches nothing, with no error anywhere.
function copyBtn(value, label){
  return '<button class="copy" data-copy="' + value + '" title="copy ' + label + '">copy</button>';
}

document.addEventListener('click', function(ev){
  const b = ev.target.closest ? ev.target.closest('[data-copy]') : null;
  if (!b) return;
  ev.stopPropagation();
  ev.preventDefault();
  const v = b.getAttribute('data-copy');
  if (navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(v).then(function(){ toast('copied ' + shortAddr(v)); },
      function(){ toast('could not copy', true); });
  } else { toast('clipboard unavailable', true); }
});

function renderFilters(){
  const t = currentToken();
  const tags = allTags(t);
  $('filters').innerHTML =
    '<div class="f"><label>tag</label><select id="fTag"><option value="">any</option>'
    + tags.map(function(x){ return '<option>' + x + '</option>'; }).join('') + '</select></div>'
    + '<div class="f"><label>wallet contains</label><input id="fW" placeholder="address"></div>'
    + '<div class="f"><label>min purchases</label><input id="fMinN" type="number" min="0"></div>'
    + '<div class="f"><label>min tokens</label><input id="fMinT" type="number" min="0"></div>'
    + '<div class="f"><label>min USD</label><input id="fMinU" type="number" min="0"></div>'
    + '<div class="f"><label>first buy after</label><input id="fAfter" type="datetime-local"></div>'
    + '<div class="f"><label>last buy before</label><input id="fBefore" type="datetime-local"></div>'
    + '<div class="f"><label>&nbsp;</label><button class="mini" id="fClear">clear</button></div>';
  ['fTag','fW','fMinN','fMinT','fMinU','fAfter','fBefore'].forEach(function(id){
    const el = $(id);
    el.value = state.f[id] || '';
    el.oninput = function(){ state.f[id] = el.value; renderTable(); };
    el.onchange = function(){ state.f[id] = el.value; renderTable(); };
  });
  $('fClear').onclick = function(){ state.f = {}; renderFilters(); renderTable(); };
}

const COLS = [
  {k:'tags',  t:'tags',      sort:false},
  {k:'wallet',t:'wallet',    sort:true},
  {k:'n',     t:'buys',      sort:true, num:true},
  {k:'tok',   t:'tokens',    sort:true, num:true},
  {k:'usd',   t:'usd',       sort:true, num:true},
  {k:'avg',   t:'avg cost',  sort:true, num:true},
  {k:'chg',   t:'change',    sort:true, num:true},
  {k:'first', t:'first buy', sort:true},
  {k:'last',  t:'last buy',  sort:true}
];

function renderHead(){
  $('head').innerHTML = '<th class="nosort"></th>' + COLS.map(function(c){
    const on = state.sort === c.k;
    const ar = on ? ' <span class="ar">' + (state.dir === 1 ? '▲' : '▼') + '</span>' : '';
    return '<th class="' + (c.sort ? '' : 'nosort') + (c.num ? ' num' : '') + '" data-k="' + c.k + '">'
      + c.t + ar + '</th>';
  }).join('');
  Array.from($('head').children).forEach(function(th){
    const k = th.dataset.k;
    const col = COLS.filter(function(c){ return c.k === k; })[0];
    if (!col || !col.sort) return;
    th.onclick = function(){
      if (state.sort === k) state.dir = -state.dir; else { state.sort = k; state.dir = -1; }
      renderAll();
    };
  });
}

function rows(){
  const t = currentToken();
  const f = state.f;
  const out = [];
  for (const w of t.wallets){
    const a = agg(w);
    if (f.fTag && !w.tags.some(function(x){ return x.tag === f.fTag; })) continue;
    if (f.fW && w.wallet.toLowerCase().indexOf(f.fW.toLowerCase()) === -1) continue;
    if (f.fMinN && a.n < +f.fMinN) continue;
    if (f.fMinT && a.tok < +f.fMinT) continue;
    if (f.fMinU && a.usd < +f.fMinU) continue;
    if (f.fAfter && (a.first === null || a.first < f.fAfter.replace('T',' '))) continue;
    if (f.fBefore && (a.last === null || a.last > f.fBefore.replace('T',' '))) continue;
    out.push({w: w, a: a});
  }
  // THE PRICE IS READ ONCE, HERE, and the same value reaches every row. The
  // header renders from this identical object, so a Change cell can always be
  // reconciled against the price shown above the table.
  const px = t.price ? t.price.priceUsd : null;
  for (const r of out) r.a.chg = changePct(r.a.avg, px);

  const k = state.sort, d = state.dir;
  out.sort(function(x, y){
    let A, B;
    if (k === 'wallet'){ A = x.w.wallet; B = y.w.wallet; }
    else if (k === 'first' || k === 'last'){ A = x.a[k] || ''; B = y.a[k] || ''; }
    else { A = x.a[k]; B = y.a[k]; }
    // Unknown is not a quantity and must not sort as one. Nulls collect at the
    // bottom whichever way the column is sorted, rather than posing as the
    // smallest value and topping an ascending sort.
    const an = (A === null || A === undefined), bn = (B === null || B === undefined);
    if (an && bn) return 0;
    if (an) return 1;
    if (bn) return -1;
    if (A < B) return -d;
    if (A > B) return d;
    return 0;
  });
  return out;
}

// Average cost is per token, so it needs far more precision than a dollar
// figure -- these tokens trade at $0.001 and $0.25. Unknown is rendered as the
// word, in the same style as an unpriced USD cell, never as $0.00.
function avgCell(a){
  if (a.avg === null) return '<span class="unk">unknown</span>';
  /*
   * A value too small to show at 8dp must NOT be printed as $0.00000000. One
   * wallet's only buy carries 8.27 tokens against a USD amount of 5.7e-14 --
   * float residue on the paid side, the mirror of the dust legs removed from
   * the token side -- and its average is genuinely about 7e-15. Rendered
   * fixed-width that reads as a hard zero, which is a different and much
   * stronger claim than "smaller than this column can show".
   */
  let s = a.avg < 0.00000001
    ? '$' + a.avg.toExponential(1) + ' <span class="part">below display precision</span>'
    : '$' + fmtNum(a.avg, 8);
  // Say so when the average rests on only part of the wallet's buying, rather
  // than presenting a partial basis as a complete one.
  if (a.unpriced > 0) s += ' <span class="part">of ' + a.priced + '/' + a.n + '</span>';
  return s;
}

function chgCell(a){
  if (a.chg === null || a.chg === undefined) return '<span class="unk">unknown</span>';
  const cls = a.chg >= 0 ? 'up' : 'down';
  const sign = a.chg >= 0 ? '+' : '';
  return '<span class="' + cls + '">' + sign + fmtNum(a.chg, 2) + '%</span>';
}

function usdCell(a){
  if (a.priced === 0) return '<span class="unk">unknown</span>';
  let s = fmtUsd(a.usd);
  if (a.unpriced > 0) s += ' <span class="part">+' + a.unpriced + ' unpriced</span>';
  return s;
}

function tagCell(w){
  return w.tags.map(function(tg){
    return '<span class="chip' + (tg.source === 'manual' ? ' man' : '') + '">' + tg.tag
      + '<span class="x" data-act="del" data-w="' + w.wallet + '" data-t="' + tg.tag + '">×</span></span>';
  }).join('') + '<span class="addtag" data-act="add" data-w="' + w.wallet + '">+</span>';
}

function renderTable(){
  const list = rows();
  const t = currentToken();
  const totalBuys = list.reduce(function(s, r){ return s + r.a.n; }, 0);
  $('count').textContent = list.length + ' of ' + t.wallets.length + ' wallets · '
    + totalBuys + ' purchases shown';
  const body = $('body');
  if (list.length === 0){ body.innerHTML = '<tr><td colspan="10" class="empty">No wallets match these filters.</td></tr>'; return; }
  let html = '';
  for (const r of list){
    const w = r.w, a = r.a;
    const isOpen = !!state.open[w.wallet];
    html += '<tr class="w" data-w="' + w.wallet + '">'
      + '<td><span class="caret">' + (isOpen ? '▾' : '▸') + '</span></td>'
      + '<td>' + tagCell(w) + '</td>'
      + '<td class="addr"><a href="' + SOLSCAN_ACCT + w.wallet
        + '" target="_blank" rel="noopener noreferrer">' + shortAddr(w.wallet) + '</a>'
        + copyBtn(w.wallet, 'wallet') + '</td>'
      + '<td class="num">' + a.n + '</td>'
      + '<td class="num">' + fmtNum(a.tok, 4) + '</td>'
      + '<td class="num">' + usdCell(a) + '</td>'
      + '<td class="num">' + avgCell(a) + '</td>'
      + '<td class="num">' + chgCell(a) + '</td>'
      + '<td class="num">' + (a.first ? fmtTime(a.first) : '—') + '</td>'
      + '<td class="num">' + (a.last ? fmtTime(a.last) : '—') + '</td>'
      + '</tr>';
    if (isOpen){
      const ps = w.purchases.slice().sort(function(x, y){ return x.blockTime < y.blockTime ? -1 : 1; });
      let sumTok = 0, sumUsd = 0, nUnp = 0;
      let inner = '<table><thead><tr><th>time</th><th>window</th><th class="num">tokens</th>'
        + '<th class="num">usd</th><th class="num">price</th><th>pool</th><th>signature</th></tr></thead><tbody>';
      for (const p of ps){
        sumTok += p.tokenAmount;
        if (p.usdAmount === null || p.usdAmount === undefined) nUnp++; else sumUsd += p.usdAmount;
        inner += '<tr><td class="num">' + fmtTime(p.blockTime) + '</td>'
          + '<td><span class="chip">' + p.windowTag + '</span></td>'
          + '<td class="num">' + fmtNum(p.tokenAmount, 6) + '</td>'
          + '<td class="num">' + (p.usdAmount === null || p.usdAmount === undefined
              ? '<span class="unk">unknown</span>' : fmtUsd(p.usdAmount)) + '</td>'
          + '<td class="num">' + (p.priceUsd === null || p.priceUsd === undefined
              ? '<span class="unk">unknown</span>' : '$' + fmtNum(p.priceUsd, 8)) + '</td>'
          + '<td class="addr">' + shortAddr(p.pool) + '</td>'
          + '<td class="addr"><a href="https://solscan.io/tx/' + p.signature
          + '" target="_blank" rel="noopener">' + shortAddr(p.signature) + '</a></td></tr>';
      }
      inner += '</tbody></table>';
      // RECONCILIATION, SHOWN NOT ASSERTED: the collapsed row's figures are
      // re-summed here from the rows actually rendered above.
      const okTok = Math.abs(sumTok - a.tok) < 1e-9;
      const okUsd = Math.abs(sumUsd - a.usd) < 1e-6;
      const okN = ps.length === a.n;
      const good = okTok && okUsd && okN;
      // "$0.00 priced" for a wallet where NOTHING was priced renders a measured
      // zero where there is no measurement — the same defect as a $0.00 cell,
      // just in the summary line instead of the table.
      const pricedTxt = (ps.length - nUnp) === 0
        ? 'none priced'
        : fmtUsd(sumUsd) + ' priced';
      const rec = '<div class="rec' + (good ? '' : ' bad') + '">'
        + (good
          ? 'reconciles: ' + ps.length + ' purchases, ' + fmtNum(sumTok, 4) + ' tokens, '
            + pricedTxt + (nUnp ? ', ' + nUnp + ' unpriced' : '')
          : 'MISMATCH between the summary row and these purchases')
        + '</div>';
      html += '<tr class="exp"><td colspan="8">' + rec + inner + '</td></tr>';
    }
  }
  body.innerHTML = html;
  Array.from(body.querySelectorAll('tr.w')).forEach(function(tr){
    tr.onclick = function(ev){
      // clicking a tag control, a copy button or a link must not toggle the row
      if (ev.target.closest && ev.target.closest('[data-act],[data-copy],a')) return;
      const w = tr.dataset.w;
      state.open[w] = !state.open[w];
      renderTable();
    };
  });
  Array.from(body.querySelectorAll('[data-act]')).forEach(function(el){
    el.onclick = function(ev){
      ev.stopPropagation();
      if (el.dataset.act === 'del') editTag(el.dataset.w, el.dataset.t, 'remove');
      else {
        const v = prompt('Tag for ' + shortAddr(el.dataset.w));
        if (v && v.trim()) editTag(el.dataset.w, v.trim(), 'add');
      }
    };
  });
}

function editTag(wallet, tag, action){
  const t = currentToken();
  fetch('/api/token-wallet-tag', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({mint: t.mint, wallet: wallet, tag: tag, action: action})
  }).then(function(r){ return r.json().then(function(j){ return {ok: r.ok, j: j}; }); })
    .then(function(res){
      if (!res.ok){ toast(res.j.error || 'write failed', true); return; }
      const wr = t.wallets.filter(function(x){ return x.wallet === wallet; })[0];
      if (wr){
        if (action === 'remove') wr.tags = wr.tags.filter(function(x){ return x.tag !== tag; });
        else if (!wr.tags.some(function(x){ return x.tag === tag; })) wr.tags.push({tag: tag, source: 'manual'});
        else wr.tags = wr.tags.map(function(x){ return x.tag === tag ? {tag: tag, source: 'manual'} : x; });
      }
      renderFilters(); renderTable();
      toast(action === 'add' ? 'tag added' : 'tag removed');
    })
    .catch(function(e){ toast(String(e), true); });
}

function renderAll(){ renderChainTabs(); renderTokenTabs(); renderHeader(); renderFilters(); renderHead(); renderTable(); }
if (DATA.length) renderAll();
</script>
</body>
</html>`;
}
