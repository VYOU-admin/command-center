"""
Venue differences, in one place.

  v3  each pool is its own contract, so the pool address IS the log address and
      amount0/amount1 are int256 from the POOL's perspective: positive means the
      token came into the pool.
  v4  one PoolManager singleton, so the pool is a bytes32 poolId in topic1 and
      amounts are int128 from the SWAPPER's perspective: positive means the
      swapper received.

The int128 amounts are ABI sign-extended into 32-byte words and MUST be masked
to the low 128 bits before the sign test. Without the mask a negative amount
decodes as roughly 10^60.
"""
from __future__ import annotations


def i256(word: str) -> int:
    v = int(word, 16)
    return v - (1 << 256) if v >= (1 << 255) else v


def i128(word: str) -> int:
    v = int(word, 16) & ((1 << 128) - 1)
    return v - (1 << 128) if v >= (1 << 127) else v


class Venue:
    """Everything that differs between v3 and v4 for one tracked pool."""

    def __init__(self, version: str, pool: str, base: str, quote: str,
                 pool_manager: str, topics: dict):
        self.version = version
        self.pool = pool.lower()
        self.base = base.lower()
        self.quote = quote.lower()
        self.pm = (pool_manager or "").lower()
        self.topics = topics
        if version not in ("v3", "v4"):
            raise SystemExit(f"unsupported venue version {version!r}")
        # Currency order is by address on both versions.
        self.base_index = 0 if self.base < self.quote else 1

    # ---- where the swap logs live -------------------------------------------
    @property
    def log_address(self) -> str:
        return self.pool if self.version == "v3" else self.pm

    @property
    def log_topics(self):
        if self.version == "v3":
            return [self.topics["swap_v3"]]
        return [self.topics["swap_v4"], self.pool]

    @property
    def venue_address(self) -> str:
        """The contract that is one side of every swap: the arb/tip counterparty."""
        return self.pool if self.version == "v3" else self.pm

    # ---- decoding ------------------------------------------------------------
    def amounts(self, data_hex: str):
        """(base_amount, quote_amount) as signed integers, raw units."""
        d = data_hex[2:] if data_hex.startswith("0x") else data_hex
        conv = i256 if self.version == "v3" else i128
        a0, a1 = conv(d[0:64]), conv(d[64:128])
        return (a0, a1) if self.base_index == 0 else (a1, a0)

    def side(self, base_amount: int) -> str:
        """
        v3 amounts are pool-perspective: base leaving the pool is a buy.
        v4 amounts are swapper-perspective: base arriving at the swapper is a buy.
        """
        if self.version == "v3":
            return "buy" if base_amount < 0 else "sell"
        return "buy" if base_amount > 0 else "sell"
