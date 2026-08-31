#!/usr/bin/env python3
"""Real timestamps for every block a PONS trade landed in. Never defaults a miss."""
import json, os, time, requests
from dotenv import load_dotenv
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
BATCH, _last = 20, [0.0]

def post(b):
    for a in range(8):
        w = _last[0] + 0.35 - time.time()
        if w > 0: time.sleep(w)
        _last[0] = time.time()
        try:
            r = requests.post(AL, json=b, timeout=120)
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(min(30, 1.5 * (a + 1) ** 2)); continue
            j = r.json(); return j if isinstance(j, list) else [j]
        except Exception:
            time.sleep(min(30, 1.5 * (a + 1) ** 2))
    return None

trades = json.load(open(S + "/pons_decoded.json"))["trades"]
blocks = sorted({t["block"] for t in trades})
print(f"{len(blocks):,} distinct blocks to timestamp")
out, todo, rnd = {}, blocks, 0
while todo and rnd < 12:
    rnd += 1; fail = []
    for i in range(0, len(todo), BATCH):
        ch = todo[i:i + BATCH]
        res = post([{"jsonrpc": "2.0", "id": j, "method": "eth_getBlockByNumber",
                     "params": [hex(b), False]} for j, b in enumerate(ch)])
        if res is None: fail += ch; continue
        got = set()
        for r in res:
            b = ch[r["id"]]
            v = r.get("result")
            if "error" in r or not v or not v.get("timestamp"):
                fail.append(b); continue
            out[b] = int(v["timestamp"], 16); got.add(b)
        fail += [b for b in ch if b not in got and b not in fail]
    todo = sorted(set(fail))
    print(f"  round {rnd}: {len(out):,}/{len(blocks):,} resolved, retrying {len(todo):,}", flush=True)
    if todo: time.sleep(3)
if todo:
    raise SystemExit(f"{len(todo)} blocks unresolved -- refusing to emit partial timestamps")
json.dump(out, open(S + "/pons_blocktimes.json", "w"))
lo, hi = min(out.values()), max(out.values())
print(f"span {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(lo))} .. "
      f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(hi))}  ({(hi-lo)/3600:.2f} h)")
