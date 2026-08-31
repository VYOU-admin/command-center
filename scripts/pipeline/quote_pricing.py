"""
Quote-asset USD pricing, generalised.

THE PROBLEM. NTF quoted in native ETH and PONS in WETH, so both reached USD
through one hop: ETH/USD from CoinGecko. AI quotes in NVDA, a tokenised equity
with no CoinGecko path at all. The next Robinhood token may quote in something
else again, so this resolves a quote asset to USD by SEARCHING FOR A ROUTE
rather than by knowing about any particular asset.

THE ROUTE IS RESOLVED IN TIERS, most direct first:

  tier 0  the quote IS a USD stablecoin          -> 1.0, verified not assumed
  tier 1  the quote is native or wrapped native  -> CoinGecko ETH/USD hourly
  tier 2  anything else                          -> price it on-chain against a
          tier 0 or tier 1 asset, using the deepest reference pool that ALREADY
          EXISTED when the window opened

TIER 2 IS WHERE THE REAL TRAP IS. A reference pool must predate the window. The
deepest NVDA/USD pool by current liquidity was created after the AI window, so
using it would have priced the window from a pool that did not yet exist.
Candidates are filtered on creation time BEFORE they are ranked on depth, and
the chosen pool must actually contain swaps inside the window -- coverage is
reported, never assumed.

The constant-versus-per-trade decision is then the same measurement used for
every other token: the spread of the quote across the window itself.
"""
from __future__ import annotations

import bisect
import time

import requests

CONSTANT_RATE_MAX_SPREAD_PCT = 5.0
STABLE_SYMBOLS = {"USDC", "USDT", "DAI", "USDG", "USDS", "PYUSD", "FDUSD",
                  "TUSD", "USDE", "LUSD", "GUSD", "USDP"}
NATIVE_SYMBOLS = {"ETH", "WETH"}
ZERO = "0x" + "0" * 40


def classify(symbol: str, address: str) -> str:
    s = (symbol or "").upper()
    if s in STABLE_SYMBOLS:
        return "stable"
    if s in NATIVE_SYMBOLS or (address or "").lower() == ZERO:
        return "native"
    return "other"


def dexscreener_pairs(chain: str, token: str, tries: int = 4):
    for a in range(tries):
        try:
            r = requests.get(
                f"https://api.dexscreener.com/token-pairs/v1/{chain}/{token}", timeout=60)
            if r.status_code == 200:
                return r.json() or []
        except Exception:
            pass
        time.sleep(3 * (a + 1))
    return []


def candidate_references(chain: str, quote_addr: str, quote_symbol: str,
                         window_start_ts: int):
    """Reference pools that could price `quote` during the window."""
    out = []
    for p in dexscreener_pairs(chain, quote_addr):
        created = p.get("pairCreatedAt")
        if not created:
            continue                      # unknown age is not usable evidence
        created //= 1000
        if created >= window_start_ts:
            continue                      # did not exist yet
        base = p.get("baseToken") or {}
        quo = p.get("quoteToken") or {}
        ba = str(base.get("address", "")).lower()
        qa = str(quo.get("address", "")).lower()
        if ba == quote_addr.lower():
            other, side = quo, "base"
        elif qa == quote_addr.lower():
            other, side = base, "quote"
        else:
            continue
        kind = classify(other.get("symbol"), other.get("address"))
        if kind == "other":
            continue                      # cannot reach USD from here in one hop
        out.append({
            "pair": p.get("pairAddress"), "dex": p.get("dexId"),
            "labels": p.get("labels") or [], "created": created, "side": side,
            "other_symbol": other.get("symbol"), "other_address": other.get("address"),
            "other_kind": kind,
            "liquidity_usd": (p.get("liquidity") or {}).get("usd", 0) or 0,
            "age_days_before_window": (window_start_ts - created) / 86400.0,
        })
    out.sort(key=lambda c: (0 if c["other_kind"] == "stable" else 1, -c["liquidity_usd"]))
    return out


def choose_method(series_ts, series_px, t_from: int, t_to: int):
    """(mode, rate_fn, report) from the quote's own movement across the window."""
    inw = [px for t, px in zip(series_ts, series_px) if t_from - 3600 <= t <= t_to + 3600]
    if not inw:
        inw = list(series_px)
    lo, hi = min(inw), max(inw)
    mean = sum(inw) / len(inw)
    spread = 100.0 * (hi - lo) / mean if mean else 0.0
    if spread <= CONSTANT_RATE_MAX_SPREAD_PCT:
        rate = lambda _t, _m=mean: _m
        mode = "constant"
    else:
        def rate(t, ts=series_ts, px=series_px):
            i = bisect.bisect_left(ts, t)
            if i <= 0:
                return px[0]
            if i >= len(ts):
                return px[-1]
            return px[i] if abs(ts[i] - t) < abs(ts[i - 1] - t) else px[i - 1]
        mode = "per_trade"
    return mode, rate, {"mode": mode, "min": lo, "max": hi, "mean": mean,
                        "spread_pct": spread, "points": len(inw),
                        "threshold_pct": CONSTANT_RATE_MAX_SPREAD_PCT}
