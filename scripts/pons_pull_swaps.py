#!/usr/bin/env python3
"""
PONS: pull every Uniswap V3 Swap log for the supplied pool.

V3 vs V4, which the pipeline must handle differently:
  V3  each pool is its own contract, so the pool address IS the log address and
      the Swap event carries amount0/amount1 as int256 deltas from the POOL's
      perspective. Positive means the token came into the pool.
  V4  one PoolManager singleton for every pool, so the pool is identified by a
      poolId in topic1 and amounts are int128 from the SWAPPER's perspective.

Public RPC for bulk logs: it serves 25k-50k block ranges, while Alchemy's free
tier caps eth_getLogs at nine blocks — roughly 4.7 million requests for this
span, against about 1,700 here.

Checkpointed per window. The span is 42.2M blocks; a run that loses its place
on a timeout would be unaffordable to restart.
"""
from __future__ import annotations

import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRATCH = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
           "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
PUB = "https://rpc.mainnet.chain.robinhood.com"
POOL = "0x10cc6bd38112cac182db90b6a71d8bb5939526ba"
SWAP_V3 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
CKPT = os.path.join(SCRATCH, "pons_swaps.jsonl")
STATE = os.path.join(SCRATCH, "pons_swaps.state")
WINDOW = 25_000

calls = 0
_last = 0.0


def rpc(method, params, timeout=120, tries=5):
    global calls, _last
    for a in range(tries):
        w = _last + 0.9 - time.time()
        if w > 0:
            time.sleep(w)
        _last = time.time()
        calls += 1
        try:
            r = requests.post(PUB, json={"jsonrpc": "2.0", "id": 1,
                                         "method": method, "params": params}, timeout=timeout)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(0.8 * (a + 1) ** 2)
                continue
            j = r.json()
        except ValueError:
            time.sleep(0.5 * (a + 1) ** 2)      # HTML error page, not a decode bug
            continue
        except requests.RequestException:
            time.sleep(0.5 * (a + 1) ** 2)
            continue
        if "error" in j:
            m = str(j["error"].get("message", ""))
            if "Too Many" in m:
                time.sleep(1.5 * (a + 1) ** 2)
                continue
            return None, m
        return j.get("result"), None
    return None, "exhausted retries"


def fetch(lo, hi):
    """Split on size or timeout. A skipped window is missing data, not zero."""
    res, err = rpc("eth_getLogs", [{"fromBlock": hex(lo), "toBlock": hex(hi),
                                    "address": POOL, "topics": [SWAP_V3]}])
    if err is None:
        return res or []
    if ("exceeds limit" in err or "timed out" in err) and hi > lo:
        mid = (lo + hi) // 2
        return fetch(lo, mid) + fetch(mid + 1, hi)
    raise SystemExit(f"window {lo}-{hi}: {err}")


def main():
    blocks = json.load(open(os.path.join(SCRATCH, "pons_blocks.json")))
    start, head = blocks["create"], blocks["head"]
    done = []
    seen = set()
    if os.path.exists(STATE) and os.path.exists(CKPT):
        done = json.load(open(STATE))["ranges"]
        with open(CKPT) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                seen.add((r["transactionHash"], r["logIndex"]))
        print(f"resuming: {len(done)} windows, {len(seen):,} swaps", flush=True)
    covered = {tuple(r) for r in done}
    ck = open(CKPT, "a")
    t0 = time.time()
    lo = start
    total = len(seen)
    while lo <= head:
        hi = min(lo + WINDOW, head)
        if (lo, hi) in covered:
            lo = hi + 1
            continue
        logs = fetch(lo, hi)
        added = 0
        for l in logs:
            k = (l["transactionHash"], l["logIndex"])
            if k in seen:
                continue
            seen.add(k)
            ck.write(json.dumps({k2: l[k2] for k2 in
                                 ("address", "topics", "data", "blockNumber",
                                  "transactionHash", "logIndex")}) + "\n")
            added += 1
        total += added
        done.append([lo, hi])
        ck.flush()
        json.dump({"ranges": done, "head": head}, open(STATE, "w"))
        pct = 100.0 * (hi - start) / max(1, head - start)
        if len(done) % 20 == 0 or added:
            el = (time.time() - t0) / 60
            print(f"  {lo:,}..{hi:,}  +{added:<5} total {total:,}  {pct:5.1f}%  "
                  f"{calls} calls  {el:.1f} min", flush=True)
        lo = hi + 1
    print(f"\nTOTAL SWAPS {total:,}   windows {len(done)}   calls {calls}   "
          f"wall {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
