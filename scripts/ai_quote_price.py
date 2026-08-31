#!/usr/bin/env python3
"""
NVDA/USD across the AI window, from the chosen reference pool.

Direct USD: NVDA/USDG, a Uniswap V3 pool that predates the window by 2.1 days.
USDG is Global Dollar, a USD stablecoin, so no ETH hop is needed. Its decimals
are READ from the contract -- stablecoins are exactly where assuming 18 breaks,
since USDC and USDT use 6.

Token ordering is CONFIRMED by calling token0()/token1() on the pool rather than
inferred from address sort order.
"""
import json, os, time, statistics, requests
from dotenv import load_dotenv
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
PUB = "https://rpc.mainnet.chain.robinhood.com"
POOL = "0xb944cec30bd4175855215d767adc81f39e5f7e2b"
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"
i256 = lambda h: (lambda v: v - (1 << 256) if v >= (1 << 255) else v)(int(h, 16))
_l = [0.0]

def al(m, p, tries=8):
    for a in range(tries):
        w = _l[0] + 0.3 - time.time()
        if w > 0: time.sleep(w)
        _l[0] = time.time()
        try:
            r = requests.post(AL, json={"jsonrpc":"2.0","id":1,"method":m,"params":p}, timeout=90)
            if r.status_code in (429,500,502,503,504): time.sleep(min(30,1.5*(a+1)**2)); continue
            j = r.json()
            if "error" in j: time.sleep(1.0*(a+1)); continue
            return j.get("result")
        except Exception: time.sleep(min(30,1.5*(a+1)**2))
    raise SystemExit(f"{m} exhausted retries")

def logs(lo, hi, tries=8):
    for a in range(tries):
        try:
            r = requests.post(PUB, json={"jsonrpc":"2.0","id":1,"method":"eth_getLogs",
                "params":[{"fromBlock":hex(lo),"toBlock":hex(hi),"address":POOL,"topics":[SWAP_V3]}]}, timeout=180)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(45,2.5*(a+1)**2)); continue
            j = r.json()
            if "error" in j:
                m = str(j["error"].get("message",""))
                if "Too Many" in m: time.sleep(min(45,2.5*(a+1)**2)); continue
                if ("limit" in m or "timed out" in m) and hi > lo:
                    mid=(lo+hi)//2; return logs(lo,mid)+logs(mid+1,hi)
                raise SystemExit(f"getLogs: {m}")
            return j.get("result") or []
        except requests.RequestException: time.sleep(min(45,2.5*(a+1)**2))
    raise SystemExit("getLogs exhausted retries")

w = json.load(open(S + "/ai_window.json"))
t0v = al("eth_call", [{"to": POOL, "data": "0x0dfe1681"}, "latest"])   # token0()
t1v = al("eth_call", [{"to": POOL, "data": "0xd21220a7"}, "latest"])   # token1()
tok0 = "0x" + t0v[-40:]; tok1 = "0x" + t1v[-40:]
d0 = int(al("eth_call", [{"to": tok0, "data": "0x313ce567"}, "latest"]), 16)
d1 = int(al("eth_call", [{"to": tok1, "data": "0x313ce567"}, "latest"]), 16)
print(f"pool token0 {tok0} decimals {d0}")
print(f"pool token1 {tok1} decimals {d1}")
nvda_is_1 = tok1 == NVDA
print(f"NVDA is token{'1' if nvda_is_1 else '0'}; stablecoin decimals "
      f"{d0 if nvda_is_1 else d1}  (READ, not assumed)")

lo, hi = w["first_block"] - 30000, w["boundary_block"] + 30000   # +-~50 min of margin
got = []; cur = lo; t0 = time.time()
while cur <= hi:
    nx = min(cur + 20000, hi)
    got += logs(cur, nx)
    print(f"  ..{nx:,}  {len(got):,} ref swaps  {time.time()-t0:.0f}s", flush=True)
    cur = nx + 1
print(f"reference swaps pulled: {len(got):,}")

blocks = sorted({int(l["blockNumber"], 16) for l in got})
bt = {}
for i in range(0, len(blocks), 20):
    ch = blocks[i:i+20]
    res = al("eth_getBlockByNumber", [hex(ch[0]), False]) if len(ch) == 1 else None
    for b in ch:
        r = al("eth_getBlockByNumber", [hex(b), False])
        if not r or not r.get("timestamp"): raise SystemExit(f"no ts for {b}")
        bt[b] = int(r["timestamp"], 16)
pts = []
for l in got:
    d = l["data"][2:]
    a0 = i256(d[0:64]); a1 = i256(d[64:128])
    if a0 == 0 or a1 == 0: continue
    nv = abs(a1) / 10**d1 if nvda_is_1 else abs(a0) / 10**d0
    st = abs(a0) / 10**d0 if nvda_is_1 else abs(a1) / 10**d1
    if nv <= 0: continue
    pts.append((bt[int(l["blockNumber"], 16)], st / nv))
pts.sort()
print(f"priced points: {len(pts):,}")
inw = [(t, p) for t, p in pts if w["first_ts"] <= t <= w["end_ts"]]
print(f"  inside the window: {len(inw):,}")
hours = {}
for t, p in pts: hours.setdefault(t // 3600, []).append(p)
cov = sum(1 for h in range((w["first_ts"]//3600), (w["end_ts"]//3600)+1) if h in hours)
need = (w["end_ts"]//3600) - (w["first_ts"]//3600) + 1
print(f"  hourly coverage inside window: {cov}/{need} hours")
series = sorted((h*3600+1800, statistics.median(v)) for h, v in hours.items())
json.dump({"pool": POOL, "counter": "USDG", "counter_decimals": d0 if nvda_is_1 else d1,
           "points": pts, "series": series}, open(S + "/ai_quote_series.json", "w"))
vals = [p for t, p in inw] or [p for t, p in pts]
print(f"\nNVDA/USD across the window: min ${min(vals):,.4f}  max ${max(vals):,.4f}  "
      f"median ${statistics.median(vals):,.4f}")
print(f"  spread {100*(max(vals)-min(vals))/statistics.mean(vals):.2f}%")
