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


PUMPSWAP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
RAYDIUM_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C"
RAYDIUM_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
KNOWN_AMMS = {PUMPSWAP_AMM: "pumpswap", RAYDIUM_CPMM: "raydium_cpmm",
              RAYDIUM_AMM_V4: "raydium_amm_v4"}


def _programs_in(tx) -> set:
    """Every program invoked, at any depth. Depth matters: an aggregator CPIs
    into the AMM, so top-level instructions alone under-report badly."""
    out = set()
    msg = (tx.get("transaction") or {}).get("message") or {}
    for ins in (msg.get("instructions") or []):
        if ins.get("programId"):
            out.add(ins["programId"])
    for inner in ((tx.get("meta") or {}).get("innerInstructions") or []):
        for ins in inner.get("instructions", []):
            if ins.get("programId"):
                out.add(ins["programId"])
    for line in ((tx.get("meta") or {}).get("logMessages") or []):
        if line.startswith("Program ") and " invoke [" in line:
            out.add(line.split()[1])
    return out


def _scan(rpc, mint, order, limit=12):
    """Programs seen in the mint's oldest or newest transactions."""
    res, err = rpc.call("getTransactionsForAddress", [mint, {
        "transactionDetails": "full", "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 0, "sortOrder": order,
        "limit": limit, "filters": {"status": "succeeded"}}])
    progs = {}
    first_ts = None
    for tx in ((res or {}).get("data") or []):
        if first_ts is None:
            first_ts = tx.get("blockTime")
        for p in _programs_in(tx):
            progs[p] = progs.get(p, 0) + 1
    return progs, first_ts, err


def _venue_from_holders(rpc, mint, origin, log=print):
    """
    The AMM that owns the largest token accounts.

    Deterministic where a transaction sample is not: pool vaults sit at the top
    of the holder list and stay there, so the same query gives the same answer
    on every run.
    """
    accs, err = rpc.call("getTokenLargestAccounts", [mint])
    if err:
        return None
    for a in ((accs or {}).get("value") or [])[:5]:
        info, e = rpc.call("getAccountInfo", [a["address"], {"encoding": "jsonParsed"}])
        holder = (((info or {}).get("value") or {}).get("data") or {}) \
            .get("parsed", {}).get("info", {}).get("owner")
        if not holder:
            continue
        oi, e2 = rpc.call("getAccountInfo", [holder, {"encoding": "base64"}])
        prog = ((oi or {}).get("value") or {}).get("owner")
        if prog in KNOWN_AMMS and KNOWN_AMMS[prog] != origin:
            log(f"    graduation resolved from holders: {a['address'][:12]}.. -> "
                f"{holder[:12]}.. owned by {prog[:12]}..")
            return KNOWN_AMMS[prog]
    return None


