/**
 * CATE wallet PnL page.
 *
 * A STATIC TABLE, not a monitor panel. The 556 rows are a finished analysis of
 * one token's bonding-curve buyers, loaded once; nothing appends to it. It
 * therefore has no schedule, no adapter and no retention -- it is a small
 * reference table with a page in front of it.
 *
 * TABS ARE DATA-DRIVEN. "All wallets" is the default and unions every token:
 * one row per DISTINCT wallet with its figures summed, so a wallet that appears
 * in several tokens is one row, not several. Per-token tabs follow, one per
 * distinct `token` value found in the rows, then Groups.
 *
 * Adding a token is an INSERT with a new token value. No code here changes: the
 * tab appears, the union picks the wallets up, and tokens_touched starts
 * reporting more than 1 on its own. With a single token loaded every wallet
 * shows 1, which is the correct answer rather than a placeholder.
 *
 * A ROW IS IDENTIFIED BY (wallet, token). Keying on wallet alone would make
 * loading a second token overwrite the first rather than add to it.
 *
 * ALL ROWS ARE SENT TO THE BROWSER and sorted, grouped and paginated there.
 * At this size that is a few hundred kB and makes every interaction instant,
 * with no round trip. It also keeps sorting honest: the requirement is that
 * sorting orders the WHOLE set rather than reshuffling whichever 50 rows happen
 * to be on screen, which server-side paging makes easy to get wrong.
 *
 * The `tag` column is plain editable text in the database, never derived at
 * read time. The initial values are generated mechanically from matching hold
 * times, but they are only a starting point -- renaming or reassigning one by
 * hand must not be silently undone by a recompute.
 */

import { escapeHtml } from './views.js';

export interface CatePnlRow {
  token: string;
  /** Which chain the wallet trades on — decides the explorer link. */
  chain: string;
  /** What realized_pnl is denominated in. SOL and ETH are not comparable. */
  quote_asset: string;
  /** Left-joined from wallet_clusters; null when the wallet is unclustered. */
  cluster_id: string | null;
  cluster_signal: string | null;
  cluster_confidence: string | null;
  /** How many clusters this wallet belongs to. A wallet may sit in several
   *  once the same signal links it to more than one distinct group. */
  cluster_count: number;
  /** How realized_pnl_usd was priced — a method for the Solana tokens, a
   *  constant for NTF. Shown in the UI because a USD figure with no visible
   *  basis invites being read as live-priced. */
  rate_basis: string | null;
  /** True when the wallet sold tokens it never bought in our window, so its
   *  PnL rests on a cost basis we cannot see. */
  pre_window_entry: boolean;
  wallet: string;
  tag: string | null;
  /** 'auto' | 'manual' | null. A regroup rewrites only its own rows. */
  tag_source: string | null;
  first_buy_time_utc: string;
  first_buy_mcap_usd: number;
  last_sell_time_utc: string | null;
  n_buys: number;
  n_sells: number;
  sol_in: number;
  sol_out: number;
  realized_pnl_sol: number;
  realized_pnl_usd: number;
  tokens_still_held: number;
  hold_min: number | null;
  sold_out: boolean;
  /** Token units bought and sold inside the tracked pool and window. */
  tokens_bought: number | null;
  tokens_sold: number | null;
  /** TWO BALANCE COLUMNS, NEVER ONE. `implied_balance` is bought minus sold
   *  from decoded swaps in the tracked pool; `onchain_balance` is a balanceOf
   *  read at a stated block. They answer different questions and a per-wallet
   *  disagreement is information, not a bug — it means the wallet moved tokens
   *  outside the pool or the window. Null means never measured, which is not
   *  the same fact as zero. */
  implied_balance: number | null;
  onchain_balance: number | null;
  balance_delta: number | null;
  balance_match: boolean | null;
  unrealized_pnl_usd: number | null;
  still_holding: boolean | null;
  /** True when the wallet moved this token to or from a non-pool address
   *  inside the window, so its realized PnL covers the tracked pool only. */
  has_off_pool_activity: boolean | null;
}

/**
 * One row per (token, chain): how the cohort was cut, and what bounded it.
 *
 * `threshold_binding` exists so a threshold column is never misread as a filter
 * that selected something. PONS admitted 1,051 of 1,051 wallets against a $10M
 * ceiling because the highest first-buy market cap was $394,932 — the cohort is
 * defined by its window, not by the threshold. Other tokens will bind.
 */
export interface TokenMetaRow {
  token: string;
  chain: string;
  quote_asset: string;
  dex: string | null;
  dex_version: string | null;
  pool_address: string | null;
  window_hours: number | null;
  window_start_utc: string | null;
  window_end_utc: string | null;
  first_swap_block: number | null;
  boundary_block: number | null;
  swaps_in_window: number | null;
  unique_txs: number | null;
  fully_covered: boolean | null;
  total_supply: number | null;
  mcap_threshold_usd: number | null;
  threshold_binding: boolean | null;
  threshold_note: string | null;
  fee_rate_buy: number | null;
  fee_rate_sell: number | null;
  cohort_size: number | null;
  price_usd: number | null;
  price_block: number | null;
  balance_block: number | null;
  decode_check: string | null;
}

/**
 * Group membership, by behaviour inside the analysis window.
 *
 * Stored rather than derived, because the derivation needs transfer logs that
 * never reach Postgres. The SQL-only proxies were measured and both fail: group
 * 1 by `not has_off_pool_activity` returns 119 of 266, and group 3 by a balance
 * shortfall selects 32 wallets for 8 real members.
 */
export interface GroupRow { token: string; wallet: string; groupNo: number }

/**
 * The newest balance reading per wallet from the append-only scan series.
 *
 * `balanceRaw` is null when the read failed; the page must show that as unknown
 * rather than zero, which is the whole reason the scanner records a status.
 */
export interface ScanRow {
  token: string;
  wallet: string;
  balanceRaw: string | null;
  status: string;
  block: number;
  readAt: string | null;
}

/**
 * A per-token wallet tag.
 *
 * Stored in wallet_tags, NOT wallet_pnl.tag: that column is written by
 * /api/wallet-tag with no token filter, so a tag set here would spread to the
 * same wallet's rows in every other token. Absence of a row means no tag.
 */
export interface TagRow { token: string; chain: string; wallet: string; tag: string }

/** A wallet_clusters row. Independent of wallet_pnl and its cohort filter. */
export interface ClusterRow {
  chain: string;
  wallet: string;
  cluster_id: string;
  signal: string;
  evidence: string;
  confidence: string;
  cluster_size: number;
  /** True when this wallet also has a wallet_pnl row. 259 of 274 do not. */
  has_pnl: boolean;
}

