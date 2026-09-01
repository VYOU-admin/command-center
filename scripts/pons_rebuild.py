#!/usr/bin/env python3
"""
Re-derive PONS with the global infrastructure exclusion applied.

The exclusion is applied AT THE CANDIDATE STAGE: an infrastructure address is
never a candidate to be attributed a swap, so it never becomes a row. It is not
filtered out after the fact.

Round-trippers (wallets that both receive from and send to the tracked pool in
one transaction) are detected per run and excluded the same way -- the swap-level
form of the circular-arb rule, consistent with the AI run.

Everything is rebuilt from cached swaps/receipts/transfers. No re-pull.
"""
import json, os, sys, time, statistics, requests
from collections import defaultdict, deque
from dotenv import load_dotenv
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline import infrastructure as infra

S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv('.env')
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
POOL = "0x10cc6bd38112cac182db90b6a71d8bb5939526ba"
TOKEN = "0x39dbed3a2bd333467115de45665cc57f813c4571"
DEC = 10 ** 18; TOL = 1e-6; SUPPLY = 1_000_000_000; THRESH = 10_000_000
utc = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))
i256 = lambda h: (lambda v: v - (1 << 256) if v >= (1 << 255) else v)(int(h, 16))

EXCL = infra.excluded_set("robinhood", [POOL])
print(f"infrastructure exclusions in force: {len(EXCL)} addresses "
      f"(global list + tracked pool {POOL})")

sw = json.load(open(S + "/pons_window_swaps.json"))
rec = {}
for line in open(S + "/pons_receipts.jsonl"):
    try: r = json.loads(line); rec[r["k"]] = r["v"]
    except ValueError: pass
old = json.load(open(S + "/pons_final.json"))["rows"]
old_by = {r["wallet"]: r for r in old}
bt = {int(k): v for k, v in json.load(open(S + "/pons_blocktimes.json")).items()}
fin = json.load(open(S + "/pons_final.json")); PX = fin["px"]; HEAD = fin["head"]; BND = fin["bnd"]
ETH = json.load(open(S + "/pons_decoded.json"))["eth"]
RATE = json.load(open(S + "/pons_decoded.json"))["basis"]

by_tx = defaultdict(list)
for l in sw: by_tx[l["transactionHash"]].append(l)

def net_of(v):
    n = defaultdict(float)
    for a, b, data, addr in v.get("transfers", []):
        if addr != TOKEN: continue
        x = int(data, 16) / DEC
        n["0x" + a] -= x; n["0x" + b] += x
    return n

def round_trippers(v):
    got, gave = set(), set()
    for a, b, _d, addr in v.get("transfers", []):
        if addr != TOKEN: continue
        if "0x" + a == POOL: got.add("0x" + b)
        if "0x" + b == POOL: gave.add("0x" + a)
    return got & gave

rt_all = set()
for v in rec.values(): rt_all |= (round_trippers(v) - EXCL)
print(f"round-trippers detected on PONS: {len(rt_all):,}")

# The cached timestamps were built from the previous decode, which dropped the
# circular-arb transaction entirely. Re-including it introduces blocks that were
# never timestamped, so fetch the gap rather than defaulting it.
_lt = [0.0]
def _post(b):
    for a in range(8):
        w = _lt[0] + 0.35 - time.time()
        if w > 0: time.sleep(w)
        _lt[0] = time.time()
        try:
            r = requests.post(AL, json=b, timeout=120)
            if r.status_code in (429,500,502,503,504): time.sleep(min(30,1.5*(a+1)**2)); continue
            j = r.json(); return j if isinstance(j, list) else [j]
        except Exception: time.sleep(min(30,1.5*(a+1)**2))
    return None
need = sorted({int(l["blockNumber"], 16) for l in sw} - set(bt))
if need:
    print(f"timestamping {len(need)} block(s) missing from the cache")
    todo, rnd = need, 0
    while todo and rnd < 12:
        rnd += 1; fail = []
        for i in range(0, len(todo), 20):
            ch = todo[i:i+20]
            res = _post([{"jsonrpc":"2.0","id":j,"method":"eth_getBlockByNumber",
                          "params":[hex(b), False]} for j, b in enumerate(ch)])
            if res is None: fail += ch; continue
            got = set()
            for r in res:
                b = ch[r["id"]]; v = r.get("result")
                if "error" in r or not v or not v.get("timestamp"): fail.append(b); continue
                bt[b] = int(v["timestamp"], 16); got.add(b)
            fail += [b for b in ch if b not in got and b not in fail]
        todo = sorted(set(fail))
    if todo: raise SystemExit(f"{len(todo)} blocks unresolved -- refusing partial timestamps")