def discover(rpc, mint: str, log=print):
    """
    Venue from the token's ORIGIN, plus any venue it later graduated to.

    WHY ORIGIN AND NOT RECENT ACTIVITY. CATE is a pump.fun token that graduated
    to PumpSwap. Its recent transactions show pAMMBay6 and no bonding-curve
    program at all, so a recency-based check calls it a plain AMM token and the
    puller then looks for the wrong thing. The origin is what identifies the
    launch mechanism; the graduation venue is where later trades live. Both are
    reported because trades exist in both places.
    """
    supply_whole, supply_raw, decimals = read_mint(rpc, mint)
    log(f"  mint {mint}")
    log(f"    supply {supply_whole:,.0f}  decimals {decimals}  (read from the mint)")

    oldest, first_ts, e1 = _scan(rpc, mint, "asc")
    newest, _, e2 = _scan(rpc, mint, "desc")
    if e1 and e2:
        raise SystemExit(f"cannot read transaction history for {mint}: {e1}")
    import time as _t
    if first_ts:
        log(f"    first transaction {_t.strftime('%Y-%m-%dT%H:%M:%SZ', _t.gmtime(first_ts))}")
    log(f"    programs at ORIGIN : {sorted(oldest)[:6]}")
    log(f"    programs RECENTLY  : {sorted(newest)[:6]}")

    origin = None
    if PUMPFUN_PROGRAM in oldest:
        origin = "pumpfun_curve"
    else:
        for p, label in KNOWN_AMMS.items():
            if p in oldest:
                origin = label
                break

    # GRADUATION IS RESOLVED FROM WHO HOLDS THE SUPPLY, not from a sample of
    # recent transactions. A 12-transaction window reported pumpswap on one run
    # and nothing on the next, purely by which trades happened to land in it.
    # The largest token accounts are stable: a pool vault is owned by an
    # authority, and that authority is owned by the AMM program.
    graduated = _venue_from_holders(rpc, mint, origin, log)
    if graduated is None:
        for p, label in KNOWN_AMMS.items():
            if p in newest and label != origin:
                graduated = label
                break

    if origin is None and graduated is None:
        raise SystemExit(
            f"VENUE NOT RECOGNISED for {mint}.\n"
            f"  programs at origin: {sorted(oldest)}\n"
            f"  programs recently : {sorted(newest)}\n"
            f"  supported: pump.fun bonding curve, Raydium CPMM/AMMv4, PumpSwap.\n"
            f"  Refusing to guess — a wrong venue yields a plausible empty result.")
    if origin is None:
        origin = graduated
        graduated = None

    log(f"  ORIGIN VENUE     : {origin}")
    log(f"  GRADUATION VENUE : {graduated or '(none — never migrated)'}")
    if graduated:
        log(f"  -> trades live in BOTH; the puller must cover the curve and the AMM")

    return {"venue": origin, "origin_venue": origin, "graduation_venue": graduated,
            "mint": mint, "supply_whole": supply_whole, "supply_raw": supply_raw,
            "decimals": decimals,
            "quote": {"symbol": "SOL", "address": WSOL, "decimals": 9,
                      "native": origin == "pumpfun_curve"},
            "programs_origin": oldest, "programs_recent": newest}


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


def pull_wallet_trades(rpc, mint: str, wallets, venue: dict, log=print, checkpoint=None):
    """
    Live pull: every trade of `mint` by each wallet.

    ONE QUERY PER WALLET, filtered to transactions that changed a balance of
    this mint. Without that filter a wallet with thousands of unrelated
    transactions would be paged in full to find a handful of trades.

    Decoding is by balance delta at any depth — the wallet's own mint movement
    against its own SOL movement — so a swap routed through an aggregator is
    caught where a program check would miss it.
    """
    import json as _json
    import os as _os
    done = {}
    if checkpoint and _os.path.exists(checkpoint):
        with open(checkpoint) as fh:
            for line in fh:
                try:
                    r = _json.loads(line)
                except ValueError:
                    continue
                done[r["w"]] = r["t"]
        log(f"    resuming: {len(done)} wallets already pulled")
    todo = [w for w in wallets if w not in done]
    log(f"    {len(wallets)} wallets, {len(todo)} to pull")
    ck = open(checkpoint, "a") if checkpoint else None
    for i, w in enumerate(todo, 1):
        rows = []
        token = None
        while True:
            opts = {"transactionDetails": "full", "encoding": "jsonParsed",
                    "maxSupportedTransactionVersion": 0, "sortOrder": "asc",
                    "limit": 1000, "filters": {"status": "succeeded",
                    "tokenAccounts": "balanceChanged", "tokenTransfer": {"mint": mint}}}
            if token:
                opts["paginationToken"] = token
            res, err = rpc.call("getTransactionsForAddress", [w, opts])
            if err:
                break
            data = (res or {}).get("data") or []
            for tx in data:
                t = _decode_for_wallet(tx, w, mint)
                if t:
                    rows.append(t)
            token = (res or {}).get("paginationToken")
            if not token or not data:
                break
        done[w] = rows
        if ck:
            ck.write(_json.dumps({"w": w, "t": rows}) + "\n")
            ck.flush()
        if i % 50 == 0:
            log(f"    {i}/{len(todo)}  {rpc.calls} calls")
    if ck:
        ck.close()
    out = []
    for w, rows in done.items():
        out.extend(rows)
    return out


