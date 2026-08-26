#!/usr/bin/env python3
"""
CATE stage 1 — sub-$60k buyers from the bonding curve.

Reconstructs every curve trade from BALANCE DELTAS rather than from decoded
pump.fun events. The two agree, but deltas are the more defensible source here:
they describe what actually moved between accounts, independent of whether an
event layout is being read correctly.

WHOSE WALLET. postTokenBalances carries both a token account address and its
owner. The owner is the trader; the token account is just a container, and a
wallet's ATA is a different address from the wallet itself. Recording the token
account would make every wallet look unique per token and silently break any
later cross-token analysis.

SOL AMOUNT is taken from the BONDING CURVE's lamport delta, not the trader's.
The trader's balance change also carries the network fee and pump.fun's cut, so
using it would overstate what was paid into the curve and therefore the price.
The curve's delta is the SOL that actually entered or left the pool, which is
what sets the price.

TOTAL SUPPLY is read from the mint account, not assumed. pump.fun's convention
is 1e9 tokens, but a convention is not a guarantee and market cap is entirely
sensitive to it.

Writes two CSVs. Nothing is written to Postgres.
"""

from __future__ import annotations

import base64
import csv
import json
import os
import struct
import sys
import time
from collections import defaultdict
from typing import Any

import requests
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

CURVE = "3Sg92V4Mre9Apm7dJsM39B6vrAEVVErE1vBsZMKyUbxT"
MINT = "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump"
START, END = 1785083078, 1785083563
PAGE = 250
LAMPORTS = 1e9
MCAP_THRESHOLD_USD = 60_000
FIRST_SECONDS = 30

calls = 0
rpc_url = ""


def rpc(method: str, params: Any, tries: int = 6) -> Any:
    global calls
    for attempt in range(tries):
        calls += 1
        try:
            r = requests.post(rpc_url, json={"jsonrpc": "2.0", "id": 1,
                                             "method": method, "params": params}, timeout=90)
        except requests.RequestException:
            time.sleep(0.7 * (attempt + 1))
            continue
        if r.status_code == 429:
            time.sleep(1.2 * (attempt + 1))
            continue
        j = r.json()
        if "error" in j:
            msg = str(j["error"].get("message", ""))
            if "invalid params" in msg.lower():
                raise SystemExit(f"{method}: {msg}")
            time.sleep(0.7 * (attempt + 1))
            continue
        return j.get("result")
    raise SystemExit(f"{method}: exhausted retries")


def total_supply() -> tuple[float, int, int]:
    """Whole tokens, raw base units, decimals — read from the mint, not assumed."""
    res = rpc("getAccountInfo", [MINT, {"encoding": "base64"}])
    raw = base64.b64decode(res["value"]["data"][0])
    # SPL Mint: 4 mint_authority_option | 32 authority | 8 supply | 1 decimals ...
    supply = struct.unpack_from("<Q", raw, 36)[0]
    decimals = raw[44]
    return supply / (10 ** decimals), supply, decimals


def sol_usd_at(ts: int) -> tuple[float, str]:
    """SOL/USD at a minute, from Binance klines; CoinGecko daily as a fallback."""
    try:
        ms = ts * 1000
        r = requests.get("https://api.binance.com/api/v3/klines",
                         params={"symbol": "SOLUSDT", "interval": "1m",
                                 "startTime": ms, "limit": 1}, timeout=30)
        k = r.json()
        if isinstance(k, list) and k:
            return float(k[0][4]), "binance 1m close"
    except Exception:
        pass
    try:
        d = time.strftime("%d-%m-%Y", time.gmtime(ts))
        r = requests.get(f"https://api.coingecko.com/api/v3/coins/solana/history",
                         params={"date": d, "localization": "false"}, timeout=30)
        return float(r.json()["market_data"]["current_price"]["usd"]), f"coingecko daily {d}"
    except Exception as e:
        raise SystemExit(f"could not obtain SOL/USD: {e}")


def fetch_curve_txs() -> list[dict]:
    out, token, pages = [], None, 0
    while True:
        opts: dict[str, Any] = {
            "transactionDetails": "full",
            "encoding": "jsonParsed",
            "maxSupportedTransactionVersion": 0,
            "sortOrder": "asc",
            "limit": PAGE,
            "filters": {"status": "succeeded",
                        "blockTime": {"gte": START, "lte": END}},
        }
        if token:
            opts["paginationToken"] = token
        res = rpc("getTransactionsForAddress", [CURVE, opts])
        rows = (res or {}).get("data") or []
        if not rows:
            break
        out.extend(rows)
        pages += 1
        token = (res or {}).get("paginationToken")
        print(f"    page {pages}: +{len(rows)} (total {len(out)})", flush=True)
        if not token:
            break
    return out


