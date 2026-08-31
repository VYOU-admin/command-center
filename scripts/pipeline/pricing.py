"""
Quote/USD pricing, supply reconstruction, and fee measurement.

THE USD METHOD IS CHOSEN FROM THE TOKEN'S OWN WINDOW, never assumed. Measured:
NTF traded for 6 hours while ETH moved 0.8%, so a constant misprices the cohort
total by $104 on $778k. CATE traded for 31 days while SOL moved 39%, and a
constant misprices 21% of wallets by over 5% and the cohort total by 3.3%;
CYBERLEEK over 13 days and 38.8% was worse still at 92% and 8.1%. So the rule is
a measurement, not a preference.

SUPPLY IS NOT FLAT. NTF burned 49.2M of 1B across its window — 4.9% — so a
constant supply overstates late mcap by that much. Supply is walked backwards
from the current total through mint/burn events.
"""
from __future__ import annotations

import bisect
import time
from typing import Callable

import requests

# Above this spread across the trading window, a single rate is not defensible.
CONSTANT_RATE_MAX_SPREAD_PCT = 5.0


def fetch_hourly(coin: str, t_from: int, t_to: int, tries: int = 4):
    """(timestamps, prices) hourly from CoinGecko. Free tier caps the range."""
    for attempt in range(tries):
        try:
            r = requests.get(
                f"https://api.coingecko.com/api/v3/coins/{coin}/market_chart/range",
                params={"vs_currency": "usd", "from": t_from - 7200, "to": t_to + 7200},
                timeout=90)
            pts = (r.json() or {}).get("prices") or []
            if pts:
                pts.sort(key=lambda p: p[0])
                return [int(p[0] / 1000) for p in pts], [float(p[1]) for p in pts]
        except Exception:
            pass
        time.sleep(5 * (attempt + 1))
    raise SystemExit(f"CoinGecko returned no {coin} prices for {t_from}..{t_to}")


def choose_usd_method(coin: str, t_from: int, t_to: int):
    """
    Returns (mode, rate_fn, report). mode is 'constant' or 'per_trade'.

    The decision is the spread across the window, not the window's length: a
    long quiet window can still take a constant, a short violent one cannot.
    """
    ts, px = fetch_hourly(coin, t_from, t_to)
    lo, hi = min(px), max(px)
    mean = sum(px) / len(px)
    spread = 100.0 * (hi - lo) / mean if mean else 0.0
    days = (t_to - t_from) / 86400.0

    def at(t: int) -> float:
        i = bisect.bisect_left(ts, t)
        if i <= 0:
            return px[0]
        if i >= len(ts):
            return px[-1]
        return px[i] if abs(ts[i] - t) < abs(ts[i - 1] - t) else px[i - 1]

    if spread <= CONSTANT_RATE_MAX_SPREAD_PCT:
        mode = "constant"
        fn: Callable[[int], float] = lambda _t: mean
        basis = (f"constant {mean:,.2f} USD/{coin} (CoinGecko market_chart/range, "
                 f"{len(px)} hourly points; the quote moved {spread:.1f}% across "
                 f"the {days:.2f}-day window, under the {CONSTANT_RATE_MAX_SPREAD_PCT}% bar)")
    else:
        mode = "per_trade"
        fn = at
        basis = (f"hourly {coin}/USD at each trade (CoinGecko market_chart/range, "
                 f"{len(px)} hourly points spanning {days:.2f} days; the quote moved "
                 f"{spread:.1f}%, over the {CONSTANT_RATE_MAX_SPREAD_PCT}% bar, so a "
                 f"single rate would misprice systematically)")
    report = {"mode": mode, "min": lo, "max": hi, "mean": mean, "spread_pct": spread,
              "points": len(px), "days": days, "basis": basis}
    return mode, fn, report


class SupplyCurve:
    """Total supply at a block/slot, reconstructed from mint and burn events."""

    def __init__(self, current: float, events: list[tuple[int, float]]):
        self.events = sorted(events)
        self._keys = [e[0] for e in self.events]
        self._cum: list[float] = []
        c = 0.0
        for _, d in self.events:
            c += d
            self._cum.append(c)
        total_delta = c
        self.at_start = current - total_delta
        self.current = current
        self.flat = abs(total_delta) < 1.0

    def at(self, key: int) -> float:
        i = bisect.bisect_right(self._keys, key) - 1
        return self.at_start + (self._cum[i] if i >= 0 else 0.0)

    def describe(self) -> str:
        if self.flat:
            return f"supply flat at {self.current:,.0f} across the window"
        return (f"supply moved {self.at_start:,.0f} -> {self.at(self._keys[-1]) if self._keys else self.current:,.0f} "
                f"across {len(self.events)} mint/burn events")


def measure_fee_rate(single_swap_trades) -> dict:
    """
    Fee taken from each side, measured rather than assumed.

    NTF charged exactly 2.0000% on buys at both the 1st and 99th percentile and
    nothing on sells, but that is a property of that token's hook, not a
    constant of the venue. Only unambiguous single-swap transactions are used,
    because a multi-swap transaction cannot say which fee leg belongs to which
    swap.
    """
    import statistics
    buys = [r for r in single_swap_trades if r["side"] == "buy" and r.get("fee_frac") is not None]
    sells = [r for r in single_swap_trades if r["side"] == "sell" and r.get("fee_frac") is not None]
    def summarise(rows):
        if not rows:
            return {"n": 0, "median": 0.0, "p1": 0.0, "p99": 0.0}
        v = sorted(r["fee_frac"] for r in rows)
        return {"n": len(v), "median": statistics.median(v),
                "p1": v[len(v) // 100], "p99": v[min(len(v) - 1, 99 * len(v) // 100)]}
    b, s = summarise(buys), summarise(sells)
    flat_buy = b["n"] > 0 and abs(b["p99"] - b["p1"]) < 1e-6
    return {"buy": b, "sell": s, "buy_is_flat": flat_buy,
             "buy_rate": b["median"] if flat_buy else b["median"],
             "sell_rate": s["median"]}
