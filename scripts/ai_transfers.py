#!/usr/bin/env python3
"""Every AI Transfer inside the window. Enables the pool-only decode check."""
import json, os, time, requests
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
PUB = "https://rpc.mainnet.chain.robinhood.com"
AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18"
TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
CK = S + "/ai_transfers.jsonl"; ST = S + "/ai_transfers.state"
_l = [0.0]

def raw(lo, hi):
    for a in range(9):
        w = _l[0] + 1.1 - time.time()
        if w > 0: time.sleep(w)
        _l[0] = time.time()
        try:
            r = requests.post(PUB, json={"jsonrpc":"2.0","id":1,"method":"eth_getLogs",
                "params":[{"fromBlock":hex(lo),"toBlock":hex(hi),"address":AI,"topics":[TR]}]}, timeout=180)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(60, 3*(a+1)**2)); continue
            j = r.json()
        except Exception:
            time.sleep(min(60, 3*(a+1)**2)); continue
        if "error" in j:
            m = str(j["error"].get("message",""))
            if "Too Many" in m or "429" in m: time.sleep(min(60, 3*(a+1)**2)); continue
            return None, m
        return j.get("result") or [], None
    return None, "exhausted"

def fetch(lo, hi):
    res, err = raw(lo, hi)
    if err is None: return res
    if hi > lo and ("limit" in err or "timed out" in err or "exceed" in err.lower()):
        mid = (lo+hi)//2; return fetch(lo, mid) + fetch(mid+1, hi)
    raise SystemExit(f"{lo}-{hi}: {err}")

w = json.load(open(S+"/ai_window.json"))
LO, HI = w["first_block"], w["boundary_block"]
done = json.load(open(ST))["r"] if os.path.exists(ST) else []
cov = {tuple(x) for x in done}
ck = open(CK, "a"); lo = LO; tot = 0; t0 = time.time()
while lo <= HI:
    hi = min(lo + 20000, HI)
    if (lo, hi) in cov: lo = hi + 1; continue
    lg = fetch(lo, hi)
    for l in lg:
        if len(l["topics"]) >= 3:
            ck.write(json.dumps([l["topics"][1][-40:].lower(), l["topics"][2][-40:].lower(),
                                 l["data"]]) + "\n")
    tot += len(lg); done.append([lo, hi]); ck.flush()
    json.dump({"r": done}, open(ST, "w"))
    print(f"  ..{hi:,}  +{len(lg):,}  total {tot:,}  {time.time()-t0:.0f}s", flush=True)
    lo = hi + 1
ck.close()
print(f"done: {tot:,} transfers")
