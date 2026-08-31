#!/usr/bin/env python3
"""
NTF — recompute trader token amounts. Local only, no RPC calls.

THE BUG, and why the obvious fix was wrong. trader_token_amount was set to the
wallet's NET NTF movement across the whole transaction, assigned in full to
every swap in it. The first diagnosis was that multi-swap transactions needed
proportional splitting. That was incorrect: single-swap transactions were
inflated too, by up to 1381x.

The real cause is router order-splitting ACROSS POOLS. A router routes one
order through several V4 pools of the same token; we index exactly one poolId.
The receipt then shows the PoolManager releasing tokens for pools we do not
track, and the wallet receiving the combined total:

    PoolManager -> FEE               1.35
    PoolManager -> router           66.24    <- our pool (66.24 + 1.35 = 67.60)
    PoolManager -> router       93,309.08    <- a pool we do not index
    router      -> WALLET       93,375.33    <- wallet receives the TOTAL

The wallet's net is therefore not attributable to our swap at all. 6.8% of
transactions move more NTF through the PoolManager than our swaps account for.

THE CORRECT BASIS is the swap's own pool amount, which the Swap event states
exactly, minus the fee taken from that swap. Measured across 10,781 single-swap
buys where the fee leg is unambiguous, the fee is a flat 2.0000% of the pool
amount at both the 1st and 99th percentile; sells are never charged. So:

    buy  -> trader receives pool_token_amount x 0.98
    sell -> trader sends    pool_token_amount

Where a transaction has exactly one swap and one fee leg, that measured leg is
used directly rather than the rate, and the method is recorded per row so the
two can be told apart later.

WALLET IDENTITY IS UNCHANGED. The router aggregation means the end recipient is
still the trader; only the amount was wrong. Ordering and timing are untouched.
"""
from __future__ import annotations

import csv
import json
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SRC = os.path.join(DATA, "ntf_trades.csv")
RECEIPTS = os.path.join(DATA, "ntf_receipts.jsonl")
OUT = os.path.join(DATA, "ntf_trades_v2.csv")

PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
FEE_ADDR = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"
FEE_RATE = 0.02


def main() -> None:
    receipts = {}
    with open(RECEIPTS) as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            receipts[r["k"]] = r["v"]

    rows = list(csv.DictReader(open(SRC)))
    by_tx = defaultdict(list)
    for r in rows:
        by_tx[r["tx_hash"]].append(r)
    print(f"read {len(rows):,} rows across {len(by_tx):,} transactions")

    stats = defaultdict(int)
    out = []
    for r in rows:
        pool = float(r["pool_token_amount"])
        side = r["side"]
        tx = r["tx_hash"]
        group = by_tx[tx]
        rec = receipts.get(tx) or {}

        fee = 0.0
        method = ""
        if side == "buy":
            legs = [int(d, 16) / 1e18 for a, b, d in rec.get("transfers", [])
                    if a == PM and b == FEE_ADDR]
            if len(group) == 1 and len(legs) == 1:
                fee = legs[0]
                method = "receipt_fee"
            else:
                fee = pool * FEE_RATE
                method = "rate_2pct"
        else:
            method = "sell_no_fee"
        stats[method] += 1

        trader = max(0.0, pool - fee)
        # A blank wallet means no third party gained or lost NTF in this
        # transaction. Those rows are kept, not dropped — see the report.
        out.append({
            **r,
            "trader_token_amount": f"{trader:.18f}".rstrip("0").rstrip("."),
            "fee_token_amount": f"{fee:.18f}".rstrip("0").rstrip(".") if fee else "0",
            "trader_amount_method": method,
        })

    cols = list(rows[0].keys())
    for c in ("fee_token_amount", "trader_amount_method"):
        if c not in cols:
            cols.append(c)
    with open(OUT, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(out)

    print("method used:")
    for k, v in sorted(stats.items(), key=lambda x: -x[1]):
        print(f"   {k:<14} {v:,}")
    print(f"wrote {OUT} ({len(out):,} rows)")
    print(f"original {SRC} left untouched: {os.path.exists(SRC)}")


if __name__ == "__main__":
    main()
