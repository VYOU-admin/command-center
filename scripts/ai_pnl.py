#!/usr/bin/env python3
"""AI: FIFO PnL, two-column balance check, pool-only decode check."""
import json, statistics, requests
from collections import defaultdict, deque
S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951"
DEC = 10 ** 18; TOL = 1e-6; SUPPLY = 1_000_000_000
import time
utc = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))

d = json.load(open(S+"/ai_decoded.json")); tr = d["trades"]; fee = d["fee"]
co = json.load(open(S+"/ai_cohort.json")); NVDA_USD = co["nvda_usd"]; mc = co["mc"]
bal = json.load(open(S+"/ai_balances.json"))
w = json.load(open(S+"/ai_window.json"))
cohort = set(co["cohort"])

# AI price at head, for unrealized only (approximate is fine)
px = None
try:
    r = requests.get("https://api.dexscreener.com/token-pairs/v1/robinhood/"
                     "0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18", timeout=60).json()
    for p in r:
        if str(p.get("pairAddress","")).lower() == \
           "0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27":
            px = float(p.get("priceUsd")); break
except Exception: pass
print(f"AI price at head: ${px} (DexScreener, AI/NVDA pair; unrealized only)")

# off-pool activity from the complete in-window transfer log
offcnt = defaultdict(int)
for line in open(S+"/ai_transfers.jsonl"):
    a, b, dd = json.loads(line); A = "0x"+a; B = "0x"+b
    if A in cohort and B != PM: offcnt[A] += 1
    if B in cohort and A != PM: offcnt[B] += 1
pool_only = [x for x in cohort if offcnt.get(x, 0) == 0]
print(f"cohort {len(cohort):,}   pool-only wallets {len(pool_only):,}   "
      f"with off-pool activity {len(cohort)-len(pool_only):,}")

byw = defaultdict(list)
for t in tr:
    if t["wallet"] in cohort: byw[t["wallet"]].append(t)
rows = []
for wl, ts in byw.items():
    ts.sort(key=lambda x: (x["block"], x["logIndex"]))
    lots = deque(); real = 0.0
    bought = sold = qin = qout = 0.0; nb = ns = 0; fb = ls = None
    for t in ts:
        u = t["quote"]/t["token"] if t["token"] else 0.0
        if t["side"] == "buy":
            lots.append([t["token"], u]); bought += t["token"]; qin += t["quote"]; nb += 1
            if fb is None: fb = t["t"]
        else:
            need = t["token"]; sold += t["token"]; qout += t["quote"]; ns += 1; ls = t["t"]
            while need > 1e-15 and lots:
                lot = lots[0]; take = min(need, lot[0])
                real += take*(u-lot[1]); lot[0] -= take; need -= take
                if lot[0] <= 1e-15: lots.popleft()
            if need > 1e-15: real += need*u
    imp = bought - sold; onc = bal["head"][wl]; bnd = bal["bnd"][wl]
    rows.append({"wallet": wl, "token": "AI", "chain": "robinhood", "quote_asset": "NVDA",
        "tag": None, "tag_source": None,
        "first_buy_time_utc": utc(fb) if fb else None,
        "last_sell_time_utc": utc(ls) if ls else None,
        "n_buys": nb, "n_sells": ns, "sol_in": qin, "sol_out": qout,
        "realized_pnl_sol": real, "realized_pnl_usd": real*NVDA_USD,
        "tokens_still_held": sum(l[0] for l in lots),
        "hold_min": (ls-fb)/60.0 if (fb and ls) else None,
        "sold_out": imp <= TOL, "pre_window_entry": ts[0]["side"] == "sell",
        "first_buy_mcap_usd": mc.get(wl), "rate_basis": co["basis"],
        "tokens_bought": bought, "tokens_sold": sold,
        "implied_balance": imp, "onchain_balance": onc,
        "balance_delta": onc-imp, "balance_match": abs(bnd-imp) <= TOL,
        "boundary_balance": bnd, "boundary_delta": bnd-imp,
        "unrealized_pnl_usd": onc*px if px else None, "still_holding": onc > 0,
        "has_off_pool_activity": offcnt.get(wl, 0) > 0,
        "price_usd": px, "price_block": w["head"], "balance_block": w["head"]})

n = len(rows)
m = sum(1 for r in rows if abs(r["boundary_delta"]) <= TOL)
print(f"\nBOUNDARY DECODE CHECK (block {w['boundary_block']:,})")
print(f"  implied == on-chain: {m:,}/{n:,} ({100*m/n:.1f}%)")
nz = [r for r in rows if r["boundary_balance"] > 0]
nzm = sum(1 for r in nz if abs(r["boundary_delta"]) <= TOL)
print(f"  wallets with NONZERO boundary balance: {len(nz):,}   reproduced exactly: "
      f"{nzm:,} ({100*nzm/max(len(nz),1):.1f}%)")