export function renderCatePnlPage(
  rows: CatePnlRow[],
  clusters: ClusterRow[],
  generatedAt: Date,
  tokenMeta: TokenMetaRow[] = [],
  groups: GroupRow[] = [],
  scans: ScanRow[] = [],
  tags: TagRow[] = [],
): string {
  const tokens = [...new Set(rows.map((r) => r.token))].sort();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wallet PnL</title>
<style>
  :root { color-scheme: light dark;
    --bg:#0e1116; --panel:#161b22; --border:#262d38; --text:#e6edf3;
    --muted:#8b949e; --link:#6cb6ff; --ok:#2ecc71; --warn:#f2a33c; --bad:#ff6b6b; --idle:#6e7681; }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f8fa; --panel:#fff; --border:#d8dee4; --text:#1f2328; --muted:#636c76; --link:#0969da; } }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1500px; margin:0 auto; padding:28px 20px 56px; }
  header.top { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:16px; }
  h1 { font-size:20px; margin:0; } h1 span { color:var(--muted); font-weight:400; }
  .generated { color:var(--muted); font-size:13px; }
  a.back { color:var(--link); text-decoration:none; font-size:13px; }
  .tabs { display:flex; gap:4px; border-bottom:1px solid var(--border); margin-bottom:16px; flex-wrap:wrap; }
  .tabs button { background:none; border:none; border-bottom:2px solid transparent; color:var(--muted); padding:9px 16px; font-size:14px; cursor:pointer; font-weight:600; }
  .tabs button.on { color:var(--link); border-bottom-color:var(--link); }
  /* Robinhood-chain views. Chain comes from the rows, not a hardcoded list, so a
     new Solana token never turns green by accident. */
  .tabs button.rh { color:var(--ok); }
  .tabs button.rh.on { color:var(--ok); border-bottom-color:var(--ok); }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .card h3 { margin:0 0 5px; font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; }
  .card .big { margin:0; font-size:20px; font-variant-numeric:tabular-nums; }
  .filters { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
  .frow { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-end; }
  .f { display:flex; flex-direction:column; gap:3px; }
  .f label { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); font-weight:600; }
  .f input, .f select { background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:6px; padding:5px 8px; font-size:13px; font-family:inherit; }
  .f input.num { width:86px; } .f input.date { width:132px; } .f input.txt { width:180px; }
  .f .pair { display:flex; gap:4px; align-items:center; } .f .pair span { color:var(--muted); font-size:11px; }
  .btn { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:7px; padding:6px 13px; font-size:13px; cursor:pointer; font-family:inherit; }
  .btn:hover { border-color:var(--link); color:var(--link); }
  .btn.pri { background:var(--link); border-color:var(--link); color:#0b0e13; font-weight:600; }
  .btn:disabled { opacity:.4; cursor:default; }
  .toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
  .count { color:var(--muted); font-size:12px; }
  .tablebox { background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:auto; max-height:58vh; }
  table { border-collapse:separate; border-spacing:0; width:100%; font-size:13px; }
  thead th { position:sticky; top:0; z-index:2; background:var(--panel); border-bottom:1px solid var(--border); text-align:right; padding:8px 9px; white-space:nowrap; cursor:pointer; user-select:none; font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  .cl { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:600; }
  .cl-high { background:rgba(80,200,120,.16); color:#4ec27a; border:1px solid rgba(80,200,120,.4); }
  .cl-medium { background:rgba(200,170,80,.13); color:#c2a34e; border:1px solid rgba(200,170,80,.32); }
  .cl-low { background:rgba(200,90,90,.13); color:#c26a6a; border:1px solid rgba(200,90,90,.32); }
  .sig { font-size:10px; color:var(--muted); }
  .zb { display:inline-block; padding:0 5px; border-radius:3px; font-size:10px; font-weight:600;
        background:rgba(200,140,60,.15); color:#c98c3c; border:1px solid rgba(200,140,60,.4); }
  .nopnl { font-size:10px; color:var(--muted); border:1px dashed var(--border); border-radius:3px; padding:0 4px; }
  .note { margin:10px 0; padding:9px 12px; border:1px solid var(--border); border-left:3px solid var(--link); border-radius:6px; font-size:12px; color:var(--muted); background:var(--panel); }
  thead th.nosort { cursor:default; opacity:.75; }
  a.exp { color:var(--muted); text-decoration:none; font-size:11px; }
  a.exp:hover { color:var(--link); }
  thead th.l { text-align:left; } thead th:hover { color:var(--text); }
  thead th .arrow { opacity:.5; font-size:9px; }
  tbody td { border-bottom:1px solid var(--border); padding:6px 9px; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  tbody td.l { text-align:left; } tbody tr:hover { background:rgba(127,127,127,.07); }
  tbody tr.sel { background:rgba(108,182,255,.10); }
  tbody tr.grouphead td { background:rgba(108,182,255,.10); font-weight:600; color:var(--link); cursor:pointer; }
  .pos { color:var(--ok); } .neg { color:var(--bad); }
  .bad { color:var(--bad); font-weight:600; }
  input.bad { border-color:var(--bad); }
  input.okflash { border-color:var(--ok); }
  .wallet { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; border-bottom:1px dotted var(--muted); }
  .wallet:hover { color:var(--link); }
  .tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:999px; background:rgba(108,182,255,.15); color:var(--link); cursor:text; }
  .tag.man { background:rgba(46,204,113,.16); color:var(--ok); }
  .tagempty { color:var(--muted); cursor:text; border-bottom:1px dashed var(--border); }
  .tagin { background:var(--bg); color:var(--text); border:1px solid var(--link); border-radius:5px; padding:1px 5px; font-size:12px; width:110px; font-family:inherit; }
  .muted { color:var(--muted); }
  .pager { display:flex; align-items:center; gap:5px; flex-wrap:wrap; margin-top:12px; }
  .pager button { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:6px; min-width:32px; padding:5px 8px; font-size:13px; cursor:pointer; font-variant-numeric:tabular-nums; }
  .pager button.on { background:var(--link); border-color:var(--link); color:#0b0e13; font-weight:700; }
  .pager button:disabled { opacity:.4; cursor:default; }
  .cl { display:inline-block; padding:1px 6px; border-radius:4px; font-size:11px; font-weight:600; }
  .cl-high { background:rgba(80,200,120,.16); color:#4ec27a; border:1px solid rgba(80,200,120,.4); }
  .cl-medium { background:rgba(200,170,80,.13); color:#c2a34e; border:1px solid rgba(200,170,80,.32); }
  .cl-low { background:rgba(200,90,90,.13); color:#c26a6a; border:1px solid rgba(200,90,90,.32); }
  .sig { font-size:10px; color:var(--muted); }
  .zb { display:inline-block; padding:0 5px; border-radius:3px; font-size:10px; font-weight:600;
        background:rgba(200,140,60,.15); color:#c98c3c; border:1px solid rgba(200,140,60,.4); }
  .nopnl { font-size:10px; color:var(--muted); border:1px dashed var(--border); border-radius:3px; padding:0 4px; }
  .note { background:rgba(242,163,60,.10); border:1px solid var(--warn); border-radius:8px; padding:8px 12px; font-size:12px; color:var(--text); margin-bottom:12px; }
  #toast { position:fixed; bottom:22px; left:50%; transform:translateX(-50%); padding:8px 16px; border-radius:8px; font-size:13px; font-weight:600; opacity:0; transition:opacity .18s; pointer-events:none; background:var(--link); color:#0b0e13; z-index:50; }
  #toast.show { opacity:1; } #toast.err { background:var(--bad); color:#fff; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div><h1>Wallet PnL <span id="sub"></span></h1><a class="back" href="/">&larr; back to dashboard</a></div>
    <div class="generated">generated ${escapeHtml(generatedAt.toISOString())}</div>
  </header>
  <div class="tabs" id="tabs"></div>
  <div id="view"></div>
</div>
<div id="toast"></div>
<script>
const ROWS = ${JSON.stringify(rows)};
const CLUSTERS = ${JSON.stringify(clusters)};
const TOKENS = ${JSON.stringify(tokens)};
const TOKENMETA = ${JSON.stringify(tokenMeta)};
const GROUPS = ${JSON.stringify(groups)};
const SCANS = ${JSON.stringify(scans)};
const TAGS = ${JSON.stringify(tags)};
const PER = 50;
let tab = '__all';
let sortKey='realized_pnl_sol', sortDir=-1, page=1, mode='flat';
// The union view has its own sort default: wallets seen across several tokens
// are the interesting ones, so they lead regardless of size.
let aSortKey='total_pnl_usd', aSortDir=-1;
let gSortDir=-1;
const sel = new Set();
const open = new Set();
const F = {};   // active filters

const NUMCOLS=[['n_buys','Buys'],['n_sells','Sells'],['sol_in','SOL in'],['sol_out','SOL out'],
  ['realized_pnl_sol','PnL SOL'],['realized_pnl_usd','PnL USD'],['tokens_still_held','Held'],
  ['hold_min','Hold min'],['first_buy_mcap_usd','Buy mcap $'],
  ['tokens_bought','Bought'],['tokens_sold','Sold'],['implied_balance','Implied bal'],
  ['onchain_balance','On-chain bal'],['balance_delta','Bal delta'],
  ['unrealized_pnl_usd','Unreal USD']];
const COLS=[
  {k:'_sel', t:'', l:true, kind:'sel'},
  {k:'wallet',t:'Wallet',l:true,kind:'wallet'},
  {k:'tag',t:'Tag',l:true,kind:'tag'},
  {k:'cluster',t:'Cluster',l:true,kind:'cluster'},
  {k:'first_buy_time_utc',t:'First buy',l:true,kind:'time'},
  {k:'first_buy_mcap_usd',t:'Buy mcap $',kind:'num',d:0},
  {k:'last_sell_time_utc',t:'Last sell',l:true,kind:'time'},
  {k:'n_buys',t:'Buys',kind:'int'},{k:'n_sells',t:'Sells',kind:'int'},
  {k:'sol_in',t:'SOL in',kind:'num',d:3},{k:'sol_out',t:'SOL out',kind:'num',d:3},
  {k:'realized_pnl_sol',t:'PnL SOL',kind:'pnl',d:3},{k:'realized_pnl_usd',t:'PnL USD',kind:'pnl',d:0},
  {k:'tokens_still_held',t:'Held',kind:'num',d:0},{k:'hold_min',t:'Hold min',kind:'num',d:1},
  {k:'sold_out',t:'Sold out',kind:'bool'},
  {k:'tokens_bought',t:'Bought',kind:'num',d:0},
  {k:'tokens_sold',t:'Sold',kind:'num',d:0},
  // Both balances, side by side and never collapsed into one. Implied is our
  // decode of the tracked pool; on-chain is a balanceOf read at a stated block.
  {k:'implied_balance',t:'Implied bal',kind:'num',d:0},
  {k:'onchain_balance',t:'On-chain bal',kind:'num',d:0},
  {k:'balance_delta',t:'Bal delta',kind:'num',d:0},
  {k:'balance_match',t:'Bal match',kind:'bool'},
  {k:'unrealized_pnl_usd',t:'Unreal USD',kind:'usd',d:0},
  {k:'still_holding',t:'Holding',kind:'bool'},
  {k:'has_off_pool_activity',t:'Off-pool',kind:'bool'},
];
const nz=(v)=>v===null||v===undefined||v==='';
const fmt=(v,d)=>nz(v)?'<span class="muted">—</span>':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(msg,err){const t=document.getElementById('toast');t.textContent=msg;
  t.className='show'+(err?' err':'');setTimeout(()=>t.className='',err?2600:1200);}

function tokenRows(){ return ROWS.filter(r=>r.token===tab); }
/** A token's chain, read off its rows rather than assumed. */
var _cmemo = null;
function chainOf(t){
  if(!_cmemo){ _cmemo={}; ROWS.forEach(function(r){ _cmemo[r.token]=r.chain; }); }
  return _cmemo[t]||'';
}

/**
 * The quote asset is a property of the TOKEN, not of the page.
 *
 * These headers were hardcoded to SOL in the CATE era. CATE and CYBERLEEK quote
 * in SOL, NTF in ETH, PONS in WETH and AI in NVDA, so a fixed "SOL in" header
 * mislabels three of five tabs. The union tab spans several quote assets at
 * once and so gets a generic label rather than any one asset's name.
 */
function quoteOf(){
  if(tab==='__all'||tab==='__groups') return 'quote';
  var qs=[];
  tokenRows().forEach(function(r){ if(r.quote_asset&&qs.indexOf(r.quote_asset)<0) qs.push(r.quote_asset); });
  return qs.length===1?qs[0]:'quote';
}
function colTitle(c){
  var Q=quoteOf();
  if(c.k==='sol_in') return Q+' in';
  if(c.k==='sol_out') return Q+' out';
  if(c.k==='realized_pnl_sol') return 'PnL '+Q;
  return c.t;
}

const ACOLS=[
  {k:'_sel',t:'',l:true,kind:'sel'},
  {k:'wallet',t:'Wallet',l:true,kind:'wallet'},
  {k:'tag',t:'Tag',l:true,kind:'tag'},
  {k:'tokens_touched',t:'Tokens',kind:'int'},
  {k:'tokens',t:'Token list',l:true,kind:'tokens'},
  {k:'quote_assets',t:'Quote',l:true,kind:'quote'},
  {k:'cluster',t:'Cluster',l:true,kind:'cluster'},
  // MIXED UNITS: a wallet may hold SOL-quoted and ETH-quoted PnL. Summing or
  // ordering those would be meaningless, so this column carries no sort on the
  // union tab. Per-token tabs are single-asset and keep their sort.
  {k:'total_pnl_usd',t:'Total PnL USD',kind:'usd',d:0},
  {k:'total_pnl_sol',t:'PnL quote (mixed)',kind:'pnl',d:3,nosort:true},
  {k:'total_sol_in',t:'Total quote in',kind:'num',d:3},
  {k:'total_sol_out',t:'Total quote out',kind:'num',d:3},
  {k:'total_buys',t:'Buys',kind:'int'},
  {k:'total_sells',t:'Sells',kind:'int'},
  {k:'earliest_first_buy',t:'Earliest first buy',l:true,kind:'time'},
  {k:'latest_last_sell',t:'Latest last sell',l:true,kind:'time'},
];

/**
 * One row per DISTINCT wallet, summed across every token it appears in.
 * Built from the rows already in the page -- no second query, and it starts
 * reporting real multi-token counts the moment another token is inserted.
 */
function unionRows(){
  const by=new Map();
  for(const r of ROWS){
    let u=by.get(r.wallet);
    if(!u){ u={wallet:r.wallet, tag:null, _tags:new Set(), _manual:false, _tok:new Set(),
      _q:new Set(), _chain:new Set(),
      total_pnl_sol:0, total_pnl_usd:0, total_sol_in:0, total_sol_out:0, total_buys:0, total_sells:0,
      pre_window_entry:false, _basis:new Set(),
      earliest_first_buy:null, latest_last_sell:null};
      by.set(r.wallet,u); }
    u._tok.add(r.token);
    if(r.quote_asset) u._q.add(r.quote_asset);
    if(r.cluster_id){ u.cluster_id=r.cluster_id; u.cluster_signal=r.cluster_signal;
                      u.cluster_confidence=r.cluster_confidence; }
    if(r.chain) u._chain.add(r.chain);
    if(r.tag){ u._tags.add(r.tag); if(r.tag_source==='manual') u._manual=true; }
    u.total_pnl_sol+=r.realized_pnl_sol;
    u.total_pnl_usd+=(r.realized_pnl_usd||0);
    if(r.pre_window_entry) u.pre_window_entry=true;
    if(r.rate_basis) u._basis.add(r.rate_basis); u.total_sol_in+=r.sol_in; u.total_sol_out+=r.sol_out;
    u.total_buys+=r.n_buys; u.total_sells+=r.n_sells;
    if(r.first_buy_time_utc && (!u.earliest_first_buy || r.first_buy_time_utc<u.earliest_first_buy))
      u.earliest_first_buy=r.first_buy_time_utc;
    if(r.last_sell_time_utc && (!u.latest_last_sell || r.last_sell_time_utc>u.latest_last_sell))
      u.latest_last_sell=r.last_sell_time_utc;
  }
  for(const u of by.values()){
    u.tokens=[...u._tok].sort().join(', ');
    u.tokens_touched=u._tok.size;
    u.quote_assets=[...u._q].sort().join(' + ');
    u.rate_basis=[...u._basis][0]||null;
    u.chain=u._chain.size===1?[...u._chain][0]:'mixed';
    // A wallet tagged differently per token shows both rather than silently
    // picking one.
    u.tag=u._tags.size?[...u._tags].sort().join(' / '):null;
    u.tag_source=u._manual?'manual':(u._tags.size?'auto':null);
  }
  return [...by.values()];
}

/** Filters apply to the whole token set, before sorting and paging. */
function filtered(){
  const all = tab==='__all' ? unionRows() : tokenRows();
  const isU = tab==='__all';
  const pnlK = isU?'total_pnl_sol':'realized_pnl_sol';
  const inK  = isU?'total_sol_in':'sol_in';
  const outK = isU?'total_sol_out':'sol_out';
  const buyK = isU?'total_buys':'n_buys';
  const sellK= isU?'total_sells':'n_sells';
  const fbK  = isU?'earliest_first_buy':'first_buy_time_utc';
  const lsK  = isU?'latest_last_sell':'last_sell_time_utc';
  const MAP={realized_pnl_sol:pnlK, sol_in:inK, sol_out:outK, n_buys:buyK, n_sells:sellK};
  return all.filter(r=>{
    if(F.q && !r.wallet.toLowerCase().includes(F.q.toLowerCase())) return false;
    if(F.tagMode==='tagged' && !r.tag) return false;
    if(F.tagMode==='untagged' && r.tag) return false;
    if(F.tag && r.tag!==F.tag) return false;
    if(!isU && F.sold==='yes' && !r.sold_out) return false;
    if(!isU && F.sold==='no' && r.sold_out) return false;
    // tokens_touched filter: works unchanged once a second token exists
    if(F.tt && F.tt!=='all'){
      const n = isU ? r.tokens_touched : 1;
      if(F.tt==='1' && n!==1) return false;
      if(F.tt==='2+' && n<2) return false;
      if(/^=\\d+$/.test(F.tt) && n!==Number(F.tt.slice(1))) return false;
    }
    for(const [k] of NUMCOLS){
      const kk = MAP[k] || k;
      if(isU && (kk===k) && !(kk in r)) continue;   // per-token-only column
      const lo=F['min_'+k], hi=F['max_'+k];
      if(lo!==undefined && lo!=='' ){ if(nz(r[kk]) || Number(r[kk])<Number(lo)) return false; }
      if(hi!==undefined && hi!=='' ){ if(nz(r[kk]) || Number(r[kk])>Number(hi)) return false; }
    }
    for(const [k,f] of [[fbK,'fb'],[lsK,'ls']]){
      const lo=F[f+'_from'], hi=F[f+'_to'];
      if(lo){ if(nz(r[k]) || String(r[k]).slice(0,10) < lo) return false; }
      if(hi){ if(nz(r[k]) || String(r[k]).slice(0,10) > hi) return false; }
    }
    return true;
  });
}
function curKey(){ return tab==='__all'?aSortKey:sortKey; }
function curDir(){ return tab==='__all'?aSortDir:sortDir; }
function cmp(a,b,k){
  const A=a[k],B=b[k], an=nz(A), bn=nz(B);
  if(an&&bn) return 0;
  if(an) return 1*curDir();     // nulls last in both directions
  if(bn) return -1*curDir();
  if(typeof A==='number'&&typeof B==='number') return A-B;
  if(typeof A==='boolean') return (A?1:0)-(B?1:0);
  return String(A).localeCompare(String(B));
}
function ordered(){
  const rows=filtered();
  if(tab==='__all'){
    // Default: multi-token wallets first, then by size. Explicitly sorting on
    // a chosen column overrides the tie-break, not the other way round.
    rows.sort((a,b)=>{
      const primary=cmp(a,b,aSortKey)*aSortDir;
      if(primary!==0) return primary;
      if(aSortKey!=='tokens_touched'){ const t=(b.tokens_touched-a.tokens_touched); if(t) return t; }
      return b.total_pnl_sol-a.total_pnl_sol;
    });
    return rows.map(r=>({r}));
  }
  if(mode==='flat'){ rows.sort((a,b)=>cmp(a,b,sortKey)*sortDir); return rows.map(r=>({r})); }
  const g=new Map(), loose=[];
  for(const r of rows){ if(!r.tag){loose.push(r);continue;} if(!g.has(r.tag)) g.set(r.tag,[]); g.get(r.tag).push(r); }
  const pk=(x)=>tab==='__all'?x.total_pnl_sol:x.realized_pnl_sol;
  const gs=[...g.entries()].map(([tag,rs])=>({tag,rs,sum:rs.reduce((s,x)=>s+pk(x),0)}))
    .sort((a,b)=>b.sum-a.sum);
  const out=[];
  for(const x of gs){ out.push({head:x}); x.rs.sort((a,b)=>pk(b)-pk(a));
    for(const r of x.rs) out.push({r}); }
  if(loose.length){ out.push({head:{tag:'untagged',rs:loose,sum:loose.reduce((s,x)=>s+pk(x),0)}});
    loose.sort((a,b)=>pk(b)-pk(a)); for(const r of loose) out.push({r}); }
  return out;
}
function cell(r,c){
  const v=r[c.k];
  if(c.kind==='sel') return '<input type="checkbox" class="rowsel" data-w="'+r.wallet+'"'+(sel.has(r.wallet)?' checked':'')+'>';
  if(c.kind==='usd'){
    if(v===null||v===undefined||v==='') return '<span class="muted">—</span>';
    var nu=Number(v);
    return '<span class="'+(nu>0?'pos':nu<0?'neg':'')+'">'+(nu>0?'+':'')+
      nu.toLocaleString(undefined,{maximumFractionDigits:0})+'</span>';
  }
  if(c.kind==='quote') return '<span class="muted">'+esc(String(v||''))+'</span>';
  if(c.kind==='cluster'){
    if(!r.cluster_id) return '<span class="muted">—</span>';
    // A medium-confidence same_transaction link must not read the same as a
    // high-confidence shared_signer one, so confidence drives the colour and
    // the signal is spelled out rather than abbreviated.
    var cf=r.cluster_confidence||'medium';
    var extra = (r.cluster_count>1) ? ' <span class="sig">+'+(r.cluster_count-1)+' more</span>' : '';
    return '<span class="cl cl-'+esc(cf)+'" title="'+esc(r.cluster_signal||'')+' · '+esc(cf)+' confidence'
      + (r.cluster_count>1?' · in '+r.cluster_count+' clusters':'')+'">'
      + esc(r.cluster_id)+'</span> <span class="sig">'+esc((r.cluster_signal||'').replace(/_/g,' '))+'</span>'+extra;
  }
  if(c.kind==='wallet'){
    // Explorer differs per chain; a Solscan link for an EVM address is a dead
    // end, so the chain on the row decides. 'mixed' gets no link rather than a
    // wrong one.
    var href = r.chain==='solana' ? 'https://solscan.io/account/'+r.wallet
             : (r.chain==='robinhood' ? 'https://robinhoodchain.blockscout.com/address/'+r.wallet : null);
    var lbl='<span class="wallet" data-w="'+r.wallet+'" title="'+r.wallet+'">'+r.wallet.slice(0,4)+'…'+r.wallet.slice(-4)+'</span>';
    if(r.pre_window_entry) lbl += ' <span class="zb" title="sold tokens it never bought in our window — PnL rests on a cost basis we cannot see">no basis</span>';
    return href? lbl+' <a class="exp" href="'+href+'" target="_blank" rel="noopener" title="explorer">&#8599;</a>' : lbl;
  }
  if(c.kind==='tag') return v
    ? '<span class="tag'+(r.tag_source==='manual'?' man':'')+'" data-edit="'+r.wallet+'">'+esc(v)+'</span>'
    : '<span class="tagempty" data-edit="'+r.wallet+'">+ tag</span>';
  if(c.kind==='tokens') return String(v||'').split(', ').filter(Boolean).map(t=>
    '<span class="tag" data-jump="'+esc(t)+'" data-jw="'+r.wallet+'" title="open the '+esc(t)+' tab filtered to this wallet">'+esc(t)+'</span>').join(' ');
  if(c.kind==='time') return nz(v)?'<span class="muted">—</span>':'<span class="muted">'+String(v).replace('T',' ').replace('Z','')+'</span>';
  if(c.kind==='bool') return v?'yes':'<span class="muted">no</span>';
  if(c.kind==='text') return nz(v)?'<span class="muted">—</span>':esc(String(v));
  if(c.kind==='int') return nz(v)?'<span class="muted">—</span>':v;
  if(c.kind==='pnl'){ if(nz(v)) return '<span class="muted">—</span>';
    const n=Number(v); return '<span class="'+(n>0?'pos':n<0?'neg':'')+'">'+(n>0?'+':'')+fmt(n,c.d)+'</span>'; }
  return fmt(v,c.d??2);
}
function summary(rows){
  const k=tab==='__all'?'total_pnl_sol':'realized_pnl_sol';
  const p=rows.map(r=>r[k]).sort((a,b)=>a-b);
  const med=p.length?(p.length%2?p[(p.length-1)/2]:(p[p.length/2-1]+p[p.length/2])/2):0;
  return {n:rows.length, win:p.filter(x=>x>0).length, lose:p.filter(x=>x<0).length,
          sum:p.reduce((a,b)=>a+b,0), med, tags:new Set(rows.filter(r=>r.tag).map(r=>r.tag)).size};
}
function filterBar(){
  const tags=[...new Set(tokenRows().filter(r=>r.tag).map(r=>r.tag))].sort();
  const numF=NUMCOLS.map(([k,t])=>
    '<div class="f"><label>'+colTitle({k:k,t:t})+'</label><div class="pair">'+
    '<input class="num" type="number" step="any" placeholder="min" data-f="min_'+k+'" value="'+(F['min_'+k]??'')+'">'+
    '<span>–</span><input class="num" type="number" step="any" placeholder="max" data-f="max_'+k+'" value="'+(F['max_'+k]??'')+'"></div></div>').join('');
  return '<div class="filters"><div class="frow">'+
    '<div class="f"><label>Wallet search</label><input class="txt" type="text" placeholder="partial address" data-f="q" value="'+(F.q??'')+'"></div>'+
    '<div class="f"><label>Tag</label><select data-f="tagMode">'+
      ['all','tagged','untagged'].map(v=>'<option value="'+v+'"'+(F.tagMode===v?' selected':'')+'>'+
        {all:'All',tagged:'Tagged only',untagged:'Untagged only'}[v]+'</option>').join('')+'</select></div>'+
    '<div class="f"><label>Specific tag</label><select data-f="tag"><option value="">— any —</option>'+
      tags.map(t=>'<option value="'+esc(t)+'"'+(F.tag===t?' selected':'')+'>'+esc(t)+'</option>').join('')+'</select></div>'+
    '<div class="f"><label>Tokens touched</label><select data-f="tt">'+
      ['all','1','2+'].map(v=>'<option value="'+v+'"'+(F.tt===v?' selected':'')+'>'+
        {all:'All','1':'Exactly 1','2+':'2 or more'}[v]+'</option>').join('')+
      [...new Set(ROWS.map(r=>r.token))].map((_,i)=>i+1).filter(n=>n>2)
        .map(n=>'<option value="='+n+'"'+(F.tt==='='+n?' selected':'')+'>Exactly '+n+'</option>').join('')+
      '</select></div>'+
    '<div class="f"><label>Sold out</label><select data-f="sold">'+
      ['all','yes','no'].map(v=>'<option value="'+v+'"'+(F.sold===v?' selected':'')+'>'+
        {all:'All',yes:'Yes',no:'No'}[v]+'</option>').join('')+'</select></div>'+
    '<div class="f"><label>First buy</label><div class="pair">'+
      '<input class="date" type="date" data-f="fb_from" value="'+(F.fb_from??'')+'"><span>–</span>'+
      '<input class="date" type="date" data-f="fb_to" value="'+(F.fb_to??'')+'"></div></div>'+
    '<div class="f"><label>Last sell</label><div class="pair">'+
      '<input class="date" type="date" data-f="ls_from" value="'+(F.ls_from??'')+'"><span>–</span>'+
      '<input class="date" type="date" data-f="ls_to" value="'+(F.ls_to??'')+'"></div></div>'+
    numF +
    '<div class="f"><label>&nbsp;</label><button class="btn" id="clearf">Clear filters</button></div>'+
    '</div></div>';
}

function renderTable(){
  const isU=tab==='__all';
  const C=isU?ACOLS:COLS;
  const all=ordered();
  const rowsOnly=all.filter(x=>x.r).map(x=>x.r);
  const s=summary(filtered());
  const total=isU?unionRows().length:tokenRows().length;
  document.getElementById('sub').textContent='· '+(isU?'all tokens':tab)+' · '+total+' wallets';
  const pages=Math.max(1,Math.ceil(all.length/PER));
  if(page>pages) page=pages;
  const slice=all.slice((page-1)*PER,page*PER);
  const head='<tr>'+C.map(c=>c.kind==='sel'
      ? '<th class="l"><input type="checkbox" id="selall"></th>'
      : (c.nosort
          // No data-k means the delegated click handler never matches it.
          // Mixed SOL/ETH cannot be ordered meaningfully on the union tab.
          ? '<th class="'+(c.l?'l':'')+' nosort" title="mixed quote assets - not sortable">'+colTitle(c)+'</th>'
          : '<th class="'+(c.l?'l':'')+'" data-k="'+c.k+'">'+colTitle(c)+
            ((isU||mode==='flat')&&curKey()===c.k?' <span class="arrow">'+(curDir()<0?'▼':'▲')+'</span>':'')+'</th>')).join('')+'</tr>';
  const body=slice.map(x=>{
    if(x.head) return '<tr class="grouphead"><td colspan="'+C.length+'">'+esc(x.head.tag)+
      ' · '+x.head.rs.length+' wallets · combined '+(x.head.sum>=0?'+':'')+x.head.sum.toFixed(2)+' '+quoteOf()+'</td></tr>';
    return '<tr class="'+(sel.has(x.r.wallet)?'sel':'')+'">'+
      C.map(c=>'<td class="'+(c.l?'l':'')+'">'+cell(x.r,c)+'</td>').join('')+'</tr>';
  }).join('');
  const btn=(n,l,dis,on)=>'<button '+(dis?'disabled':'')+' class="'+(on?'on':'')+'" data-p="'+n+'">'+(l??n)+'</button>';
  let pg=btn(page-1,'‹',page===1,false); const win=[];
  for(let i=1;i<=pages;i++) if(i===1||i===pages||Math.abs(i-page)<=2) win.push(i);
  let last=0; for(const i of win){ if(i-last>1) pg+='<span class="count">…</span>'; pg+=btn(i,null,false,i===page); last=i; }
  pg+=btn(page+1,'›',page===pages,false);
  pg+='<span class="count">'+(all.length?((page-1)*PER+1):0)+'–'+Math.min(page*PER,all.length)+' of '+all.length+'</span>';

  document.getElementById('view').innerHTML =
    '<div class="cards">'+
      '<div class="card"><h3>Showing</h3><p class="big">'+s.n+' <span class="muted" style="font-size:13px">of '+total+'</span></p></div>'+
      '<div class="card"><h3>Winners</h3><p class="big pos">'+s.win+'</p></div>'+
      '<div class="card"><h3>Losers</h3><p class="big neg">'+s.lose+'</p></div>'+
      '<div class="card"><h3>Sum PnL</h3><p class="big '+(s.sum>=0?'pos':'neg')+'">'+s.sum.toFixed(2)+'</p></div>'+
      '<div class="card"><h3>Median PnL</h3><p class="big '+(s.med>=0?'pos':'neg')+'">'+s.med.toFixed(3)+'</p></div>'+
      '<div class="card"><h3>Tags</h3><p class="big">'+s.tags+'</p></div>'+
    '</div>'+
    filterBar()+
    '<div class="toolbar">'+
      (isU?'':'<button class="btn '+(mode==='flat'?'pri':'')+'" id="m-flat">Sort by column</button>'+
      '<button class="btn '+(mode==='group'?'pri':'')+'" id="m-group">Group by tag</button>')+
      '<button class="btn" id="export">Export CSV</button>'+
      '<span style="flex:1"></span>'+
      '<span class="count" id="selcount">'+sel.size+' selected</span>'+
      '<input class="tagin" id="bulktag" placeholder="tag name" style="width:130px">'+
      '<button class="btn" id="bulkset" '+(sel.size?'':'disabled')+'>Tag selected</button>'+
      '<button class="btn" id="bulkclear" '+(sel.size?'':'disabled')+'>Clear tag</button>'+
    '</div>'+
    tokenNote()+
    basisNote()+
    (tab==='NTF'
      // Stated on the tab rather than in a commit message: the number is a
      // property of the data, and anyone reading these rows needs it.
      ? '<div class="note">PnL covers our pool only (poolId 0xf7579d2f…), which is '
        + '60.7% of NTF swap activity. 64 other NTF pools exist and are not indexed, '
        + 'so the full NTF position of a wallet may be larger than shown.</div>'
      : '')+
    '<div class="tablebox"><table><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div>'+
    '<div class="pager">'+pg+'</div>';
  window.__rows=rowsOnly;
}

/**
 * The pricing basis, stated on the page.
 *
 * Per-trade USD PnL does NOT equal native PnL times any single rate, so anyone
 * reconciling the two columns by hand will fail unless the method is visible.
 * SOL moved 39% across CATE's month and 38.8% across CYBERLEEK's fortnight; ETH
 * moved 0.8% across NTF's six hours, which is why only NTF gets a constant.
 */
/**
 * The token record: the window the cohort was cut from, and what bounded it.
 *
 * THE THRESHOLD LINE IS THE POINT OF THIS PANEL. A "Buy mcap $" column next to
 * a supplied threshold reads as though the threshold selected something. For
 * PONS it did not — every wallet was admitted — and that has to be visible
 * beside the column rather than buried in a commit message.
 */
function tokenNote(){
  if(tab==='__all'||tab==='__groups') return '';
  var m=null;
  TOKENMETA.forEach(function(x){ if(x.token===tab) m=x; });
  if(!m) return '';
  var rows=tokenRows();
  var bits=[];
  if(m.window_hours!=null) bits.push('<b>Window</b> '+esc(m.window_hours)+' h');
  if(m.window_start_utc) bits.push(esc(m.window_start_utc)+' &rarr; '+esc(m.window_end_utc||'?'));
  if(m.first_swap_block!=null&&m.boundary_block!=null)
    bits.push('<b>Blocks</b> '+Number(m.first_swap_block).toLocaleString('en-US')+
      '&ndash;'+Number(m.boundary_block).toLocaleString('en-US'));
  if(m.swaps_in_window!=null) bits.push('<b>Swaps</b> '+Number(m.swaps_in_window).toLocaleString('en-US'));
  if(m.unique_txs!=null) bits.push('<b>Txs</b> '+Number(m.unique_txs).toLocaleString('en-US'));
  if(m.fully_covered!=null)
    bits.push('<b>Fully covered</b> '+(m.fully_covered?'yes':'<span class="bad">no</span>'));
  if(m.dex_version) bits.push('<b>Venue</b> '+esc((m.dex||'')+' '+m.dex_version));
  if(m.fee_rate_buy!=null)
    bits.push('<b>Fee</b> buy '+(m.fee_rate_buy*100).toFixed(4)+'% / sell '+
      (m.fee_rate_sell*100).toFixed(4)+'%');

  // aggregate balance comparison, the decode check
  var withBal=rows.filter(function(r){return r.onchain_balance!=null;});
  var bal='';
  if(withBal.length){
    var mt=withBal.filter(function(r){return r.balance_match===true;}).length;
    var imp=0,onc=0,off=0;
    withBal.forEach(function(r){
      imp+=Number(r.implied_balance||0); onc+=Number(r.onchain_balance||0);
      if(r.has_off_pool_activity) off++;
    });
    bal='<br><b>Balances.</b> Two columns, never one: <i>implied</i> is our decode '+
      'of this pool inside the window, <i>on-chain</i> is a balanceOf read at block '+
      (m.balance_block!=null?Number(m.balance_block).toLocaleString('en-US'):'?')+'. '+
      'Implied total '+imp.toLocaleString('en-US',{maximumFractionDigits:0})+
      ', on-chain total '+onc.toLocaleString('en-US',{maximumFractionDigits:0})+
      ', matching '+mt+' of '+withBal.length+' wallets. A per-wallet delta is '+
      'expected where a wallet traded outside this pool and is not an error.'+
      (off?' <b>'+off+'</b> wallets have off-pool activity, so their realized PnL '+
        'covers this pool only.':'');
  }
  var thr='';
  if(m.mcap_threshold_usd!=null){
    thr='<br><b>Threshold.</b> Supplied &minus;&minus;mcap-threshold $'+
      Number(m.mcap_threshold_usd).toLocaleString('en-US')+'. '+
      (m.threshold_binding===false
        ? '<span class="bad">It selected nothing</span> &mdash; '+esc(m.threshold_note||'')+
          '. The cohort here is defined by the window, not by this ceiling, so the '+
          '&ldquo;Buy mcap $&rdquo; column must not be read as a filter that bit.'
        : 'This threshold is binding for this token.');
  }
  var dc=m.decode_check?'<br><b>Decode check.</b> '+esc(m.decode_check):'';
  return '<div class="note">'+bits.join(' &middot; ')+thr+bal+dc+'</div>';
}

function basisNote(){
  var rows = tab==='__all' ? ROWS : ROWS.filter(function(r){return r.token===tab;});
  var bas = [];
  rows.forEach(function(r){ if(r.rate_basis && bas.indexOf(r.rate_basis)<0) bas.push(r.rate_basis); });
  if(!bas.length) return '';
  var cate = rows.some(function(r){return r.token==='CATE';});
  return '<div class="note">'+
    '<b>USD basis.</b> '+bas.map(function(b){return esc(b);}).join(' · ')+
    '<br>Per-trade USD is not native PnL multiplied by one rate — each trade is '+
    'priced at its own hour, so the two columns will not reconcile by hand.'+
    (cate ? '<br><b>CATE native PnL was recomputed from net flow to FIFO on 2026-08-31.</b> '+
            '38 wallets changed, all upward, totalling +537.28 SOL. Figures differing '+
            'from an earlier screenshot have that reason.' : '')+
    '</div>';
}

/**
 * Cross-token tab: wallets appearing in more than one cohort on chain robinhood.
 *
 * DERIVED, NOT CONFIGURED. The per-token columns come from whatever tokens are
 * present in wallet_pnl for this chain, so loading a fifth token makes its
 * column and its wallets appear here with no code change.
 */
var xSortKey='total_realized_usd', xSortDir=-1;
var _clMemo=null;
function clustersFor(w){
  if(!_clMemo){ _clMemo={};
    CLUSTERS.forEach(function(c){
      if(c.chain!=='robinhood') return;
      (_clMemo[c.wallet]=_clMemo[c.wallet]||[]).push(c.cluster_id); }); }
  var a=_clMemo[w];
  if(!a) return '';
  var u=[]; a.forEach(function(x){ if(u.indexOf(x)<0) u.push(x); });
  return u.sort().join(' ');
}
function crossTokens(){
  var ts=[];
  ROWS.forEach(function(r){ if(r.chain==='robinhood'&&ts.indexOf(r.token)<0) ts.push(r.token); });
  return ts.sort();
}
function crossRows(){
  var by={};
  ROWS.forEach(function(r){ if(r.chain!=='robinhood') return;
    (by[r.wallet]=by[r.wallet]||[]).push(r); });
  var toks=crossTokens(), out=[];
  Object.keys(by).forEach(function(w){
    var rs=by[w], seen=[];
    rs.forEach(function(r){ if(seen.indexOf(r.token)<0) seen.push(r.token); });
    if(seen.length<2) return;
    var o={wallet:w, chain:'robinhood', n_tokens:seen.length,
           tokens:seen.slice().sort().join(', '), total_realized_usd:0,
           clusters:clustersFor(w)};
    toks.forEach(function(t){ o['pnl_'+t]=null; o['hold_'+t]=null; });
    rs.forEach(function(r){
      o['pnl_'+r.token]=Number(r.realized_pnl_usd||0);
      o['hold_'+r.token]=(r.still_holding===true);
      o.total_realized_usd+=Number(r.realized_pnl_usd||0); });
    out.push(o); });
  return out;
}
function XCOLS(){
  var toks=crossTokens();
  var c=[{k:'wallet',t:'Wallet',l:true,kind:'wallet'},
         {k:'n_tokens',t:'Tokens',kind:'int'},
         {k:'tokens',t:'Token list',l:true,kind:'text'}];
  toks.forEach(function(t){ c.push({k:'pnl_'+t,t:t+' PnL USD',kind:'usd',d:0}); });
  c.push({k:'total_realized_usd',t:'Total PnL USD',kind:'usd',d:0});
  toks.forEach(function(t){ c.push({k:'hold_'+t,t:t+' holding',kind:'bool'}); });
  c.push({k:'clusters',t:'Clusters',l:true,kind:'text'});
  return c;
}
function crossFiltered(){
  var rs=crossRows();
  var lo=F.x_mintok!==undefined&&F.x_mintok!==''?Number(F.x_mintok):null;
  var hi=F.x_maxtok!==undefined&&F.x_maxtok!==''?Number(F.x_maxtok):null;
  var tlo=F.x_mintotal!==undefined&&F.x_mintotal!==''?Number(F.x_mintotal):null;
  var thi=F.x_maxtotal!==undefined&&F.x_maxtotal!==''?Number(F.x_maxtotal):null;
  rs=rs.filter(function(r){
    if(lo!==null&&r.n_tokens<lo) return false;
    if(hi!==null&&r.n_tokens>hi) return false;
    if(tlo!==null&&r.total_realized_usd<tlo) return false;
    if(thi!==null&&r.total_realized_usd>thi) return false;
    return true; });
  var k=xSortKey, d=xSortDir;
  rs.sort(function(a,b){
    var x=a[k], y=b[k];
    if(x===null||x===undefined) return 1;
    if(y===null||y===undefined) return -1;
    if(typeof x==='number'&&typeof y==='number') return (x-y)*d;
    if(typeof x==='boolean') return ((x?1:0)-(y?1:0))*d;
    return String(x).localeCompare(String(y))*d; });
  return rs;
}
function renderCross(){
  var C=XCOLS(), rs=crossFiltered();
  document.getElementById('sub').textContent='· cross-token · '+rs.length+' wallets';
  var head='<tr>'+C.map(function(c){
    return '<th class="'+(c.l?'l':'')+'" data-k="'+c.k+'">'+c.t+
      (xSortKey===c.k?' <span class="arrow">'+(xSortDir<0?'▼':'▲')+'</span>':'')+'</th>'; }).join('')+'</tr>';
  var body=rs.map(function(r){
    return '<tr>'+C.map(function(c){ return '<td class="'+(c.l?'l':'')+'">'+cell(r,c)+'</td>'; }).join('')+'</tr>'; }).join('');
  document.getElementById('view').innerHTML=
    '<div class="filters"><div class="frow">'+
      '<div class="f"><label>Token count</label><div class="pair">'+
        '<input class="num" type="number" step="1" placeholder="min" data-f="x_mintok" value="'+(F.x_mintok??'')+'">'+
        '<span>–</span><input class="num" type="number" step="1" placeholder="max" data-f="x_maxtok" value="'+(F.x_maxtok??'')+'"></div></div>'+
      '<div class="f"><label>Total PnL USD</label><div class="pair">'+
        '<input class="num" type="number" step="any" placeholder="min" data-f="x_mintotal" value="'+(F.x_mintotal??'')+'">'+
        '<span>–</span><input class="num" type="number" step="any" placeholder="max" data-f="x_maxtotal" value="'+(F.x_maxtotal??'')+'"></div></div>'+
      '<button class="btn" id="clearf">Clear filters</button>'+
    '</div></div>'+
    '<div class="toolbar"><button class="btn" id="export">Export CSV</button>'+
      '<span style="flex:1"></span><span class="count">'+rs.length+' wallets</span></div>'+
    '<div class="tablebox"><table><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div>';
}

/* ------------------------------------------------- behaviour-grouped tokens */
/**
 * Any token with rows in wallet_groups gets three behaviour sub-tabs rather
 * than one flat table.
 *
 * Group membership is READ FROM wallet_groups, not recomputed here. It depends
 * on transfer logs that never reach Postgres, and both SQL-only proxies were
 * measured and rejected (group 1 -> 119 of 266, group 3 -> 32 selected for 8).
 *
 * The current balance column reads the newest row of the append-only scan
 * series, NOT wallet_pnl.onchain_balance, which was a one-off read at the run's
 * head block and goes stale within hours. A scan row whose read failed carries a
 * null balance and an error status, and is shown as "unknown" -- never as zero.
 */
var oSub = 1;              // which behaviour sub-tab is open
var oFilters = false;      // filter block starts collapsed

var _gmemo = null;
function groupsOf(w){
  // keyed by token+wallet: the same wallet can sit in different groups per token
  if(!_gmemo){ _gmemo={}; GROUPS.forEach(function(g){
    var k=g.token+'|'+g.wallet; (_gmemo[k]=_gmemo[k]||[]).push(g.groupNo); }); }
  return _gmemo[tab+'|'+w]||[];
}
/** Tokens that have behaviour groups loaded, so the tab bar can pick a view. */
var _gtok = null;
function hasGroups(t){
  if(!_gtok){ _gtok={}; GROUPS.forEach(function(g){ _gtok[g.token]=true; }); }
  return !!_gtok[t];
}
/**
 * One tag per (token, wallet), so both sub-tabs of a wallet in groups 2 and 3
 * read the same entry and show the same value.
 */
var _tmemo = null;
function tagOf(w){
  if(!_tmemo){ _tmemo={}; TAGS.forEach(function(t){ _tmemo[t.token+'|'+t.wallet]=t.tag; }); }
  return _tmemo[tab+'|'+w]||'';
}
function setTagLocal(w,v){ if(!_tmemo) tagOf(w); var k=tab+'|'+w;
  if(v) _tmemo[k]=v; else delete _tmemo[k]; }
async function saveOdysseusTag(w, v, el){
  try{
    const r=await fetch('/api/token-tag',{method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({token:tab,chain:'robinhood',wallet:w,tag:v})});
    const j=await r.json();
    if(!r.ok||!j.ok) throw new Error(j.error||('HTTP '+r.status));
    setTagLocal(w, j.tag);
    el.classList.remove('bad'); el.classList.add('okflash');
    toast(j.tag? 'tag saved' : 'tag cleared');
    setTimeout(function(){ el.classList.remove('okflash'); }, 900);
  }catch(err){
    // A failed write is shown, never swallowed: the field stays marked and the
    // in-memory value is not updated, so the page never claims a save happened.
    el.classList.add('bad');
    toast('tag NOT saved: '+(err&&err.message?err.message:'unknown error'), true);
  }
}

var _smemo = null;
function scanOf(w){
  if(!_smemo){ _smemo={}; SCANS.forEach(function(x){ _smemo[x.token+'|'+x.wallet]=x; }); }
  return _smemo[tab+'|'+w]||null;
}
/** Newest scan read time across the series, for labelling the header cards. */
function scanReadAt(){
  var t=null;
  SCANS.forEach(function(x){ if(x.token===tab && x.readAt && (!t || x.readAt>t)) t=x.readAt; });
  return t;
}
var TOK18 = 1e18;
function scanBalance(w){
  var s=scanOf(w);
  if(!s) return {known:false, value:null, note:'no scan yet'};
  if(s.balanceRaw===null) return {known:false, value:null, note:s.status};
  return {known:true, value:Number(s.balanceRaw)/TOK18, note:s.status};
}
function odysseusRows(g){
  return ROWS.filter(function(r){ return r.token===tab && groupsOf(r.wallet).indexOf(g)>=0; });
}
function oStatus(r){
  var b=scanBalance(r.wallet);
  if(!b.known) return 'unknown';
  if(b.value>0) return 'still holds';
  return r.sold_out ? 'sold out in window' : 'exited after window';
}
function fmtTok(v){ return v===null||v===undefined?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:0}); }
function balCell(r){
  var b=scanBalance(r.wallet);
  if(!b.known) return '<span class="zb" title="'+esc(b.note)+'">unknown</span>';
  return fmtTok(b.value);
}
function balUsd(r){
  var b=scanBalance(r.wallet); var m=TOKENMETA.filter(function(x){return x.token===tab;})[0];
  if(!b.known || !m || m.price_usd==null) return '<span class="muted">—</span>';
  return '$'+(b.value*m.price_usd).toLocaleString('en-US',{maximumFractionDigits:2});
}
var TAGCOL = ['tag','Tag','tag'];
var OCOLS = {
  1:[TAGCOL,['wallet','Wallet','wallet'],['first_buy_time_utc','First buy','time'],
     ['first_buy_mcap_usd','Buy mcap $','num0'],['n_buys','Buys','int'],
     ['tokens_bought','Tokens bought','num0'],['sol_in','ETH spent','num6'],
     ['usd_spent','USD spent','usd'],['tokens_still_held','Held at window close','num0'],
     ['cur_bal','Current balance','bal'],['cur_usd','Current USD','balusd'],['status','Status','text']],
  2:[TAGCOL,['wallet','Wallet','wallet'],['first_buy_time_utc','First buy','time'],
     ['first_buy_mcap_usd','Buy mcap $','num0'],['n_buys','Buys','int'],
     ['tokens_bought','Tokens bought','num0'],['sol_in','ETH in','num6'],['usd_in','USD in','usd'],
     ['n_sells','Sells','int'],['tokens_sold','Tokens sold','num0'],['sol_out','ETH out','num6'],
     ['usd_out','USD out','usd'],['realized_pnl_sol','PnL ETH','num6'],
     ['realized_pnl_usd','PnL USD','usd'],['tokens_still_held','Left at window close','num0'],
     ['cur_bal','Current balance','bal'],['cur_usd','Current USD','balusd'],['status','Status','text']],
  3:[TAGCOL,['wallet','Wallet','wallet'],['first_buy_time_utc','First buy','time'],
     ['first_buy_mcap_usd','Buy mcap $','num0'],['n_buys','Buys','int'],
     ['tokens_bought','Tokens bought','num0'],['sol_in','ETH in','num6'],['usd_in','USD in','usd'],
     ['tokens_still_held','Left at window close','num0'],
     ['cur_bal','Current balance','bal'],['cur_usd','Current USD','balusd'],['status','Status','text']]
};
function oCell(r,c){
  var k=c[0], kind=c[2];
  if(kind==='tag') return '<input class="tagin otag" data-otag="'+r.wallet+
    '" value="'+esc(tagOf(r.wallet))+'" placeholder="tag" style="width:110px">';
  if(kind==='wallet') return cell(r,{k:'wallet',kind:'wallet'});
  if(kind==='bal') return balCell(r);
  if(kind==='balusd') return balUsd(r);
  if(kind==='text') return esc(oStatus(r));
  if(kind==='time') return '<span class="muted">'+String(r[k]||'').replace('T',' ').replace('Z','')+'</span>';
  if(kind==='int') return r[k]===null?'<span class="muted">—</span>':r[k];
  if(kind==='usd'){
    var v = k==='usd_spent'||k==='usd_in' ? (r.sol_in||0)*2474.77
          : k==='usd_out' ? (r.sol_out||0)*2474.77 : r[k];
    return cell({x:v},{k:'x',kind:'usd'});
  }
  if(kind==='num6') return fmt(r[k],6);
  return fmtTok(r[k]);
}
function renderOdysseus(){
  var meta=TOKENMETA.filter(function(x){return x.token===tab;})[0]||{};
  var g1=odysseusRows(1);
  var rs=odysseusRows(oSub);
  // Remaining balance: latest scan, group 1 only, in tokens. Unknown reads are
  // excluded from the sum and counted separately rather than treated as zero.
  var sum=0, unknown=0;
  g1.forEach(function(r){ var b=scanBalance(r.wallet); if(b.known) sum+=b.value; else unknown++; });
  var rt=scanReadAt();
  // \\. not \. : this string lives inside a server-side template literal, where
  // a single backslash is consumed at build time and the regex would degrade to
  // /..*/ -- matching from the first character and erasing the whole timestamp.
  var when=rt?rt.replace('T',' ').replace(/\\..*$/,'')+' UTC':'no scan yet';
  var px=meta.price_usd, cap=(px!=null&&meta.total_supply!=null)?px*Number(meta.total_supply):null;
  var pwhen=meta.price_block!=null?('block '+Number(meta.price_block).toLocaleString('en-US')):'unknown';
  document.getElementById('sub').textContent='· '+tab+' · '+rs.length+' wallets in group '+oSub;
  var card=function(l,v,s){ return '<div class="card"><div class="k">'+l+'</div><div class="v">'+v+
    '</div>'+(s?'<div class="k">'+s+'</div>':'')+'</div>'; };
  document.getElementById('view').innerHTML=
    '<div class="cards">'+
      card('Showing',rs.length.toLocaleString('en-US'),'group '+oSub+' of 3')+
      card('Remaining balance',fmtTok(sum),'group 1, read '+esc(when)+(unknown?' · '+unknown+' unknown':''))+
      card('Current price',px!=null?('$'+Number(px).toPrecision(4)):'—','read at '+esc(pwhen))+
      card('Current market cap',cap!=null?('$'+cap.toLocaleString('en-US',{maximumFractionDigits:0})):'—','read at '+esc(pwhen))+
    '</div>'+
    '<div class="toolbar"><button class="btn" id="ofilt">'+(oFilters?'Hide':'Show')+' filters</button>'+
      '<span style="flex:1"></span><button class="btn" id="export">Export CSV</button></div>'+
    (oFilters?('<div class="filters"><div class="frow">'+
      '<div class="f"><label>Wallet search</label><input class="txt" type="text" placeholder="partial address" data-f="oq" value="'+(F.oq??'')+'"></div>'+
      '<div class="f"><label>Tokens bought</label><div class="pair">'+
        '<input class="num" type="number" step="any" placeholder="min" data-f="omin" value="'+(F.omin??'')+'">'+
        '<span>–</span><input class="num" type="number" step="any" placeholder="max" data-f="omax" value="'+(F.omax??'')+'"></div></div>'+
      '<button class="btn" id="clearf">Clear filters</button></div></div>'):'')+
    '<div class="tabs">'+[1,2,3].map(function(g){
        var lbl={1:'1 · bought and held',2:'2 · bought and sold',3:'3 · bought and transferred out'}[g];
        return '<button class="'+(oSub===g?'on':'')+'" data-osub="'+g+'">'+lbl+' ('+odysseusRows(g).length+')</button>';
      }).join('')+'</div>'+
    '<div class="tablebox"><table><thead><tr>'+
      OCOLS[oSub].map(function(c){ return '<th'+(c[2]==='wallet'||c[2]==='time'||c[2]==='text'||c[2]==='tag'?' class="l"':'')+'>'+c[1]+'</th>'; }).join('')+
      '</tr></thead><tbody>'+
      oFiltered().map(function(r){ return '<tr>'+OCOLS[oSub].map(function(c){
        return '<td'+(c[2]==='wallet'||c[2]==='time'||c[2]==='text'||c[2]==='tag'?' class="l"':'')+'>'+oCell(r,c)+'</td>'; }).join('')+'</tr>'; }).join('')+
      '</tbody></table></div>';
}
function oFiltered(){
  var rs=odysseusRows(oSub);
  var q=(F.oq||'').toLowerCase();
  var lo=F.omin!==undefined&&F.omin!==''?Number(F.omin):null;
  var hi=F.omax!==undefined&&F.omax!==''?Number(F.omax):null;
  return rs.filter(function(r){
    if(q && r.wallet.toLowerCase().indexOf(q)<0) return false;
    if(lo!==null && (r.tokens_bought||0)<lo) return false;
    if(hi!==null && (r.tokens_bought||0)>hi) return false;
    return true;
  }).sort(function(a,b){ return (b.tokens_bought||0)-(a.tokens_bought||0); });
}

function renderGroups(){
  // READS wallet_clusters, NOT wallet_pnl.tag. The whole reason the table is
  // separate is that 259 of 274 clustered wallets have no PnL row at all — the
  // cohort filter excluded them — so a groups view built from wallet_pnl can
  // only ever show the 15 that survived it.
  const pnlBy=new Map();
  for(const r of ROWS) pnlBy.set(r.chain+'|'+r.wallet, r);
  const g=new Map();
  for(const c of CLUSTERS){
    if(!g.has(c.cluster_id)) g.set(c.cluster_id,[]);
    g.get(c.cluster_id).push(c);
  }
  const gs=[...g.entries()].map(([cid,cs])=>{
    const withPnl=cs.filter(c=>pnlBy.has(c.chain+'|'+c.wallet));
    const pnl=withPnl.reduce((s2,c)=>s2+(pnlBy.get(c.chain+'|'+c.wallet).realized_pnl_sol||0),0);
    return {cid, n:cs.length, withPnl:withPnl.length, noPnl:cs.length-withPnl.length,
            conf:cs[0].confidence, signal:cs[0].signal, evidence:cs[0].evidence,
            chain:cs[0].chain, pnl, cs};
  }).sort((a,b)=>{
    // high confidence first, then size — the ordering states which links are
    // stronger rather than leaving it to a colour alone.
    const rank=x=>x.conf==='high'?0:(x.conf==='medium'?1:2);
    return (rank(a)-rank(b)) || (b.n-a.n) || a.cid.localeCompare(b.cid);
  });
  const body=gs.map(x=>{
    const isOpen=open.has(x.cid);
    let h='<tr><td class="l"><button class="btn" style="padding:1px 7px" data-exp="'+esc(x.cid)+'">'+(isOpen?'▾':'▸')+'</button></td>'+
      '<td class="l"><span class="cl cl-'+esc(x.conf)+'">'+esc(x.cid)+'</span></td>'+
      '<td class="l"><span class="sig">'+esc(x.signal.replace('_',' '))+'</span></td>'+
      '<td class="l"><span class="cl cl-'+esc(x.conf)+'">'+esc(x.conf)+'</span></td>'+
      '<td>'+x.n+'</td>'+
      '<td>'+x.withPnl+'</td>'+
      '<td>'+(x.noPnl?'<span class="nopnl">'+x.noPnl+' no PnL</span>':'0')+'</td>'+
      '<td><span class="'+(x.pnl>0?'pos':x.pnl<0?'neg':'')+'">'+(x.withPnl?((x.pnl>0?'+':'')+x.pnl.toFixed(3)):'—')+'</span></td>'+
      '<td class="l"><span class="muted" title="'+esc(x.evidence)+'">'+esc(x.evidence.slice(0,14))+'…</span></td></tr>';
    if(isOpen){
      h+='<tr><td></td><td colspan="8" class="l" style="padding:0 9px 8px">'+
        x.cs.map(c=>{
          const r=pnlBy.get(c.chain+'|'+c.wallet);
          const href = c.chain==='solana' ? 'https://solscan.io/account/'+c.wallet
                     : 'https://robinhoodchain.blockscout.com/address/'+c.wallet;
          return '<div style="display:flex;gap:12px;padding:2px 0;font-size:12px;align-items:center">'+
            '<span class="wallet" data-w="'+c.wallet+'" title="'+c.wallet+'">'+c.wallet.slice(0,6)+'…'+c.wallet.slice(-4)+'</span>'+
            '<a class="exp" href="'+href+'" target="_blank" rel="noopener">&#8599;</a>'+
            (r ? '<span class="muted">'+r.token+'</span><span class="'+(r.realized_pnl_sol>0?'pos':r.realized_pnl_sol<0?'neg':'')+'">'
                 +(r.realized_pnl_sol>0?'+':'')+Number(r.realized_pnl_sol).toFixed(4)+' '+esc(r.quote_asset)+'</span>'
               : '<span class="nopnl">no PnL row — outside the cohort</span>')+
            '</div>';
        }).join('')+'</td></tr>';
    }
    return h;
  }).join('');
  const tot=CLUSTERS.length, withp=CLUSTERS.filter(c=>pnlBy.has(c.chain+'|'+c.wallet)).length;
  document.getElementById('view').innerHTML=
    '<div class="note">'+tot+' clustered wallets in '+g.size+' clusters. '
      +withp+' have a PnL row; '+(tot-withp)+' do not — those sit outside the '
      +'sub-$100k cohort and exist only in wallet_clusters. Confidence: '
      +'<span class="cl cl-high">high</span> = one shared low-degree signer, '
      +'<span class="cl cl-medium">medium</span> = same-transaction or an overlapping signer.</div>'+
    '<div class="tablebox"><table><thead><tr>'+
      '<th class="l"></th><th class="l">Cluster</th><th class="l">Signal</th><th class="l">Confidence</th>'+
      '<th>Wallets</th><th>With PnL</th><th>No PnL</th><th>Combined PnL</th><th class="l">Evidence</th>'+
    '</tr></thead><tbody>'+(body||'<tr><td colspan="9" class="l muted">no clusters</td></tr>')+'</tbody></table></div>';
}

function render(){
  document.getElementById('tabs').innerHTML =
    '<button class="'+(tab==='__all'?'on':'')+'" data-tab="__all">All wallets</button>'+
    TOKENS.map(t=>'<button class="'+(tab===t?'on ':'')+(chainOf(t)==='robinhood'?'rh':'')+'" data-tab="'+t+'">'+esc(t)+'</button>').join('')+
    '<button class="'+(tab==='__cross'?'on ':'')+'rh" data-tab="__cross">Cross-token</button>'+
    '<button class="'+(tab==='__groups'?'on':'')+'" data-tab="__groups">Groups</button>';
  if(tab==='__cross') renderCross();
  else if(tab==='__groups') renderGroups();
  else if(hasGroups(tab)) renderOdysseus();
  else renderTable();
}

async function saveTag(wallets, tag){
  try{
    const r=await fetch('/api/wallet-tag',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({wallets,tag})});
    const j=await r.json();
    if(!r.ok||!j.ok) throw new Error(j.error||('HTTP '+r.status));
    for(const w of wallets){ const row=ROWS.find(x=>x.wallet===w);
      if(row){ row.tag=j.tag; row.tag_source=j.tag?'manual':null; } }
    toast('saved '+j.updated+' wallet'+(j.updated===1?'':'s'));
    render();
  }catch(e){ toast('save failed: '+e.message, true); }
}
async function renameTag(from,to){
  try{
    const r=await fetch('/api/tag-rename',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({from,to})});
    const j=await r.json();
    if(!r.ok||!j.ok) throw new Error(j.error||('HTTP '+r.status));
    for(const row of ROWS) if(row.tag===from){ row.tag=j.tag; row.tag_source=j.tag?'manual':null; }
    if(open.has(from)){ open.delete(from); if(j.tag) open.add(j.tag); }
    toast('renamed '+j.updated+' wallet'+(j.updated===1?'':'s'));
    render();
  }catch(e){ toast('rename failed: '+e.message, true); }
}

function inlineEdit(el, current, onSave){
  const inp=document.createElement('input');
  inp.className='tagin'; inp.value=current||'';
  el.replaceWith(inp); inp.focus(); inp.select();
  let done=false;
  const finish=(save)=>{ if(done) return; done=true;
    const v=inp.value.trim();
    if(save && v!==(current||'')) onSave(v===''?null:v); else render(); };
  inp.addEventListener('keydown',(e)=>{
    if(e.key==='Enter'){ e.preventDefault(); finish(true); }
    if(e.key==='Escape'){ e.preventDefault(); finish(false); } });
  inp.addEventListener('blur',()=>finish(false));
}

function exportCsv(){
  // Exactly what is on screen, in the order it is on screen, with FULL
  // addresses -- the table truncates for reading, a CSV that did so would be
  // useless for anything downstream.
  if(tab==='__cross'){
    const xr=crossFiltered(), xc=XCOLS().map(c=>c.k);
    const qq=(v)=>{ if(v===null||v===undefined) return '';
      const t=String(v); return /[",]/.test(t)?'"'+t.replace(/"/g,'""')+'"':t; };
    const out=[xc.join(',')].concat(xr.map(r=>xc.map(c=>qq(r[c])).join(','))).join(String.fromCharCode(10))+String.fromCharCode(10);
    const st=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const el=document.createElement('a');
    el.href=URL.createObjectURL(new Blob([out],{type:'text/csv'}));
    el.download='cross-token_wallets_'+st+'.csv';
    el.click(); URL.revokeObjectURL(el.href); return;
  }
  const rows=ordered().filter(x=>x.r).map(x=>x.r);
  const cols = tab==='__all'
    ? ['wallet','tag','tokens_touched','tokens','total_pnl_sol','total_sol_in','total_sol_out',
       'total_buys','total_sells','earliest_first_buy','latest_last_sell']
    : ['token','wallet','tag','tag_source','first_buy_time_utc','first_buy_mcap_usd',
       'last_sell_time_utc','n_buys','n_sells','sol_in','sol_out','realized_pnl_sol',
       'realized_pnl_usd','tokens_still_held','hold_min','sold_out'];
  const q=(v)=>{ if(v===null||v===undefined) return '';
    const s=String(v); return /[",\\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const csv=[cols.join(',')].concat(rows.map(r=>cols.map(c=>q(r[c])).join(','))).join('\\n')+'\\n';
  const stamp=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download=(tab==='__all'?'all-wallets':tab.toLowerCase())+'_wallet_pnl_'+stamp+'.csv';
  a.click(); URL.revokeObjectURL(a.href);
  toast('exported '+rows.length+' rows');
}

document.addEventListener('change',(e)=>{
  const t=e.target;
  if(t && t.dataset && t.dataset.otag){ saveOdysseusTag(t.dataset.otag, t.value.trim(), t); }
});
document.addEventListener('keydown',(e)=>{
  const t=e.target;
  if(t && t.dataset && t.dataset.otag && e.key==='Enter'){
    e.preventDefault(); saveOdysseusTag(t.dataset.otag, t.value.trim(), t); t.blur();
  }
});
document.addEventListener('input',(e)=>{
  const f=e.target.dataset && e.target.dataset.f;
  if(!f) return;
  F[f]=e.target.value;
  if(f==='tagMode'&&e.target.value==='all') delete F.tagMode;
  if(f==='sold'&&e.target.value==='all') delete F.sold;
  page=1;
  const active=document.activeElement, k=active&&active.dataset?active.dataset.f:null;
  render();
  if(k){ const el=document.querySelector('[data-f="'+k+'"]'); if(el){ el.focus();
    if(el.type==='text'||el.type==='number'){ try{el.setSelectionRange(el.value.length,el.value.length);}catch(_){} } } }
});
document.addEventListener('click',(e)=>{
  const tb=e.target.closest('[data-tab]');
  if(tb){ tab=tb.dataset.tab; page=1; sel.clear(); render(); return; }
  if(e.target.id==='clearf'){ for(const k of Object.keys(F)) delete F[k]; page=1; render(); return; }
  if(e.target.id==='ofilt'){ oFilters=!oFilters; render(); return; }
  const os=e.target.closest('[data-osub]');
  if(os){ oSub=Number(os.dataset.osub); render(); return; }
  if(e.target.id==='export'){ exportCsv(); return; }
  if(e.target.id==='m-flat'){ mode='flat'; page=1; render(); return; }
  if(e.target.id==='m-group'){ mode='group'; page=1; render(); return; }
  if(e.target.dataset && e.target.dataset.gsort){ gSortDir=-gSortDir; render(); return; }
  const exp=e.target.closest('[data-exp]');
  if(exp){ const t=exp.dataset.exp; open.has(t)?open.delete(t):open.add(t); render(); return; }
  const th=e.target.closest('th[data-k]');
  if(th){ const k=th.dataset.k;
    if(tab==='__cross'){ if(xSortKey===k) xSortDir=-xSortDir; else {xSortKey=k;xSortDir=-1;} }
    else if(tab==='__all'){ if(aSortKey===k) aSortDir=-aSortDir; else {aSortKey=k;aSortDir=-1;} }
    else { if(mode!=='flat') mode='flat';
      if(sortKey===k) sortDir=-sortDir; else {sortKey=k;sortDir=-1;} }
    page=1; render(); return; }
  const pb=e.target.closest('button[data-p]');
  if(pb){ page=Number(pb.dataset.p); render(); const b=document.querySelector('.tablebox'); if(b) b.scrollTop=0; return; }
  if(e.target.id==='selall'){
    const vis=ordered().filter(x=>x.r).map(x=>x.r.wallet);
    if(e.target.checked) vis.forEach(w=>sel.add(w)); else vis.forEach(w=>sel.delete(w));
    render(); return; }
  if(e.target.classList && e.target.classList.contains('rowsel')){
    const w=e.target.dataset.w; e.target.checked?sel.add(w):sel.delete(w);
    document.getElementById('selcount').textContent=sel.size+' selected';
    document.getElementById('bulkset').disabled=!sel.size;
    document.getElementById('bulkclear').disabled=!sel.size;
    e.target.closest('tr').classList.toggle('sel',e.target.checked); return; }
  if(e.target.id==='bulkset'){
    const v=document.getElementById('bulktag').value.trim();
    if(!v){ toast('enter a tag name first',true); return; }
    saveTag([...sel],v); return; }
  if(e.target.id==='bulkclear'){ saveTag([...sel],null); return; }
  const ed=e.target.closest('[data-edit]');
  if(ed){ const w=ed.dataset.edit; const row=ROWS.find(x=>x.wallet===w);
    inlineEdit(ed,row?row.tag:'',(v)=>saveTag([w],v)); return; }
  const rn=e.target.closest('[data-rename]');
  if(rn){ const t=rn.dataset.rename; inlineEdit(rn,t,(v)=>renameTag(t,v)); return; }
  const jp=e.target.closest('[data-jump]');
  if(jp){ tab=jp.dataset.jump; for(const k of Object.keys(F)) delete F[k];
    const jw=jp.dataset.jw||'';
    if(jw) F.q=jw;
    mode='flat'; page=1; sel.clear(); render();
    toast(jw?('showing '+jp.dataset.jump+' · '+jw.slice(0,4)+'…'+jw.slice(-4)):('showing '+jp.dataset.jump)); return; }
  const w=e.target.closest('.wallet');
  if(w){ navigator.clipboard.writeText(w.dataset.w).then(()=>toast('copied '+w.dataset.w.slice(0,4)+'…'+w.dataset.w.slice(-4))); }
});
render();
</script>
</body>
</html>`;
}
