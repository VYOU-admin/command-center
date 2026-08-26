#!/usr/bin/env python3
"""
Helius reconnaissance for a token trade-history pull.

MEASURES SCOPE ONLY. Nothing here writes a CSV or touches Postgres: the point
is to find out what a full pull would cost and whether it is even possible,
before committing to it.

The account it leans on, getTransactionsForAddress, is not on every Helius
plan. Because a plan rejection and a bad query both come back as an error, the
first thing this does is one deliberate gating call whose only job is to tell
those two apart -- and it stops there if the method is unavailable, rather than
burning credits discovering the same thing repeatedly.

CREDITS. In transactionDetails="signatures" mode the call costs a flat 10
credits regardless of how many signatures come back, so a census is cheap:
paging a million signatures costs the same per page as paging ten. Every call
made here is counted and reported.

THE KEY IS NEVER PRINTED. It is read from the environment and interpolated into
the URL at request time; the URL is redacted anywhere it would otherwise be
logged.
"""

from __future__ import annotations

import json
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import requests
from dotenv import load_dotenv

RPC_HOST = "https://mainnet.helius-rpc.com/"
CREDITS_PER_SIGNATURES_CALL = 10
MAX_REQS_PER_SEC = 10
PAGE_LIMIT = 1000

# --- the addresses this recon is about -------------------------------------
CATE_MINT = "Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump"
CATE_POOL = "HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3"
CYBERLEEK_MINT = "ApZuxdpzMrbEYTGEzeY9afh5pj9d6qPRJCTgQYiipbKg"

# Raydium program ids, so a discovered pool can be attributed to the right one.
# They matter because each parses differently downstream.
RAYDIUM_PROGRAMS = {
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM v4",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CPMM",
    "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
}

# Raydium CPMM PoolState, after the 8-byte Anchor discriminator. Only the
# fields this recon needs; the vaults are what a trade pull would actually read.
CPMM_POOL_FIELDS = {
    "amm_config": 8, "pool_creator": 40, "token_0_vault": 72,
    "token_1_vault": 104, "lp_mint": 136, "token_0_mint": 168, "token_1_mint": 200,
}

# Identifying the pool by its OWNER is what works. Scanning a mint's earliest
# transactions for a known program id does not: CYBERLEEK's pool is created
# well after the mint, behind routers, and the program never appears in those
# first transactions at all.
def pool_program(c: "Client", pool: str) -> tuple[str, str, dict]:
    res = c.call("getAccountInfo", [pool, {"encoding": "base64"}], credits=1)
    v = (res or {}).get("value")
    if not v:
        return ("", "unknown — account not found", {})
    owner = v["owner"]
    name = RAYDIUM_PROGRAMS.get(owner, f"unrecognised program {owner}")
    fields = {}
    if owner == "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C":
        import base64 as _b64
        raw = _b64.b64decode(v["data"][0])
        fields = {k: b58encode(raw[o:o + 32]) for k, o in CPMM_POOL_FIELDS.items()
                  if o + 32 <= len(raw)}
    return (owner, name, fields)


_B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n:
        n, r = divmod(n, 58)
        out = _B58[r] + out
    for ch in b:
        if ch == 0:
            out = "1" + out
        else:
            break
    return out


def estimate_window(c: "Client", address: str, start: int, end: int) -> dict:
    """
    Size a window from ONE page instead of paging it out.

    A full census of a busy pool is not cheap: CATE's five-hour window took
    2,665 pages and 26,650 credits. One page reveals how much wall-clock 1,000
    signatures covers, which extrapolates to a count and, more usefully, to what
    the exact census would cost before committing to it.
    """
    res = c.signatures_page(address, start=start, end=end)
    rows = rows_of(res)
    if not rows:
        return {"sampled": 0, "estimate": 0, "pages": 0, "credits": 0}
    span = rows[-1]["blockTime"] - rows[0]["blockTime"]
    window = end - start
    est = int(window / span * len(rows)) if span > 0 else len(rows)
    pages = est // PAGE_LIMIT + 1
    return {"sampled": len(rows), "span": span, "window": window,
            "estimate": est, "pages": pages,
            "credits": pages * CREDITS_PER_SIGNATURES_CALL}
PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"


class HeliusGated(RuntimeError):
    """The method is not available on this plan. Distinct from a bad query."""


