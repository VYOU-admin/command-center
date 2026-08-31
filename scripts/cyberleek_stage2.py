#!/usr/bin/env python3
"""
CYBERLEEK stage 2 — exits and FIFO PnL for the sub-$60k buyers.

ONE QUERY PER WALLET, filtered to transactions that changed a balance of THIS
mint. That is the whole point of the tokenTransfer filter: without it a wallet
with thousands of unrelated transactions would be paged in full to find a
handful of CYBERLEEK trades.

NO END BOUND. Stage 1 was capped at 2026-08-22 because sub-$60k buys had
provably stopped by then. Exits have no such property — a wallet can sell at any
time, and cutting the window would silently convert a sale into "still holding"
and understate realized PnL. Every trade each wallet ever made is pulled.

VENUE IS NOT ASSUMED. A wallet may have traded CYBERLEEK anywhere: the CPMM pool
this study is built around, another pool, or an aggregator routing through
something else entirely. A swap is recognised structurally — this wallet's mint
balance moved one way while its SOL moved the other — at ANY call depth. The
pool is identified afterwards for reporting rather than used as a filter, so a
sale on a venue nobody anticipated is still counted.

REALIZED PnL IS FIFO. Unsold inventory is valued at ZERO and surfaced through
tokens_still_held rather than marked to market. Marking to market would blend a
measured result with a price forecast, and the question here is what wallets
actually took off the table.

Writes two CSVs and loads the per-wallet rows into Postgres wallet_pnl with
token='CYBERLEEK'. CATE rows are never touched.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import time
from collections import defaultdict, deque
from typing import Any

import requests
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

MINT = "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg"
WSOL_MINT = "So11111111111111111111111111111111111111112"
POOL = "G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh"
CROSSING_TS = 1786839760  # 2026-08-16T00:22:40Z
SOL_USD = 75.46           # same rate stage 1 used, so the two files agree
LAMPORTS = 1e9
RATE_PER_SEC = 10

BUYERS_CSV = os.path.join(DATA, "cyberleek_sub60k_buyers.csv")
TRADES_CSV = os.path.join(DATA, "cyberleek_wallet_trades.csv")
PNL_CSV = os.path.join(DATA, "cyberleek_wallet_pnl.csv")
CKPT = os.path.join(DATA, "cyberleek_stage2.jsonl")

calls = 0
rpc_url = ""
_last_call = 0.0


def rpc(method: str, params: Any, tries: int = 6) -> Any:
    global calls, _last_call
    for attempt in range(tries):
        wait = _last_call + (1.0 / RATE_PER_SEC) - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_call = time.time()
        calls += 1
        try:
            r = requests.post(
                rpc_url,
                json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
                timeout=120,
            )
        except requests.RequestException:
            time.sleep(0.7 * (attempt + 1))
            continue
        if r.status_code == 429:
            time.sleep(1.5 * (attempt + 1))
            continue
        try:
            j = r.json()
        except ValueError:
            # Truncated body. A ValueError, not a RequestException — the
            # distinction killed a 4,851-page run earlier in this project.
            time.sleep(0.7 * (attempt + 1))
            continue
        if "error" in j:
            msg = str(j["error"].get("message", ""))
            if "invalid params" in msg.lower():
                raise SystemExit(f"{method}: {msg}")
            time.sleep(0.7 * (attempt + 1))
            continue
        return j.get("result")
    raise SystemExit(f"{method}: exhausted retries")


def wallet_page(wallet: str, token: str | None) -> dict:
    opts: dict[str, Any] = {
        "transactionDetails": "full",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 0,
        "sortOrder": "asc",
        "limit": 1000,
        "filters": {
            "status": "succeeded",
            "tokenAccounts": "balanceChanged",
            "tokenTransfer": {"mint": MINT},
        },
    }
    if token:
        opts["paginationToken"] = token
    return rpc("getTransactionsForAddress", [wallet, opts]) or {}


def decode_for_wallet(tx: dict, wallet: str) -> dict | None:
    """A CYBERLEEK swap by `wallet`, or None. Depth-independent by construction."""
    meta = tx.get("meta") or {}
    if meta.get("err"):
        return None
    bt = tx.get("blockTime")
    txn = tx.get("transaction") or {}
    sig = (txn.get("signatures") or [None])[0]
    msg = txn.get("message") or {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    la = meta.get("loadedAddresses") or {}
    keys = keys + list(la.get("writable") or []) + list(la.get("readonly") or [])
    idx_of = {k: i for i, k in enumerate(keys)}

    # This wallet's net movement of the mint, summed over every token account it
    # owns in the transaction.
    def owner_delta(mint: str, owner: str) -> float:
        pre = {b["accountIndex"]: b for b in (meta.get("preTokenBalances") or []) if b.get("mint") == mint}
        post = {b["accountIndex"]: b for b in (meta.get("postTokenBalances") or []) if b.get("mint") == mint}
        tot = 0.0
        for i in set(pre) | set(post):
            o = (post.get(i) or pre.get(i) or {}).get("owner")
            if o != owner:
                continue
            a = float((post.get(i, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
            b = float((pre.get(i, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
            tot += a - b
        return tot

    tok_d = owner_delta(MINT, wallet)
    if abs(tok_d) < 1e-9:
        return None  # a transfer in/out with no net change, or not this wallet

    # SOL side: native lamports, plus any wrapped-SOL account the wallet owns.
    fee = (meta.get("fee") or 0) / LAMPORTS
    wi = idx_of.get(wallet)
    native = 0.0
    if wi is not None:
        pre_b = meta.get("preBalances") or []
        post_b = meta.get("postBalances") or []
        if wi < len(pre_b) and wi < len(post_b):
            native = (post_b[wi] - pre_b[wi]) / LAMPORTS
            if wi == 0:  # feePayer is account 0; add the fee back
                native += fee
    wsol = owner_delta(WSOL_MINT, wallet)
    sol_d = native + wsol

    # A swap moves the token one way and SOL the other. Same-sign means a
    # transfer, an airdrop, or a liquidity action — not a trade.
    if abs(sol_d) < 1e-9 or (sol_d > 0) == (tok_d > 0):
        return None

    side = "buy" if tok_d > 0 else "sell"
    token_amount = abs(tok_d)
    sol_amount_trader = abs(sol_d)
    venue = "raydium_cpmm" if POOL in idx_of else "other"
    return {
        "signature": sig,
        "block_time": bt,
        "block_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(bt)) if bt else "",
        "wallet": wallet,
        "side": side,
        "sol_amount_trader": sol_amount_trader,
        "token_amount": token_amount,
        "price_sol_per_token": sol_amount_trader / token_amount if token_amount else 0.0,
        "venue": venue,
    }


def fifo_pnl(trades: list[dict]) -> tuple[float, float, float]:
    """Realized SOL PnL by FIFO; unsold inventory is worth zero, not marked."""
    lots: deque[list[float]] = deque()  # [qty, cost_per_token]
    realized = 0.0
    bought = 0.0
    sold = 0.0
    for t in sorted(trades, key=lambda x: (x["block_time"], x["signature"])):
        qty = t["token_amount"]
        if t["side"] == "buy":
            lots.append([qty, t["sol_amount_trader"] / qty if qty else 0.0])
            bought += qty
            continue
        sold += qty
        proceeds_per = t["sol_amount_trader"] / qty if qty else 0.0
        left = qty
        while left > 1e-12 and lots:
            lot = lots[0]
            take = min(left, lot[0])
            realized += take * (proceeds_per - lot[1])
            lot[0] -= take
            left -= take
            if lot[0] <= 1e-12:
                lots.popleft()
        if left > 1e-12:
            # Sold more than we saw bought — tokens arrived by transfer or from
            # before the window. Cost basis zero: counts as pure profit, which is
            # the conservative reading for "did this wallet take money out".
            realized += left * proceeds_per
    return realized, bought, sold


def main() -> None:
    global rpc_url
    load_dotenv(os.path.join(ROOT, ".env"))
    key = os.environ.get("HELIUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("HELIUS_API_KEY missing")
    rpc_url = f"https://mainnet.helius-rpc.com/?api-key={key}"

    buyers = list(csv.DictReader(open(BUYERS_CSV)))
    print(f"=== {len(buyers)} sub-$60k buyers to query ===", flush=True)

    done: dict[str, list[dict]] = defaultdict(list)
    if os.path.exists(CKPT):
        with open(CKPT) as fh:
            for line in fh:
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                done[rec["wallet"]] = rec["trades"]
        print(f"    resuming: {len(done)} wallets already pulled", flush=True)

    ck = open(CKPT, "a")
    for i, b in enumerate(buyers, 1):
        w = b["wallet"]
        if w in done:
            continue
        rows: list[dict] = []
        token = None
        while True:
            res = wallet_page(w, token)
            data = res.get("data") or []
            for x in data:
                t = decode_for_wallet(x, w)
                if t:
                    rows.append(t)
            token = res.get("paginationToken")
            if not token or not data:
                break
        done[w] = rows
        ck.write(json.dumps({"wallet": w, "trades": rows}) + "\n")
        ck.flush()
        if i % 20 == 0 or i == len(buyers):
            print(f"    {i}/{len(buyers)} wallets, {calls} credits", flush=True)
    ck.close()

    # ---- trades CSV ----
    all_trades: list[dict] = []
    for w, rows in done.items():
        all_trades.extend(rows)
    all_trades.sort(key=lambda t: (t["block_time"], t["wallet"], t["signature"]))
    tcols = ["signature", "block_time", "block_time_utc", "wallet", "side",
             "sol_amount_trader", "token_amount", "price_sol_per_token", "venue"]
    with open(TRADES_CSV, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=tcols)
        wr.writeheader()
        wr.writerows(all_trades)

    # ---- per-wallet PnL ----
    seed = {b["wallet"]: b for b in buyers}
    out: list[dict] = []
    for w, rows in done.items():
        s = seed[w]
        buys = [t for t in rows if t["side"] == "buy"]
        sells = [t for t in rows if t["side"] == "sell"]
        realized, bought, sold = fifo_pnl(rows)
        first_buy = min((t["block_time"] for t in buys), default=int(s["first_buy_time"]))
        last_sell = max((t["block_time"] for t in sells), default=None)
        out.append({
            "wallet": w,
            "first_buy_time": first_buy,
            "first_buy_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(first_buy)),
            "first_buy_mcap_usd": float(s["first_buy_mcap_usd"]),
            "last_sell_time": last_sell or "",
            "last_sell_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(last_sell)) if last_sell else "",
            "n_buys": len(buys),
            "n_sells": len(sells),
            "sol_in": sum(t["sol_amount_trader"] for t in buys),
            "sol_out": sum(t["sol_amount_trader"] for t in sells),
            "tokens_bought": bought,
            "tokens_sold": sold,
            "tokens_still_held": max(0.0, bought - sold),
            "realized_pnl_sol": realized,
            "realized_pnl_usd": realized * SOL_USD,
            "hold_minutes": round((last_sell - first_buy) / 60, 2) if last_sell else "",
            "sold_out": bool(sold >= bought - 1e-9 and sold > 0),
            "n_trades_total": len(rows),
            "bought_before_crossing": s["bought_before_crossing"] == "True",
        })
    out.sort(key=lambda r: -r["realized_pnl_sol"])
    pcols = ["wallet", "first_buy_time", "first_buy_time_utc", "first_buy_mcap_usd",
             "last_sell_time", "last_sell_time_utc", "n_buys", "n_sells", "sol_in",
             "sol_out", "tokens_bought", "tokens_sold", "tokens_still_held",
             "realized_pnl_sol", "realized_pnl_usd", "hold_minutes", "sold_out",
             "n_trades_total", "bought_before_crossing"]
    with open(PNL_CSV, "w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=pcols)
        wr.writeheader()
        wr.writerows(out)

    # ---- report ----
    pnls = sorted(r["realized_pnl_sol"] for r in out)
    n = len(pnls)
    median = pnls[n // 2] if n % 2 else (pnls[n // 2 - 1] + pnls[n // 2]) / 2
    top20 = out[:20]
    print("\n" + "=" * 78)
    print(f"wallets queried        {len(done)}")
    print(f"trades decoded         {len(all_trades):,}")
    print(f"median realized_pnl    {median:+.4f} SOL")
    print(f"\ntop 10 realized_pnl_sol: " +
          ", ".join(f"{r['realized_pnl_sol']:+.2f}" for r in out[:10]))
    bc = sum(1 for r in top20 if r["bought_before_crossing"])
    print(f"\ntop 20 split: bought_before_crossing True={bc}  False={len(top20)-bc}")
    print("\nTOP 20 BY REALIZED PnL")
    print(f"{'#':>3} {'wallet':<44} {'pnl_sol':>10} {'sol_in':>9} {'sol_out':>10} "
          f"{'held':>12} {'pre':>4}")
    for i, r in enumerate(top20, 1):
        print(f"{i:>3} {r['wallet']:<44} {r['realized_pnl_sol']:>10.3f} {r['sol_in']:>9.3f} "
              f"{r['sol_out']:>10.3f} {r['tokens_still_held']:>12,.0f} "
              f"{'Y' if r['bought_before_crossing'] else 'n':>4}")
    print(f"\nwrote {TRADES_CSV} ({len(all_trades):,} rows)")
    print(f"wrote {PNL_CSV} ({len(out)} rows)")
    print(f"credits burned {calls}")


if __name__ == "__main__":
    main()
