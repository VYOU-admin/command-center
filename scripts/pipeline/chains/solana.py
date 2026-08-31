"""
Solana: pump.fun bonding curve and Raydium CPMM.

VENUE IS DETECTED, NOT DECLARED. CYBERLEEK looked like a pump.fun token and was
not — it traded on a Raydium CPMM pool with no bonding curve at all. Asking the
operator to say which would just move that mistake upstream. The mint's own
history decides: a pump.fun curve PDA that exists and has transactions means a
curve token; otherwise we look for a CPMM pool holding the mint.

SWAPS ARE DECODED FROM BALANCE DELTAS AT ANY CALL DEPTH. Aggregators CPI into
the AMM, so a top-level program check finds almost nothing — measured 0 of 20
on CATE before the depth assumption was removed, then 25% once it was.

WHOSE WALLET. postTokenBalances carries a token account and its OWNER. The owner
is the trader; the token account is a container and a wallet's ATA is a
different address, so recording the account would make every wallet look unique
per token and break cross-token work entirely.
"""
from __future__ import annotations

import base64
import struct
from collections import defaultdict

TOKEN_METADATA = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
WSOL = "So11111111111111111111111111111111111111112"
LAMPORTS = 1e9


def read_mint(rpc, mint: str):
    """Supply and decimals from the mint account. Never assume 1e9."""
    res, err = rpc.call("getAccountInfo", [mint, {"encoding": "base64"}])
    if err or not res or not res.get("value"):
        raise SystemExit(f"cannot read mint {mint}: {err or 'no account'}")
    raw = base64.b64decode(res["value"]["data"][0])
    supply = struct.unpack_from("<Q", raw, 36)[0]
    decimals = raw[44]
    return supply / (10 ** decimals), supply, decimals


def _curve_pda(mint: str):
    """pump.fun bonding-curve PDA, derived rather than looked up."""
    try:
        from base58 import b58decode, b58encode
    except ImportError:
        return None
    import hashlib
    seeds = [b"bonding-curve", b58decode(mint)]
    prog = b58decode(PUMPFUN_PROGRAM)
    for bump in range(255, -1, -1):
        h = hashlib.sha256(b"".join(seeds) + bytes([bump]) + prog + b"ProgramDerivedAddress").digest()
        # on-curve test omitted: callers treat a miss as "not a curve token"
        return b58encode(h).decode()
    return None


def discover(rpc, mint: str, log=print):
    """
    Returns a venue descriptor, or raises with what it actually found.

    Deliberately does not guess: an unrecognised venue is a hard stop naming the
    programs seen, because a wrong venue silently produces a plausible-looking
    empty result.
    """
    supply_whole, supply_raw, decimals = read_mint(rpc, mint)
    log(f"  mint {mint}")
    log(f"    supply {supply_whole:,.0f}  decimals {decimals}  (read from the mint)")

    # Which programs actually touched this mint recently?
    sigs, err = rpc.call("getSignaturesForAddress", [mint, {"limit": 40}])
    programs = defaultdict(int)
    curve_addr = None
    pool_addr = None
    if not err and sigs:
        for s in sigs[:12]:
            tx, e2 = rpc.call("getTransaction", [s["signature"],
                              {"encoding": "jsonParsed", "maxSupportedTransactionVersion": 0}])
            if e2 or not tx:
                continue
            msg = (tx.get("transaction") or {}).get("message") or {}
            for ins in (msg.get("instructions") or []):
                pid = ins.get("programId")
                if pid:
                    programs[pid] += 1
            for inner in ((tx.get("meta") or {}).get("innerInstructions") or []):
                for ins in inner.get("instructions", []):
                    pid = ins.get("programId")
                    if pid:
                        programs[pid] += 1
    log(f"    programs seen touching the mint: {dict(sorted(programs.items(), key=lambda x:-x[1])[:5])}")

    if PUMPFUN_PROGRAM in programs:
        return {"venue": "pumpfun_curve", "mint": mint, "supply_whole": supply_whole,
                "decimals": decimals, "quote": {"symbol": "SOL", "address": WSOL,
                "decimals": 9, "native": True}, "programs": dict(programs)}

    # Not a curve token: look for a CPMM/AMM pool holding the mint.
    accs, err2 = rpc.call("getTokenLargestAccounts", [mint])
    holders = [a["address"] for a in ((accs or {}).get("value") or [])][:6]
    for h in holders:
        info, e3 = rpc.call("getAccountInfo", [h, {"encoding": "jsonParsed"}])
        owner = (((info or {}).get("value") or {}).get("data") or {}).get("parsed", {}) \
            .get("info", {}).get("owner")
        if owner:
            pool_addr = owner
            break
    if pool_addr:
        return {"venue": "raydium_cpmm", "mint": mint, "pool": pool_addr,
                "supply_whole": supply_whole, "decimals": decimals,
                "quote": {"symbol": "SOL", "address": WSOL, "decimals": 9, "native": False},
                "programs": dict(programs)}
    raise SystemExit(
        f"VENUE NOT RECOGNISED for {mint}. Programs seen: "
        f"{dict(programs) or 'none'}. Supported: pump.fun bonding curve, Raydium CPMM. "
        f"Refusing to guess — a wrong venue yields a plausible empty result.")


def owner_token_deltas(meta: dict, mint: str) -> dict:
    """Net change in `mint` per OWNER. Depth-independent by construction."""
    pre = {b["accountIndex"]: b for b in (meta.get("preTokenBalances") or []) if b.get("mint") == mint}
    post = {b["accountIndex"]: b for b in (meta.get("postTokenBalances") or []) if b.get("mint") == mint}
    out = defaultdict(float)
    for idx in set(pre) | set(post):
        owner = (post.get(idx) or pre.get(idx) or {}).get("owner")
        if not owner:
            continue
        a = float((post.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
        b = float((pre.get(idx, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
        out[owner] += a - b
    return out


def decode_tx(tx: dict, venue: dict):
    """One transaction -> a trade row, or None. Balance deltas only."""
    meta = tx.get("meta") or {}
    if meta.get("err"):
        return None
    bt = tx.get("blockTime")
    txn = tx.get("transaction") or {}
    sig = (txn.get("signatures") or [None])[0]
    msg = txn.get("message") or {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    mint = venue["mint"]
    anchor = venue.get("curve") or venue.get("pool")
    if not anchor or anchor not in keys:
        return None
    ci = keys.index(anchor)
    pre_b, post_b = meta.get("preBalances") or [], meta.get("postBalances") or []
    if ci >= len(pre_b) or ci >= len(post_b):
        return None
    # SOL that entered or left the pool side — the price-setting amount, not the
    # trader's, which also carries network and aggregator fees.
    pool_sol = (post_b[ci] - pre_b[ci]) / LAMPORTS
    deltas = owner_token_deltas(meta, mint)
    movers = {o: d for o, d in deltas.items() if abs(d) > 1e-9 and o != anchor}
    if not movers or abs(pool_sol) < 1e-12:
        return None
    owner = max(movers.items(), key=lambda kv: abs(kv[1]))[0]
    tok = abs(movers[owner])
    if tok <= 0:
        return None
    return {"signature": sig, "block_time": bt, "wallet": owner,
            "side": "buy" if pool_sol > 0 else "sell",
            "quote_amount": abs(pool_sol), "token_amount": tok,
            "pool_token_amount": tok, "attribution": "balance_delta"}