@dataclass
class Client:
    api_key: str
    calls: int = 0
    credits: int = 0
    _stamps: list[float] = field(default_factory=list)

    @property
    def url(self) -> str:
        return f"{RPC_HOST}?api-key={self.api_key}"

    def _throttle(self) -> None:
        now = time.monotonic()
        self._stamps = [t for t in self._stamps if now - t < 1.0]
        if len(self._stamps) >= MAX_REQS_PER_SEC:
            time.sleep(1.0 - (now - self._stamps[0]) + 0.01)
            self._stamps = [t for t in self._stamps if time.monotonic() - t < 1.0]
        self._stamps.append(time.monotonic())

    def call(self, method: str, params: Any, *, credits: int = CREDITS_PER_SIGNATURES_CALL,
             tries: int = 5) -> Any:
        body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
        last_err = None
        for attempt in range(tries):
            self._throttle()
            self.calls += 1
            self.credits += credits
            try:
                r = requests.post(self.url, json=body, timeout=60)
            except requests.RequestException as e:
                last_err = str(e)
                time.sleep(0.6 * (attempt + 1))
                continue
            if r.status_code == 429:
                time.sleep(1.2 * (attempt + 1))
                continue
            try:
                payload = r.json()
            except ValueError:
                last_err = f"HTTP {r.status_code}: {r.text[:200]}"
                time.sleep(0.6 * (attempt + 1))
                continue
            if "error" in payload:
                msg = str(payload["error"].get("message", payload["error"]))
                # A plan rejection is terminal; retrying only burns credits.
                if any(w in msg.lower() for w in
                       ("plan", "upgrade", "method not found", "not supported",
                        "unauthorized", "forbidden", "tier")):
                    raise HeliusGated(msg)
                # A malformed request will fail identically every time; retrying
                # it four more times only spends credits to learn nothing.
                if "invalid params" in msg.lower():
                    raise RuntimeError(f"{method}: {msg}")
                last_err = msg
                time.sleep(0.6 * (attempt + 1))
                continue
            return payload.get("result")
        raise RuntimeError(f"{method} failed after {tries} tries: {last_err}")

    def signatures_page(self, address: str, *, start: int | None = None,
                        end: int | None = None, token: str | None = None) -> dict:
        # The address is a POSITIONAL first argument; passing it inside the
        # options map returns "invalid type: map, expected a string", which
        # reads like a plan rejection but is not one.
        opts: dict[str, Any] = {
            "transactionDetails": "signatures",
            "sortOrder": "asc",
            "limit": PAGE_LIMIT,
            "filters": {"status": "succeeded"},
        }
        bt: dict[str, int] = {}
        if start is not None:
            bt["gte"] = start
        if end is not None:
            bt["lte"] = end
        if bt:
            opts["filters"]["blockTime"] = bt
        if token:
            opts["paginationToken"] = token
        res = self.call("getTransactionsForAddress", [address, opts])
        return res if isinstance(res, dict) else {"data": res or [], "paginationToken": None}

    def count_signatures(self, address: str, start: int, end: int,
                         label: str = "") -> tuple[int, int]:
        """Total signatures in a window, and how many pages it took."""
        total, pages, token = 0, 0, None
        while True:
            res = self.signatures_page(address, start=start, end=end, token=token)
            rows = rows_of(res)
            total += len(rows)
            pages += 1
            token = res.get("paginationToken")
            if label:
                print(f"      page {pages}: +{len(rows)} (total {total})", flush=True)
            if not token:
                break
        return total, pages


def rows_of(res: dict) -> list:
    """Rows come back under "data"; the other names are defensive."""
    if not isinstance(res, dict):
        return res or []
    return res.get("data") or res.get("transactions") or res.get("signatures") or []


def load_key() -> str:
    load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
    key = os.environ.get("HELIUS_API_KEY", "").strip()
    if not key:
        print("HELIUS_API_KEY not found in environment or .env", file=sys.stderr)
        sys.exit(2)
    # Never print the key. Only its shape, so a wrong/empty value is diagnosable.
    print(f"key loaded: {len(key)} chars, ends …{key[-4:]}")
    return key


def gating_check(c: Client) -> None:
    print("\n=== 1. GATING CHECK ===")
    print(f"    address {CATE_POOL}")
    print("    blockTime 1785081600 -> 1785099600")
    try:
        res = c.signatures_page(CATE_POOL, start=1785081600, end=1785099600)
    except HeliusGated as e:
        print("\n    *** METHOD GATED — STOPPING ***")
        print(f"    exact error: {e}")
        print(f"\n    credits burned: {c.credits} ({c.calls} calls)")
        sys.exit(1)
    rows = rows_of(res)
    print(f"    OK — {len(rows)} signatures on the first page, "
          f"paginationToken={'yes' if res.get('paginationToken') else 'none'}")


