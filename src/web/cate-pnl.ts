/**
 * CATE wallet PnL page.
 *
 * A STATIC TABLE, not a monitor panel. The 556 rows are a finished analysis of
 * one token's bonding-curve buyers, loaded once; nothing appends to it. It
 * therefore has no schedule, no adapter and no retention -- it is a small
 * reference table with a page in front of it.
 *
 * ALL 556 ROWS ARE SENT TO THE BROWSER and sorted, grouped and paginated there.
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
  wallet: string;
  tag: string | null;
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
}

export function renderCatePnlPage(rows: CatePnlRow[], generatedAt: Date): string {
  const pnl = rows.map((r) => r.realized_pnl_sol).sort((a, b) => a - b);
  const winners = pnl.filter((p) => p > 0).length;
  const losers = pnl.filter((p) => p < 0).length;
  const total = pnl.reduce((a, b) => a + b, 0);
  const median = pnl.length
    ? pnl.length % 2
      ? pnl[(pnl.length - 1) / 2]!
      : (pnl[pnl.length / 2 - 1]! + pnl[pnl.length / 2]!) / 2
    : 0;
  const tagged = new Set(rows.filter((r) => r.tag).map((r) => r.tag)).size;

  const fmt = (n: number, d = 2): string =>
    n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CATE wallet PnL</title>
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
  .wrap { max-width:1400px; margin:0 auto; padding:32px 20px 64px; }
  header.top { display:flex; align-items:baseline; justify-content:space-between; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
  h1 { font-size:20px; margin:0; letter-spacing:-0.01em; }
  h1 span { color:var(--muted); font-weight:400; }
  .generated { color:var(--muted); font-size:13px; }
  a.back { color:var(--link); text-decoration:none; font-size:13px; }
  a.back:hover { text-decoration:underline; }

  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
  .card h3 { margin:0 0 6px; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--muted); font-weight:600; }
  .card .big { margin:0; font-size:22px; font-variant-numeric:tabular-nums; letter-spacing:-0.02em; }

  .toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin-bottom:12px; }
  .toolbar button { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:7px; padding:7px 13px; font-size:13px; cursor:pointer; }
  .toolbar button.on { border-color:var(--link); color:var(--link); }
  .toolbar .hint { color:var(--muted); font-size:12px; }

  /* Fixed-height body so the page never grows with the data; the header row is
     sticky inside it so columns stay identified while the body scrolls. */
  .tablebox { background:var(--panel); border:1px solid var(--border); border-radius:10px; overflow:auto; max-height:60vh; }
  table { border-collapse:separate; border-spacing:0; width:100%; font-size:13px; }
  thead th { position:sticky; top:0; z-index:2; background:var(--panel); border-bottom:1px solid var(--border); text-align:right; padding:9px 10px; white-space:nowrap; cursor:pointer; user-select:none; font-size:11px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
  thead th:first-child, thead th.l { text-align:left; }
  thead th:hover { color:var(--text); }
  thead th .arrow { opacity:.45; font-size:10px; }
  tbody td { border-bottom:1px solid var(--border); padding:7px 10px; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  tbody td:first-child, tbody td.l { text-align:left; }
  tbody tr:hover { background:rgba(127,127,127,.07); }
  tbody tr.grouphead td { background:rgba(108,182,255,.10); font-weight:600; color:var(--link); }
  .pos { color:var(--ok); } .neg { color:var(--bad); }
  .wallet { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; cursor:pointer; border-bottom:1px dotted var(--muted); }
  .wallet:hover { color:var(--link); border-bottom-color:var(--link); }
  .tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:999px; background:rgba(108,182,255,.15); color:var(--link); }
  .muted { color:var(--muted); }

  .pager { display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-top:14px; }
  .pager button { background:var(--panel); color:var(--text); border:1px solid var(--border); border-radius:6px; min-width:34px; padding:6px 9px; font-size:13px; cursor:pointer; font-variant-numeric:tabular-nums; }
  .pager button.on { background:var(--link); border-color:var(--link); color:#0b0e13; font-weight:700; }
  .pager button:disabled { opacity:.4; cursor:default; }
  .pager .range { color:var(--muted); font-size:12px; margin-left:8px; }
  #toast { position:fixed; bottom:22px; left:50%; transform:translateX(-50%); background:var(--link); color:#0b0e13; padding:8px 16px; border-radius:8px; font-size:13px; font-weight:600; opacity:0; transition:opacity .18s; pointer-events:none; }
  #toast.show { opacity:1; }
</style>
</head>
<body>
<div class="wrap">
  <header class="top">
    <div>
      <h1>CATE wallet PnL <span>· ${rows.length} curve buyers</span></h1>
      <a class="back" href="/">&larr; back to dashboard</a>
    </div>
    <div class="generated">generated ${escapeHtml(generatedAt.toISOString())}</div>
  </header>

  <div class="cards">
    <div class="card"><h3>Wallets</h3><p class="big">${rows.length}</p></div>
    <div class="card"><h3>Winners</h3><p class="big pos">${winners}</p></div>
    <div class="card"><h3>Losers</h3><p class="big neg">${losers}</p></div>
    <div class="card"><h3>Sum PnL</h3><p class="big ${total >= 0 ? 'pos' : 'neg'}">${fmt(total)}</p></div>
    <div class="card"><h3>Median PnL</h3><p class="big ${median >= 0 ? 'pos' : 'neg'}">${fmt(median, 3)}</p></div>
    <div class="card"><h3>Tag groups</h3><p class="big">${tagged}</p></div>
  </div>

  <div class="toolbar">
    <button id="mode-flat" class="on">Sort by column</button>
    <button id="mode-group">Group by tag</button>
    <span class="hint">Click a header to sort · click a wallet to copy · sorting applies to all ${rows.length} rows</span>
  </div>

  <div class="tablebox">
    <table id="t">
      <thead><tr id="hrow"></tr></thead>
      <tbody id="tb"></tbody>
    </table>
  </div>
  <div class="pager" id="pager"></div>
</div>
<div id="toast">copied</div>

<script>
const ROWS = ${JSON.stringify(rows)};
const PER = 50;
const COLS = [
  {k:'wallet',            t:'Wallet',      l:true,  kind:'wallet'},
  {k:'tag',               t:'Tag',         l:true,  kind:'tag'},
  {k:'first_buy_time_utc',t:'First buy',   l:true,  kind:'time'},
  {k:'first_buy_mcap_usd',t:'Buy mcap $',  kind:'num', d:0},
  {k:'last_sell_time_utc',t:'Last sell',   l:true,  kind:'time'},
  {k:'n_buys',            t:'Buys',        kind:'int'},
  {k:'n_sells',           t:'Sells',       kind:'int'},
  {k:'sol_in',            t:'SOL in',      kind:'num', d:3},
  {k:'sol_out',           t:'SOL out',     kind:'num', d:3},
  {k:'realized_pnl_sol',  t:'PnL SOL',     kind:'pnl', d:3},
  {k:'realized_pnl_usd',  t:'PnL USD',     kind:'pnl', d:0},
  {k:'tokens_still_held', t:'Held',        kind:'num', d:0},
  {k:'hold_min',          t:'Hold min',    kind:'num', d:1},
  {k:'sold_out',          t:'Sold out',    kind:'bool'},
];
let sortKey='realized_pnl_sol', sortDir=-1, page=1, mode='flat';

const num=(v)=>v===null||v===undefined||v===''?null:Number(v);
const fmt=(v,d)=>v===null?'<span class="muted">—</span>':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});

