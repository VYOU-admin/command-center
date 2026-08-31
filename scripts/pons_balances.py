#!/usr/bin/env python3
"""
balanceOf reads for the PONS cohort, at two blocks.

A missing result is NEVER coerced to zero. An earlier version mapped any absent
`result` to 0.0, and 490 of 1,046 reads were silently rate-limited into fake zero
balances -- which then read as "wallets hold tokens on our books but nothing on
chain". Every wallet here must come back with a value the node actually returned,
or the script fails loudly.
"""
import json, os, time, requests
from dotenv import load_dotenv

S = ("/private/tmp/claude-501/-Users-tomordishnica-projects-command-center/"
     "ad1af308-f68f-4c04-aff1-e23be68c2214/scratchpad")
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
AL = f"https://robinhood-mainnet.g.alchemy.com/v2/{os.environ['ALCHEMY_API_KEY'].strip()}"
TOKEN = "0x39dbed3a2bd333467115de45665cc57f813c4571"
DEC = 10 ** 18
BATCH = 20
_last = [0.0]


def post(b):
    for a in range(8):
        w = _last[0] + 0.35 - time.time()
        if w > 0:
            time.sleep(w)
        _last[0] = time.time()
        try:
            r = requests.post(AL, json=b, timeout=120)
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(min(30, 1.5 * (a + 1) ** 2))
                continue
            j = r.json()
            return j if isinstance(j, list) else [j]
        except Exception:
            time.sleep(min(30, 1.5 * (a + 1) ** 2))
    return None


def read_at(wallets, block, label):
    out, todo, rnd = {}, list(wallets), 0
    while todo and rnd < 12:
        rnd += 1
        fail = []
        for i in range(0, len(todo), BATCH):
            ch = todo[i:i + BATCH]
            res = post([{"jsonrpc": "2.0", "id": j, "method": "eth_call",
                         "params": [{"to": TOKEN, "data": "0x70a08231" + "0" * 24 + w[2:]},
                                    hex(block)]} for j, w in enumerate(ch)])
            if res is None:
                fail += ch
                continue
            got = set()
            for r in res:
                w = ch[r["id"]]
                v = r.get("result")
                if "error" in r or not v or v == "0x":
                    fail.append(w)          # retried, never zeroed
                    continue
                out[w] = int(v, 16) / DEC
                got.add(w)
            fail += [w for w in ch if w not in got and w not in fail]
        todo = sorted(set(fail))
        print(f"  {label} round {rnd}: resolved {len(out):,}/{len(wallets):,}, "
              f"retrying {len(todo):,}", flush=True)
        if todo:
            time.sleep(3)
    if todo:
        raise SystemExit(f"{label}: {len(todo)} wallets never resolved -- refusing "
                         f"to emit partial balances")
    return out


def main():
    rows = json.load(open(S + "/pons_rows_bnd.json"))
    ws = sorted({r["wallet"] for r in rows})
    HEAD = json.load(open(S + "/pons_rows.json"))["head"]
    BND = 9106777
    print(f"reading {len(ws):,} balances at head {HEAD:,} and boundary {BND:,}")
    head = read_at(ws, HEAD, "head")
    bnd = read_at(ws, BND, "boundary")
    json.dump({"head_block": HEAD, "bnd_block": BND, "head": head, "bnd": bnd},
              open(S + "/pons_balances.json", "w"))
    print(f"\nhead nonzero {sum(1 for v in head.values() if v>0):,}/{len(head):,}")
    print(f"bnd  nonzero {sum(1 for v in bnd.values() if v>0):,}/{len(bnd):,}")


if __name__ == "__main__":
    main()