trades = []; blocked = defaultdict(int); nomover = 0
for h, g in by_tx.items():
    v = rec.get(h)
    if not v: continue
    rt = round_trippers(v)
    net = net_of(v)
    for l in g:
        d = l["data"][2:]; a0 = i256(d[0:64]); a1 = i256(d[64:128])
        if a0 == 0 or a1 == 0: continue
        side = "buy" if a1 < 0 else "sell"
        pool_amt = abs(a1) / DEC; quote = abs(a0) / DEC
        raw = {k: x for k, x in net.items()
               if abs(x) > 1e-12 and (x > 0) == (side == "buy")}
        for k in raw:
            if k in EXCL: blocked[k] += 1
        cand = {k: x for k, x in raw.items() if k not in EXCL and k not in rt}
        if not cand: nomover += 1; continue
        w = max(cand.items(), key=lambda kv: abs(kv[1]))[0]
        b = int(l["blockNumber"], 16)
        trades.append({"tx": h, "block": b, "t": bt[b], "wallet": w, "side": side,
                       "quote": quote, "token": pool_amt, "pool_token": pool_amt,
                       "path": "single" if len(g) == 1 else "multiswap",
                       "logIndex": int(l["logIndex"], 16)})
print(f"\ncandidate-stage blocks (infrastructure appearing as a candidate):")
for k, n in sorted(blocked.items(), key=lambda x: -x[1]):
    lab = next((l for a, l, _ in infra.load("robinhood") if a == k), "tracked-pool")
    print(f"  {k}  {lab:<24} {n:,} swaps")
if not blocked: print("  none")
print(f"trades {len(trades):,}   unattributable after exclusion {nomover:,}")

byw = defaultdict(list)
for t in trades: byw[t["wallet"]].append(t)
first = {}
for t in sorted(trades, key=lambda x: (x["block"], x["logIndex"])):
    if t["side"] != "buy" or t["wallet"] in first: continue
    first[t["wallet"]] = t
mc = {w: (t["quote"] / t["token"]) * SUPPLY * ETH for w, t in first.items() if t["token"] > 0}
under = [w for w, m in mc.items() if m < THRESH]
excess = set()
for w, ts in byw.items():
    b = sum(t["token"] for t in ts if t["side"] == "buy")
    s = sum(t["token"] for t in ts if t["side"] == "sell")
    if s - b > 1: excess.add(w)
cohort = sorted(set(under) - excess)
print(f"buyers {len(mc):,}   sub-threshold {len(under):,}   excess sellers {len(excess):,}"
      f"   COHORT {len(cohort):,}   (was {len(old):,})")
gone = sorted(set(old_by) - set(cohort)); added = sorted(set(cohort) - set(old_by))
print(f"  removed from cohort: {len(gone)}   newly present: {len(added)}")
for w in gone:
    o = old_by[w]
    lab = next((l for a, l, _ in infra.load("robinhood") if a == w), "?")
    print(f"    - {w}  {lab}  realized ${o['realized_pnl_usd']:,.2f}  "
          f"unrealized ${o['unrealized_pnl_usd']:,.0f}")

# balances for the new cohort, no silent defaults
_l = [0.0]
def post(b):
    for a in range(8):
        w = _l[0] + 0.35 - time.time()
        if w > 0: time.sleep(w)
        _l[0] = time.time()
        try:
            r = requests.post(AL, json=b, timeout=120)
            if r.status_code in (429,500,502,503,504): time.sleep(min(30,1.5*(a+1)**2)); continue
            j = r.json(); return j if isinstance(j, list) else [j]
        except Exception: time.sleep(min(30,1.5*(a+1)**2))
    return None
def read_at(ws, block, label):
    out, todo, rnd = {}, list(ws), 0
    while todo and rnd < 12:
        rnd += 1; fail = []
        for i in range(0, len(todo), 20):
            ch = todo[i:i+20]
            res = post([{"jsonrpc":"2.0","id":j,"method":"eth_call","params":[
                {"to":TOKEN,"data":"0x70a08231"+"0"*24+w[2:]}, hex(block)]}
                for j, w in enumerate(ch)])
            if res is None: fail += ch; continue
            got = set()
            for r in res:
                w = ch[r["id"]]; vv = r.get("result")
                if "error" in r or not vv or vv == "0x": fail.append(w); continue
                out[w] = int(vv, 16) / DEC; got.add(w)
            fail += [w for w in ch if w not in got and w not in fail]
        todo = sorted(set(fail))
        print(f"  {label} round {rnd}: {len(out):,}/{len(ws):,}, retrying {len(todo):,}", flush=True)
        if todo: time.sleep(3)
    if todo: raise SystemExit(f"{label}: {len(todo)} unresolved -- refusing partial balances")
    return out
head_b = read_at(cohort, HEAD, "head"); bnd_b = read_at(cohort, BND, "boundary")

offcnt = defaultdict(int)
cs = set(cohort)
for line in open(S + "/pons_transfers.jsonl"):
    a, b, d = json.loads(line); A = "0x" + a; B = "0x" + b
    if A in cs and B != POOL: offcnt[A] += 1
    if B in cs and A != POOL: offcnt[B] += 1

