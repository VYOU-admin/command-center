#!/usr/bin/env python3
"""
AI/NVDA swaps in the window, plus the AI supply curve.

SUPPLY IS RECONCILED, NOT READ. totalSupply() is read at the first and boundary
blocks via archive, AND every mint/burn Transfer inside the window is pulled.
The two must agree: start + mints - burns == end. A single totalSupply() read
was challenged on PONS for exactly this reason, so the read is the anchor and
the events are the proof.
"""
import json, os, time, requests
from dotenv import load_dotenv
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv('.env')
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
PUB = "https://rpc.mainnet.chain.robinhood.com"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
PID = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
AI = "0x2e8c31162b855a2ffa90f6f8634643ad6f111e18"
Z32 = "0x" + "0" * 64
DEC = 10 ** 18
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
            if "error" in j:
                if a == tries-1: raise SystemExit(f"{m}: {j['error']}")
                time.sleep(1.0*(a+1)); continue
            return j.get("result")
        except requests.RequestException: time.sleep(min(30,1.5*(a+1)**2))
    raise SystemExit(f"{m} exhausted retries")

def logs(addr, topics, lo, hi, tries=8):
    for a in range(tries):
        try:
            r = requests.post(PUB, json={"jsonrpc":"2.0","id":1,"method":"eth_getLogs",
                "params":[{"fromBlock":hex(lo),"toBlock":hex(hi),"address":addr,"topics":topics}]}, timeout=180)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(min(45,2.5*(a+1)**2)); continue
            j = r.json()
            if "error" in j:
                m = str(j["error"].get("message",""))
                if "Too Many" in m: time.sleep(min(45,2.5*(a+1)**2)); continue
                if ("limit" in m or "timed out" in m) and hi > lo:
                    mid=(lo+hi)//2
                    return logs(addr,topics,lo,mid)+logs(addr,topics,mid+1,hi)
                raise SystemExit(f"getLogs: {m}")
            return j.get("result") or []
        except requests.RequestException: time.sleep(min(45,2.5*(a+1)**2))
    raise SystemExit("getLogs exhausted retries")

w = json.load(open(S+"/ai_window.json"))
lo, hi = w["first_block"], w["boundary_block"]

sw = []; cur = lo; t0 = time.time()
while cur <= hi:
    nx = min(cur+20000, hi)
    sw += logs(PM, [SWAP, PID], cur, nx)
    print(f"  swaps ..{nx:,}  {len(sw):,}  {time.time()-t0:.0f}s", flush=True)
    cur = nx+1
print(f"SWAPS IN WINDOW: {len(sw):,}   unique txs: {len({l['transactionHash'] for l in sw}):,}")
json.dump(sw, open(S+"/ai_swaps.json","w"))

mint = []; burn = []; cur = lo
while cur <= hi:
    nx = min(cur+20000, hi)
    mint += logs(AI, [TRANSFER, Z32], cur, nx)
    burn += logs(AI, [TRANSFER, None, Z32], cur, nx)
    cur = nx+1
mv = sum(int(l["data"],16) for l in mint)/DEC
bv = sum(int(l["data"],16) for l in burn)/DEC
print(f"\nSUPPLY EVENTS IN WINDOW: {len(mint)} mints ({mv:,.4f}), {len(burn)} burns ({bv:,.4f})")
s0 = int(al("eth_call",[{"to":AI,"data":"0x18160ddd"},hex(lo)]),16)/DEC
s1 = int(al("eth_call",[{"to":AI,"data":"0x18160ddd"},hex(hi)]),16)/DEC
print(f"  totalSupply at first block  {lo:,}: {s0:,.4f}")
print(f"  totalSupply at boundary     {hi:,}: {s1:,.4f}")
print(f"  reconciliation: {s0:,.4f} + {mv:,.4f} - {bv:,.4f} = {s0+mv-bv:,.4f}  vs {s1:,.4f}")
ok = abs((s0+mv-bv)-s1) < 1e-6
print(f"  {'AGREES' if ok else '*** DISAGREES by %.6f ***' % ((s0+mv-bv)-s1)}")
json.dump({"supply_first":s0,"supply_last":s1,"mints":len(mint),"burns":len(burn),
           "minted":mv,"burned":bv,"reconciles":ok,
           "events":[[int(l["blockNumber"],16), int(l["data"],16)/DEC, "mint"] for l in mint]+
                    [[int(l["blockNumber"],16), -int(l["data"],16)/DEC, "burn"] for l in burn]},
          open(S+"/ai_supply.json","w"))
