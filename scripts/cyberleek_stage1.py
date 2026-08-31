#!/usr/bin/env python3
"""
CYBERLEEK stage 1 — sub-$60k buyers from the Raydium CPMM pool.

DIFFERENT VENUE, SAME METHOD. CATE traded on a pump.fun bonding curve, where
one account holds the SOL and the price is a function of the curve. CYBERLEEK
has no curve: it is a constant-product CPMM pool with two vaults, so price is
whatever the pool actually exchanged in each swap. Everything here is therefore
derived from BALANCE DELTAS — what moved between accounts — rather than from
decoded instruction data. That choice matters more here than it did for CATE,
because the CPMM instruction layout differs from AMM v4 and a layout assumed
from the wrong program would be silently wrong rather than loudly wrong.

CALL DEPTH. Swaps arrive through aggregators (Jupiter and friends) that CPI
into the pool, so the pool program is almost never the top-level instruction.
Nothing here inspects call depth at all: a transaction counts as a swap if the
two vault balances moved in opposite directions, which is true at any depth.

WHOSE WALLET. postTokenBalances carries a token account address and its OWNER.
The owner is the trader; the token account is a container, and a wallet's ATA
is a different address from the wallet itself. Recording the token account
would make every wallet look unique per token and break cross-token overlap —
which is exactly what this script is for.

PRICE comes from the POOL's own vault deltas: |WSOL vault delta| divided by
|token vault delta|. That is the price the pool actually executed at. The
trader's own SOL delta is reported separately as sol_amount_trader, because it
carries the network fee, aggregator fees and any routing legs, and so overstates
what reached the pool.

Writes two CSVs. Nothing is written to Postgres.
"""

from __future__ import annotations

import base64
import csv
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

POOL = "G8kgi7aUpeX8EVR8VMkrth9SKEv5BietWC33UjAiiMGh"
MINT = "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg"
VAULT_WSOL = "6iZNEKMsSDHG42UpDXgGd2FRNZosEDe7RbLwjNPAtaKU"
VAULT_TOKEN = "4cQ4QmL4h85RyEVzb1bWsmvd25zMdgkAKipVyKqpKs5Y"
WSOL_MINT = "So11111111111111111111111111111111111111112"

POOL_CREATED = 1786828046  # 2026-08-15T21:07:26Z
# Explicit end, capped deliberately. The full history is ~1.2M transactions
# and tens of thousands of credits; the price crossed $60k at 195 minutes, so
# buys below the threshold after the first week are late dip-buys rather than
# early participation. This boundary is a decision, not a search artefact.
PULL_END = 1787356800  # 2026-08-22T00:00:00Z
SOL_PRICE_HOUR = 1786827600  # 2026-08-15T21:00:00Z
LAMPORTS = 1e9
MCAP_THRESHOLD_USD = 60_000

calls = 0
rpc_url = ""


def rpc(method: str, params: Any, tries: int = 6) -> Any:
    global calls
    for attempt in range(tries):
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
            time.sleep(1.2 * (attempt + 1))
            continue
        try:
            j = r.json()
        except ValueError:
            # A truncated body. Helius occasionally cuts a large full-mode page
            # mid-stream; requests raises JSONDecodeError, which is a ValueError
            # and NOT a RequestException, so it escaped the retry loop above and
            # killed a 4,851-page run outright. It is retryable like any other
            # transport failure.
            time.sleep(0.7 * (attempt + 1))
            continue
        if "error" in j:
            msg = str(j["error"].get("message", ""))
            # A params error is a bug, not a transient failure. Stop rather than
            # retry it five more times and bill for each attempt.
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
    # SPL Mint: 4 mint_authority_option | 32 authority | 8 supply | 1 decimals
    supply = struct.unpack_from("<Q", raw, 36)[0]
    decimals = raw[44]
    return supply / (10 ** decimals), supply, decimals


