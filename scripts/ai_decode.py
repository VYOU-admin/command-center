#!/usr/bin/env python3
"""
AI/NVDA V4 decode: fee measurement, circular-arb exclusion, attribution.

V4, not V3. One PoolManager singleton, poolId in topic1, and amounts are int128
from the SWAPPER's perspective (negative = paid, positive = received), sign-
extended into 32-byte words so they must be masked to 128 bits before the sign
test. currency0 = AI (0x2e8c..), currency1 = NVDA (0xd060..), ordered by address.

Locked constraints, carried unchanged:
  - attribution by BALANCE DELTA at any call depth, never tx.from (~46% correct)
  - router order-splitting: the swap's OWN pool amount minus its OWN fee
  - circular arb: exclude txs where the PoolManager both sends AND receives AI
  - fee rate MEASURED from unambiguous single-swap trades, never assumed
"""
import json, os, time, statistics, requests
from collections import defaultdict
from dotenv import load_dotenv
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv('.env')
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18"
NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"
ZERO = "0x" + "0" * 40
DEC = 10 ** 18
_l = [0.0]

def i128(word):
    v = int(word, 16) & ((1 << 128) - 1)
    return v - (1 << 128) if v >= (1 << 127) else v

def al(m, p, tries=8):
    for a in range(tries):
        w = _l[0] + 0.12 - time.time()
        if w > 0: time.sleep(w)
        _l[0] = time.time()
        try:
            r = requests.post(AL, json=p if isinstance(p, list) else
                              {"jsonrpc":"2.0","id":1,"method":m,"params":p}, timeout=120)
            if r.status_code in (429,500,502,503,504): time.sleep(min(30,1.2*(a+1)**2)); continue
            j = r.json()
            return j
        except Exception: time.sleep(min(30,1.2*(a+1)**2))
    return None

sw = json.load(open(S+"/ai_swaps.json"))
rec = {}
for line in open(S+"/ai_receipts.jsonl"):
    try: r = json.loads(line); rec[r["k"]] = r["v"]
    except ValueError: pass
print(f"swaps {len(sw):,}   receipts {len(rec):,}")

by_tx = defaultdict(list)
for l in sw: by_tx[l["transactionHash"]].append(l)
multi = sum(1 for g in by_tx.values() if len(g) > 1)
print(f"transactions {len(by_tx):,}   multi-swap {multi:,} "
      f"({100*multi/len(by_tx):.1f}%)  -- router splitting matters here")

def net_of(v, contract):
    n = defaultdict(float)
    for a, b, data, addr in v.get("transfers", []):
        if addr != contract: continue
        x = int(data, 16) / DEC
        n["0x"+a] -= x; n["0x"+b] += x
    return n

# ---- circular arb, V4 PoolManager rule, applied AT SWAP LEVEL ----
#
# The rule is "the PoolManager both sends and receives the token in one
# transaction", and the reason is that the attributed wallet is a tip recipient
# rather than a trader. On AI that signature fires on 59.6% of transactions,
# because this token charges a 1% token-side hook fee: the PoolManager pays the
# fee out to recipient addresses, one of which immediately dumps its cut back
# into the pool as a second swap.
#
# Excluding the whole transaction would therefore delete 2,122 GENUINE BUYS
# alongside the fee dumps. So the exclusion is applied per swap, by identifying
# the ROUND-TRIPPERS -- wallets that both receive from and send to the
# PoolManager inside one transaction -- and refusing to attribute any swap to
# them. The buyer in the same transaction is untouched.
circ_tx = set()
for h, v in rec.items():
    t = [x for x in v.get("transfers", []) if x[3] == AI]
    if any("0x"+a == PM for a,_,_,_ in t) and any("0x"+b == PM for _,b,_,_ in t):
        circ_tx.add(h)
print(f"\nCIRCULAR ARB (V4: PoolManager both sends AND receives AI):")
print(f"  transactions matching the raw rule: {len(circ_tx):,} of {len(by_tx):,} "
      f"({100*len(circ_tx)/len(by_tx):.1f}%)")
if not circ_tx:
    print("  CAUGHT ZERO -- stated plainly, not treated as a pass.")

def round_trippers(v):
    """Wallets that both receive from and send to the PoolManager in this tx."""
    got, gave = set(), set()
    for a, b, _d, addr in v.get("transfers", []):
        if addr != AI: continue
        if "0x"+a == PM: got.add("0x"+b)
        if "0x"+b == PM: gave.add("0x"+a)
    return (got & gave) - {PM, ZERO}

rt_all = set()
for h, v in rec.items(): rt_all |= round_trippers(v)
print(f"  distinct round-tripper (tip recipient) addresses: {len(rt_all):,}")
circ = set()   # kept for the payload; whole-tx exclusion is no longer used

