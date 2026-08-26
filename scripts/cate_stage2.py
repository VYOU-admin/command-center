#!/usr/bin/env python3
"""
CATE stage 2 — exits and realized PnL for the curve buyers.

One query per wallet, filtered to transactions that moved a CATE token balance,
with no end bound: the point is every CATE trade a wallet ever made, on the
bonding curve and on the AMM afterwards, through today.

SWAPS ARE DETECTED AT ANY CALL DEPTH. Almost no real swap has the AMM as its
top-level program -- aggregators and bots CPI into it, so the AMM shows up at
invoke [2] or deeper. A top-level check finds essentially none of them; that
was measured on this exact pool, where 0 of 20 sampled swaps had PumpSwap at
depth 1.

SOL AMOUNT IS THE TRADER'S, net of the network fee. Stage 1 deliberately used
the bonding curve's lamport delta, because there the question was the price the
curve charged. Here the question is what the wallet actually made or spent, so
the wallet's own balance change is right -- with the transaction fee added back
when the wallet paid it, so the fee is not counted as part of the trade.

REALIZED PnL IS FIFO, and unsold tokens are NOT marked to market: they are left
out of the realized figure entirely and surfaced as tokens_still_held. Marking
them at a live price would mix a measured result with a forecast, and a wallet
that never sold has not realized anything.

Writes two CSVs. Nothing is written to Postgres.
"""

from __future__ import annotations

import collections
import csv
import os
import statistics
import sys
import time
from typing import Any

import requests
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MINT = "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump"
LAMPORTS = 1e9
MAX_RPS = 10

VENUES = {
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA": "pumpswap",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pumpfun_curve",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium_amm_v4",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "raydium_cpmm",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "raydium_clmm",
    "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "orca_whirlpool",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "meteora_dlmm",
    "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "meteora_pools",
}

calls = 0
_stamps: list[float] = []
rpc_url = ""


def throttle() -> None:
    global _stamps
    now = time.monotonic()
    _stamps = [t for t in _stamps if now - t < 1.0]
    if len(_stamps) >= MAX_RPS:
        time.sleep(max(0.0, 1.0 - (now - _stamps[0])) + 0.01)
        _stamps = [t for t in _stamps if time.monotonic() - t < 1.0]
    _stamps.append(time.monotonic())


def rpc(method: str, params: Any, tries: int = 6) -> Any:
    global calls
    for attempt in range(tries):
        throttle()
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
    return None


def all_keys(tx: dict) -> list[str]:
    """Static account keys followed by any loaded from an address lookup table,
    in the order pre/postBalances are indexed."""
    msg = (tx.get("transaction") or {}).get("message", {})
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    loaded = (tx.get("meta") or {}).get("loadedAddresses") or {}
    return keys + list(loaded.get("writable") or []) + list(loaded.get("readonly") or [])


def venue_of(tx: dict) -> str:
    """Which AMM was invoked, at ANY depth. A top-level check misses nearly all."""
    logs = (tx.get("meta") or {}).get("logMessages") or []
    for line in logs:
        if "invoke" not in line:
            continue
        for pid, name in VENUES.items():
            if pid in line:
                return name
    return "unknown"


def wallet_trades(wallet: str) -> list[dict]:
    out: list[dict] = []
    token = None
    while True:
        opts: dict[str, Any] = {
            "transactionDetails": "full",
            "encoding": "jsonParsed",
            "maxSupportedTransactionVersion": 0,
            "sortOrder": "asc",
            "limit": 1000,
            "filters": {"status": "succeeded",
                        "tokenAccounts": "balanceChanged",
                        "tokenTransfer": {"mint": MINT}},
        }
        if token:
            opts["paginationToken"] = token
        res = rpc("getTransactionsForAddress", [wallet, opts])
        rows = (res or {}).get("data") or []
        if not rows:
            break
        for tx in rows:
            t = parse_trade(tx, wallet)
            if t:
                out.append(t)
        token = (res or {}).get("paginationToken")
        if not token:
            break
    out.sort(key=lambda t: (t["block_time"], t["signature"]))
    return out


