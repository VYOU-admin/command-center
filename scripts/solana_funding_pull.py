#!/usr/bin/env python3
"""
Solana funding-source pull: the first inbound transfer per cohort wallet.

ONE CALL PER WALLET. getTransactionsForAddress with sortOrder "asc" and limit 1
returns the oldest transaction directly, so there is no paging to the end of
history. The funder is then read from preBalances/postBalances in that same
response — the account whose lamports fell while the wallet's rose — which needs
no second call.

WHY FUNDING RATHER THAN THE FEE PAYER. On Solana most wallets sign their own
transactions, so the fee payer is usually the wallet itself and carries almost
no grouping information. That is the opposite of the EVM case, where relayers
made the signer informative. Funding source is the signal that survives.

Read-only with respect to Postgres: this writes a JSON file and nothing else.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import defaultdict

import requests
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRATCH = "/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad"
CKPT = os.path.join(SCRATCH, "funding.jsonl")

load_dotenv(os.path.join(ROOT, ".env"))
KEY = os.environ.get("HELIUS_API_KEY", "").strip()
if not KEY:
    raise SystemExit("HELIUS_API_KEY missing")
URL = f"https://mainnet.helius-rpc.com/?api-key={KEY}"
scrub = lambda s: re.sub(re.escape(KEY), "<KEY>", str(s))

RATE = 10.0
calls = 0
_last = 0.0


def rpc(method, params, tries=5, timeout=90):
    global calls, _last
    for a in range(tries):
        w = _last + 1.0 / RATE - time.time()
        if w > 0:
            time.sleep(w)
        _last = time.time()
        calls += 1
        try:
            r = requests.post(URL, json={"jsonrpc": "2.0", "id": "1",
                                         "method": method, "params": params}, timeout=timeout)
            if r.status_code == 429:
                time.sleep(1.5 * (a + 1)); continue
            j = r.json()
        except Exception:
            time.sleep(1.5 * (a + 1)); continue
        if "error" in j:
            m = scrub(j["error"].get("message", ""))
            if "invalid params" in m.lower():
                raise SystemExit(f"{method}: {m}")
            time.sleep(1.0 * (a + 1)); continue
        return j.get("result"), None
    return None, "exhausted retries"


def first_funder(wallet: str):
    """(funder, lamports, signature, block_time) or (None, reason)."""
    res, err = rpc("getTransactionsForAddress", [wallet, {
        "transactionDetails": "full",
        "encoding": "jsonParsed",
        "maxSupportedTransactionVersion": 0,
        "sortOrder": "asc",
        "limit": 1,
        "filters": {"status": "succeeded"},
    }])
    if err:
        return {"error": err}
    rows = (res or {}).get("data") or []
    if not rows:
        return {"error": "no transactions"}
    tx = rows[0]
    meta = tx.get("meta") or {}
    msg = (tx.get("transaction") or {}).get("message") or {}
    keys = [k["pubkey"] if isinstance(k, dict) else k for k in (msg.get("accountKeys") or [])]
    pre = meta.get("preBalances") or []
    post = meta.get("postBalances") or []
    if wallet not in keys:
        return {"error": "wallet not in accountKeys"}
    wi = keys.index(wallet)
    if wi >= len(pre) or wi >= len(post):
        return {"error": "balance arrays short"}
    gained = post[wi] - pre[wi]
    if gained <= 0:
        return {"error": "wallet did not gain lamports in its first tx"}
    # the funder is whoever lost the most, excluding the wallet itself
    losers = []
    for i, k in enumerate(keys):
        if i == wi or i >= len(pre) or i >= len(post):
            continue
        d = post[i] - pre[i]
        if d < 0:
            losers.append((k, -d))
    if not losers:
        return {"error": "no account lost lamports"}
    losers.sort(key=lambda x: -x[1])
    return {
        "funder": losers[0][0],
        "lamports": gained,
        "signature": (tx.get("transaction") or {}).get("signatures", [None])[0],
        "block_time": tx.get("blockTime"),
    }


def main() -> None:
    wallets = json.load(open(os.path.join(SCRATCH, "solana_wallets.json")))
    done = {}
    if os.path.exists(CKPT):
        with open(CKPT) as fh:
            for line in fh:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                done[r["wallet"]] = r["v"]
        print(f"resuming: {len(done)} already pulled", flush=True)
    todo = [w for w in wallets if w not in done]
    print(f"{len(wallets)} cohort wallets, {len(todo)} to pull", flush=True)
    t0 = time.time()
    with open(CKPT, "a") as ck:
        for i, w in enumerate(todo, 1):
            v = first_funder(w)
            done[w] = v
            ck.write(json.dumps({"wallet": w, "v": v}) + "\n")
            if i % 100 == 0:
                ck.flush()
                el = time.time() - t0
                print(f"  {i}/{len(todo)}  {calls} calls  {el:.0f}s  ({i/el:.1f}/s)", flush=True)
    ok = sum(1 for v in done.values() if "funder" in v)
    print(f"\nresolved {ok}/{len(done)}   credits(calls) {calls}   wall {(time.time()-t0)/60:.1f} min")
    reasons = defaultdict(int)
    for v in done.values():
        if "funder" not in v:
            reasons[v.get("error", "?")] += 1
    for k, n in sorted(reasons.items(), key=lambda x: -x[1]):
        print(f"  failed: {k}: {n}")


if __name__ == "__main__":
    main()
