#!/usr/bin/env python3
"""Build the AI load payload: rows, clusters, token record."""
import json, os, sys, time
from collections import defaultdict
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline import infrastructure as infra
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
EXCL = infra.excluded_set("robinhood", [PM])
utc = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))

R = json.load(open(S+"/ai_rows.json")); rows = R["rows"]
d = json.load(open(S+"/ai_decoded.json")); tr = d["trades"]; fee = d["fee"]
co = json.load(open(S+"/ai_cohort.json"))
w = json.load(open(S+"/ai_window.json"))
bt = {int(k): v for k, v in json.load(open(S+"/ai_blocktimes.json")).items()}
cohort = {r["wallet"] for r in rows}

sig = {}
for line in open(S+"/ai_receipts.jsonl"):
    r = json.loads(line); sig[r["k"]] = (r["v"] or {}).get("from", "")
txw = defaultdict(set)
for t in tr:
    if t["wallet"] in cohort: txw[t["tx"]].add(t["wallet"])
bysig = defaultdict(set)
for tx, ws in txw.items():
    s = sig.get(tx, "")
    if not s or s in EXCL: continue
    for wl in ws:
        if wl != s: bysig[s].add(wl)
cand = {s: v for s, v in bysig.items() if len(v) > 1}
sizes = sorted({len(v) for v in cand.values()})
gap, cut = 0, None
for i in range(1, len(sizes)):
    if sizes[i]-sizes[i-1] > gap and sizes[i] >= 10:
        gap, cut = sizes[i]-sizes[i-1], sizes[i]
print(f"shared_signer: {len(cand):,} multi-wallet signers, sizes {sizes[:6]}..{sizes[-4:]}")
print(f"  degree gap {gap} -> infrastructure cut at >= {cut}" if cut else "  no gap found")
clusters = []; n = 0; excl_infra = 0
for s, ws in sorted(cand.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    if cut and len(ws) >= cut: excl_infra += 1; continue
    n += 1; cid = f"ai-s{n:03d}"
    for wl in sorted(ws):
        clusters.append({"chain":"robinhood","wallet":wl,"cluster_id":cid,
                         "signal":"shared_signer","evidence":s,
                         "confidence":"high","cluster_size":len(ws)})
print(f"  kept {n} clusters, excluded {excl_infra} as infrastructure")
m = 0
for tx, ws in sorted(txw.items()):
    if len(ws) < 2: continue
    m += 1; cid = f"ai-t{m:03d}"
    for wl in sorted(ws):
        clusters.append({"chain":"robinhood","wallet":wl,"cluster_id":cid,
                         "signal":"same_transaction","evidence":tx,
                         "confidence":"high","cluster_size":len(ws)})
print(f"same_transaction: {m} clusters")
print(f"cluster rows {len(clusters):,} covering "
      f"{len({c['wallet'] for c in clusters}):,} of {len(rows):,} wallets")

tok = {
  "token":"AI","chain":"robinhood",
  "token_address":"0x2e8c31162b855a2ffa90f6f8634643ad6f111e18",
  "pool_address":"0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27",
  "dex":"uniswap","dex_version":"v4",
  "quote_asset":"NVDA","quote_address":"0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  "quote_decimals":18,"total_supply":1_000_000_000,"window_hours":4,
  "window_start_utc":utc(w["first_ts"]),"window_end_utc":utc(w["end_ts"]),
  "first_swap_block":w["first_block"],"boundary_block":w["boundary_block"],
  "swaps_in_window":5725,"unique_txs":3585,"fully_covered":True,
  "mcap_threshold_usd":2_000_000,"threshold_binding":False,
  "threshold_note":("highest first-buy mcap was $459,433 against a $2,000,000 "
                    "ceiling, 1,173 of 1,173 admitted"),
  "fee_rate_buy":fee["buy"],"fee_rate_sell":fee["sell"],
  "usd_method":"constant","rate_basis":co["basis"],
  "price_usd":R["px"],"price_block":w["head"],"balance_block":w["head"],
  "cohort_size":len(rows),
  "decode_check":("pool-only subset reproduces on-chain balance for 318/324 wallets "
                  "(98.1%), 70/76 of those holding a nonzero balance; 162 of 168 "
                  "mismatches have off-pool activity. Circular arb applied per swap: "
                  "2 round-tripper fee recipients excluded, not the 2,135 transactions "
                  "the raw rule matched. Infrastructure excluded at candidate stage."),
}
json.dump({"rows":rows,"clusters":clusters,"token":tok}, open(S+"/ai_load.json","w"))
print(f"\nwrote ai_load.json  rows {len(rows):,}  clusters {len(clusters):,}  "
      f"({os.path.getsize(S+'/ai_load.json')/1024:.0f} KB)")
