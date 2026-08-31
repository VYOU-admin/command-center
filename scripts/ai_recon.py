#!/usr/bin/env python3
"""AI (Artificial Inu) recon: resolve the V4 poolId to its currency pair.

Constants are never recalled from memory. The Swap topic0 is taken from the
working NTF indexer; the pair is resolved from DexScreener and then confirmed
against on-chain reads, because a fabricated constant that matches nothing has
already cost this project a full investigation.
"""
import json, os, sys, time, requests
from dotenv import load_dotenv
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
PUB = "https://rpc.mainnet.chain.robinhood.com"
TOKEN = "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18".lower()
PID = "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"

def call(to, data, tag="latest"):
    r = requests.post(AL, json={"jsonrpc": "2.0", "id": 1, "method": "eth_call",
        "params": [{"to": to, "data": data}, tag]}, timeout=60).json()
    if "error" in r: return None
    return r.get("result")

def dec_str(hexv):
    if not hexv or hexv == "0x": return None
    b = bytes.fromhex(hexv[2:])
    if len(b) >= 64:                      # dynamic string
        n = int.from_bytes(b[32:64], "big")
        return b[64:64 + n].decode("utf-8", "replace").strip("\x00") or None
    return b.decode("utf-8", "replace").strip("\x00") or None

def meta(addr):
    return {"address": addr,
            "symbol": dec_str(call(addr, "0x95d89b41")),
            "name": dec_str(call(addr, "0x06fdde03")),
            "decimals": int(call(addr, "0x313ce567") or "0x0", 16),
            "total_supply_read": int(call(addr, "0x18160ddd") or "0x0", 16)}

print("== DexScreener")
r = requests.get(f"https://api.dexscreener.com/token-pairs/v1/robinhood/{TOKEN}", timeout=60)
pairs = r.json() if r.status_code == 200 else []
print(f"  {len(pairs)} pairs returned for the AI token")
match = None
for p in pairs:
    pa = str(p.get("pairAddress", "")).lower()
    bs = (p.get("baseToken") or {}).get("symbol"); qs = (p.get("quoteToken") or {}).get("symbol")
    hit = pa == PID.lower()
    print(f"  {'>>' if hit else '  '} {pa[:24]}..  {bs}/{qs}  "
          f"liq ${(p.get('liquidity') or {}).get('usd', 0):,.0f}  created {p.get('pairCreatedAt')}")
    if hit: match = p
if not match:
    print("  !! supplied poolId not among DexScreener pairs -- resolving on-chain only")
else:
    print(f"\n  matched pair: base {(match.get('baseToken') or {}).get('address')} "
          f"quote {(match.get('quoteToken') or {}).get('address')}")
    print(f"  dex {match.get('dexId')} labels {match.get('labels')} created {match.get('pairCreatedAt')}")
    json.dump(match, open(S + "/ai_pair.json", "w"))

print("\n== on-chain token metadata (decimals READ, never assumed)")
base = meta(TOKEN)
print(f"  AI    {base}")
q = None
if match:
    qa = str((match.get("quoteToken") or {}).get("address", "")).lower()
    if qa:
        q = meta(qa); print(f"  QUOTE {q}")
json.dump({"base": base, "quote": q}, open(S + "/ai_tokens.json", "w"))
