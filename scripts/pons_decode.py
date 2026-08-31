#!/usr/bin/env python3
"""
PONS decode: V3 swaps -> attributed trades, with the locked constraints.

V3 vs V4. Each V3 pool is its own contract, so the pool address is the log
address and amount0/amount1 are int256 deltas from the POOL's perspective:
positive means the token came INTO the pool. Token order is by address, so
WETH (0x0Bd7...) is token0 and PONS (0x39dB...) is token1.

ATTRIBUTION IS BY BALANCE DELTA, never tx.from — measured at ~46% correct on
this chain, because smart-account wallets and ERC-4337 bundlers make the signer
a relayer.

ROUTER ORDER-SPLITTING. The trader amount is the swap's own pool amount minus
its own fee, never the wallet's whole net across the transaction. A router can
route one order through several pools of the same token; attributing the net to
one pool inflated NTF by up to 1381x.

CIRCULAR ARB. The V4 rule was "PoolManager both sends and receives". The V3
analogue is the POOL CONTRACT both sending and receiving PONS in one
transaction. The count it catches is reported even when zero — a filter that
matches nothing has looked like success on this project repeatedly.
"""
import json, os, sys
from collections import defaultdict

S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
POOL = "0x10cc6bd38112cac182db90b6a71d8bb5939526ba"
TOKEN = "0x39dbed3a2bd333467115de45665cc57f813c4571"
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
ZERO = "0x" + "0" * 40
DEC = 10 ** 18


def i256(h):
    v = int(h, 16)
    return v - (1 << 256) if v >= (1 << 255) else v


def load():
    sw = json.load(open(os.path.join(S, "pons_window_swaps.json")))
    rec = {}
    with open(os.path.join(S, "pons_receipts.jsonl")) as fh:
        for line in fh:
            try:
                r = json.loads(line)
            except ValueError:
                continue
            rec[r["k"]] = r["v"]
    return sw, rec


def net_of(rec_v, contract):
    """Net movement of `contract` per address in this transaction."""
    net = defaultdict(float)
    for a, b, data, addr in rec_v.get("transfers", []):
        if addr != contract:
            continue
        v = int(data, 16) / DEC
        net["0x" + a] -= v
        net["0x" + b] += v
    return net


def main():
    sw, rec = load()
    print(f"swaps in window {len(sw):,}   receipts {len(rec):,}")
    by_tx = defaultdict(list)
    for l in sw:
        by_tx[l["transactionHash"]].append(l)
    multi = sum(1 for g in by_tx.values() if len(g) > 1)
    print(f"transactions {len(by_tx):,}   multi-swap transactions {multi:,}")

    # ---- circular arb, V3 analogue ----
    circ = set()
    for h, v in rec.items():
        t = [x for x in v.get("transfers", []) if x[3] == TOKEN]
        if any("0x" + a == POOL for a, _, _, _ in t) and \
           any("0x" + b == POOL for _, b, _, _ in t):
            circ.add(h)
    print(f"\nCIRCULAR-ARB (V3: pool contract both sends AND receives PONS): "
          f"{len(circ):,} transactions")
    if not circ:
        print("  CAUGHT ZERO. Stated plainly rather than treated as a pass: the")
        print("  rule was written for V4's PoolManager singleton and may simply")
        print("  not apply to a V3 pool, where the pool is one side of every swap.")

    # ---- fee measurement, single-swap transactions only ----
    fees = {"buy": [], "sell": []}
    for h, g in by_tx.items():
        if len(g) != 1 or h in circ:
            continue
        v = rec.get(h)
        if not v:
            continue
        d = g[0]["data"][2:]
        a1 = i256(d[64:128])              # PONS, pool perspective
        pool_amt = abs(a1) / DEC
        if pool_amt <= 0:
            continue
        side = "buy" if a1 < 0 else "sell"
        net = net_of(v, TOKEN)
        movers = {k: x for k, x in net.items()
                  if abs(x) > 1e-12 and k not in (POOL, ZERO)}
        if not movers:
            continue
        w = max(movers.items(), key=lambda kv: abs(kv[1]))[0]
        trader_amt = abs(movers[w])
        fees[side].append(trader_amt / pool_amt)
    import statistics
    print("\nFEE RATE, measured on unambiguous single-swap transactions:")
    out = {}
    for side in ("buy", "sell"):
        v = sorted(fees[side])
        if not v:
            print(f"  {side}: no samples")
            out[side] = 0.0
            continue
        med = statistics.median(v)
        p1, p99 = v[len(v) // 100], v[min(len(v) - 1, 99 * len(v) // 100)]
        flat = abs(p99 - p1) < 1e-6
        print(f"  {side}: n={len(v):,}  trader/pool median {med:.6f}  "
              f"p1 {p1:.6f}  p99 {p99:.6f}  {'FLAT' if flat else 'VARIABLE'}")
        out[side] = 1.0 - med
    print(f"  => implied fee: buy {out['buy']*100:.4f}%  sell {out['sell']*100:.4f}%")
    json.dump(out, open(os.path.join(S, "pons_fee.json"), "w"))
    json.dump(sorted(circ), open(os.path.join(S, "pons_circ.json"), "w"))


if __name__ == "__main__":
    main()
