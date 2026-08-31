#!/usr/bin/env python3
"""
NTF realized PnL, FIFO, on the clean cohort. Writes a CSV; loads nothing.

COHORT: a first buy in our pool, first_buy_mcap_usd < $100,000, and not one of
the 867 excess sellers. Circular-arb rows are dropped first — in those the
PoolManager both sends and receives NTF in one transaction and the attributed
wallet is a tip recipient rather than the trader.

COST BASIS is the ETH that entered the pool for that swap divided by the tokens
the trader actually received. The 2% buy skim is therefore absorbed into the
entry price rather than tracked separately, which is what makes the entry price
the real one the trader paid per token held.

KNOWN UNDERSTATEMENT: eth_amount is the POOL side. A sampled buy showed the
trader's tx.value exceeding it by about 1% — an ETH-side fee that is not in this
file. quote_in is therefore a floor and realized PnL a slight overstatement,
uniformly across the cohort. Fixing it needs a per-transaction value read, which
this stage deliberately does not do.

Unsold inventory is valued at ZERO and surfaced through remaining_tokens rather
than marked to market: the question is what came off the table, not what a
position might be worth.
"""
from __future__ import annotations

import bisect
import csv
import json
import os
from collections import defaultdict, deque

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SCRATCH = "/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad"
OUT = os.path.join(DATA, "ntf_wallet_pnl.csv")
ETH_USD = 2439.92


def main() -> None:
    circ = set(json.load(open(os.path.join(SCRATCH, "circ.json"))))
    cohort = set(json.load(open(os.path.join(SCRATCH, "cohort.json")))["cohort"])
    S = json.load(open(os.path.join(SCRATCH, "supply.json")))
    ev = sorted(S["events"])
    blocks = [b for b, _ in ev]
    cum = []
    c = 0.0
    for _, d in ev:
        c += d
        cum.append(c)
    sup0 = S["sup_at_first"]

    def supply_at(bn: int) -> float:
        i = bisect.bisect_right(blocks, bn) - 1
        return sup0 + (cum[i] if i >= 0 else 0.0)

    rows = [r for r in csv.DictReader(open(os.path.join(DATA, "ntf_trades_v2.csv")))
            if r["tx_hash"] not in circ and r["wallet"] in cohort]
    rows.sort(key=lambda r: (int(r["block_number"]), int(r["log_index"])))
    print(f"cohort wallets {len(cohort):,}   rows in scope {len(rows):,}")

    by_wallet = defaultdict(list)
    for r in rows:
        by_wallet[r["wallet"]].append(r)

    out = []
    walk_target = None
    for w, trades in by_wallet.items():
        lots: deque = deque()          # [qty, eth_per_token]
        realized = 0.0
        bought = sold = quote_in = quote_out = 0.0
        buys = sells = 0
        first = None
        for t in trades:
            eth = float(t["eth_amount"])
            tok = float(t["trader_token_amount"]) if t["trader_token_amount"] else 0.0
            if tok <= 0:
                continue
            if t["side"] == "buy":
                if first is None:
                    first = t
                basis = eth / tok
                lots.append([tok, basis])
                bought += tok
                quote_in += eth
                buys += 1
            else:
                proceeds = eth / tok
                left = tok
                sold += tok
                quote_out += eth
                sells += 1
                while left > 1e-12 and lots:
                    lot = lots[0]
                    take = min(left, lot[0])
                    realized += take * (proceeds - lot[1])
                    lot[0] -= take
                    left -= take
                    if lot[0] <= 1e-12:
                        lots.popleft()
                if left > 1e-12:
                    realized += left * proceeds     # basis-free, should not occur
        if first is None:
            continue
        remaining = max(0.0, bought - sold)
        mcap = (float(first["eth_amount"]) / float(first["pool_token_amount"])) \
            * supply_at(int(first["block_number"])) * ETH_USD
        out.append({
            "wallet": w, "chain": "robinhood", "token": "NTF", "quote_asset": "ETH",
            "first_buy_ts": first["block_time_utc"],
            "first_buy_block": first["block_number"],
            "first_buy_mcap_usd": f"{mcap:.6f}",
            "buys": buys, "sells": sells,
            "tokens_bought": f"{bought:.6f}", "tokens_sold": f"{sold:.6f}",
            "remaining_tokens": f"{remaining:.6f}",
            "quote_in": f"{quote_in:.18f}".rstrip("0").rstrip("."),
            "quote_out": f"{quote_out:.18f}".rstrip("0").rstrip("."),
            "realized_pnl": f"{realized:.18f}".rstrip("0").rstrip("."),
            "sold_out": "true" if (sold > 0 and remaining <= 1e-6) else "false",
        })

    out.sort(key=lambda r: -float(r["realized_pnl"]))
    cols = ["wallet", "chain", "token", "quote_asset", "first_buy_ts", "first_buy_block",
            "first_buy_mcap_usd", "buys", "sells", "tokens_bought", "tokens_sold",
            "remaining_tokens", "quote_in", "quote_out", "realized_pnl", "sold_out"]
    with open(OUT, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=cols)
        wr.writeheader()
        wr.writerows(out)

    import statistics
    pnl = [float(r["realized_pnl"]) for r in out]
    print(f"\ncohort size            {len(out):,}")
    print(f"median realized PnL    {statistics.median(pnl):+.6f} ETH  (${statistics.median(pnl)*ETH_USD:+,.2f})")
    print(f"mean                   {statistics.mean(pnl):+.6f} ETH")
    print(f"positive / negative    {sum(1 for x in pnl if x>0):,} / {sum(1 for x in pnl if x<0):,}")
    print(f"sold out completely    {sum(1 for r in out if r['sold_out']=='true'):,}")
    bad = [r for r in out if float(r["tokens_sold"]) > float(r["tokens_bought"]) + 1]
    print(f"tokens_sold > tokens_bought after exclusions: {len(bad):,}")

    print("\nTOP 10 BY REALIZED PnL")
    print(f"{'#':>3} {'wallet':<44} {'pnl_eth':>12} {'pnl_usd':>12} {'in':>10} {'out':>10} {'held':>14}")
    for i, r in enumerate(out[:10], 1):
        p = float(r["realized_pnl"])
        print(f"{i:>3} {r['wallet']:<44} {p:>12.5f} {p*ETH_USD:>12,.0f} "
              f"{float(r['quote_in']):>10.4f} {float(r['quote_out']):>10.4f} {float(r['remaining_tokens']):>14,.0f}")
    print(f"\nwrote {OUT} ({len(out):,} rows)")
    json.dump(out[0]["wallet"], open(os.path.join(SCRATCH, "topwallet.json"), "w"))


if __name__ == "__main__":
    main()
