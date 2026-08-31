"""
EVM: Uniswap V4 via the PoolManager singleton (Robinhood chain 4663).

FOUR LOCKED CONSTRAINTS, each of which cost a wrong answer to find:

1. tx.from IS NOT THE TRADER. Measured on this chain: of 167 single-counterparty
   transactions only 84 had the counterparty equal to tx.from. Smart-account
   wallets and ERC-4337 bundlers make the signer a relayer. Attribution comes
   from token balance deltas.

2. ROUTER ORDER-SPLITTING. A router routes one order through several V4 pools of
   the same token; we index one poolId. The wallet then receives the combined
   total, and attributing it to our swap inflated by up to 1381x. The correct
   basis is the swap's own pool amount minus its own fee. 6.8% of transactions
   move more of the token through the PoolManager than our swaps account for.

3. CIRCULAR ARB. Where the PoolManager both sends and receives the token in one
   transaction, the token cycles PoolManager -> router -> PoolManager and the
   attributed wallet receives only a residual tip. 5.2% of NTF rows. The wallet
   identity itself is wrong there, not just the amount, so those rows are
   excluded rather than corrected.

4. THE QUOTE ASSET IS NOT ASSUMED. NTF's quote was NATIVE ETH (address zero),
   not WETH: no WETH contract appeared in any swap and the trader paid tx.value.
   Initialize carries currency0/currency1 as indexed topics, so it is read.
"""
from __future__ import annotations

from collections import defaultdict

ZERO32 = "0x" + "0" * 64
ZERO_ADDR = "0x" + "0" * 40
INITIALIZE = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438"
SWAP = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"
DEC = 10 ** 18

pad = lambda a: "0x" + "0" * 24 + a[2:].lower()
addr_of = lambda t: "0x" + t[-40:].lower()


def i128(word: str) -> int:
    v = int(word, 16) & ((1 << 128) - 1)
    return v - (1 << 128) if v >= (1 << 127) else v


def get_logs(rpc, frm, to, address, topics):
    """Splits on size or timeout rather than skipping — a skipped window is
    missing data, which cost 66% of one dataset before this was added."""
    res, err = rpc.call("eth_getLogs", [{"fromBlock": hex(frm), "toBlock": hex(to),
                                        "address": address, "topics": topics}])
    if err is None:
        return res or []
    if ("exceeds limit" in err or "timed out" in err) and to > frm:
        mid = (frm + to) // 2
        return get_logs(rpc, frm, mid, address, topics) + get_logs(rpc, mid + 1, to, address, topics)
    raise SystemExit(f"eth_getLogs {frm}-{to}: {err}")


def call(rpc, to, data):
    res, _ = rpc.call("eth_call", [{"to": to, "data": data}, "latest"])
    return res


def _decode_string(hexs):
    if not hexs or hexs == "0x":
        return None
    try:
        b = hexs[2:]
        ln = int(b[64:128], 16)
        if not 0 < ln <= 512:
            return None
        return bytes.fromhex(b[128:128 + ln * 2]).decode("utf8", "replace").strip("\x00").strip()
    except Exception:
        return None


def discover(rpc, token: str, pool_manager: str, from_block: int, log=print):
    """Every V4 pool holding this token, from Initialize events."""
    head_hex, err = rpc.call("eth_blockNumber", [])
    if err:
        raise SystemExit(f"eth_blockNumber: {err}")
    head = int(head_hex, 16)
    pools = {}
    for slot in (2, 3):                       # currency0 or currency1
        topics = [INITIALIZE] + [None] * (slot - 1) + [pad(token)]
        for l in get_logs(rpc, from_block, head, pool_manager, topics):
            pools[l["topics"][1].lower()] = {
                "block": int(l["blockNumber"], 16),
                "currency0": addr_of(l["topics"][2]),
                "currency1": addr_of(l["topics"][3]),
            }
    if not pools:
        raise SystemExit(
            f"NO UNISWAP V4 POOL FOUND for {token} on PoolManager {pool_manager} "
            f"from block {from_block}. Refusing to guess a venue.")
    dec = call(rpc, token, "0x313ce567")
    decimals = int(dec, 16) if dec and dec != "0x" else 18
    name = _decode_string(call(rpc, token, "0x06fdde03"))
    sym = _decode_string(call(rpc, token, "0x95d89b41"))
    sup = call(rpc, token, "0x18160ddd")
    supply = int(sup, 16) / (10 ** decimals) if sup and sup != "0x" else 0.0
    log(f"  token {name} ({sym})  decimals {decimals}  supply {supply:,.0f}")
    log(f"  pools found: {len(pools)}")
    # The pool with the most swaps is the primary; the rest are reported so the
    # coverage fraction is visible rather than implied.
    counts = {}
    for pid in pools:
        counts[pid] = len(get_logs(rpc, from_block, head, pool_manager, [SWAP, pid]))
    primary = max(counts, key=lambda k: counts[k])
    total = sum(counts.values()) or 1
    other = pools[primary]["currency0"] if pools[primary]["currency1"] == token.lower() \
        else pools[primary]["currency1"]
    quote_native = other == ZERO_ADDR
    quote = {"symbol": "ETH" if quote_native else "?", "address": other,
             "decimals": 18, "native": quote_native}
    if not quote_native:
        qs = _decode_string(call(rpc, other, "0x95d89b41"))
        qd = call(rpc, other, "0x313ce567")
        quote = {"symbol": qs or "?", "address": other,
                 "decimals": int(qd, 16) if qd and qd != "0x" else 18, "native": False}
    log(f"  primary pool {primary}  swaps {counts[primary]:,} of {total:,} "
        f"({100*counts[primary]/total:.1f}% of this token's V4 activity)")
    log(f"  quote asset: {quote['symbol']} {quote['address']} decimals {quote['decimals']}"
        f"{' (native)' if quote_native else ''}")
    return {"venue": "uniswap_v4", "token": token.lower(), "pool_manager": pool_manager,
            "pools": pools, "primary": primary, "swap_counts": counts,
            "coverage_pct": 100.0 * counts[primary] / total, "quote": quote,
            "decimals": decimals, "supply_whole": supply, "name": name, "symbol": sym,
            "head": head}


def transfers_of(receipt: dict, token: str):
    return [(addr_of(l["topics"][1]), addr_of(l["topics"][2]), int(l["data"], 16) / DEC)
            for l in (receipt.get("logs") or [])
            if l["address"].lower() == token and l["topics"][0].lower() == TRANSFER
            and len(l["topics"]) >= 3]


def is_circular(receipt: dict, token: str, pool_manager: str) -> bool:
    """PoolManager both sends and receives the token: the attributed wallet is a
    tip recipient, not the trader."""
    t = transfers_of(receipt, token)
    pm = pool_manager.lower()
    return any(a == pm for a, _, _ in t) and any(b == pm for _, b, _ in t)


def trader_amount(pool_amount: float, side: str, fee_buy: float, fee_sell: float) -> float:
    """
    The swap's own pool amount minus its own fee — NOT the wallet's net.

    The wallet's net across a router-split transaction includes pools we do not
    index, which is the 1381x inflation. The pool amount is stated exactly by
    the Swap event and is attributable to this swap alone.
    """
    fee = fee_buy if side == "buy" else fee_sell
    return max(0.0, pool_amount * (1.0 - fee))
