#!/usr/bin/env python3
"""
Parameterized wallet pipeline.

  python3 scripts/run_pipeline.py --name CATE --address <mint> \
      --chain solana --mcap-threshold 100000 [--write] [--cached-trades FILE]

Runs seven phases and reports at each. Writes nothing unless --write is given,
so a comparison run cannot disturb wallet_pnl.

WHAT THIS DECIDES ITSELF and what still needs a person is documented in
docs/PIPELINE.md — read that before trusting an unattended run.
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pipeline.rpc import Rpc                      # noqa: E402
from pipeline import pricing, pnl                 # noqa: E402
from pipeline.chains import solana as sol_chain   # noqa: E402
from pipeline.chains import evm as evm_chain      # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
PM_4663 = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
COIN = {"solana": "solana", "robinhood": "ethereum"}


def hr(t):
    print("\n" + "=" * 74 + f"\n{t}\n" + "=" * 74, flush=True)


def phase1_discover(args, rpc):
    hr("PHASE 1 — DISCOVER: venue, pools, quote asset, supply, fee")
    if args.chain == "solana":
        v = sol_chain.discover(rpc, args.address, log=print)
        print(f"  venue: {v['venue']}")
    else:
        v = evm_chain.discover(rpc, args.address, PM_4663, args.from_block, log=print)
        print(f"  venue: {v['venue']}")
    q = v["quote"]
    print(f"  QUOTE ASSET: {q['symbol']}  {q['address']}  decimals={q['decimals']}"
          f"{'  (native)' if q.get('native') else ''}")
    return v


def load_cached(path):
    """Trades from a cached CSV, normalised to the pipeline's shape."""
    rows = list(csv.DictReader(open(path)))
    out = []
    for r in rows:
        w = r.get("wallet")
        if not w:
            continue
        q = r.get("sol_amount_trader") or r.get("eth_amount") or r.get("sol_amount")
        tk = r.get("trader_token_amount") or r.get("token_amount")
        pool = r.get("pool_token_amount") or tk
        if q in (None, "") or tk in (None, ""):
            continue
        out.append({"signature": r.get("signature") or r.get("tx_hash"),
                    "block_time": int(r["block_time"]), "wallet": w, "side": r["side"],
                    "quote_amount": float(q), "token_amount": float(tk),
                    "pool_token_amount": float(pool or 0),
                    "attribution": r.get("attribution", "cached")})
    return out


def phase2_trades(args, rpc, venue):
    hr("PHASE 2 — PULL AND DECODE")
    if args.cached_trades:
        trades = load_cached(args.cached_trades)
        print(f"  using cached trades: {args.cached_trades}")
    else:
        raise SystemExit("live pull not wired in this build — pass --cached-trades; "
                         "see docs/PIPELINE.md 'what is not automated'")
    by_w = defaultdict(list)
    for t in trades:
        by_w[t["wallet"]].append(t)
    print(f"  trades {len(trades):,}   wallets attributed {len(by_w):,}")
    print(f"  sides: buy {sum(1 for t in trades if t['side']=='buy'):,} / "
          f"sell {sum(1 for t in trades if t['side']=='sell'):,}")
    return trades, by_w