function cmp(a,b,k){
  const A=a[k], B=b[k];
  // Nulls always sort last, in both directions: a missing value is not
  // "smaller", and letting it lead an ascending sort buries the real data.
  const an=A===null||A===undefined||A==='', bn=B===null||B===undefined||B==='';
  if(an&&bn) return 0;
  if(an) return 1*sortDir;   // cancels the outer flip, so nulls stay last
  if(bn) return -1*sortDir;
  if(typeof A==='number'&&typeof B==='number') return A-B;
  if(typeof A==='boolean') return (A?1:0)-(B?1:0);
  return String(A).localeCompare(String(B));
}

/** Sorted over the FULL set, never just the visible page. */
function sorted(){
  const rows=ROWS.slice();
  if(mode==='flat'){
    rows.sort((a,b)=>cmp(a,b,sortKey)*sortDir);
    return rows.map(r=>({r}));
  }
  // group mode: tagged groups by combined PnL desc, untagged below
  const groups=new Map();
  const loose=[];
  for(const r of ROWS){
    if(!r.tag){ loose.push(r); continue; }
    if(!groups.has(r.tag)) groups.set(r.tag,[]);
    groups.get(r.tag).push(r);
  }
  const ordered=[...groups.entries()]
    .map(([tag,rs])=>({tag,rs,sum:rs.reduce((s,x)=>s+x.realized_pnl_sol,0)}))
    .sort((a,b)=>b.sum-a.sum);
  const out=[];
  for(const g of ordered){
    out.push({head:g});
    g.rs.sort((a,b)=>b.realized_pnl_sol-a.realized_pnl_sol);
    for(const r of g.rs) out.push({r});
  }
  if(loose.length){
    out.push({head:{tag:'untagged',rs:loose,sum:loose.reduce((s,x)=>s+x.realized_pnl_sol,0)}});
    loose.sort((a,b)=>b.realized_pnl_sol-a.realized_pnl_sol);
    for(const r of loose) out.push({r});
  }
  return out;
}

