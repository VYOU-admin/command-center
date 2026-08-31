#!/usr/bin/env python3
"""
NTF stage 2b — decode indexed Swap logs into trades, with BALANCE-DELTA
attribution.

WHY NOT tx.from. Measured over 200 sampled transactions: of the 167 with a
single net token counterparty, only 84 had that counterparty equal to tx.from.
The other 83 were smart-contract wallets reached through a relayer, and three
transactions came straight from the ERC-4337 EntryPoint, where tx.from is a
bundler by construction. Attributing those to tx.from would credit the trade to
a relayer. So the trader is derived from who actually gained or lost NTF.

THE FEE ADDRESS IS EXCLUDED. 0xe5e7...e044 takes roughly 2% and nets positive in
103 of 200 sampled transactions. Left in, it would be the most active "trader"
on the token by a wide margin.

TWO TOKEN AMOUNTS, DELIBERATELY. pool_token_amount is |amount1| from the Swap
event — what the pool released or absorbed, and the correct basis for price.
trader_token_amount is the wallet's own net movement, which is smaller on buys
because of the skim. PnL needs the trader's number; price needs the pool's.
Conflating them would silently overstate holdings by ~2%.

AMOUNT CONVENTION verified against ground truth, not read off an ABI: a swap
with amount0 = -0.17 had tx.value = 0.17 ETH and amount1 = +7,901,867 matched
the NTF transfers out of the PoolManager. So amount0 < 0 means the swapper paid
ETH: a buy.

Checkpointed per transaction and per block, so a crash resumes.
"""
from __future__ import annotations

import csv
import json
import os
import re
import time
from bisect import bisect_left
from collections import defaultdict

import requests
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
SWAPS = os.path.join(DATA, "ntf_swaps.jsonl")
RCACHE = os.path.join(DATA, "ntf_receipts.jsonl")
BCACHE = os.path.join(DATA, "ntf_blocks.jsonl")
OUT = os.path.join(DATA, "ntf_trades.csv")

TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
TOKEN = "0x27e9d5067596132936427ee311f05b339a50eba6"
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
FEE = "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"
ZERO = "0x" + "0" * 40
DUST = 10 ** 15                      # 0.001 token
TOTAL_SUPPLY = 1_000_000_000
DEC = 10 ** 18

load_dotenv(os.path.join(ROOT, ".env"))
KEY = os.environ.get("ALCHEMY_API_KEY", "").strip()
if not KEY:
    raise SystemExit("ALCHEMY_API_KEY missing")
ALCHEMY = f"https://robinhood-mainnet.g.alchemy.com/v2/{KEY}"
scrub = lambda s: re.sub(re.escape(KEY), "<KEY>", str(s))

calls = 0


def a_rpc(method, params, timeout=60, tries=5):
    global calls
    for a in range(tries):
        calls += 1
        try:
            r = requests.post(ALCHEMY, json={"jsonrpc": "2.0", "id": 1,
                                             "method": method, "params": params},
                              timeout=timeout)
            if r.status_code == 429:
                time.sleep(1.5 * (a + 1)); continue
            j = r.json()
        except Exception:
            time.sleep(1.5 * (a + 1)); continue
        if "error" in j:
            return None, scrub(j["error"].get("message", ""))[:120]
        return j.get("result"), None
    return None, "retries"


def i128(word: str) -> int:
    v = int(word, 16) & ((1 << 128) - 1)
    return v - (1 << 128) if v >= (1 << 127) else v


def load_jsonl(path):
    out = {}
    if os.path.exists(path):
        with open(path) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                out[r["k"]] = r["v"]
    return out


def eth_usd_series(t_from, t_to):
    for attempt in range(4):
        try:
            r = requests.get(
                "https://api.coingecko.com/api/v3/coins/ethereum/market_chart/range",
                params={"vs_currency": "usd", "from": t_from - 7200, "to": t_to + 7200},
                timeout=90)
            pts = (r.json() or {}).get("prices") or []
            if pts:
                pts.sort(key=lambda p: p[0])
                return [int(p[0] / 1000) for p in pts], [float(p[1]) for p in pts]
        except Exception:
            pass
        time.sleep(10 * (attempt + 1))
    raise SystemExit("CoinGecko returned no ETH/USD points")


