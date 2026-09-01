#!/usr/bin/env python3
"""
One command for the Robinhood-chain wallet pipeline.

Runs the 18 steps of docs/PIPELINE_SPEC.md section 3 in order, parameterised over
venue (v3/v4) and quote asset. Consolidates the per-token pons_*.py and ai_*.py
scripts into a single path; the decode logic is carried across unchanged.

  python3 scripts/run_token.py --token <addr> --pool <addr|poolId>
                               --mcap-threshold <usd> --window-hours <n>
                               --chain robinhood

STOPS AFTER THE REPORT. It never writes to Postgres. `--load` builds the load
payload and prints the command that applies it; loading is always a separate,
explicit act.

CHECKPOINTED AT EVERY EXPENSIVE STAGE, under <scratch>/run/<TOKEN>/. A crash
resumes without re-pulling.

NO SILENT DEFAULTS. Any value the node did not actually return is retried and
then fails the run. A missing result is never coerced to zero -- 490 rate-limited
balance reads once became fake zero balances and manufactured a decode crisis.
"""
from __future__ import annotations

import argparse, json, os, statistics, sys, time
from collections import defaultdict, deque

import requests
import yaml
from dotenv import load_dotenv

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))
from pipeline.venue import Venue                      # noqa: E402
from pipeline.constraints import Ledger               # noqa: E402
from pipeline import infrastructure as infra          # noqa: E402
from pipeline import quote_pricing as qp          # noqa: E402
from pipeline import pricing as pricing_mod        # noqa: E402