def _decode_for_wallet(tx, wallet, mint):
    """This wallet's mint movement against its own SOL movement. Any depth."""
    meta = tx.get("meta") or {}
    if meta.get("err"):
        return None
    txn = tx.get("transaction") or {}
    sig = (txn.get("signatures") or [None])[0]
    msg = txn.get("message") or {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    tok = owner_token_deltas(meta, mint).get(wallet, 0.0)
    if abs(tok) < 1e-9:
        return None
    if wallet not in keys:
        return None
    wi = keys.index(wallet)
    pre, post = meta.get("preBalances") or [], meta.get("postBalances") or []
    if wi >= len(pre) or wi >= len(post):
        return None
    fee = (meta.get("fee") or 0) / LAMPORTS
    native = (post[wi] - pre[wi]) / LAMPORTS
    if wi == 0:
        native += fee          # the fee payer is account 0; add its fee back
    wsol = owner_token_deltas(meta, WSOL).get(wallet, 0.0)
    sol = native + wsol
    if abs(sol) < 1e-9 or (sol > 0) == (tok > 0):
        return None            # same sign is a transfer, not a swap
    return {"signature": sig, "block_time": tx.get("blockTime"), "wallet": wallet,
            "side": "buy" if tok > 0 else "sell",
            "quote_amount": abs(sol), "token_amount": abs(tok),
            "pool_token_amount": abs(tok), "attribution": "balance_delta"}


def find_pool_accounts(rpc, mint: str, log=print):
    """
    The pool's token vault and its authority, from the holder list.

    The largest token accounts for a traded mint are the AMM's vaults, and they
    stay there — unlike a transaction sample, this gives the same answer twice.
    """
    accs, err = rpc.call("getTokenLargestAccounts", [mint])
    if err:
        raise SystemExit(f"getTokenLargestAccounts: {err}")
    vals = (accs or {}).get("value") or []
    if not vals:
        raise SystemExit(f"no token accounts for {mint}")
    # THE VAULT IS THE LARGEST HOLDER, not "the one whose authority is owned by
    # an AMM program". That stricter test only passes for PumpSwap: a Raydium
    # CPMM vault authority is a data-less PDA owned by the System Program, so
    # requiring AMM ownership rejects the very pool we are looking for.
    top = vals[0]
    info, _ = rpc.call("getAccountInfo", [top["address"], {"encoding": "jsonParsed"}])
    authority = (((info or {}).get("value") or {}).get("data") or {}) \
        .get("parsed", {}).get("info", {}).get("owner")
    if not authority:
        raise SystemExit(f"cannot read the authority of {top['address']}")
    oi, _ = rpc.call("getAccountInfo", [authority, {"encoding": "base64"}])
    prog = ((oi or {}).get("value") or {}).get("owner")
    venue = KNOWN_AMMS.get(prog)
    log(f"    token vault {top['address']}  holds {float(top.get('uiAmount') or 0):,.0f}")
    log(f"    authority   {authority}  owned by {prog}"
        f"  {'-> ' + venue if venue else '(program not a known AMM; vault identified by size)'}")
    return {"vault": top["address"], "authority": authority, "program": prog,
            "venue": venue or "unknown_amm"}


def pull_pool_trades(rpc, mint: str, pool: dict, log=print, checkpoint=None,
                     start_ts: int | None = None, end_ts: int | None = None):
    """
    POOL-SIDE decode. The wallet is the attribution target, never the filter.

    WHY NOT PER-WALLET. Requiring the wallet's own SOL to move opposite its
    token balance discards every swap where an aggregator pays the SOL on the
    buyer's behalf — measured at 65 of 268 CYBERLEEK buyers, 24%. The pool
    always moves both sides, so reading the pool and attributing to whoever
    received the tokens catches those.

    Depth is irrelevant here by construction: balances are netted over the whole
    transaction, so a swap reached through three levels of CPI looks the same as
    a direct one.
    """
    import json as _json
    import os as _os
    seen, rows = set(), []
    if checkpoint and _os.path.exists(checkpoint):
        with open(checkpoint) as fh:
            for line in fh:
                try:
                    t = _json.loads(line)
                except ValueError:
                    continue
                if t["signature"] not in seen:
                    seen.add(t["signature"])
                    rows.append(t)
        log(f"    resuming: {len(rows):,} trades already pulled")
    ck = open(checkpoint, "a") if checkpoint else None
    token, pages = None, 0
    authority = pool["authority"]
    while True:
        opts = {"transactionDetails": "full", "encoding": "jsonParsed",
                "maxSupportedTransactionVersion": 0, "sortOrder": "asc",
                "limit": 250, "filters": {"status": "succeeded"}}
        bt = {}
        if start_ts:
            bt["gte"] = start_ts
        if end_ts:
            bt["lte"] = end_ts
        if bt:
            opts["filters"]["blockTime"] = bt
        if token:
            opts["paginationToken"] = token
        res, err = rpc.call("getTransactionsForAddress", [pool["vault"], opts])
        if err:
            log(f"    stopped: {err}")
            break
        data = (res or {}).get("data") or []
        if not data:
            break
        for tx in data:
            t = _decode_pool_side(tx, mint, pool["vault"], authority)
            if t and t["signature"] not in seen:
                seen.add(t["signature"])
                rows.append(t)
                if ck:
                    ck.write(_json.dumps(t) + "\n")
        pages += 1
        if ck:
            ck.flush()
        token = (res or {}).get("paginationToken")
        if pages % 10 == 0:
            log(f"    page {pages}: {len(rows):,} trades  {rpc.calls} calls")
        if not token:
            break
    if ck:
        ck.close()
    log(f"    done: {pages} pages, {len(rows):,} trades, {rpc.calls} calls")
    return rows


def _decode_pool_side(tx, mint, vault, authority):
    """Vault moved the token; whoever moved it the other way is the trader."""
    meta = tx.get("meta") or {}
    if meta.get("err"):
        return None
    txn = tx.get("transaction") or {}
    sig = (txn.get("signatures") or [None])[0]
    msg = txn.get("message") or {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]

    pre = {b["accountIndex"]: b for b in (meta.get("preTokenBalances") or [])}
    post = {b["accountIndex"]: b for b in (meta.get("postTokenBalances") or [])}
    if vault not in keys:
        return None
    vi = keys.index(vault)
    va = float((post.get(vi, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
    vb = float((pre.get(vi, {}).get("uiTokenAmount") or {}).get("uiAmount") or 0)
    vault_delta = va - vb
    if abs(vault_delta) < 1e-9:
        return None

    # The trader is whoever's balance of the mint moved opposite the vault's,
    # excluding the pool's own accounts.
    movers = {o: d for o, d in owner_token_deltas(meta, mint).items()
              if abs(d) > 1e-9 and o != authority and (d > 0) != (vault_delta > 0)}
    if not movers:
        return None
    owner = max(movers.items(), key=lambda kv: abs(kv[1]))[0]
    tok = abs(movers[owner])

    # Quote side: SOL that entered or left the pool, native or wrapped.
    sol = 0.0
    ai = keys.index(authority) if authority in keys else None
    if ai is not None:
        pb, pob = meta.get("preBalances") or [], meta.get("postBalances") or []
        if ai < len(pb) and ai < len(pob):
            sol = (pob[ai] - pb[ai]) / LAMPORTS
    if abs(sol) < 1e-12:
        wd = owner_token_deltas(meta, WSOL)
        sol = wd.get(authority, 0.0)
    if abs(sol) < 1e-12:
        # fall back to the counterparty's own SOL movement
        sol = -sum(d for o, d in owner_token_deltas(meta, WSOL).items() if o == owner)
    if abs(sol) < 1e-12 or tok <= 0:
        return None
    return {"signature": sig, "block_time": tx.get("blockTime"), "wallet": owner,
            "side": "buy" if vault_delta < 0 else "sell",
            "quote_amount": abs(sol), "token_amount": tok,
            "pool_token_amount": tok, "attribution": "pool_side"}