def parse_trade(tx: dict, wallet: str) -> dict | None:
    meta = tx.get("meta") or {}
    sig = (tx.get("transaction") or {}).get("signatures", [None])[0]
    bt = tx.get("blockTime")
    if bt is None:
        return None

    # token delta for THIS wallet as owner, across all its token accounts
    tok = 0.0
    for arr, sign in ((meta.get("postTokenBalances") or [], 1.0),
                      (meta.get("preTokenBalances") or [], -1.0)):
        for b in arr:
            if b.get("mint") == MINT and b.get("owner") == wallet:
                tok += sign * float((b.get("uiTokenAmount") or {}).get("uiAmount") or 0)
    if abs(tok) < 1e-9:
        return None

    keys = all_keys(tx)
    try:
        wi = keys.index(wallet)
    except ValueError:
        return None
    pre = (meta.get("preBalances") or [])
    post = (meta.get("postBalances") or [])
    if wi >= len(pre) or wi >= len(post):
        return None
    delta = (post[wi] - pre[wi]) / LAMPORTS
    # Add the network fee back when this wallet paid it, so the fee is not
    # counted as part of the trade itself.
    if wi == 0:
        delta += (meta.get("fee") or 0) / LAMPORTS

    side = "buy" if tok > 0 else "sell"
    sol = abs(delta)
    token_amount = abs(tok)
    return {
        "signature": sig,
        "block_time": bt,
        "wallet": wallet,
        "side": side,
        "sol_amount_trader": sol,
        "token_amount": token_amount,
        "price_sol_per_token": (sol / token_amount) if token_amount else 0.0,
        "venue": venue_of(tx),
    }


def fifo_pnl(trades: list[dict]) -> dict:
    lots: collections.deque = collections.deque()   # (tokens, sol_cost_per_token)
    realized = 0.0
    bought = sold = sol_in = sol_out = 0.0
    n_buys = n_sells = 0
    for t in trades:
        if t["side"] == "buy":
            n_buys += 1
            bought += t["token_amount"]
            sol_in += t["sol_amount_trader"]
            if t["token_amount"] > 0:
                lots.append([t["token_amount"], t["sol_amount_trader"] / t["token_amount"]])
        else:
            n_sells += 1
            sold += t["token_amount"]
            sol_out += t["sol_amount_trader"]
            remaining = t["token_amount"]
            cost = 0.0
            while remaining > 1e-9 and lots:
                lot = lots[0]
                take = min(lot[0], remaining)
                cost += take * lot[1]
                lot[0] -= take
                remaining -= take
                if lot[0] <= 1e-9:
                    lots.popleft()
            # Tokens sold with no matching buy (airdrop, transfer in) contribute
            # proceeds at zero cost rather than being dropped.
            realized += t["sol_amount_trader"] - cost
    held = sum(l[0] for l in lots)
    return {"n_buys": n_buys, "n_sells": n_sells, "sol_in": sol_in, "sol_out": sol_out,
            "tokens_bought": bought, "tokens_sold": sold, "tokens_still_held": held,
            "realized_pnl_sol": realized}


