#!/usr/bin/env python3
"""AI cohort: mcap at first buy, threshold, excess sellers."""
import json, statistics
from collections import defaultdict
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
SUPPLY = 1_000_000_000          # reconciled flat across the window
THRESH = 2_000_000

d = json.load(open(S+"/ai_decoded.json")); tr = d["trades"]
w = json.load(open(S+"/ai_window.json"))
qs = json.load(open(S+"/ai_quote_series.json"))
inw = [p for t, p in qs["points"] if w["first_ts"] <= t <= w["end_ts"]]
NVDA_USD = statistics.mean(inw)
lo, hi = min(inw), max(inw)
spread = 100*(hi-lo)/NVDA_USD
BASIS = (f"constant {NVDA_USD:,.4f} USD/NVDA, from the NVDA/USDG uniswap v3 pool "
         f"{qs['pool']} ({len(inw)} in-window swaps; NVDA moved {spread:.2f}% across "
         f"the 4h window, under the 5% bar)")
print(f"NVDA/USD constant ${NVDA_USD:,.4f}  (min ${lo:,.4f} max ${hi:,.4f}, spread {spread:.2f}%)")

byw = defaultdict(list)
for t in tr: byw[t["wallet"]].append(t)
first = {}
for t in sorted(tr, key=lambda x: (x["block"], x["logIndex"])):
    if t["side"] != "buy" or t["wallet"] in first: continue
    first[t["wallet"]] = t
mc = {wl: (t["quote"]/t["token"])*SUPPLY*NVDA_USD for wl, t in first.items() if t["token"] > 0}
v = sorted(mc.values()); n = len(v); q = lambda p: v[min(n-1, int(p*n))]
print(f"\nMCAP AT FIRST BUY  ({n:,} wallets with a buy)")
for lab, val in (("min",v[0]),("p10",q(.10)),("p25",q(.25)),("median",statistics.median(v)),
                 ("p75",q(.75)),("p90",q(.90)),("max",v[-1])):
    print(f"    {lab:>6}  ${val:>13,.0f}")
step = max(1, int(v[-1]/20)); bk = defaultdict(int)
for x in v: bk[int(x//step)] += 1
mx = max(bk.values())
print(f"  histogram (${step:,} buckets):")
for i in sorted(bk):
    print(f"    ${i*step:>11,}-${(i+1)*step:>11,} {bk[i]:>5,} {'#'*int(40*bk[i]/mx)}")
under = [wl for wl, m in mc.items() if m < THRESH]
pct = 100*len(under)/n
print(f"\n  THRESHOLD ${THRESH:,}: {len(under):,} of {n:,} ({pct:.1f}%)")
binding = not (pct >= 99.9)
print(f"  threshold_binding = {binding}"
      + ("" if binding else "  ** admits everything; cohort is defined by the window **"))
excess = set()
for wl, ts in byw.items():
    b = sum(t["token"] for t in ts if t["side"] == "buy")
    s = sum(t["token"] for t in ts if t["side"] == "sell")
    if s - b > 1: excess.add(wl)
cohort = [wl for wl in under if wl not in excess]
print(f"  excess sellers {len(excess):,}   COHORT {len(cohort):,}")
json.dump({"cohort": cohort, "mc": mc, "nvda_usd": NVDA_USD, "basis": BASIS,
           "threshold_binding": binding, "under": len(under), "total_buyers": n,
           "spread_pct": spread}, open(S+"/ai_cohort.json","w"))