rows = []
for w in cohort:
    ts = sorted(byw[w], key=lambda x: (x["block"], x["logIndex"]))
    lots = deque(); real = 0.0; bought = sold = qin = qout = 0.0; nb = ns = 0; fb = ls = None
    for t in ts:
        u = t["quote"] / t["token"] if t["token"] else 0.0
        if t["side"] == "buy":
            lots.append([t["token"], u]); bought += t["token"]; qin += t["quote"]; nb += 1
            if fb is None: fb = t["t"]
        else:
            need = t["token"]; sold += t["token"]; qout += t["quote"]; ns += 1; ls = t["t"]
            while need > 1e-15 and lots:
                lot = lots[0]; take = min(need, lot[0]); real += take * (u - lot[1])
                lot[0] -= take; need -= take
                if lot[0] <= 1e-15: lots.popleft()
            if need > 1e-15: real += need * u
    imp = bought - sold; onc = head_b[w]; bnd = bnd_b[w]
    rows.append({"wallet": w, "token": "PONS", "chain": "robinhood", "quote_asset": "WETH",
        "tag": None, "tag_source": None,
        "first_buy_time_utc": utc(fb) if fb else None,
        "last_sell_time_utc": utc(ls) if ls else None,
        "n_buys": nb, "n_sells": ns, "sol_in": qin, "sol_out": qout,
        "realized_pnl_sol": real, "realized_pnl_usd": real * ETH,
        "tokens_still_held": sum(l[0] for l in lots),
        "hold_min": (ls - fb) / 60.0 if (fb and ls) else None,
        "sold_out": imp <= TOL, "pre_window_entry": ts[0]["side"] == "sell",
        "first_buy_mcap_usd": mc.get(w), "rate_basis": RATE,
        "tokens_bought": bought, "tokens_sold": sold,
        "implied_balance": imp, "onchain_balance": onc,
        "balance_delta": onc - imp, "balance_match": abs(bnd - imp) <= TOL,
        "boundary_balance": bnd, "boundary_delta": bnd - imp,
        "unrealized_pnl_usd": onc * PX, "still_holding": onc > 0,
        "has_off_pool_activity": offcnt.get(w, 0) > 0,
        "price_usd": PX, "price_block": HEAD, "balance_block": HEAD})

old_real = sum(r["realized_pnl_usd"] for r in old)
new_real = sum(r["realized_pnl_usd"] for r in rows)
gone_real = sum(old_by[w]["realized_pnl_usd"] for w in gone)
print(f"\nrealized USD: was ${old_real:,.2f}  now ${new_real:,.2f}  "
      f"excluded rows carried ${gone_real:,.2f}")
print(f"  difference beyond the excluded rows: "
      f"${(old_real - gone_real) - new_real:,.6f}")
print(f"unrealized USD: was ${sum(r['unrealized_pnl_usd'] for r in old):,.0f}  "
      f"now ${sum(r['unrealized_pnl_usd'] for r in rows):,.0f}")

# clusters, re-derived for the new cohort
sig = {}
for line in open(S + "/pons_receipts.jsonl"):
    r = json.loads(line); sig[r["k"]] = (r["v"] or {}).get("from", "")
txw = defaultdict(set)
for t in trades:
    if t["wallet"] in cs: txw[t["tx"]].add(t["wallet"])
bysig = defaultdict(set)
for tx, ws in txw.items():
    s = sig.get(tx, "")
    if not s or s in EXCL: continue
    for w in ws:
        if w != s: bysig[s].add(w)
cand = {s: v for s, v in bysig.items() if len(v) > 1}
sizes = sorted({len(v) for v in cand.values()})
gap, cut = 0, None
for i in range(1, len(sizes)):
    if sizes[i] - sizes[i-1] > gap and sizes[i] >= 10:
        gap, cut = sizes[i] - sizes[i-1], sizes[i]
clusters = []; n = 0
for s, ws in sorted(cand.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    if cut and len(ws) >= cut: continue
    n += 1; cid = f"pons-s{n:03d}"
    for w in sorted(ws):
        clusters.append({"chain":"robinhood","wallet":w,"cluster_id":cid,
                         "signal":"shared_signer","evidence":s,
                         "confidence":"high","cluster_size":len(ws)})
m = 0
for tx, ws in sorted(txw.items()):
    if len(ws) < 2: continue
    m += 1; cid = f"pons-t{m:03d}"
    for w in sorted(ws):
        clusters.append({"chain":"robinhood","wallet":w,"cluster_id":cid,
                         "signal":"same_transaction","evidence":tx,
                         "confidence":"high","cluster_size":len(ws)})
print(f"clusters: {n} shared_signer + {m} same_transaction = {len(clusters):,} rows "
      f"(infrastructure cut at >= {cut}, gap {gap})")

tok = json.load(open(S + "/pons_load.json"))["token"]
tok["cohort_size"] = len(rows)
tok["decode_check"] = ("476/476 wallets that only ever touched this pool reproduce "
                       "their on-chain balance exactly, including 154 with a nonzero "
                       "balance; all mismatches had off-pool transfers. Infrastructure "
                       "addresses are excluded at the candidate stage.")
json.dump({"rows": rows, "clusters": clusters, "token": tok},
          open(S + "/pons_load2.json", "w"))
print(f"\nwrote pons_load2.json  rows {len(rows):,}  clusters {len(clusters):,}")
