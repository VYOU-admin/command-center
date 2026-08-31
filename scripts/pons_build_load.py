#!/usr/bin/env python3
"""Build the PONS wallet_pnl rows, token record and clusters. Writes JSON only."""
import json, os, time, statistics
from collections import defaultdict, deque
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
POOL = "0x10cc6bd38112cac182db90b6a71d8bb5939526ba"
TOKEN_ADDR = "0x39dbed3a2bd333467115de45665cc57f813c4571"
WETH = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
DEC = 10 ** 18; TOL = 1e-6; SUPPLY = 1_000_000_000
utc = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))

dec = json.load(open(S + "/pons_decoded.json"))
fin = json.load(open(S + "/pons_final.json"))
bal = json.load(open(S + "/pons_balances.json"))
bt = {int(k): v for k, v in json.load(open(S + "/pons_blocktimes.json")).items()}
fee = json.load(open(S + "/pons_fee.json"))
trades, mc, ETH, RATE = dec["trades"], dec["mc"], dec["eth"], dec["basis"]
PX, HEAD, BND = fin["px"], fin["head"], fin["bnd"]
cohort = {r["wallet"] for r in fin["rows"]}

# ---- off-pool activity, from the complete window transfer log ----
offcnt = defaultdict(int)
for line in open(S + "/pons_transfers.jsonl"):
    a, b, d = json.loads(line); A = "0x" + a; B = "0x" + b
    if A in cohort and B != POOL: offcnt[A] += 1
    if B in cohort and A != POOL: offcnt[B] += 1

byw = defaultdict(list)
for t in trades:
    if t["wallet"] in cohort: byw[t["wallet"]].append(t)

rows = []
for w, ts in byw.items():
    ts.sort(key=lambda x: (x["block"], x["logIndex"]))
    lots = deque(); real = 0.0
    bought = sold = qin = qout = 0.0; nb = ns = 0
    fb = ls = None
    for t in ts:
        u = t["quote"] / t["token"] if t["token"] else 0.0
        if t["side"] == "buy":
            lots.append([t["token"], u]); bought += t["token"]; qin += t["quote"]; nb += 1
            if fb is None: fb = bt[t["block"]]
        else:
            need = t["token"]; sold += t["token"]; qout += t["quote"]; ns += 1
            ls = bt[t["block"]]
            while need > 1e-15 and lots:
                lot = lots[0]; take = min(need, lot[0])
                real += take * (u - lot[1]); lot[0] -= take; need -= take
                if lot[0] <= 1e-15: lots.popleft()
            if need > 1e-15: real += need * u        # unsold basis is zero
    imp = bought - sold; onc = bal["head"][w]; bnd = bal["bnd"][w]
    rows.append({
        "wallet": w, "token": "PONS", "chain": "robinhood", "quote_asset": "WETH",
        "tag": None, "tag_source": None,
        "first_buy_time_utc": utc(fb) if fb else None,
        "last_sell_time_utc": utc(ls) if ls else None,
        "n_buys": nb, "n_sells": ns,
        "sol_in": qin, "sol_out": qout,
        "realized_pnl_sol": real, "realized_pnl_usd": real * ETH,
        "tokens_still_held": sum(l[0] for l in lots),
        "hold_min": (ls - fb) / 60.0 if (fb and ls) else None,
        "sold_out": imp <= TOL,
        "pre_window_entry": ts[0]["side"] == "sell",
        "first_buy_mcap_usd": mc.get(w),
        "rate_basis": RATE,
        "tokens_bought": bought, "tokens_sold": sold,
        "implied_balance": imp, "onchain_balance": onc,
        "balance_delta": onc - imp, "balance_match": abs(bnd - imp) <= TOL,
        "boundary_balance": bnd, "boundary_delta": bnd - imp,
        "unrealized_pnl_usd": onc * PX, "still_holding": onc > 0,
        "has_off_pool_activity": offcnt.get(w, 0) > 0,
        "price_usd": PX, "price_block": HEAD, "balance_block": HEAD,
    })