def trades_from(txs: list[dict], supply_whole: float) -> list[dict]:
    trades = []
    for tx in txs:
        meta = tx.get("meta") or {}
        bt = tx.get("blockTime")
        sig = (tx.get("transaction") or {}).get("signatures", [None])[0]
        msg = (tx.get("transaction") or {}).get("message", {})
        keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]

        # token balance deltas for THIS mint, keyed by owner
        pre = {b["accountIndex"]: b for b in (meta.get("preTokenBalances") or []) if b.get("mint") == MINT}
        post = {b["accountIndex"]: b for b in (meta.get("postTokenBalances") or []) if b.get("mint") == MINT}
        deltas: dict[str, float] = defaultdict(float)
        for idx in set(pre) | set(post):
            owner = (post.get(idx) or pre.get(idx) or {}).get("owner")
            if not owner:
                continue
            a = float((post.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
            b = float((pre.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
            deltas[owner] += a - b

        # SOL that entered or left the pool
        try:
            ci = keys.index(CURVE)
        except ValueError:
            continue
        pre_l = (meta.get("preBalances") or [])[ci]
        post_l = (meta.get("postBalances") or [])[ci]
        curve_sol_delta = (post_l - pre_l) / LAMPORTS

        # The trader is whoever's token balance moved, excluding the curve itself
        movers = {o: d for o, d in deltas.items() if abs(d) > 1e-9 and o != CURVE}
        if not movers or abs(curve_sol_delta) < 1e-12:
            continue
        owner = max(movers.items(), key=lambda kv: abs(kv[1]))[0]
        tok = movers[owner]
        # SOL into the curve => a buy; out of it => a sell.
        side = "buy" if curve_sol_delta > 0 else "sell"
        sol_amount = abs(curve_sol_delta)
        token_amount = abs(tok)
        if token_amount <= 0:
            continue
        price = sol_amount / token_amount
        trades.append({
            "signature": sig,
            "block_time": bt,
            "wallet": owner,
            "side": side,
            "sol_amount": sol_amount,
            "token_amount": token_amount,
            "price_sol_per_token": price,
            "mcap_sol": price * supply_whole,
        })
    return trades


def main() -> None:
    global rpc_url
    load_dotenv(os.path.join(ROOT, ".env"))
    key = os.environ.get("HELIUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("HELIUS_API_KEY missing")
    rpc_url = f"https://mainnet.helius-rpc.com/?api-key={key}"
    os.makedirs(DATA, exist_ok=True)

    print("=== supply (read from the mint, not assumed) ===")
    supply_whole, supply_raw, decimals = total_supply()
    print(f"    raw={supply_raw}  decimals={decimals}  whole tokens={supply_whole:,.0f}")

    print("\n=== SOL/USD at 2026-07-26 16:30 UTC ===")
    px, src = sol_usd_at(1785083400)
    print(f"    ${px:,.2f}  ({src})")

    print("\n=== paging the bonding curve, full detail ===")
    txs = fetch_curve_txs()
    print(f"    {len(txs)} successful transactions in window")

    trades = trades_from(txs, supply_whole)
    for t in trades:
        t["mcap_usd"] = t["mcap_sol"] * px
    trades.sort(key=lambda t: (t["block_time"], t["signature"]))
    print(f"    {len(trades)} curve trades derived")

    f1 = os.path.join(DATA, "cate_curve_trades.csv")
    cols = ["signature", "block_time", "block_time_utc", "wallet", "side",
            "sol_amount", "token_amount", "price_sol_per_token", "mcap_sol", "mcap_usd"]
    with open(f1, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for t in trades:
            w.writerow({**t, "block_time_utc":
                        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t["block_time"]))})

    launch = trades[0]["block_time"] if trades else START
    buyers: dict[str, dict] = {}
    for t in trades:
        if t["side"] != "buy" or t["mcap_usd"] >= MCAP_THRESHOLD_USD:
            continue
        b = buyers.setdefault(t["wallet"], {
            "wallet": t["wallet"], "first_buy_time": t["block_time"],
            "first_buy_mcap_usd": t["mcap_usd"], "n_buys_sub60k": 0,
            "sol_spent_sub60k": 0.0, "tokens_bought_sub60k": 0.0})
        b["n_buys_sub60k"] += 1
        b["sol_spent_sub60k"] += t["sol_amount"]
        b["tokens_bought_sub60k"] += t["token_amount"]

    f2 = os.path.join(DATA, "cate_sub60k_buyers.csv")
    bcols = ["wallet", "first_buy_time", "first_buy_time_utc", "first_buy_mcap_usd",
             "n_buys_sub60k", "sol_spent_sub60k", "tokens_bought_sub60k"]
    with open(f2, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=bcols)
        w.writeheader()
        for b in sorted(buyers.values(), key=lambda x: x["first_buy_time"]):
            w.writerow({**b, "first_buy_time_utc":
                        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(b["first_buy_time"]))})

    # ---- report ----
    buys = [t for t in trades if t["side"] == "buy"]
    sells = [t for t in trades if t["side"] == "sell"]
    crossed = next((t for t in trades if t["mcap_usd"] >= MCAP_THRESHOLD_USD), None)
    early = sum(1 for b in buyers.values() if b["first_buy_time"] - launch <= FIRST_SECONDS)

    print("\n" + "=" * 60)
    print(f"total curve trades      {len(trades):,}   buys {len(buys):,} / sells {len(sells):,}")
    if trades:
        print(f"mcap_usd first trade    ${trades[0]['mcap_usd']:,.0f}")
        print(f"mcap_usd at graduation  ${trades[-1]['mcap_usd']:,.0f}")
    if crossed:
        print(f"crossed ${MCAP_THRESHOLD_USD:,}        YES at "
              f"{time.strftime('%H:%M:%SZ', time.gmtime(crossed['block_time']))} "
              f"(+{crossed['block_time'] - launch}s), mcap ${crossed['mcap_usd']:,.0f}")
    else:
        print(f"crossed ${MCAP_THRESHOLD_USD:,}        NO — never reached before graduation")
    print(f"distinct sub-$60k buyers {len(buyers):,}")
    print(f"  of those, first buy within {FIRST_SECONDS}s: {early:,}")
    print(f"\nwrote {f1}")
    print(f"wrote {f2}")
    print(f"\nrpc calls {calls}")


if __name__ == "__main__":
    main()
