#!/usr/bin/env python3
"""PONS: decode -> mcap -> cohort -> FIFO -> balances. Writes nothing to Postgres."""
import json, os, sys, time, bisect, statistics, requests
from collections import defaultdict, deque
S=("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
   "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
POOL="0x10cc6bd38112cac182db90b6a71d8bb5939526ba"
TOKEN="0x39dbed3a2bd333467115de45665cc57f813c4571"
ZERO="0x"+"0"*40; DEC=10**18; SUPPLY=1_000_000_000; THRESH=10_000_000
i256=lambda h:(lambda v: v-(1<<256) if v>=(1<<255) else v)(int(h,16))

sw=json.load(open(S+"/pons_window_swaps.json"))
rec={}
for line in open(S+"/pons_receipts.jsonl"):
    try: r=json.loads(line); rec[r["k"]]=r["v"]
    except ValueError: pass
circ=set(json.load(open(S+"/pons_circ.json")))
win=json.load(open(S+"/pons_window.json"))
t_first,t_end=win["t_first"],win["t_end"]; b_first=win["b_first"]
spb=(t_end-t_first)/max(1,(win["b_end"]-b_first))
ts_of=lambda bn:int(t_first+(bn-b_first)*spb)

r=requests.get("https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range",
   params={"vs_currency":"usd","from":t_first-7200,"to":t_end+7200},timeout=90).json()
pts=sorted(r.get("prices") or [],key=lambda p:p[0])
ets=[int(p[0]/1000) for p in pts]; epx=[float(p[1]) for p in pts]
lo,hi=min(epx),max(epx); mean=sum(epx)/len(epx); spread=100*(hi-lo)/mean
MODE="constant" if spread<=5.0 else "per_trade"
def eth_at(t):
    if MODE=="constant": return mean
    i=bisect.bisect_left(ets,t)
    if i<=0: return epx[0]
    if i>=len(ets): return epx[-1]
    return epx[i] if abs(ets[i]-t)<abs(ets[i-1]-t) else epx[i-1]
BASIS=(f"constant {mean:,.2f} USD/ETH (CoinGecko, {len(pts)} hourly points; ETH moved "
       f"{spread:.1f}% across the {(t_end-t_first)/3600:.1f}h window, under the 5% bar)"
       if MODE=="constant" else f"hourly ETH/USD at each trade ({len(pts)} points, spread {spread:.1f}%)")
print(f"USD METHOD: {MODE}   ETH ${lo:,.2f}..${hi:,.2f}  spread {spread:.1f}%")
print(f"  basis: {BASIS}")

by_tx=defaultdict(list)
for l in sw: by_tx[l["transactionHash"]].append(l)
def net_of(v,contract):
    n=defaultdict(float)
    for a,b,data,addr in v.get("transfers",[]):
        if addr!=contract: continue
        x=int(data,16)/DEC; n["0x"+a]-=x; n["0x"+b]+=x
    return n
trades=[]; skipped_circ=0; no_mover=0; paths=defaultdict(int)
for h,g in by_tx.items():
    if h in circ: skipped_circ+=len(g); continue
    v=rec.get(h)
    if not v: continue
    net=net_of(v,TOKEN)
    movers={k:x for k,x in net.items() if abs(x)>1e-12 and k not in (POOL,ZERO)}
    total_pool=sum(abs(i256(l["data"][2:][64:128]))/DEC for l in g) or 1.0
    for l in g:
        d=l["data"][2:]; a0=i256(d[0:64]); a1=i256(d[64:128])
        if a0==0 or a1==0: continue
        pool_amt=abs(a1)/DEC; quote=abs(a0)/DEC
        side="buy" if a1<0 else "sell"
        cands={k:x for k,x in movers.items() if (x>0)==(side=="buy")}
        if not cands: no_mover+=1; continue
        w=max(cands.items(),key=lambda kv:abs(kv[1]))[0]
        # ROUTER SPLIT: the swap's own pool amount, never the wallet's whole net
        path="single" if len(g)==1 else "multiswap"
        paths[path]+=1
        bn=int(l["blockNumber"],16)
        trades.append({"tx":h,"block":bn,"t":ts_of(bn),"wallet":w,"side":side,
                       "quote":quote,"token":pool_amt,"pool_token":pool_amt,
                       "path":path,"logIndex":int(l["logIndex"],16)})
print(f"\nDECODE: {len(trades):,} trades  circular-arb skipped {skipped_circ}  no-mover {no_mover}")
print(f"  attribution paths: {dict(paths)}")
byw=defaultdict(list)
for t in trades: byw[t["wallet"]].append(t)
print(f"  wallets attributed: {len(byw):,}")

# validation: trader/pool ratio by path (fee is 0%, so band is 1.0)
band=defaultdict(lambda:[0,0])
for h,g in by_tx.items():
    if h in circ: continue
    v=rec.get(h)
    if not v or len(g)!=1: continue
    net=net_of(v,TOKEN)
    mv={k:x for k,x in net.items() if abs(x)>1e-12 and k not in (POOL,ZERO)}
    if not mv: continue
    d=g[0]["data"][2:]; a1=i256(d[64:128]); pool_amt=abs(a1)/DEC
    if pool_amt<=0: continue
    w=max(mv.items(),key=lambda kv:abs(kv[1]))[0]
    side="buy" if a1<0 else "sell"
    ratio=abs(mv[w])/pool_amt
    k=f"single|{side}"; band[k][0]+=1
    if abs(ratio-1.0)>0.0005: band[k][1]+=1
print("  skim-band check (fee 0%, so target ratio 1.0, tol 0.05%):")
for k,(n,o) in sorted(band.items()):
    print(f"    {k:<14} n={n:>6,}  out-of-band {o:>5,} ({100*o/max(n,1):>5.2f}%)")

first={}
for t in sorted(trades,key=lambda x:(x["block"],x["logIndex"])):
    if t["side"]!="buy" or t["wallet"] in first: continue
    first[t["wallet"]]=t
mc={w:(t["quote"]/t["token"])*SUPPLY*eth_at(t["t"]) for w,t in first.items() if t["token"]>0}
v=sorted(mc.values()); n=len(v); q=lambda p:v[min(n-1,int(p*n))]
print(f"\nMCAP AT FIRST BUY  ({n:,} wallets with a buy)")
for lab,val in (("min",v[0]),("p10",q(.10)),("p25",q(.25)),("median",statistics.median(v)),
                ("p75",q(.75)),("p90",q(.90)),("max",v[-1])):
    print(f"    {lab:>6}  ${val:>14,.0f}")
step=max(1,int(v[-1]/20))
bk=defaultdict(int)
for x in v: bk[int(x//step)]+=1
mx=max(bk.values())
print(f"  histogram (${step:,} buckets):")
for i in sorted(bk)[:20]:
    print(f"    ${i*step:>12,}-${(i+1)*step:>12,} {bk[i]:>5,} {'#'*int(40*bk[i]/mx)}")
under=[w for w,m in mc.items() if m<THRESH]
pct=100*len(under)/n
print(f"\n  THRESHOLD ${THRESH:,}: {len(under):,} of {n:,} ({pct:.1f}%)")
if pct<3 or pct>40: print(f"  ** FLAG: {pct:.1f}% is {'under 3%' if pct<3 else 'over 40%'}")
excess=set()
for w,ts in byw.items():
    b=sum(t["token"] for t in ts if t["side"]=="buy"); s=sum(t["token"] for t in ts if t["side"]=="sell")
    if s-b>1: excess.add(w)
cohort=[w for w in under if w not in excess]
print(f"  excess sellers {len(excess):,}   COHORT {len(cohort):,}")
json.dump({"trades":trades,"cohort":cohort,"mc":mc,"basis":BASIS,"eth":mean,
           "mode":MODE},open(S+"/pons_decoded.json","w"))
