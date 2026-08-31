#!/usr/bin/env python3
"""Receipts for AI in-window transactions. Checkpointed; never defaults a miss."""
import json, os, time, requests
from dotenv import load_dotenv
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv('.env')
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18"
NVDA = "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
CK = S + "/ai_receipts.jsonl"
_l = [0.0]

def post(b):
    for a in range(8):
        w = _l[0] + 0.11 - time.time()
        if w > 0: time.sleep(w)
        _l[0] = time.time()
        try:
            r = requests.post(AL, json=b, timeout=120)
            if r.status_code in (429,500,502,503,504):
                time.sleep(min(30, 1.2*(a+1)**2)); continue
            j = r.json()
            return j if isinstance(j, list) else [j]
        except Exception:
            time.sleep(min(30, 1.2*(a+1)**2))
    return None

sw = json.load(open(S+"/ai_swaps.json"))
txs = sorted({l["transactionHash"] for l in sw})
done = set()
if os.path.exists(CK):
    for line in open(CK):
        try: done.add(json.loads(line)["k"])
        except ValueError: pass
todo = [t for t in txs if t not in done]
print(f"{len(txs):,} txs, {len(done):,} cached, {len(todo):,} to fetch", flush=True)
ck = open(CK, "a"); t0 = time.time(); n = 0; rnd = 0
while todo and rnd < 12:
    rnd += 1; fail = []
    for i in range(0, len(todo), 20):
        ch = todo[i:i+20]
        res = post([{"jsonrpc":"2.0","id":j,"method":"eth_getTransactionReceipt",
                     "params":[h]} for j, h in enumerate(ch)])
        if res is None: fail += ch; continue
        got = set()
        for r in res:
            h = ch[r["id"]]
            v = r.get("result")
            if "error" in r or not v:
                fail.append(h); continue      # retried, never written as empty
            slim = {"from": (v.get("from") or "").lower(),
                    "transfers": [[l["topics"][1][-40:].lower(), l["topics"][2][-40:].lower(),
                                   l["data"], l["address"].lower()]
                                  for l in (v.get("logs") or [])
                                  if l["address"].lower() in (AI, NVDA)
                                  and l["topics"][0].lower() == TRANSFER and len(l["topics"]) >= 3]}
            ck.write(json.dumps({"k": h, "v": slim}) + "\n"); got.add(h); n += 1
        fail += [h for h in ch if h not in got and h not in fail]
        if n and n % 500 == 0:
            ck.flush()
            print(f"  {n}/{len(txs)}  {(time.time()-t0)/60:.1f} min", flush=True)
    todo = sorted(set(fail))
    print(f"  round {rnd}: {n:,} written, retrying {len(todo):,}", flush=True)
    if todo: time.sleep(3)
ck.close()
if todo: raise SystemExit(f"{len(todo)} receipts never resolved -- refusing partial output")
print(f"done: {n} fetched, {(time.time()-t0)/60:.1f} min")