function cell(r,c){
  const v=r[c.k];
  if(c.kind==='wallet') return '<span class="wallet" data-w="'+v+'" title="'+v+'">'+v.slice(0,4)+'…'+v.slice(-4)+'</span>';
  if(c.kind==='tag') return v?'<span class="tag">'+v+'</span>':'<span class="muted">—</span>';
  if(c.kind==='time') return v?'<span class="muted">'+String(v).replace('T',' ').replace('Z','')+'</span>':'<span class="muted">—</span>';
  if(c.kind==='bool') return v?'yes':'<span class="muted">no</span>';
  if(c.kind==='int') return v===null?'<span class="muted">—</span>':v;
  if(c.kind==='pnl'){ const n=num(v); if(n===null) return '<span class="muted">—</span>';
    return '<span class="'+(n>0?'pos':n<0?'neg':'')+'">'+(n>0?'+':'')+fmt(n,c.d)+'</span>'; }
  return fmt(num(v),c.d??2);
}

function render(){
  document.getElementById('hrow').innerHTML = COLS.map(c=>
    '<th class="'+(c.l?'l':'')+'" data-k="'+c.k+'">'+c.t+
    (mode==='flat'&&sortKey===c.k?' <span class="arrow">'+(sortDir<0?'▼':'▲')+'</span>':'')+'</th>').join('');
  const all=sorted();
  const pages=Math.max(1,Math.ceil(all.length/PER));
  if(page>pages) page=pages;
  const slice=all.slice((page-1)*PER, page*PER);
  document.getElementById('tb').innerHTML = slice.map(x=>{
    if(x.head) return '<tr class="grouphead"><td colspan="'+COLS.length+'">'+x.head.tag+
      ' · '+x.head.rs.length+' wallets · combined '+(x.head.sum>=0?'+':'')+x.head.sum.toFixed(2)+' SOL</td></tr>';
    return '<tr>'+COLS.map(c=>'<td class="'+(c.l?'l':'')+'">'+cell(x.r,c)+'</td>').join('')+'</tr>';
  }).join('');
  // numbered page buttons, windowed so the row never overflows
  const btn=(n,label,dis,on)=>'<button '+(dis?'disabled':'')+' class="'+(on?'on':'')+'" data-p="'+n+'">'+(label??n)+'</button>';
  let h=btn(page-1,'‹',page===1,false);
  const win=[];
  for(let i=1;i<=pages;i++){ if(i===1||i===pages||Math.abs(i-page)<=2) win.push(i); }
  let last=0;
  for(const i of win){ if(i-last>1) h+='<span class="range">…</span>'; h+=btn(i,null,false,i===page); last=i; }
  h+=btn(page+1,'›',page===pages,false);
  h+='<span class="range">'+((page-1)*PER+1)+'–'+Math.min(page*PER,all.length)+' of '+all.length+'</span>';
  document.getElementById('pager').innerHTML=h;
}

document.addEventListener('click',(e)=>{
  const th=e.target.closest('th[data-k]');
  if(th){
    if(mode!=='flat'){ mode='flat'; document.getElementById('mode-flat').classList.add('on');
      document.getElementById('mode-group').classList.remove('on'); }
    const k=th.dataset.k;
    if(sortKey===k) sortDir=-sortDir; else { sortKey=k; sortDir=-1; }
    page=1; render(); return;
  }
  const pb=e.target.closest('button[data-p]');
  if(pb){ page=Number(pb.dataset.p); render(); document.querySelector('.tablebox').scrollTop=0; return; }
  const w=e.target.closest('.wallet');
  if(w){
    navigator.clipboard.writeText(w.dataset.w).then(()=>{
      const t=document.getElementById('toast');
      t.textContent='copied '+w.dataset.w.slice(0,4)+'…'+w.dataset.w.slice(-4);
      t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),1100);
    });
  }
});
document.getElementById('mode-flat').onclick=()=>{mode='flat';page=1;
  document.getElementById('mode-flat').classList.add('on');
  document.getElementById('mode-group').classList.remove('on');render();};
document.getElementById('mode-group').onclick=()=>{mode='group';page=1;
  document.getElementById('mode-group').classList.add('on');
  document.getElementById('mode-flat').classList.remove('on');render();};
render();
</script>
</body>
</html>`;
}
