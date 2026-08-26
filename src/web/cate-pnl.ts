/**
 * CATE wallet PnL page.
 *
 * A STATIC TABLE, not a monitor panel. The 556 rows are a finished analysis of
 * one token's bonding-curve buyers, loaded once; nothing appends to it. It
 * therefore has no schedule, no adapter and no retention -- it is a small
 * reference table with a page in front of it.
 *
 * TABS ARE DATA-DRIVEN. One tab per distinct `token` value, built from the
 * rows themselves, plus a Groups tab. Adding a second token means inserting
 * rows with a new token value -- nothing here is edited.
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
}

export function renderCatePnlPage(rows: CatePnlRow[], generatedAt: Date): string {
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
  thead th.l { text-align:left; } thead th:hover { color:var(--text); }
  thead th .arrow { opacity:.5; font-size:9px; }
  tbody td { border-bottom:1px solid var(--border); padding:6px 9px; text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  tbody td.l { text-align:left; } tbody tr:hover { background:rgba(127,127,127,.07); }
  tbody tr.sel { background:rgba(108,182,255,.10); }
  tbody tr.grouphead td { background:rgba(108,182,255,.10); font-weight:600; color:var(--link); cursor:pointer; }
  .pos { color:var(--ok); } .neg { color:var(--bad); }
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
const TOKENS = ${JSON.stringify(tokens)};
const PER = 50;
let tab = TOKENS[0] || 'CATE';
let sortKey='realized_pnl_sol', sortDir=-1, page=1, mode='flat';
let gSortDir=-1;
const sel = new Set();
const open = new Set();
const F = {};   // active filters

const NUMCOLS=[['n_buys','Buys'],['n_sells','Sells'],['sol_in','SOL in'],['sol_out','SOL out'],
  ['realized_pnl_sol','PnL SOL'],['realized_pnl_usd','PnL USD'],['tokens_still_held','Held'],
  ['hold_min','Hold min'],['first_buy_mcap_usd','Buy mcap $']];
const COLS=[
  {k:'_sel', t:'', l:true, kind:'sel'},
  {k:'wallet',t:'Wallet',l:true,kind:'wallet'},
  {k:'tag',t:'Tag',l:true,kind:'tag'},
  {k:'first_buy_time_utc',t:'First buy',l:true,kind:'time'},
  {k:'first_buy_mcap_usd',t:'Buy mcap $',kind:'num',d:0},
  {k:'last_sell_time_utc',t:'Last sell',l:true,kind:'time'},
  {k:'n_buys',t:'Buys',kind:'int'},{k:'n_sells',t:'Sells',kind:'int'},
  {k:'sol_in',t:'SOL in',kind:'num',d:3},{k:'sol_out',t:'SOL out',kind:'num',d:3},
  {k:'realized_pnl_sol',t:'PnL SOL',kind:'pnl',d:3},{k:'realized_pnl_usd',t:'PnL USD',kind:'pnl',d:0},
  {k:'tokens_still_held',t:'Held',kind:'num',d:0},{k:'hold_min',t:'Hold min',kind:'num',d:1},
  {k:'sold_out',t:'Sold out',kind:'bool'},
];
const nz=(v)=>v===null||v===undefined||v==='';
const fmt=(v,d)=>nz(v)?'<span class="muted">—</span>':Number(v).toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});
const esc=(s)=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function toast(msg,err){const t=document.getElementById('toast');t.textContent=msg;
  t.className='show'+(err?' err':'');setTimeout(()=>t.className='',err?2600:1200);}

function tokenRows(){ return ROWS.filter(r=>r.token===tab); }

/** Filters apply to the whole token set, before sorting and paging. */
function filtered(){
  return tokenRows().filter(r=>{
    if(F.q && !r.wallet.toLowerCase().includes(F.q.toLowerCase())) return false;
    if(F.tagMode==='tagged' && !r.tag) return false;
    if(F.tagMode==='untagged' && r.tag) return false;
    if(F.tag && r.tag!==F.tag) return false;
    if(F.sold==='yes' && !r.sold_out) return false;
    if(F.sold==='no' && r.sold_out) return false;
    for(const [k] of NUMCOLS){
      const lo=F['min_'+k], hi=F['max_'+k];
      if(lo!==undefined && lo!=='' ){ if(nz(r[k]) || Number(r[k])<Number(lo)) return false; }
      if(hi!==undefined && hi!=='' ){ if(nz(r[k]) || Number(r[k])>Number(hi)) return false; }
    }
    for(const [k,f] of [['first_buy_time_utc','fb'],['last_sell_time_utc','ls']]){
      const lo=F[f+'_from'], hi=F[f+'_to'];
      if(lo){ if(nz(r[k]) || String(r[k]).slice(0,10) < lo) return false; }
      if(hi){ if(nz(r[k]) || String(r[k]).slice(0,10) > hi) return false; }
    }
    return true;
  });
}
function cmp(a,b,k){
  const A=a[k],B=b[k], an=nz(A), bn=nz(B);
  if(an&&bn) return 0;
  if(an) return 1*sortDir;      // nulls last in both directions
  if(bn) return -1*sortDir;
  if(typeof A==='number'&&typeof B==='number') return A-B;
  if(typeof A==='boolean') return (A?1:0)-(B?1:0);
  return String(A).localeCompare(String(B));
}
function ordered(){
  const rows=filtered();
  if(mode==='flat'){ rows.sort((a,b)=>cmp(a,b,sortKey)*sortDir); return rows.map(r=>({r})); }
  const g=new Map(), loose=[];
  for(const r of rows){ if(!r.tag){loose.push(r);continue;} if(!g.has(r.tag)) g.set(r.tag,[]); g.get(r.tag).push(r); }
  const gs=[...g.entries()].map(([tag,rs])=>({tag,rs,sum:rs.reduce((s,x)=>s+x.realized_pnl_sol,0)}))
    .sort((a,b)=>b.sum-a.sum);
  const out=[];
  for(const x of gs){ out.push({head:x}); x.rs.sort((a,b)=>b.realized_pnl_sol-a.realized_pnl_sol);
    for(const r of x.rs) out.push({r}); }
  if(loose.length){ out.push({head:{tag:'untagged',rs:loose,sum:loose.reduce((s,x)=>s+x.realized_pnl_sol,0)}});
    loose.sort((a,b)=>b.realized_pnl_sol-a.realized_pnl_sol); for(const r of loose) out.push({r}); }
  return out;
}
function cell(r,c){
  const v=r[c.k];
  if(c.kind==='sel') return '<input type="checkbox" class="rowsel" data-w="'+r.wallet+'"'+(sel.has(r.wallet)?' checked':'')+'>';
  if(c.kind==='wallet') return '<span class="wallet" data-w="'+r.wallet+'" title="'+r.wallet+'">'+r.wallet.slice(0,4)+'…'+r.wallet.slice(-4)+'</span>';
  if(c.kind==='tag') return v
    ? '<span class="tag'+(r.tag_source==='manual'?' man':'')+'" data-edit="'+r.wallet+'">'+esc(v)+'</span>'
    : '<span class="tagempty" data-edit="'+r.wallet+'">+ tag</span>';
  if(c.kind==='time') return nz(v)?'<span class="muted">—</span>':'<span class="muted">'+String(v).replace('T',' ').replace('Z','')+'</span>';
  if(c.kind==='bool') return v?'yes':'<span class="muted">no</span>';
  if(c.kind==='int') return nz(v)?'<span class="muted">—</span>':v;
  if(c.kind==='pnl'){ if(nz(v)) return '<span class="muted">—</span>';
    const n=Number(v); return '<span class="'+(n>0?'pos':n<0?'neg':'')+'">'+(n>0?'+':'')+fmt(n,c.d)+'</span>'; }
  return fmt(v,c.d??2);
}
function summary(rows){
  const p=rows.map(r=>r.realized_pnl_sol).sort((a,b)=>a-b);
  const med=p.length?(p.length%2?p[(p.length-1)/2]:(p[p.length/2-1]+p[p.length/2])/2):0;
  return {n:rows.length, win:p.filter(x=>x>0).length, lose:p.filter(x=>x<0).length,
          sum:p.reduce((a,b)=>a+b,0), med, tags:new Set(rows.filter(r=>r.tag).map(r=>r.tag)).size};
}
function filterBar(){
  const tags=[...new Set(tokenRows().filter(r=>r.tag).map(r=>r.tag))].sort();
  const numF=NUMCOLS.map(([k,t])=>
    '<div class="f"><label>'+t+'</label><div class="pair">'+
    '<input class="num" type="number" step="any" placeholder="min" data-f="min_'+k+'" value="'+(F['min_'+k]??'')+'">'+
    '<span>–</span><input class="num" type="number" step="any" placeholder="max" data-f="max_'+k+'" value="'+(F['max_'+k]??'')+'"></div></div>').join('');
  return '<div class="filters"><div class="frow">'+
    '<div class="f"><label>Wallet search</label><input class="txt" type="text" placeholder="partial address" data-f="q" value="'+(F.q??'')+'"></div>'+
    '<div class="f"><label>Tag</label><select data-f="tagMode">'+
      ['all','tagged','untagged'].map(v=>'<option value="'+v+'"'+(F.tagMode===v?' selected':'')+'>'+
        {all:'All',tagged:'Tagged only',untagged:'Untagged only'}[v]+'</option>').join('')+'</select></div>'+
    '<div class="f"><label>Specific tag</label><select data-f="tag"><option value="">— any —</option>'+
      tags.map(t=>'<option value="'+esc(t)+'"'+(F.tag===t?' selected':'')+'>'+esc(t)+'</option>').join('')+'</select></div>'+
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
  const all=ordered();
  const rowsOnly=all.filter(x=>x.r).map(x=>x.r);
  const s=summary(filtered());
  const total=tokenRows().length;
  document.getElementById('sub').textContent='· '+tab+' · '+total+' wallets';
  const pages=Math.max(1,Math.ceil(all.length/PER));
  if(page>pages) page=pages;
  const slice=all.slice((page-1)*PER,page*PER);
  const head='<tr>'+COLS.map(c=>c.kind==='sel'
      ? '<th class="l"><input type="checkbox" id="selall"></th>'
      : '<th class="'+(c.l?'l':'')+'" data-k="'+c.k+'">'+c.t+
        (mode==='flat'&&sortKey===c.k?' <span class="arrow">'+(sortDir<0?'▼':'▲')+'</span>':'')+'</th>').join('')+'</tr>';
  const body=slice.map(x=>{
    if(x.head) return '<tr class="grouphead"><td colspan="'+COLS.length+'">'+esc(x.head.tag)+
      ' · '+x.head.rs.length+' wallets · combined '+(x.head.sum>=0?'+':'')+x.head.sum.toFixed(2)+' SOL</td></tr>';
    return '<tr class="'+(sel.has(x.r.wallet)?'sel':'')+'">'+
      COLS.map(c=>'<td class="'+(c.l?'l':'')+'">'+cell(x.r,c)+'</td>').join('')+'</tr>';
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
      '<button class="btn '+(mode==='flat'?'pri':'')+'" id="m-flat">Sort by column</button>'+
      '<button class="btn '+(mode==='group'?'pri':'')+'" id="m-group">Group by tag</button>'+
      '<button class="btn" id="export">Export CSV</button>'+
      '<span style="flex:1"></span>'+
      '<span class="count" id="selcount">'+sel.size+' selected</span>'+
      '<input class="tagin" id="bulktag" placeholder="tag name" style="width:130px">'+
      '<button class="btn" id="bulkset" '+(sel.size?'':'disabled')+'>Tag selected</button>'+
      '<button class="btn" id="bulkclear" '+(sel.size?'':'disabled')+'>Clear tag</button>'+
    '</div>'+
    '<div class="tablebox"><table><thead>'+head+'</thead><tbody>'+body+'</tbody></table></div>'+
    '<div class="pager">'+pg+'</div>';
  window.__rows=rowsOnly;
}

function renderGroups(){
  const rows=tokenRows();
  const g=new Map();
  for(const r of rows){ if(!r.tag) continue; if(!g.has(r.tag)) g.set(r.tag,[]); g.get(r.tag).push(r); }
  const gs=[...g.entries()].map(([tag,rs])=>({
    tag, n:rs.length,
    pnl:rs.reduce((s,x)=>s+x.realized_pnl_sol,0),
    solin:rs.reduce((s,x)=>s+x.sol_in,0),
    first:rs.map(x=>x.first_buy_time_utc).filter(Boolean).sort()[0]||'',
    last:rs.map(x=>x.last_sell_time_utc).filter(Boolean).sort().slice(-1)[0]||'',
    manual:rs.some(x=>x.tag_source==='manual'), rs,
  })).sort((a,b)=>(b.pnl-a.pnl)*(gSortDir<0?1:-1));
  const body=gs.map(x=>{
    const isOpen=open.has(x.tag);
    let h='<tr><td class="l"><button class="btn" style="padding:1px 7px" data-exp="'+esc(x.tag)+'">'+(isOpen?'▾':'▸')+'</button></td>'+
      '<td class="l"><span class="tag'+(x.manual?' man':'')+'" data-rename="'+esc(x.tag)+'">'+esc(x.tag)+'</span></td>'+
      '<td>'+x.n+'</td>'+
      '<td><span class="'+(x.pnl>0?'pos':x.pnl<0?'neg':'')+'">'+(x.pnl>0?'+':'')+x.pnl.toFixed(3)+'</span></td>'+
      '<td>'+x.solin.toFixed(3)+'</td>'+
      '<td class="l"><span class="muted">'+(x.first||'—').replace('T',' ').replace('Z','')+'</span></td>'+
      '<td class="l"><span class="muted">'+(x.last||'—').replace('T',' ').replace('Z','')+'</span></td>'+
      '<td class="muted">—</td></tr>';
    if(isOpen){
      h+='<tr><td></td><td colspan="7" class="l" style="padding:0 9px 8px">'+
        x.rs.sort((a,b)=>b.realized_pnl_sol-a.realized_pnl_sol).map(r=>
          '<div style="display:flex;gap:12px;padding:2px 0;font-size:12px">'+
          '<span class="wallet" data-w="'+r.wallet+'" title="'+r.wallet+'">'+r.wallet.slice(0,4)+'…'+r.wallet.slice(-4)+'</span>'+
          '<span class="'+(r.realized_pnl_sol>0?'pos':'neg')+'">'+(r.realized_pnl_sol>0?'+':'')+r.realized_pnl_sol.toFixed(3)+' SOL</span>'+
          '<span class="muted">'+r.n_buys+'b/'+r.n_sells+'s</span>'+
          '<span class="muted">'+(r.first_buy_time_utc||'').replace('T',' ').replace('Z','')+'</span></div>').join('')+
        '</td></tr>';
    }
    return h;
  }).join('');
  document.getElementById('sub').textContent='· '+tab+' · '+gs.length+' groups';
  document.getElementById('view').innerHTML =
    '<div class="note">⚠️ <strong>Tokens touched</strong> is not yet populated — it needs cross-token data, and only '+
    TOKENS.join(', ')+' has been loaded. The column is present but empty rather than showing a 1 that would just be counting this page.</div>'+
    '<div class="tablebox"><table><thead><tr>'+
      '<th class="l"></th><th class="l">Tag</th><th>Wallets</th>'+
      '<th data-gsort="1" style="cursor:pointer">Combined PnL SOL '+(gSortDir<0?'▼':'▲')+'</th>'+
      '<th>Combined SOL in</th><th class="l">Earliest first buy</th><th class="l">Latest last sell</th>'+
      '<th>Tokens touched</th></tr></thead><tbody>'+(body||'<tr><td colspan="8" class="l muted">no tags</td></tr>')+'</tbody></table></div>';
}

function render(){
  document.getElementById('tabs').innerHTML =
    TOKENS.map(t=>'<button class="'+(tab===t?'on':'')+'" data-tab="'+t+'">'+esc(t)+'</button>').join('')+
    '<button class="'+(tab==='__groups'?'on':'')+'" data-tab="__groups">Groups</button>';
  if(tab==='__groups') renderGroups(); else renderTable();
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
  const rows=ordered().filter(x=>x.r).map(x=>x.r);
  const cols=['token','wallet','tag','tag_source','first_buy_time_utc','first_buy_mcap_usd',
    'last_sell_time_utc','n_buys','n_sells','sol_in','sol_out','realized_pnl_sol',
    'realized_pnl_usd','tokens_still_held','hold_min','sold_out'];
  const q=(v)=>{ if(v===null||v===undefined) return '';
    const s=String(v); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; };
  const csv=[cols.join(',')].concat(rows.map(r=>cols.map(c=>q(r[c])).join(','))).join('\n')+'\n';
  const stamp=new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download=tab.toLowerCase()+'_wallet_pnl_'+stamp+'.csv';
  a.click(); URL.revokeObjectURL(a.href);
  toast('exported '+rows.length+' rows');
}

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
  if(e.target.id==='export'){ exportCsv(); return; }
  if(e.target.id==='m-flat'){ mode='flat'; page=1; render(); return; }
  if(e.target.id==='m-group'){ mode='group'; page=1; render(); return; }
  if(e.target.dataset && e.target.dataset.gsort){ gSortDir=-gSortDir; render(); return; }
  const exp=e.target.closest('[data-exp]');
  if(exp){ const t=exp.dataset.exp; open.has(t)?open.delete(t):open.add(t); render(); return; }
  const th=e.target.closest('th[data-k]');
  if(th){ if(mode!=='flat') mode='flat';
    const k=th.dataset.k; if(sortKey===k) sortDir=-sortDir; else {sortKey=k;sortDir=-1;}
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
  const w=e.target.closest('.wallet');
  if(w){ navigator.clipboard.writeText(w.dataset.w).then(()=>toast('copied '+w.dataset.w.slice(0,4)+'…'+w.dataset.w.slice(-4))); }
});
render();
</script>
</body>
</html>`;
}
