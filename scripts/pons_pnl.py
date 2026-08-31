#!/usr/bin/env python3
"""PONS: FIFO PnL + two-column balance check. Writes CSV/JSON only, no Postgres."""
import json,os,time,statistics,requests
from collections import defaultdict,deque
from dotenv import load_dotenv
S=("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
   "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),".env"))
AL=f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
POOL="0x10cc6bd38112cac182db90b6a71d8bb5939526ba"; TOKEN="0x39dbed3a2bd333467115de45665cc57f813c4571"
DEC=10**18; SUPPLY=1_000_000_000
d=json.load(open(S+"/pons_decoded.json"))
trades,cohort,mc,ETH=d["trades"],set(d["cohort"]),d["mc"],d["eth"]

def call(batch):
    for a in range(6):
        try:
            r=requests.post(AL,json=batch,timeout=120)
            if r.status_code in (429,500,502,503,504): time.sleep(1.5*(a+1)); continue
            j=r.json()
            return j if isinstance(j,list) else [j]
        except Exception: time.sleep(1.5*(a+1))
    raise SystemExit("rpc failed")
HEAD=int(call([{"jsonrpc":"2.0","id":0,"method":"eth_blockNumber","params":[]}])[0]["result"],16)
sl=call([{"jsonrpc":"2.0","id":0,"method":"eth_call","params":[{"to":POOL,"data":"0x3850c7bd"},hex(HEAD)]}])[0]
sq=int(sl["result"][2:66],16)
p01=(sq/(2**96))**2                       # token0(WETH) priced in token1(PONS)
PX_ETH=1.0/p01 if p01 else 0.0            # WETH per PONS; both 18dp so no scaling
PX_USD=PX_ETH*ETH
print(f"HEAD {HEAD:,}  pool price {PX_ETH:.10f} WETH/PONS  = ${PX_USD:.8f}  (mcap ${PX_USD*SUPPLY:,.0f})")

cw=sorted(cohort); bal={}
print(f"balanceOf: {len(cw):,} wallets, batched, pinned at block {HEAD:,}")
for i in range(0,len(cw),100):
    ch=cw[i:i+100]
    req=[{"jsonrpc":"2.0","id":j,"method":"eth_call","params":[{"to":TOKEN,
          "data":"0x70a08231"+"0"*24+w[2:]},hex(HEAD)]} for j,w in enumerate(ch)]
    for r in call(req):
        v=r.get("result")
        bal[ch[r["id"]]]=int(v,16)/DEC if v and v!="0x" else 0.0
    if (i//100)%3==0: print(f"  {min(i+100,len(cw))}/{len(cw)}",flush=True)

byw=defaultdict(list)
for t in trades:
    if t["wallet"] in cohort: byw[t["wallet"]].append(t)
rows=[]
for w,ts in byw.items():
    ts.sort(key=lambda x:(x["block"],x["logIndex"]))   # deterministic tie-break
    lots=deque(); real=0.0; bought=sold=cost_in=proc=0.0; first_sell=(ts[0]["side"]=="sell")
    for t in ts:
        u=t["quote"]/t["token"] if t["token"] else 0.0
        if t["side"]=="buy":
            lots.append([t["token"],u]); bought+=t["token"]; cost_in+=t["quote"]
        else:
            need=t["token"]; sold+=t["token"]; proc+=t["quote"]
            while need>1e-15 and lots:
                lot=lots[0]; take=min(need,lot[0])
                real+=take*(u-lot[1]); lot[0]-=take; need-=take
                if lot[0]<=1e-15: lots.popleft()
            if need>1e-15: real+=need*u          # unsold-inventory basis is zero
    imp=bought-sold; onc=bal.get(w,0.0); rem=sum(l[0] for l in lots)
    rows.append({"wallet":w,"trades":len(ts),"tokens_bought":bought,"tokens_sold":sold,
        "realized_pnl_eth":real,"realized_pnl_usd":real*ETH,"implied_balance":imp,
        "onchain_balance":onc,"balance_delta":onc-imp,"remaining_tokens":rem,
        "unrealized_pnl_usd":onc*PX_USD,"still_holding":onc>0,
        "first_action_sell":first_sell,"first_buy_mcap_usd":mc.get(w,0.0),
        "price_block":HEAD,"price_usd":PX_USD,
        "paths":",".join(sorted({t["path"] for t in ts}))})

dl=sorted(abs(r["balance_delta"]) for r in rows)
n=len(dl); pq=lambda p:dl[min(n-1,int(p*n))]
TOL=max(1e-9,pq(0.50)*10) if pq(0.50)>0 else 1e-6
med_bought=statistics.median([r["tokens_bought"] for r in rows if r["tokens_bought"]>0])
TOL=max(TOL,med_bought*1e-9)
for r in rows: r["balance_match"]=abs(r["balance_delta"])<=TOL
mt=sum(1 for r in rows if r["balance_match"])
print(f"\nBALANCE CHECK  tolerance {TOL:.10g} tokens")
print(f"  |delta| p50 {pq(.5):.6g}  p75 {pq(.75):.6g}  p90 {pq(.9):.6g}  p99 {pq(.99):.6g}  max {dl[-1]:.6g}")
print(f"  match {mt:,}/{n:,} ({100*mt/n:.1f}%)")
print(f"  exact zero delta: {sum(1 for r in rows if r['balance_delta']==0):,}")
print(f"  negative delta (sold/moved off-window): {sum(1 for r in rows if r['balance_delta']<-TOL):,}")
print(f"  positive delta (acquired elsewhere):    {sum(1 for r in rows if r['balance_delta']>TOL):,}")
bp=defaultdict(lambda:[0,0])
for r in rows:
    bp[r["paths"]][0]+=1; bp[r["paths"]][1]+=r["balance_match"]
print("  match rate by attribution path:")
for k,(t_,m_) in sorted(bp.items()): print(f"    {k:<20} {m_:>5,}/{t_:<6,} {100*m_/t_:>5.1f}%")
pn=sorted(r["realized_pnl_usd"] for r in rows)
print(f"\nFIFO PnL  cohort {len(rows):,}   median ${statistics.median(pn):,.2f}   "
      f"total ${sum(pn):,.0f}   winners {sum(1 for x in pn if x>0):,}")
rows.sort(key=lambda r:-r["realized_pnl_usd"])
print("\nTOP 10")
print(f"  {'wallet':<44}{'PnL USD':>13}{'bought':>14}{'sold':>14}{'onchain':>14}{'unreal$':>12}")
for r in rows[:10]:
    print(f"  {r['wallet']:<44}{r['realized_pnl_usd']:>13,.0f}{r['tokens_bought']:>14,.0f}"
          f"{r['tokens_sold']:>14,.0f}{r['onchain_balance']:>14,.0f}{r['unrealized_pnl_usd']:>12,.0f}")
json.dump({"rows":rows,"head":HEAD,"px":PX_USD,"tol":TOL},open(S+"/pons_rows.json","w"))
top=rows[0]["wallet"]
print(f"\nFIFO WALKTHROUGH — {top}")
lots=deque(); run=0.0
for t in sorted(byw[top],key=lambda x:(x["block"],x["logIndex"])):
    u=t["quote"]/t["token"]
    if t["side"]=="buy":
        lots.append([t["token"],u])
        print(f"  BUY  {t['token']:>13,.2f} @ {u:.3e} ETH  cost {t['quote']:.6f} ETH  blk {t['block']:,}")
    else:
        need=t["token"]; g=0.0
        while need>1e-15 and lots:
            lot=lots[0]; take=min(need,lot[0]); g+=take*(u-lot[1]); lot[0]-=take; need-=take
            if lot[0]<=1e-15: lots.popleft()
        if need>1e-15: g+=need*u
        run+=g
        print(f"  SELL {t['token']:>13,.2f} @ {u:.3e} ETH  proceeds {t['quote']:.6f}  "
              f"gain {g:+.6f} ETH  running {run:+.6f} ETH  blk {t['block']:,}")
print(f"  TOTAL {run:+.6f} ETH x ${ETH:,.2f} = ${run*ETH:,.2f}   unsold {sum(l[0] for l in lots):,.2f}")