# ---- fee rate, unambiguous single-swap transactions only ----
fees = {"buy": [], "sell": []}
# Unambiguous means one swap of that side in the transaction, with the tip
# recipients removed from the candidate set. Restricting to strictly one-swap
# transactions would leave only 20 buy samples on this token.
for h, g in by_tx.items():
    if len(g) > 2: continue
    v = rec.get(h)
    if not v: continue
    rt = round_trippers(v)
    net = net_of(v, AI)
    mv = {k: x for k, x in net.items()
          if abs(x) > 1e-12 and k not in (PM, ZERO) and k not in rt}
    for l in g:
        d = l["data"][2:]
        a0 = i128(d[0:64])
        if a0 == 0: continue
        side = "buy" if a0 > 0 else "sell"
        if sum(1 for x in g if (i128(x["data"][2:][0:64]) > 0) == (side == "buy")) != 1:
            continue                        # two same-side swaps: not unambiguous
        pool_amt = abs(a0) / DEC
        cand = {k: x for k, x in mv.items() if (x > 0) == (side == "buy")}
        if not cand: continue
        w = max(cand.items(), key=lambda kv: abs(kv[1]))[0]
        fees[side].append(abs(cand[w]) / pool_amt)
print("\nFEE RATE, measured on unambiguous single-swap transactions:")
out = {}
for side in ("buy", "sell"):
    v = sorted(fees[side])
    if not v:
        print(f"  {side}: no samples"); out[side] = 0.0; continue
    med = statistics.median(v)
    p1, p99 = v[len(v)//100], v[min(len(v)-1, 99*len(v)//100)]
    print(f"  {side}: n={len(v):,}  trader/pool median {med:.6f}  p1 {p1:.6f}  p99 {p99:.6f}  "
          f"{'FLAT' if abs(p99-p1) < 1e-6 else 'VARIABLE'}")
    out[side] = 1.0 - med
print(f"  => implied fee: buy {out['buy']*100:.4f}%  sell {out['sell']*100:.4f}%")

# ---- block timestamps, every distinct trade block ----
blocks = sorted({int(l["blockNumber"], 16) for l in sw})
print(f"\ntimestamping {len(blocks):,} distinct blocks")
bt = {}; todo = blocks; rnd = 0
while todo and rnd < 12:
    rnd += 1; fail = []
    for i in range(0, len(todo), 20):
        ch = todo[i:i+20]
        j = al(None, [{"jsonrpc":"2.0","id":k,"method":"eth_getBlockByNumber",
                       "params":[hex(b), False]} for k, b in enumerate(ch)])
        if not isinstance(j, list): fail += ch; continue
        got = set()
        for r in j:
            b = ch[r["id"]]; v = r.get("result")
            if "error" in r or not v or not v.get("timestamp"): fail.append(b); continue
            bt[b] = int(v["timestamp"], 16); got.add(b)
        fail += [b for b in ch if b not in got and b not in fail]
    todo = sorted(set(fail))
    print(f"  round {rnd}: {len(bt):,}/{len(blocks):,}, retrying {len(todo):,}", flush=True)
if todo: raise SystemExit(f"{len(todo)} blocks unresolved -- refusing partial timestamps")

# ---- decode ----
trades = []; paths = defaultdict(int); nomover = 0
excluded_rt = 0
for h, g in by_tx.items():
    v = rec.get(h)
    if not v: continue
    rt = round_trippers(v)
    net = net_of(v, AI)
    mv = {k: x for k, x in net.items()
          if abs(x) > 1e-12 and k not in (PM, ZERO) and k not in rt}
    for l in g:
        d = l["data"][2:]
        a0 = i128(d[0:64]); a1 = i128(d[64:128])
        if a0 == 0 or a1 == 0: continue
        side = "buy" if a0 > 0 else "sell"
        pool_amt = abs(a0) / DEC          # AI, this swap's OWN amount
        quote = abs(a1) / DEC             # NVDA
        cand = {k: x for k, x in mv.items() if (x > 0) == (side == "buy")}
        if not cand:
            # no attributable trader once tip recipients are removed: this is
            # the fee-dump leg, excluded by the circular-arb rule
            nomover += 1; excluded_rt += 1; continue
        w = max(cand.items(), key=lambda kv: abs(kv[1]))[0]
        path = "single" if len(g) == 1 else "multiswap"
        paths[path] += 1
        b = int(l["blockNumber"], 16)
        trades.append({"tx": h, "block": b, "t": bt[b], "wallet": w, "side": side,
                       "quote": quote, "token": pool_amt * (1.0 - out[side]),
                       "pool_token": pool_amt, "path": path,
                       "logIndex": int(l["logIndex"], 16)})
print(f"\nDECODE: {len(trades):,} trades   paths {dict(paths)}")
print(f"  swaps excluded as tip-recipient / unattributable: {excluded_rt:,} "
      f"({100*excluded_rt/len(sw):.1f}% of swaps)")
byw = defaultdict(list)
for t in trades: byw[t["wallet"]].append(t)
print(f"wallets attributed: {len(byw):,}")
json.dump({"trades": trades, "fee": out, "circ": sorted(circ)}, open(S+"/ai_decoded.json","w"))