po = [r for r in rows if not r["has_off_pool_activity"]]
pom = sum(1 for r in po if abs(r["boundary_delta"]) <= TOL)
ponz = [r for r in po if r["boundary_balance"] > 0]
ponzm = sum(1 for r in ponz if abs(r["boundary_delta"]) <= TOL)
print(f"  POOL-ONLY SUBSET (the check that carries weight): {pom:,}/{len(po):,} "
      f"({100*pom/max(len(po),1):.1f}%)")
print(f"    of those with a nonzero balance: {ponzm:,}/{len(ponz):,} "
      f"({100*ponzm/max(len(ponz),1):.1f}%)")
dl = sorted(abs(r["boundary_delta"]) for r in rows)
qq = lambda p: dl[min(n-1, int(p*n))]
print(f"  |delta| p50 {qq(.5):.6g}  p75 {qq(.75):.6g}  p90 {qq(.9):.6g}  "
      f"p99 {qq(.99):.6g}  max {dl[-1]:.6g}")
bp = defaultdict(lambda: [0, 0])
for r in rows:
    paths = ",".join(sorted({t["path"] for t in byw[r["wallet"]]}))
    bp[paths][0] += 1; bp[paths][1] += abs(r["boundary_delta"]) <= TOL
print("  match rate by attribution path:")
for k, (t_, m_) in sorted(bp.items()):
    print(f"    {k:<22} {m_:>5,}/{t_:<6,} {100*m_/t_:>5.1f}%")
mm = [r for r in rows if abs(r["boundary_delta"]) > TOL]
print(f"  mismatches: {len(mm):,}, of which with off-pool activity: "
      f"{sum(1 for r in mm if r['has_off_pool_activity']):,}")

pn = sorted(r["realized_pnl_usd"] for r in rows)
print(f"\nFIFO PnL  cohort {n:,}  median ${statistics.median(pn):,.2f}  "
      f"total ${sum(pn):,.0f}  winners {sum(1 for x in pn if x>0):,}  "
      f"losers {sum(1 for x in pn if x<0):,}")
print(f"still_holding {sum(1 for r in rows if r['still_holding']):,}  "
      f"unrealized ${sum(r['unrealized_pnl_usd'] or 0 for r in rows):,.0f}")
rows.sort(key=lambda r: -r["realized_pnl_usd"])
print("\nTOP 10")
print(f"  {'wallet':<44}{'PnL USD':>11}{'bought':>16}{'sold':>16}{'onchain':>14}{'off':>5}")
for r in rows[:10]:
    print(f"  {r['wallet']:<44}{r['realized_pnl_usd']:>11,.0f}{r['tokens_bought']:>16,.0f}"
          f"{r['tokens_sold']:>16,.0f}{r['onchain_balance']:>14,.0f}"
          f"{'yes' if r['has_off_pool_activity'] else 'no':>5}")
json.dump({"rows": rows, "nvda_usd": NVDA_USD, "px": px}, open(S+"/ai_rows.json","w"))
top = rows[0]["wallet"]
print(f"\nFIFO WALKTHROUGH — {top}")
lots = deque(); run = 0.0
for t in sorted(byw[top], key=lambda x: (x["block"], x["logIndex"])):
    u = t["quote"]/t["token"]
    if t["side"] == "buy":
        lots.append([t["token"], u])
        print(f"  BUY  {t['token']:>15,.2f} @ {u:.4e} NVDA  cost {t['quote']:>9.6f}  blk {t['block']:,}")
    else:
        need = t["token"]; g = 0.0
        while need > 1e-15 and lots:
            lot = lots[0]; take = min(need, lot[0]); g += take*(u-lot[1])
            lot[0] -= take; need -= take
            if lot[0] <= 1e-15: lots.popleft()
        if need > 1e-15: g += need*u
        run += g
        print(f"  SELL {t['token']:>15,.2f} @ {u:.4e} NVDA  proceeds {t['quote']:>9.6f}  "
              f"gain {g:+.6f}  running {run:+.6f}  blk {t['block']:,}")
print(f"  TOTAL {run:+.6f} NVDA x ${NVDA_USD:,.2f} = ${run*NVDA_USD:,.2f}   "
      f"unsold {sum(l[0] for l in lots):,.2f}")