def phase3_mcap(args, trades, venue, rate_fn, supply):
    hr("PHASE 3 — MCAP AT FIRST BUY")
    first = {}
    for t in sorted(trades, key=lambda x: (int(x["block_time"]), x.get("signature") or "")):
        if t["side"] != "buy" or t["wallet"] in first:
            continue
        pool = t["pool_token_amount"] or t["token_amount"]
        if pool <= 0:
            continue
        px = t["quote_amount"] / pool
        first[t["wallet"]] = px * supply.at(int(t["block_time"])) * rate_fn(int(t["block_time"]))
    v = sorted(first.values())
    if not v:
        print("  no buys found"); return first, []
    import statistics
    q = lambda p: v[min(len(v) - 1, int(p * len(v)))]
    print(f"  wallets with a first buy: {len(v):,}")
    for lab, val in (("min", v[0]), ("p10", q(.10)), ("p25", q(.25)),
                     ("median", statistics.median(v)), ("p75", q(.75)),
                     ("p90", q(.90)), ("max", v[-1])):
        print(f"    {lab:>6}  ${val:>14,.0f}")
    step = max(20_000, int(v[-1] / 25) // 1000 * 1000 or 20_000)
    print(f"  histogram, ${step:,} buckets:")
    buckets = defaultdict(int)
    for x in v:
        buckets[int(x // step)] += 1
    mx = max(buckets.values())
    for i in sorted(buckets)[:25]:
        print(f"    ${i*step:>10,}-${(i+1)*step:>10,} {buckets[i]:>5,} {'#'*int(40*buckets[i]/mx)}")
    t = args.mcap_threshold
    under = [w for w, m in first.items() if m < t]
    pct = 100.0 * len(under) / len(first)
    print(f"\n  YOUR THRESHOLD ${t:,}: {len(under):,} of {len(first):,} wallets ({pct:.1f}%)")
    if pct < 3 or pct > 40:
        print(f"  ** FLAG: {pct:.1f}% is {'under 3%' if pct<3 else 'over 40%'}. Nearby thresholds:")
        for alt in (t // 4, t // 2, t * 2, t * 4):
            n = sum(1 for m in first.values() if m < alt)
            print(f"       ${alt:>10,}: {n:>5,} ({100*n/len(first):>5.1f}%)")
        print("  running with your number anyway.")
    return first, under


def phase4_pnl(trades_by_wallet, cohort, rate_fn, fee):
    hr("PHASE 4 — FIFO PnL (native and USD)")
    rows = {}
    for w in cohort:
        rows[w] = pnl.fifo_wallet(trades_by_wallet[w], rate_fn)
    print(f"  wallets computed: {len(rows):,}")
    flagged = sum(1 for r in rows.values() if r["pre_window_entry"])
    print(f"  zero-basis-sell wallets (entry predates our window): {flagged:,}")
    return rows


def compare_to_db(name, rows, q_path):
    hr("COMPARE AGAINST wallet_pnl (no writes)")
    import subprocess
    sql = ("\\pset tuples_only on\n\\pset format unaligned\n\\pset fieldsep |\n"
           f"select wallet||'|'||realized_pnl_sol from wallet_pnl where token='{name}';")
    out = subprocess.run(["bash", q_path], input=sql, capture_output=True, text=True).stdout
    stored = {}
    for l in out.strip().split("\n"):
        p = l.split("|")
        if len(p) == 2:
            try:
                stored[p[0]] = float(p[1])
            except ValueError:
                pass
    print(f"  wallet_pnl rows for {name}: {len(stored):,}")
    print(f"  pipeline produced          : {len(rows):,}")
    both = [w for w in rows if w in stored]
    diffs = [(abs(rows[w]["realized_native"] - stored[w]), w) for w in both]
    bad = sorted([d for d in diffs if d[0] > 1e-6], reverse=True)
    print(f"  compared {len(both):,}   matching within 1e-6: {len(both)-len(bad):,}   differing: {len(bad):,}")
    for d, w in bad[:5]:
        print(f"    {w[:26]}..  pipeline {rows[w]['realized_native']:+.8f}  stored {stored[w]:+.8f}  diff {d:.2e}")
    only_p = [w for w in rows if w not in stored]
    only_s = [w for w in stored if w not in rows]
    print(f"  in pipeline only: {len(only_p):,}   in wallet_pnl only: {len(only_s):,}")
    return len(bad) == 0 and not only_p and not only_s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", required=True)
    ap.add_argument("--address", required=True)
    ap.add_argument("--chain", required=True, choices=["solana", "robinhood"])
    ap.add_argument("--mcap-threshold", type=float, required=True)
    ap.add_argument("--cached-trades")
    ap.add_argument("--from-block", type=int, default=48_000_000)
    ap.add_argument("--write", action="store_true", help="load to Postgres (off by default)")
    ap.add_argument("--compare", action="store_true", help="compare to wallet_pnl, never write")
    ap.add_argument("--skip-discovery", action="store_true")
    args = ap.parse_args()

    from dotenv import load_dotenv
    load_dotenv(os.path.join(ROOT, ".env"))
    if args.chain == "solana":
        key = os.environ.get("HELIUS_API_KEY", "").strip()
        rpc = Rpc(f"https://mainnet.helius-rpc.com/?api-key={key}", 10.0, key)
    else:
        rpc = Rpc("https://rpc.mainnet.chain.robinhood.com", 8.0)

    t0 = time.time()
    print(f"TOKEN {args.name}  chain={args.chain}  threshold=${args.mcap_threshold:,.0f}")
    venue = None
    if not args.skip_discovery:
        venue = phase1_discover(args, rpc)
    trades, by_w = phase2_trades(args, rpc, venue)

    lo = min(int(t["block_time"]) for t in trades)
    hi = max(int(t["block_time"]) for t in trades)
    hr("USD METHOD — chosen from this token's own window")
    mode, rate_fn, rep = pricing.choose_usd_method(COIN[args.chain], lo, hi)
    print(f"  window {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(lo))} -> "
          f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(hi))}  ({rep['days']:.2f} days)")
    print(f"  quote range ${rep['min']:,.2f} .. ${rep['max']:,.2f}  spread {rep['spread_pct']:.1f}%")
    print(f"  METHOD: {mode}")
    print(f"  basis: {rep['basis']}")

    supply_whole = (venue or {}).get("supply_whole") or 1.0
    supply = pricing.SupplyCurve(supply_whole, [])
    first, under = phase3_mcap(args, trades, venue, rate_fn, supply)
    cohort = under if under else list(by_w)
    rows = phase4_pnl(by_w, cohort, rate_fn, {"buy": 0.0, "sell": 0.0})

    if args.compare:
        matched = compare_to_db(args.name, rows, os.path.join(
            "/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
            "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad", "q.sh"))
        print(f"\n  RESULT: {'MATCHES wallet_pnl' if matched else 'DOES NOT MATCH — see above'}")
    if args.write:
        print("\n  --write given, but load is gated: see docs/PIPELINE.md")
    print(f"\nrpc calls {rpc.calls}   wall {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
