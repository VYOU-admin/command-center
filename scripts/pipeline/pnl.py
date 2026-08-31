"""
FIFO realized PnL in native and USD, and the validation checks that go with it.

FIFO, NOT NET FLOW. CATE originally stored net flow (SOL out - SOL in), which
matches FIFO only when every lot is consumed. Where a sell precedes the buy that
funds it, FIFO treats those proceeds as zero-basis and leaves the later buy
unmatched, and the two diverge — 38 of 556 CATE wallets, by up to 198 SOL. The
byte-identical check is what surfaced that; keep it.

UNSOLD INVENTORY IS WORTH ZERO and reported through remaining_tokens rather than
marked to market. The question is what came off the table, not what a position
might fetch.

ORDERING MATTERS. Ties on block time must break deterministically, or the same
input produces different lots on different runs. Sort by (time, signature).
"""
from __future__ import annotations

from collections import defaultdict, deque


def fifo_wallet(trades, rate_fn):
    """
    One wallet's trades -> its PnL row fields.

    trades: dicts with block_time, side, quote_amount, token_amount, signature.
    rate_fn: block_time -> quote/USD.
    """
    rows = sorted(trades, key=lambda t: (int(t["block_time"]), t.get("signature") or ""))
    lots: deque = deque()          # [qty, quote_per_token, usd_rate_at_buy]
    realized = realized_usd = 0.0
    bought = sold = quote_in = quote_out = 0.0
    buys = sells = 0
    zero_basis_tokens = 0.0
    first_buy = None
    last_sell = None
    for t in rows:
        q = float(t["quote_amount"] or 0)
        tk = float(t["token_amount"] or 0)
        if tk <= 0 or q <= 0:
            continue
        bt = int(t["block_time"])
        rate = rate_fn(bt)
        if t["side"] == "buy":
            if first_buy is None:
                first_buy = t
            lots.append([tk, q / tk, rate])
            bought += tk
            quote_in += q
            buys += 1
        else:
            px = q / tk
            left = tk
            sold += tk
            quote_out += q
            sells += 1
            last_sell = t
            while left > 1e-12 and lots:
                lot = lots[0]
                take = min(left, lot[0])
                realized += take * (px - lot[1])
                realized_usd += take * (px * rate - lot[1] * lot[2])
                lot[0] -= take
                left -= take
                if lot[0] <= 1e-12:
                    lots.popleft()
            if left > 1e-12:
                # Tokens acquired before our window: no basis to subtract. This
                # inflates PnL by an unknown amount, which is why the wallet is
                # flagged rather than silently credited.
                zero_basis_tokens += left
                realized += left * px
                realized_usd += left * px * rate
    return {
        "n_buys": buys, "n_sells": sells,
        "tokens_bought": bought, "tokens_sold": sold,
        "remaining_tokens": max(0.0, bought - sold),
        "quote_in": quote_in, "quote_out": quote_out,
        "realized_native": realized, "realized_usd": realized_usd,
        "zero_basis_tokens": zero_basis_tokens,
        "pre_window_entry": zero_basis_tokens > 1.0,
        "first_buy": first_buy, "last_sell": last_sell,
        "sold_out": sold > 0 and (bought - sold) <= 1e-6,
    }


def validate(trades_by_wallet, fee_rate_buy, fee_rate_sell):
    """
    The checks that caught real bugs, run every time rather than on suspicion.

    The skim band is derived from the measured fee, not hardcoded: a token with
    no fee should sit at 1.0 on both sides, and one with a 2% buy fee at 0.98.
    """
    out = defaultdict(lambda: {"n": 0, "out_of_band": 0})
    band_buy = 1.0 - fee_rate_buy
    band_sell = 1.0 - fee_rate_sell
    tol = 0.0005
    over_sell = []
    zero_amounts = 0
    for w, trades in trades_by_wallet.items():
        b = s = 0.0
        for t in trades:
            path = t.get("attribution", "unknown")
            pool = float(t.get("pool_token_amount") or 0)
            tr = t.get("token_amount")
            if pool <= 0 or float(t.get("quote_amount") or 0) <= 0:
                zero_amounts += 1
            if tr is not None and pool > 0:
                k = f"{path}|{t['side']}"
                out[k]["n"] += 1
                ratio = float(tr) / pool
                target = band_buy if t["side"] == "buy" else band_sell
                if abs(ratio - target) > tol:
                    out[k]["out_of_band"] += 1
            if t["side"] == "buy":
                b += float(tr or 0)
            else:
                s += float(tr or 0)
        if s > b + 1:
            over_sell.append((w, b, s))
    return {"bands": dict(out), "over_sellers": over_sell, "zero_amounts": zero_amounts}