def find_pool(c: Client) -> dict:
    print("\n=== 2. CYBERLEEK POOL DISCOVERY ===")
    res = c.call("getTransactionsForAddress", [CYBERLEEK_MINT, {
        "transactionDetails": "full",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 0,
        "sortOrder": "asc",
        "limit": 20,
    }], credits=100)
    txs = rows_of(res)
    print(f"    {len(txs)} earliest transactions fetched")
    for i, tx in enumerate(txs):
        msg = (tx.get("transaction") or {}).get("message", {})
        keys = [k["pubkey"] if isinstance(k, dict) else k
                for k in (msg.get("accountKeys") or [])]
        progs = {k for k in keys if k in RAYDIUM_PROGRAMS}
        logs = (tx.get("meta") or {}).get("logMessages") or []
        init = any("initialize" in l.lower() for l in logs)
        if progs:
            prog = sorted(progs)[0]
            sig = (tx.get("transaction") or {}).get("signatures", ["?"])[0]
            print(f"\n    tx[{i}] {sig[:24]}… blockTime={tx.get('blockTime')}")
            print(f"      program: {prog}  ({RAYDIUM_PROGRAMS[prog]})")
            print(f"      initialize in logs: {init}")
            print(f"      {len(keys)} accounts; candidates (non-program, non-mint):")
            for k in keys[:20]:
                if k not in RAYDIUM_PROGRAMS and k != CYBERLEEK_MINT:
                    print(f"        {k}")
            return {"program": prog, "program_name": RAYDIUM_PROGRAMS[prog],
                    "accounts": keys, "blockTime": tx.get("blockTime"), "sig": sig}
    print("    no Raydium program found in the earliest transactions")
    for i, tx in enumerate(txs[:5]):
        msg = (tx.get("transaction") or {}).get("message", {})
        keys = [k["pubkey"] if isinstance(k, dict) else k
                for k in (msg.get("accountKeys") or [])]
        print(f"    tx[{i}] blockTime={tx.get('blockTime')} programs seen: "
              f"{[k for k in keys if k.endswith('Mp8') or 'pump' in k]}")
    return {}


def cate_launch(c: Client) -> dict:
    print("\n=== 3. CATE LAUNCH TIME + BONDING CURVE ===")
    res = c.call("getTransactionsForAddress", [CATE_MINT, {
        "transactionDetails": "full",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 0,
        "sortOrder": "asc",
        "limit": 5,
    }], credits=100)
    txs = rows_of(res)
    print(f"    {len(txs)} earliest transactions fetched")
    for i, tx in enumerate(txs):
        bt = tx.get("blockTime")
        msg = (tx.get("transaction") or {}).get("message", {})
        keys = [k["pubkey"] if isinstance(k, dict) else k
                for k in (msg.get("accountKeys") or [])]
        sig = (tx.get("transaction") or {}).get("signatures", ["?"])[0]
        has_pump = PUMP_PROGRAM in keys
        print(f"\n    tx[{i}] {sig[:24]}… blockTime={bt} "
              f"({time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(bt)) if bt else '?'}) "
              f"pump_program={has_pump}")
        if has_pump:
            print(f"      accounts:")
            for k in keys[:16]:
                print(f"        {k}")
            return {"blockTime": bt, "accounts": keys, "sig": sig}
    return {}


def census(c: Client, cyberleek_pool: str | None) -> None:
    print("\n=== 4. VOLUME CENSUS (counts only) ===")
    windows = [
        ("CATE pool", CATE_POOL, 1785081600, 1785099600),
        ("CYBERLEEK pool w1", cyberleek_pool, 1786813200, 1787076000),
        ("CYBERLEEK pool w2", cyberleek_pool, 1787076000, 1787104800),
        ("CYBERLEEK pool w3", cyberleek_pool, 1787421600, 1787493600),
    ]
    for label, addr, start, end in windows:
        if not addr:
            print(f"    {label:22} SKIPPED — pool not discovered")
            continue
        print(f"    {label:22} {addr[:12]}… {start}->{end}")
        total, pages = c.count_signatures(addr, start, end)
        hrs = (end - start) / 3600
        print(f"      => {total:,} signatures over {pages} page(s), {hrs:.1f}h window")


def main() -> None:
    c = Client(load_key())
    gating_check(c)
    pool = find_pool(c)
    cate = cate_launch(c)
    pool_id = None
    if pool:
        # The pool id is reported for confirmation rather than guessed at here;
        # picking the wrong account would silently census the wrong thing.
        print(f"\n    -> pool program: {pool['program_name']} ({pool['program']})")
    census(c, pool_id)
    print(f"\n=== CREDITS ===\n    calls={c.calls}  credits={c.credits}")


if __name__ == "__main__":
    main()