CFG = yaml.safe_load(open(os.path.join(ROOT, "config", "pipeline.yaml")))
TOPICS, SEL, LIM = CFG["topics"], CFG["selectors"], CFG["limits"]
SCRATCH = os.environ.get("PIPELINE_SCRATCH") or (
    "/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
    "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
ZERO = "0x" + "0" * 40
utc = lambda t: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


# ----------------------------------------------------------------- checkpoints
class Store:
    def __init__(self, token_label):
        self.dir = os.path.join(SCRATCH, "run", token_label)
        os.makedirs(self.dir, exist_ok=True)

    def p(self, name): return os.path.join(self.dir, name)
    def has(self, name): return os.path.exists(self.p(name))

    def json(self, name, build):
        if self.has(name):
            print(f"  [resume] {name}")
            return json.load(open(self.p(name)))
        v = build()
        json.dump(v, open(self.p(name), "w"))
        return v


# ------------------------------------------------------------------------ rpc
class Rpc:
    def __init__(self, chain):
        c = CFG["chains"][chain]
        load_dotenv(os.path.join(ROOT, ".env"))
        key = os.environ.get(c["alchemy_key_env"], "").strip()
        if not key:
            raise SystemExit(f"{c['alchemy_key_env']} missing from .env")
        self.al = c["alchemy_url"].format(key=key)
        self.pub = c["public_rpc"]
        self.cfg = c
        self._al_t, self._pub_t = [0.0], [0.0]

    def _wait(self, slot, gap):
        w = slot[0] + gap - time.time()
        if w > 0: time.sleep(w)
        slot[0] = time.time()

    def batch(self, calls):
        """Alchemy JSON-RPC batch. Returns list or None; never invents results."""
        for a in range(8):
            self._wait(self._al_t, LIM["alchemy_min_interval_s"])
            try:
                r = requests.post(self.al, json=calls, timeout=120)
                if r.status_code in (429, 500, 502, 503, 504):
                    time.sleep(min(30, 1.2 * (a + 1) ** 2)); continue
                j = r.json()
                return j if isinstance(j, list) else [j]
            except Exception:
                time.sleep(min(30, 1.2 * (a + 1) ** 2))
        return None

    def one(self, method, params):
        r = self.batch([{"jsonrpc": "2.0", "id": 0, "method": method, "params": params}])
        if not r or "error" in r[0] or r[0].get("result") is None:
            raise SystemExit(f"{method} failed: {r}")
        return r[0]["result"]

    def resolve_all(self, items, make_call, extract, label, on_batch=None):
        """
        Batch every item and RETRY the ones that did not come back. Aborts rather
        than returning a partial map.
        """
        out, todo, rnd = {}, list(items), 0
        while todo and rnd < LIM["max_retry_rounds"]:
            rnd += 1; fail = []
            for i in range(0, len(todo), LIM["batch_size"]):
                ch = todo[i:i + LIM["batch_size"]]
                res = self.batch([make_call(j, x) for j, x in enumerate(ch)])
                if res is None: fail += ch; continue
                got = set()
                for r in res:
                    x = ch[r["id"]]
                    if "error" in r:
                        fail.append(x); continue
                    try:
                        v = extract(r.get("result"))
                    except Exception:
                        v = None
                    if v is None: fail.append(x); continue
                    out[x] = v; got.add(x)
                    if on_batch is not None: on_batch(x, v)
                fail += [x for x in ch if x not in got and x not in fail]
            todo = sorted(set(fail), key=str)
            print(f"    {label} round {rnd}: {len(out):,}/{len(items):,}, "
                  f"retrying {len(todo):,}", flush=True)
            if todo: time.sleep(3)
        if todo:
            raise SystemExit(f"{label}: {len(todo)} never resolved -- refusing partial data")
        return out

    def call(self, to, data, tag="latest"):
        r = self.batch([{"jsonrpc": "2.0", "id": 0, "method": "eth_call",
                         "params": [{"to": to, "data": data}, tag]}])
        if not r or "error" in r[0]: return None
        v = r[0].get("result")
        return None if not v or v == "0x" else v

    def logs(self, address, topics, lo, hi):
        """Public RPC getLogs, paced, splitting on range/timeout errors only."""
        for a in range(9):
            self._wait(self._pub_t, LIM["public_min_interval_s"])
            try:
                r = requests.post(self.pub, json={"jsonrpc": "2.0", "id": 1,
                    "method": "eth_getLogs", "params": [{
                        "fromBlock": hex(lo), "toBlock": hex(hi),
                        "address": address, "topics": topics}]}, timeout=180)
                if r.status_code == 429 or r.status_code >= 500:
                    time.sleep(min(60, 3 * (a + 1) ** 2)); continue
                j = r.json()
            except Exception:
                time.sleep(min(60, 3 * (a + 1) ** 2)); continue
            if "error" in j:
                m = str(j["error"].get("message", ""))
                if "Too Many" in m or "429" in m:
                    time.sleep(min(60, 3 * (a + 1) ** 2)); continue
                if hi > lo and ("limit" in m or "timed out" in m or "exceed" in m.lower()):
                    mid = (lo + hi) // 2
                    return self.logs(address, topics, lo, mid) + \
                           self.logs(address, topics, mid + 1, hi)
                raise SystemExit(f"getLogs {lo}-{hi}: {m}")
            return j.get("result") or []
        raise SystemExit(f"getLogs {lo}-{hi} exhausted retries")

    def logs_range(self, address, topics, lo, hi, store, name):
        """Checkpointed window walk. Completed ranges are never re-pulled."""
        ck, st = store.p(name + ".jsonl"), store.p(name + ".state")
        done = json.load(open(st))["r"] if os.path.exists(st) else []
        cov = {tuple(x) for x in done}
        out = []
        if os.path.exists(ck):
            for line in open(ck):
                try: out.append(json.loads(line))
                except ValueError: pass
        fh = open(ck, "a"); cur = lo; t0 = time.time()
        while cur <= hi:
            nx = min(cur + LIM["getlogs_window_blocks"], hi)
            if (cur, nx) in cov: cur = nx + 1; continue
            got = self.logs(address, topics, cur, nx)
            for l in got:
                fh.write(json.dumps({k: l[k] for k in
                    ("address", "topics", "data", "blockNumber",
                     "transactionHash", "logIndex")}) + "\n")
                out.append(l)
            done.append([cur, nx]); fh.flush()
            json.dump({"r": done}, open(st, "w"))
            print(f"    {name} ..{nx:,}  +{len(got):,}  total {len(out):,}  "
                  f"{time.time()-t0:.0f}s", flush=True)
            cur = nx + 1
        fh.close()
        return out

    def block_ts(self, blocks, store, name="blocktimes"):
        path = store.p(name + ".json")
        bt = {int(k): v for k, v in json.load(open(path)).items()} if os.path.exists(path) else {}
        need = [b for b in blocks if b not in bt]
        if need:
            print(f"    timestamping {len(need):,} block(s)")
            got = self.resolve_all(need,
                lambda j, b: {"jsonrpc": "2.0", "id": j, "method": "eth_getBlockByNumber",
                              "params": [hex(b), False]},
                lambda r: int(r["timestamp"], 16) if r and r.get("timestamp") else None,
                "blocktimes")
            bt.update(got); json.dump(bt, open(path, "w"))
        return bt

    def balances(self, token, wallets, block, store):
        path = store.p("balances.json")
        cache = json.load(open(path)) if os.path.exists(path) else {}
        k = str(block); cache.setdefault(k, {})
        need = [w for w in wallets if w not in cache[k]]
        if need:
            print(f"    balanceOf at block {block:,}: {len(need):,} wallet(s)")
            got = self.resolve_all(need,
                lambda j, w: {"jsonrpc": "2.0", "id": j, "method": "eth_call", "params": [
                    {"to": token, "data": SEL["balance_of"] + "0" * 24 + w[2:]}, hex(block)]},
                lambda r: int(r, 16) if r and r != "0x" else None,
                f"balances@{block}")
            cache[k].update(got); json.dump(cache, open(path, "w"))
        return {w: cache[k][w] for w in wallets}

    def receipts(self, txs, keep_addrs, store):
        ck = store.p("receipts.jsonl")
        have = {}
        if os.path.exists(ck):
            for line in open(ck):
                try: r = json.loads(line); have[r["k"]] = r["v"]
                except ValueError: pass
        todo = [t for t in txs if t not in have]
        if todo:
            print(f"    receipts: {len(have):,} cached, {len(todo):,} to fetch")
            fh = open(ck, "a")
            written = [0]
            def sink(h, v):
                # INCREMENTAL CHECKPOINT. Writing only after the whole stage
                # succeeded meant a crash 4,900 receipts in lost all of them,
                # which is not "checkpointed at every expensive stage".
                fh.write(json.dumps({"k": h, "v": v}) + "\n")
                written[0] += 1
                if written[0] % 200 == 0: fh.flush()
            got = self.resolve_all(todo,
                lambda j, h: {"jsonrpc": "2.0", "id": j,
                              "method": "eth_getTransactionReceipt", "params": [h]},
                lambda r: ({"from": (r.get("from") or "").lower(),
                            "transfers": [[l["topics"][1][-40:].lower(),
                                           l["topics"][2][-40:].lower(),
                                           l["data"], l["address"].lower()]
                                          for l in (r.get("logs") or [])
                                          if l["address"].lower() in keep_addrs
                                          and l["topics"][0].lower() == TOPICS["transfer"]
                                          and len(l["topics"]) >= 3]}) if r else None,
                "receipts", on_batch=sink)
            have.update(got)
            fh.close()
        return have


def dec_str(hexv):
    if not hexv: return None
    b = bytes.fromhex(hexv[2:])
    if len(b) >= 64:
        n = int.from_bytes(b[32:64], "big")
        return b[64:64 + n].decode("utf-8", "replace").strip("\x00") or None
    return b.decode("utf-8", "replace").strip("\x00") or None


# ------------------------------------------------------------------ the stages
def run(args):
    L = Ledger()
    chain = CFG["chains"][args.chain]
    rpc = Rpc(args.chain)
    token = args.token.lower()

    # -- 1/2: resolve the pool, read decimals from the contracts ---------------
    st0 = Store("_tmp")
    pairs = qp.dexscreener_pairs(chain["dexscreener_slug"], token)
    match = next((p for p in pairs
                  if str(p.get("pairAddress", "")).lower() == args.pool.lower()), None)
    if not match:
        raise SystemExit(f"supplied pool {args.pool} not found among "
                         f"{len(pairs)} DexScreener pairs for this token")
    version = (match.get("labels") or ["v3"])[0].lower()
    quote_addr = str((match.get("quoteToken") or {}).get("address", "")).lower()
    base_addr = str((match.get("baseToken") or {}).get("address", "")).lower()
    if base_addr != token:
        quote_addr, base_addr = base_addr, quote_addr
    sym = lambda a: dec_str(rpc.call(a, SEL["symbol"])) or "?"
    base_sym, quote_sym = sym(token), (sym(quote_addr) if quote_addr != ZERO
                                       else chain["native_symbol"])
    def decimals(a):
        if a == ZERO: return 18, "native"
        v = rpc.call(a, SEL["decimals"])
        if v is None: raise SystemExit(f"decimals() unreadable for {a} -- never assumed")
        return int(v, 16), "contract read"
    bdec, bsrc = decimals(token)
    qdec, qsrc = decimals(quote_addr)
    L.record("decimals_read", f"{base_sym} {bdec} ({bsrc}), {quote_sym} {qdec} ({qsrc})")
    L.record("quote_detected", f"{quote_sym} {quote_addr} via DexScreener + on-chain symbol/decimals")

    label = base_sym.upper()
    S = Store(label)
    ven = Venue(version, args.pool, token, quote_addr or ZERO,
                chain.get("v4_pool_manager"), TOPICS)
    if version == "v3":                     # confirm ordering, never infer it
        t0 = rpc.call(args.pool, SEL["token0"]); t1 = rpc.call(args.pool, SEL["token1"])
        if t0 and t1:
            got = ("0x" + t0[-40:], "0x" + t1[-40:])
            exp = (token, quote_addr) if ven.base_index == 0 else (quote_addr, token)
            if got != exp:
                raise SystemExit(f"pool token order {got} contradicts address order {exp}")
            L.record("token_order_confirmed", f"token0/token1 read from the pool: {got[0][:10]}/{got[1][:10]}")
    print(f"\n{label} / {quote_sym}   uniswap {version}   base_index {ven.base_index}")
    print(f"  base  {token} decimals {bdec} ({bsrc})")
    print(f"  quote {quote_addr or 'native'} decimals {qdec} ({qsrc})")
    BD, QD = 10 ** bdec, 10 ** qdec

    # -- 3: window, boundary block by binary search on real timestamps ---------
    def win():
        head = int(rpc.one("eth_blockNumber", []), 16)
        created = int(match.get("pairCreatedAt") or 0) // 1000
        if not created: raise SystemExit("DexScreener gave no pairCreatedAt")
        def ts(b): return int(rpc.one("eth_getBlockByNumber", [hex(b), False])["timestamp"], 16)
        def find(target, lo, hi):
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if ts(mid) <= target: lo = mid
                else: hi = mid - 1
            return lo
        cb = find(created, 1, head)
        first = None; lo = max(1, cb - 50); step = 5000
        while lo <= head and first is None:
            hi = min(lo + step, head)
            got = rpc.logs(ven.log_address, ven.log_topics, lo, hi)
            if got:
                got.sort(key=lambda l: (int(l["blockNumber"], 16), int(l["logIndex"], 16)))
                first = got[0]; break
            lo = hi + 1; step = min(step * 2, 100000)
        if first is None: raise SystemExit("no swaps found in this pool")
        fb = int(first["blockNumber"], 16); ft = ts(fb)
        end = ft + int(args.window_hours * 3600)
        bnd = find(end, fb, head)
        # COVERAGE IS MEASURED, NOT ASSERTED. A pool younger than --window-hours
        # cannot fill its window: the boundary collapses onto head and the run
        # silently analyses a short window unless this is checked.
        head_ts = ts(head)
        return {"head": head, "head_ts": head_ts, "first_block": fb, "first_ts": ft,
                "end_ts": end, "boundary_block": bnd,
                "boundary_ts": ts(bnd), "fully_covered": head_ts >= end,
                "method": "binary search on block timestamps"}
    W = S.json("window.json", win)
    covered_h = (min(W.get("boundary_ts", W["end_ts"]), W["end_ts"]) - W["first_ts"]) / 3600.0
    if not W.get("fully_covered", True):
        L.record("window_coverage",
                 f"NOT FULLY COVERED: chain head is {utc(W.get('head_ts', 0))}, window ends "
                 f"{utc(W['end_ts'])}; only {covered_h:.2f}h of {args.window_hours}h available")
    else:
        L.record("window_coverage",
                 f"fully covered: {covered_h:.2f}h of {args.window_hours}h requested")
    L.record("window_binary_search",
             f"blocks {W['first_block']:,}..{W['boundary_block']:,} "
             f"({utc(W['first_ts'])} -> {utc(W['end_ts'])}), {W['method']}")
    print(f"  window {args.window_hours}h  blocks {W['first_block']:,}..{W['boundary_block']:,}"
          f"  {utc(W['first_ts'])} -> {utc(W['end_ts'])}")

    # -- 6: swaps -------------------------------------------------------------
    sw = rpc.logs_range(ven.log_address, ven.log_topics,
                        W["first_block"], W["boundary_block"], S, "swaps")
    seen = set(); uniq = []
    for l in sw:
        k = (l["transactionHash"], l["logIndex"])
        if k in seen: continue
        seen.add(k); uniq.append(l)
    sw = uniq
    by_tx = defaultdict(list)
    for l in sw: by_tx[l["transactionHash"]].append(l)
    print(f"  swaps in window {len(sw):,}   unique transactions {len(by_tx):,}")

    # -- 7: supply, reconciled ------------------------------------------------
    def supply():
        z32 = "0x" + "0" * 64
        mint = rpc.logs_range(token, [TOPICS["transfer"], z32],
                              W["first_block"], W["boundary_block"], S, "mints")
        burn = rpc.logs_range(token, [TOPICS["transfer"], None, z32],
                              W["first_block"], W["boundary_block"], S, "burns")
        mv = sum(int(l["data"], 16) for l in mint) / BD
        bv = sum(int(l["data"], 16) for l in burn) / BD
        # ANCHOR BEFORE THE WINDOW. totalSupply() at block B reflects state AFTER
        # B, so anchoring at first_block would double-count a mint landing in that
        # same block -- which is exactly what happens when the window opens on the
        # pool's creation block.
        raw = rpc.call(token, SEL["total_supply"], hex(W["first_block"] - 1))
        if raw is None:
            # Distinguish "not deployed yet" from "the call failed". Only the
            # former is legitimately zero; the latter must abort.
            code = rpc.one("eth_getCode", [token, hex(W["first_block"] - 1)])
            if code in ("0x", "0x0"):
                s0, s0_src = 0.0, "contract not deployed before the window (eth_getCode empty)"
            else:
                raise SystemExit("totalSupply() unreadable before the window, but code exists")
        else:
            s0, s0_src = int(raw, 16) / BD, "totalSupply() read"
        s1 = int(rpc.call(token, SEL["total_supply"], hex(W["boundary_block"])), 16) / BD
        return {"first": s0, "first_source": s0_src, "last": s1,
                "mints": len(mint), "burns": len(burn),
                "minted": mv, "burned": bv,
                "events": sorted([[int(l["blockNumber"], 16), int(l["data"], 16) / BD] for l in mint]
                                 + [[int(l["blockNumber"], 16), -int(l["data"], 16) / BD] for l in burn])}
    SUP = S.json("supply.json", supply)
    drift = (SUP["first"] + SUP["minted"] - SUP["burned"]) - SUP["last"]
    if abs(drift) > 1e-6:
        L.fail("supply_reconciled", f"start+mints-burns differs from end by {drift:.6f}")
    else:
        L.record("supply_reconciled",
                 f"before window {SUP['first']:,.4f} + {SUP['minted']:,.4f} minted "
                 f"- {SUP['burned']:,.4f} burned = {SUP['last']:,.4f} at boundary "
                 f"[{SUP.get('first_source','')}]; "
                 f"{SUP['mints']} mint / {SUP['burns']} burn events")
    def supply_at(b):
        s = SUP["first"]
        for blk, d in SUP["events"]:
            if blk <= b: s += d
        return s

    # -- 4/5: quote -> USD ----------------------------------------------------
    QU = S.json("quote_usd.json", lambda: resolve_quote(rpc, chain, ven, quote_addr,
                                                        quote_sym, qdec, W, S))
    rate = (lambda _t, m=QU["mean"]: m) if QU["mode"] == "constant" else \
           (lambda t, ts=QU["ts"], px=QU["px"]: px[min(range(len(ts)), key=lambda i: abs(ts[i]-t))])
    print(f"  quote USD: {QU['basis']}")

    # -- 8: receipts ----------------------------------------------------------
    keep = {token} | ({quote_addr} if quote_addr and quote_addr != ZERO else set())
    rec = rpc.receipts(sorted(by_tx), keep, S)

    # -- 10: round-trippers (circular arb, at swap granularity) ---------------
    EXCL = infra.excluded_set(args.chain, [ven.venue_address])
    VA = ven.venue_address
    def rts(v):
        got, gave = set(), set()
        for a, b, _d, addr in v.get("transfers", []):
            if addr != token: continue
            if "0x" + a == VA: got.add("0x" + b)
            if "0x" + b == VA: gave.add("0x" + a)
        return (got & gave) - EXCL
    raw_rule_txs = sum(1 for v in rec.values()
                       if any("0x" + a == VA for a, _b, _d, ad in v.get("transfers", []) if ad == token)
                       and any("0x" + b == VA for _a, b, _d, ad in v.get("transfers", []) if ad == token))
    all_rt = set()
    for v in rec.values(): all_rt |= rts(v)
    L.record("circular_arb_applied",
             f"raw rule matched {raw_rule_txs:,} of {len(by_tx):,} txs; applied per swap via "
             f"{len(all_rt):,} round-tripper address(es)")
    L.record("infrastructure_excluded",
             f"{len(EXCL)} global addresses from config/infrastructure.yaml, applied at candidate stage")

    def net_of(v):
        n = defaultdict(float)
        for a, b, data, addr in v.get("transfers", []):
            if addr != token: continue
            x = int(data, 16) / BD
            n["0x" + a] -= x; n["0x" + b] += x
        return n

    # -- 9: fee, measured from unambiguous single-side transactions -----------
    fees = {"buy": [], "sell": []}
    for h, g in by_tx.items():
        if len(g) > 2: continue
        v = rec.get(h)
        if not v: continue
        rt = rts(v); net = net_of(v)
        mv = {k: x for k, x in net.items()
              if abs(x) > 1e-12 and k not in EXCL and k not in rt}
        for l in g:
            ba, _qa = ven.amounts(l["data"])
            if ba == 0: continue
            side = ven.side(ba)
            if sum(1 for x in g if ven.side(ven.amounts(x["data"])[0]) == side) != 1:
                continue
            pool_amt = abs(ba) / BD
            cand = {k: x for k, x in mv.items() if (x > 0) == (side == "buy")}
            if not cand: continue
            w = max(cand.items(), key=lambda kv: abs(kv[1]))[0]
            fees[side].append(abs(cand[w]) / pool_amt)
    FEE, fee_rep = {}, []
    for side in ("buy", "sell"):
        v = sorted(fees[side])
        if not v:
            FEE[side] = 0.0
            fee_rep.append(f"  {side}: NO SAMPLES -- fee assumed 0%, which is a gap, not a measurement")
            L.fail("fee_measured", f"no unambiguous {side} samples")
            continue
        med = statistics.median(v)
        p1, p99 = v[len(v)//100], v[min(len(v)-1, 99*len(v)//100)]
        FEE[side] = 1.0 - med
        fee_rep.append(f"  {side}: n={len(v):,} median {med:.6f} p1 {p1:.6f} p99 {p99:.6f} "
                       f"{'FLAT' if abs(p99-p1) < 1e-6 else 'VARIABLE'} -> fee {FEE[side]*100:.4f}%")
    if "fee_measured" not in L.rows:
        L.record("fee_measured", f"buy {FEE['buy']*100:.4f}% / sell {FEE['sell']*100:.4f}%, "
                                 f"from single-side transactions")
    return dict(L=L, S=S, rpc=rpc, ven=ven, token=token, label=label, base_sym=base_sym, qdec=qdec,
                quote_sym=quote_sym, quote_addr=quote_addr, BD=BD, QD=QD, W=W, SUP=SUP,
                supply_at=supply_at, QU=QU, rate=rate, sw=sw, by_tx=by_tx, rec=rec,
                EXCL=EXCL, rts=rts, net_of=net_of, FEE=FEE, fee_rep=fee_rep,
                args=args, chain=chain, all_rt=all_rt, raw_rule_txs=raw_rule_txs)


def resolve_quote(rpc, chain, ven, quote_addr, quote_sym, qdec, W, S):
    """
    Quote -> USD by route (spec section 5). Tier 2 candidates are filtered on
    creation time BEFORE depth: a pool created after the window cannot price it.
    """
    kind = qp.classify(quote_sym, quote_addr)
    t0, t1 = W["first_ts"], W["end_ts"]
    if kind == "stable":
        return {"mode": "constant", "mean": 1.0, "ts": [], "px": [],
                "tier": 0, "spread_pct": 0.0,
                "basis": f"constant 1.00 USD/{quote_sym} (USD stablecoin)"}
    if kind == "native":
        ts, px = pricing_mod.fetch_hourly(chain["coingecko_id"], t0, t1)
        mode, _fn, rep = qp.choose_method(ts, px, t0, t1)
        return {"mode": mode, "mean": rep["mean"], "ts": ts, "px": px, "tier": 1,
                "spread_pct": rep["spread_pct"],
                "basis": (f"{'constant %.2f' % rep['mean'] if mode=='constant' else 'hourly'} "
                          f"USD/{quote_sym} (CoinGecko, {rep['points']} points; moved "
                          f"{rep['spread_pct']:.2f}% across the window, bar is "
                          f"{rep['threshold_pct']:.0f}%)")}
    # tier 2: price the quote on-chain against a tier-0/1 asset
    cands = qp.candidate_references(chain["dexscreener_slug"], quote_addr, quote_sym, t0)
    if not cands:
        raise SystemExit(f"no reference pool for {quote_sym} predating the window")
    print(f"  tier-2 quote: {len(cands)} reference pool(s) predate the window; "
          f"choosing {cands[0]['other_symbol']} route")
    c = cands[0]
    ver = (c["labels"] or ["v3"])[0].lower()
    other = str(c["other_address"]).lower()
    rv = Venue(ver, c["pair"], quote_addr, other, chain.get("v4_pool_manager"), TOPICS)
    odec = 18 if other == ZERO else int(rpc.call(other, SEL["decimals"]), 16)
    print(f"    reference {c['pair'][:20]}.. {ver} counter {c['other_symbol']} decimals {odec}")
    lo, hi = W["first_block"] - 30000, W["boundary_block"] + 30000
    rl = rpc.logs_range(rv.log_address, rv.log_topics, lo, hi, S, "quote_ref")
    bt = rpc.block_ts(sorted({int(l["blockNumber"], 16) for l in rl}), S, "quote_ref_bt")
    if c["other_kind"] == "native":
        ots, opx = pricing_mod.fetch_hourly(chain["coingecko_id"], t0, t1)
        oat = lambda t: opx[min(range(len(ots)), key=lambda i: abs(ots[i] - t))]
    else:
        oat = lambda _t: 1.0
    pts = []
    for l in rl:
        qa, oa = rv.amounts(l["data"])          # quote asset, counter asset
        if qa == 0 or oa == 0: continue
        q = abs(qa) / 10 ** qdec; o = abs(oa) / 10 ** odec
        if q <= 0: continue
        t = bt[int(l["blockNumber"], 16)]
        pts.append([t, (o / q) * oat(t)])
    pts.sort()
    inw = [p for t, p in pts if t0 <= t <= t1]
    hours = {}
    for t, p in pts: hours.setdefault(t // 3600, []).append(p)
    need = (t1 // 3600) - (t0 // 3600) + 1
    cov = sum(1 for h in range(t0 // 3600, t1 // 3600 + 1) if h in hours)
    series = sorted((h * 3600 + 1800, statistics.median(v)) for h, v in hours.items())
    ts = [a for a, _ in series]; px = [b for _, b in series]
    mode, _fn, rep = qp.choose_method(ts, px, t0, t1)
    mean = statistics.mean(inw) if inw else rep["mean"]
    lo_, hi_ = (min(inw), max(inw)) if inw else (rep["min"], rep["max"])
    spread = 100 * (hi_ - lo_) / mean if mean else 0.0
    mode = "constant" if spread <= LIM["constant_rate_max_spread_pct"] else "per_trade"
    return {"mode": mode, "mean": mean, "ts": ts, "px": px, "tier": 2,
            "spread_pct": spread, "coverage": f"{cov}/{need}", "ref_pool": c["pair"],
            "basis": (f"{'constant %.4f' % mean if mode=='constant' else 'hourly'} "
                      f"USD/{quote_sym}, from the {quote_sym}/{c['other_symbol']} "
                      f"{c['dex']} {ver} pool {c['pair']} ({len(inw)} in-window swaps, "
                      f"{cov}/{need} hours covered; {quote_sym} moved {spread:.2f}% across "
                      f"the window, bar is {LIM['constant_rate_max_spread_pct']:.0f}%)")}


def decode_and_report(C):
    L, S, rpc, ven, args = C["L"], C["S"], C["rpc"], C["ven"], C["args"]
    token, BD, QD = C["token"], C["BD"], C["QD"]
    by_tx, rec, EXCL, rts, net_of, FEE = (C["by_tx"], C["rec"], C["EXCL"], C["rts"],
                                          C["net_of"], C["FEE"])
    W, sw = C["W"], C["sw"]

    bt = rpc.block_ts(sorted({int(l["blockNumber"], 16) for l in sw}), S)

    trades, blocked, unattr, from_match = [], defaultdict(int), 0, 0
    for h, g in by_tx.items():
        v = rec.get(h)
        if not v: continue
        rt = rts(v); net = net_of(v)
        for l in g:
            ba, qa = ven.amounts(l["data"])
            if ba == 0 or qa == 0: continue
            side = ven.side(ba)
            pool_amt = abs(ba) / BD
            raw = {k: x for k, x in net.items()
                   if abs(x) > 1e-12 and (x > 0) == (side == "buy")}
            for k in raw:
                if k in EXCL: blocked[k] += 1
            cand = {k: x for k, x in raw.items() if k not in EXCL and k not in rt}
            if not cand: unattr += 1; continue
            w = max(cand.items(), key=lambda kv: abs(kv[1]))[0]
            if w == v.get("from"): from_match += 1
            b = int(l["blockNumber"], 16)
            # ROUTER SPLIT: this swap's OWN pool amount minus its OWN fee.
            trades.append({"tx": h, "block": b, "t": bt[b], "wallet": w, "side": side,
                           "quote": abs(qa) / QD, "token": pool_amt * (1.0 - FEE[side]),
                           "pool_token": pool_amt, "path": "single" if len(g) == 1 else "multiswap",
                           "logIndex": int(l["logIndex"], 16)})
    bad = [t for t in trades
           if abs(t["token"] - t["pool_token"] * (1 - FEE[t["side"]])) > 1e-9 * max(1, t["pool_token"])]
    if bad: L.fail("router_split_own_amount", f"{len(bad)} trades not equal to own pool amount minus own fee")
    else: L.record("router_split_own_amount",
                   f"all {len(trades):,} trades use the swap's own pool amount minus its own fee")
    pct = 100.0 * from_match / max(1, len(trades))
    L.record("attribution_balance_delta",
             f"attributed by wallet balance delta; the attributed wallet equals tx.from in "
             f"only {from_match:,}/{len(trades):,} ({pct:.1f}%) of trades")

    byw = defaultdict(list)
    for t in trades: byw[t["wallet"]].append(t)
    first = {}
    for t in sorted(trades, key=lambda x: (x["block"], x["logIndex"])):
        if t["side"] == "buy" and t["wallet"] not in first: first[t["wallet"]] = t
    rate = C["rate"]; supply_at = C["supply_at"]
    mc = {w: (t["quote"] / t["token"]) * supply_at(t["block"]) * rate(t["t"])
          for w, t in first.items() if t["token"] > 0}
    THR = args.mcap_threshold
    under = [w for w, m in mc.items() if m < THR]
    binding = not (len(under) == len(mc) and len(mc) > 0)
    excess = set()
    for w, ts in byw.items():
        b = sum(t["token"] for t in ts if t["side"] == "buy")
        s = sum(t["token"] for t in ts if t["side"] == "sell")
        if s - b > 1: excess.add(w)
    cohort = sorted(set(under) - excess)

    # Price at head, for unrealized only. v3 pools expose slot0; a v4 pool has no
    # contract of its own, so fall back to the pair's quoted USD price. Head is
    # pinned in window.json so re-runs stay deterministic.
    C_QU_MEAN = C["QU"]["mean"]; C_SLUG = C["chain"]["dexscreener_slug"]
    def head_price():
        if ven.version == "v3":
            sl = rpc.call(ven.pool, "0x3850c7bd", hex(W["head"]))
            if sl:
                sq = int(sl[2:66], 16)
                p01 = (sq / (2 ** 96)) ** 2          # token0 priced in token1
                if p01:
                    # slot0 gives token0 priced in token1. If the base token IS
                    # token1, the base's price in the quote is the reciprocal.
                    base_in_quote = (1.0 / p01) if ven.base_index == 1 else p01
                    return {"native": base_in_quote,
                            "usd": base_in_quote * C_QU_MEAN,
                            "source": f"slot0 at block {W['head']:,} x the window quote rate"}
        for pr in qp.dexscreener_pairs(C_SLUG, token):
            if str(pr.get("pairAddress", "")).lower() == args.pool.lower() and pr.get("priceUsd"):
                return {"native": None, "usd": float(pr["priceUsd"]),
                        "source": "DexScreener pair priceUsd (live)"}
        return {"native": None, "usd": None, "source": "unavailable"}
    HP = S.json("head_price.json", head_price)
    print(f"  price at head: ${HP['usd']}  ({HP['source']})")

    head_b = rpc.balances(token, cohort, W["head"], S)
    bnd_b = rpc.balances(token, cohort, W["boundary_block"], S)
    tf = rpc.logs_range(token, [TOPICS["transfer"]], W["first_block"], W["boundary_block"], S, "transfers")
    cs = set(cohort); VA = ven.venue_address
    offcnt = defaultdict(int); rawnet = defaultdict(float)
    for l in tf:
        if len(l["topics"]) < 3: continue
        a = "0x" + l["topics"][1][-40:].lower(); b = "0x" + l["topics"][2][-40:].lower()
        x = int(l["data"], 16) / BD
        if a in cs:
            rawnet[a] -= x
            if b != VA: offcnt[a] += 1
        if b in cs:
            rawnet[b] += x
            if a != VA: offcnt[b] += 1

    rows, netflow_diff = [], 0
    for w in cohort:
        ts = sorted(byw[w], key=lambda x: (x["block"], x["logIndex"]))
        lots = deque(); real = 0.0; bought = sold = qin = qout = 0.0
        nb = ns = 0; fb = ls = None
        for t in ts:
            u = t["quote"] / t["token"] if t["token"] else 0.0
            if t["side"] == "buy":
                lots.append([t["token"], u]); bought += t["token"]; qin += t["quote"]; nb += 1
                if fb is None: fb = t["t"]
            else:
                need = t["token"]; sold += t["token"]; qout += t["quote"]; ns += 1; ls = t["t"]
                while need > 1e-15 and lots:
                    lot = lots[0]; take = min(need, lot[0])
                    real += take * (u - lot[1]); lot[0] -= take; need -= take
                    if lot[0] <= 1e-15: lots.popleft()
                if need > 1e-15: real += need * u     # unsold inventory valued at zero
        if abs(real - (qout - qin)) > 1e-9: netflow_diff += 1
        imp = bought - sold
        onc = head_b[w] / BD; bnd = bnd_b[w] / BD
        rows.append({"wallet": w, "token": C["label"], "chain": args.chain,
            "quote_asset": C["quote_sym"], "tag": None, "tag_source": None,
            "first_buy_time_utc": utc(fb) if fb else None,
            "last_sell_time_utc": utc(ls) if ls else None,
            "n_buys": nb, "n_sells": ns, "sol_in": qin, "sol_out": qout,
            "realized_pnl_sol": real, "realized_pnl_usd": real * C["QU"]["mean"],
            "tokens_still_held": sum(l[0] for l in lots),
            "hold_min": (ls - fb) / 60.0 if (fb and ls) else None,
            "sold_out": imp <= 1e-6, "pre_window_entry": ts[0]["side"] == "sell",
            "first_buy_mcap_usd": mc.get(w), "rate_basis": C["QU"]["basis"],
            "tokens_bought": bought, "tokens_sold": sold,
            "implied_balance": imp, "onchain_balance": onc,
            "balance_delta": onc - imp, "balance_match": abs(bnd - imp) <= 1e-6,
            "boundary_balance": bnd, "boundary_delta": bnd - imp,
            "unrealized_pnl_usd": (onc * HP["usd"]) if HP["usd"] else None,
            "still_holding": onc > 0,
            "has_off_pool_activity": offcnt.get(w, 0) > 0,
            "price_usd": HP["usd"], "price_block": W["head"], "balance_block": W["head"]})
    C["HP"] = HP
    L.record("fifo_not_netflow",
             f"FIFO with unsold inventory at zero; differs from net flow for "
             f"{netflow_diff:,} of {len(rows):,} wallets")
    L.enforce()
    return dict(trades=trades, rows=rows, mc=mc, cohort=cohort, under=under,
                binding=binding, excess=excess, byw=byw, blocked=blocked,
                unattr=unattr, rawnet=rawnet, bnd_b=bnd_b, offcnt=offcnt, THR=THR)


def report(C, D):
    """Every validation check in spec section 8. Zeros are stated as zeros."""
    rows, trades, BD = D["rows"], D["trades"], C["BD"]
    W, S, ven = C["W"], C["S"], C["ven"]
    n = len(rows); P = print
    P("\n" + "=" * 72)
    P(f"{C['label']} / {C['quote_sym']}   uniswap {ven.version}   chain {C['args'].chain}")
    P("=" * 72)
    P(f"\nWINDOW  {C['args'].window_hours}h   blocks {W['first_block']:,}..{W['boundary_block']:,}")
    P(f"  {utc(W['first_ts'])} -> {utc(W['end_ts'])}")
    fc = W.get("fully_covered", True)
    ch = (min(W.get("boundary_ts", W["end_ts"]), W["end_ts"]) - W["first_ts"]) / 3600.0
    P(f"  swaps in window {len(C['sw']):,}   unique transactions {len(C['by_tx']):,}")
    P(f"  fully_covered = {str(fc).lower()}   {ch:.2f}h of {C['args'].window_hours}h covered"
      + ("" if fc else f"   ** the chain has not reached the window end ({utc(W['end_ts'])}) **"))
    P(f"\nSUPPLY  first {C['SUP']['first']:,.4f}   last {C['SUP']['last']:,.4f}   "
      f"{C['SUP']['mints']} mints / {C['SUP']['burns']} burns   reconciles")
    P(f"\nQUOTE   {C['QU']['basis']}")
    P(f"        tier {C['QU']['tier']}   method {C['QU']['mode']}")
    P("\nFEE, measured on unambiguous single-side transactions:")
    for line in C["fee_rep"]: P(line)
    P(f"\nCIRCULAR ARB ({ven.version}: {'pool contract' if ven.version=='v3' else 'PoolManager'} "
      f"both sends AND receives the token in one transaction)")
    P(f"  transactions matching the raw rule: {C['raw_rule_txs']:,} of {len(C['by_tx']):,}")
    P(f"  round-tripper addresses excluded at candidate stage: {len(C['all_rt']):,}")
    if not C["all_rt"]:
        P("  ZERO round-trippers. Stated as a zero, not treated as a pass: on this token the "
          "rule found nothing to exclude.")
    P(f"\nINFRASTRUCTURE EXCLUSION (config/infrastructure.yaml, candidate stage)")
    if D["blocked"]:
        for k, c in sorted(D["blocked"].items(), key=lambda x: -x[1]):
            lab = next((l for a, l, _ in infra.load(C["args"].chain) if a == k), "tracked-pool/venue")
            P(f"  {k}  {lab:<24} blocked on {c:,} swaps")
    else:
        P("  ZERO swaps had an infrastructure address as a candidate. Stated as a zero.")
    P(f"\nDECODE  {len(trades):,} trades   unattributable {D['unattr']:,}   "
      f"{len(trades)+D['unattr']:,} accounted of {len(C['sw']):,} swaps")
    paths = defaultdict(int)
    for t in trades: paths[t["path"]] += 1
    P(f"  paths {dict(paths)}   wallets attributed {len({t['wallet'] for t in trades}):,}")

    mcv = sorted(D["mc"].values())
    if mcv:
        q = lambda p: mcv[min(len(mcv)-1, int(p*len(mcv)))]
        P(f"\nMCAP AT FIRST BUY ({len(mcv):,} buyers)")
        for lab, v in (("min", mcv[0]), ("p25", q(.25)), ("median", statistics.median(mcv)),
                       ("p75", q(.75)), ("max", mcv[-1])):
            P(f"    {lab:>6}  ${v:>14,.0f}")
        step = max(1, int(mcv[-1] / 20)); bk = defaultdict(int)
        for x in mcv: bk[int(x // step)] += 1
        mx = max(bk.values())
        P(f"  histogram (${step:,} buckets):")
        for i in sorted(bk):
            P(f"    ${i*step:>12,}-${(i+1)*step:>12,} {bk[i]:>5,} {'#'*int(40*bk[i]/mx)}")
        pctu = 100.0 * len(D["under"]) / len(mcv)
        P(f"\n  THRESHOLD ${D['THR']:,}: {len(D['under']):,} of {len(mcv):,} ({pctu:.1f}%)")
        P(f"  threshold_binding = {D['binding']}"
          + ("" if D["binding"] else "  ** admits everything; the cohort is defined by the window **"))
    P(f"  excess sellers {len(D['excess']):,}   COHORT {n:,}")

    TOL = 1e-6
    m = sum(1 for r in rows if abs(r["boundary_delta"]) <= TOL)
    nz = [r for r in rows if r["boundary_balance"] > 0]
    nzm = sum(1 for r in nz if abs(r["boundary_delta"]) <= TOL)
    po = [r for r in rows if not r["has_off_pool_activity"]]
    pom = sum(1 for r in po if abs(r["boundary_delta"]) <= TOL)
    ponz = [r for r in po if r["boundary_balance"] > 0]
    ponzm = sum(1 for r in ponz if abs(r["boundary_delta"]) <= TOL)
    P(f"\nBALANCE VALIDATION at the boundary block {W['boundary_block']:,}")
    P(f"  implied == on-chain, all wallets:  {m:,}/{n:,} ({100*m/max(n,1):.1f}%)")
    P(f"  wallets with a nonzero balance:    {nzm:,}/{len(nz):,} "
      f"({100*nzm/max(len(nz),1):.1f}%)")
    P(f"  POOL-ONLY SUBSET (carries weight): {pom:,}/{len(po):,} "
      f"({100*pom/max(len(po),1):.1f}%)")
    P(f"    of those with a nonzero balance: {ponzm:,}/{len(ponz):,} "
      f"({100*ponzm/max(len(ponz),1):.1f}%)")
    dl = sorted(abs(r["boundary_delta"]) for r in rows)
    if dl:
        qq = lambda p: dl[min(len(dl)-1, int(p*len(dl)))]
        P(f"  |delta| p50 {qq(.5):.6g}  p90 {qq(.9):.6g}  p99 {qq(.99):.6g}  max {dl[-1]:.6g}")
    bp = defaultdict(lambda: [0, 0])
    for r in rows:
        k = ",".join(sorted({t["path"] for t in D["byw"][r["wallet"]]}))
        bp[k][0] += 1; bp[k][1] += abs(r["boundary_delta"]) <= TOL
    P("  match rate by attribution path:")
    for k, (t_, m_) in sorted(bp.items()):
        P(f"    {k:<22} {m_:>5,}/{t_:<6,} {100*m_/t_:>5.1f}%")
    mm = [r for r in rows if abs(r["boundary_delta"]) > TOL]
    P(f"  mismatches {len(mm):,}, of which with off-pool activity "
      f"{sum(1 for r in mm if r['has_off_pool_activity']):,}")
    recn = sum(1 for r in rows if abs(D["rawnet"].get(r["wallet"], 0.0) - r["boundary_balance"]) <= TOL)
    P(f"  transfer-log net == on-chain balance: {recn:,}/{n:,} "
      f"({100*recn/max(n,1):.1f}%)  (transfer pull completeness)")

    pn = sorted(r["realized_pnl_usd"] for r in rows)
    P(f"\nFIFO PnL  cohort {n:,}   median ${statistics.median(pn) if pn else 0:,.2f}   "
      f"total ${sum(pn):,.2f}")
    P(f"  winners {sum(1 for x in pn if x>0):,}  losers {sum(1 for x in pn if x<0):,}  "
      f"flat {sum(1 for x in pn if x==0):,}   still holding "
      f"{sum(1 for r in rows if r['still_holding']):,}")
    top = sorted(rows, key=lambda r: -r["realized_pnl_usd"])[:10]
    P("\nTOP 10")
    P(f"  {'wallet':<44}{'PnL USD':>11}{'bought':>16}{'sold':>16}{'onchain':>14}")
    for r in top:
        P(f"  {r['wallet']:<44}{r['realized_pnl_usd']:>11,.0f}{r['tokens_bought']:>16,.0f}"
          f"{r['tokens_sold']:>16,.0f}{r['onchain_balance']:>14,.0f}")
    if top:
        w = top[0]["wallet"]
        P(f"\nFIFO WALKTHROUGH — {w}")
        lots = deque(); run_ = 0.0
        for t in sorted(D["byw"][w], key=lambda x: (x["block"], x["logIndex"])):
            u = t["quote"] / t["token"]
            if t["side"] == "buy":
                lots.append([t["token"], u])
                P(f"  BUY  {t['token']:>15,.2f} @ {u:.4e}  cost {t['quote']:>10.6f}  blk {t['block']:,}")
            else:
                need = t["token"]; g = 0.0
                while need > 1e-15 and lots:
                    lot = lots[0]; take = min(need, lot[0]); g += take * (u - lot[1])
                    lot[0] -= take; need -= take
                    if lot[0] <= 1e-15: lots.popleft()
                if need > 1e-15: g += need * u
                run_ += g
                P(f"  SELL {t['token']:>15,.2f} @ {u:.4e}  proceeds {t['quote']:>10.6f}  "
                  f"gain {g:+.6f}  running {run_:+.6f}  blk {t['block']:,}")
        P(f"  TOTAL {run_:+.6f} {C['quote_sym']} x ${C['QU']['mean']:,.4f} = "
          f"${run_*C['QU']['mean']:,.2f}   unsold {sum(l[0] for l in lots):,.2f}")
    P("\n" + C["L"].report())
    P(f"\nNOT LOADED. Run again with --load to build the payload.")
    json.dump({"rows": rows}, open(S.p("rows.json"), "w"))


def build_payload(C, D):
    """rows + clusters + token record, ready for scripts/load_tokens.mjs."""
    rows, trades, args = D["rows"], D["trades"], C["args"]
    label, EXCL = C["label"], C["EXCL"]
    cohort = {r["wallet"] for r in rows}
    sig = {h: (v or {}).get("from", "") for h, v in C["rec"].items()}
    txw = defaultdict(set)
    for t in trades:
        if t["wallet"] in cohort: txw[t["tx"]].add(t["wallet"])
    bysig = defaultdict(set)
    for tx, ws in txw.items():
        sg = sig.get(tx, "")
        if not sg or sg in EXCL: continue
        for w in ws:
            if w != sg: bysig[sg].add(w)
    cand = {k: v for k, v in bysig.items() if len(v) > 1}
    sizes = sorted({len(v) for v in cand.values()})
    gap, cut = 0, None
    for i in range(1, len(sizes)):
        if sizes[i] - sizes[i - 1] > gap and sizes[i] >= 10:
            gap, cut = sizes[i] - sizes[i - 1], sizes[i]
    pre = label.lower()
    clusters = []; n = 0; dropped = 0
    for sg, ws in sorted(cand.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        if cut and len(ws) >= cut: dropped += 1; continue
        n += 1
        for w in sorted(ws):
            clusters.append({"chain": args.chain, "wallet": w, "cluster_id": f"{pre}-s{n:03d}",
                             "signal": "shared_signer", "evidence": sg,
                             "confidence": "high", "cluster_size": len(ws)})
    m = 0
    for tx, ws in sorted(txw.items()):
        if len(ws) < 2: continue
        m += 1
        for w in sorted(ws):
            clusters.append({"chain": args.chain, "wallet": w, "cluster_id": f"{pre}-t{m:03d}",
                             "signal": "same_transaction", "evidence": tx,
                             "confidence": "high", "cluster_size": len(ws)})
    print(f"\nCLUSTERS  shared_signer {n} (infrastructure cut at >= {cut}, gap {gap}, "
          f"{dropped} dropped)   same_transaction {m}")
    if m == 0:
        print("  same_transaction produced ZERO clusters. Stated as a zero.")
    W, QU, HP = C["W"], C["QU"], C["HP"]
    tok = {"token": label, "chain": args.chain, "token_address": C["token"],
           "pool_address": args.pool, "dex": "uniswap", "dex_version": C["ven"].version,
           "quote_asset": C["quote_sym"], "quote_address": C["quote_addr"],
           "quote_decimals": C["qdec"], "total_supply": C["SUP"]["last"],
           "window_hours": args.window_hours,
           "window_start_utc": utc(W["first_ts"]), "window_end_utc": utc(W["end_ts"]),
           "first_swap_block": W["first_block"], "boundary_block": W["boundary_block"],
           "swaps_in_window": len(C["sw"]), "unique_txs": len(C["by_tx"]),
           "fully_covered": bool(W.get("fully_covered", True)),
           # Measured coverage, not the requested window. The two differ exactly
           # when the pool is younger than --window-hours.
           "covered_hours": round((min(W.get("boundary_ts", W["end_ts"]), W["end_ts"])
                                   - W["first_ts"]) / 3600.0, 4),
           "mcap_threshold_usd": args.mcap_threshold,
           "threshold_binding": D["binding"],
           "threshold_note": (f"highest first-buy mcap was ${max(D['mc'].values()):,.0f} against a "
                              f"${args.mcap_threshold:,.0f} ceiling, {len(D['under']):,} of "
                              f"{len(D['mc']):,} admitted"),
           "fee_rate_buy": C["FEE"]["buy"], "fee_rate_sell": C["FEE"]["sell"],
           "usd_method": QU["mode"], "rate_basis": QU["basis"],
           "price_usd": HP["usd"], "price_block": W["head"], "balance_block": W["head"],
           "cohort_size": len(rows),
           "decode_check": (f"pool-only subset reproduces the on-chain balance for "
                            f"{sum(1 for r in rows if not r['has_off_pool_activity'] and abs(r['boundary_delta'])<=1e-6):,}"
                            f"/{sum(1 for r in rows if not r['has_off_pool_activity']):,} wallets. "
                            f"Boundary is the LAST block with timestamp <= window end. "
                            f"Infrastructure excluded at the candidate stage.")}
    return {"rows": rows, "clusters": clusters, "token": tok}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--token", required=True)
    ap.add_argument("--pool", required=True)
    ap.add_argument("--mcap-threshold", type=float, required=True)
    ap.add_argument("--window-hours", type=float, required=True)
    ap.add_argument("--chain", default="robinhood")
    ap.add_argument("--load", action="store_true",
                    help="build the load payload; still never writes to Postgres itself")
    a = ap.parse_args()
    try: sys.stdout.reconfigure(line_buffering=True)   # progress visible when backgrounded
    except Exception: pass
    if a.chain not in CFG["chains"]:
        raise SystemExit(f"chain {a.chain!r} not in config/pipeline.yaml")
    C = run(a)
    D = decode_and_report(C)
    report(C, D)
    if a.load:
        p = C["S"].p("load_payload.json")
        json.dump(build_payload(C, D), open(p, "w"))
        print(f"\nLOAD PAYLOAD WRITTEN: {p}")
        print("  The database is reachable only from inside Railway, so applying it is a")
        print("  separate step: upload this file and run scripts/load_tokens.mjs --dry first.")


if __name__ == "__main__":
    main()