def price_at(ts_list, px_list, ts):
    i = bisect_left(ts_list, ts)
    if i <= 0:
        return px_list[0]
    if i >= len(ts_list):
        return px_list[-1]
    return px_list[i] if abs(ts_list[i] - ts) < abs(ts_list[i - 1] - ts) else px_list[i - 1]


def main():
    swaps, seen = [], set()
    with open(SWAPS) as fh:
        for line in fh:
            try:
                s = json.loads(line)
            except ValueError:
                continue
            k = (s["transactionHash"], s["logIndex"])
            if k not in seen:
                seen.add(k); swaps.append(s)
    swaps.sort(key=lambda x: (int(x["blockNumber"], 16), int(x["logIndex"], 16)))
    print(f"swaps to decode: {len(swaps):,}", flush=True)

    by_tx = defaultdict(list)
    for s in swaps:
        by_tx[s["transactionHash"]].append(s)
    blocks_needed = sorted({int(s["blockNumber"], 16) for s in swaps})
    print(f"unique transactions {len(by_tx):,}   unique blocks {len(blocks_needed):,}", flush=True)

    receipts = load_jsonl(RCACHE)
    blocks = load_jsonl(BCACHE)
    print(f"cached: {len(receipts):,} receipts, {len(blocks):,} blocks", flush=True)

    t0 = time.time()
    todo = [h for h in by_tx if h not in receipts]
    if todo:
        with open(RCACHE, "a") as ck:
            for i, h in enumerate(todo, 1):
                r, e = a_rpc("eth_getTransactionReceipt", [h])
                if r is None:
                    slim = {"from": None, "transfers": [], "err": e}
                else:
                    slim = {
                        "from": (r.get("from") or "").lower(),
                        "transfers": [
                            ["0x" + l["topics"][1][-40:].lower(),
                             "0x" + l["topics"][2][-40:].lower(),
                             l["data"]]
                            for l in r.get("logs", [])
                            if l["address"].lower() == TOKEN
                            and l["topics"][0].lower() == TRANSFER
                            and len(l["topics"]) >= 3
                        ],
                    }
                receipts[h] = slim
                ck.write(json.dumps({"k": h, "v": slim}) + "\n")
                if i % 500 == 0:
                    ck.flush()
                    el = time.time() - t0
                    print(f"  receipts {i:,}/{len(todo):,}  {calls} calls  "
                          f"{el/60:.1f} min  ({i/el:.1f}/s)", flush=True)

    todo_b = [b for b in blocks_needed if str(b) not in blocks]
    if todo_b:
        with open(BCACHE, "a") as ck:
            for i, b in enumerate(todo_b, 1):
                r, e = a_rpc("eth_getBlockByNumber", [hex(b), False])
                ts = int((r or {}).get("timestamp", "0x0"), 16)
                blocks[str(b)] = ts
                ck.write(json.dumps({"k": str(b), "v": ts}) + "\n")
                if i % 500 == 0:
                    ck.flush()
                    print(f"  blocks {i:,}/{len(todo_b):,}  {calls} calls  "
                          f"{(time.time()-t0)/60:.1f} min", flush=True)

    times = [blocks[str(int(s["blockNumber"], 16))] for s in swaps]
    lo, hi = min(t for t in times if t), max(times)
    print(f"\nspan {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(lo))} -> "
          f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(hi))}", flush=True)
    ts_list, px_list = eth_usd_series(lo, hi)
    print(f"ETH/USD points {len(ts_list)}  ${min(px_list):,.2f}..${max(px_list):,.2f}", flush=True)

    rows = []
    stats = defaultdict(int)
    for txh, group in by_tx.items():
        rec = receipts.get(txh) or {}
        net = defaultdict(int)
        for a, b, data in rec.get("transfers", []):
            v = int(data, 16)
            net[a] -= v
            net[b] += v
        parties = {a: v for a, v in net.items()
                   if abs(v) > DUST and a not in (PM, ZERO, FEE)}
        group.sort(key=lambda x: int(x["logIndex"], 16))
        pool_amts = []
        for s in group:
            d = s["data"][2:]
            w = [d[i * 64:(i + 1) * 64] for i in range(len(d) // 64)]
            pool_amts.append((i128(w[0]), i128(w[1])))

        # ---- attribution ----
        assign = {}
        if len(parties) == 1:
            only = next(iter(parties))
            total_pool = sum(abs(a1) for _, a1 in pool_amts) or 1
            for s, (_, a1) in zip(group, pool_amts):
                assign[s["logIndex"]] = (only,
                                         abs(parties[only]) * abs(a1) / total_pool,
                                         "single" if len(group) == 1 else "single_multiswap")
            stats["single"] += len(group)
        elif not parties:
            for s in group:
                assign[s["logIndex"]] = ("", None, "zero_net_party")
            stats["zero_net_party"] += len(group)
        else:
            # match each swap to the party whose net magnitude is closest
            for s, (_, a1) in zip(group, pool_amts):
                target = abs(a1)
                best = min(parties, key=lambda p: abs(abs(parties[p]) - target))
                rel = abs(abs(parties[best]) - target) / target if target else 1
                assign[s["logIndex"]] = (best, abs(parties[best]),
                                         "multi_matched" if rel < 0.15 else "multi_ambiguous")
                stats["multi_matched" if rel < 0.15 else "multi_ambiguous"] += 1

        for s, (a0, a1) in zip(group, pool_amts):
            if a0 == 0 or a1 == 0:
                stats["skipped_zero_amount"] += 1
                continue
            bn = int(s["blockNumber"], 16)
            bt = blocks.get(str(bn), 0)
            eth_amount = abs(a0) / DEC
            pool_tok = abs(a1) / DEC
            wallet, trader_raw, method = assign[s["logIndex"]]
            trader_tok = (trader_raw / DEC) if trader_raw is not None else ""
            price = eth_amount / pool_tok if pool_tok else 0.0
            eu = price_at(ts_list, px_list, bt) if bt else 0.0
            rows.append({
                "tx_hash": s["transactionHash"],
                "block_number": bn,
                "block_time": bt,
                "block_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(bt)) if bt else "",
                "wallet": wallet,
                "side": "buy" if a0 < 0 else "sell",
                "eth_amount": eth_amount,
                "pool_token_amount": pool_tok,
                "trader_token_amount": trader_tok,
                "price_eth_per_token": price,
                "eth_usd": eu,
                "mcap_usd": price * TOTAL_SUPPLY * eu,
                "attribution": method,
                "tx_from": rec.get("from") or "",
                "log_index": int(s["logIndex"], 16),
            })

    rows.sort(key=lambda r: (r["block_number"], r["log_index"]))
    cols = ["tx_hash", "block_number", "block_time", "block_time_utc", "wallet", "side",
            "eth_amount", "pool_token_amount", "trader_token_amount",
            "price_eth_per_token", "eth_usd", "mcap_usd", "attribution", "tx_from",
            "log_index"]
    with open(OUT, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=cols)
        wr.writeheader()
        wr.writerows(rows)

    buys = sum(1 for r in rows if r["side"] == "buy")
    wallets = {r["wallet"] for r in rows if r["wallet"]}
    unattributed = sum(1 for r in rows if not r["wallet"])
    differs = sum(1 for r in rows if r["wallet"] and r["tx_from"] and r["wallet"] != r["tx_from"])
    print("\n" + "=" * 70)
    print(f"trades decoded        {len(rows):,}   buys {buys:,} / sells {len(rows)-buys:,}")
    print("attribution:")
    for k in ("single", "single_multiswap", "multi_matched", "multi_ambiguous",
              "zero_net_party", "skipped_zero_amount"):
        if stats.get(k):
            print(f"   {k:<22} {stats[k]:,}")
    print(f"distinct wallets      {len(wallets):,}")
    print(f"unattributed rows     {unattributed:,}  (flagged zero_net_party)")
    print(f"wallet != tx_from     {differs:,}  ({100*differs/max(1,len(rows)-unattributed):.1f}% "
          f"of attributed) -- these would have been wrong under tx.from")
    if rows:
        print(f"mcap at first trade   ${rows[0]['mcap_usd']:,.0f}  ({rows[0]['block_time_utc']})")
        print(f"mcap at head          ${rows[-1]['mcap_usd']:,.0f}  ({rows[-1]['block_time_utc']})")
    print(f"wrote {OUT}")
    print(f"alchemy calls {calls:,}   wall {(time.time()-t0)/60:.1f} min")


if __name__ == "__main__":
    main()
