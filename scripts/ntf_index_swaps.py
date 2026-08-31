#!/usr/bin/env python3
"""
NTF stage 1 — index every Uniswap V4 Swap log for the pool.

WHY TWO ENDPOINTS. Measured, not assumed:
  public RPC : eth_getLogs accepts 25k-50k block spans, but times out
               intermittently and rate-limits on COST rather than request count.
  Alchemy    : free tier caps eth_getLogs at NINE blocks, which would need
               ~23,000 calls for this range — strictly worse for bulk log work,
               but it serves 10.6 req/s with no throttling for single-tx reads.
So bulk logs come from the public endpoint and per-transaction reads from
Alchemy. This file only does the first half.

RETRY AND SPLIT. A timeout is not an empty range. An earlier count of 7,026 was
a floor precisely because three windows timed out and were skipped, silently
losing every swap inside them. Here a timeout halves the window and retries,
recursively, and a window is only recorded once it actually returns.

CHECKPOINTED per window with its block range, so a crash resumes rather than
re-paying for work already done.
"""
from __future__ import annotations

import json
import os
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

PUBLIC = "https://rpc.mainnet.chain.robinhood.com"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
PID = "0xf7579d2f662922c92c526cf1ce7f2793c98f87223148ab3f4a372ee7de328413"
START_BLOCK = 48_485_901

WINDOW = 25_000
MIN_WINDOW = 200          # below this a timeout is a real failure, not size
CKPT = os.path.join(DATA, "ntf_swaps.jsonl")
STATE = os.path.join(DATA, "ntf_swaps.state")

pub_calls = 0
_last = 0.0


def rpc(method, params, timeout=120, tries=5):
    """Returns (result, error_message). Paced; 429 backs off."""
    global pub_calls, _last
    for a in range(tries):
        w = _last + 1.0 - time.time()
        if w > 0:
            time.sleep(w)
        _last = time.time()
        pub_calls += 1
        try:
            r = requests.post(PUBLIC, json={"jsonrpc": "2.0", "id": 1,
                                            "method": method, "params": params},
                              timeout=timeout)
            j = r.json()
        except Exception as e:
            if a == tries - 1:
                return None, f"transport: {str(e)[:80]}"
            time.sleep(2 * (a + 1))
            continue
        if "error" in j:
            m = str(j["error"].get("message", ""))
            if "Too Many Requests" in m:
                time.sleep(5 * (a + 1))
                continue
            return None, m
        return j.get("result"), None
    return None, "exhausted retries"


def fetch_window(lo, hi, depth=0):
    """
    Logs in [lo,hi], splitting on timeout or size limit.

    Returns (logs, windows_done). A window that cannot be served even at
    MIN_WINDOW raises, rather than being skipped — skipping is the bug that
    produced a floor last time.
    """
    res, err = rpc("eth_getLogs", [{"fromBlock": hex(lo), "toBlock": hex(hi),
                                    "address": PM, "topics": [SWAP, PID]}])
    if err is None:
        return res, 1
    retryable = ("timed out" in err) or ("exceeds limit" in err)
    if retryable and (hi - lo) > MIN_WINDOW:
        mid = (lo + hi) // 2
        a, na = fetch_window(lo, mid, depth + 1)
        b, nb = fetch_window(mid + 1, hi, depth + 1)
        return a + b, na + nb
    raise SystemExit(f"window {lo}-{hi} unrecoverable: {err}")


def main():
    os.makedirs(DATA, exist_ok=True)
    head, err = rpc("eth_blockNumber", [])
    if err:
        raise SystemExit(f"head: {err}")
    head = int(head, 16)
    print(f"head {head:,}   start {START_BLOCK:,}   span {head-START_BLOCK:,} blocks", flush=True)

    done_ranges = []
    seen = set()
    swaps = []
    if os.path.exists(STATE) and os.path.exists(CKPT):
        done_ranges = json.load(open(STATE))["ranges"]
        with open(CKPT) as fh:
            for line in fh:
                try:
                    x = json.loads(line)
                except ValueError:
                    continue
                k = (x["transactionHash"], x["logIndex"])
                if k not in seen:
                    seen.add(k)
                    swaps.append(x)
        print(f"resuming: {len(done_ranges)} windows, {len(swaps):,} swaps already indexed", flush=True)

    covered = {tuple(r) for r in done_ranges}
    ck = open(CKPT, "a")
    t0 = time.time()
    lo = START_BLOCK
    windows = 0
    while lo <= head:
        hi = min(lo + WINDOW, head)
        if (lo, hi) in covered:
            lo = hi + 1
            continue
        logs, n = fetch_window(lo, hi)
        windows += n
        added = 0
        for x in logs:
            k = (x["transactionHash"], x["logIndex"])
            if k in seen:
                continue
            seen.add(k)
            swaps.append(x)
            ck.write(json.dumps(x) + "\n")
            added += 1
        ck.flush()
        done_ranges.append([lo, hi])
        json.dump({"ranges": done_ranges, "head": head}, open(STATE, "w"))
        print(f"  {lo:,}..{hi:,}  +{added:<6} total {len(swaps):,}  "
              f"(subwindows {n})", flush=True)
        lo = hi + 1
    ck.close()
    dt = time.time() - t0

    # every block in range must be covered by exactly the recorded windows
    done_ranges.sort()
    gaps = []
    cursor = START_BLOCK
    for a, b in done_ranges:
        if a > cursor:
            gaps.append((cursor, a - 1))
        cursor = max(cursor, b + 1)
    if cursor <= head:
        gaps.append((cursor, head))

    print(f"\nTOTAL SWAPS {len(swaps):,}")
    print(f"blocks {START_BLOCK:,}..{head:,}   windows {len(done_ranges)}")
    print(f"coverage gaps: {gaps if gaps else 'NONE - every block accounted for'}")
    print(f"public RPC calls {pub_calls}   wall {dt/60:.1f} min")


if __name__ == "__main__":
    main()