def main() -> None:
    global rpc_url
    load_dotenv(os.path.join(ROOT, ".env"))
    key = os.environ.get("HELIUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("HELIUS_API_KEY missing")
    rpc_url = f"https://mainnet.helius-rpc.com/?api-key={key}"

    seed = list(csv.DictReader(open(os.path.join(DATA, "cate_sub60k_buyers.csv"))))
    wallets = [r["wallet"] for r in seed]
    seed_by = {r["wallet"]: r for r in seed}
    print(f"{len(wallets)} wallets to query")

    sol_usd = 74.48   # same basis as stage 1, cross-checked against CoinGecko hourly
    t0 = time.time()
    all_trades: list[dict] = []
    per_wallet: dict[str, list[dict]] = {}
    for i, w in enumerate(wallets, 1):
        tr = wallet_trades(w)
        per_wallet[w] = tr
        all_trades.extend(tr)
        if i % 50 == 0 or i == len(wallets):
            print(f"    {i}/{len(wallets)} wallets, {len(all_trades)} trades, "
                  f"{calls} calls, {time.time() - t0:.0f}s", flush=True)
    runtime = time.time() - t0

    f1 = os.path.join(DATA, "cate_wallet_trades.csv")
    cols = ["signature", "block_time", "block_time_utc", "wallet", "side",
            "sol_amount_trader", "token_amount", "price_sol_per_token", "venue"]
    with open(f1, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for t in sorted(all_trades, key=lambda x: (x["block_time"], x["signature"])):
            w.writerow({**t, "block_time_utc":
                        time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t["block_time"]))})

    rows = []
    for wl in wallets:
        tr = per_wallet[wl]
        p = fifo_pnl(tr)
        buys = [t for t in tr if t["side"] == "buy"]
        sells = [t for t in tr if t["side"] == "sell"]
        fb = buys[0]["block_time"] if buys else int(seed_by[wl]["first_buy_time"])
        ls = sells[-1]["block_time"] if sells else None
        sold_out = p["tokens_still_held"] <= max(1e-6, p["tokens_bought"] * 1e-6)
        rows.append({
            "wallet": wl,
            "first_buy_time": fb,
            "first_buy_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(fb)),
            "first_buy_mcap_usd": float(seed_by[wl]["first_buy_mcap_usd"]),
            "last_sell_time": ls or "",
            "last_sell_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ls)) if ls else "",
            **p,
            "realized_pnl_usd": p["realized_pnl_sol"] * sol_usd,
            "hold_minutes": round((ls - fb) / 60, 2) if ls else "",
            "sold_out": sold_out,
            "n_trades_total": len(tr),
        })

    f2 = os.path.join(DATA, "cate_wallet_pnl.csv")
    pcols = ["wallet", "first_buy_time", "first_buy_time_utc", "first_buy_mcap_usd",
             "last_sell_time", "last_sell_time_utc", "n_buys", "n_sells",
             "sol_in", "sol_out", "tokens_bought", "tokens_sold", "tokens_still_held",
             "realized_pnl_sol", "realized_pnl_usd", "hold_minutes", "sold_out",
             "n_trades_total"]
    with open(f2, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=pcols)
        w.writeheader()
        for r in sorted(rows, key=lambda x: -x["realized_pnl_sol"]):
            w.writerow({k: r[k] for k in pcols})

    # ---- report ----
    curve_only = sum(1 for wl in wallets if len(per_wallet[wl]) <= int(seed_by[wl]["n_buys_sub60k"]))
    pnl = sorted((r["realized_pnl_sol"] for r in rows), reverse=True)
    sold = [r for r in rows if r["sold_out"]]
    holding = [r for r in rows if not r["sold_out"]]
    holds = [r["hold_minutes"] for r in sold if r["hold_minutes"] != ""]

    print("\n" + "=" * 72)
    print(f"wallets queried                 {len(wallets)}")
    print(f"no trades beyond the curve      {curve_only}")
    print(f"total trades found              {len(all_trades):,}")
    print(f"median realized_pnl_sol         {statistics.median(pnl):+.4f}")
    print(f"top-10 realized_pnl_sol         {', '.join(f'{p:+.2f}' for p in pnl[:10])}")
    print(f"sold everything                 {len(sold)}")
    print(f"still holding a balance         {len(holding)}")
    if holds:
        print(f"median hold (sold-out wallets)  {statistics.median(holds):.1f} min")
    print(f"\nrpc calls {calls}   runtime {runtime:.0f}s")
    print(f"wrote {f1}")
    print(f"wrote {f2}")

    print("\n=== TOP 20 BY REALIZED PnL (SOL) ===")
    print(f"{'wallet':<46}{'pnl_sol':>10}{'pnl_usd':>11}{'buys':>6}{'sells':>6}"
          f"{'hold_min':>10}{'sold_out':>9}")
    for r in sorted(rows, key=lambda x: -x["realized_pnl_sol"])[:20]:
        print(f"{r['wallet']:<46}{r['realized_pnl_sol']:>10.3f}{r['realized_pnl_usd']:>11.0f}"
              f"{r['n_buys']:>6}{r['n_sells']:>6}"
              f"{str(r['hold_minutes']):>10}{str(r['sold_out']):>9}")


if __name__ == "__main__":
    main()
