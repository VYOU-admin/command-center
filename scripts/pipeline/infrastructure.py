"""
Addresses that must never be attributed a trade.

Loaded from config/infrastructure.yaml so the list can be extended without
touching decode code.

THE BUG THIS PREVENTS. The exclusion used to be venue-scoped: a v4 run excluded
the v4 PoolManager because it happened to be the venue, and a v3 run excluded
nothing of the sort. Routers hop through the v4 PoolManager while trading a v3
pool, so it accumulated PONS and entered that cohort as a trader holding 19.8%
of the token's unrealized total. The general form is that an exclusion list
scoped to one venue will silently fail on another, so this list is global.

Applied AT THE CANDIDATE STAGE, before cohort selection: an excluded address
never becomes a row, rather than being filtered out afterwards.
"""
from __future__ import annotations

import os
import yaml

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_PATH = os.path.join(_ROOT, "config", "infrastructure.yaml")


def load(chain: str = "robinhood"):
    """[(address_lowercase, label, reason)] for this chain."""
    with open(_PATH) as fh:
        cfg = yaml.safe_load(fh) or {}
    rows = ((cfg.get("chains") or {}).get(chain) or [])
    return [(str(r["address"]).lower(), r.get("label", ""), " ".join(
        str(r.get("reason", "")).split())) for r in rows]


def excluded_set(chain: str = "robinhood", extra=()):
    """
    The set to test attribution candidates against.

    `extra` carries the per-run additions the file deliberately does not hold:
    the tracked pool contract, and the round-trippers detected for that token.
    """
    s = {a for a, _l, _r in load(chain)}
    for x in extra:
        if x:
            s.add(str(x).lower())
    return s


def describe(chain: str = "robinhood") -> str:
    return "\n".join(f"  {a}  {l}\n      {r}" for a, l, r in load(chain))
