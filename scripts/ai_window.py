#!/usr/bin/env python3
"""
AI/NVDA window: first swap in the tracked pool, then --window-hours forward.

The boundary block is found by BINARY SEARCH ON ACTUAL BLOCK TIMESTAMPS, never
by interpolating a seconds-per-block rate, which drifts badly across a span this
size. Same rule PONS used.
"""
import json, os, sys, time, requests
from dotenv import load_dotenv
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
PUB = "https://rpc.mainnet.chain.robinhood.com"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
PID = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
WINDOW_HOURS = 4
CREATED = 1784051311
_last = [0.0]

def al(method, params, tries=8):
    for a in range(tries):
        w = _last[0] + 0.3 - time.time()
        if w > 0: time.sleep(w)
        _last[0] = time.time()
        try:
            r = requests.post(AL, json={"jsonrpc": "2.0", "id": 1,
                                        "method": method, "params": params}, timeout=90)
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(min(30, 1.5 * (a + 1) ** 2)); continue
            j = r.json()
            if "error" in j: time.sleep(1.0 * (a + 1)); continue
            return j.get("result")
        except Exception:
            time.sleep(min(30, 1.5 * (a + 1) ** 2))
    raise SystemExit(f"{method} exhausted retries")

def ts_of(b):
    r = al("eth_getBlockByNumber", [hex(b), False])
    if not r or not r.get("timestamp"):
        raise SystemExit(f"no timestamp for block {b}")   # never defaulted
    return int(r["timestamp"], 16)

def find_block(target, lo, hi):
    """Last block with timestamp <= target."""
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if ts_of(mid) <= target: lo = mid
        else: hi = mid - 1
    return lo

def logs(lo, hi, tries=8):
    for a in range(tries):
        try:
            r = requests.post(PUB, json={"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                "params": [{"fromBlock": hex(lo), "toBlock": hex(hi),
                            "address": PM, "topics": [SWAP, PID]}]}, timeout=180)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(45, 2.5 * (a + 1) ** 2)); continue
            j = r.json()
            if "error" in j:
                m = str(j["error"].get("message", ""))
                if "Too Many" in m: time.sleep(min(45, 2.5 * (a + 1) ** 2)); continue
                if ("limit" in m or "timed out" in m) and hi > lo:
                    mid = (lo + hi) // 2
                    return logs(lo, mid) + logs(mid + 1, hi)
                raise SystemExit(f"getLogs {lo}-{hi}: {m}")
            return j.get("result") or []
        except requests.RequestException:
            time.sleep(min(45, 2.5 * (a + 1) ** 2))
    raise SystemExit(f"getLogs {lo}-{hi} exhausted retries")

head = int(al("eth_blockNumber", []), 16)
print(f"head block {head:,}")
create_b = find_block(CREATED, 1, head)
print(f"pool creation ts {CREATED} -> block {create_b:,} "
      f"({time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ts_of(create_b)))})")

# first swap in this pool, scanning forward in widening steps
first = None; lo = max(1, create_b - 50); step = 5000
while lo <= head and first is None:
    hi = min(lo + step, head)
    got = logs(lo, hi)
    if got:
        got.sort(key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))
        first = got[0]
        break
    lo = hi + 1; step = min(step * 2, 100000)
if first is None: raise SystemExit("no swaps found in this pool")
fb = int(first["blockNumber"], 16); ft = ts_of(fb)
print(f"first swap block {fb:,} at {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(ft))}")
end_ts = ft + WINDOW_HOURS * 3600
bnd = find_block(end_ts, fb, head)
print(f"window {WINDOW_HOURS}h ends {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(end_ts))} "
      f"-> boundary block {bnd:,}  (span {bnd-fb:,} blocks)")
json.dump({"head": head, "create_block": create_b, "first_block": fb, "first_ts": ft,
           "end_ts": end_ts, "boundary_block": bnd, "window_hours": WINDOW_HOURS},
          open(S + "/ai_window.json", "w"))