print(f"rows {len(rows):,}   off-pool {sum(1 for r in rows if r['has_off_pool_activity']):,}"
      f"   still_holding {sum(1 for r in rows if r['still_holding']):,}"
      f"   balance_match {sum(1 for r in rows if r['balance_match']):,}")

# ---- clusters ----
sig = {}
for line in open(S + "/pons_receipts.jsonl"):
    r = json.loads(line); sig[r["k"]] = (r["v"] or {}).get("from", "")
txw = defaultdict(set)
for t in trades:
    if t["wallet"] in cohort: txw[t["tx"]].add(t["wallet"])

# shared_signer: one signer = one star, never chained; self-signed carries nothing
bysig = defaultdict(set)
for tx, ws in txw.items():
    s = sig.get(tx, "")
    if not s: continue
    for w in ws:
        if w != s: bysig[s].add(w)
deg = sorted({s: len(v) for s, v in bysig.items()}.values())
cand = {s: v for s, v in bysig.items() if len(v) > 1}
sizes = sorted({len(v) for v in cand.values()})
gap, cut = 0, None
for i in range(1, len(sizes)):
    if sizes[i] - sizes[i - 1] > gap and sizes[i] >= 10:
        gap, cut = sizes[i] - sizes[i - 1], sizes[i]
print(f"\nshared_signer: {len(cand):,} multi-wallet signers, sizes {sizes[:8]}..{sizes[-5:]}")
print(f"  degree gap {gap} -> infrastructure cut at >= {cut}" if cut else "  no gap found")
clusters = []
n = 0
for s, ws in sorted(cand.items(), key=lambda kv: (-len(kv[1]), kv[0])):
    if cut and len(ws) >= cut: continue          # infrastructure, not an operator
    n += 1; cid = f"pons-s{n:03d}"
    for w in sorted(ws):
        clusters.append({"chain": "robinhood", "wallet": w, "cluster_id": cid,
                         "signal": "shared_signer", "evidence": s,
                         "confidence": "high", "cluster_size": len(ws)})
excl = sum(1 for ws in cand.values() if cut and len(ws) >= cut)
print(f"  kept {n} clusters, excluded {excl} as infrastructure")

m = 0
for tx, ws in sorted(txw.items()):
    if len(ws) < 2: continue
    m += 1; cid = f"pons-t{m:03d}"
    for w in sorted(ws):
        clusters.append({"chain": "robinhood", "wallet": w, "cluster_id": cid,
                         "signal": "same_transaction", "evidence": tx,
                         "confidence": "high", "cluster_size": len(ws)})
print(f"same_transaction: {m} clusters")
cw = {c["wallet"] for c in clusters}
print(f"cluster rows {len(clusters):,}, covering {len(cw):,} of {len(rows):,} wallets")

tok = {
    "token": "PONS", "chain": "robinhood", "token_address": TOKEN_ADDR,
    "pool_address": POOL, "dex": "uniswap", "dex_version": "v3",
    "quote_asset": "WETH", "quote_address": WETH, "quote_decimals": 18,
    "total_supply": SUPPLY, "window_hours": 4,
    "window_start_utc": utc(min(bt.values())), "window_end_utc": utc(max(bt.values())),
    "first_swap_block": 8963150, "boundary_block": BND,
    "swaps_in_window": 5662, "unique_txs": 5657, "fully_covered": True,
    "mcap_threshold_usd": 10000000, "threshold_binding": False,
    "threshold_note": ("highest first-buy mcap was $394,932 against a $10,000,000 "
                       "ceiling, 1,051 of 1,051 admitted"),
    "fee_rate_buy": fee["buy"], "fee_rate_sell": fee["sell"],
    "usd_method": "constant", "rate_basis": RATE,
    "price_usd": PX, "price_block": HEAD, "balance_block": HEAD,
    "cohort_size": len(rows),
    "decode_check": ("476/476 wallets that only ever touched this pool reproduce "
                     "their on-chain balance exactly, including 154 with a nonzero "
                     "balance; all 63 mismatches had off-pool transfers"),
}
json.dump({"rows": rows, "clusters": clusters, "token": tok}, open(S + "/pons_load.json", "w"))
print(f"\nwrote pons_load.json  ({os.path.getsize(S+'/pons_load.json')/1024:.0f} KB)")
