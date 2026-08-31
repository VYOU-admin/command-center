#!/usr/bin/env python3
"""Receipts for PONS in-window transactions, via Alchemy. Checkpointed."""
import json, os, re, sys, time, requests
from dotenv import load_dotenv
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S=("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
   "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv(os.path.join(ROOT,".env"))
KEY=os.environ["ALCHEMY_API_KEY"].strip()
AL=f"https://robinhood-mainnet.g.alchemy.com/v2/{KEY}"
scrub=lambda s: re.sub(re.escape(KEY),"<KEY>",str(s))
TOKEN="0x39dbed3a2bd333467115de45665cc57f813c4571"
WETH="0x0bd7d308f8e1639fab988df18a8011f41eacad73"
TRANSFER="0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
CK=os.path.join(S,"pons_receipts.jsonl")
calls=0
def al(m,p,tries=5):
    global calls
    for a in range(tries):
        calls+=1
        try:
            r=requests.post(AL,json={"jsonrpc":"2.0","id":1,"method":m,"params":p},timeout=60)
            if r.status_code==429 or r.status_code>=500:
                time.sleep(1.2*(a+1)); continue
            j=r.json()
        except Exception:
            time.sleep(1.2*(a+1)); continue
        if "error" in j: return None
        return j.get("result")
    return None
def main():
    sw=json.load(open(os.path.join(S,"pons_window_swaps.json")))
    txs=sorted({l["transactionHash"] for l in sw})
    done=set()
    if os.path.exists(CK):
        for line in open(CK):
            try: done.add(json.loads(line)["k"])
            except ValueError: pass
        print(f"resuming: {len(done)} receipts cached",flush=True)
    todo=[t for t in txs if t not in done]
    print(f"{len(txs)} in-window transactions, {len(todo)} to fetch",flush=True)
    t0=time.time()
    with open(CK,"a") as ck:
        for i,h in enumerate(todo,1):
            r=al("eth_getTransactionReceipt",[h])
            # keep only what attribution needs: PONS and WETH transfer legs, from
            slim={"from":(r or {}).get("from","").lower(),
                  "transfers":[[l["topics"][1][-40:].lower(),l["topics"][2][-40:].lower(),
                                l["data"],l["address"].lower()]
                               for l in ((r or {}).get("logs") or [])
                               if l["address"].lower() in (TOKEN,WETH)
                               and l["topics"][0].lower()==TRANSFER and len(l["topics"])>=3]}
            ck.write(json.dumps({"k":h,"v":slim})+"\n")
            if i%500==0:
                ck.flush(); el=time.time()-t0
                print(f"  {i}/{len(todo)}  {calls} calls  {el/60:.1f} min  ({i/el:.1f}/s)",flush=True)
    print(f"done: {calls} calls, {(time.time()-t0)/60:.1f} min",flush=True)
if __name__=="__main__": main()