def sol_usd_at(ts: int) -> tuple[float, str]:
    """SOL/USD from CoinGecko. Binance returns 451 from this IP, so it is not tried."""
    try:
        r = requests.get(
            "https://api.coingecko.com/api/v3/coins/solana/market_chart/range",
            params={"vs_currency": "usd", "from": ts - 7200, "to": ts + 7200},
            timeout=60,
        )
        pts = (r.json() or {}).get("prices") or []
        if pts:
            best = min(pts, key=lambda p: abs(p[0] / 1000 - ts))
            when = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(best[0] / 1000))
            return float(best[1]), f"coingecko hourly, point at {when}"
    except Exception:
        pass
    try:
        d = time.strftime("%d-%m-%Y", time.gmtime(ts))
        r = requests.get(
            "https://api.coingecko.com/api/v3/coins/solana/history",
            params={"date": d, "localization": "false"},
            timeout=60,
        )
        return float(r.json()["market_data"]["current_price"]["usd"]), f"coingecko daily {d}"
    except Exception as e:
        raise SystemExit(f"could not obtain SOL/USD: {e}")


def owner_token_deltas(meta: dict, mint: str) -> dict[str, float]:
    """Net change in `mint` per OWNER, from pre/postTokenBalances."""
    pre = {b["accountIndex"]: b for b in (meta.get("preTokenBalances") or []) if b.get("mint") == mint}
    post = {b["accountIndex"]: b for b in (meta.get("postTokenBalances") or []) if b.get("mint") == mint}
    out: dict[str, float] = defaultdict(float)
    for idx in set(pre) | set(post):
        owner = (post.get(idx) or pre.get(idx) or {}).get("owner")
        if not owner:
            continue
        a = float((post.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
        b = float((pre.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
        out[owner] += a - b
    return out


def account_token_delta(meta: dict, account_index_of: dict[str, int], addr: str, mint: str) -> float:
    """Net change of one specific token ACCOUNT (a vault), by address."""
    idx = account_index_of.get(addr)
    if idx is None:
        return 0.0
    pre = {b["accountIndex"]: b for b in (meta.get("preTokenBalances") or [])}
    post = {b["accountIndex"]: b for b in (meta.get("postTokenBalances") or [])}
    a = float((post.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
    b = float((pre.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
    return a - b


def decode_tx(tx: dict, supply_whole: float, sol_usd: float) -> dict | None:
    """One transaction -> one trade row, or None if it is not a swap on this pool."""
    meta = tx.get("meta") or {}
    if meta.get("err"):
        return None
    bt = tx.get("blockTime")
    txn = tx.get("transaction") or {}
    sig = (txn.get("signatures") or [None])[0]
    msg = txn.get("message") or {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    idx_of = {k: i for i, k in enumerate(keys)}

    # THE SWAP TEST, depth-independent: both vaults moved, in opposite directions.
    wsol_d = account_token_delta(meta, idx_of, VAULT_WSOL, WSOL_MINT)
    tok_d = account_token_delta(meta, idx_of, VAULT_TOKEN, MINT)
    if abs(wsol_d) < 1e-12 or abs(tok_d) < 1e-12:
        return None
    if (wsol_d > 0) == (tok_d > 0):
        return None  # both same direction: a deposit or withdrawal, not a swap

    # SOL into the pool => somebody bought; SOL out => somebody sold.
    side = "buy" if wsol_d > 0 else "sell"
    price = abs(wsol_d) / abs(tok_d)

    # The trader is the owner whose token balance moved opposite the pool's.
    movers = {o: d for o, d in owner_token_deltas(meta, MINT).items() if abs(d) > 1e-9}
    movers.pop(POOL, None)
    # the vault's own owner is the pool authority; drop anything moving with the pool
    movers = {o: d for o, d in movers.items() if (d > 0) != (tok_d > 0)}
    if not movers:
        return None
    owner = max(movers.items(), key=lambda kv: abs(kv[1]))[0]
    token_amount = abs(movers[owner])
    if token_amount <= 0:
        return None

    # Trader's own SOL movement, with the fee added back when they paid it.
    fee = (meta.get("fee") or 0) / LAMPORTS
    oi = idx_of.get(owner)
    sol_trader = 0.0
    if oi is not None:
        pre_b = (meta.get("preBalances") or [])
        post_b = (meta.get("postBalances") or [])
        if oi < len(pre_b) and oi < len(post_b):
            sol_trader = (post_b[oi] - pre_b[oi]) / LAMPORTS
            if oi == 0:  # feePayer is always account 0
                sol_trader -= fee
    # A wallet routing through a WSOL account shows no native delta; fall back to
    # the pool side, which is the amount that actually reached the pool.
    if abs(sol_trader) < 1e-12:
        sol_trader = -wsol_d
    sol_amount_trader = abs(sol_trader)

    venue = "raydium-cpmm"
    return {
        "signature": sig,
        "block_time": bt,
        "block_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(bt)) if bt else "",
        "wallet": owner,
        "side": side,
        "sol_amount_trader": sol_amount_trader,
        "token_amount": token_amount,
        "price_sol_per_token": price,
        "mcap_usd": price * supply_whole * sol_usd,
        "venue": venue,
    }


def page(after: int | None, before: int | None, limit: int, token: str | None = None) -> dict:
    opts: dict[str, Any] = {
        "transactionDetails": "full",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 0,
        "sortOrder": "asc",
        "limit": limit,
        "filters": {"status": "succeeded"},
    }
    bt: dict[str, int] = {}
    if after is not None:
        bt["gte"] = after
    if before is not None:
        bt["lte"] = before
    if bt:
        opts["filters"]["blockTime"] = bt
    if token:
        opts["paginationToken"] = token
    return rpc("getTransactionsForAddress", [POOL, opts]) or {}


def find_crossing(supply_whole: float, sol_usd: float, end_ts: int) -> tuple[dict | None, int]:
    """
    Binary search for the first trade at or above the threshold.

    The mcap of a CPMM pool is not monotone — it goes down as well as up — so a
    bisection cannot be trusted on its own to find the FIRST crossing. It is used
    here only to locate a region cheaply; the exact first crossing is then
    confirmed by a forward scan from the last known-below point.
    """
    probes = 0
    lo, hi = POOL_CREATED, end_ts
    first_hit: dict | None = None

    while lo < hi:
        mid = (lo + hi) // 2
        res = page(mid, None, 50)
        probes += 1
        rows = res.get("data") or []
        trades = [t for t in (decode_tx(x, supply_whole, sol_usd) for x in rows) if t]
        hit = next((t for t in trades if t["mcap_usd"] >= MCAP_THRESHOLD_USD), None)
        if hit:
            first_hit = hit
            hi = mid  # a crossing exists at or before here; look earlier
            if trades and trades[0]["block_time"] >= mid:
                hi = min(hi, hit["block_time"])
        else:
            if not trades:
                break
            lo = max(mid + 1, trades[-1]["block_time"])
        if hi - lo <= 1:
            break
    return first_hit, probes


def main() -> None:
    global rpc_url
    load_dotenv(os.path.join(ROOT, ".env"))
    key = os.environ.get("HELIUS_API_KEY", "").strip()
    if not key:
        raise SystemExit("HELIUS_API_KEY missing")
    rpc_url = f"https://mainnet.helius-rpc.com/?api-key={key}"
    os.makedirs(DATA, exist_ok=True)

    print("=== supply (read from the mint, not assumed) ===", flush=True)
    supply_whole, supply_raw, decimals = total_supply()
    print(f"    raw={supply_raw}  decimals={decimals}  whole tokens={supply_whole:,.0f}")

    print("\n=== SOL/USD at 2026-08-15 21:00 UTC ===", flush=True)
    sol_usd, src = sol_usd_at(SOL_PRICE_HOUR)
    px_threshold = MCAP_THRESHOLD_USD / sol_usd / supply_whole
    print(f"    ${sol_usd:,.2f}  ({src})")
    print(f"    $60k mcap  =>  price_sol_per_token >= {px_threshold:.12f}")

    # FULL HISTORY: pool creation -> now, an explicit boundary rather than
    # wherever a bisection happened to stop. The binary search is deliberately
    # NOT run: with the complete series in hand the first crossing is simply the
    # first qualifying row, which is both cheaper (no probes) and exact (a
    # bisection over a non-monotone price can only ever find *a* crossing).
    now = PULL_END
    probes = 0
    print(f"\n=== capped pull: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(POOL_CREATED))}"
          f" -> {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now))} ===", flush=True)
    end_ts = now
    # CHECKPOINTED. A full-history pull is thousands of pages and tens of
    # minutes; losing it to one truncated response (as happened) wastes every
    # credit spent. Each page is appended to a JSONL and the pagination token is
    # saved beside it, so a rerun resumes instead of starting over.
    ckpt = os.path.join(DATA, "cyberleek_pull.jsonl")
    state = os.path.join(DATA, "cyberleek_pull.state")
    trades: list[dict] = []
    seen: set[str] = set()
    total_txs = 0
    non_swap = 0
    token = None
    pages = 0
    if os.path.exists(ckpt) and os.path.exists(state):
        import json as _json
        with open(state) as fh:
            st = _json.load(fh)
        token = st.get("token")
        total_txs = st.get("total_txs", 0)
        non_swap = st.get("non_swap", 0)
        pages = st.get("pages", 0)
        with open(ckpt) as fh:
            for line in fh:
                t = _json.loads(line)
                if t["signature"] not in seen:
                    seen.add(t["signature"])
                    trades.append(t)
        print(f"    resuming: {len(trades):,} trades, {pages} pages already done", flush=True)
        if token is None and pages:
            print("    (previous run had finished paging)", flush=True)
    ck = open(ckpt, "a")
    while True:
        res = page(POOL_CREATED, end_ts, 250, token)
        rows = res.get("data") or []
        if not rows:
            break
        for x in rows:
            total_txs += 1
            t = decode_tx(x, supply_whole, sol_usd)
            if t is None:
                non_swap += 1
                continue
            if t["signature"] in seen:
                continue
            seen.add(t["signature"])
            trades.append(t)
            import json as _json
            ck.write(_json.dumps(t) + "\n")
        pages += 1
        token = res.get("paginationToken")
        ck.flush()
        import json as _json
        with open(state, "w") as fh:
            _json.dump({"token": token, "total_txs": total_txs,
                        "non_swap": non_swap, "pages": pages}, fh)
        if pages % 25 == 0 or not token:
            print(f"    page {pages}: {total_txs:,} txs seen, {len(trades):,} trades", flush=True)
        if not token:
            break

    ck.close()
    trades.sort(key=lambda t: (t["block_time"], t["signature"]))

    # The true first crossing, from the complete series rather than a probe.
    crossing = next((t for t in trades if t["mcap_usd"] >= MCAP_THRESHOLD_USD), None)

    # A CPMM PRICE IS NOT MONOTONE, and that makes "sub-$60k" ambiguous in a way
    # it never was for a bonding curve. CATE's curve only ever went up, so
    # "below $60k" and "before the first crossing" were the same set. This pool
    # crosses $60k and then falls back under it repeatedly, so they differ.
    #
    # THE DEFINITION IN FORCE: a buyer qualifies on any buy below $60k, whenever
    # it happened — including during a dip after the pool had already crossed.
    # The narrower "before the first crossing" reading is still computed, purely
    # so the gap between the two is visible rather than a matter of belief.
    #
    # ⚠️ THE WINDOW IS NOT THE TOKEN'S WHOLE HISTORY. The pull ends wherever the
    # binary search happened to land, which is an artefact of the search and not
    # a meaningful boundary. "At any time" therefore means "at any time inside
    # the pulled window". Widening the window can only ever add buyers.
    pulled_last_utc = trades[-1]["block_time_utc"] if trades else ""
    cross_bt = crossing["block_time"] if crossing else float("inf")
    before_cross = set(t["wallet"] for t in trades
                       if t["side"] == "buy"
                       and t["mcap_usd"] < MCAP_THRESHOLD_USD
                       and t["block_time"] <= cross_bt)
    after_dip_rows = [t for t in trades
                      if t["block_time"] > cross_bt
                      and t["side"] == "buy"
                      and t["mcap_usd"] < MCAP_THRESHOLD_USD]
    in_window = [t for t in trades if t["block_time"] <= cross_bt]

    f1 = os.path.join(DATA, "cyberleek_trades.csv")
    cols = ["signature", "block_time", "block_time_utc", "wallet", "side",
            "sol_amount_trader", "token_amount", "price_sol_per_token", "mcap_usd", "venue"]
    with open(f1, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        w.writerows(trades)

    buyers: dict[str, dict] = {}
    for t in trades:
        if t["side"] != "buy" or t["mcap_usd"] >= MCAP_THRESHOLD_USD:
            continue
        b = buyers.setdefault(t["wallet"], {
            "wallet": t["wallet"], "first_buy_time": t["block_time"],
            "first_buy_time_utc": t["block_time_utc"],
            "first_buy_mcap_usd": t["mcap_usd"], "n_buys_sub60k": 0,
            "sol_spent_sub60k": 0.0, "tokens_bought_sub60k": 0.0,
            # True when at least one sub-$60k buy landed at or before the first
            # crossing. A CPMM price is not monotone, so "bought below $60k" and
            # "bought early" are different claims; this column keeps them apart
            # in the data instead of leaving it to whoever reads the CSV.
            "bought_before_crossing": False})
        b["n_buys_sub60k"] += 1
        if t["block_time"] <= cross_bt:
            b["bought_before_crossing"] = True
        b["sol_spent_sub60k"] += t["sol_amount_trader"]
        b["tokens_bought_sub60k"] += t["token_amount"]

    f2 = os.path.join(DATA, "cyberleek_sub60k_buyers.csv")
    bcols = ["wallet", "first_buy_time", "first_buy_time_utc", "first_buy_mcap_usd",
             "n_buys_sub60k", "sol_spent_sub60k", "tokens_bought_sub60k",
             "bought_before_crossing"]
    with open(f2, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=bcols)
        w.writeheader()
        for b in sorted(buyers.values(), key=lambda x: x["first_buy_time"]):
            w.writerow(b)

    # ---- overlap with CATE ----
    cate_path = os.path.join(DATA, "cate_sub60k_buyers.csv")
    cate: set[str] = set()
    if os.path.exists(cate_path):
        with open(cate_path) as fh:
            for row in csv.DictReader(fh):
                cate.add(row["wallet"])
    overlap = sorted(set(buyers) & cate)

    buys = [t for t in trades if t["side"] == "buy"]
    sells = [t for t in trades if t["side"] == "sell"]

    print("\n" + "=" * 64)
    print(f"pool created            {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(POOL_CREATED))}")
    if crossing:
        print(f"crossing                {crossing['block_time_utc']}  "
              f"(+{crossing['block_time'] - POOL_CREATED}s = "
              f"{(crossing['block_time'] - POOL_CREATED)/60:.1f} min after creation)")
    else:
        print("crossing                NEVER — mcap stayed below $60,000")
    print(f"transactions examined   {total_txs:,}   pull ends {pulled_last_utc}")
    print(f"  swaps decoded (full)  {len(trades):,}   buys {len(buys):,} / sells {len(sells):,}")
    print(f"  of those, <= crossing {len(in_window):,}")
    print(f"  non-swap discarded    {non_swap:,}")
    if trades:
        print(f"mcap_usd at first trade ${trades[0]['mcap_usd']:,.0f}")
    print(f"mcap_usd at crossing    ${crossing['mcap_usd']:,.0f}" if crossing else "mcap_usd at crossing    n/a")
    dip_wallets = set(t["wallet"] for t in after_dip_rows)
    print(f"distinct sub-$60k buyers {len(buyers):,}   (ANY buy below $60k in the pulled window)")
    print(f"  before first crossing  {len(before_cross):,}")
    print(f"  added by later dips    {len(set(buyers) - before_cross):,} "
          f"(from {len(after_dip_rows):,} dip buys across {len(dip_wallets):,} wallets)")
    print(f"\nOVERLAP with CATE sub-$60k buyers: {len(overlap)} of {len(buyers)} "
          f"(CATE list has {len(cate)})")
    for w_ in overlap:
        print(f"    {w_}")
    if not overlap:
        print("    (none)")
    print(f"\nwrote {f1}  ({len(trades):,} rows)")
    print(f"wrote {f2}  ({len(buyers):,} rows)")
    print(f"\ncredits burned (RPC calls) {calls}")


if __name__ == "__main__":
    main()
