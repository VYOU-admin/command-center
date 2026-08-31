#!/usr/bin/env python3
"""
NTF stage 2a — is tx.from actually the trader?

WHY THIS EXISTS. The V4 Swap event carries (poolId, sender) and sender is always
a router: measured 20/20 contracts, with tx.from differing every time. The cheap
fix is to call the trader tx.from. That is only correct if one transaction ==
one trader. It breaks for batched or aggregated transactions, where a single
signer swaps on behalf of several people, and it breaks silently — every trade
in the batch is attributed to the batcher.

THE SWAP EVENT HAS NO RECIPIENT FIELD, so tx.from cannot be compared against one
directly. What can be compared is where the TOKENS actually went: the NTF
ERC-20 Transfer logs inside the same transaction. If a transaction moves NTF to
more than one non-router address, or if the receiving address is not tx.from,
then tx.from is not a safe attribution.

Two independent signals are reported:
  1. transactions carrying more than one Swap log for this pool
  2. transactions whose NTF Transfer logs credit/debit more than one
     counterparty, or a counterparty that is not tx.from

Nothing is written. This only decides which decoder to build.
"""
from __future__ import annotations

import json
import os
import re
import time
from collections import Counter, defaultdict

import requests
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
CKPT = os.path.join(DATA, "ntf_swaps.jsonl")

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
TOKEN = "0x27e9d5067596132936427ee311f05b339a50eba6"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SAMPLE = 200

load_dotenv(os.path.join(ROOT, ".env"))
KEY = os.environ.get("ALCHEMY_API_KEY", "").strip()
if not KEY:
    raise SystemExit("ALCHEMY_API_KEY missing")
ALCHEMY = f"https://robinhood-mainnet.g.alchemy.com/v2/{KEY}"
scrub = lambda s: re.sub(re.escape(KEY), "<KEY>", str(s))

alchemy_calls = 0


def a_rpc(method, params, timeout=60, tries=4):
    global alchemy_calls
    for a in range(tries):
        alchemy_calls += 1
        try:
            r = requests.post(ALCHEMY, json={"jsonrpc": "2.0", "id": 1,
                                             "method": method, "params": params},
                              timeout=timeout)
            if r.status_code == 429:
                time.sleep(1.5 * (a + 1))
                continue
            j = r.json()
        except Exception:
            time.sleep(1.5 * (a + 1))
            continue
        if "error" in j:
            return None, scrub(j["error"].get("message", ""))[:120]
        return j.get("result"), None
    return None, "retries"


def topic_addr(t):
    return "0x" + t[-40:].lower()


def main():
    if not os.path.exists(CKPT):
        raise SystemExit("no indexed swaps yet — run ntf_index_swaps.py first")
    swaps = []
    with open(CKPT) as fh:
        for line in fh:
            try:
                swaps.append(json.loads(line))
            except ValueError:
                pass
    print(f"indexed swaps available: {len(swaps):,}")

    # evenly spaced sample across the whole history, not the first N
    swaps.sort(key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16)))
    step = max(1, len(swaps) // SAMPLE)
    sample = swaps[::step][:SAMPLE]
    by_tx = defaultdict(list)
    for s in sample:
        by_tx[s["transactionHash"]].append(s)
    print(f"sampling {len(sample)} swaps across {len(by_tx)} transactions\n")

    multi_swap_tx = 0
    multi_counterparty = 0
    from_is_recipient = 0
    from_not_recipient = 0
    checked = 0
    examples = []
    t0 = time.time()

    for txh, group in by_tx.items():
        tx, e1 = a_rpc("eth_getTransactionByHash", [txh])
        rc, e2 = a_rpc("eth_getTransactionReceipt", [txh])
        if e1 or e2 or not tx or not rc:
            continue
        checked += 1
        frm = (tx.get("from") or "").lower()

        # every Swap log for THIS pool in this transaction
        pool_swaps = [l for l in rc.get("logs", [])
                      if l["address"].lower() == PM
                      and l["topics"][0].lower() == group[0]["topics"][0].lower()
                      and l["topics"][1].lower() == group[0]["topics"][1].lower()]
        if len(pool_swaps) > 1:
            multi_swap_tx += 1

        # NTF transfers in this transaction: who actually gained or lost tokens
        parties = set()
        for l in rc.get("logs", []):
            if l["address"].lower() != TOKEN or l["topics"][0].lower() != TRANSFER:
                continue
            a, b = topic_addr(l["topics"][1]), topic_addr(l["topics"][2])
            for p in (a, b):
                # the pool manager and the zero address are plumbing, not traders
                if p not in (PM, "0x" + "0" * 40):
                    parties.add(p)
        # routers appear as intermediaries; a real counterparty set of >1
        # non-router address is the batching signature
        if len(parties) > 1:
            multi_counterparty += 1
        if frm in parties:
            from_is_recipient += 1
        else:
            from_not_recipient += 1
            if len(examples) < 5:
                examples.append((txh, frm, sorted(parties), len(pool_swaps)))

    dt = time.time() - t0
    print("=" * 72)
    print(f"transactions checked                      {checked}")
    print(f"  with MORE THAN ONE Swap log (this pool) {multi_swap_tx}")
    print(f"  with MORE THAN ONE NTF counterparty     {multi_counterparty}")
    print(f"  tx.from IS among the NTF counterparties {from_is_recipient}")
    print(f"  tx.from is NOT                          {from_not_recipient}")
    if examples:
        print("\n  examples where tx.from is not a token counterparty:")
        for txh, frm, parties, nsw in examples:
            print(f"    {txh}")
            print(f"      tx.from={frm}  swaps_in_tx={nsw}")
            print(f"      NTF parties={parties}")
    verdict = (multi_swap_tx == 0 and multi_counterparty == 0 and from_not_recipient == 0)
    print("\n  VERDICT: " + ("tx.from is SAFE — one trader per transaction"
                             if verdict else
                             "tx.from is NOT reliable — use balance-delta attribution"))
    print(f"\nalchemy calls {alchemy_calls}   wall {dt:.1f}s")


if __name__ == "__main__":
    main()
