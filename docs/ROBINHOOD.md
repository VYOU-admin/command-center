# Robinhood Chain

The one document. Everything needed to load, price, score and display a token on
Robinhood Chain (chain 4663). It replaces the separate definitions, procedure,
findings and failure-mode files: there is no second place to look.

Solana is a different chain and keeps its own procedure in
`docs/SOLANA-TOKEN-INTAKE.md`. Nothing here applies to it.

---

## The four rules that keep this document true

1. **This document is read in full before any token work begins.** Not skimmed,
   not searched — read. Then say what in it applies to the token in front of you.
2. **Any bug, workaround or measurement updates this document first and the code
   second.** The document is the specification; the code is an implementation of
   it.
3. **A rule here that the code does not implement is a defect in the code.**
   Always, and in that direction. The code is never the authority.
4. **Nothing gets its own new document.** If it matters, it goes in this one.

These exist because the documents were originally written *after* the code, from
what the code happened to do. That is backwards, and it is why they drifted:
twice a definition was found to be wrong or unproven only after work had been
built on it.

---

## 0. What is loaded right now

*Updated whenever a token is loaded or a defect is found. Last: 2026-09-13.*
**This is the first thing a session needs.** Everything below it is procedure;
this is state.

| token | role | cohorts | rows | wallets | swept to | monitor | scores |
|---|---|---|---|---|---|---|---|
| **PONS** `0x39dBED…4571` | tracked | `PONS-P1` 13,823 · `PONS-P1-T` 396 | 504,502 | 14,138 | 61,173,149 | `token-updates` ✅ | 13,823 |
| **INDEX** `0x56910D…9870` | tracked | `INDEX-P1` 3,316 · `INDEX-P2` 4,267 | 157,129 | 7,230 | 61,193,149 | `index-updates` ✅ | 7,583 |
| **AI** `0x2E8c31…1e18` | tracked | `AI-P1` 3,508 | 59,923 | 3,507 | 61,181,432 | `ai-updates` ✅ | 3,508 |
| **CHUMP** `0x0E0d2C…C21B` | tracked | `CHUMP-P1` 523 | 3,200 | 522 | 61,698,120 | `chump-updates` ✅ | 523 |
| **NVDA** `0xd0601c…9eec` | **pricing-source** | none | 0 | 0 | 59,111,432 | none — correct | never |
| **MOS** `4ChT49…91ZT` | tracked (**Solana**) | `MOS-P1..P4` 519 | 1,534 | 486 | none | none | **never** |
| **USELESS** `Dz9mQ9…bonk` | tracked (**Solana**) | `USELESS-P1..P3` 1,615 | 10,458 | 1,462 | none | none | **never** |

```
row breakdown  PONS  buy 115,189  sell 76,298  transfers 313,015
               INDEX buy  59,020  sell 29,365  transfers  68,744
               AI    buy  22,976  sell 14,764  transfers  21,852
               CHUMP buy   1,292  sell  1,122  transfers     786   AT LOAD
price series   pons 5,171  index 5,488  ai 4,171  chump 49  bridge(NVDA) 4,065
native ETH/USD 10,159 buckets: 9,652 token-incidental, 489 market-derived,
               18 market-repaired.  trade rows with null USD: AI 169, PONS 67, INDEX 0
watchlist      1,275 memberships, 1,181 distinct wallets, top 5%  (CHUMP added 27)
monitors       token-updates, index-updates, ai-updates, chump-updates, token-price,
               wallet-scores, watchlist-watch, oil-prices, postgres-disk  all enabled
watcher        watchlist_activity: 303 rows, 103 tokens (mostly UNTRACKED), cursor
               61,595,492.  67.6% of trades priced since it derives ETH/USD per slice.
               /watchlist tab: DOM-verified 303 rendered = 303 claimed, 0.38 MB
```

**CHUMP IS LOADED. Steps 1–17 complete, 2026-09-13**, at a total of **142,378 CU =
$0.064**. It is the first token driven end to end through the RUNNER rather than the
standalone CLIs, and that alone surfaced **nine defects**, one of which — a write that
reported 3,200 rows stored over an empty table — is the worst failure recorded in this
document. Its findings are in section 8 and every defect is in section 9.

**CASHCAT IS LOADED. Steps 1–17 complete, 2026-09-14**, at a total of **327,660 CU =
$0.147**: **97,834 rows** over a **2,245-wallet** cohort, 99.38% of trade rows priced,
and **113 wallets on the watchlist**. It is the chain's earliest token and the second
driven end to end through the runner. The defect it surfaced is the one worth carrying
forward: **the four floors bound each side of a row independently and nothing bounded
the ratio**, so `buildRows` now fences a row's implied price against its own bucket. Its
findings are in section 8 and the one open item — **metric 5's 1/n_pumps ceiling** — is
in section 9.

**METRIC 5 CHANGED ON 2026-09-14 AND SCORES ACROSS THAT DATE ARE NOT COMPARABLE.**
`prePumpShare` is now the MAXIMUM over pump points of each pump's pre-48h buy share,
where it was the mean. The mean could not exceed **1/n_pumps** — three tokens recorded
a maximum sitting exactly there and this document read each as a fact about wallets.
All six windows were re-scored. **Every score quoted in a section 8 findings block was
computed with the MEAN and is left as that run produced it**; every score in the live
tables is now the maximum. The definition, the measured effect on all six windows, and
the check that no other metric has the same shape are in step 13.

**BONER IS IN PROGRESS, STOPPED AT THE COHORT REVIEW 2026-09-15.** Steps 1–7 complete
at **133,106 CU = $0.060** including HIMS; cohort **1,352 wallets** held in
`token_intake_state` and **nothing written** — tags, rows, windows and scores all 0,
verified on a fresh connection. **It is the SECOND BRIDGE EVER** (HIMS,
`0xccee82fe…3d09`, a tokenised equity like NVDA) and **the first sweep since the
batching fix — 3,202 rows/sec against CASHCAT's 1,248.** Two open items it surfaced are
in section 9: nothing in the repository writes `tokens.role`, and the cohort phase
spends without printing a work set.

**Read the V3-ONLY subsection before loading CASHCAT.** CHUMP is the first token whose
market is v3, and that subsection exists so the next one does not rediscover it.

**PONS was rebuilt on 2026-09-11/12 and is no longer the odd one out.** It now
carries the same rules as AI and INDEX: EIP-7702 accounts kept, 39 routers found
by behaviour rather than the 3 configured, payment-proven cohort membership, and
transfer rows. Cross-token comparison is sound for the first time.

**What is known incomplete, per token:**

- **INDEX — FIXED 2026-09-13. Its 6,052 null-USD trade rows are now 0.** ETH/USD
  is derived from the dedicated WETH/USDG market (1,867,945 swaps, 489 buckets
  added, $0.0193) and the 13,575 rows in the affected range were reinserted. Trade
  nulls chain-wide are now **AI 169, PONS 80, INDEX 0**. Its `index_usd_prices`
  still starts at 5,363,150 — the token's OWN series comes from token/USDG ticks,
  which INDEX did not have that early — so the early dashboard price for INDEX is
  still blank even though its rows are priced. See step 10 and the INDEX findings.
- **NVDA** — **1,443,064 in-scope swap blocks have no stored timestamp.** Benign
  today: NVDA has no cohort and no rows, so nothing calls `loadSlice` on it. It
  becomes a blocker the moment NVDA is tracked rather than used as a bridge, and
  it is ~12 h on the free route or $13 metered.
- **MOS, USELESS** — **Solana**, loaded by the scratchpad scripts that were
  lost. Nothing in this document applies to them. Tagged but **never scored**:
  `wallet-scores` requires an explicit `chain` and is Robinhood-only, which is
  correct — it once scored these two from a Robinhood monitor. They are frozen
  history until a Solana scorer exists.
- **All three tracked tokens** — rows extend past the swept range because the
  hourly job runs ahead of the last sweep. That tail is now written by the
  **fixed** adapter (carrying `log_index` and a real `counterparty`), so it is
  no longer a region of known-wrong rows; before 2026-09-12 it was.

---

## 1. What this system is for

Given a token and a period of time, find every wallet that bought it in that
period, work out roughly how much each bought, roughly what they paid, roughly
what they made, and whether they still hold. Then score those wallets so the
interesting ones can be found again, and show it all on a dashboard.

Approximation is acceptable on the **dollar** figures. It is not acceptable on
**who bought** and **which trade belongs to whom** — a real buyer dropped from a
cohort, or a trade credited to the wrong address, is the failure this system
exists to avoid. Spend effort there.

---

## 2. What you supply

Everything else is read from the chain. Pools, decimals, prices and symbols are
never supplied by hand, because a value that is asserted rather than read is how
a figure ends up wrong by a factor of 10^12.

| input | format | example |
|---|---|---|
| token address | checksummed, exactly as the chain returns it | `0x39dBED3a2bd333467115dE45665cC57F813C4571` |
| ticker | short symbol, used as the tag prefix | `PONS` |
| charted pool | the pool you were looking at when you picked the window; recorded, never used as a filter | `0x10cc6bd3…` |
| window bounds | one or more, each with a label and an **offset-qualified** start and end | `PONS-P1`, `2026-07-21T00:00:00+00:00` → `2026-08-21T23:59:59+00:00` |
| pump points | zero or more instants, **offset-qualified**, used by two scoring metrics | `2026-08-07T04:00:00-04:00` |

**Every instant carries its offset.** A bare local time is a different moment
depending on who reads it. "08-07 04:00 Eastern" is `08:00Z` in August and
`09:00Z` in December, and both scoring metrics that use pump points key off a
48-hour window and a linear distance to that instant. The runner rejects an
instant with no offset rather than guessing.

**The window is what you commissioned, not what was observed.** A window over
12:00–14:00 whose earliest buy landed at 12:09 still covered 12:00–14:00.
Deriving the bounds back from the rows would silently redefine the period as
whatever happened to trade, and shrink a quiet window to nothing.

**Each window is scored separately, and the score-quality thresholds are
properties of the WINDOW, not of the token.** INDEX proved it: the `low-weight`
threshold **derived to 0.625 for INDEX-P1** from a real gap across two distinct
partial weights, while **INDEX-P2 had no partial weights at all** and kept the 0.8
default. One token, one scoring run per tag, two different thresholds — and
reporting a single token-level threshold would have been wrong for one of them.

**That example is now historical, and how it ENDED is the better lesson.** After
the ETH/USD fix of 2026-09-13 filled INDEX-P1's unpriced era, its partial weights
disappeared and **its threshold can no longer be derived either** — it is 0.8,
undrivable, exactly like INDEX-P2. The gap the threshold was derived from was not a
property of the cohort at all; it was missing price data. **A threshold derived
from a gap should be re-derived whenever the data underneath it changes**, and a
derived value that stops being derivable is a signal about the data rather than a
failure.

**A wallet that bought in two windows belongs to both cohorts.** It gets **two
tag rows and one set of rows**: `wallet_transactions` is not window-scoped and
deliberately has no tag column, because which window a transaction falls in is
derivable from its timestamp and a stored copy of that answer can go stale. That
is correct, not a duplicate.

---

## 3. Chain facts, all measured

```
chain id                 4663 (0x1237)
genesis                  2026-04-30
block time               ~0.1 s   -> 35,622 blocks/hour, measured over
                         935,564 blocks / 94,548 s
public RPC               https://rpc.mainnet.chain.robinhood.com
Alchemy                  https://robinhood-mainnet.g.alchemy.com/v2/{key}
uniswap v4 PoolManager   0x8366a39cc670b4001a1121b8f6a443a643e40951
uniswap v3 factory       0x1f7d7550b1b028f7571e69a784071f0205fd2efa
explorer                 https://robinhoodchain.blockscout.com/
DexScreener slug         robinhood
```

**Use Alchemy, not the public RPC.** Two measured reasons, either sufficient:

- **The public RPC returns `blockTimestamp: "0x0"` on every log** — 708 of 708
  in a sample — against a true `0x6a9d1a6c` for the same block. It is present,
  well-formed and entirely wrong, so a job that reads timestamps from logs and
  is pointed at the free endpoint stamps every row 1970-01-01 with nothing
  raised. Alchemy populates it correctly: 5,758 logs, 0 missing, 0 zero, 0
  non-monotonic, exact match against `eth_getBlockByNumber` on every spot check.
- **The public RPC is not archival.** `eth_getCode` at any past block returns
  `{"code":-32000,"message":"metadata is not found"}`. Every step that needs
  historical state needs Alchemy.

The public RPC also caps a query at 10,000 logs and needs 4,000 ms between calls
to avoid refusals. It is a fallback for spot checks, not a collection endpoint.

**One exception, measured 2026-09-11: BLOCK timestamps from the public RPC are
exact, and they are the expensive ones.** `eth_getBlockByNumber` is not
`blockTimestamp`-on-a-log and does not share its defect. Across three samples at
blocks 20M, 45M and 55M, 100 of 100 matched Alchemy bit-for-bit, with 0 returned
as `0x0`. Its limits, isolated from each other by idling 15 s between probes:

| | measured |
|---|---|
| batch cap | **exactly 100**; a 200-item batch is refused with HTTP 429 *even after 15 s idle*, so the refusal is about size, not rate |
| refill | one batch per **6,000 ms**: 15,000 ms 6/6 clean, 10,000 ms 6/6, 6,000 ms 6/6, 3,000 ms 4/6 |
| concurrency | does not help — two lanes at once produced 24 refusals out of 24 |
| throughput | 16.7 blocks/sec, free |

**It fails transiently, and a transient failure is not a wrong answer.** The
first run died after 430,000 of 717,340 blocks on one per-item error —
`block 51230150: Post "http://10.31.73.205:8547/rpc": context deadline
exceeded`, the endpoint's own upstream timing out on one item in a batch of 100.
The code raised, because it treated every per-item error that was not
rate-limiting as permanent, and then sat dead for seven hours because nothing
was watching it. Three categories, three responses, and conflating the first two
is what cost the time:

| the endpoint says | response |
|---|---|
| 429, 5xx, timeout, deadline exceeded, reset connection | **retry the batch** — this says nothing about the data |
| `0x0` timestamp, wrong block number, short batch | **raise at once, never retry** — waiting does not make a wrong answer right, and this is exactly what it does to log timestamps |
| a timestamp | store it |

A long free job must also survive its own failures: the work set is recomputed
from what is missing, so re-running resumes, and it is run under a loop that
re-execs on a non-zero exit.

This matters because step 9 is the one step that can become expensive on a token
whose swaps were copied rather than swept. `--public` on `fill-timestamps` takes
that route; it cross-checks 100 of the blocks it is about to fetch against
Alchemy first (2,000 CU, $0.0009) and aborts on any disagreement, because "it
answered" is not evidence that it answered correctly.

**Test the free alternatives before committing to a metered one, and report what
each can and cannot do.** The measurement takes minutes; the assumption costs
whatever the job costs. A block-timestamp fetch was once queued as ~13,000 paid
calls without either alternative having been tried — the public RPC served the
same batched request perfectly, 100 blocks per request in 448 ms, for free, and
the explorer was unusable at any price. Neither fact was known when the paid job
was planned, and only one of them would have been guessed correctly.

**AN INSTANT DOES NOT NAME A BLOCK ON THIS CHAIN: THE RELATIONSHIP IS 1-TO-10.**
Block timestamps have one-second resolution and blocks arrive every ~0.1 s, so ten
consecutive blocks carry the same timestamp. Measured around block 23,791,950 on
2026-09-13, reading 29 consecutive blocks:

```
23,791,940 .. 23,791,949   1785462270   2026-07-31T01:44:30Z   10 blocks
23,791,950 .. 23,791,959   1785462271   2026-07-31T01:44:31Z   10 blocks
23,791,960 .. 23,791,964   1785462272   2026-07-31T01:44:32Z   (5 of 10 read)
```

**This is a property of the chain, not slop in any load.** `blockForInstant`
resolves the FIRST block whose timestamp is at or after the target — `if (ts <
target) lo = mid + 1; else hi = mid` — so it is deterministic and reproducible:
the same instant returns the same block from any starting hints, verified on
CHUMP's start bound from both wide (1..head) and narrow (20M..30M) hints. A
one-second ambiguity on a bound specified to the hour changes no cohort, so
**PONS, AI and INDEX are unaffected and their bounds are not in question.**

What it does mean is that **a bound given as an instant lands on the first block of
its second within the range searched**, which may be earlier than a specific block
somebody had in mind. Where the intended bound IS a specific block, check which block
the instant resolves to rather than assuming they coincide.

**The low bound of the search matters as much as the instant, and that is what
settles it in practice.** `resolveWindows` passes the token's DEPLOYMENT BLOCK as
`firstBlock`, and `blockForInstant` opens with `if (target <= loTs) return lo` — so
an instant at or before the deployment block's timestamp returns the deployment block
itself. CHUMP is the worked example: `2026-07-31T01:44:30+00:00` against a deployment
at 23,791,950 whose timestamp is 1785462271 resolves to **23,791,950**, not to
23,791,940 which is where the same instant lands when the search starts at block 1.
**A window cannot begin before the token exists, and the clamp is what guarantees
it** — worth knowing, because the same instant gives two answers depending on the
low bound, and only one of them is reachable through the runner.

**Blockscout is not usable programmatically.** Every API path tested returns
HTTP 403 behind a Cloudflare interstitial. It is a link target for humans.

**`ALCHEMY_API_KEY` is a Railway service variable** and is also in the local
`.env`. It was deliberately kept off the service for the whole first intake and
passed per command, which stopped working once the hourly job had to run inside
the container. Do not conclude the key was wiped because a probe reports it
missing — check `railway variables` first.

**Pushed is not deployed, and a green deployment list is not proof either.**
Confirm the running container actually carries the commit before running
anything against it — `grep` the built file in `/app/dist` for a string that
only this commit introduces. Two ways this went wrong in one session: a build
sat in `BUILDING` for **41 minutes** with an empty log while the container
served the previous build, so a fix silently never shipped; and a check that
read the top row of `railway deployment list` passed against the *previous*
deployment because the new one did not exist yet — the redeploy then landed
mid-run and destroyed both the running process and its output file. An empty
commit re-triggers a hung build, which succeeded in 90 seconds.

**A long job must be launched detached, and even that does not survive a
redeploy.** `setsid nohup … > file 2>&1 < /dev/null &` survives the SSH session
ending; nothing survives the container being replaced. Also: `pgrep -f <name>`
run inside `sh -c` matches its own command line and reports RUNNING forever —
poll for a marker in the output file instead.

**Do not change a Railway variable while a collection is running.** Setting one
triggers a redeploy, the redeploy replaces the container filesystem, and every
working file under `/app` is destroyed along with the process. Only what is
already in Postgres survives, which is why every step below writes progressively
rather than accumulating and flushing at the end.

**Never write collection code to a scratchpad.** The first intake was carried
out by scratchpad scripts; a container recycle destroyed them, and its
13,095-wallet cohort can no longer be reproduced from any code that exists. A
throwaway query for a one-off count is fine. Anything that sweeps, decides
membership, or writes a row goes in the repository, committed, before it runs.

---

## 4. The sequence

Steps marked **STOP** end by reporting and waiting for review. They sit where a
wrong answer is cheap to correct and expensive to carry forward — scope, cohort
membership and pricing each propagate into everything downstream.

**Every step has an expected WALL-CLOCK duration as well as a CU cost.** Cost
was recorded for every phase and duration for none, so "this is taking too long"
was an opinion rather than a number. Measured on the three loads:

| phase | PONS | AI | INDEX | expected |
|---|---|---|---|---|
| identity | not measured¹ | 0.9 s | 0.7 s | **seconds** |
| windows | not measured¹ | 1.0 s | 0.9 s (two windows) | **~1 s per bound** |
| pools | not measured¹ | 3.7 s | 3.7 s | **seconds** |
| scope | not measured¹ | 3.6–16.4 s² | 4.8 s | **under a minute** |

CHUMP, the first token driven through the RUNNER rather than the standalone CLIs,
measured faster than all three on every early phase — 58 pools against AI's 5,040 is
most of it. **Every phase, measured end to end, is now on record for one token**,
which none of the other three has:

| phase | CHUMP wall-clock | CU | against estimate |
|---|---|---|---|
| identity | **0.8 s** | 816 | ~800 — exact |
| windows | **0.6 s** | 600 | ~1,040 for one bound — 42% under, the start instant short-circuited |
| pools | **1.3 s** | 490 | ~500 — exact |
| scope, first run | **0.6 s** | 478 | 2 `eth_call` × 10 distinct counters + head |
| scope, RE-RUN after the sweep | **0.8 s** | 582 | + 4 `eth_getCode` for router detection |
| sweep | **13.1 min** | 111,190 | ~56,880 — **1.95x over**, and the cause is the runner sweeping from block 0 |
| conventions | **0.8 s** | 10 | one `eth_blockNumber`; the rest is stored logs |
| cohort | **27.6 s** | 28,690 | ~28,000 estimated from 642 candidates — **exact** |
| tags | **0.2 s** | 0 | no network |
| timestamps | **3.1 s** | 0 | toFetch 0 — the sweep carried every one |
| prices | **4.5 s** | 0 | no network |
| dry run | seconds | 0 | no network |
| write | **5.8 s** | 0 | no network |
| scoring + watchlist, ALL 5 windows | **11.0 s** | 0 | database only |
| | **total 142,378 CU** | | **$0.064** |

CASHCAT, the earliest token on the chain and the second through the runner
end to end. Phases filled in as the run proceeds:

| phase | CASHCAT wall-clock | CU | against estimate |
|---|---|---|---|
| identity | **0.7 s** | 816 | ~800 — exact, and identical to every other token |
| windows | **0.9 s** | 1,100 | ~1,040 for one window — 55 `eth_getBlockByNumber`, 5.8% over |
| pools | **2.5 s** | 480 | ~500 — exact. 8 `eth_getLogs` for 1,001 candidates |
| scope | **2.3 s** | 2,714 | 104 `eth_call` for 52 distinct counters, + head |
| density probe | ~1 min | ~900 | 15 `eth_getLogs`, 7 samples from the deployment block |
| **sweep** | **199.8 min** | **218,230** | ~191,000 estimated — **14.2% over on CU, 9x under on TIME** |
| scope, RE-RUN after the sweep | **5.8 s** | 2,896 | + 7 `eth_getCode`; routers 7 probed / 6 identified |
| conventions, first run | 37 s | 0 | **RAISED** — v4/in-window 779 of 790, no multi-swap guard |
| conventions, WITH the guard | **7.4 s** | 0 | **unanimous, 2,505 of 2,505** across all six cells |
| ETH/USD series extension | ~1 min | 3,600 | ~3,360 estimated — **7% over**, the tightest here |
| **cohort** | **78.9 s** | **101,424** | ~101,716 from 2,360 candidates — **0.3% under** |
| tags | **1.1 s** | 0 | no network |
| timestamps | **50.8 s** | **0** | toFetch 0 — the sweep carried all 55,076 |
| prices | **75.6 s** | 0 | no network |
| dry run, first run | ~60 s | 0 | no network |
| write, first attempt | — | 0 | **RAISED** on its own price gate — see below |
| dry run, after the row fence | **107.9 s** | 0 | reconciles: 41,902 + 55,932 = 97,834 |
| **write** | **148.3 s** | 0 | **97,834 rows stored; price check `outside: 0`** |
| scoring, ALL 6 windows + watchlist | **13.7 s** | 0 | database only |
| | **total 327,660 CU** | | **$0.147** |

BONER, the SECOND BRIDGE EVER and the first sweep after the batching fix. Steps 1–7
only; the run stops at the cohort review.

| phase | BONER wall-clock | CU | against estimate |
|---|---|---|---|
| identity | **805 ms** | 816 | ~800 — exact, the **sixth** token at 816 |
| windows | **470 ms** | 560 | ~1,040 — **46% under**, the start instant clamped to the deployment block |
| pools | **990 ms** | 240 | ~500 — **52% under**, 4 sparse `eth_getLogs` for 388 candidates |
| scope, first run | **~2 s** | 2,766 | 106 `eth_call`; routers probed 0, as expected before the sweep |
| density probe | ~20 s | 960 | 5 samples from the deployment block, 11 requests, **142x spread** |
| **sweep** | **10.45 min** | **55,450** | 645–918 requests estimated, **924 actual** — 0.7% above the top |
| scope, RE-RUN after the sweep | **11.5 s** | 2,974 | + 8 `eth_getCode`; routers **8 probed / 8 identified** |
| conventions | **2.5 s** | 0 | v4 in-window **800 of 800 excluded, 0 tested** — see below |
| **cohort** | **59.7 s** | **64,750** | **no work set was printed before spending** — section 9 |
| | **total 127,556 CU** | | **$0.057**, plus HIMS 4,590 and the probe 960 |

**HIMS as a pricing source cost 4,590 CU**: identity 816, windows 1,100, pools 480,
scope 2,194. **The whole intake to the cohort stop is 133,106 CU = $0.060.**

**`timestamps` took 50.8 s to fetch NOTHING, and that is the materialised work-set
query rather than a defect.** It resolves the blocks the rows will need across 4.38M
swaps and 10.6M transfers; the answer was **55,076 needed, 55,076 already stored,
0 to fetch**. Confirmed rather than assumed, as step 9 requires — a v3-swept token
carries its own `blockTimestamp` and pays nothing here, now measured on a second
token after CHUMP.

**The row writer still inserts one row per statement.** The sweep was batched on
2026-09-14; `planOrWrite` was not. At CASHCAT's 97,834 rows that is roughly 80
seconds and nobody notices; at a token an order of magnitude larger it becomes the
sweep's 200-minute problem again. Recorded rather than fixed, because the write is
not the phase that hurt.

**THE COHORT ESTIMATE LANDED TO 0.3%, and it decomposes to the CU exactly:**

```
payment  2,453 transactions x 15 CU  =  36,795
       +   341 receipts     x 15 CU  =   5,115      = 41,910  <- reported paymentCu
getCode  2,289 survivors    x 26 CU  =  59,514
                                        -------
                                        101,424  <- the phase's cu_spent, exactly
```

**341 of 2,453 transactions needed a receipt — 13.9%** — against the 14% step 7
measured on PONS. **A constant measured on one token holding on a token nineteen times
older and a hundredth its window length is worth trusting**, and it is the second such
constant CASHCAT confirms after identity's 816 CU.

**THE SWEEP'S CU ESTIMATE WAS GOOD AND ITS WALL-CLOCK ESTIMATE WAS 9x LOW, and the
reason generalises.** I sized the time by scaling CHUMP's 13.1 minutes by the expected
REQUEST count — 3,183 against CHUMP's 1,853 — and got ~22 minutes. The requests came in
at 3,637, only 14% over. **The time came in at 199.8 minutes because the sweep's
wall-clock is set by ROWS INSERTED, not by requests made**:

```
                requests   rows written        rows/request   wall-clock
CHUMP              1,853        687,982              371       13.1 min
CASHCAT            3,637     14,957,528            4,113      199.8 min
                     2.0x          21.7x             11x         15.3x
```

**1,248 rows per second, and `pg_stat_activity` named the cause while it ran**:
`wait_event: ClientRead` between sub-second inserts — the row-at-a-time loop section 7
already records for the ETH/USD market sweep, where the remedy was multi-row `VALUES`
at 500 rows. **The intake sweep still inserts one row per statement**, and CASHCAT is
the first token large enough for that to dominate its runtime. Estimate a sweep's
duration from the LOGS it will write; estimate its cost from the REQUESTS.

**The identity phase costs 816 CU on every token measured** — PONS, INDEX, AI, CHUMP
and now CASHCAT — because the bisect depth barely moves: 27 `eth_getCode` finds a
deployment block at 88,836 exactly as it finds one at 23,791,950. **A constant that
holds across a 268x range of deployment blocks is worth trusting.**

**The cohort estimate was the one that mattered and it landed exactly.** 642 candidate
wallets × 17.1 CU payment + ≤642 × 26 CU code check predicted ~28,000 CU; the run spent
**28,690**, and it decomposes precisely: 670 transactions × 15 + 168 receipts × 15 =
12,570 payment, plus 620 × 26 = 16,120 code checks. **Quote a cohort from the candidate
count, derived before spending, and it is not an estimate at all.**

**Two phases ran far over and both were defects, not slowness** — the 3x rule earning
its place twice in one intake. `timestamps` sat **10m34s** active and CPU-bound on an
unmaterialised query against an expected "near-free, seconds", and was cancelled;
materialised, it takes **3.1 s**. `prices` finished in **9 ms** reporting zeros, which
is the same rule from the other side: a phase far UNDER its expectation is as much a
signal as one far over.

**The earlier per-phase table, PONS / AI / INDEX** — these rows were orphaned from
their header by an edit on 2026-09-13 and are restored to one here:

| phase | PONS | AI | INDEX | expected |
|---|---|---|---|---|
| transfer sweep | not measured¹ | ~9 min (13.9M blocks) | ~40 min (57.4M blocks) | **~1 min per 1.5M blocks** |
| swap load | not measured¹ | ~4 min | ~35 min | scales with blocks not in `v4_swaps_all` |
| cohort | not measured¹ | ~2 min | ~6 min (two windows) | **minutes** |
| prices | not measured¹ | seconds | seconds | **seconds — no network** |
| rows (dry run + write) | not measured¹ | ~1 min | ~8 min | scales with rows |
| scoring, all windows | — | — | ~60 s for 24,186 wallets | **seconds to a minute** |
| scoring + watchlist rebuild | — | — | 80.9 s (9.1–11.9 s without the rebuild) | **about a minute** |
| watcher, 20,000-block slice | — | — | 40.3 s first run, 15.3 s after | **seconds; the first run classifies pools** |

¹ PONS was loaded by the scratchpad scripts that were lost; no phase timing
survives. ² 16.4 s when router detection ran with data present.

**A phase running materially over these is a HANG, not slowness — check for one
rather than waiting.** Two measured cases, both of which looked like patience
being required and were not:

- **A 19-minute router query and a 17-minute convention query.** Both were
  single statements whose inputs were CTEs, which the planner has no statistics
  or index for. Both became **~5 seconds** once the inputs were materialised into
  indexed temp tables. Neither was ever going to finish usefully.
- **A 41-minute "build".** The deployment sat in `BUILDING` with an empty log
  while the container went on serving the previous build, so a fix silently
  never shipped. An empty commit re-triggered it and it succeeded in **90
  seconds**.

The rule: if a phase passes roughly **3x** its expected duration, stop and look
at `pg_stat_activity` for a running query and at the deployment list for a stuck
build. Waiting longer has never once been the answer here.

Every step also has a **compute-unit ceiling set before it starts**, inside the job.
An account-level cap protects the wallet; only an in-job ceiling protects
against a step whose scope was wrong from its first request. A step that reaches
its ceiling stops and says where it stopped.

---

### Step 0 — Read this document

Read it. Then state which of its rules bear on the token in front of you:
which failure modes it is exposed to, which definitions are in question for it,
what an earlier token already learned that applies here.

---

### Step 1 — Token identity

**Does:** reads `name`, `symbol`, `decimals`, `totalSupply` from the contract,
and finds the deployment block by bisecting `eth_getCode`.
**Costs:** ~30 calls, ~800 CU.
**Produces:** a `tokens` row.
**Stops:** no.

**Decimals are read, never assumed.** USDG has 6 where everything around it has
18, and it is the counter asset on 238 of PONS's 381 in-scope pools — assuming
18 inflates every USDG-quoted figure by 10^12. One counter token, PONTIFUL, also
had 6. **Treat a `0x` return as unknown, not as 18 and not as 0.**

---

### Step 2 — Window bounds → blocks

**Does:** bisects block timestamps to convert each window's instants to block
numbers.
**Costs:** ~26 calls per bound, ~520 CU per bound.
**Produces:** start and end blocks per window.
**Stops:** no.

There is no timestamp index on this chain and no explorer API that answers, so
bisection is the only route.

**Overlapping windows are rejected.** Tagging one wallet twice with different
labels is legitimate, but silently overlapping bounds are almost always a
configuration mistake, so they raise rather than proceed.

**PUMP POINTS ARE PERSISTED HERE TOO, and until CHUMP nothing in the repository
did it.** They are an operator input (section 2) that metrics 5 and 6 are defined
against, they live in `token_events` keyed `(chain, token, kind, event_at)`, and
`scoreWindow` raises without them. `pump_points` in an intake config was read by
nothing. `npm run pump-points -- <config.yaml>` now writes them from the config,
idempotently, rejecting any instant with no offset for the same reason a window
bound is rejected: "08-07 04:00 Eastern" and "08-07 04:00 UTC" are four hours apart
in August and both metrics key off a 48-hour window.

---

### Step 3 — Pool enumeration — **STOP**

**Does:** finds every pool the token has ever had, on both venues.
**Costs:** ~8 `eth_getLogs` for enumeration — and then the flow probe, which
dominates and was badly under-quoted here once. **The ~1,300 CU figure this
document used to carry for "a token like AI" is wrong by roughly 300x.**
Enumeration is cheap because both `Initialize` and `PoolCreated` are sparse
filters. The flow probe is not: it sweeps *every transfer the token has ever
emitted* and then spends one `eth_getCode` on every address that both sent and
received.

Measured for AI, from its swept window rather than estimated:

```
enumeration, 4 sparse filters                              ~8 calls      480 CU
flow probe, transfer sweep 18,275,473..58,182,616
  39.9M blocks at 0.0255 logs/block, span capped 100,000   ~399 calls 23,940 CU
flow probe, eth_getCode per two-way address
  14,034 candidates IN THE WINDOW ALONE x 26 CU                       364,884 CU
                                                                   ------------
                                                                    ~389,000 CU
                                                                        ~$0.175
```

**The `eth_getCode` count is the whole cost, and it scales with the token's
address count, not its pool count.** Quote it from the two-way address count,
never from a per-token constant.

**Enumeration alone is often enough, and is ~500 CU.** `Initialize` is complete
for v4 — the PoolManager emits it for every pool, hooked or not — and
`PoolCreated` is authoritative for the configured factory. The flow probe adds
only v3 pools from *other* factories. For AI that is roughly 13 pools of 4,856,
so the probe costs ~$0.17 to find 0.3% of the pool set. Decide it per token
rather than running it by default.

**`max_pools` is PER TOKEN, with a global default of 2,000.** AI has ~4,856, so
the phase raises before it finishes until the cap is lifted in that token's own
config — `max_pools: 6000` for AI. It belongs per token because the right answer
is a property of the token, and a global raise would silently remove the guard
for every future one. That is the cap working, not failing.

**The flow probe is OFF by default — `flow_probe: false`.** Turn it on per
token, never globally, and price it first.

> **When the flow probe IS worth running.** Decide before spending, in this
> order, and none of it costs a probe:
>
> 1. **Price it.** One `eth_getCode` per address that both sent and received the
>    token, at 26 CU. Get that count from transfers already stored:
>    `select count(*) from (select to_addr intersect select from_addr) t`. AI:
>    14,034 → ~$0.18. **Never quote it from a per-token constant** — it scales
>    with address count, not pool count.
> 2. **Ask what it can add.** Only v3 pools from factories other than the
>    configured one. `Initialize` is complete for v4 and `PoolCreated` is
>    authoritative for the configured factory, so if enumeration already shows
>    v4 dominating, the probe is buying a rounding error. AI is 99.7% v4.
> 3. **Weigh it by swaps, not by pool count.** Sweep `Swap` on the enumerated v3
>    pools — cheap when the v3 set is small — and take v3's share of the token's
>    swaps. A token where v3 carries a material share is one where a missing v3
>    pool drops real buyers, and that is what the probe is for.
>
> Skipping it is recorded in the phase report as **"NOT RUN"**, never as a zero:
> a zero would say the probe ran and found nothing.
**Produces:** the candidate pool list.
**Stops:** yes — the pool set decides what is swept and what is missed.

> **Definition — a pool.**
> **v3:** a contract that answers both `token0()` (`0x0dfe1681`) and `token1()`
> (`0xd21220a7`).
> **v4:** a 32-byte pool id from the PoolManager's `Initialize` event. **A v4
> pool has no contract of its own** — the PoolManager singleton holds every
> pool's reserves — so it can never be found by probing an address, and it is
> never a transfer counterparty. The PoolManager is.
> **Not a pool:** routers, aggregators, hook contracts, the token itself, the
> launchpad. A hook is attached *to* a pool and is not one.

`Initialize` carries the pool id and both currencies as indexed topics:

```
topic0    0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438
topics[1] pool id      topics[2] currency0     topics[3] currency1
data      5 words: fee, tickSpacing, hooks, sqrtPriceX96, tick
```

The other PoolManager signatures, found the same way:

```
0x40e9cecb...  Swap              3 topics, 192 data bytes  (id, sender)
0xf208f491...  ModifyLiquidity   3 topics, 128 data bytes  (id, sender)
0x1b3d7edb...  ERC-6909 accounting
```

v3 `PoolCreated` is `0x783cca1c0412dd0d695e784568c96da2e9c22ff989357a2e8b1d9b2b4e6b7118`,
with `token0`/`token1`/`fee` as topics and the pool address as the second data word.

**Never take a topic hash on trust.** Each of these was identified by sampling
logs with no topic filter, grouping by `topic0`, and confirming against a known
pool. **A fabricated topic matches zero logs and reads as a clean sweep** — that
has shipped here once, a made-up `Transfer` topic matching nothing across
100,000 blocks.

**Never treat a DexScreener listing as the pool set.** It caps its response at
30 pairs and is not sorted by liquidity. For PONS it knew **30 of 91** v3-style
pools and **14 of 792** v4 pools; 28 of the 40 in-scope v3 pools were absent,
including one carrying 53,688 transfers — the 7th busiest pool on the chain. Use
the API to annotate liquidity and volume, never to enumerate.

**v3 pools are found two ways, because neither is complete.** The factory's
`PoolCreated` is authoritative for pools from that factory; a flow probe catches
the rest. The probe takes every address that both received and sent the token —
a pool does both, but so does a router — then tests each on-chain. **A revert is
the answer, not a failure:** it means the contract has no such function, so it is
not a pool. Retrying reverts is how a classifier once spent five rounds
re-asking 1,664 settled questions.

**Stream the flow probe; never buffer it.** It reads every transfer the token
has ever emitted — 5.76M log objects for PONS — to look at two address fields.
Keep the two address sets and discard each batch.

**Hooks do not need special handling.** 4,465 of AI's 4,843 v4 pools carry a
non-zero hooks address across 34 hook contracts, and **the PoolManager still
emits its own `Swap` for every one** — verified on three hooked pools with
9,175, 5 and 132 events, not assumed from source. **No hook emits the `Swap`
topic itself.** Sweeping `Swap` from the PoolManager is complete.

**Re-derive the pool set every run.** Pools are created continuously: between two
enumerations 12 hours apart PONS gained 83 new v4 pools, 8 in scope. A fixed list
goes stale within a day, and a missed pool is a filter matching nothing — the run
succeeds and omits those trades.

**If a token resolves to a very large number of pools, stop and report the list
rather than reading all of them.** Cost is linear in pools and the choice is
yours. AI has 4,856.

**Where no single pool dominates, the set covering 99% of in-scope volume is the
useful cut.** One token had a single pool carrying 57% of volume across four
covering 99%; another had one pool carrying essentially all of it. Below 99% the
tail is cheap — pools under 1% of volume cost hundreds of credits, not tens of
thousands — so the cut is about the dense secondary pools, not the long tail.
Collecting only the charted pair silently drops every wallet an aggregator
routed elsewhere.

---

### Step 4 — Scope — **STOP**

**Does:** decides which pools are priceable, reading every counter asset's
`symbol()` and `decimals()` from its own contract first.
**Costs:** 2 `eth_call` per distinct counter asset. Bound this: AI has 4,481
distinct counters and reading all of them is 232,000 CU on its own — read the
pricing assets and the busiest counters, not the tail.
**Produces:** `pool_meta` rows for in-scope pools.
**Stops:** yes — the counter-asset decision sets every price downstream.

> **Definition — in scope for pricing.** A pool is in scope when its counter
> side is a recognised pricing asset:
> ```
> WETH        0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73   18 decimals
> USDG        0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168    6 decimals
> native ETH  0x0000000000000000000000000000000000000000   18 decimals
> ```
> ...or a **bridge asset**, which is priced through its own on-chain route. See
> the second hop below.

**Apply the rule once, to both venues.** Applying it to v3 only left PONS/NVDA
and PONS/STONKBROKER in the v4 set — pricing a memecoin against a tokenised
equity through an oracle nobody verified.

**Read the counter's `symbol()` before deciding.** Of 48 unidentified PONS
counter assets all 48 resolved; none was a stablecoin; four were tokenised
equities that have real off-chain prices and are still excluded on their own,
because their on-chain price depends on a bridge nobody verified.

**Record the pools excluded and why, not just the count**, before any swap is
read, so the set that was read is on record independently of what the read
returned.

**A counter whose `decimals()` cannot be read cannot be valued.** Raise. Treating
an unreadable decimals as 18 is a factor-of-10^12 error waiting to happen.

#### The second hop

A token whose main market is against a non-pricing asset is priced *through*
that asset when the asset itself has an on-chain USD route: `token → bridge →
USD`, same bucketed-median machinery one level deeper, no off-chain feed.

**The scope rule applies recursively.** A bridge's own series comes only from
pools pairing it **with** a recognised pricing asset. Pools where the bridge is
itself some third token's pricing side are excluded — including them would price
the bridge against the thing it is pricing.

AI is why this exists: its charted AI/NVDA pool is **56% of its swaps and 59% of
its window activity**, and NVDA has 512 pools against pricing assets carrying
226,454 swaps. Without the hop, the token's main market is discarded entirely —
those pools produce *no rows at all*, not null-priced rows.

**A BRIDGE'S DECIMALS ARE READ, NEVER DEFAULTED — and the code defaulted them to
18 until 2026-09-14.** The rule is step 1's, unchanged: *treat a `0x` return as
unknown, not as 18 and not as 0*, because **USDG has 6** and assuming 18 inflates
every figure quoted in it by **10^12**. The prices phase applied that rule to the
token and not to its bridge, fifteen lines apart:

```
token   const decimals = identity?.decimals ?? (select decimals ...).rows[0]?.decimals;
        if (typeof decimals !== 'number') throw ...            <- raises
bridge  const bdec = (select decimals ...).rows[0]?.decimals ?? 18;   <- SILENTLY 18
```

`bdec` scales every bridge amount inside `deriveBridgeUsd`, so a bridge whose `tokens`
row is missing — or whose `decimals` column is null, which `??` also catches —
produces a complete, plausible, wrong bridge series. Nothing raises and no count comes
back zero, which is what makes it worse than a crash.

**It was dormant only because AI is the only token with a bridge and NVDA's `tokens`
row exists. BONER is queued and needs a HIMS bridge, so it stops being dormant on the
next intake.** A bridge is loaded far enough to have a `tokens` row *by a separate
identity run*, and nothing in the prices phase checks that it happened first.

**Two implementations of one rule, and only one of them was right.** That is the trap
step 7 already names, appearing here between a variable and the one declared below it.

**Two bucketed medians multiplied compound their error.** Report the spread
against direct token/USD trades in the same buckets rather than assuming it small.

**If a token has no USD route at all — no stablecoin pool and no bridge — report
it and stop.** Do not substitute a rate from anywhere else.

---

### Step 5 — Swap sweep, full chain life

**Does:** sweeps `Swap` from the in-scope pools and `Transfer` from the token,
across the token's whole life.
**Costs:** the largest step. ~60 CU per `eth_getLogs`, flat regardless of span.
**Produces:** `token_swap_logs`, `token_transfer_logs`, `block_times`.
**Stops:** no.

**`token_swap_logs` is not created by any code in this repository.** Every
reader assumes it exists because the first intake made it by hand. Its shape:
`(chain, token, venue, pool, block_number, log_index, tx_hash, sender,
recipient, amount0, amount1)`, unique on `(chain, token, block_number,
log_index)`. A fresh database would fail at the first read.

**v4 swaps can be copied from `v4_swaps_all` instead of swept — pure SQL, no
RPC, no cost** — for the blocks it covers (15,115,267–42,695,454). It holds
every v4 swap on the chain, so a token whose window sits inside that range needs
no v4 sweep at all. **Copy every pool of the token, in scope or not**: router
detection asks whether a send sat inside a transaction containing a swap of this
token, and restricting to in-scope pools makes a router that routed through an
out-of-scope pool look like a distributor.

**Sweep full chain life, not the window.** The PONS cohort window held **772,131
of 2,459,873 swaps — 31%**. The other 1.46M happened after it closed, and they
are exactly the sell-side data that cost basis and realised PnL depend on.

**"FULL CHAIN LIFE" MEANS THE TOKEN'S LIFE, AND THE SWEEP STARTS AT THE DEPLOYMENT
BLOCK.** A block before the token existed cannot contain one of its logs, so every
request over that range is guaranteed to match nothing. CHUMP swept from block 0 and
the waste is measured, not estimated — from `token_sweep_progress`, which records one
row per request:

```
sweep ranges recorded                         1,853   x 60 CU = 111,180 CU
   + one eth_blockNumber                                        111,190  <- the phase cost, exactly
ranges ENTIRELY BELOW the deployment block      711   237 per stream x 3 streams
logs those 711 requests returned                  0   <- the proof they could hold nothing
                                             ------
wasted                                       42,660 CU = $0.0192
```

**That is 38.4% of the sweep and 30.0% of CHUMP's whole 142,378 CU intake**, spent
reading 23,791,950 blocks that pre-date the token. An earlier figure here of
"~238 requests, ~14,280 CU" was **per stream and understated the total threefold** —
there are three streams (`swap-v3`, `swap-v4`, `transfer`) and each paid the tax.

**The waste grows with how LATE the token was deployed**, which is the opposite of
the intuition that an old token is the expensive one. It is
`ceil(deployment_block / max_log_span_blocks) x 3 streams x 60 CU`, so at the
100,000-block cap that is **180 CU per 100,000 blocks of chain the token missed**:

| deployed at | wasted requests | wasted CU | |
|---|---|---|---|
| 23.8M (CHUMP) | 711 | 42,660 | $0.019 |
| 40M | 1,200 | 72,000 | $0.032 |
| 55M | 1,650 | 99,000 | $0.045 |
| a token launched today | ~1,854 | ~111,000 | ~$0.050 |

**A token launched now would spend its ENTIRE sweep budget on blocks that cannot
contain it.** CASHCAT's deployment block is not known until its identity phase runs,
so quote its saving from that figure and not from CHUMP's.

```
v3   address = the in-scope pool addresses, topic0 = Swap_v3
v4   address = the PoolManager, topic0 = Swap_v4, topics[1] = the pool ids
```

**Filter v4 by pool id, and CHUNK the array.** An unfiltered PoolManager sweep
returns every v4 swap on the chain — 33.2M rows and 14 GB for one month. A
540-entry topic array is accepted; **5,024 entries HANGS.** AI has 5,024 v4
pools, and passing them in one filter produced **57 minutes with no range
recorded, no refusal and no error** — the endpoint neither answered nor refused.
Chunk at **500 ids per request**. That multiplies the request count by the chunk
count, so size the ceiling for it, and let only the last chunk record the range:
the blocks are not fully read until every chunk has been.

This is the wall-clock rule earning its place. A sweep that records nothing for
an hour is not slow, it is stuck, and no amount of waiting was going to change
it.

**Span sizing belongs to the filter, not to the endpoint.** A *sparse* filter —
one token's pool creations — returned 4,615 logs across **40,000,000 blocks in a
single call**. A *dense* filter — that token's transfers — is refused above
100,000. Carrying one constant across both cost ~1,864 calls where 8 sufficed.

**Three refusal types need three opposite responses. Conflating them is the most
expensive mistake made here, and it was made twice.**

```
result cap    "exceeds limit of N" / "Log response size exceeded"
              -> NARROW the span, possibly a long way.
rate limit    HTTP 429
              -> back off in TIME and HOLD the span. Narrowing on a rate limit
                 produces MORE requests, which is backwards.
cap vs
throttle      both return 429. A probe call settles it: if the endpoint answers,
              it was throughput and the sweep continues; if it refuses the probe
              too, the account is cut off and every further call is wasted.
```

**A floor that cannot satisfy the endpoint is a livelock, not a retry.** One
sweep re-requested the same range every 30 seconds for five and a half minutes
because its 2,000-block floor could not satisfy a 10,000-log cap. Throw instead.

**Span sizing is density-targeted with a recovering cap.** Re-widening to the
maximum after every success made the first sweep thrash; a ratchet that only
narrowed starved its sparse middle at 47,000 blocks per minute.

**Density is measured over the range just read, and must be computed BEFORE the
cursor advances past it.** This was wrong for the whole first intake:
`logs / (end - cursor + 2)` was evaluated after `cursor = end + 1`, so the
denominator was always **1** and "density" was the raw log count. `wanted =
6000 / density` then floored to **0** for any request returning more than 6,000
logs, and the next span became the 25-block minimum.

Measured on PONS transfers, blocks 54,935,280–55,235,279, both denominators over
the same blocks:

```
                       requests   blocks covered   smallest span   size refusals
defective denominator     24         105,270            25              0
corrected denominator     17         300,000         2,916              0
```

The defective run oscillated — 100,000 → 25 → 1,000 → 25 → 400 → 40 — and never
settled; the corrected one converged on 6,000–19,000 blocks and held there,
which is the target working as designed. Projected over 1,757,870 blocks that is
**100 requests against 401**, and the 401 is optimistic because the oscillation
had not converged.

**Zero size refusals in either run. The span collapse was arithmetic, not the
endpoint.** Do not attribute a collapsing span to result-cap refusals without
checking the refusal count first — that hypothesis was recorded here and was
wrong. `npm run sweep-probe` prints span, range, log count, density and next
span per request, and takes `--legacy` to reproduce the defect for comparison.

**Measured PONS transfer density**, blocks 54,935,280–55,235,279: mean **0.4669
logs per block**, per-request range 0.31–0.96, 140,078 logs over 300,000 blocks.
At the 6,000-log target that is a natural span of roughly **13,000 blocks**.

**A RE-SWEEP MUST NOT CRASH, and for a long time it did.**
`recordSweepRange` was a bare insert against a table keyed
`(chain, token, kind, from_block)`, so re-running a sweep over a range already
recorded raised a duplicate key and killed the job. Every row insert in the
system is `on conflict do nothing` and idempotent; only the bookkeeping was not,
and **three separate attempts to resume an interrupted sweep died on it.** The
later record now wins — a re-sweep has read the range again and its count is the
current one.

**A TOKEN'S DENSITY IS NOT CONSTANT OVER ITS LIFE, so probe the range you will
actually sweep.** AI measured **0.0255 logs per block** across its window and
**0.417 across the 3.7M blocks before the current head — 16x denser.** A ceiling
derived from the window's density stopped the sweep at 37% of the range. The
same mistake, in the other direction, made INDEX's estimate 27% low: its probe
started at another token's origin and never sampled its early life. Sample the
blocks you are about to read, not the blocks you happen to have.

**Commit progress per range, and gap-check on a fresh connection when it
finishes.** `sum(to_block - from_block + 1)` must equal the span exactly **and**
a window function over the ranges must find zero gaps. The sum alone is not
enough: an overlap and a gap of the same size cancel out in a total.

**A batched call returns per-item errors inside an HTTP 200.** Inspect every
response body. A read that requests a set must confirm every requested item came
back and abort rather than emit a partial result — 490 of 1,046 batched balance
reads once came back 429 and every one became a plausible zero balance.

---

### Step 5b — Reconcile the sweep

**Does:** checks the swaps found against the transfers that moved the token
through the PoolManager.
**Costs:** no network.
**Stops:** no, but an unexplained residual is a defect.

For PONS, against the full 875-pool list:

```
PoolManager token-transfer txs   384,385
v4 swap txs captured             385,901
unexplained                       18,792  (4.9%)
```

Sampling 40 unexplained transactions and reading every PoolManager event in them
returned **38 `ModifyLiquidity` and 0 `Swap`** — liquidity provision, correctly
not a swap. **A residual that is explained is a result; a residual left
unexplained is a defect.**

Scoping to in-scope pools only raises the residual to 13.7%, which decomposes
exactly: 34,036 transactions swapping on out-of-scope pools plus the 18,792
liquidity events.

---

### Step 6 — Sign conventions

**Does:** verifies each venue's sign convention against the actual transfers.
**Costs:** ~15 calls.
**Produces:** a pass/fail. A disagreement fails the run.
**Stops:** no, but it raises.

**The two venues use opposite conventions on this chain.**

```
v3   POOL perspective     the pool sent the token  => amount negative
v4   SWAPPER perspective  the swapper received     => amount positive
```

Measured against the actual token transfer in the same transaction, in three
separate regions, unanimously:

```
          in-window    before window   after window
v3        394/394      299/299         290/290
v4        164/164      294/294         154/154
```

Assuming one convention for both would have inverted every v4 buy into a sell
across 480,924 rows, with plausible totals throughout and nothing to indicate a
problem. **Verify both, inside and outside the window, before writing anything.**

**THE SAMPLE MUST BE TAKEN PER VENUE, AND A VENUE WITH NOTHING TESTED MUST RAISE.**
Found on CHUMP 2026-09-13, and it is the filter-matched-nothing failure landing in
the one check whose whole purpose is to catch a silent inversion. The phase drew
`order by block_number limit 800` over the region and handed one result to both
venues. CHUMP's v3 activity starts at 23,794,012 and its v4 at 39,893,773, so the
first 800 in-window swaps are **800 v3 and 0 v4** — the 18 v4 swaps inside the window
were never reached. It reported `v4 tested: 0, convention: undetermined` and
**passed**, because the raise fired only on `tested > 0 && undetermined`.

```
in-window      v3  12,013   v4     18     sampled: v3 800, v4 0
before-window  v3       0   v4      0     RETURNED NO ROWS -- and correctly so
after-window   v3 252,250   v4 10,704     NOT TESTED AT ALL -- see below
```

Take up to the sample cap **per venue per region**, and raise when a region contains
swaps of a venue and none were tested. A venue whose market opens later than the
other is the normal case, not an exotic one.

**THE REGIONS MUST BE RESOLVED FROM STORED STATE, NOT FROM VARIABLES A RESUMED RUN
NEVER SET.** The same CHUMP run skipped the after-window region entirely. `head` is
fetched by the phases that need it, and on a resumed run every one of those was
already `complete`, so `head` was **0**, the region became `44,992,964..0`, failed
`region.to <= region.from`, and was dropped without a word. **That region holds
262,954 swaps — 95.6% of the token's total.** `firstBlock` was 0 for the same reason;
it was harmless only because no CHUMP swap can precede its deployment.

This is the third appearance of one defect — step 7's rule that **a STOP ends the
process, so anything a later phase needs must be PERSISTED rather than carried in a
variable.** It cost AI a router detection over `0..0` reported as a clean pass, it
cost INDEX a fallback to unresolved window bounds, and here it cost the conventions
check its largest region. **A region computed from an unset bound must raise, never
be skipped.**

**Report a region that is genuinely empty as "RETURNED NO ROWS".** CHUMP's
before-window region really does hold zero swaps, because its window starts at its
deployment block — that is a result, and it is distinguishable from a region that was
dropped only if it is printed.

**A TRANSACTION HOLDING MORE THAN ONE SWAP OF THE TOKEN IS NOT EVIDENCE, AND THE
COUNT MUST BE EXCLUDED RATHER THAN DROPPED IN SILENCE.** Approved and implemented
2026-09-14 after CASHCAT raised `v4/in-window 779/790`. A router can buy the token on
one pool and sell it on another inside one transaction; only the NET leaves the
PoolManager, so pairing **each** swap against that single net transfer forces one of
them to disagree. The 11 disagreements were arithmetic, not a convention.

**The guard is `exactly one swap of this token in the transaction`**, counted over
`token_swap_logs` — not over `v4_swaps_all`, which held **0 rows anywhere inside
CASHCAT-P1** and could not have adjudicated anything here.

**THE COUNT COMES FROM THE WHOLE TABLE, NEVER FROM THE SAMPLE.** The conventions phase
draws up to 800 swaps per venue per region, so a transaction with two swaps may
contribute only one of them to the sample. Counting within the sample would report
that transaction as single-swap and admit exactly the pair the guard exists to reject.
The count is loaded from `token_swap_logs` for the sampled transaction hashes.

**ONE IMPLEMENTATION, SHARED.** `build-cohort.ts` has had this guard as `spt.n = 1`
against its `_alltok` temp table since INDEX; `verifyConventions` never had it. Rather
than write a second one, the definition now lives in `src/intake/adjudicable.ts` —
one SQL text and one predicate — and both callers import it. **This is the fourth time
two implementations of one rule produced a wrong answer here**, and the remedy this
time is to remove the second implementation rather than to correct it.

**Excluded transactions are REPORTED, per venue per region.** A pair the check cannot
adjudicate is not evidence of agreement, and a guard that quietly shrinks the
denominator is indistinguishable from a check that passed. Every cell carries
`in_region`, `sampled`, `excluded_multi_swap` and `tested`.

**AND THE EXCLUSION RATE IS PART OF THE RESULT, BECAUSE IT SETS HOW STRONG THE
EVIDENCE IS.** On CASHCAT the guard excluded **80–90% of every v4 sample** against
**0–12% of every v3 sample**:

```
v4  in-window     718 of 800 excluded   ->  82 tested       v3  45 of 800  -> 755
v4  before-window  24 of  29 excluded   ->   5 tested       v3   0 of 800  -> 799
v4  after-window  638 of 800 excluded   -> 162 tested       v3  98 of 800  -> 702
```

**A headline "2,505 of 2,505 unanimous" is true and is NOT the strength of the v4
evidence.** CASHCAT's v4 convention rests on **82 in-window tests, and 5 in the
before-window region** — not on 800 apiece. **Read the tested column, never the
total**, and where a venue's tested count is small say so next to the verdict rather
than letting the sum speak for it.

This costs nothing in correctness — step 6 is a check, not a source of direction, and
direction always comes from the transfer — but a future reader deciding how much to
trust a v4 amount on this token should see 82 rather than 2,505. **Where a guard
removes most of a venue's sample, raising the sample cap for that venue is the way to
buy evidence back**, and it was not done here because unanimity at 82 was enough to
proceed.

**One limitation, stated rather than discovered later:** `token_swap_logs` holds only
the token's IN-SCOPE pools, so a hop on a REJECTED pool is invisible to this count.
`build-cohort.ts` layers `v4_swaps_all` on top for exactly that case, and that layer
is unavailable below block 15,115,267. For CASHCAT both hops were in-scope pools, so
the guard sees them; a token whose multi-hop route touches a rejected pool below that
block would still slip through, and nothing currently detects it.

**`to == from - 1` IS THE EMPTY REGION; ANYTHING FURTHER INVERTED IS AN UNRESOLVED
BOUND.** The two must not share a branch, and the first attempt at this fix collapsed
them and raised on CHUMP's legitimate `23,791,950..23,791,949`. A window that starts
at the token's deployment block leaves `before-window` as `firstBlock..firstBlock-1`
by construction — the window bound and the range bound coincide — and that is the
normal shape for any token whose window opens where the token opens, which the
low-bound clamp in section 3 makes the *common* case rather than a rare one. An
unresolved bound looks different: `44,992,964..0`, inverted by 45 million blocks.
The old `to <= from` test was wrong in the other direction, silently dropping a
one-block region as well.

This is a check, not a source of direction. See the next step.

---

### Step 7 — Cohort — **STOP**

**Does:** decides who bought inside each window.
**Costs:** two things. One `eth_getCode` per surviving candidate — the figure
recorded for PONS is ~85,000 CU, which does not reconcile against 26 CU per call
over 15,096 candidates (392,496 CU) and is **flagged, not corrected**. Plus the
payment proof, ~17.1 CU per candidate wallet, **~289,000 CU / $0.13 for PONS's
16,910 candidate wallets**.
**Produces:** the cohort list, held for review.
**Stops:** yes — before anything is written to `wallet_tags`.

> **Definition — a buyer.** A buy has **two halves and both are required**:
> 1. it is a **swap** in which the wallet **receives** the token, and
> 2. the wallet **gave up value in the same transaction** — it sent some other
>    token, or sent native value beyond the fee.
>
> **A wallet needs ONE proven payment to enter the cohort, and proving stops
> there.** Membership asks "did this wallet buy", which one proven purchase
> answers for good; it does not ask how many times. Once a wallet is in, its
> remaining candidate transactions are not bought.
>
> **Individual buy and sell rows are NOT payment-proven.** This is settled and
> is not to be reopened. A row records that the token moved between a wallet and
> an in-scope pool inside a swap transaction, which is what step 11 defines a
> trade to be. Some of those receipts will not have been paid for by the wallet
> they are credited to; those are already covered by the **`inflated-pnl` flag**,
> exactly as missing transfer rows are, and that is the accepted treatment.
>
> The reason is cost, and it was measured rather than argued. Proving every row
> is **$4.23 per intake**; proving membership once per wallet is **$0.13** — the
> difference between 430,215 candidate transactions and 16,910 candidate
> wallets on PONS. Row-level proof buys a precision the `inflated-pnl` flag
> already delivers, at thirty times the price.
>
> Testing only the first half classified **159 of 1,395 legs — 11% — as
> purchases where the wallet gave up nothing at all.** One received 12,913
> tokens against a zero native delta; another received two tokens and paid for
> neither. **A wallet absent from the transaction cannot have paid in it.**
>
> On this chain the same test put **2 of 40** sampled router-fed recipients on
> the buying side and **38 not**: a shared funding EOA pays and the token lands
> in a user's account. Those 38 are not buyers — someone bought for them.
>
> **Definition — a seller.** The mirror: the token moves *from* the wallet *to*
> an in-scope pool counterparty, inside a transaction containing a `Swap`.

**Native-ETH payments are proven from the transaction receipt plus `tx.value`,
not from logs.** Value sent as native ETH moves without a `Transfer` log. A rule
that asked whether the wallet sent a pricing asset *to a pool* rejected **39 of
40** decoded buys, and all 39 had paid — 36 of them in native ETH only. On this
chain the wallet sends native ETH to a router, the router wraps it, and the
**pool receives WETH from the router**, so the wallet never appears as the
sender of an ERC-20 and the narrower question answers "no" for the normal path.

A wallet counts as having paid when it is the sender of any ERC-20 other than
the token being bought, or is the transaction's sender with a non-zero `value`.

**Ask the cheap half first.** Native ETH is how most buyers pay here, and that
is visible in the transaction alone — no receipt. So `eth_getTransactionByHash`
is fetched first at 15 CU, and `eth_getTransactionReceipt` costs a further 15
only when the native test fails and an ERC-20 leg is the one remaining way to
have paid. This is not an approximation: every case still gets a definite
answer, identical to fetching both, and it only skips evidence that cannot
change the verdict. Measured on 100 transactions:

```
answered by the transaction alone, 15 CU     86
needed a receipt as well,          30 CU     14
mean per candidate                         17.1 CU
```

One transaction read serves every wallet in it, so the unit is the transaction
rather than the candidate.

**The hourly job proves nothing and spends nothing on this.** It writes rows for
wallets that are already in the cohort and never decides membership, and rows
are not payment-proven — so it stays at the 430–714 CU in step 15. The figure
worth recording is the one it avoids: had rows been proven, a median slice holds
**41 cohort-relevant transactions of which ~6 need a receipt, about 705 CU a
run**, and that is the number to compare against if row-level proof is ever
reconsidered. It is also ~78x below the 3,219 transactions an *unfiltered*
candidate stream holds — proving must never be applied before the cohort filter,
which is the mistake that produced a 200x cost estimate once.

**Where the receipt is skipped, "did the payment reach a pool" is reported as
NULL, never as false.** It was not looked at.

**`eth_getBlockByNumber` was tested for this and rejected on measurement. Do not
re-derive it.** It returns every transaction in a block with its `value` for 20
CU, so it would replace the per-transaction read — but only above **1.33
transactions per block**, and PONS measures **1.22**. Using it costs 52,860 CU
per slice against 48,285, which is 9% worse.

**`token_payment_logs` is a free fast path where it already covers a wallet.**
As of 2026-09-08 its **813,458 rows (530 MB, blocks 15,115,287–56,693,145) name
9,875 payers** who sent a pricing asset straight to a pool. It stopped growing
when the hourly job was paused; a figure of 625,888 recorded earlier was taken
seven cycles before that.
Every wallet in it did pay, so it is sound as a shortcut and unsound as a test —
which is exactly the distinction the rejected rule got wrong. Measured against
PONS's 16,910 in-window candidate wallets it proves **2,166 of them, 12.8%, for
nothing**. **It is not worth sweeping for a new token** — collecting it was the
rejected rule's cost, and a new token starts with an empty table.

**The measured cost of the cohort step on PONS, after all of this:**

```
candidate wallets                                     16,910
proven free from token_payment_logs                    2,166   (12.8%)
left to prove over RPC                                14,744
  x 15 CU for the transaction                        221,160 CU
  + ~14% needing a receipt, x 15 CU                   30,962 CU
                                                   -----------
                                                    ~252,000 CU   ~$0.11
```

That is the whole payment cost of an intake. It fits inside the 600,000 CU
cohort ceiling with room, and it replaces the $4.23 that per-row proof would
have cost.

Measured against **execution traces** as independent ground truth — the call
tree read as calldata, not as emitted logs, so the two views can disagree:
**140 of 140 accepts confirmed, 0 disagreements, 0 unreadable**, across a
deterministic 40 and a seeded random 100 with no overlap. **The receipt cannot
score itself**; anything checking this rule again must use a second view.

Six of the 100 accept on proven payment while no pricing asset reaches a pool
counterparty anywhere in the transaction. All six are **v4**, whose settlement
runs through the PoolManager's internal accounting rather than a plain
`Transfer`. They are accepted — the definition asks only that the wallet gave up
value — and reported as payment proven, purpose unproven.

**A receipt that cannot be read raises.** It is not a wallet that did not pay.

**A MULTI-HOP TRANSACTION WHERE THE TOKEN IS AN INTERMEDIATE IS NOT A
CONVENTION DIFFERENCE EITHER.** A router can buy the token on one pool and sell
it on another inside one transaction; the single transfer out of the PoolManager
is then the route's final output, not that swap's. Counting only the token's own
stored swaps cannot see it, because the other legs sit on pools whose swaps were
never collected. PONS had **three such cases in 120,721 pairs — 0.0025%** — and
decoding two showed **four v4 swaps across four pools in one transaction**.
`v4_swaps_all` holds every v4 swap on the chain for the blocks it covers and can
see what the token's own table cannot; outside that range the test falls back to
the token's own count and says so.

**"AND SAYS SO" WAS NOT IMPLEMENTED, AND THE FALLBACK DEFAULTS PERMISSIVELY.** The
join is `left join _allv4 av … coalesce(av.n, 1)`, so a transaction with no row in
`v4_swaps_all` is treated as holding exactly one v4 swap — **unambiguous**. Inside the
covered range that is a measurement: no row genuinely means no v4 swap. **Outside it,
the same null means "not collected", and the test admits the leg rather than flagging
it.** Both readings arrive as `NULL` and the code could not tell them apart.

**The coalesce itself is correct and stays** — it *is* the documented fallback to the
token's own count, `spt.n = 1`. What was missing is the disclosure the comment already
promised. The conventions log now reports how many of the compared transactions sit
outside `v4_swaps_all`'s coverage, so a reader knows for how many of them the v4
ambiguity test was blind rather than satisfied. **A fallback that is not counted is
indistinguishable from a test that passed.**

**Direction comes from the transfer, never from the sign.** The sign convention
establishes which side is the token and how large the counter amount is. A wallet
that received the token bought; one that sent it sold. That is directly
observable and does not depend on getting a convention right.

**The buyer is the address on the non-pool side of the transfer** — not the
swap's `sender` or `recipient` topic, which is routinely a router, and not the
transaction's fee payer.

**The cohort must come from both venues.** The first PONS cohort was built from
v3 pools alone, because v4 pools are not transfer counterparties — the
PoolManager is — and it missed **3,067 wallets, 23.5% of the final cohort**, who
bought exclusively on v4. When a venue's pools are invisible to the obvious
query, that is not evidence they were inactive.

> **Definition — a wallet versus a contract.** An **EIP-7702 delegated account**
> has *exactly 23 bytes* of code: `0xef0100` followed by a 20-byte delegate
> address. **That is a wallet.** Any *other* non-empty code is a deployed
> contract. Empty code is a plain EOA.
>
> Verified on chain: delegated accounts read 23 bytes with an `0xef0100` prefix
> and share a delegate implementation; the PoolManager reads 24,009 bytes, a
> router 4,720, the token 5,274, all with ordinary constructor prefixes.
>
> Treating the two alike wrongly excluded **2,001 wallets** from the PONS cohort
> against **463 genuine contracts** — the cohort would be 15,096 rather than
> 13,095, a 15.3% increase.

**The code check runs at the window's END block, never at `latest`.** An address
that was an ordinary wallet when it bought is a buyer whatever it became
afterwards. Checking at `latest` cost **581 wallets — 4.6% of the cohort** — to
delegations adopted later, and wrongly *included* six that held a delegation
during the window and revoked it after. It was wrong in both directions. This
needs the archival endpoint.

**Pool-ness and wallet-ness are checked at DIFFERENT blocks, deliberately.** A
pool is a pool for good, so the flow probe checks code at the enumeration head.
A wallet's status is a fact about a moment, so the cohort checks code at the
window's end block. Using one block for both would be wrong in one direction or
the other.

**A failed `eth_getCode` must throw.** It has no legitimate error, so anything
else is a failed read, and recording it as "no contract here" turns a pool or a
router into a wallet.

> **Definition — router and infrastructure.** An address is a router when all
> three hold: it is a **deployed contract**, it sends the token to **many
> distinct recipients**, and **a high share of its sends sit inside a
> transaction containing a swap**. The third is the discriminator:
> ```
> 0xb92fe925…  36,850 recipients  150,347 sends   75.6%   router
> 0x8876789976  1,714              12,468         98.3%   router
> 0xb300000b…     502               6,652         96.8%   router
> 0x6a37f719…   2,181              50,303          0.0%   NOT a router
> 0xa1d65242…   1,444               8,613          0.0%   NOT a router
> ```
> The ones at 0.0% move comparable volume to comparable numbers of wallets and
> are distributors. Real routers run 53–98.8%.
>
> **ROUTER DETECTION MUST RUN AFTER THE SWEEP, NOT IN THE SCOPE PHASE.** It reads
`token_transfer_logs` and `token_swap_logs`, and the scope phase runs before
either exists — so on a token loaded in phase order it probes **0 candidates and
reports no routers**, which is indistinguishable from a token that has none.
INDEX did exactly that: 0 probed inside scope, and **40 probed / 19 identified**
when scope was re-run after the sweep. AI only ever worked because its transfers
had been swept by hand first. Re-run scope after the sweep, or move detection to
the cohort step; until that is done, check the probed count is non-zero before
trusting an empty router set.

**RE-RUNNING SCOPE AFTER THE SWEEP COSTS A DUPLICATE COHORT UNLESS THE RUN CAN BE
STOPPED BETWEEN THEM — `--stop-after <phase>`.** The ordering this step requires is
`scope → sweep → scope again → cohort`, and the runner's phase order is fixed:
`scope` STOPs, and a `--continue` from there runs **sweep, conventions and cohort in
one invocation**. So the cohort is built before detection has ever seen a transfer,
and the only remedy without a new control is to let it run, `--redo scope`, and then
`--redo cohort` — **paying the cohort's whole RPC bill twice.** On CHUMP that would
have been 28,690 CU spent for nothing; on a larger token it is the single most
expensive phase paid twice.

`npm run intake -- <cfg> --stop-after sweep` runs up to and including the named
phase and exits cleanly. It is a run control and touches no definition: the phases,
their order, their ceilings and their reports are unchanged. The sequence becomes

```
run                          -> identity, windows, pools      STOP
--continue                   -> scope (routers probed 0)      STOP
--continue --stop-after sweep-> sweep                         stops after it
--redo scope                 -> scope WITH transfers stored   STOP
--continue                   -> conventions, cohort           STOP
```

and **the cohort is paid for once, after the routers it must exclude are persisted.**

**Identify them by behaviour, not from a list.** For PONS, behaviour finds
> **30 routers where the configured list holds 3**, of which only 2 are routers
> at all. A router the list misses gets the trade attributed to it instead of to
> the buyer.

**A STOP ends the process, so the phase after it starts with nothing in
memory. Anything a later phase needs must be PERSISTED, not carried in a
variable.** Router detection reported `probed: 0, identified: 0, rejected: 0`
for AI — a clean pass — because the run that reached the scope phase had resumed
with `--continue`: the windows phase was already complete so it returned
nothing, `windows` fell back to the raw config whose `startBlock`/`endBlock` are
undefined, and `head` was never fetched because every phase that fetches it had
been skipped. Detection therefore ran over `block_number between 0 and 0`.

Measured on the same data, same counterparty list: **0 senders over 0..0, and 16
over the real window**, one of them fronting 9,764 recipients.

The fix is three things, and the third generalises: the windows phase persists
its resolved blocks under `windows:resolved`; a resumed run reads them back and
raises if any window still has no blocks; and **`detectRouters` refuses a range
that contains nothing rather than reporting no routers**. An empty range is a
defect, not an answer.

**The behaviour-detected routers were once never persisted for PONS, and THE
REBUILD FIXED IT — this paragraph said otherwise until 2026-09-14.**
`effectiveExclusions` reads `token_intake_state` for `router:%` rows. Before the
2026-09-11/12 rebuild PONS had **zero** of them, so its 13,095-wallet cohort was
built against the 3 addresses in `config/infrastructure.yaml` and nothing else.
**PONS now has 39 persisted router rows**, matching its stored scope report of
`probed 72 / identified 39`, and section 0 has said so since the rebuild.

**Two places in this document went on asserting the pre-rebuild state**, and a
read-only replay against `token_intake_state` is what caught it. That is the drift
this document exists to prevent, appearing in the document itself: **a claim about
stored state has to be re-checked against the store whenever the store changes**,
and "PONS has zero" was a measurement with a date on it, written as though it were
a property.

**Materialise the swap-transaction set before joining to it.** Written as one
statement with the swap transactions in a CTE, router detection ran for **19
minutes** on AI before being cancelled: the planner has no statistics for a CTE
result and no index on it, so the join against a quarter of a million sends
degenerates. Inserting them into an indexed temp table and analysing it turns
the same work into a hash join. Identical result, different plan.

**The swap-share discriminator needs swaps to discriminate with.** Part 3 of the
router rule divides by the transactions containing a `Swap`. With the swap table
empty for that token and range the share is 0.0% for everyone, and every
candidate is confidently labelled a distributor. AI hit exactly this: its swaps
live in `v4_swaps_all` and were never copied into `token_swap_logs`, so all 16
candidates — including one fronting 9,765 recipients — came back "moves tokens
without trading them". **A zero denominator is not evidence that nobody traded**,
and detection now raises rather than answering.

**Apply the exclusion list at the candidate stage**, before the code check, so an
excluded address never becomes a row. Report list entries that matched nothing —
an entry silently matching nothing is indistinguishable from a check that never
ran.

**Round-tripping is decided PER TRANSACTION, not per window.** A wallet that both
receives from and sends to a pool inside **one transaction** is a fee recipient
or an arbitrage hop. A wallet that buys in March and sells in May is a trader.
The window-level test flags 10,389 PONS wallets and would drop **8,220 of the
13,095 genuine members**; the per-transaction test flags 512 and drops 3.

**"Who traded" has exactly one implementation**, shared by this step and the row
writer. **A check that re-asks the same question is a second implementation, and
it will drift.** The sign-convention check in `build-cohort.ts` was written
fresh, and it paired a swap with any transfer leaving the counterparty. It
reported a 1.4-2.0% convention disagreement on AI, which would have meant the
venue conventions differ per token.

They do not. Decoding settled it: in
`0x0470cc5749d290c824d8bfafac3d990edb6b9bda84a5088d9786e0d711aa5d9e` the
PoolManager sends **2,551.600644918571742165 AI** to `0x1521027b…` and the
identical amount comes straight back in the same transaction — an arbitrage bot,
and the transaction is addressed to it. The v3 case is the same shape: pool
`0xc4a21f9d…` sends 57,289 to a router and 25,239 + 31,951 return.

`tradeLegs` already drops these; the fresh check did not, because it counted
legs in one direction only. Counting both ways gives **v3 15,279 agree / 0
disagree, v4 7,511 / 0** — unanimous, matching PONS. **The residual was the rule
that was not shared.** Two implementations of one rule is a bug waiting to happen: the cohort
once read transfers alone and never joined the swap table, so a transfer out of
the PoolManager with no swap qualified a wallet that produced no row.

---

### Step 8 — Tags

**Does:** writes `wallet_tags` and `token_windows`.
**Costs:** no network.
**Produces:** the cohort as stored.
**Stops:** no — it is only reached after the cohort STOP is cleared.

**Every run writes its `token_windows` row.** A cohort with rows and no window
row is a defect: it means a cohort exists whose definition was never written
down, and the only remaining description of it is the rows themselves. The
dashboard legend and the scorer both read it — **a token with no window row
cannot be scored at all.**

**Write the window row only when the window is complete across every pool in
scope.** A window with rows and no window row is the signal that it was
interrupted, and it renders with no legend entry, which is correct: a
half-collected cohort must not look complete.

**`wallet_tags.source` is `auto` for a run and `manual` for a human edit.** It is
`NOT NULL` with no default. A re-run re-asserts `auto` tags by upsert and never
removes `manual` ones — tags live in their own table so operator edits survive.

**A cohort that shrinks must shrink the tags.** This step was upsert-only, which
meant a membership rule that *removes* a wallet could never take effect. The
PONS rebuild's cohort of 13,823 keeps 12,362, adds 1,461 and **drops 733**;
upserting alone would have left 14,556 tags — the union of two different
definitions, describing no cohort that was ever computed. The cohort handed to
this step is the complete membership for the window, so an `auto` tag for a
wallet not in it is deleted. `manual` is untouched in both directions.

This happens **only when the window is complete**. A partial cohort is not a
membership claim and deleting against one would empty the table. Both callers
pass the whole reviewed cohort, and the hourly adapter only reads `wallet_tags`.

**The step re-counts and refuses to continue if the table does not hold the
cohort.** The statements having run without throwing is not evidence; the rows
written next are derived from these tags, so a wrong tag table is a wrong row
table one step later.

Check the address casing before a rebuild. Tags are matched on the exact string,
so if stored tags and the cohort disagreed in case the upsert would insert a
second row for every wallet instead of refreshing it. On the PONS rebuild both
sides were fully lowercase and the exact-case match equalled the lowercased
match at 12,362, which is what makes the delete-and-upsert safe.

---

### Step 9 — Block timestamps

**Does:** fills `block_times` for the blocks the rows being written actually need.
**Costs:** 20 CU per block. Derive the count and report it **before** the first
request.
**Produces:** `block_times` rows.
**Stops:** no.

**The work set comes from the rows that will be written, not from every block in
the swap table.** That distinction was a **9.6× overshoot** on PONS — 1,379,236
blocks where 144,073 were needed, of which 92,598 were already stored — and cost
roughly **7,000,000 compute units** before it was caught from the billing
dashboard.

**There is ONE derivation, used by both the estimate and the fetch.** They were
once two queries scoped differently, so the plan printed a small number and the
fetch would have done a much larger job. If the two disagree, the job stops
rather than spending against a figure nobody saw.

**THE SAME RULE APPLIES TO ANY JOB THAT PRINTS A WORK SET, and `eth-usd-series`
broke it in the other direction — it printed ZERO and then wrote 140.** Its estimate
asked "which buckets do already-unpriced rows need", a repair question, while its
write asked "which buckets in this range have no price". For a token being repaired
those agree; for CASHCAT, pre-filled before a single row existed, the first was empty
and the second was 158. **Under-reporting a work set is the same defect as
over-reporting one**: the figure the operator approved was not the figure the job
acted on. Fixed 2026-09-14 — see section 9.

**THE WORK-SET DERIVATION MUST BE MATERIALISED, AND ON CHUMP IT HUNG FOR 10m34s.**
It was a single statement whose body was an `exists` holding two
`in (select wallet from wallet_tags ...)` subqueries. The planner has no statistics
for either and no index it can use across them, so against CHUMP's 274,985 swaps,
412,997 transfers and 523-wallet cohort it sat **active and CPU-bound, in
`pg_stat_activity`, having emitted nothing** — the phase log never even printed its
work-set line, because the plan query itself had not returned.

**This is the third time this exact shape has appeared here**, after the 19-minute
router query and the 17-minute conventions query in section 4, and the remedy is the
one those two already established: materialise each input into an indexed temp table
and `analyze` it. Three steps — cohort wallets, then the transactions touching them,
then the swap blocks in those transactions — each a primary-keyed temp table.

**The "one derivation" rule got STRONGER, not weaker.** The estimate and the fetch
used to share a SQL *string*; they now read the same materialised *rows*, so they
cannot drift even if one call site is edited.

**The wall-clock rule is what caught it.** The phase's expectation is "near-free,
seconds"; at ten minutes it was past 3x, and `pg_stat_activity` named the cause in
one query. Waiting would not have worked: the statement had no path to completing
usefully.

**Two `order by 1` text sorts were found alongside it, both in
`fill-timestamps`.** `select … block_number::text … order by 1` binds ORDER BY to the
first OUTPUT column — the text rendering — so the blocks came back in lexicographic
order with `'10003150'` before `'5363150'`. It changes no value, since every block in
the list is fetched either way, but it is the section 7 trap sitting live in the
code. One is fixed by aliasing the cast and ordering by the qualified column; the
other is a `select distinct`, which forbids ordering by an expression outside the
select list, so the cast is dropped instead — node-pg returns an `int8` as a string
regardless.

On Alchemy this step is usually free: `blockTimestamp` arrives with the logs
during the sweep. It exists for the blocks that arrive without one.

**Swaps copied from `v4_swaps_all` carry no timestamp, and that is what makes
this step expensive.** `loadSlice` refuses an in-scope swap whose block has no
stored timestamp — for prices as well as for rows, since `derivePricesForLife`
goes through `loadSlice`. On the PONS rebuild that left **717,340 blocks**, which
is 14,346,800 CU = **$6.46 for one token** at 20 CU per `eth_getBlockByNumber`.

**Take the free route.** `npm run fill-timestamps -- <cfg> --for-prices --public`
fetches the same blocks from the public RPC in batches of 100 at no cost, at
16.7 blocks/sec — about 12 hours for the PONS backlog. The trade is wall-clock
against dollars, and wall-clock is the cheaper of the two here.

This is the rule at the top of this document — "test the free alternatives
before committing to a metered one" — finally implemented. It was recorded after
a ~13,000-call fetch was queued without trying the alternative, and then the
rebuild queued 717,340 the same way, because nothing in the code took the free
route. A rule the code does not implement is a defect in the code.

---

### Step 10 — Prices — **STOP**

**Does:** derives the token's USD price and the native asset's USD price, per
block bucket.
**Costs:** no network — derived from stored logs.
**Produces:** `pons_usd_prices`, `native_usd_prices`, `bridge_usd_prices`.
**Stops:** yes — before any USD figure is attached to a row.

**There is no price feed in this system.** Derive it from the token itself: a
token/USDG swap gives the token in dollars, a token/WETH swap gives it in ETH,
and the ratio is ETH/USD.

**A PRICES PHASE THAT DERIVES NOTHING IS A DEFECT, AND IT REPORTED A CLEAN PASS.**
CHUMP's prices phase finished in **9 ms** with `usdTicks 0, natTicks 0, derived 0,
buckets written 0` — for a token with 274,985 swaps across 51 in-scope pools quoted
in USDG, WETH and native ETH. Nothing raised, because every count was a legitimate
zero in isolation. The cause was `derivePricesForLife(…, firstBlock, head)` being
handed **0 and 0** on a resumed run: the identity phase produces both, a STOP ends
the process, and the prices phase never fetched either. **Every tick count coming
back zero at once is the signature of an empty RANGE, not a token with no market** —
check the bounds before the data.

**Bucketed medians, not per-tick pairing.** Bucket both series by block, take the
median of each side per bucket, then divide. A single bad tick cannot move a
median; pairing individual ticks lets it straight through.

**A degenerate swap poisons a whole series otherwise.** Ticks built as
`|counter| / |token|` occasionally include a swap whose token side is near zero
against a normal counter side. On one Solana window 35 rows priced at exactly
**549,755,813,888** — 2^39, what a float ratio degenerates to — and that window's
USD total came to **$136,522,225,213,212,380** against a real token price near
$0.095.

**Fence at each stage and report what each fence caught:**

```
token/USD ticks   median 8.83e-2   discarded 46 outside 100x
token/ETH ticks   median 4.68e-5   discarded 9,129 outside 100x
derived ETH/USD                    0 outside 10x -- nothing to discard
```

That last zero is the signal the derivation is sound.

**A median taken over too wide a period is biased when the price is moving**,
and that is a systematic error rather than noise. Measured on another chain, a
whole-window rate came to 95.56 where the first half gave 127.17 and the second
97.41. The 10,000-block bucket here is ~17 minutes, far tighter than a window,
which is why buckets are used rather than one figure per window — **but this has
never been measured on this chain.** Measure it on a token that moved.

**Leave gaps as gaps.** Of 4,655 PONS buckets, 4,593 (98.67%) had both sides; 40
had no USDG trade and 22 no trade at all. Those 62 are **not interpolated, not
carried forward**, and swaps landing in them store a null USD.

**Buckets are anchored at a fixed block tied to the token — its first swap
block, its DEPLOYMENT block where the first swap cannot be read, or AN EXISTING
GRID where the token shares a series with tokens already loaded.**

`native_usd_prices` is keyed `(chain, block_number)` with **no token column**: it
is the chain's ETH/USD series and every token writes into it. PONS anchored it at
8,963,150 (residue 3150) and AI at 9,721,433 (residue 1433), so it already holds
two interleaved samplings of one quantity. **INDEX was anchored at 8,963,150 to
reuse PONS's grid rather than add a third** — it is ETH-quoted and leans on that
series hardest, and PONS's 4,943 buckets already span 9,143,150–58,993,150, the
whole of INDEX's life. It reads them and adds none. Prefer an existing grid over
a new one whenever the token shares a series. The
purpose is a fixed grid that a later run reproduces, so the anchor must be a
figure nobody has to re-derive. AI's first swap sits at roughly 9,721,980, more
than five million blocks before `v4_swaps_all` begins, so reading it would cost
~32,400 CU of sweeping to name a boundary. **AI is therefore anchored at its
deployment block, 9,721,433** — approved deliberately, strictly earlier than any
swap it can ever have, and free. Its buckets satisfy `block % 10000 == 1433`.

**A bridge's series is derived on the GRID OF THE TOKEN BEING PRICED**, because
`deriveBridgeUsd` is called with that token's config. `bridge_usd_prices` is keyed
`(chain, bridge, bucket_block)` with no room for two grids, so **two tokens with
different anchors pricing through the same bridge would write interleaved series
into one table** — the exact fault the anchor rule exists to prevent, one level
up. Nothing has hit this yet: AI is the only token with a bridge. Before a second
one gets one, either give the bridge its own fixed anchor or key the table by the
grid.

**Buckets are anchored at the token's first swap block, not at zero.** Every
stored PONS bucket satisfies `block % 10000 == 3150` because the anchor is
8,963,150. A function anchored at zero looks up 54930000 where the stored bucket
is 54933150 — matching nothing, pricing every row null, and writing a second
series interleaved with the first.

**ETH/USD IS A PROPERTY OF THE CHAIN, SO EXACTLY ONE MONITOR PER CHAIN DERIVES
IT.** `native_usd_prices` is keyed `(chain, block_number)` with no token column.
PONS and INDEX both anchored at 8,963,150 and both derived it forward every
hour into the same rows; the insert is `on conflict do nothing`, so whichever
reached a bucket first stored its derivation and the other's was discarded with
nothing raised. **4,644 buckets had swaps from both tokens**, and two
independent derivations ~14 minutes apart differ by a **median 0.52%, mean
0.79%, maximum 11.5%** — small enough that no figure is badly wrong, large
enough that the stored value there was an accident of scheduling.

`pricing.derives_native_usd` now names the owner: **`token-updates` (PONS) owns
this chain's series**, because it is the deepest and longest-running token here.
Every other monitor still *derives* the series in memory — it needs it to value
its own rows for the slice — and **persists nothing**.

**THE INTAKE NEVER HONOURED THAT RULE, and CHUMP is where it was caught — by a
DEADLOCK, not by a check.** The monitor configs have carried
`derives_native_usd` since the rule was written (`token-updates` true,
`index-updates` and `ai-updates` false), but **`plan.ts` never read the key**, so it
was not even a valid intake-config option — and `persistAllPrices` wrote
`native_usd_prices` for every token regardless. CHUMP's prices phase died with
`deadlock detected` against an `index-updates` run that overlapped it by two seconds.

**The deadlock is the symptom; writing a shared table from a second place is the
defect.** It matters more now than when the rule was written: since 2026-09-13 the
series is derived from the dedicated WETH/USDG market, which *is* the quantity, and a
newly-loaded token filling gaps with token-incidental buckets would put the inferior
provenance back into the series the better one was built to replace.

The intake now reads the key, defaults it to **false**, derives the series in memory
as before — the token needs the rate to value its own rows — and **reports the count
it did not write** rather than omitting it.

**The buckets already written by the race are left alone.** Each is a real
derivation from real trades; only which token's trades produced it is arbitrary.
Rewriting them would replace reviewed history to gain at most half a percent,
and the rule below forbids it. Going forward only the owner writes.

#### The chain's ETH/USD series comes from the ETH/USD market — added 2026-09-13

**ETH/USD was a by-product and is now a measurement.** It used to exist only
where a *tracked token* happened to trade against both a native asset and USDG
inside one bucket, which made the chain's reference series an accident of which
tokens were loaded. That left it starting at 5,363,150 — the bucket of INDEX's
first USDG swap — with **6,052 INDEX rows below it unpriced**, and its earliest
buckets resting on a single USDG tick each, swinging 1,877 → 1,434 → 1,653 across
110,000 blocks.

The chain has a dedicated market for exactly this quantity: **48 WETH/USDG and
ETH/USDG pools, the earliest created at block 50,716**, 1.62M blocks before the
earliest tracked token's first swap. `eth-usd-series` enumerates them the same way
step 3 enumerates any pool — both orderings of both pairs, `Initialize` for v4 and
`PoolCreated` for v3 — sweeps their swaps, and derives the series from ticks whose
two sides *are* ETH and USD.

**The ratio is convention-independent, which is why this is safe across venues.**
A tick is `|usd side| / |native side|`, and taking absolute values means the v3
pool perspective and the v4 swapper perspective give the same number. Step 6's
conventions decide direction, and this derivation asks only for magnitude.

**Decimals come from the pricing-asset block in config, not from a per-swap
read.** WETH 18, USDG 6, native ETH 18 are fixed by this document and by every
intake config; a pool in this market pairs two of exactly those three. This is the
one place decimals are not read per token, and the reason is that the assets are
enumerated rather than discovered.

**IT WRITES ONLY BUCKETS THAT ARE MISSING.** The rule below is absolute and this
obeys it: a stored bucket was computed by a run that saw the whole bucket, so the
job inserts `on conflict do nothing` and reports how many it skipped. It does not
improve the single-tick buckets — that would be a rewrite.

**The consequence is a series with two provenances, and it is recorded in the data
rather than only here.** `native_usd_prices.source` is `eth-usd-market` for a
bucket derived from the dedicated market and **NULL for every bucket written
before 2026-09-13**, which were derived from a tracked token's incidental
both-sided ticks. A null is not a missing value here; it is the older method, and
the column exists so nobody has to infer provenance from a block number.

**It writes on the residue-3150 grid, not a chain-level one.** That is the grid
PONS and INDEX read, so it is the grid that fixes the rows. Giving the shared
series a genuine chain-level anchor still needs the resolver to look up native
prices on a chain anchor instead of the token's, and AI's 4,172 buckets at residue
1433 remain unreadable by the other two. **Both stay open in section 9** — this
fixes the coverage hole, not the fragmentation.

**Cost, sized from the buckets actually needed rather than from the token's
life:** 378 missing buckets span 1,663,150–9,453,150, so the sweep covers
7,800,000 blocks. Enumeration is 8 sparse calls (~480 CU). The probe measured 168
`eth_getLogs` over 3,700,000 blocks of this same market, which scales to ~354
calls, so **~22,000 CU ≈ $0.010, ceiling 200,000 CU**. Timestamps ride with the
logs. Deriving, writing buckets, reinserting the rows and re-scoring cost nothing.

**RUN 2026-09-13, measured against that estimate:**

```
pools enumerated                807   (803 v4, 4 v3; earliest created block 50,716)
pools that actually TRADED       52   (48 v4, 4 v3) -- matching the probe exactly
market swaps swept        1,867,945   (v4 352,990, v3 1,514,955)
block_times carried          812,410   free, with the logs
buckets derived                 780   every bucket in the range had a market
ticks kept                1,867,130   median 2,201.5 per bucket
discarded by the 10x fence        8   the signal the derivation is sound
ETH/USD                 $1,701.18 - $1,972.97, median $1,778.87
buckets INSERTED                489
buckets already present, SKIPPED 291   never rewritten
                          ---------
cost                       42,960 CU   $0.0193   ceiling 200,000, never approached
```

**2.0x over the estimate, and the reason is density, again.** 716 `eth_getLogs`
against ~354 estimated, because v3 in this range runs **0.19 logs/block against
the probe's 0.049** — the probe sampled 1,670,964–5,371,436 and the sweep ran to
9,463,149. That is the third time here that a density taken from a different range
has been wrong, after 16x on AI and 27% on INDEX. **Sample the blocks you are
about to read.**

**Re-running it is idempotent, and that was verified rather than assumed:** a
second pass stored 0 new pools, 0 new timestamps, and the identical swap counts.

**The market series is tight where the old one is not.** 489 market buckets span
$1,701–$1,973 — a 16% total range on a median 2,201 ticks each. The 9,670
token-incidental buckets span **$1,239–$2,653**, a 114% range, on a median 216
ticks.

**THE OLD SERIES IS MEASURABLY WRONG WHERE ITS TICK COUNT IS LOW, and that is now
evidenced rather than suspected.** Because the market fills only gaps, no bucket
carries both provenances, so there is **no same-bucket cross-check** — that
comparison returns zero rows and is reported as zero, not omitted. Comparing each
market bucket against a token-derived bucket within ±20,000 blocks instead, across
**245 pairs**:

```
mean difference    5.70%
median             3.63%
maximum           42.91%
over 10%              30 pairs
```

**Every one of the five worst disagreements is a token-derived bucket resting on
2 or 3 USD ticks**, and in each the market says ~$1,771–$1,798 while the token
bucket says $1,239–$1,298:

| market bucket | market | token bucket | token | token ticks | difference |
|---|---|---|---|---|---|
| 9,073,150 | $1,771.48 | 9,083,150 | $1,239.55 | **2** | 42.91% |
| 6,633,150 | $1,797.93 | 6,623,150 | $1,297.74 | **3** | 38.54% |
| 6,603,150 | $1,797.09 | 6,623,150 | $1,297.74 | **3** | 38.48% |

**The market is the one telling the truth.** Three transactions decoded
independently — blocks 1,680,559, 3,005,932 and 5,354,209 — give 1,708.53,
1,771.72 and 1,743.24, which agree with the market series and not with $1,239.

**Never rewrite a bucket that is already stored.** A stored bucket was computed
by a run that saw the whole bucket; recomputing gains nothing and silently
replaces reviewed history. Three were rewritten before this was caught.

#### THE ONE EXCEPTION, approved 2026-09-13

**"Never rewrite a stored bucket" now has a single exception: when the stored
value is KNOWN WRONG and the replacement is BETTER FOUNDED.** Both halves are
required, and neither is a matter of opinion:

- **Known wrong** is a same-bucket disagreement against an independent derivation,
  not a hunch and not a thin tick count on its own.
- **Better founded** means, precisely: the replacement is derived from the market
  that *is* the quantity being measured, from **1,710–6,421 ticks** per bucket
  against the stored value's **1–11**, and it agrees with transactions decoded by
  hand while the stored value does not. Blocks 1,680,559, 3,005,932 and 5,354,209
  give 1,708.53, 1,771.72 and 1,743.24; the stored buckets nearby say $1,239.

**A tighter number is NOT grounds on its own.** The original rule exists because
recomputing a bucket gains nothing and silently replaces reviewed history, and
that still holds for a bucket that merely has more ticks. What lifts it here is
that the two derivations disagree materially *on the same bucket* and one of them
is independently corroborated.

**The measurement, same-bucket rather than adjacent.** An earlier figure of "~30
wrong buckets" came from comparing each market bucket with a token-derived bucket
within ±20,000 blocks, which double-counts. Deriving the market value **for the
same bucket** gives 291 comparable buckets:

```
compared                        291
mean disagreement              4.47%
median                         3.22%
maximum                       43.15%
over 10%                         18   <- the set overwritten
over  5%                         94
over  2%                        194
```

**The threshold is 10%, and the reason it is not lower is this document's own
tolerance.** Section 1 says dollar approximation is acceptable; the calibration in
use is that USD error up to about 5% changes no decision. So 2–5% is noise nobody
acts on and rewriting it would spend reviewed history to gain nothing. **Between 5%
and 10% is a judgement call that was NOT taken** — 76 further buckets sit there and
they stand.

**Every overwrite is recorded, not replaced.** `native_usd_prices_history` keeps
the old value, its tick count, its source and the reason, so the rewrite is
auditable and reversible. Overwriting reviewed history without a trail would be
worse than the error.

**What it moved, measured before writing:**

```
buckets overwritten                18   of 291 compared; 10.55% to 43.15%, median 14.76%
rows in those buckets, INDEX      786   506 trades, 280 transfers
rows in those buckets, PONS       161   137 trades,  24 transfers
rows in those buckets, AI           0   <- AI reads residue 1433, not 3150
transfer rows unchanged           304   null by definition
```

**What moved, measured before and after:**

| rows | USD before | USD after | change |
|---|---|---|---|
| INDEX / ETH, 484 trades | $351,100.38 | $389,123.88 | **+$38,023.50 (+10.83%)** |
| PONS / WETH, 137 trades | $13,340.68 | $13,821.41 | **+$480.73 (+3.60%)** |
| INDEX / USDG, 22 trades | $4,215.77 | $4,077.61 | **−$138.16 (−3.28%)** |

**A USDG-quoted row is NOT insulated from the ETH/USD series, and predicting that
it was is a mistake worth recording.** A stablecoin resolves to 1 without reading
any series, so those 22 rows were expected not to move. They moved, and the reason
is step 11's allocation rule: `groupUsd` is summed over a GROUP, a group can span
pools (`group.pools.size > 1`), and **11 of the 22 transactions also contain an
ETH-pool swap of the token**. Re-pricing the ETH leg changed the group total and
therefore the USDG row's allocated share.

The correct statement: **a USDG row is insulated only when its transaction
contains no ETH-quoted leg.** Checking the stored ROWS for a second pool is not
enough either — the first check looked there, found 0, and was wrong; the ETH
swaps produced no rows of their own. Check `token_swap_logs`.

**A side effect worth having: PONS trade rows with a null USD fell from 80 to 67.**
The 489 buckets the market ADDED include some inside PONS's life, and the reinsert
picked them up.

**Verified after: 0 of 291 buckets on this grid still disagree by more than 10%**,
and the 76 between 5% and 10% stand as recorded in section 9. Watchlist membership
did not change at all — 0 added, 0 removed — so the repair was correct and
immaterial to the cut. Both are worth saying: a fix that changes real money need
not change a decision.

**AI's zero is the fragmentation in section 9 showing through.** AI's buckets sit
at residue 1433 and it never reads a residue-3150 bucket, so a repair on this grid
cannot reach it. AI's own series has the same defect and has not been examined.

**Only whole buckets are written.** A bucket straddling the edge of a range is
computed from a fraction of its ticks.

**Sanity-check against a live source, and say so when you cannot check the
past.** The derived PONS series ran $1,614–$2,548 with a median of $1,911, and
its most recent bucket read $2,480.88 against DexScreener's deepest live
WETH/USDG pool at $2,488.48 — **0.3% apart**, from an entirely independent
derivation. Historical levels could not be checked against any external source
and that was stated rather than implied.

**Stored prices must fall inside the range of the ticks they came from.** Run
that comparison after any collection; anything outside it is a defect to explain
rather than an outlier to accept.

**"THE TICKS THEY CAME FROM" MEANS THE ROW'S OWN BUCKET, AND CHECKING IT AGAINST
THE SERIES' GLOBAL RANGE REFUSED A CORRECT WRITE.** The check took `min`/`max`
over the whole of `<token>_usd_prices` and required every row to fall inside it.
That silently assumes the token's own USD series spans its life — true for PONS,
INDEX and AI, and **false in general**.

CHUMP is the counter-example. 264,263 of its 274,985 swaps sit on one v3 WETH pool
and only 2,331 are USDG-quoted, so its own series is **49 buckets covering
45,293,150–61,693,150 — 1.3% of its life, all of it after the cohort window
closed.** Its rows are priced from the COUNTER side across the whole life, and the
token rose from **$0.0000022 at its first swap to $0.0425 at head, about
19,000x.** 1,749 perfectly correct rows fell below a range derived from the last
1.3% of the token's history, and the write was refused.

**Proven on individual swaps before the check was changed, per the rule that an
aggregate is a hypothesis.** Hand-computed from the pool's own amounts times the
bucket's ETH/USD, on the charted v3 pool `0x714442e9…` where CHUMP is `amount1`:

| block | transaction | WETH route | CHUMP's own USDG bucket |
|---|---|---|---|
| 23,794,012 (first swap) | `0x655220cda0f1df3522be9a3308f3d6ff2fd140d6935dd86df245d003a93f2df0` | **$0.0000022381** | — |
| 40,002,855 | `0x5d81d811fd715801927d4f83da35bdb851f2f2fb1e2ebf2badf52251cd72866b` | $0.0014901 | — |
| 44,993,181 (just after the window) | `0x01d98a1b0f943eb1aa15cad564a1254dde36910f06e0584c606d424697bd646c` | $0.0101957 | — |
| 55,000,045 | `0x93eea3fa7c5baf35a0466203fe16fdd9df2cd1dcfcab2cdc871d36313d356ed0` | $0.0411014 | — |
| **61,697,928** | `0x72154acac93af66efc6bf06461b1c45c0b947b1fc6c9993cab04fc1566ac41c1` | **$0.0424296** | **$0.0425254** |

The first line is exactly the low the check rejected, and **the last line is the
cross-check that settles it: two entirely independent routes — WETH × ETH/USD
against a direct USDG quote — agree to 0.23%** in the one era where both exist.

**The comparison is now per bucket, at the configured native fence.** Measured over
CHUMP's 10,215 comparable swaps: **0 outside 10x**, worst ratio 6.58x, mean
difference 13.1%. That spread is real intra-bucket movement across ~17 minutes on a
token that rose 19,000x, and an order-of-magnitude error — the 2^39 degenerate tick
this check exists to catch — still cannot hide inside 10x. **Rows sitting in a
bucket the token's own series never priced are NOT comparable, and that count is
reported rather than dropped from the denominator.**

**Sanity-check the USD total against market cap ÷ supply** before reporting it. A
sum is the cheapest tripwire there is.

---

### Step 11 — Dry run — **STOP**

**Does:** builds every row the write would produce and reports the counts.
Writes nothing.
**Costs:** no network.
**Stops:** yes.

The dry run and the write are **the same code path**, with a flag. Two paths
that are supposed to agree do not.

> **Definition — a transfer versus a trade.** A **transfer** is any ERC-20
> `Transfer` log for the token, neutral about intent. A **trade** is a transfer
> whose counterparty is an in-scope pool, inside a transaction containing a
> `Swap` on that pool.
>
> **A trade carries no payment test, and step 7's does not apply here.** That is
> deliberate and the two sections agree: payment is proven **once per wallet, to
> decide cohort membership**, and never again per row. A row saying the token
> moved between a wallet and a pool in a swap transaction is a true statement
> about the chain whether or not that particular wallet funded that particular
> transaction. Rows that are really unpaid receipts show up as a negative
> position and are flagged `inflated-pnl`, which is the same treatment missing
> transfer rows get. See step 7 for the decision and its cost.
>
> **"Was present in a transaction containing X" is not "did X."** A transaction
> contains many transfers, most of them intermediate hops. That conflation
> produced a wrong count of 34,744 that nearly justified a rebuild.

**Write `transfer_in` and `transfer_out` for movements that are not trades**,
always with a **null** USD amount — an acquisition or disposal at an unknown
cost. Their absence is why a large minority of PONS cohort wallets show a
**negative position**, having sold more than they bought, and why the
`inflated-pnl` flag exists. Measured in `numeric` over the 13,095 cohort on
2026-09-07:

```
position < -0.001, intake rows only              2,061
position < -0.001, all rows including hourly     2,100
stored inflated-pnl flags (computed 09-06 20:08) 2,088
```

**An earlier figure of 2,682 is recorded here and does not reproduce under any
of the three.** It is not known which measurement produced it, and it has not
been reinterpreted to fit — the three live numbers stand and the discrepancy is
recorded as open.

**A transfer becomes a row only when it is not part of a trade for that wallet in
that transaction**, or the same movement counts twice and every position doubles.

**Four floors, each catching something different:**

```
token side  >= 1 raw unit    caught 0 rows on PONS
paid side   >= 1 raw unit    caught 22 rows
token amount >= 0.001        caught 1 row carrying $980,393.99
USD >= $0.01                 caught 5,301 rows, largest $0.00999987
```

The **paid-side** floor catches what the token-side floor does not: a leg where
the wallet received real tokens and gave up float residue.

The **token-amount** floor is the one that is easy to omit. A USD-only floor lets
through a row with 1.7e-6 tokens and $980,394 of allocated USD — a price of
$5.79e11 per token, and **0.87% of the token's entire USD volume, invented**.

**Rows with a null USD are never dropped by the USD floor.** Unpriced is not
small: two of PONS's 2,266 unpriced rows carried token amounts in the thousands.

**Float residue passes a `> 0` test and invents buyers.** A wallet whose receipts
and sends cancel nets to zero exactly and to `2.8e-14` in floating point. 89 such
rows existed once, and 10 wallets had no other rows at all — tagged as buyers who
never bought. **Compute counts and thresholds in SQL, in `numeric`.** The same
count gave 2,101 in doubles and 2,682 in numeric, a 28% difference on 18-decimal
quantities. **Neither figure reproduces today** — see the negative-position
counts above — so treat the 28% as the finding and the two numbers as
unverified.

**Allocate USD across wallets by each wallet's share of the token moved in that
transaction and pool.** The denominator spans every candidate, including wallets
outside the cohort — allocating only across cohort wallets hands them dollars
that belonged to someone else in the same transaction.

**Report dry-run counts including zeros, and abort on a mismatch rather than
adjusting the numbers to fit.** A pre-flight once printed `zero_both : 480924`
because its query had lost a `filter` clause, and committed anyway; the real
figure was 10. A genuine catastrophe would have committed identically.

---

### Step 12 — Write

**Does:** inserts `wallet_transactions`.
**Costs:** no network.
**Stops:** no.

**THE PER-TOKEN PRICE TABLE WAS CREATED BY NO CODE, and CHUMP is where that
surfaced.** `SCHEMA` in `adapters/token-updates/schema.ts` creates exactly one:
`pons_usd_prices`, hardcoded. `index_usd_prices` and `ai_usd_prices` were made by
hand, exactly as `token_swap_logs` and `token_events` were, so the prices phase died
on `relation "chump_usd_prices" does not exist` **after deriving the whole series** —
the work was done and had nowhere to go. The table named by `tables.token_usd` is now
created if it is missing, with the name validated against `^[a-z][a-z0-9_]*$` before
it reaches the statement. **A table that is read and written by code but created by
none is a missing step, not a missing row** — this is the third instance of that
sentence in this document.

**The hand-made tables and the schema had already drifted, which is the reason to
care.** `index_usd_prices` and `ai_usd_prices` declare `pons_usd` and `ticks` as
`NOT NULL`, matching `SCHEMA`; `pons_usd_prices` itself, the one the schema actually
creates, has them **nullable**. Two shapes for one table definition, and nothing
would have reported it.

**Two columns are named for the first token loaded, and neither is
configurable:** `pool_meta.pons_side` and `<token>_usd_prices.pons_usd`. The
table NAMES are configured; the column names are not, so every token's price
table carries a `pons_usd` column and every pool row a `pons_side`. Renaming
them is a migration rather than a config change. Expect them; do not write
`token_side`.

**The unique key is `(chain, tx_hash, wallet, token, side, pool, counterparty,
log_index)` with `NULLS NOT DISTINCT`, and every part of it earns its place.**
Each was added after the simpler form silently discarded real rows, and since
the insert is `ON CONFLICT DO NOTHING`, a discarded row looks exactly like an
idempotent re-run.

| part | what the key loses without it |
|---|---|
| `counterparty` | one transaction sending to two recipients makes two `transfer_out` rows that collide on a null pool — splits and airdrops do this constantly |
| `NULLS NOT DISTINCT` | the opposite: Postgres treats two nulls as distinct, a null pool makes every transfer unique, and a re-run doubles every transfer instead of being idempotent |
| `log_index` | two transfers in one transaction **between the same pair** collapse to one row and the rest are thrown away |

The third was found on 2026-09-12, when the PONS rebuild planned 502,147 rows
and stored 488,806 — **13,341 transfers discarded, trades untouched**. They are
not duplicates. In `0x8235525f6cb2d57d9dad3685463741af94179148b490cfe98687c7755d1d8a5f`
there are **58 transfers** from `0x5ca62142…` to `0x0e42d788…`, every amount
different; in `0xd1f443def102e449e4744fe12ef4ac0d9e2c8f89e2f422efccef9672bb780afe`
there are **133** between one pair. Measured over cohort-touching logs, the old
key collapsed **26,149 for PONS, 3,959 for INDEX, 1,842 for AI**.

**`log_index` is NULL for a trade row and that is deliberate.** A trade row
aggregates every swap log for one wallet, side and pool inside a transaction —
that aggregation is the definition of the row, not an accident — so it has no
single log index and must keep deduplicating exactly as before. `NULLS NOT
DISTINCT` gives that for free: trade rows all carry null and collide as they
always did, transfer rows carry a real index and no longer collide.

The defect stayed invisible for as long as it did because PONS had 2,240
transfer rows until the transfer gap was closed. At 311,112 it surfaced
immediately. **A constraint is only exercised by the data that reaches it.**

**The hourly adapter hardcoded `counterparty` to null while the intake passed the
real value.** Same family, opposite direction: the column is in the key so that
one transaction to two recipients keeps both rows, and with null it keeps one.
719 PONS rows, 1,205 INDEX and 311 AI carry a null counterparty written by that
path. Two code paths inserting into one table must build the row the same way,
and this is the fourth time on this project that they did not.

**Write progressively**, per slice, not accumulated and flushed at the end, so a
run that dies leaves a truthful partial record rather than nothing.

**Bound a catch-up run to the range, and do not overshoot.** `catch-up` stops
when the cursor stops advancing, a cycle fails, or the cycle limit is reached —
so a limit set above what the range needs keeps going into fresh blocks. A
recovery of 1,757,870 blocks needed 44 cycles of 40,000; `--max-cycles 50` ran
six more, wrote 220 rows nobody had asked for and moved the cursor 240,000
blocks past where the operator left it. Nothing was corrupted, and that is not
the point: derive the cycle count from the range before starting.

**Correcting a run is a scoped delete and reinsert** — `(chain, token, tag)`,
never wider — with dry-run counts reported first, including the zeros. Neither
`wallet_tags` nor `token_windows` is touched by it.

**Verify from a fresh connection afterwards, not from the script exiting
cleanly.** A script that finished without throwing is not evidence the write
landed. The same applies to deploys: establish success from observable state.

**THE WORST CASE THIS DOCUMENT HAS RECORDED: THE WRITE REPORTED 3,200 ROWS STORED
AND "intake complete", AND THE DATABASE HELD ZERO.** Found on CHUMP 2026-09-13 by
that fresh-connection rule and by nothing else — every log line said success.

The mechanism, and it generalises far past this one query. **Postgres aborts a
transaction the moment any statement in it fails, and `COMMIT` on an aborted
transaction DOES NOT RAISE — it returns the command tag `ROLLBACK` and discards
everything.** So one swallowed query error anywhere inside a transaction turns the
whole thing into a silent no-op. The write phase did this:

```
insert 3,200 rows                                        -- fine
select coalesce(max(total_supply),0) from tokens ...     -- ERROR: no such column
  .catch(() => ({ rows: [{ s: '0' }] }))                 -- error hidden, tx now ABORTED
checkUsdTotal(..., supply = 0)                           -- "within the ceiling"
COMMIT                                                   -- returns ROLLBACK, no error
writePhase(status = 'complete')                          -- a SEPARATE transaction, commits
```

`tokens` has columns `mint, chain, ticker, name, decimals, charted_pair,
created_at, role` — **there has never been a `total_supply` column**, so that
statement failed on every token. It never mattered before because PONS, INDEX and
AI were loaded with the standalone CLIs; **CHUMP is the first token driven through
the runner end to end**, and the runner is what wraps a phase in one transaction.

Two fixes, and the first is the one that matters:

- **`withTransaction` now checks the command tag the COMMIT returned** and raises
  if it is `ROLLBACK`. It costs nothing and converts every
  swallowed-error-inside-a-transaction into a failure instead of silent data loss.
  It belongs there rather than at the call site because **every caller is exposed**,
  not only the one that was caught.
- The supply figure is read back from the stored identity report — the identity
  phase reads `totalSupply()` from the contract — and **raises if absent** rather
  than defaulting to a zero that makes the sanity check meaningless.

**This is the "never map an error to a zero" rule with a new and worse
consequence.** The `balanceOf` case manufactured plausible wrong data; this one
threw away correct data and reported success. **A `.catch` that returns a default
inside a transaction is not a fallback, it is a silent rollback of everything
around it.**

---

### Step 13 — Score

**Does:** scores the cohort on seven weighted metrics.
**Costs:** no network — reads the database only.
**Produces:** `wallet_scores`.
**Stops:** report-only unless `--write` is passed.

```
1a PnL USD          30%    min-max across the cohort
1b PnL percent      20%    min-max
2  number of buys    5%    min-max
3  earliness        12.5%  linear within the window, already 0..1
4  hold time        12.5%  min-max
5  pre-pump share    5%    MAX over pumps of a share, already 0..1
6  buy-size trend    5%    share x weight, already 0..1
7  total USD in     10%    min-max
```

**Min-max, not rank, deliberately** — the point is that outliers dominate. The
consequence is measurable and must be stated: on PONS, **70% of the nominal
weight sits on money metrics that contribute 0.8% of the median wallet's
score.** The typical wallet is ranked by earliness, hold time and buy-size trend.

**Metric 6's denominator shifts per pump point:** for the second pump it weights
every buy from inception to that pump, including buys after the first, so the
same buy contributes differently to each pump's figure.

**The window selects who is scored; every metric then runs over the wallet's full
history**, except metric 3, which is explicitly the first buy inside the window.

**A null is never a zero.** Nulls drop out of the weighted sum and the remaining
weights are renormalised, so a wallet is never punished for a metric that could
not be computed. **Report the weight each score rests on** — the top-scoring PONS
wallet rests on 17.5% of it, its 22 buys all unpriced, ranked on hold time alone.

**A metric whose range is degenerate across the cohort is dropped for everyone
and reported**, rather than dividing by a zero range.

**SCORING IS RECURRING, AND IT IS ITS OWN MONITOR.** Every input moves with
every new row — PnL, hold time, buy count, total USD in — so a score computed
once at intake is stale the moment the next row lands. Every token was scored
exactly once, by hand, while rows arrived hourly: **PONS's scores were three
days old, AI's a day, and rescoring moved 12,385 of 13,095 PONS wallets and
3,496 of 3,508 AI wallets.**

It is a separate monitor rather than part of the hourly job because:

- the hourly job is per TOKEN and cursor-driven; scoring is per (token, window)
  and has no cursor. A token-scoped job leaves a token with no hourly monitor
  unscored — which is how AI went a month without one;
- scoring must cover **every** window, and a token-scoped job cannot see the
  others;
- it reads the database only, so coupling it to a job that spends compute units
  means a ceiling or a rate limit stops scoring too, and a scoring bug fails row
  ingestion.

**THE SCORING MONITOR IS SCOPED TO ONE CHAIN, and this was recorded wrongly
once.** Its first version scored every token that had a cohort, defaulting the
chain, so it scored **MOS and USELESS — Solana tokens — from a Robinhood
monitor**. They raised for want of pump points and that was written down here as
"correct". It was not: line 7 says Solana is a different chain and nothing here
applies to it. **A scoping defect had been documented as correct behaviour**,
which is precisely the failure this document exists to catch, and it survived a
review that claimed to find no contradictions. The chain is now a required
option with no default.

**One unscoreable window must still not block the rest, and must not be
swallowed.** Each window is scored independently and every failure is recorded
with its reason and alerted — and **the run fails if any did**. That last clause
was also written before it was true: the code queued the alert and returned
success, so `last_status` read green while windows went unscored.

**There is ONE implementation of a score.** It lived inside the CLI's `main()`,
which is why the only way to score was to run it by hand. It now lives in
`src/scoring/run.ts`; the CLI and the monitor both call it.

**A cohort that shrinks must shrink the scores.** This was upsert-only, like
tags were, so a wallet removed from a cohort kept its score for ever. The PONS
rebuild dropped 733 wallets and left 733 scores behind: **14,556 rows describing
a 13,823-wallet cohort**, which the dashboard reads and renders as members.
Scoring now deletes `wallet_scores` rows for wallets no longer carrying the tag,
scoped to `(chain, token, tag)` so a wallet scored under another window is
untouched.

**The delete and the verification run inside the write transaction**, and the
run throws if the table does not then hold exactly the cohort — rolling the
whole write back rather than publishing a score table that describes no cohort
that was ever computed. The statements having run is not evidence.

This is the same defect in three places: `wallet_tags`, `wallet_scores`, and
`wallet_transactions` rows for dropped wallets. **Whenever a membership can
change, every table derived from it needs a removal path, not just an upsert.**
Check the rest of the derived tables against this before adding another.

**Two score-quality flags, derived on every run and stored as an array:**

- **`low-weight`** — the score rests on less than 0.8 of the weight. **Re-derive
  this threshold per token**: the PONS weight distribution is bimodal (12,296 at
  1.000, then 67 at 0.875, 18 at 0.825, 1 at 0.175), so 0.5 and 0.8 make the
  same cut there and 0.9 catches 86.
- **`inflated-pnl`** — position below **-0.001** tokens: it sold more than it
  bought, so its PnL counts a sale whose purchase is invisible. **It covers two
  causes and does not distinguish them**: transfers not yet collected, and buy
  rows that were never payment-proven because proof is taken once per wallet at
  cohort time rather than per row (step 7). Both produce the same symptom — a
  sale with no matching purchase — and both clear the same way, by collecting
  the missing side. **The floor is
  not zero**: 589 PONS wallets are negative by less than a millionth of a token,
  the smallest by 3e-18, which is allocation residue.

The flags array is **replaced** on every run, never appended, and the position
sums include transfer sides — so once transfers are collected, `inflated-pnl`
clears itself.

#### METRIC 5 IS THE MAXIMUM OVER PUMPS — changed 2026-09-14, and it replaces a mean

> **Metric 5 is the LARGEST share any single pump's 48-hour pre-window took of the
> wallet's total dollars in.** Not the mean of those shares over the pumps.

**What it replaces, and why the mean was wrong.** The metric averaged every pump's
pre-48h share: `shares.reduce(+) / shares.length`. **Whenever two pumps are more than
48 hours apart their pre-windows are disjoint, so a buy dollar falls in at most one of
them** — the shares then sum to at most 1 and their mean to at most **1/n_pumps**. The
ceiling had nothing to do with the cohort's behaviour; it was arithmetic.

**Three tokens recorded a maximum sitting exactly on 1/n before this was diagnosed:**

| token | pumps | recorded maximum | |
|---|---|---|---|
| PONS | 3 | **exactly 1/3** | read as "no wallet bought before more than one pump" |
| CHUMP | 2 | **exactly 1/2** | read as a window-end effect — real, but not the whole cause |
| CASHCAT | 3 | **exactly 1/3**, 168 wallets on it, **0 above** | the one that settled it |

**This document's own instruction — "a maximum landing exactly on 1/n_pumps is the
signature" — was describing the defect and calling it a property of the cohorts.** It
was written after PONS, repeated after CHUMP, and read as a finding about wallets all
three times. **A value that keeps landing on a round function of a CONFIGURED COUNT is
a property of the code, not of the chain.** That is the transferable lesson here.

**What the mean cost, precisely.** `normalised.prePumpShare` is the raw value passed
through unchanged — the metric is already 0..1 by construction and is deliberately not
min-maxed (see below) — so a stated weight of **0.05 delivered at most 0.0167 on a
three-pump token and the full 0.05 on a one-pump token.** Identical behaviour scored
differently for no reason but how many pumps an operator configured, which silently
reweighted the composite between tokens.

**Why the maximum and not one of the alternatives.** Dividing by the 1/n ceiling
rescales but keeps the mean's meaning, so buying before all pumps stays
indistinguishable from buying before one. Unioning the windows reaches 1.0 but discards
the per-pump structure metric 6 is built on. **The maximum answers the question the
metric is named for — did this wallet load up before a pump — reaches 1.0 on every
token, and does not penalise a wallet for having bought before a second one.**

**It is still "already 0..1" and still not min-maxed.** Each share is a fraction of the
wallet's own `usdIn`, so the maximum of them is at most 1 and reaches 1 exactly when a
wallet bought its entire priced position inside one pre-pump window. The normalisation
category is unchanged by this.

**SCORES COMPUTED BEFORE 2026-09-14 ARE NOT COMPARABLE WITH SCORES COMPUTED AFTER.**
Every stored score up to that date used the mean. Nothing is restated retroactively —
the figures recorded against each token in section 8 are what those runs produced, and
they are labelled with which definition produced them. **Do not compare a score quoted
from an older section against one computed now.**

**What still bounds this metric, stated so it is not mistaken for unbounded.** A cohort
member can only precede a pump it could physically buy before. Where every pump sits at
or after the window end — CHUMP, where pump 1 *is* the window end — a wallet can only
have bought before the first, and pumps after it contribute zero to the maximum as they
did to the mean. **That is a property of the window and the pumps, not of the
aggregation**, and the maximum reports it honestly: such a wallet now reads 1.0 for
"everything before a pump" rather than 0.5 for "half of an average".

**Still watch the distribution on every token, and report it rather than inferring it
from the maximum.** The question is whether the 5% separates anyone: CHUMP's split of
67% at zero against 23% at the ceiling is real separation, and PONS's >75% at zero is
close to none.

##### WHAT THE CHANGE MOVED, MEASURED ON ALL SIX WINDOWS BEFORE IT WAS WRITTEN

Measured with `npm run prepump-change`, which snapshots the stored scores, then runs
the real scorer with `write: false` and compares. **The "after" comes from
`scoreWindow`, not from a recomputation of the metric here** — predicting a definition
change with a second implementation of the rule being changed is the trap step 7
records four times, and it would be wrong in exactly the case that matters.

**The metric itself. Every window's maximum moves from exactly 1/n to exactly 1.0, and
the count sitting on 1/n falls to zero in all six:**

| window | pumps | max before | max after | at 1/n before → after | at 1.0 after | mean before → after |
|---|---|---|---|---|---|---|
| CASHCAT-P1 | 3 | 0.333333 | **1.0** | 168 → **0** | 167 | 0.0415 → 0.1238 |
| CHUMP-P1 | 2 | 0.500000 | **1.0** | 119 → **0** | 116 | 0.1361 → 0.2672 |
| AI-P1 | 2 | 0.500000 | **1.0** | 43 → **0** | 41 | 0.0133 → 0.0259 |
| PONS-P1 | 3 | 0.333333 | **1.0** | 657 → **0** | 648 | 0.0268 → 0.0790 |
| INDEX-P1 | 3 | 0.333333 | **1.0** | 667 → **0** | 664 | 0.0955 → 0.2854 |
| INDEX-P2 | 3 | 0.333333 | **1.0** | 84 → **0** | 78 | 0.0183 → 0.0527 |

**THE ZERO AND NULL COUNTS DO NOT MOVE IN ANY WINDOW** — CASHCAT 1,544 zeros and 6
nulls before and after, PONS 11,398 and 88, and so on for all six. That is the
arithmetic check that the change is a rescaling of the top and not a different
population: `max(shares) = 0` exactly when `mean(shares) = 0`, and a null stays null.

**The small gap between "at 1/n before" and "at 1.0 after" is a real distinction the
mean could not draw** — 168 against 167 on CASHCAT, 119 against 116 on CHUMP. A mean of
exactly 1/n only requires the shares to SUM to 1; those one-to-three wallets per window
split their buying across two pre-pump windows. **Under the mean they were
indistinguishable from a wallet that put everything into one pump; under the maximum
they are not.** That is the metric doing what it was changed to do.

**Ranks move a great deal and the CUT barely moves, which is the important pair:**

| window | wallets whose metric changed | rank changed | by >10 places | cutoff before → after | Δ |
|---|---|---|---|---|---|
| CASHCAT-P1 | 695 of 2,245 | 2,225 | 1,816 | 0.314241 → 0.314447 | +0.000207 |
| CHUMP-P1 | 172 of 523 | 494 | 387 | 0.223885 → 0.237342 | **+0.013457** |
| AI-P1 | 268 of 3,508 | 3,462 | 1,818 | 0.264115 → 0.264204 | +0.000089 |
| PONS-P1 | 2,337 of 13,823 | 13,671 | 13,192 | 0.441729 → 0.442986 | +0.001256 |
| INDEX-P1 | 1,545 of 3,316 | 3,301 | 3,157 | 0.306923 → 0.314048 | +0.007125 |
| INDEX-P2 | 760 of 4,267 | 4,242 | 4,030 | 0.332679 → 0.339276 | +0.006597 |

**Nearly every wallet's RANK changes while almost none of them changed value**, and
that is not a contradiction: when 2,337 PONS wallets rise, every wallet below them is
pushed down a place. **A rank-change count is a poor measure of a scoring change's
impact.** The cutoff is the figure that decides anything, and it moves in the fourth
decimal on three windows and the second on CHUMP.

**CHUMP moves most, and it is the token this document predicted would.** Its pumps sit
at or after the window end so every cohort member's answer came from pump 1 alone,
halved by a divisor of 2 — the largest systematic understatement of the six.

**THE WATCHLIST: 99 memberships in, 99 out, and the prediction matched the rebuild
exactly.** Per window the predicted enters/leaves were CASHCAT 8, CHUMP 7, AI 2,
PONS 49, INDEX-P1 19, INDEX-P2 14, and the actual rebuild produced **the identical
numbers**, checked against a snapshot of the pre-change list:

```
memberships   1,388 -> 1,388     (slots are fixed by cohort size, so in == out)
rows entering      99            rows leaving  99
DISTINCT WALLETS  1,289 -> 1,281  84 wallets ENTER the list, 92 LEAVE
wallets on 2+ tokens  70 -> 77
```

**84 in against 92 out reconciles with 99 in against 99 out because the list is a
UNION.** A membership entering for a wallet already on the list through another window
adds no wallet, and a membership leaving a wallet that still holds another window
removes none. **Only the 84 and the 92 reach the alert** — that is the whole
consequence of this change to anything downstream.

**Wallets qualifying on two or more tokens rose from 70 to 77**, which by step 17's own
reasoning is the list improving: that overlap is the one signal it carries that does not
depend on scores being comparable across windows.

##### NO OTHER METRIC HAS THIS SHAPE — checked against the stored values, not argued

A metric bounded by a count of configured inputs rather than by the behaviour it
measures. Every metric was checked against its attained range per window:

| metric | attained max across the six windows | count-bounded? |
|---|---|---|
| **5 `prePumpShare`** | **1.0 on all six** | **was 1/n_pumps; FIXED** |
| 6 `buySizeTrend` | 0.8403, 0.8845, 0.8945, 0.9738, 0.9868, 0.9999 | **no** — nowhere near 1/2 or 1/3 |
| 3 `earliness` | 0.99990 – 0.99999 | no — bounded by the window, and reaches it |
| 1a/1b/2/4/7 (min-max) | raw values unbounded; normalised 0..1 by cohort | by the COHORT, by design |

**Metric 6 averages over pumps exactly as metric 5 did, and is NOT bounded by 1/n,
because its per-pump denominators OVERLAP.** Each pump's figure weighs every buy from
inception to that pump, so a buy counts toward every later pump's term rather than
being partitioned between them; each term independently reaches 1, and so does their
mean. **The disjointness, not the averaging, was what created metric 5's ceiling** —
and that distinction is why "metric 6 averages too" is not a second instance of this
defect. Its shifting denominator remains recorded in step 13 as the separate property
it is.

**The min-max five are bounded by the cohort rather than by behaviour, and that IS by
design and already stated** — step 13 chooses min-max so outliers dominate, and step 17
says at length that scores are therefore not comparable across windows. Reported here
because the question was asked, not as a new finding.

**ONE THING FOUND WHILE LOOKING, NOT FIXED IN THIS PASS: metric 6 is nearly degenerate
on PONS.** Its `buySizeTrend` spans **0.99826 to 0.99990** across 13,734 wallets — a
range of 0.0016 on a metric carrying 5% of the weight, so it separates essentially
nobody there. The cause is structural rather than a defect in the aggregation: PONS's
pumps sit far from its inception, so `closeness` is near 1 for almost every buy. It is
not the 1/n shape and it is recorded rather than acted on.

---

### Step 14 — Dashboard

**Does:** renders the token alongside the others.
**Stops:** no.

**A tracked token with no rows yet is shown, but never first.** The page opens
on the first token it is given, and a token's `tokens` row is written by the
identity phase -- long before its cohort exists. Loading AI therefore made the
landing tab an empty token, which the DOM harness caught as "rendered zero wallet
rows" on a 4.92 MB page. Tokens are ordered by whether they have any rows, which
keeps the default view populated without hiding anything or naming a token in the
page.

**A role added in one place is honoured in one place.** `tokens.role` was added
for the dashboard and the price monitor was not changed with it, so NVDA stayed
in that monitor's token list, had no pool with a recognised quote at the
liquidity floor, and failed and alerted every minute. **Every reader of a table
is a caller of the rule.** When a column decides what something is, grep for the
table before assuming the change is done.

**A token loaded only to price another is not a tracked token.** `tokens.role`
records which it is: `tracked` for a token with a window and a cohort, and
`pricing-source` for a bridge asset loaded solely so another token can be priced
through it. A pricing source has no window, no cohort and no rows, and the
dashboard filters on the role rather than on a name the page knows.

NVDA is the first. Loading it far enough to derive its own USD series put a row
in `tokens`, and that row was immediately a dashboard tab for a token nobody is
tracking, with nothing in it. **Every future bridge does the same**, which is why
the distinction lives in the data.

**A new chain needs entries in the explorer table and in the price adapter's
pricing-quote set.** Both were Solana-only once, and both failed silently: a
Solscan URL built from a hex address resolves to nothing without an error, and a
Solana-only quote set rejected every Robinhood pool, so the token was never
priced while the monitor still reported success. **A chain absent from the
explorer table gets no link rather than a guessed one.**

**The page must not embed transaction rows.** 191,728 rows produced a 69.3 MB
page. Wallet totals are computed in SQL and a wallet's transactions come from
`/api/token-txs` on expansion — 4.22 MB before scores, 4.92 MB with scores and
flags.

**Average cost excludes unpriced rows from BOTH sides.** Keeping their tokens in
the denominator while their dollars are absent understates exactly the wallets
whose data is weakest. A wallet with no priced row has an **unknown** average
cost, not zero. Unknown average gives unknown change, never 0%.

**The header and every Change cell read one price row per render.** Reading it
separately per consumer is the paired-baseline defect, and it is invisible: both
numbers look right alone.

**Verify by executing the served page in a DOM and counting what renders.** A
green build proves the page compiles and ships, and nothing about whether the
table has rows in it. That harness has twice caught a fault in itself rather than
the page — read its output accordingly.

---

### Step 15 — Hourly updates

**Does:** advances the token's rows from a cursor toward the head, one bounded
slice per run.
**Costs:** ~430 CU typical, ~714 busy — about $0.14–$0.23 a month per token.
**Stops:** no; it alerts.

**The cursor is the only progress state, and it advances in the same transaction
that writes the rows.** A run that dies leaves it where it was and the next run
re-reads that range; re-reading is safe because the row key is unique, and
skipping is impossible because the cursor never passes uncommitted data.

**What the rejected rule actually cost, measured.** Over the 1,757,870 blocks
the job covered in 47 cycles (54,935,280–56,693,149), replaying the same code
path with the payment test removed:

```
buy rows the correct rule produces   1,410
buy rows actually written            1,069
DROPPED                                191   13.5%, across 82 distinct wallets
sell rows produced / written    1,662 / 1,511
SELLS DROPPED                            0   <- the control
```

**Sells are never payment-tested, so a non-zero sell figure means the comparison
is wrong rather than the job.** It caught two errors before the buy number was
believed: counting every tag on the token instead of the job's `cohort_tags`,
and comparing raw `tradeLegs` output against written rows so that `buildRows`'
floors read as losses. Any future version of this comparison keeps that control.

**The 191 are recoverable and nothing needs deleting.** `wallet_transactions`
has a unique key over the event and the insert is `on conflict do nothing`, so
re-running from an earlier cursor inserts only what is missing. Cost is one
re-read of the range, ~14,640 CU / **$0.007**, plus nothing for payment.

**THE HOURLY JOB WRITES TRADES AND TRANSFERS. It used to write only trades.**
The intake calls `buildTransferRows`; the adapter called `buildRows` alone, so a
token's `transfer_in`/`transfer_out` coverage stopped dead where its intake
stopped while buys and sells kept arriving. AI's backlog held **13,893 trade rows
and zero transfers**; rebuilding the same range produced **12,608 transfers** the
job had never written.

That was never cosmetic. `inflated-pnl` flags a wallet whose sales exceed its
purchases, and the acquisition that explains it is usually a transfer — so **the
flag drifted further from the truth every hour the job ran**, on every token.
The adapter now runs `tradeLegs` once, hands the legs to `buildTransferRows`, and
returns both row kinds as one record set.

**Rows already written before this fix are still missing their transfers.** The
job only advances forward; closing the gap for a token means a scoped reinsert
over the blocks its hourly job covered, exactly as AI's repair did.

**COPYING SWAPS COSTS TIMESTAMPS LATER.** `v4_swaps_all` carries no
`blockTimestamp`, so a copied swap in a block with no swept transfer has no time
and the row writer refuses it. AI needed **7,945 blocks filled at 158,900 CU
($0.07)** before its reinsert would run — more than the swap copy saved. Copying
is still right; just carry the timestamp cost in the estimate.

**The hourly job and the intake share ONE buy rule, and a change to one is a
change to both.** The hourly job is not a simplified version of the intake — it
runs the same `tradeLegs`, so whatever decides who bought during a load also
decides it every hour afterwards. This is why a rejected rule kept running: the
payment check was measured wrong against 40 decoded transactions, and the
scheduled job went on applying it to every hour it advanced, writing an
incomplete set of buys with nothing raised. Whenever the definition of a buy
moves, both callers move with it, and the hourly job is re-run from a cursor
early enough to cover what the old rule dropped.

**A LOADED TOKEN WITHOUT A MONITOR MUST NOT LOOK COMPLETE.** The intake writes
rows up to wherever it swept and stops; nothing in it required a monitor, so a
token could pass every phase, score, and render on the dashboard while never
advancing again. **AI did exactly that — loaded, scored, verified, and then
26,883,347 blocks behind head a month later, with no error anywhere because
there was no error to raise.** The write phase now refuses to run for a token
with no monitor, and names the file to add.

It cannot CREATE one: monitors are YAML in the repository, read at boot, and a
file written by a container survives neither the container nor git. So the gate
is the other half — fail loudly, before the rows are written, while the operator
is still there.

**The monitor's pricing values must MATCH the intake config, and the gate checks
them.** Copying another token's monitor is the natural shortcut and is silently
wrong: `bucket_origin` from the wrong token matches no stored bucket and prices
every row null, and a missing `bridge_assets` drops every pool quoted in that
bridge. PONS and INDEX share 8,963,150; **AI's is 9,721,433** and a copy would
have been wrong.

**The hourly job must DERIVE each bridge forward, not merely load it.** It
derived the token's own series every cycle and left the bridge series exactly
where the intake stopped, so once the cursor passed the bridge's last bucket
every bridge-quoted row priced null. **AI's backlog wrote 5,033 NVDA-quoted rows
and priced one** — the boundary bucket — while all 672 cycles reported success.
The bridge's swaps are not the token's, so they are swept per slice from its own
in-scope pools: one `eth_getLogs` per venue per slice.

**A STALE SERIES IS NOT A PRESENT ONE.** Checking only that the loaded map is
non-empty passes a series that ends before the slice begins, which is exactly how
those 5,032 nulls were written with nothing raised. The job now fails when a
bridge's last bucket falls behind the slice it is pricing. **Every "is it there"
check on a series needs to be "does it reach here".**

**The hourly job must load the bridge series too.** `counterUsdResolver` takes
`bridgeUsd` as an optional third argument and the adapter omitted it, so every
bridge-quoted pool priced null on every hourly run while the intake priced the
same pools correctly. The config parser read `bridge_assets` and always had, so
the option was accepted and silently did nothing — worse than not supporting it.
On AI that is 80% of its volume. The adapter now loads the series and **raises if
a bridge is configured and no series exists for it**.

**Seed the cursor where the intake stopped, never at the head.** Seeding at the
head skips the backlog permanently and silently.

**Lag the head.** ~200 blocks, so a reorg at the tip cannot strand rows. This
chain's actual reorg depth has not been measured — the figure is a margin, not a
finding.

**What fails a run and what does not:** an unreadable range fails; a pool
enumeration failure fails; the CU ceiling fails. A price-derivation failure does
**not** fail — rows are written with a null USD, which is honest and
recoverable, and the count is reported.

---

### Step 16 — Findings

**A FINDINGS SECTION RECORDS WHAT WAS TRUE AT LOAD. Current counts live in
section 0 and nowhere else.** Three findings sections carried row counts that
read as current and were stale within the hour, because the hourly job never
stops adding rows. Write "at load" or do not write the number.

**Append this token's section to the findings at the end of this document before
calling it done.** What surprised you, what the numbers were, what turned out not
to be true. That is what the next token reads.

---

### Step 17 — The watchlist and its alert

**Does:** cuts the top N% of every scored window into one cross-token wallet
list, watches those wallets trade **any** token on the chain, and alerts
aggregated by token.
**Costs:** the watchlist is free — it reads `wallet_scores`. The watcher spends;
see below.
**Produces:** `wallet_watchlist`, `watchlist_activity`.
**Stops:** yes — the watchlist is reviewed before the watcher is built, because
the cut decides everything the watcher spends money on.

**This is what the whole system is for.** Every step before it answers "what did
this cohort do with this token". This one inverts that: it asks what the wallets
worth watching are doing *now*, anywhere. It was built last and belongs in this
document first.

#### The cut is a config value, not a constant

`watchlist.top_percent`, default **0.05**. It is not measured and there is no
natural break in the data to measure it against — it is an operator preference
and will be tuned. Measured sensitivity on the four scored windows, merged:

| cut | qualifying rows | distinct wallets |
|---|---|---|
| 1% | 253 | 246 |
| 2% | 501 | 483 |
| **5%** | **1,248** | **1,176** |
| 10% | 2,493 | 2,354 |

Per window, at 5%, **as measured on 2026-09-12, BEFORE the ETH/USD fix** — kept
because the INDEX-P1 figures are what the artefact looked like, and the corrected
figures are in the "artefact is gone" block below:

| window | cohort | top 5% | score at cutoff | max | median |
|---|---|---|---|---|---|
| `AI-P1` | 3,508 | 176 | **0.264357** | 0.757349 | 0.157199 |
| `INDEX-P1` | 3,316 | 166 | **0.668889** | 0.832810 | 0.250994 |
| `INDEX-P2` | 4,267 | 214 | **0.337093** | 0.640614 | 0.260233 |
| `PONS-P1` | 13,823 | 692 | **0.449739** | 0.602470 | 0.344013 |

#### SCORES ARE NOT COMPARABLE ACROSS WINDOWS, AND THE 5% CUT PROVES IT

State this wherever the merged list is used. Three measurements, each sufficient
on its own:

1. **`INDEX-P1`'s 5% cutoff, 0.6689, is above `PONS-P1`'s MAXIMUM of 0.6025 and
   above `INDEX-P2`'s maximum of 0.6406.** No PONS wallet would clear INDEX-P1's
   bar, and every INDEX-P1 qualifier would top the PONS list.
2. **`AI-P1`'s cutoff, 0.2644, is below `PONS-P1`'s MEDIAN of 0.3440.** The same
   "top 5%" label selects an élite in one window and an average wallet in
   another.
3. Each metric is **min-maxed within its own cohort** (step 13), so a score is a
   rank-like position inside one window and carries no cross-window meaning. The
   quality thresholds are per-window too — `low-weight` derived to 0.625 for
   INDEX-P1 and could not be derived for INDEX-P2.

**`INDEX-P1`'s top 5% WAS an artefact, and it is the clearest case.** (Fixed
2026-09-13; the mechanism is kept because it will recur on any window whose era is
unpriced.) All **166 of
166** are flagged `low-weight`, with a **median `weight_used` of 0.300** — every
one of them is scored on 30% of the weight. The cause is known: INDEX-P1 spans
blocks 1,693,406–9,800,208, which is exactly the era where 6,052 INDEX rows have
no USD (step 10 and the INDEX findings). The money metrics are null, they drop
out, the weights renormalise, and a wallet ranked on earliness and hold time
alone scores **higher than any fully-weighted wallet on any token** — INDEX-P1
holds the highest maximum of all four windows at 0.8328 on 30% of the weight.

The weight distributions, which is where this is visible:

```
AI-P1      3,490 at 1.000    5 at 0.300     1 at 0.950    12 at 0 (null score)
INDEX-P1   2,277 at 1.000  1,019 at 0.300   16 at 0.950    4 at 0
INDEX-P2   4,259 at 1.000                                  8 at 0
PONS-P1   13,732 at 1.000      2 at 0.875    1 at 0.825   88 at 0
```

**So the cut is per window and the merge is a union, never a re-ranking.** Do not
sort the merged list by score, do not take a global top N%, and do not present a
cross-token ranking. The list is "qualified somewhere", and each membership row
keeps the window it qualified under and the score it had there.

#### A null score must never rank first

`order by score desc` in Postgres is `NULLS FIRST`. Under the default ordering
the null-score wallets occupy ranks 1..n of every window — PONS's **88 nulls take
ranks 1–88** of 13,823, AI's 12 take 1–12 — so they would fill 12.7% of PONS's
692-wallet allocation and displace 88 genuine top scorers. The cut is taken
**`order by score desc nulls last`**, and the difference is visible in the
cutoff: PONS 0.449739 correct against 0.450131 defaulted, AI 0.264357 against
0.264943.

A null score means every metric was null (`weight_used = 0`, and the counts match
exactly: 12 / 4 / 8 / 88). Such a wallet is not a top wallet; it is an unmeasured
one.

#### Wallets that qualify more than once, and flagged wallets

A wallet is **on the list once**, with one membership row per window it qualified
under. 1,248 qualifying rows collapse to **1,176 distinct wallets**: 1,110
qualify in one window, **60 in two, 6 in three**. Every overlap is cross-token —
**no wallet is in both INDEX windows' top 5%** — so the pairs are:

```
AI-P1    + PONS-P1     32        INDEX-P1 + PONS-P1      3
INDEX-P2 + PONS-P1     25        AI-P1    + INDEX-P1     1
AI-P1    + INDEX-P2    17
```

Qualifying twice is the strongest signal the list carries, because it is the one
comparison that does not depend on scores being comparable: it says the wallet was
in the top slice of two independently-built cohorts.

**Flagged wallets are kept and labelled, never dropped.** Of the 1,176: **169
carry `low-weight` somewhere, 148 carry `inflated-pnl` somewhere, and 884 are
unflagged in every window they qualified under.** Dropping them would be wrong in
both directions — `inflated-pnl` usually means a transfer has not been collected
yet rather than that the wallet is uninteresting, and it clears itself once the
missing side arrives (step 13). `low-weight` is a statement about our data, not
about the wallet. But 166 of the 169 low-weight entries are INDEX-P1, so a list
that did not carry the flag would present that window's artefact as signal.

#### Where the rebuild belongs: inside the scoring monitor

**Alongside scoring, in `wallet-scores`, not as its own monitor.** The watchlist
is a membership derived entirely from `wallet_scores`, and step 13's own
reasoning applies unchanged: it has no cursor, it reads the database only, and it
must cover every window rather than every token. Three further reasons:

- **It changes exactly when scores change and at no other time.** A separate
  schedule would either trail the scores or recompute an unchanged list.
- **A separate monitor could read `wallet_scores` mid-rewrite.** Scoring deletes
  orphans and re-asserts rows inside one transaction; a reader on its own clock
  can land in the middle of that.
- **The three-table lesson says the removal path belongs in the write.** A wallet
  that drops out of a top 5% must drop off the watchlist, and the place that
  cannot forget is the run that moved the score.

**The watcher is a separate monitor, for the opposite reason.** It is
cursor-driven and it spends compute units, and step 13 is explicit that coupling
a database-only job to one that spends means a ceiling or a rate limit stops
scoring too. `wallet-scores` stays free; the watcher carries its own ceiling.

#### Built and verified 2026-09-12

`wallet_watchlist` keys `(chain, wallet, token, tag)` — one membership row per
window a wallet qualified under, carrying the score, its rank, the cohort size,
the slot count, the weight the score rests on, the flags, and the `top_percent`
the cut was taken at. Rebuilt inside `wallet-scores`, after every window scored.

As stored, read back on a fresh connection after an unattended monitor run:

| window | cohort | slots | admitted | cutoff | max | low-weight | inflated-pnl |
|---|---|---|---|---|---|---|---|
| `AI-P1` | 3,508 | 176 | 176 | 0.264308 | 0.757357 | 3 | 71 |
| `INDEX-P1` | 3,316 | 166 | 166 | 0.668896 | 0.832810 | **166** | 0 |
| `INDEX-P2` | 4,267 | 214 | 214 | 0.337066 | 0.640592 | 0 | 2 |
| `PONS-P1` | 13,823 | 692 | 692 | 0.449285 | 0.602471 | 0 | 78 |

**1,248 rows, 1,176 distinct wallets, 66 in two or more windows — all of them
cross-token — and 0 null scores admitted.** Slots equal admitted in every window.
Invariants checked and all zero: memberships with no matching score row **0**,
with no matching tag **0**, with a rank above their slot count **0**, and exactly
**1** distinct `top_percent` value stored.

**THE INDEX-P1 ARTEFACT IS GONE, 2026-09-13.** Fixing the ETH/USD derivation
removed the cause rather than masking it, and the effect on the cut is large:

| `INDEX-P1` top 5% | before | after |
|---|---|---|
| flagged `low-weight` | **166 of 166** | **0 of 166** |
| score at cutoff | 0.668896 | **0.324779** |
| maximum score | 0.832810 | **0.530007** |
| `low-weight` threshold | derived 0.625 | 0.8, **cannot be derived** — no partial weights left |

Its cutoff now sits in the same band as every other window — AI 0.2642, INDEX-P1
0.3248, INDEX-P2 0.3429, PONS 0.4472 — where before it was above two windows'
maxima. **The formal warning still stands: min-max is within a cohort and the cut
is still per window.** What changed is that the pathological case is gone, so the
merged list no longer carries 166 wallets selected by missing data.

**The merged list changed accordingly:** 1,248 memberships still (slots are fixed
by cohort size) but **100 added and 100 removed — 8% churn**; distinct wallets
**1,176 → 1,151**; and wallets qualifying in two or more windows **66 → 85**, of
which 69 span two or more tokens. More multi-window qualifiers is the list getting
better: that overlap is the one signal in it that does not depend on scores being
comparable.

**The figures move every cycle, and that is correct.** Between an ad-hoc query and
the monitor's own run twenty minutes later the cutoffs shifted in the fourth
decimal (AI 0.264357 → 0.264308, PONS 0.449739 → 0.449285) and the two-window
count went 67 → 66, because the hourly jobs add rows and every score is
recomputed. A watchlist figure is a snapshot of a moving cut, never a constant.

**Wall-clock: the rebuild adds ~70 s to the scoring monitor.** The nine runs
before it shipped ran 9,142–11,926 ms; the first run with it took **80,901 ms**.
One sample, so treat the 70 s as provisional, but it moves `wallet-scores` from
"seconds" into "about a minute" and the expectation table should read that way.

---

**Everything below this line is DESIGN, not measurement. It is recorded before
the watcher is built, and every figure in it is an estimate that the first real
run must replace.**

#### What is watched, and what wallet-first changes

Those wallets' buys and sells of **any** token, not only the tokens they were
scored on. Three things change, and none is cosmetic:

1. **The filter inverts.** Every sweep so far fixes the token and lets the
   wallets vary: `address = <token>, topic0 = Transfer`. This fixes the wallets
   and lets the token vary: `address` unset, `topic0 = Transfer`, and the wallet
   set in `topics[1]` (sent) or `topics[2]` (received). That is **two filters per
   wallet chunk**, and the chunk rule from step 5 applies — a 540-entry topic
   array is accepted and 5,024 hangs, so **chunk at 500**. 1,176 wallets is 3
   chunks, so **6 filters per slice**.
2. **There is no pool set.** The trade definition in step 11 requires the
   counterparty to be an in-scope pool, and `pool_meta` exists only for tracked
   tokens. For an arbitrary token it does not, so the counterparty has to be
   classified: the **v4 PoolManager is a single known address** and covers every
   v4 trade, while a v3 pool must be identified by `token0()`/`token1()` exactly
   as step 3 defines it — 52 CU per novel address, **cached in a table so each is
   asked once**. A revert is the answer, not a failure.
3. **"In a transaction containing a Swap" is not "traded".** Step 11 records that
   this conflation produced a wrong count of 34,744. The counterparty test above
   is what keeps this honest; transaction-level co-occurrence alone must not be
   used.

#### What is stored

`watchlist_activity`, one row per movement: wallet, token, side, token amount,
USD amount, block, block time, transaction hash, log index. The unique key
follows step 12 — `(chain, tx_hash, wallet, token, side, counterparty,
log_index)` with `NULLS NOT DISTINCT` — for the reasons that key already records.

**USD will be null far more often here than anywhere else in this system, and
that is honest rather than broken.** A watchlist token usually has no price
series: there is no `<token>_usd_prices` table for it, no bucket grid, and no
in-scope pool set. USD is derivable only where the counter asset is itself
priceable — USDG resolves to 1, and WETH or native ETH resolve through
`native_usd_prices`, which is chain-level. So a trade against a stablecoin or ETH
gets a USD figure and everything else gets **null, never zero**. Token amount and
decimals are always recorded, so a null USD row is still a complete record of
what moved. **The expected null share is unmeasured; the first run reports it.**

#### The alert

**Aggregated by token, never per wallet.** One line per token: token, wallets
that bought, wallets that sold, total token amount, total USD. Nothing
per-wallet in the alert — the per-wallet detail is the stored record and a later
dashboard tab.

Proposed channel **`crypto_early`** and cadence **30 minutes**. The channel
because this is early-signal wallet activity rather than a system event, and
`system` is reserved for failure and recovery alerts. 30 minutes because it
matches the scoring monitor's period, so the watchlist a run uses is never more
than one scoring cycle stale.

**An empty period sends nothing.** A "0 wallets traded" message every 30 minutes
trains the reader to ignore the channel, and the run still records its cycle so
silence is distinguishable from a dead monitor by looking at `monitor_runs`
rather than at Discord. A **failure** alerts on `system` as every other monitor
does.

#### The pool-side test for an ARBITRARY token

Step 11 defines a trade as a transfer whose counterparty is a pool, **inside a
transaction containing a `Swap` on that pool**. Both halves are kept here. The
weaker "was in a transaction containing a Swap" is NOT used — that conflation
produced a wrong count of 34,744 once, and a watchlist wallet's transfer sits in
transactions full of unrelated hops.

`pool_meta` exists only for tracked tokens, so the counterparty is classified from
the chain and cached. **Both venues, by the step 3 definition:**

| venue | the counterparty is | classified by | cost |
|---|---|---|---|
| v4 | the **PoolManager**, one known address, for every v4 pool | the `Swap` log in the same transaction carries the pool id; that id's `Initialize` gives its two currencies | one sparse `eth_getLogs` per novel pool id, 60 CU |
| v3 | the pool contract itself | `token0()` and `token1()` — a revert is the answer, not a failure | two `eth_call`, 52 CU per novel address |

**A v4 transfer cannot name its own pool.** The PoolManager is the counterparty for
every v4 pool, so the transfer alone cannot say which pool traded — the `Swap` log
in the transaction is the only thing that can. That is why the Swap half is
structural here rather than a redundant check: for v4 it supplies the pool
identity, and the currency test then confirms the token actually belongs to it.

**Both caches are permanent.** A pool is a pool for good (step 7: pool-ness is
checked at the enumeration head, not per moment), so a classification is asked once
per address or pool id and never again. The first run pays for the set the
watchlist touches; later runs pay only for pools that are new to it.

#### USD for a token with no price series

**Most tokens a watchlist wallet touches have no series, no grid and no in-scope
pool set**, so the honest answer is often null. It is never zero.

Where the trade's pool pairs the token with a **recognised pricing asset**, USD is
derivable from the counter side without any series for the token itself: USDG
resolves to 1, and WETH or native ETH resolve through `native_usd_prices`, which is
chain-level and now market-derived. The `Swap` log carries both amounts, and the
counter asset's decimals are read once and cached like the pool classification.

**The watcher looks up the nearest PRECEDING native bucket, not the exact bucket,
and that is a deliberate departure.** Everywhere else in this document an
exact-bucket lookup is required, because a token's rows live on that token's fixed
grid and a mismatch prices everything null. The watcher has no such grid: it prices
arbitrary tokens, and `native_usd_prices` holds two interleaved residues (3150 and
1433, section 9). Taking the greatest bucket at or below the trade's block, within
one bucket width, reads whichever grid is nearer instead of missing both. **This is
a signal feed, not the accounting record** — `wallet_transactions` keeps the
exact-bucket discipline. Stated here so it is a choice rather than a bug someone
finds later.

#### Cost per run — ESTIMATE, and what must be measured first

```
transfer filters   6 per slice (3 wallet chunks x 2 directions)
                   x ceil(slice_blocks / span) x 60 CU
v3 counterparty    52 CU per NOVEL address, cached; high on the first run,
classification     approaching zero afterwards
```

At a 40,000-block slice and one request per filter, that is **360 CU per run, ~$0.00016** — but the span
depends on a density nobody has measured, and **this document records twice that
a density assumed from the wrong population was wrong by 16x and by 27%.** A
wallet-keyed filter across all tokens has no measured density at all.

#### BUILT AND MEASURED 2026-09-13

**Density, probed near head before anything was swept** — 6 samples of 20,000
blocks, 120,000 blocks total, `watch-probe`, 2,170 CU / $0.00098:

```
transfer logs matching the watchlist   3,179
logs per block                      0.026492   range 330-828 per 20,000 blocks
natural span at the 6,000-log target 226,486 blocks
```

**The 100,000-block cap binds, not density.** That is the opposite of every other
sweep here: a wallet-keyed filter across all tokens is *sparse*, so the slice size
is limited by the endpoint rather than by log volume, and the request count is
**6 per slice — 3 wallet chunks x 2 directions — whatever the slice size.**

**Measured cost per run, first run and steady state:**

```
transfer filters, 6 requests                        360 CU
Swap filters, v4 PoolManager + v3 addresses     ~120-240 CU
                                                 ---------
steady state                                    ~500-600 CU   ~$0.00025/run
                                                              ~$0.35/month at 48/day

first run, additionally: 104 pool classifications and 67 decimals reads
measured total for a run with that backlog        1,134 CU     $0.00051
```

**Wall-clock: 40.3 s on the first run, 15.3 s on the second.** The difference is the
classification backlog, which does not recur.

**What it found, first 20,000-block slice (61,554,943–61,574,942):**

```
transfers matching a watchlist wallet    1,193
candidates (a wallet side + a counterparty) 1,178
TRADES                                     189    190 stored across two runs
  wallet-to-wallet, skipped                   0
  rejected: counterparty not a pool         932
  rejected: no Swap on that pool             57
  rejected: token not in that pool            0
tokens                                      67    63 of them UNTRACKED
wallets                                     54    of 1,151 watched
buys 113   sells 77
pools classified: 78 v4, 26 v3, 65 not-a-pool (negatives cached too)
decimals: 67 tokens, 67 readable, 0 unreadable
```

**932 of 1,178 candidates rejected for having a non-pool counterparty is the test
doing its job, not a loss.** A watchlist wallet's transfers are mostly not trades —
they are funding, routing hops and wallet-to-wallet movement. The weaker
"transaction contained a Swap" test would have admitted a large share of those 932.

**63 of 67 tokens are outside the pipeline**, which is the point of the inversion:
179 of 190 rows are activity on tokens no cohort was ever built for.

#### USD: 75 of 189 priced, and the two reasons for the rest

```
priced                                                      75
null: counter asset is not a recognised pricing asset       45   expected, by design
null: no ETH/USD bucket within one bucket width             69   FIXABLE, see below
```

**THE WATCHER OUTRUNS THE ETH/USD SERIES, and that is the bigger half of the
nulls.** `native_usd_prices` reaches 61,553,150 because the hourly job derives it
and runs an hour behind; the watcher read to 61,574,942, **21,792 blocks past the
series** — more than two bucket widths — so nothing in that region can price. This
is step 15's "a stale series is not a present one" appearing from the other
direction: not a series that ends before a slice, but a slice that starts after the
series.

**IT GETS WORSE THE LONGER IT RUNS, and the second slice proved it.** The series
head has not moved since 61,553,150 while the watcher advanced to 61,585,390 — now
**3.2 bucket widths ahead**. The first slice priced 75 of 189 rows; the second
priced **1 of 42**:

| slice | blocks past the series | priced | unpriced |
|---|---|---|---|
| 61,554,943–61,574,942 | 21,792 (2.2 buckets) | 75 of 189 | 114 |
| 61,574,943–61,585,390 | 32,240 (3.2 buckets) | **1 of 42** | 41 |

This is not a fixed 36% tax. **The watcher drifts away from the series at the rate
the chain produces blocks, and every hour it runs unaided the priced share falls.**
An alert reading "$4 priced" on 42 trades is not a screener.

**IMPLEMENTED 2026-09-13: the watcher derives ETH/USD for its own slice, in memory.**
The cause is gone, not reduced:

| slice | derivation | trades | priced | share |
|---|---|---|---|---|
| 61,554,943–61,574,942 | stored series only | 190 | 76 | 40.0% |
| 61,574,943–61,585,390 | stored series only | 42 | 1 | **2.4%** |
| 61,585,391–61,595,492 | **slice derivation** | 71 | **48** | **67.6%** |

**The "no ETH/USD bucket" reason is now ZERO.** All 23 remaining nulls on the third
slice are `counter asset is not a recognised pricing asset`, which is the irreducible
category — a token traded against another memecoin has no USD route at any price.

The derivation itself, per run: **2 buckets from 8,220 ticks, 0 discarded by the 10x
fence** — the soundness signal step 10 names — in **3 requests**. It read
$2,524.13 and $2,522.65, consistent with the $2,480.88 the PONS series and
DexScreener agreed on to 0.3%.

**`native_usd_prices` was not touched**: its head is still 61,553,150 and its three
provenances still hold 9,655 / 489 / 18 buckets. The ownership rule held.

#### THE SLICE ENDS ON A WHOLE BUCKET BOUNDARY — decided 2026-09-13

**The watcher never derives a partial bucket.** An earlier version clamped the
derivation's sweep to head, which left the trailing bucket incomplete and derived it
anyway from whatever ticks existed. That was recorded here as a deliberate narrowing
of step 10's "only whole buckets are written". **The narrowing is withdrawn.** Step
10's rule is absolute and needs no amendment: the fix belongs in what the watcher
READS, not in what the rule allows.

**The slice is capped at the last whole bucket boundary at or below `head - lag`:**

```
lag      = head_lag (200)
safe     = head - lag                      the last block we are willing to read
boundary = bucketOf(safe + 1, size, origin) - 1
from     = cursor + 1   (or boundary - slice + 1 with no cursor)
to       = min(from + slice - 1, boundary)
if to < from  ->  nothing to advance; report and exit without sweeping
```

`boundary` is the last block of the last COMPLETE bucket at or below `safe`. The
`safe + 1` form handles the exact-boundary case without a branch: at
`safe = 61,595,692` it yields 61,593,149 — stop before the incomplete bucket
61,593,150 — and at `safe = 61,593,149` it yields 61,593,149 itself.

**Three consequences, and the third is the cost:**

1. **Every bucket the derivation sees is whole, by construction.** `to` is a bucket
   end, so the sweep range `bucketOf(from) .. to` contains only complete buckets. No
   clamp to head is needed and `partial_buckets` can never be non-zero — which is why
   it was removed from the run log rather than left reporting a constant zero.
2. **The slice self-aligns.** After one run the cursor sits on a bucket end, so every
   later slice starts on a bucket start and ends on a bucket end.
3. **The watcher now lags head by up to one bucket width.** 10,000 blocks at 35,622
   blocks/hour is **16.8 minutes**, against ~0.3 minutes under the old clamp. Blocks
   past the boundary are not read this run; the cursor stops there and the next run
   picks them up once their bucket completes. At a 30-minute cadence that sits inside
   one cycle, but **the alert is now up to ~17 minutes stale and that is the price
   paid for never pricing from a fraction of a bucket.**

**A slice with no ETH/USD ticks at all raises.** The market has 52 trading pools with
thousands of ticks per bucket, so an empty derivation is a defect rather than a quiet
market — the filter-matched-nothing rule applied to this job.

**The options as they stood, kept because the reasoning is the reusable part.** The
first three each trade something real away; the fourth did not:

| option | effect |
|---|---|
| **derive ETH/USD in memory, per slice** | **RECOMMENDED.** Every row prices, freshness is untouched, ~120 CU a run, and it persists nothing so the ownership rule holds |
| cap the slice at the series head + one bucket | every row prices, but the watcher lags an hour behind — the freshness a screener exists for |
| widen the lookup to several bucket widths | prices more rows by dating them further from the trade — invents precision |
| leave it | the priced share keeps falling; token amounts stay correct |

**Why deriving in memory is not a new ownership violation.** Step 10 says exactly
one monitor per chain *persists* `native_usd_prices` — `token-updates` owns it — and
that **every other monitor already derives the series in memory for its own slice
and persists nothing.** The watcher doing the same is the established pattern, not
an exception to it. The market's own pools are enumerated and cached
(`eth_usd_pools`), so a slice needs one v4 filter plus one v3 filter over its own
20,000 blocks: **two requests, ~120 CU, against the ~550 the run already spends.**

#### MEASURED 2026-09-14: is a market-cap-filtered buy alert buildable on this data?

**Asked as a measurement pass, nothing built.** `watchlist_activity` at the time held
**15,993 rows over 1,225 tokens and 547 wallets**, blocks 61,554,892–63,213,144,
2026-09-13 01:09:37Z to 2026-09-14 23:55:15Z. Section 0's "303 rows, 103 tokens" is
the figure from the day it was built and is two days stale — **current counts live in
section 0 and are re-read, never quoted from a findings block.**

**COVERAGE, over the 10,562 BUY rows (1,078 distinct tokens):**

| counter asset | buy rows | tokens | priced | unpriced |
|---|---|---|---|---|
| other token | 3,331 | 439 | **0** | 3,331 |
| native ETH | 3,240 | 427 | 3,189 | 51 |
| USDG | 2,352 | 213 | **2,352** | **0** |
| WETH | 1,639 | 175 | 1,628 | 11 |
| | **10,562** | | **7,169** | **3,393** |

Both sides reconcile exactly — 3,189 + 2,352 + 1,628 = 7,169 and
3,331 + 51 + 11 = 3,393 — so no row is unaccounted for.

**The null reasons, and the two that returned nothing are stated rather than omitted:**

```
counter asset is not a recognised pricing asset   3,331 rows / 439 tokens   98.2%
no ETH/USD bucket                                    62 rows /  30 tokens    1.8%
a buy row whose pool is not in chain_pool_cache       RETURNED NO ROWS
a USDG-COUNTER buy row left unpriced                  RETURNED NO ROWS
```

**USDG priced 2,352 of 2,352, which is the stablecoin rule holding exactly** — a
dollar resolves to 1 without consulting any series, so there is no mechanism by which
one can go null.

**THE 62 "no ETH/USD bucket" ROWS ARE ALL PRE-FIX, AND THAT CONFIRMS THE FIX RATHER
THAN CONTRADICTING IT.** They sit in blocks 61,564,885–61,585,150, 01:26–02:00 on
2026-09-13 — inside the first two slices recorded above, before the slice derivation
shipped. **None has recurred in the 1.66M blocks since.** This subsection nearly
recorded it as a live 62-row defect; the block range is what settled it, and an
"expected zero" that is non-zero must be dated before it is believed either way.

**A CHECK OF MINE CONTRADICTED ANOTHER AND THE CRUDER ONE WAS WRONG.** A late query
asking "is either currency USDG" found 250 unpriced rows where the per-counter
classification found none. All 250 are rows where **USDG is the TOKEN BEING BOUGHT**,
against counters like PONS, AI and FLYBRAIN — correctly unpriced under
"counter is not a pricing asset". Testing membership of the PAIR is not testing the
COUNTER, and section 7's rule applies: when a query disagrees with itself, suspect the
query.

**SUPPLY IS THE BINDING CONSTRAINT, AND IT IS ALMOST ENTIRELY ABSENT.**

```
distinct tokens in watchlist_activity            1,225
  with a stored totalSupply                          5   <- PONS, INDEX, AI, CASHCAT, NVDA
  NOVEL                                          1,220
tokens on the BUY side                           1,078
```

**`tokens` has no `total_supply` column** — step 12 records this and it is still true.
The only stored supply anywhere is `token_intake_state`'s identity report, which exists
for the six loaded tokens; CHUMP is the sixth and has no watchlist activity.

**Priced per bucket:** the market cap is derivable for **5 of 693** tokens bought on
2026-09-14. 441 are priced but have no supply, and 247 have neither.

**THE FIVE DERIVABLE MARKET CAPS ARE THREE ORDERS OF MAGNITUDE ABOVE BOTH THRESHOLDS**,
so at today's coverage $200,000 and $150,000 are the SAME filter — they partition the
visible set identically, because the smallest visible cap is 83x the larger threshold:

| token | supply | implied price | implied market cap (2026-09-14) |
|---|---|---|---|
| PONS | 1,000,000,000 | $0.5715 | **$571,540,107** |
| AI | 991,382,832.598 | $0.2425 | **$240,372,331** |
| CASHCAT | 1,000,000,000 | $0.1544 | **$154,385,172** |
| INDEX | 1,000,000,000 | $0.0313 | **$31,282,984** |
| NVDA | 78,589.647 | $212.07 | **$16,666,711** |

**THE SLICE-IMPLIED PRICE IS SOUND AS A LEVEL, AND THAT IS MEASURED RATHER THAN
ASSUMED — but only where it can be checked.** Against each token's own independently
derived series over the same block range:

| token | slice-implied | stored-series median | apart |
|---|---|---|---|
| PONS | $0.55362 | $0.56192 | **1.5%** |
| CASHCAT | $0.15496 | $0.16159 | 4.1% |
| AI | $0.24513 | $0.26508 | 7.5% |
| INDEX | $0.03022 | $0.02774 | **8.9%** |

All four sit inside the ~10% band section 1's tolerance treats as not changing a
decision, and PONS's per-row ratio median (0.55472) sits on its aggregate (0.55362),
so no degenerate row dominates. **The check is only available for the four tokens that
HAVE a series — the deepest on the chain. For the other 1,220 there is no independent
cross-check at any price.**

**WHAT THE FILTER WOULD HAVE SURFACED, and it is the wrong five.** The tokens whose
market cap is computable are exactly the loaded, already-tracked ones. Every token the
alert exists to find is in the blind set — measured on 2026-09-14, top by distinct
buying wallets:

```
BLIND, priced but no supply     ZZZ 24 wallets $54,112   CRCL 24  IPO 22  DELTA 21
                                MEME 16 $41,927   BONER 12 $53,321  (BONER is queued)
EXCLUDED, no price at all       JUDE 15 wallets 58.9M tokens   RSI 14   OPEN 11
                                DIVI 10   BobCoin 9   RHSE 9
```

**24 distinct wallets buying one token in a day is the coordination signal step 17
says the alert exists to catch**, and the market-cap filter cannot see a single one of
them today.

**COST OF THE SUPPLY READ, priced before spending and NOT spent:**

```
1,220 novel tokens x 26 CU (eth_call totalSupply)   31,720 CU   $0.0143  one-off
~474 newly-seen tokens per day x 26 CU              12,324 CU   $0.0055/day
                                                                ~$0.17/month ongoing
```

**Readability is evidenced but not proven: 1,225 of 1,225 tokens already answered
`decimals()`**, the same ERC-20 call shape, and 1,210 answered `symbol()`. That is
strong evidence and not a guarantee, so step 1's rule governs the result — **a `0x`
return is unknown, never zero**, and a token whose supply cannot be read has no market
cap rather than a market cap of nothing.

**SUPPLY IS NOT CACHEABLE ON THE SAME TERMS AS DECIMALS, AND THIS IS THE ONE DESIGN
POINT THAT IS NOT OBVIOUS.** `token_decimals_cache` is permanent because decimals are
immutable and a pool is a pool for good. **Total supply is neither** — a mint or a burn
changes it, and a permanently cached supply would go stale silently, which is this
document's most-recorded failure shape. A supply cache needs a re-read cadence and a
`supply_read` settled-negative flag (the flag for the same reason `meta_read` exists:
without it, a token that genuinely does not answer is re-asked for ever).

**WHAT IS NOT KNOWABLE AT ANY EFFORT, stated rather than worked around:**

- **Total supply is not circulating supply.** A burn address holding a large balance,
  or a locked LP position, makes the two diverge, and nothing here measures either.
  Every figure above is TOTAL-supply market cap and must be labelled as one.
- **A slice-implied price is not a market price.** It is a volume-weighted average over
  one wallet set's trades in a window, from the rows the alert already aggregates — the
  distinction step 17 already draws for the nearest-preceding-bucket lookup.
- **A token with no USD route has no market cap at any price.** The 439 tokens whose
  counter is another memecoin are not underpriced, they are unpriceable, and no supply
  read changes that. They are 3,331 of 10,562 buy rows.

#### The watchlist tab — `/watchlist`

The alert is capped at 20 tokens; **this page is where the rest lives**, one row per
trade: token with name, symbol, address and a DexScreener link, wallet, side, token
amount, USD, time with block, and the transaction. **Filterable by token and by
wallet**, and the alert footer links to it.

**Filtering and the row cap are in SQL, not the browser.** 191,728 rows once produced
a 69.3 MB page (step 14). The cap is stated on the page beside the total matching
count — "Showing 303 of 303" — so a truncation is visible rather than reading as
"that is all that happened". Filters are query-string, so a filtered view is a
shareable URL and scales past what a browser can hold.

**A malformed address is treated as NO filter, not as an error.** A half-typed
address should show everything rather than nothing; a filter matching nothing is the
failure shape this project keeps hitting.

**The token name IS the DexScreener link, the same URL the alert renders**, so both
surfaces send a reader to the same place. **The separate "chart" link was removed and
it is the only thing removed** — it pointed at that identical URL, so keeping it would
be two links to one destination. The address link stays, because it goes to Blockscout,
and so does the transaction link.

**The DOM harness checks every row's link, not just the first.** A href built from a
missing field yields `.../undefined` or a bare prefix, which renders as a working-looking
link that resolves to nothing — the same shape of failure as a filter matching nothing.
Every token link must match `https://dexscreener.com/robinhood/0x<40 hex>` and the link
count must equal the rendered row count, so a row missing its link fails rather than
passing unnoticed.

**Verified by executing the served page in jsdom**, per step 14 — a green build
proves nothing about whether the table has rows:

```
page size            399,100 bytes (0.38 MB)
rendered data rows   303
page claims          303 of 303        <- the check that matters
token filter         32 of 303 rows
wallet filter        2 rows
malformed filter     ignored, result unchanged
script errors        0
```

The rendered-versus-claimed check is the point: a page can claim 500 rows in its
header and render none. `verify-watchlist-page.mjs` also exercises both filters and
asserts a malformed one is ignored, because a filter that silently matches nothing
would pass any check that only counted rows.

Both pages are in the build's parse gate with a sample carrying a priced row, an
unpriced row and an unnamed token, so those branches fail the deploy rather than
production.

**The footer link is omitted when no public domain is configured**, never printed
broken — step 14's rule that a dead link which looks live is the same failure shape as
a filter matching nothing.

#### The alert, as it renders

Aggregated by token, nothing per-wallet, **three lines per token** with buy and sell
kept separate so a token being accumulated is distinguishable from one being
distributed. Ordered by total USD descending.

```
Watchlist: 74 trades, 35 tokens, 29 wallets
Blocks 61595493-61603149  ·  $18,204 priced  ·  18 of 74 rows unpriced

[**PONS** — Pons](https://dexscreener.com/robinhood/0x39dbed…4571)  `0x39db…4571`
　bought   2 wallets  $4,616+
　sold     —
　price    $0.1202

[**WIF** — dogwifhat](https://dexscreener.com/robinhood/0x15d36b…5c4d)  `0x15d3…5c4d`
　bought   —
　sold     3 wallets  unpriced
　price    unpriced

…and 15 more tokens, ordered by USD. All 35 are in `watchlist_activity`.
```

**The token amount is NOT on the bought and sold lines — USD only.** That is a
DISPLAY decision and nothing else: token amounts are still stored on every
`watchlist_activity` row and still shown per trade on the `/watchlist` tab, both
unchanged. The alert was carrying three numbers a side, which buried the one a reader
acts on.

**THE PRICE LINE IS SLICE-IMPLIED, NOT THE STORED SERIES.** It is total USD divided
by total token amount **across that token's PRICED rows in this slice, both sides
combined** — derived from the rows the alert already aggregates, with no price series
read and no additional request. Two consequences that must not be forgotten:

- **The denominator is the priced rows only.** Including an unpriced row's tokens
  would divide real dollars by tokens that contributed none, understating the price by
  whatever share went unpriced.
- **It is a signal figure, not the accounting record.** Same distinction this step
  already draws for the nearest-preceding bucket lookup: the watcher prices arbitrary
  tokens off a fresh in-memory derivation for a screener, while
  `wallet_transactions` keeps the exact-bucket discipline. A slice-implied price is a
  volume-weighted average over ~10,000 blocks of one wallet set's trades — **not the
  token's price**, and never to be compared with a `<token>_usd_prices` bucket as
  though it were.

**Where no row in that token priced, the line reads `unpriced` rather than being
omitted.** A missing line would read as "no price exists"; the line saying `unpriced`
says we looked and could not derive one.

**Zero is never printed as `$0`.** A side with no trades reads `—`; a side whose every
row was unpriced reads `unpriced`; a side partly unpriced reads `$n+`, so a total is
never presented as complete when it is not. `$0` would be a measurement, and the wrong
one.

**A symbol is a label, not an identity, so the address is always shown.** Two
tokens on this chain both answer `symbol()` with "NVDA" (step 16). Name and symbol
are read once per token and cached with its decimals; a token that answers neither
is rendered as its address rather than given an invented label.

**The list is capped at 12 tokens, and a HARD GUARD enforces the real limit.**

The cap was 20 when a token took two lines. At three lines plus a label it takes four,
and 20 tokens measured **3,801 characters against the sink's 4,000-character slice** —
199 characters of headroom, roughly one more token block. **Past 4,000 the sink slices
before posting, so the alert does not vanish: it silently loses its tail, which is the
"…and N more" footer and the link to the tab** — precisely the two elements that tell a
reader something was omitted. A truncated alert would look complete.

**A cap alone is not enough, because a block's length is not fixed.** Token names run
from `FAB` to `Large Language Model`, USD figures from `$40` to `$8,537+`, and a price
line from `$0.0000350` to `$2,524.13`. Twelve blocks is comfortable at typical lengths
and could still overrun at atypical ones, so the body is **measured before posting and
token blocks are dropped from the tail until it fits inside 3,600 characters** — 400
below the slice, about 10%. The margin is a round number chosen to hold one more
four-line block plus footer growth, not a measurement.

**The footer states the count the guard actually dropped, not the cap.** Dropping to fit
and then reporting "…and 18 more" from the cap arithmetic would understate what was
left out, which is the same failure as a silent trim one step removed.

#### THE SECOND ALERT: buys only, filtered by total-supply market cap — built 2026-09-15

**A SECOND MESSAGE TO THE SAME CHANNEL ON THE SAME RUN, not a replacement.** The
existing alert is unchanged and still posts first. This one answers a different
question: *which SMALL tokens are the watchlist buying?* The first alert ranks whatever
the watchlist touched; this one cuts to tokens under a market-cap ceiling, where an
early position is still an early position.

**How the two differ, stated so a future reader cannot mistake one for the other:**

| | existing alert | market-cap alert |
|---|---|---|
| sides | buys AND sells, kept separate | **buys only** |
| ordering | distinct buying wallets, then USD | same |
| filter | none — every token the slice touched | **implied market cap ≤ `max_market_cap_usd`** |
| what it needs | the slice's rows | the rows **plus a stored `totalSupply`** |
| tokens it cannot value | shown with `unpriced` | **given their own section, never dropped** |

**MARKET CAP HERE IS TOTAL-SUPPLY MARKET CAP AND THE ALERT SAYS SO IN ITS OWN BODY.**
It is `totalSupply / 10^decimals x slice-implied price`, and BOTH terms carry a
limitation that is stated rather than buried:

- **Total supply is not circulating supply.** A burn address or a locked LP position
  makes the two diverge and nothing here measures either. The alert labels the column
  `mcap (total supply)` so the figure cannot be read as a float-adjusted one.
- **The slice-implied price is not a market price.** It is the same volume-weighted
  average over one wallet set's trades in ~10,000 blocks that the existing alert's
  price line already uses — a signal figure, never to be compared with a
  `<token>_usd_prices` bucket. This step already draws that distinction for the
  nearest-preceding-bucket lookup; it applies here unchanged, and multiplying it by a
  supply does not make it more of a market figure than it was.

**The threshold is a CONFIG VALUE with its reasoning, not a constant.**
`max_market_cap_usd`, default **200000**. It is an operator preference like
`top_percent` and there is no natural break in the data to measure it against — the
2026-09-14 measurement found the five tokens whose market cap was then derivable
sitting between **$16.7M and $571M**, three orders of magnitude above any plausible
cut, so the data offered no boundary at all. **$150,000 is measured alongside every
run and reported in the log**, so the cut can be moved from evidence rather than
picked again.

**THE TOKENS THE FILTER CANNOT SEE GET THEIR OWN SECTION, and that is the point of the
alert rather than an edge case.** 439 tokens in the 2026-09-14 measurement are quoted
only against other memecoins and have **no USD route at any effort**; the earliest
signal is likeliest to be exactly there. They are listed below the filtered set, never
dropped, and the two reasons are labelled DISTINCTLY because they are not the same
condition:

| kind | what is known | how it renders |
|---|---|---|
| **no price** | wallets and token amount only | USD column reads `unpriced` |
| **no supply** | wallets and a real USD figure | the USD figure, plus `mcap unknown` |

**A token whose USD we DO know is not rendered as `unpriced`.** Printing `unpriced`
over a figure the run computed would misstate what is known, which is the failure this
document spends most of section 5 on. The instruction was to show the USD column as
`unpriced` for the unpriceable set, and that is what it does — the no-supply set keeps
its dollars and loses only the market cap.

**ONE IMPLEMENTATION OF EVERY SHARED RULE.** The symbol-is-a-label rendering, the
DexScreener link, the `$0`-is-never-printed figure formatter, the price scale, and the
measure-and-drop character guard are **extracted into `src/intake/alert-format.ts` and
imported by both alerts**. They were inline in the watcher adapter and copying them
would have been the fifth instance of the two-implementations trap this document
records — the one failure mode it names more often than any other.

**The character guard is the same 3,600-character measure-and-drop**, and with two
sections it drops from the UNPRICEABLE tail first and the filtered tail second, so the
filtered list — the thing the alert is named for — survives longest. **The footer
states what the guard actually dropped from each section**, not a cap arithmetic.

**Nothing is sent on an empty period**, and "empty" means BOTH sections are empty. A
slice with no qualifying token but a full unpriceable section still posts, because that
section is the signal this alert exists to carry.

#### STORING `totalSupply`: read once, re-read weekly, and the timestamp IS the flag

**Supply is cached like decimals and expires unlike decimals.** `token_decimals_cache`
is permanent because decimals are immutable and a pool is a pool for good (step 3).
**Total supply is neither** — a mint or a burn changes it — so a permanent cache would
go stale silently, which is the failure shape this document records most often.

```
alter table token_decimals_cache add column if not exists total_supply   numeric;
alter table token_decimals_cache add column if not exists supply_read_at timestamptz;
```

**`supply_read_at` does the work of two flags and that is deliberate.** It is set on
every read ATTEMPT, successful or not, so:

| state | meaning |
|---|---|
| `supply_read_at is null` | never read — this token is work |
| `supply_read_at` older than `supply_ttl_days` | stale — this token is work again |
| `supply_read_at` set, `total_supply` null | **read, and the contract did not answer** |

The third row is why a separate settled-negative boolean is not needed: a token that
genuinely does not answer `totalSupply()` is not re-asked until its TTL expires, which
is exactly what `meta_read` buys for name and symbol, without a second column that
could disagree with the first. **The staleness is visible rather than assumed** — the
timestamp is on the row and the alert's log reports the oldest one it used.

**A `0x` RETURN IS UNKNOWN, NEVER ZERO — step 1, and here it decides whether a token
appears in the alert at all.** A supply of zero would compute a market cap of `$0`,
which clears any ceiling and would put every unreadable token at the top of the
filtered list. It stores **null** instead and the token falls to the no-supply section,
which is the honest place for it.

**The backfill is its own CLI with its own ceiling**, `npm run token-supply`, dry-run
by default, reporting the work set BEFORE the first request per step 9's rule that one
derivation serves both the estimate and the fetch. The monitor also reads supply
incrementally, bounded by `supply_reads_per_run`, so a newly-seen token gets a supply
without anyone running the backfill again and the weekly re-reads drain a few per cycle.

**Batched `eth_call` returns per-item errors inside an HTTP 200** (step 5), so every
response is inspected individually and a token that errors is recorded as
attempted-and-unresolved rather than skipped silently.

#### BUILT AND MEASURED 2026-09-15 — the supply read, and the first two-alert run

**THE SUPPLY READ LANDED EXACTLY ON ITS ESTIMATE, and every token answered.**

```
work set                    1,227   never read 1,227   stale 0   already fresh 0
estimated                  31,902 CU  $0.0144     ceiling 38,283 (1.2x, set from the work set)
spent                      31,902 CU  $0.0144     0.0% against estimate
resolved                    1,227     unresolved 0   empty return 0   errored 0
wall clock                   23.1 s
read back from the table    total 1,227  with_supply 1,227  attempted_no_supply 0  never 0
```

**1,227 of 1,227 is the strongest possible answer to "is `totalSupply()` readable",
and the 2026-09-14 measurement predicted it correctly from a proxy** — every one of
those tokens had already answered `decimals()`, the same ERC-20 call shape, and the
prediction was recorded as evidence rather than proof. It held. **The zero unresolved
count is reported rather than omitted**, because it is the figure that says the `0x`
path was never exercised: the null-supply branch of the alert is untested against real
data and will stay so until a token declines to answer.

**The estimate landed at 0.0% because the unit of work is exactly one call per token**
— unlike a sweep, where density decides the request count and this document records
three estimates wrong by 16x, 27% and 2.0x. **Quote a per-token job from the token
count and it is not an estimate at all**, which is the same thing step 7 says about
quoting a cohort from its candidate count.

**THE FIRST RUN CARRYING BOTH ALERTS**, slice 63,223,150–63,233,149:

```
existing alert   107 trades, 49 tokens, 38 wallets   2,405 characters   0 dropped by the guard
market-cap alert  62 buy rows, 26 tokens, 25 wallets  2,298 characters   0 dropped
  qualifying at $200,000      3      <- Analyst $115.2k, PEG $118.6k, Carbonoid $8.0k
  qualifying at $150,000      3      <- MEASURED ALONGSIDE, reported, never rendered
  above the threshold        16
  no supply                   0      <- the backfill had covered every token
  no price                    7
incremental supply read     6 tokens, 6 resolved, 156 CU   (1,227 fresh, 0 stale)
```

**THE FILTER SURFACED A TOKEN THE UNFILTERED ALERT BURIED, which is the whole case for
building it.** `Carbonoid` — 1 wallet, $123, an $8.0k market cap — sits in the
market-cap alert's top three and is **not in the existing alert's twelve**, because
that alert orders by buying wallets then USD and Carbonoid fell into its 37 omitted.
The two alerts are looking at the same 107 trades and disagreeing about what matters,
which is what a second question is for.

**$200,000 and $150,000 selected the SAME THREE TOKENS on this slice**, so the first
run gives no evidence for moving the cut. That is a result and it is recorded as one —
the comparison runs on every cycle, and the figure to watch is the first slice where
the two counts differ.

**Both alerts fitted well inside the guard** — 2,405 and 2,298 against a 3,600
margin — so the drop path did not run. It remains untested against real data on the
new alert for the same reason the null-supply branch is: nothing has been big enough.

#### A DEPLOY FAILED TO BOOT ON THE OPTION ALLOW-LIST, AND THAT IS THE GUARD WORKING

The first deploy of this change **failed**: the monitor YAML gained four options and
`watchlist-watch`'s `validate` refused them — `unexpected option(s)
max_market_cap_usd, compare_market_cap_usd, supply_ttl_days, supply_reads_per_run` —
so the container would not start.

**This is the behaviour to want, and the reason is in step 15.** `bridge_assets` was
accepted by the config parser and read by nobody, silently doing nothing for **80% of
AI's volume**. An option the adapter does not know is almost always a typo, and a
threshold that silently does not apply is worse than a refusal. **The previous
container kept serving throughout** — Railway does not replace a deployment that fails
to boot — so no alert was missed and nothing was half-configured.

**The deployment list is what found it, not waiting.** Five minutes of marker polling
showed the old SHA; section 4's rule says to check the list at ~3x rather than wait,
and the list said `FAILED` immediately. **A build that is failing and a build that is
slow look identical from inside the container.**

#### Ordering: buying wallets first, USD second

**Tokens are ordered by DISTINCT BUYING WALLETS descending, then total USD bought.** It
was total USD across both sides, and that was wrong twice over:

- **Two wallets buying the same token is the coordination signal this system exists to
  find.** A single wallet moving $8,000 is one wallet's opinion; five wallets buying the
  same thing in one slice is the thing worth waking up for. Ordering by USD buried it
  under whichever token happened to carry the largest single trade.
- **A USD-first order sorted every token with no USD route off the end.** A token with
  nothing priced totals zero, so it landed last by construction and was always the
  first cut — measured on the 61,603,150–61,613,149 slice, **all 6 tokens with an
  unpriced price line fell in the 10 omitted.** An unpriced token whose buyers are
  stacking up is exactly the case the ordering must not hide.

Sell-side activity now sorts below every token with a buyer, since a sell-only token has
zero buying wallets. That is deliberate: the alert leads with accumulation.

**The footer also states how many of the omitted tokens had nothing priced**, so a
reader can tell whether the tail was dropped for being quiet or for being unpriceable.

**Channel: `crypto`, which IS the Discord channel #crypto-screener.** The webhook
named "Crypto" is `DISCORD_WEBHOOK_CRYPTO` and `env.ts` already registers it, so
nothing was created and the log reads `via: "channel"`. **The two names differ and
that is worth knowing** — a reader should not assume `crypto` is a general channel,
and adding `DISCORD_WEBHOOK_CRYPTO_SCREENER` later would register a SECOND channel
pointing at the same Discord channel while leaving this monitor on `crypto`.

An earlier attempt routed this to a `crypto_screener` channel that did not exist,
which fell back to `DISCORD_WEBHOOK_URL` and said so. **The fallback warning is the
design working** — a misrouting was visible rather than silent — but it was a
misrouting, and the fix was to find the webhook that already existed rather than add
one.

**Every 30 minutes, and NOTHING is sent on an empty period.** A recurring "0 wallets
traded" line trains the reader to ignore the channel, and `monitor_runs` already
distinguishes silence from a dead monitor. Failures alert on `system`.

**`AlertLevel` gained `info`.** The activity alert is none of critical, warning or
recovery, and reusing `recovery` would colour a routine event as "a failure ended".

**`run-once` races the scheduler.** The container boot ran `watchlist-watch` at
01:43:22 and a manual `run-once` at 01:43:53 read the same range, because the first
had not committed its cursor when the second read it. Nothing was corrupted — the
row key is unique and the insert is `on conflict do nothing`, so the second run
stored 1 row of 189 — but a concurrent run is possible and on a more expensive job
it would double-spend. **Check `monitor_runs` before running a monitor by hand.**

---

## 5. What a null means, per field

**A null is never a zero.** Zero is a measurement; null is the absence of one.

| field | null means |
|---|---|
| `wallet_transactions.usd_amount` | the swap's price bucket had no derivable rate |
| `wallet_transactions.price_usd` | the same |
| `wallet_transactions.counterparty` | not recorded — every PONS trade row without exception. Current counts live in section 0, never here |
| `wallet_scores.score` | every one of the eight metrics was null |
| a metric inside `metrics.raw` | uncomputable for this wallet; it drops out and the weights renormalise |
| a missing price bucket | no trade on both sides in that bucket; gaps stay gaps |

`block_time` and `token_amount` are `NOT NULL`. A row that cannot state when it
happened or how much moved is not a row.

**A filter, gate or lookup that matches nothing is a suspected defect, not a
clean pass.** Report it as "RETURNED NO ROWS" rather than omitting the line —
zero is a result, and an omitted line is indistinguishable from a check that
never ran.

**Never map an error to a zero.** A `balanceOf` reader once mapped any absent
result to `0.0`; 490 of 1,046 batched reads came back 429 and every one became a
plausible zero balance, manufacturing a false decode crisis that cost a full
investigation. A crash would have been strictly better.

---

## 6. Every constant, and whether it was measured

| constant | value | measured? |
|---|---|---|
| block time | ~0.1 s, 35,622 blocks/hour | **measured** — 935,564 blocks over 94,548 s |
| dense `eth_getLogs` span | 100,000 blocks | **measured** — 250,000 refused for response size, one account |
| sparse `eth_getLogs` span | 40,000,000 blocks | **measured once**, on one filter (AI `Initialize`), generalised to all sparse filters |
| `eth_getLogs` cost | 60 CU, flat | **measured** — 4,920 CU over 82 calls, matches the provider's table |
| `eth_getBlockByNumber` | 20 CU | provider's published table; not independently measured |
| `eth_call` / `eth_getCode` | 26 CU | provider's published table |
| `eth_getTransactionReceipt` / `…ByHash` | 15 CU each | provider's published table |
| `debug_traceTransaction` | 309 CU | **published, not measured** — 95% of the payment test's cost, and worth confirming against the dashboard before any job depends on it |
| `eth_blockNumber` | 10 CU | provider's published table |
| throughput | 15.3 calls/s at concurrency 8, zero refusals | **measured** |
| per-item errors begin | ~13 req/s × 100 sub-calls | **measured** — 2.4–2.5 req/s with batch 100 gave 0 errors in 51,475 sub-calls |
| public RPC pacing, logs | 4,000 ms clean, 800 ms gave 15/20 refusals | **measured** |
| public RPC batch cap, blocks | exactly 100; 200 refused after 15 s idle | **measured 2026-09-11** |
| public RPC pacing, blocks | 6,000 ms clean 6/6; 3,000 ms 4/6 | **measured 2026-09-11** |
| public RPC block timestamps | 100/100 exact vs Alchemy, 0 zeros | **measured 2026-09-11** |
| block timestamp, Alchemy | 20 CU each; 717,340 blocks = $6.46 on PONS | **measured 2026-09-11** |
| price bucket | 10,000 blocks (~17 min) | derived from the measured block time |
| bucket anchor | a fixed block tied to the token: an EXISTING grid if it shares a series, else the first swap block, else the deployment block | **measured** per token; INDEX deliberately reused PONS's 8,963,150 and added only 298 of 5,234 native buckets |
| tick fence | 100× the bucket median | **guessed**, then validated — caught 46 and 9,129 on PONS |
| native fence | 10× | **guessed**, then validated — caught 0 on PONS |
| target logs/request | 6,000 | **never measured** — would be measured by sweeping one range at several targets and comparing calls and refusals |
| reorg lag | 200 blocks | **never measured** — would be measured by watching head reorganisations over a day |
| router min recipients | 50 | **guessed** — arbitrary; the data shows no natural break here |
| router min swap share | 0.5 | **guessed**, but it sits in a real gap: routers 53–98.8%, distributors 0.0% |
| `low-weight` threshold | 0.8 of the weight | **measured on PONS**; must be re-derived per token |
| `inflated-pnl` floor | −0.001 tokens | reuses the token-amount floor; **measured** that 589 wallets sit above −1e-6 |
| token-amount floor | 0.001 | **measured** — caught the $980,394 row |
| USD floor | $0.01 | **measured** — caught 5,301 rows, largest $0.00999987 |

---

### Leftover tables from the first intake

Fifteen tables survive from the scratchpad scripts that loaded PONS, holding
**2,268 MB of a 21 GB database**. Nothing in the repository reads any of them —
checked for `from`/`join`/`into`/`update`/`delete` against each name, not for
the bare word. They are kept, not dropped: `cohort0` and `coh3` are the PONS
cohort at two stages, and `need_blocks` at 1,379,236 rows is the timestamp
overshoot step 9 records.

```
legs 845 MB / 215,177    swagg 735 MB / 2,250,043    p2pv 257 MB / 983,871
p2p 212 MB / 983,871     need_blocks 77 MB           walleg 70 MB / 185,060
wt_stage 54 MB           need2 8,336 kB              hops 5,056 kB
coh3 1,920 kB            cohort0 1,920 kB            hop_contracts 688 kB
h1set 288 kB             need3 272 kB                excl 32 kB
```

**`records` is NOT one of them — it is live**, written by `src/store/records.ts`
and read by `registry.ts` for monitor counts. It was listed as debris once on
the strength of a bare-word grep; matching a table name needs the SQL keyword
in front of it.

---

## 7. Rules that govern the code rather than the chain

These are not about Robinhood Chain, but the code that loads it obeys them.

- **A `create table if not exists` is a no-op on an existing table.** It does not
  reconcile a changed shape, and it reports success either way.
- **`ORDER BY` binds to an output column name before a table column, so a
  `::text` cast silently changes the sort to lexicographic.** In
  `select block_number::text from t order by block_number`, the output column is
  *named* `block_number`, and that is what `ORDER BY` resolves to — so the sort
  is on text. On block numbers that puts `'10003150'` before `'5363150'`.

  This produced a flat contradiction inside one query on 2026-09-12:
  `min(block_number)` returned 5,363,150 while an ordered subquery returned
  10,003,150, and a row at 5,363,150 provably existed. It reads exactly like a
  corrupt btree, and index corruption was about to be reported before the real
  cause was found. The aggregates were right the whole time; the diagnostic was
  wrong.

  Alias the cast (`block_number::text as blk`) or order by the bare column, and
  when a query disagrees with itself, **suspect the query before the database.**
- **Check SQL parameter arity before deploying.** A mismatch is a runtime error
  on a path that may run hours later.
- **Chain an edit and the command that depends on it with `&&`.** A failed patch
  that does not stop the next command once sent an empty schema, which
  `client.query('')` executed happily and reported as applied.
- **Never pass a Postgres timestamp through a JavaScript `Date` and back as a
  lookup key.** The column stores microseconds and a `Date` holds milliseconds;
  the truncated value is a valid timestamp that matches zero rows, with no error.
- **Never lowercase a blockchain address** on a chain where case matters. EVM hex
  is case-insensitive and is lowercased here deliberately; base58 is not.
- **Pair figures from the same baseline.** Two numbers read separately look
  correct alone and only reconcile wrongly together.
- **A monitor where one item fails and the run still reports success hides a
  permanent failure.** Alert on the first, fail the run once an item has failed
  repeatedly.
- **Write a cycle's stats row at cycle start, not on completion**, or a run that
  dies leaves no trace.
- **Insert in batches. One row per statement under autocommit fsyncs the WAL once
  per row, and it is slow enough to look like a hang.** Measured 2026-09-13 on the
  ETH/USD market sweep: throughput pinned at **~185 rows/second** regardless of
  what the endpoint delivered, with `pg_stat_activity` showing the backend in
  `IO / WalSync`. The v4 half took **50 minutes** and the v3 half projected to
  **83 more** — for a job whose entire RPC bill is about one penny. **The
  bottleneck was never the chain, and no amount of waiting was going to reveal
  that.** Multi-row `VALUES` statements at 500 rows make it one fsync per batch.

  Progressive commits survive this: a batch is still a commit, so a run that dies
  leaves a truthful partial record. Row granularity was never what that property
  needed. Watch for the trap in a multi-row insert — two rows with the same key in
  one statement raise, so de-duplicate within the batch (many logs share a block).

  This is the wall-clock rule from section 4 doing its job. The phase was not
  slow, it was wrongly built, and the tell was a database wait event rather than
  anything visible in the job's own log.

  **APPLIED TO THE INTAKE SWEEP 2026-09-14, after CASHCAT paid for its absence.**
  The rule above was written for the ETH/USD market sweep and fixed only there; the
  intake sweep went on inserting one row per statement, and CASHCAT is the first
  token big enough for that to dominate. **199.8 minutes for 14,957,528 rows —
  1,248 rows/second — with `pg_stat_activity` showing the backend in `ClientRead`
  between sub-second inserts.** All three streams and their `block_times`
  companions now go through one batched writer at 500 rows.

  **`block_times` is where the de-duplication trap actually bites.** Its key is
  `(chain, block_number)` and **ten consecutive blocks share a timestamp on this
  chain**, so a 500-row batch of logs routinely carries many rows for one block.
  Two rows with the same key in one `VALUES` statement RAISE — `on conflict do
  nothing` does not save you, because the conflict is inside the statement rather
  than against the table. The writer keeps the first occurrence of each key per
  batch; cross-batch duplicates are still handled by `on conflict`.

  **The improvement is EXPECTED, not measured.** CASHCAT is not being re-swept, so
  there is no before-and-after on the same data. The ETH/USD sweep measured
  ~185 rows/second at one row per statement under autocommit and the intake managed
  1,248 inside a transaction; batching removes ~500x the round trips per statement,
  so the expectation is a large multiple rather than a known one. **BONER is the
  first token that will measure it**, and the figure to record then is rows/second
  against CASHCAT's 1,248.

  **It does NOT restore progressive commit for the intake.** The runner still wraps
  the whole phase in one transaction (section 9), so a batch here is not a commit
  and a sweep that dies still leaves nothing. Batching buys throughput; the
  durability half of this rule is a separate, still-open defect.
- **A documented guarantee the code does not implement is a defect in the code.**
- **A query that filters one side of a relationship but not the other** counts
  infrastructure as participants. Apply every address list to every side.
- **Report third-party costs from the provider**, never derived from constants in
  this repository.
- **Derive the work set from the rows you will write**, not from the superset
  that contains them, and state the derivation before the first request.
- **Validate a population claim on individual records before acting on it.** An
  aggregate is a hypothesis; twice one pointed the wrong way and decoding twenty
  transactions settled it in minutes.
- **THE ENVIRONMENT MAY BE SHARED, SO RECORD THE DEPLOYMENT ID BEFORE ANY LONG OR
  PAID WORK AND RE-CHECK IT AFTER.** Two Claude Code sessions ran against this repo
  and container on 2026-09-13. The container rebuilt at **08:08:06** with no push
  behind it from the session that was working, and section 3's consequence duly
  followed: **that session's `chump-*.log` files under `/app` were gone** when it
  looked afterwards. Nothing was lost because only Postgres held anything that
  mattered — which is exactly why every step writes progressively — but a paid job
  replaced mid-run has **spent the compute units and lost the output**, and it would
  have reported nothing at all.

  **What a session CAN establish, measured from inside the container 2026-09-13:**

  | check | how | what it tells you |
  |---|---|---|
  | container identity | `RAILWAY_DEPLOYMENT_ID` in the env | **the single best signal** — if it differs from the one you recorded, the container was replaced and everything under `/app` with it |
  | source it was built from | `RAILWAY_GIT_COMMIT_SHA` in the env | which commit is actually running, without grepping `dist` |
  | when it was replaced | `ps -o lstart= -p 1` | pid 1 started 08:08:30, matching the 08:08:06 build |
  | when the build was produced | `stat -c '%y' /app/dist/<file>` | a build newer than your own push means somebody else deployed |
  | another session's detached job | `ps -eo pid,etime,args` | only `node dist/index.js` was running, up 8h51m — nobody else had a job in flight |
  | another session's queries | `pg_stat_activity` | long statements that are not yours |
  | a monitor mid-cycle | `monitor_runs` | already required before running one by hand |

  **What it CANNOT establish, and this is the part to accept rather than work
  around:** *why* a redeploy happened, or who triggered it — nothing in the container
  records the cause; whether another session is attached at all, since SSH leaves no
  durable trace; and whether a service variable was changed, which needs
  `railway variables` from outside and shows the current value, never the history.
  **A rebuild with no push behind it is therefore indistinguishable from a variable
  change, a manual redeploy and a platform restart.** Do not guess between them.

  **The rule: capture `RAILWAY_DEPLOYMENT_ID` and the pid-1 start time before starting,
  re-read both when the work ends, and treat any change as "the output is gone, the CU
  is spent, re-run from what Postgres holds".** `grep`ping `/app/dist` for a marker
  stays the proof that a FIX shipped; the deployment id is the proof that the container
  you verified is the one you are still talking to.

---

## 8. Findings, one section per token

### PONS — `0x39dBED3a2bd333467115dE45665cC57F813C4571`

Cohort `PONS-P1`, 13,095 wallets, window 2026-07-21 → 2026-08-21 (blocks
15,115,285–42,691,407). **179,736 rows at intake.** Every later count is in section 0 and nowhere
else — a snapshot written into a findings section is stale the next hour. (An earlier figure of 181,477 appeared here
and reconciles with nothing in the database; it has been removed rather than
explained.) First EVM intake; most of the rules above
came from it.

- Opposite sign conventions per venue, measured unanimously in three regions.
- USDG at 6 decimals, the counter on 238 of 381 in-scope pools.
- DexScreener knew 14 of 792 v4 pools.
- The window held 31% of the token's swaps.
- Price buckets anchored at `% 10000 == 3150`.
- A router investigation produced a claim of 34,744 missing buyers that decoding
  disproved twice over — see steps 7 and 11. Defensible figure: **~1,477 of
  29,542, 95% interval roughly 175–5,000**. Not acted on.
- The dominant pattern is custodial: one funding EOA
  (`0xf70da978…`) pays, a router routes, and the token lands in a user's
  EIP-7702 account. 96% of 150 sampled router recipients were delegated
  accounts; **0 of the 150 were in the cohort**.
- The contract check wrongly excludes **2,001 delegated accounts** against 463
  real contracts. The 396 `PONS-P1-T` hop wallets are unaffected — all 396 are
  plain EOAs. The wider hop table is: hop 1 is 14.8% delegated, hop 2 18.8%,
  hop 3 8.8%.
- No bonding curve: the first pool `Initialize` is in the same block as the token
  deployment.
- Scoring: 70% of the weight contributes 0.8% of the median score.

### INDEX — `0x56910D4409F3a0C78C64DD8D0545FF0705389870`

**Loaded 2026-09-10.** "The Index", 18 decimals, supply 1,000,000,000, deployed
at block **1,670,725** — earlier than any token loaded before, and thirteen
million blocks before `v4_swaps_all` begins. **First token through this runner
with two windows.**

```
INDEX-P1  2026-07-03 00:00 -> 07-14 16:00 ET   blocks 1,693,406..9,800,208    3,316 wallets
INDEX-P2  2026-08-01 12:00 -> 08-23 12:00 ET  blocks 25,165,577..44,130,852   4,267 wallets
rows 152,302 AT LOAD for 7,230 wallets   $40,162,847   pools 196 in scope of 317
(the hourly job has added rows since -- section 0 carries the current count)
```

```
phase                     measured    estimate
identity                     816 CU       800
windows (two windows)      2,240 CU     2,100    exactly 2x one window
pools                        480 CU       500
scope (x2 runs)            5,428 CU     4,200
transfer sweep, full life 38,220 CU    30,000   +27.4%  A FINDING
v4 copy + gap sweep + v3  54,300 CU    ~48,000
block_times                    0 CU              carried by the sweeps
cohort, two windows      362,811 CU     unknown
prices                         0 CU
                        -----------
                          ~464,000 CU   ~$0.21
```

**INDEX's 6,052 null-USD trade rows, diagnosed 2026-09-12.** Against AI's 169
and PONS's 80 — two orders of magnitude, and the cause is INDEX's age, not its
quoting.

**Where they fall.** Overwhelmingly at the token's start, in 378 distinct
buckets between blocks 1,670,964 and 9,460,566, and nowhere else:

| block band | trade rows | null | share |
|---|---|---|---|
| < 5,363,150 | 4,688 | 4,688 | **100.0%** |
| 5,363,150 – 9,143,149 | 4,169 | 1,337 | 32.1% |
| 9,143,150 – 20M | 31,160 | 27 | 0.1% |
| 20M – 40M | 28,202 | 0 | 0% |
| 40M+ | 20,046 | 0 | 0% |

**Which side is missing.** Always the counter side — the chain's ETH/USD
reference. A trade row's USD comes from what the counter asset paid, so
`native_usd_prices` is the only series consulted; `index_usd_prices` plays no
part in it (and has the identical hole, starting at the same 5,363,150).

**Which pools.** 6,038 of the 6,052 are **native ETH** on 6 v4 pools; 14 are
WETH on one v3 pool. **USDG rows are never null — 0 of 22,102** — because a
dollar stablecoin resolves to 1 without consulting any series. WETH rows are
null 14 times in 41,924.

**Why INDEX differs from AI and PONS by two orders of magnitude, plainly: it is
NOT because INDEX is ETH-quoted with no bridge.** Being ETH-quoted is what
*exposes* the gap — USDG rows are immune — but the gap itself is chronological.
INDEX's first swap is at block **1,670,964, against native ETH. Its first USDG
swap is at 5,371,436**, 3.7 million blocks later. Nothing else on this chain
traded that early: PONS begins at 8,963,150 and AI at 18,275,462. So for the
first 3.7M blocks of INDEX's life **there is no USD-denominated market anywhere
in the collected data to date ETH against**, and no amount of quoting choice
changes that.

The mechanism is exact. `native_usd_prices` begins at bucket **5,363,150**,
which is precisely the bucket containing INDEX's first USDG swap. **INDEX
bootstraps the chain's ETH/USD series itself**, and it cannot do so before it
has both quote sides in one bucket. In the pre-9,463,150 era INDEX occupies 713
buckets: 286 carry both sides, **424 carry ETH only**, 3 carry USDG only. The
424 are where the rows go null.

**It is not a bucket-grid mismatch, and that was tested rather than assumed.**
For all 6,052, a price exists at the exact bucket in **0** cases, and anywhere
inside the same 10,000-block window at any residue in **0** cases. Only 336 have
any native price within ±10,000 blocks, and the nearest is 5,363,150 — the start
of the series. The lookup is behaving correctly; the data is absent.

**What it would take to price them, and the cost.** ETH/USD in that era can only
come from a market we have not collected: a WETH-or-ETH/USDG pool belonging to
no tracked token. Enumerating it is one sparse `Initialize`/`PoolCreated` query
over the chain's life (~120 CU, measured: 4,615 Initialize logs returned in a
single call across 40,000,000 blocks), and sweeping its swaps across
1,670,964–5,371,436 is ~37 dense requests at 60 CU (~2,220 CU). Timestamps ride
along with the logs. Deriving a chain-level series and reinserting the INDEX rows
costs nothing. **Total ≈ 2,400 CU ≈ $0.001.**

**PROBE RUN 2026-09-12: the market exists, and these rows are RECOVERABLE.**
`eth-usd-probe` enumerated both orderings of WETH/USDG and ETH/USDG across the
whole chain and found **48 pools, the earliest created at block 50,716** — 1.62
million blocks *before* INDEX's first swap — with 33 of them created before the
range even starts. Sweeping their Swap logs over 1,670,964–5,371,436 returned
**264,078 swaps** (81,701 v4, 182,377 v3). The first falls at block **1,671,009,
45 blocks after INDEX's first swap.** There is no meaningful part of INDEX's life
without a USD-denominated ETH market running alongside it.

Verified on individual decoded transactions rather than on the count, from the v3
WETH/USDG pool `0xa9188730fe85be88ad499d7d52b099e800fb0334` (created at block
50,716; token0 WETH 18 dec, token1 USDG 6 dec):

| block | tx | implied ETH/USD |
|---|---|---|
| 1,680,559 | `0x0f6ebed92d60f68c4c7d16c4c7e2b2ca168ff2bd3788e394010dd4fe4c6061b2` | **1,708.53** |
| 3,005,932 | `0x27a4eaaef146ffe11accdc5196cc60e736041f585a9fd03777ae026aa103e27e` | **1,771.72** |
| 5,354,209 | `0x59703054ec722367bd9bd2644b0c3947a18853c83980a67fb0bd739e07fab5d6` | **1,743.24** |

Against the current series' earliest bucket, 5,363,150 at **1,877.27**. Same
regime, no order-of-magnitude error, and steadier than what we store.

**The dedicated market is not merely a fallback — it is better than the series we
have.** The earliest stored buckets rest on **one USDG tick each**: 5,363,150 has
`usd_ticks 1`, 5,403,150 has 1, 5,473,150 has 2, and their medians swing
1,877 → 1,434 → 1,653 across 110,000 blocks. The WETH/USDG pool supplies 5 to 86
swaps per 20,000 blocks continuously from block 50,716. Deriving ETH/USD from the
market that *is* ETH/USD replaces a by-product with a measurement.

**`v4_swaps_all` said the opposite and was wrong to be believed.** It returns 0
swaps before 5,371,436 — but spans only 15,115,267–42,695,454, having been built
for PONS's window. That zero was a coverage artefact. It is recorded here because
the probe cost less than half a cent and overturned it completely: **a zero from a
table whose coverage you have not checked is not a finding.**

**Cost: 10,080 CU / $0.0045, against an estimate of ~2,400 CU / $0.001 — 4.2x
over.** The enumeration came in at 360 CU against 480 estimated. The dense sweep
did not: I sized it at 37 requests from the block count and it took 168
`eth_getLogs` calls, because 264,078 logs forced the span to halve repeatedly.
**Sizing a dense sweep by block count and not by log density is the same mistake
this document records for the sweep phase**, made again in an estimate.

**Is any of it a defect?** The lookup is not. Three other things are:

1. **`intake/index.yaml` states something the data contradicts.** Its comment
   justifies reusing PONS's anchor by saying INDEX thereby reads buckets
   "spanning 9,143,150-58,993,150 — its whole life". INDEX's life starts at
   1,670,964. **7.47 million blocks of it sit outside the claimed span, and
   4,688 rows sit in that gap.** The false claim is why nobody expected these
   rows to be unpriceable. A config comment asserting coverage must be checked
   against the series it names.
2. **ETH/USD is a chain-level quantity derived per token.** It exists only where
   some tracked token happened to trade against both a native asset and USDG
   inside one 10,000-block bucket, which makes the chain's reference series an
   accident of which tokens were loaded and when. A series derived from the
   WETH/USDG market itself would have no such hole. This is the same root as the
   shared-anchor item in section 9.
3. **The series is fragmented across two residues.** `native_usd_prices` holds
   9,645 buckets: 5,473 at PONS's residue 3150 and **4,172 at AI's residue
   1433**, and a reader anchored on one grid can never match the other. It does
   not cause these 6,052 — AI's contribution starts at 18,281,433, long after
   the null era — so today it is harmless duplication of one quantity. It stops
   being harmless the moment a token needs a bucket only the other grid has.

**These rows were underivable from what had been COLLECTED, not from the chain,
and that distinction is the whole finding.** The earlier reading of this section
concluded they were genuinely underivable; the probe reversed it for half a cent.
`native_usd_prices` was never missing because the data does not exist — it was
missing because it is assembled from tracked tokens' incidental both-sided
buckets instead of from the ETH/USD market itself.

They must still not be interpolated. The fix is to derive a chain-level ETH/USD
series from the WETH/USDG and ETH/USDG pools, on a chain-level anchor, and
reinsert; that is a code change and is listed in section 9, not done here.

- **The density probe missed the token's early life.** I probed 8,963,150
  onward, but INDEX starts at 1,670,725; the unsampled 7.3M blocks are denser
  than the probe suggested and the sweep came in **27.4% over**. **Probe from the
  deployment block, not from where another token started.**
- **My P1 span estimate was ~10x low** for the same reason: I assumed 07-03 sat
  near PONS's origin. It is block 1,693,406, so P1 is 8,106,802 blocks, not
  ~840,000. Resolve the window before costing anything that depends on it.
- **The bucket anchor reused PONS's grid and the reuse is measurable**: of 5,234
  native buckets derived, **4,936 were already present and only 298 were new**.
  INDEX read the chain's existing ETH/USD series instead of forking it.
- **Sign conventions unanimous across both windows and outside them**: v3
  22,838/0 and 62,550/0; v4 142/0, 24,937/0, 71,522/0.
- **19 routers identified of 40 probed**, against 3 in the configured list. Seven
  configured entries matched nothing for P1 and three for P2, all reported.
- **762 delegated EIP-7702 accounts kept** (192 in P1, 570 in P2).
- Price fences caught 9 USD ticks and 29 native ticks of 557,188; the derived
  native fence caught **0**, the signal the derivation is sound.

**PONS IS FROZEN, AND IT WAS BUILT UNDER DIFFERENT RULES FROM AI AND INDEX.**
State this wherever PONS is compared with another token. Three known
differences, none of them acted on:

1. **2,001 EIP-7702 delegated accounts were excluded** that the current rule
   keeps. The cohort would be **15,096 rather than 13,095, a 15.3% increase.**
2. ~~**The cohort used the 3 configured router addresses.**~~ **NO LONGER TRUE —
   corrected 2026-09-14.** This was the pre-rebuild state. PONS carries **39
   persisted `router:%` rows** against a stored scope report of `probed 72 /
   identified 39`, so `effectiveExclusions` returns the config list **plus 39
   behavioural routers**. The claim survived here for two days after the rebuild
   made it false.
3. **No `transfer_in`/`transfer_out` rows.** 185,189 rows, all buys and sells.
   AI and INDEX both have transfers, which is why PONS's `inflated-pnl` count
   cannot clear itself: 2,122 wallets show a negative position because the
   acquisitions that explain them are not collected.

**What a rebuild would cost, measured:**

```
transfers already stored to block 54,935,932       no re-sweep needed for the window
cohort step   16,910 candidate wallets in-window
              x 26 CU code check + ~17.1 CU payment   ~727,000 CU    ~$0.33
router detection, 62 candidates x 26 CU                 ~1,600 CU
transfer rows: sweep 54,935,932 -> head, ~4.2M blocks   ~2,600 CU
rows: delete and rewrite 185,189 rows                        0 CU
re-score                                                     0 CU
                                                       -----------
                                                       ~731,000 CU    ~$0.33
```

**What would change:** the cohort grows by up to 2,001 wallets; up to 62 router
addresses are excluded, removing rows currently attributed to them; transfer
rows appear and `inflated-pnl` falls from 2,122 toward the residue; every PONS
score moves because the cohort and the rows underneath it move.

**THE DECISION IS THE OPERATOR'S AND HAS NOT BEEN MADE.** PONS is the reference
cohort every rule in this document was derived from, and rebuilding it changes
the numbers those rules were measured against. It stays as it is until that is
decided explicitly.

### AI — `0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18`

**Loaded 2026-09-09.** Cohort `AI-P1`, **3,508 wallets**, window 2026-07-24
12:00 → 2026-08-09 16:00 Eastern (blocks 18,275,461–32,206,441), **31,896 rows AT
LOAD** (section 0 carries the current count; the hourly job has added more),
**$8,657,254** of USD volume. Name "Artificial Inu", 18 decimals, supply
991,382,832.598, deployed at block 9,721,433.

```
                                measured        against estimate
transfer sweep                8,820 CU          8,400   +5.0%
v3 swaps                      8,400 CU          8,400    0.0%
v4 swaps copied from v4_swaps_all   0 CU        -- pure SQL
identity+windows+pools+scope  4,610 CU          4,576   +0.7%
NVDA as a pricing source      4,610 CU          3,500  +32%  (missed its timestamps)
block_times (237 + 23)        4,940 CU
cohort, first build          73,733 CU        160,500   -54%  (round-trip filtering)
cohort, rebuilt with NVDA   165,584 CU
prices                            0 CU
                            ----------
                           ~271,000 CU  ~$0.12 for the whole token
```

- **The second hop is most of the token.** NVDA pools carry **15,031 of 31,896
  rows, 2,549 wallets and $6,945,374 — 80% of AI's USD volume** — against WETH's
  $870,922 and USDG's $840,348. Without the hop the cohort was 1,366 and the
  volume $1,127,383.
- **Two tokens answer `symbol()` with "NVDA".** The real one,
  `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec`, has 13 AI pools; the impostor at
  `0xa90b49763f970d79d6772270c96ac02bc1b71e18` has one, and its address ends
  `1e18` like a crowd of junk counters here. Match a bridge by address.
- **NVDA/USD derived cleanly:** 1,368 of ~1,393 buckets, 0 fence discards,
  $188.95–$225.91 — a plausible range for a tokenised NVIDIA share, from a
  derivation that knows nothing about the real one.
- **AI/USD** 1,375 buckets, $0.00133989–$0.00880391, 0 discards on any fence.
- **Buckets anchored at the deployment block 9,721,433**, residue 1433, because
  the first swap sits before `v4_swaps_all` and reading it costs ~32,400 CU.
- **15 routers detected against 3 in the configured list**, 13 of them new. One
  candidate at 0.1% swap share is a distributor; the rest run 90–100%.
- **Scores:** 3,508 wallets, range 0.0385–0.7562, median 0.1427, mean 0.1627, 12
  nulls. `inflated-pnl` 318 (9.1%), `low-weight` 8, both 0.
- **The low-weight threshold could not be derived and 0.8 stands.** AI's weight
  distribution has only one distinct partial weight (0.3), so there is no gap to
  cut at — unlike PONS, which is bimodal. **Re-deriving it produced "do not
  change it", which is a result and is recorded as one.**
- **315 delegated EIP-7702 accounts kept**, 9.0% of the cohort.
- Zero mints inside the window: AI's supply did not originate there.
- The top two wallets score 0.7562 on 30% of the weight and are flagged
  `low-weight`; the highest full-weight score is 0.6524.

**Window, bisected:** AI-P1 is blocks **18,275,461–32,206,441** (13,930,980).
Deployed at 9,721,433; name "Artificial Inu", 18 decimals, supply
991,382,832.598. **Derive window bounds by bisection, not from the nearest
stored `block_times`** — doing the latter landed 12 blocks late at the start and
217 early at the end, leaving a 229-block hole in a sweep that reported a clean
gap check because it was checked against its own narrower range.

**Enumeration and scope, measured against estimate:**

```
phase       actual      estimate    calls
identity      816 CU       ~800      4 eth_call, 27 eth_getCode (bisect), 1 blockNumber
windows     1,080 CU     ~1,040      54 eth_getBlockByNumber
pools         480 CU       ~500      8 eth_getLogs, flow probe NOT RUN
scope       2,184 CU     ~2,236      84 eth_call
            --------
             4,560 CU   ~$0.002 for the whole enumeration and scope
```

**Pools: 5,040 candidates — 5,023 v4 from `Initialize`, 17 v3 from the factory.**
(Reconnaissance said 4,856; pools are created continuously, which is why the set
is re-derived every run.) **337 in scope** — 332 v4 and 5 v3 — and 4,703
rejected, **4,603 of them without their symbol being read**, which the persisted
reason states rather than implying the symbol was checked and rejected.

```
in-scope pools by counter    USDG 180    native ETH 150    WETH 7
```

**NVDA is `0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec`, 18 decimals, 13 pools** —
read from the chain, not inferred from a pool name.

**A SECOND token also answers `symbol()` with "NVDA"**:
`0xa90b49763f970d79d6772270c96ac02bc1b71e18`, one pool. Its address ends `1e18`,
a vanity suffix shared by a crowd of junk counters here (`BABYAI`, `SHIB`, `INU`,
`AICAT` all end the same way). **A symbol is a label, not an identity.** Match a
bridge asset by address; never resolve one by symbol.

**What the second pricing hop is worth, measured:**

```
                      pools   swaps in window        candidate wallets
in-scope only           332            49,780  40.9%              694
NVDA pools               12            71,836  59.1%            2,636
other out-of-scope        1                 5   0.0%
union (with the hop)                  121,621                  3,025
```

**The hop is worth 4.4x the cohort** — 694 wallets without it, 3,025 with it,
2,331 wallets that bought AI only against NVDA. It also confirms the
reconnaissance figure of ~56-59% of swaps on the charted pair.

**Transfer density measured** across the AI-P1 window (blocks 18,275,473–
32,206,224), ten evenly spaced 20,000-block samples, 600 CU, **0 size refusals**:

```
mean 0.0308 logs/block   min 0.0066   median 0.0216   max 0.0679   spread 10.3x
```

**AI is 15x sparser than PONS** (0.4669). At the 6,000-log target the natural
span is ~195,000 blocks, so `max_log_span_blocks` at 100,000 — not density — is
what will bound the sweep. The whole 13,930,752-block transfer sweep is
therefore **~140 requests, ~8,400 CU, $0.004**, and the densest sampled region
would still take ~88,000-block spans. There is no dense region to plan around.

Deployed at block 9,721,433, decimals 18. Charted pool `0xcbdfea90…`, AI/NVDA, v4.

- **4,856 pools against 4,481 distinct counter assets** — AI is overwhelmingly
  the *pricing* asset for other tokens rather than the priced one.
- The charted AI/NVDA pool is **56% of its swaps and 59% of the window's**, and
  NVDA is priceable on-chain — this is what the second hop was built for.
- 4,465 of 4,843 v4 pools carry a hook; one launchpad hook covers 4,424. The
  PoolManager still emits its own `Swap` for all of them.
- No bonding curve; first swap 547 blocks after deployment.
- `v4_swaps_all` already covers 59.22% of AI's life and **the whole AI-P1
  window**, but holds no transfers, so attribution still needs a transfer sweep.
- **BONER and CASHCAT trade against AI.** Two of the queued tokens.

---

### CHUMP — `0x0E0d2C89a5a019FE1cF762e5e33187631DACC21B`

**LOADED 2026-09-13, steps 1–17.** "Chump Coin", 18 decimals, supply 1,000,000,000,
deployed at block **23,791,950** (2026-07-31T01:44:31Z), 5,225 bytes of code. Cohort
`CHUMP-P1`, **523 wallets, 3,200 rows AT LOAD**, $779,206 of USD volume.
**142,378 CU = $0.064 for the whole token.**

**THE FIRST TOKEN DRIVEN END TO END THROUGH THE RUNNER, and that is the headline
finding.** PONS, INDEX and AI were loaded with the standalone CLIs, which is a working
path that hides whole classes of defect. Driving one token through `intake.js` from
identity to write surfaced **nine**, listed in section 9, of which four would have
produced a silent wrong answer rather than a failure:

| what it reported | what was true |
|---|---|
| `write: rows_stored 3200`, `intake complete` | **the table was empty** — a swallowed error aborted the transaction and COMMIT silently became ROLLBACK |
| `prices: 0 ticks, 0 buckets, 0 written` in 9 ms | the bounds were `0..0`; the real derivation is 2,331 USD and 271,935 native ticks |
| `conventions: v4 tested 0` — passed | the sample never reached v4, and the after-window region holding 95.6% of the swaps was skipped |
| `routers: probed 0, identified 0` | 4 probed, **3 routers**, two of them absent from the configured list |

**None of these is a chain fact. Every one is the code reporting success over work it
had not done**, which is exactly what this document exists to catch.

```
cohort         523 wallets from 636 candidates: 620 payment-proven, 16 unproven,
               97 contracts excluded, 29 EIP-7702 delegated accounts KEPT
rows           3,200 = buy 1,292 + sell 1,122 + transfer_out 580 + transfer_in 206
               blocks 23,794,012..61,425,727
priced         2,414 of 2,414 trade rows -- ZERO null-USD trades
               786 transfer rows null by definition
usd volume     $779,205.80
scores         522 scored, 1 null, ALL 522 on full weight (1.000)
               min 0.1199  p25 0.1461  median 0.1910  p75 0.2054  p90 0.2194  max 0.5754
flags          inflated-pnl 1, low-weight 0, threshold 0.8 and NOT derivable
watchlist      27 of 27 slots admitted, cutoff 0.2259, max 0.5754
```

```
window CHUMP-P1   23,791,950 .. 44,992,963    21,201,013 blocks
                  2026-07-31T01:44:30+00:00 -> 2026-08-24T12:00:00-04:00
pumps             2026-08-24T12:00:00-04:00, 2026-08-28T12:00:00-04:00
                  BOTH at or after the window end -- intended
charted pool      0x714442e9a611f8561a7df108d6d925132937cfb8  CHUMP/WETH, v3
pools             58 candidates -> 51 in scope, 7 rejected
                  in scope: v4 27 ETH + 18 USDG + 4 WETH = 49;  v3 1 WETH + 1 USDG = 2
rejected          BPRNT, SPY, jkfdjskljf, MEMEINDEX, DFG, TEST, TEST -- all
                  no-usd-reference, one pool each
no bridge needed  every in-scope counter is a recognised pricing asset
bucket anchor     8,963,150 -- the EXISTING residue-3150 grid PONS and INDEX read.
                  CHUMP's deployment sits in bucket 23,783,150, inside PONS's span,
                  so no third residue was created
cost, steps 1-4   2,384 CU total = $0.0011
```

**The window start resolved to the deployment block exactly, and that was luck worth
understanding.** The bound was given as `2026-07-31T01:44:30+00:00`, one second before
the deployment block's own timestamp. `resolveWindows` passes the deployment block as
the search's low bound and `blockForInstant` opens `if (target <= loTs) return lo`, so
it returned 23,791,950 immediately. The same instant searched from block 1 returns
**23,791,940** — the first of the ten blocks sharing that second (section 3). **Two
answers from one instant, and only the clamped one is reachable through the runner.**

**Router detection reported `probed: 0, identified: 0` in the scope phase and it must
not be believed.** Scope runs before the sweep, so there were no transfers to probe —
exactly what the document already records for INDEX. Six configured infrastructure
addresses matched nothing and were reported as such. Detection has to be re-run after
the sweep.

#### Step 6–7 prerequisites: scope RE-RUN after the sweep, 2026-09-13

**Router detection went from `probed: 0` to `probed: 4` purely by running after the
sweep, and it is the first CHUMP result that could not have been obtained before.**
The scope phase was re-run with the new `--redo scope` (section 9) once
`token_swap_logs` held 274,985 rows and `token_transfer_logs` 412,997:

```
duration            762 ms        cost 582 CU   (first run: 478 CU, kept as scope:superseded)
calls               18 eth_call, 4 eth_getCode, 1 eth_blockNumber
routers probed        4   identified 3   rejected 1
in scope             51   rejected 7     -- unchanged from the first run, as expected
```

| address | recipients | sends | in a swap tx | code | verdict |
|---|---|---|---|---|---|
| `0xda549474…` | 502 | 513 | **0.0%** | **eoa** | **not a router** — a distributor |
| `0x5a705de8…` | 118 | 251 | **100.0%** | contract | router — **not in the configured list** |
| `0xb92fe925…` | 94 | 276 | **100.0%** | contract | router — in both |
| `0x39b38686…` | 88 | 162 | **100.0%** | contract | router — **not in the configured list** |

**The discriminator separates as cleanly here as it did on PONS: 100.0%, 100.0%,
100.0% against 0.0%, with no candidate anywhere in between.** The 0.0% address is
also an EOA, so it fails two of the three parts independently — a distributor moving
CHUMP to 502 recipients that would have been excluded as a router by any
recipient-count rule alone.

**Two routers the hand-typed list does not contain.** Had the cohort been built from
`config/infrastructure.yaml` alone — which is what happens when detection runs in the
scope phase before the sweep — trades routed through `0x5a705de8…` and
`0x39b38686…` would have been attributed to the routers instead of to the buyers.
That is the PONS defect exactly, and CHUMP is the **first token where it was caught
before the cohort was built** rather than after.

**Five configured entries matched nothing, and three of those five are structural
rather than a finding.** The v4 PoolManager and the zero address are removed from the
candidate query by construction — `detectRouters` excludes the counterparty set and
the zero address before grouping — so they can never appear in the behavioural set,
and the burn address sent no CHUMP. Only `0xb01ca24b…` and `0x8876789976…` are
genuine "listed but not supported by this token's behaviour". **Report the five, and
say which kind each is**, or a structural exclusion reads as a stale list entry.

**The cohort work set, derived before spending anything:**

```
swap transactions in window        10,219
candidate transactions              6,364
CANDIDATE WALLETS                     642   <- the figure the cost is quoted from
payment, 642 x 17.1 CU             ~11,000 CU     worst case 642 x 8 x 30 = 154,080
eth_getCode, <=642 x 26 CU         ~16,700 CU
                                  ----------
realistic                          ~28,000 CU  ~$0.013    ceiling 400,000
```

**642 candidates against PONS's 16,910 is the scale CHUMP actually is**, and it is why
its cohort step costs a twenty-fifth of PONS's. Quote the cost from this count, never
from another token's.

#### Steps 6–17 as measured, 2026-09-13

**Sign conventions: unanimous, 1,944 of 1,944, and this is the first token where the
v3 side carried the weight.** Every earlier measurement of the v3 POOL convention was
made on a v4-dominant token.

| venue | region | in region | sampled | tested | agreeing | convention |
|---|---|---|---|---|---|---|
| v3 | in-window | 12,013 | 800 | 380 | **380** | pool |
| v4 | in-window | 18 | 18 | 18 | **18** | swapper |
| v3 | after-window | 252,250 | 800 | 792 | **792** | pool |
| v4 | after-window | 10,704 | 800 | 754 | **754** | swapper |
| both | before-window | **0** | — | — | — | **RETURNED NO ROWS** |

**before-window is empty because the window starts at the deployment block**, which
the low-bound clamp guarantees — so `firstBlock..startBlock-1` is
`23,791,950..23,791,949`, empty by construction rather than by absence of trading.
Say so; do not omit the line.

**The cohort, and it reconciles exactly:**

```
candidate wallets for payment       636      (derived 642 before the run, from SQL)
  proven free from token_payment_logs  0     <- REPORTED, not omitted; see below
  proven over RPC                    620
  no payment in any transaction       16     636 = 620 + 16
code-checked at the window's END block 620
  excluded as deployed contracts      97
  EIP-7702 delegated accounts KEPT    29
COHORT                                523     620 - 97 = 523
excluded earlier: infrastructure 285, round-trippers 1,806, pools 1
unused exclusions: 0xb01ca24b... matched nothing -- reported
```

**`token_payment_logs` proved 0 of 636, against 12.8% on PONS, and that is expected
rather than a defect.** It names wallets that sent a pricing asset straight to a
*PONS* pool; a CHUMP buyer appears only if they also bought PONS. **The zero is
reported because a fast path matching nothing is indistinguishable from one that never
ran** — and step 7 already says it is not worth sweeping for a new token.

**Costs $0.013 where PONS cost $0.11**, because the cost is the candidate count and
CHUMP has 636 against PONS's 16,910. Quote it from the count, never from another token.

**Timestamps cost NOTHING: 2,911 needed, 2,911 already stored, 0 to fetch.** The v3
sweep carried `blockTimestamp` with every log, which is what the Alchemy route buys.
Contrast AI, whose copied v4 swaps needed 7,945 blocks filled at $0.07. **A token
swept rather than copied pays nothing here**, and that is now measured rather than
assumed.

**Prices, and CHUMP HAS ALMOST NO USD MARKET OF ITS OWN:**

```
                    swaps    pools
v3 WETH           264,263        1   <- the charted pool, 96.1% of all swaps
v4 ETH              8,388       20
v4 USDG             2,331        8   <- 0.85%
v4 WETH                 3        2
```

```
usd ticks     2,331   discarded by the 100x fence   0
native ticks 271,935  discarded by the 100x fence   0
derived native buckets 49         discarded by the 10x fence  0   <- the soundness signal
chump_usd_prices      49 buckets, 45,293,150..61,693,150, $0.0108..$0.2434
buckets with no USDG side       2,231
native buckets NOT written      49    -- CHUMP does not own the chain's series
```

**Its own USD series covers 1.3% of its life and NONE of its cohort window.** All 49
buckets sit after block 45,293,150; the window closes at 44,992,963. **This does not
affect a single row's USD**, because a trade row is priced from the counter side
through `native_usd_prices`, and that series covers CHUMP's life **completely — 3,791
of 3,791 buckets at residue 3150**. It affects only the dashboard's price line for the
early era, exactly as it does for INDEX.

**The price trajectory, hand-computed and cross-checked, is in step 10** — $0.0000022
at the first swap to $0.0425 at head, with the WETH route and a direct USDG quote
agreeing to **0.23%** in the one era where both exist. That comparison is what proved
the row prices right when the price-range gate rejected them.

**Rows: 3,200 planned, 3,200 stored, no loss to the unique key.** PONS lost 13,341
transfers to the key before `log_index` was added; CHUMP loses none, which is the fix
holding on a token whose transfers were collected from the start.

**522 of 523 cohort wallets have rows, and the one that does not is fully explained.**
`0x096fc56b…` received **0.51297777 CHUMP** from the charted pool at block 40,849,735
and sent the identical amount back 32 blocks later. At that era's price (~$0.00149)
each leg is worth **$0.0008**, below the **$0.01 USD floor**, so both were dropped. It
is a genuine, payment-proven buyer whose entire activity is worth less than a cent —
the floor doing its job, not a wallet lost.

**Scores: the cleanest weight distribution of any token here.** All 522 scored wallets
sit at `weight_used = 1.000`; none is partial. That follows directly from every trade
row being priced — no money metric is ever null, so nothing drops out and nothing
renormalises. **The `low-weight` threshold therefore cannot be derived and 0.8
stands**, the same result AI and INDEX-P2 reached for the opposite reason: AI had one
partial weight and no gap, CHUMP has no partial weights at all.

```
min 0.1199   p25 0.1461   median 0.1910   p75 0.2054   p90 0.2194   max 0.5754
1 null score -- the zero-row wallet above, every metric null, correctly unranked
flags: inflated-pnl 1, low-weight 0
```

#### METRIC 5 SEPARATES HERE, AND ITS CEILING IS STRUCTURAL

**The document asked for this to be watched on every token, and it has now repeated.**
PONS: >75% at zero, maximum exactly **1/3** on three pumps. CHUMP, measured rather than
predicted:

```
pre-pump share exactly 0      350   67.0%
strictly between 0 and 0.5     53   10.2%
exactly 0.5                   119   22.8%
MAXIMUM                       0.5 = 1/2, on TWO pumps
```

**"A maximum landing exactly on 1/n_pumps is the signature" — it has now landed there
twice, on two tokens with different pump counts.** But CHUMP explains WHY, and the
explanation is not a data artefact:

**Both of CHUMP's pump points are at or after the window end, and pump 1 IS the window
end** (`2026-08-24T16:00:00Z` for both). A wallet only enters the cohort by buying
inside the window; the window closes at pump 1; so **no wallet can possibly have bought
in the 48 hours before pump 2, which is four days later. The metric's ceiling is 1/2 by
construction, and no cohort member can ever exceed it.**

**The general rule as it was written here: metric 5's maximum is bounded by the number
of pump points a cohort member can physically precede, over the total number of pumps.**

**HALF OF THAT WAS THE MEAN, AND IT WAS CORRECTED ON 2026-09-14.** Two separate things
were producing CHUMP's 0.5 and this section conflated them:

- **Real, and still true:** both pumps sit at or after the window end and pump 1 **is**
  the window end, so no cohort member can have bought in the 48 hours before pump 2.
  Pump 2's share is structurally zero for every wallet here.
- **An artefact of the aggregation, now gone:** dividing by `shares.length` — the total
  number of pumps, including the one no wallet could precede — turned "everything I
  bought was inside pump 1's window" into **0.5** rather than 1.0.

**Under the maximum, CHUMP's 119 ceiling wallets read 1.0.** Their behaviour has not
changed and neither has the window-end fact; what changed is that the metric no longer
divides a wallet's answer by a count of pumps that answer could never reach. **The
separation this section reports — 67% at zero against 23% at the ceiling — is
unaffected, because a monotone rescaling of the top group cannot reorder it.**

The surviving caution is worth keeping: read a pre-pump share against where the pumps
sit relative to the window before calling it weak signal. On CHUMP it is not weak.

**And unlike PONS, it does separate.** 119 wallets at the ceiling against 350 at zero
is a real 23%/67% split of the cohort, with 53 in between. The 5% weight is not wasted
here. **Report the distribution; do not infer it from the maximum.**

**Watchlist: CHUMP added 27 slots and the merged list moved by 28 added / 1 removed**,
going 1,248 → **1,275 memberships** and 1,151 → **1,181 distinct wallets**. Its cutoff
of **0.2259** is the lowest of the five windows — below AI's 0.2644 and well below
PONS's 0.4546 — which is the cross-window incomparability this document already
warns about, appearing again on a fifth window rather than a new finding.

Invariants on a fresh connection, all zero: memberships with no score **0**, with no
tag **0**, with a rank above their slot count **0**, null scores admitted **0**, and
exactly **1** distinct `top_percent`.

**Dashboard, verified by executing the served page in jsdom:** tab `CHUMP 523`, count
line **"523 of 523 wallets · 3200 transactions"** matching the database exactly, 100
rows on page 1 of 6, 0 unscored, **0 on a partial weight**, all **8 of 8 metrics
contributing and 0 dropped as null**, and the row-expansion API call carrying CHUMP's
own mint. The page is now **8.93 MB** with four tokens, against 4.92 MB recorded when
there were three.

**What surprised me, and both were my errors rather than the chain's:**

1. **I called the v3-only premise contradicted on pool count, and pool count is the
   wrong measure.** See the V3-ONLY subsection — this is the most transferable lesson
   from CHUMP.
2. **I reported the bisection as returning 23,791,940 from a standalone check that
   passed the wrong low bound.** The runner returns the deployment block. A
   reimplementation of a rule that already exists in the code will disagree with it;
   that is the "two implementations of one rule" trap in step 7, in miniature.

---

### V3-ONLY: what differs from the v4 path — written for CASHCAT

CHUMP is the first token whose market is v3. Read this before loading another.

#### WEIGH THE VENUE SPLIT BY SWAPS, NEVER BY POOL COUNT

**This is step 3's own rule — "Weigh it by swaps, not by pool count" — and it still
misled on first application, because pool count is what the enumeration phase reports
and swaps are not.** The numbers:

```
                 pools in scope   swaps in v4_swaps_all   swaps, FULL LIFE (swept)
v4                           49            13                    10,722    3.9%
v3                            2       n/a (not covered)         264,263   96.1%
```

**The 13 was a coverage artefact and I reported it before the sweep corrected it.**
`v4_swaps_all` stops at 42,695,454 and CHUMP's v4 activity is almost entirely after
it, so the free query saw 13 swaps where the full-life sweep found **10,722**. The
conclusion survives — v3 carries **96.1%** of CHUMP's swaps — but the margin is 20x
narrower than the free query implied, and v4 at 3.9% is not negligible. **State the
coverage limit AND treat the figure as a lower bound until the sweep replaces it.**

By pools, CHUMP is **96% v4** and looks like AI. By swaps, its 49 v4 pools carry
**thirteen swaps between them**, all in blocks 39,893,773–40,843,977, and everything
that matters happens on two v3 pools. **I reported the premise contradicted on the
pool count before measuring the swaps, and had to withdraw it.** The v4 pools are
vanity or spam pools created against the token; a token can accumulate dozens of them
without a single trade.

**The measurement is nearly free and there is no excuse for skipping it.**
`v4_swaps_all` already holds every v4 swap on the chain for 15,115,267–42,695,454, so
counting a candidate token's v4 swaps is one SQL query against stored data, no RPC:

```sql
select count(*), count(distinct pool_id) from v4_swaps_all
 where pool_id in (select pool from pool_meta
                    where chain='robinhood' and token=$1 and venue='v4');
```

**State the coverage limit with the result.** That query says nothing about blocks
after 42,695,454 — for CHUMP, 2.3M of its window and everything since. A zero there
would be a coverage artefact, which is the trap recorded against `v4_swaps_all` in the
INDEX findings.

#### The v4_swaps_all shortcut applies and is worthless here

CHUMP's window overlaps `v4_swaps_all` for 23,791,950–42,695,454 — **89% of it** — so
the copy shortcut is available, contradicting the assumption that a v3 token cannot use
it. It delivers **13 swaps**. Copy anyway, because it is free and it is what router
detection's swap-share discriminator divides by, but do not size any estimate around it.

#### WHAT A v3-DOMINANT TOKEN CHANGES DOWNSTREAM — measured on the full load

The venue split does not stop mattering at the sweep. Four consequences, none of
which is obvious from the pool list:

1. **The conventions sample must be taken per venue.** A v3-dominant token's early
   blocks contain no v4 swaps at all — CHUMP's v3 starts at 23,794,012 and its v4 at
   39,893,773 — so one `limit 800` ordered by block returns 800 v3 rows and never
   reaches v4. See step 6; this is the defect it produced.
2. **Timestamps are free.** The v3 sweep carries `blockTimestamp` on every log, so a
   swept token needs **0 blocks filled**, against AI's 7,945 at $0.07 for copied v4
   swaps. **The `v4_swaps_all` shortcut trades a timestamp bill for a sweep bill**, and
   on a v3 token there is nothing to copy anyway.
3. **The cohort query is direct.** A v3 pool contract IS the transfer counterparty, so
   the buyer is found without the PoolManager indirection that cost the first PONS
   cohort 3,067 wallets.
4. **The token may have no USD market of its own.** This is the one to plan for.

#### A v3 TOKEN'S OWN USD SERIES MAY COVER ALMOST NONE OF ITS LIFE

**CHUMP's `chump_usd_prices` is 49 buckets — 1.3% of its life, all of it after the
cohort window closed.** 96.1% of its swaps sit on a single v3 **WETH** pool and only
0.85% are USDG-quoted, so there is almost nothing to derive a token/USD tick from.

**This costs nothing at row level and everything at check level.** A trade row is
priced from the COUNTER side through `native_usd_prices`, which is chain-level and
market-derived, and covered CHUMP's life completely — **3,791 of 3,791 buckets**. Every
one of its 2,414 trade rows is priced. What broke was the write phase's price-range
gate, which compared rows against the token's own global tick range (step 10).

**Before loading another v3 token, ask the cheap question first:** what share of its
swaps are quoted against the USD asset? One SQL query over `token_swap_logs` joined to
`pool_meta` answers it, and it predicts both the sparse own-series and the dashboard's
blank early price line. **The rows are fine either way; the checks and the display are
what to expect.**

#### THE ROUTER SET IS SMALL AND CLEANLY SEPARATED

**4 candidates cleared the 50-recipient bar, against PONS's 62 and INDEX's 40**, and
the discriminator separated perfectly: **100.0%, 100.0%, 100.0% against 0.0%**, with
nothing in between. The 0.0% address is also an EOA, so it fails two of the three parts
independently.

**Two of the three routers are absent from `config/infrastructure.yaml`**, which is the
PONS defect caught before the cohort was built rather than after. **Run detection after
the sweep on every token** — `npm run intake -- <cfg> --redo scope` now exists for
exactly this.

#### Rules that applied UNCHANGED

- **Decimals read, never assumed.** CHUMP returned raw `0x…12` = 18.
- **The charted pool is recorded and never filtered on.** It is 1 of 51 in scope.
- **Scope applies once, to both venues.** 51 of 58 in scope, 7 rejected with reasons
  recorded before any swap was read.
- **A counter whose `decimals()` cannot be read raises.** All 10 distinct counters
  resolved; none was a stablecoin other than USDG.
- **The bucket anchor prefers an existing grid.** CHUMP reuses 8,963,150.
- **Router detection must run after the sweep.** It reported 0 probed inside scope.

#### Rules that are v4-SPECIFIC and did not apply

- **The 500-id topic-array chunking rule DID NOT APPLY to the v3 sweep at all.** v3
  filters by pool **address** in `eth_getLogs`'s `address` field, not by a topic array,
  so the 540-accepted / 5,024-hangs measurement is irrelevant to it. It still applies
  to CHUMP's 49 v4 pools, which fit in one chunk regardless.
- **`Initialize` completeness** is a v4 property. v3 pools come from the factory's
  `PoolCreated` plus, optionally, the flow probe.
- **"A v4 pool is never a transfer counterparty — the PoolManager is."** On the v3 path
  the pool contract **is** the counterparty, which makes the cohort query direct and
  removes the failure that cost the first PONS cohort 3,067 wallets.

#### Density: measured from the deployment block, and it varies by 91x

**Probe the blocks you will actually read.** Measured with `sweep-probe`, three 300,000
block samples plus six 100,000-block window samples:

```
23,791,950 (deployment)   145 logs / 300k    0.0005 /block
27,000,000                  0 logs / 100k    0
30,000,000                  0 logs / 100k    0
34,000,000                  0 logs / 300k    0
39,800,000                121 logs / 100k
40,800,000                246 logs / 100k
44,000,000                242 logs / 100k
44,892,964 (window end)   631 logs / 100k
61,300,000 (near head) 13,718 logs / 300k    0.0457 /block   <- 91x the deployment rate
```

**THREE MID-WINDOW SAMPLES RETURNED ZERO.** CHUMP was dormant from roughly 24M to
39.8M — inside its own cohort window — then woke and ramped, and is densest well after
the window closed. A ceiling or a span sized from the deployment block would have been
91x too generous; one sized near head, 91x too tight. **The window is real but
back-loaded into its last ~5M blocks**, which is where the cohort will come from.

#### The sweep, measured

```
duration            788,104 ms = 13.1 min
cost                111,190 CU = $0.050   against ~56,880 CU / $0.026 estimated -- 1.95x
logs                v3 264,263   v4 10,722   transfers 412,997
coverage            all three streams 61,698,121 / 61,698,121 blocks, 0 gaps, 0 overlaps
```

**The 1.95x overrun is entirely explained and it is not density: the runner swept from
block 0, not from the deployment block.** `expectedBlocks` is 61,698,121 — the whole
chain — where the estimate assumed 37.88M from block 23,791,950. **23.8M blocks before
the token existed were swept and can only ever return zero logs**, about 238 wasted
requests, ~14,280 CU, $0.0064. The rest of the overrun is the same arithmetic applied
to a range 1.63x larger than estimated. Step 5 says "sweep full chain life"; the runner
reads that as the CHAIN's life rather than the TOKEN's. Sizing any future estimate from
the deployment block while the runner starts at zero will be wrong by the ratio of the
two.

**Span sizing is capped, not density-driven, for this token.** At 0.0005–0.0457
logs/block the 6,000-log target implies spans of 76,394 to 200,000,000 blocks, so
`max_log_span_blocks` at 100,000 binds almost everywhere: **≈1 request per 100,000
blocks.** Sweep estimate from those blocks: transfers over 37.88M blocks ≈379 requests,
v3 `Swap` on 2 pools ≈379, the v4 gap 42.70M→head ≈190 — **≈56,880 CU ≈ $0.026**
against a 2,000,000 ceiling.


### CASHCAT — `0x020bfC650A365f8BB26819deAAbF3E21291018b4`

**IN PROGRESS 2026-09-14. Steps 1–11 COMPLETE; step 12 RAISED on its own price gate
and nothing is written.** Cohort `CASHCAT-P1` is tagged at **2,245 wallets** with its
`token_windows` row; `wallet_transactions` is **0**. Total **327,660 CU = $0.147**.
"Cash Cat", 18 decimals, supply 1,000,000,000, deployed at block **88,836**.

**CASHCAT IS BY FAR THE EARLIEST TOKEN THIS PIPELINE HAS LOADED**, and almost
everything below follows from that. Its deployment block is **88,836** against
INDEX's 1,670,725, PONS's 8,963,150, AI's 9,721,433 and CHUMP's 23,791,950 — it
predates the next-earliest token by a factor of nineteen, and sits only 38,120 blocks
after the earliest WETH/USDG pool on the chain (50,716).

```
window CASHCAT-P1   846,162 .. 3,789,108      2,942,946 blocks
                    2026-07-01T16:00:00-04:00 -> 2026-07-07T16:00:00-04:00
pumps               2026-07-07T16:00:00-04:00  <- IS the window end
                    2026-08-03T20:00:00-04:00, 2026-08-19T16:00:00-04:00
charted pool        0xa70fc67c9f69da90b63a0e4c05d229954574e313  CASHCAT/WETH, v3
head at identity    62,148,338
```

#### THE CHARTED POOL IS v3 AND THE TOKEN IS NOT — the CHUMP lesson in reverse

**CHUMP looked 96% v4 by pool count and was 96.1% v3 by swaps. CASHCAT is the mirror
image: it was handed over as a v3 token because its CHARTED pool is v3, and its v4
side is enormous.** Measured from `v4_swaps_all` against its 920 enumerated v4 pool
ids, before any sweep:

```
candidates                     1,001   920 v4 from Initialize, 81 v3 from the factory
v4 swaps in v4_swaps_all     879,297   across 296 of those 920 pools
   ...spanning                          15,115,267 .. 42,695,199
   ...inside CASHCAT-P1              0  <- A COVERAGE ARTEFACT, NOT A MEASUREMENT
```

**Both numbers have to be read with their limits or they mislead in opposite
directions.** 879,297 is a **lower bound** — `v4_swaps_all` stops at 42,695,454 and
says nothing about the 19.5M blocks since. And the **0 inside the window is not a
finding at all**: the window closes at 3,789,108 and the table begins at 15,115,267,
so the window sits **11.3 million blocks below anything that table can see**.

**THE PRE-SWEEP VENUE MEASUREMENT THE V3-ONLY SUBSECTION RECOMMENDS IS IMPOSSIBLE FOR
THIS TOKEN, and saying so is the result.** That subsection tells the next token to
weigh the split by swaps using one free SQL query against `v4_swaps_all`. For CHUMP
that worked because its window overlapped the table by 89%. For CASHCAT the overlap is
**zero**, so the free query can only describe a period the cohort does not come from.
**The window's split cannot be known until the sweep, and no estimate should be sized
against the covered range instead.**

**What is already certain is that v4 is not negligible here**, which is the opposite
of CHUMP, so none of the "v4-specific rules that did not apply" in the V3-ONLY
subsection can be assumed away.

#### THE ETH/USD SERIES DOES NOT REACH THIS TOKEN, and it was checked before the run

**The chain's residue-3150 ETH/USD series starts at bucket 1,663,150. CASHCAT's window
opens at bucket 843,150 and its life at bucket 83,150.** The first **816,988 blocks of
the window — 27.8% of it — have no ETH/USD bucket at any residue**, and neither does
the 757,326 blocks of life before the window.

```
bucketOf(block, 10000, 8963150) = 8963150 + floor((block - 8963150)/10000)*10000
  deployment  88,836     -> bucket    83,150     158 buckets below the series
  window start 846,162   -> bucket   843,150      82 buckets below the series
  series starts          -> bucket 1,663,150
```

**The arithmetic below the origin is correct and that was verified rather than
assumed** — `Math.floor` is true floor division, so a block below the anchor still
lands on residue 3150 at or below itself. The gap is in the DATA, not the lookup,
which is precisely the distinction the INDEX findings draw.

**It is recoverable, and cheaply, for the same reason INDEX's 6,052 were.** The
earliest WETH/USDG pool on this chain was created at block **50,716** — 38,120 blocks
*before* CASHCAT exists — so a USD-denominated ETH market runs alongside this token
for its entire life. The series simply was never extended that far back because no
loaded token needed it. `eth-usd-series` already does this job and cost $0.0193 to
cover 7.8M blocks; extending it below 1,663,150 is the same job over a smaller range.

**DONE 2026-09-14, and the window is now completely covered.** Approved and run as
`eth-usd-series --from 83150 --to 1663149 --ceiling 50000 --commit`:

```
                       BEFORE            AFTER
series head, residue 3150   1,663,150         83,150      +140 buckets (6,083 -> 6,223)
CASHCAT-P1 buckets     213 of 295 covered   295 of 295    0 missing
CASHCAT-P1 blocks below the head   816,988 (27.8%)    0
buckets missing over CASHCAT's LIFE      158            18
```

```
buckets derived            140      ticks kept 23,889   discarded by the 10x fence 0
inserted                   140      already present 0 -- nothing was rewritten
ETH/USD            $1,198.69 - $2,591.09    median $1,627.24
ticks per bucket   median 161, mean 171, MINIMUM 1
cost                     3,600 CU = $0.0016    60 eth_getLogs   ceiling 50,000
```

**The 10x fence discarded ZERO of 23,889 ticks**, which is the soundness signal step 10
names, and the range $1,199–$2,591 sits inside the $1,239–$2,653 the chain's older
buckets already span.

**DENSITY WAS PROBED OVER THE BLOCKS ACTUALLY READ, and it varies by 165x inside the
target range alone:**

| probe | blocks | market swaps | per block |
|---|---|---|---|
| 83,150–283,149 | 200,000 | **24** | **0.00012** |
| 700,000–900,000 | 200,001 | 3,981 | 0.019905 |
| 1,400,000–1,663,149 | 263,150 | 4,363 | 0.016580 |

**Only THREE market pools existed in the earliest sample** against 819 today, which is
why it is so sparse. Even the densest sample implies a 301,500-block natural span, so
**the 100,000-block cap binds everywhere** and the request count is set by blocks
rather than by density — 16 per filter. Estimated ~3,360 CU, spent 3,600: **7% over**,
the tightest sweep estimate recorded here, precisely because a cap-bound sweep does not
depend on the density that has been wrong three times.

**EIGHTEEN BUCKETS REMAIN MISSING AND THEY ARE REPORTED RATHER THAN CHASED.** They sit
in **93,150–743,150**, the sparse early region where the market barely traded, and
they are **all below the window's first bucket at 843,150** — so no cohort-window row
can go unpriced for want of a rate. Gaps stay gaps: a bucket with no market trade is
not interpolated and not carried forward.

**The thinnest new bucket rests on ONE tick.** That is the provenance this document
elsewhere calls measurably wrong — but the comparison that condemned those was
token-incidental buckets against the market, and these ARE the market. Where the
market traded once in 10,000 blocks, one tick is the best measurement that exists, and
the alternative is no price at all. **Recorded so a thin early CASHCAT price is
expected rather than surprising.**

**Doing this BEFORE the rows exist is the point.** INDEX's 6,052 nulls were written
first and repaired afterwards; CASHCAT's window is covered before a single row is
written, so there is nothing to reinsert and no window of history that was briefly
wrong. `intake/index.yaml`'s false coverage claim is the cautionary case — **a config
asserting a series covers a token must be checked against the series** — and CASHCAT's
config said the reach was one bucket from the window and must be verified, which it
now has been.

#### Scope: 590 of 1,001 in scope, and NO BRIDGE IS NEEDED

```
duration  2,297 ms    cost 2,714 CU    104 eth_call (52 distinct counters x 2) + 1 head

IN SCOPE  590                      REJECTED 411
  v4 ETH    274                      symbol NOT READ, outside the cap   236
  v4 USDG   272                      symbol read, not a pricing asset   175
  v4 WETH    37                    top rejected counters:
  v3 WETH     4                      TENDIES 30, FRONG 19, Index 15, GME 14,
  v3 USDG     3                      PONS 10, AI 10, STONKBROKER 6
```

**`no_usd_route: false` and `no_native_route: false`, so CASHCAT needs no bridge** and
the second hop does not apply. 590 pools quote it against WETH, USDG or native ETH
directly. That was the one thing worth stopping for and it did not arise.

**ONLY 7 OF 590 IN-SCOPE POOLS ARE v3**, which is the pool-count view again and is not
the venue split. The charted pool `0xa70fc67c…` is one of the four v3/WETH pools, is in
scope, carries `pons_side 0`, and is recorded rather than filtered on.

**CASHCAT trades against INDEX (15 pools), PONS (10) and AI (10), and all three are
correctly REJECTED.** The document already noted that "BONER and CASHCAT trade against
AI"; scope shows the relationship is real and excludes it anyway, because AI is not a
recognised pricing asset and no bridge is configured for this token. That is step 4's
recursive rule holding — pricing CASHCAT through AI would price a memecoin against a
memecoin.

**The 236 pools whose counter symbol was NOT READ cannot hide a pricing asset, and
that is structural rather than lucky.** In-scope membership is decided by the counter's
ADDRESS against the configured pricing assets, so a WETH, USDG or native-ETH pool
matches before any symbol is read; the read cap only limits whether a *rejected*
counter can be NAMED. The phase says "NOT READ" rather than implying the symbol was
checked and rejected, which is the distinction step 4 requires.

**One counter outside the pricing set has 9 decimals** — `REWARDS`, one pool, rejected.
Recorded because it is the third non-18 decimals counter this chain has produced after
USDG's 6 and PONTIFUL's 6, and it is why decimals are read rather than assumed.

#### Density: probed from the deployment block, and the cap does NOT bind everywhere

**CHUMP's sweep was cap-bound almost everywhere; CASHCAT's is not.** Seven samples
across the range actually to be swept, 15 requests, ~900 CU:

| range | blocks | logs | logs/block |
|---|---|---|---|
| 88,836–388,836 (deployment) | 300,000 | 2,076 | 0.0069 |
| 846,162–946,162 (window opens) | 100,000 | 3,129 | 0.0313 |
| 2,000,000–2,100,000 (mid-window) | 100,000 | 524 | **0.0052** — the floor |
| 3,689,108–3,789,108 (window closes) | 100,000 | 1,290 | 0.0129 |
| **10,000,000–10,100,000** | 100,000 | **30,063** | **0.3006** — the peak |
| 30,000,000–30,100,000 | 100,000 | 15,116 | 0.1512 |
| 61,900,000–62,000,000 (near head) | 100,000 | 5,019 | 0.0502 |

**The spread is 58x and the peak is nowhere near either end** — it is at ~10M, six
million blocks after the window closed and fifty million before head. At 0.3006
logs/block the 6,000-log target implies a **~20,000-block span**, so the sweep narrows
there rather than running at the 100,000 cap. **A density taken from the window would
have been 58x too generous and one taken near head 6x too generous**; this document
has recorded the same error at 16x on AI and 27% on INDEX, and CASHCAT is the widest
spread yet.

**Sweep estimate, stated before the first request**, and note the v4 chunking term
that CHUMP's 49 pools never exercised:

```
transfers, density-varying spans                    ~1,320 requests
swap-v3, 7 pool addresses, cap-bound                  ~621
swap-v4, 583 pools = 2 CHUNKS of 500, cap-bound     ~1,242   <- 2x for the chunking
                                                    -------
                                                    ~3,183 requests x 60 CU
                                                   ~191,000 CU  ~$0.086
                                          ceiling    800,000 CU  (4.2x headroom)
```

#### The deployment-block sweep saved 240 CU here, and that CONFIRMS the rule

CHUMP's block-0 sweep wasted **42,660 CU**. CASHCAT's saving is
`ceil(88,836 / 100,000) = 1` request per stream-pass across four passes — transfer,
v3, and v4 twice for its two chunks — so **4 requests, 240 CU, $0.0001**.

**That is the rule in step 5 confirmed from the other end of the range.** The waste
scales with how LATE a token launched, and CASHCAT launched at block 88,836. The fix
that saved CHUMP 30% of its entire intake saves CASHCAT almost nothing — and both
figures come from the same formula, which is what makes it a rule rather than an
anecdote.

#### The sweep, measured — and the VENUE SPLIT that overturns the premise

```
duration   11,986,177 ms = 199.8 min      cost 218,230 CU = $0.098
calls      3,637 eth_getLogs + 1 eth_blockNumber   (3,637 x 60 + 10 = 218,230, exact)
logs       v3 2,388,973   v4 1,991,868   transfers 10,576,687   TOTAL 14,957,528
coverage   all three streams 62,064,096 / 62,064,096 blocks, 0 gaps, 0 overlaps
ranges     swap-v3 672, swap-v4 650, transfer 1,644
           BELOW THE DEPLOYMENT BLOCK: 0, 0, 0   <- CHUMP had 711
```

**THE VENUE SPLIT, AND IT IS DIFFERENT IN THE WINDOW FROM OVER THE TOKEN'S LIFE.**
Both figures matter and reporting only one would mislead:

| | v3 | v4 | |
|---|---|---|---|
| **full life** | 2,388,973 — **54.5%** | 1,991,868 — **45.5%** | near-balanced |
| **inside CASHCAT-P1** | 17,314 — **86.3%** | 2,741 — **13.7%** | v3-dominant |
| pools that actually traded | **6** of 7 in scope | **398** of 583 in scope | |

**The cohort comes from the window, where v3 carries 86.3%. The cost basis and
realised PnL come from the whole life, where v4 carries 45.5%.** A token can be
v3-dominant for its cohort and half-v4 for its accounting, and CASHCAT is the first
here to show it. **Quote the split for the period you are about to use it for.**

**THE PRE-SWEEP LOWER BOUND WAS 2.3x LOW, EXACTLY AS THE RULE SAYS IT WOULD BE.**
`v4_swaps_all` gave 879,297 v4 swaps before the sweep; the sweep found **1,991,868**.
The V3-ONLY subsection's instruction — *treat the figure as a lower bound until the
sweep replaces it* — was written from CHUMP, where the gap was 13 against 10,722.
Here it is 879,297 against 1,991,868. **The rule held on a token where the shortcut
could not see the window at all.**

**One v3 pool of the 7 in scope never traded, and 185 of the 583 v4 pools never
traded.** Reported rather than omitted: a pool in scope with no swaps is a real
result, and it is what makes "pools in scope" the wrong denominator for a venue split.

#### The deployment-block fix, confirmed from stored data

**`token_sweep_progress` holds 2,966 ranges and NONE of them lies below block 88,836.**
CHUMP's sweep had **711** such ranges returning 0 logs between them. The saving here is
`ceil(88,836 / 100,000) = 1` request across four stream-passes — transfer, v3, and v4
twice for its two chunks — so **4 requests, 240 CU, $0.0001**.

**That is the rule confirmed from the opposite end of the range.** CHUMP wasted 42,660
CU because it launched at block 23.8M; CASHCAT wastes 240 because it launched at
88,836. Same formula, 178x apart, and the fix that saved CHUMP 30% of its whole intake
saves CASHCAT a hundredth of a cent. **The waste scales with how LATE a token
launched** — measured now at both ends rather than argued at one.

#### Router detection after the sweep: 7 probed, 6 identified, 5 of them NEW

```
duration 5,774 ms   cost 2,896 CU   104 eth_call + 7 eth_getCode + 1 head
```

| address | recipients | sends | in a swap tx | code | verdict |
|---|---|---|---|---|---|
| `0xb92fe925…` | 338 | 982 | 99.1% | contract | router — **in both** |
| `0x0579fa41…` | 79 | 444 | 75.5% | contract | router — **new** |
| `0xb477751b…` | 75 | 469 | 99.1% | contract | router — **new** |
| `0x5a705de8…` | 70 | 138 | 100.0% | contract | router — **new** |
| `0xe72688f7…` | 62 | 753 | 100.0% | contract | router — **new** |
| `0x350eb177…` | 56 | 1,155 | 78.3% | contract | router — **new** |
| `0x73991a25…` | 51 | 187 | **0.0%** | contract | **NOT a router** — a distributor |

**The discriminator separated cleanly for the fourth token running: 75.5–100% against
0.0%, nothing in between.** And the rejected address is corroboration rather than a
new measurement — `0x73991a25…` appears in step 7's own router table at **0.0% on
PONS**, where it moved 6,467 sends to 1,097 recipients. **The same address behaves the
same way on two tokens four months and eight million blocks apart**, which is the
strongest evidence yet that the 50% bar is cutting at a real boundary rather than a
convenient one.

**Five of the six routers are absent from `config/infrastructure.yaml`**, against two
of three on CHUMP. **All six are persisted** — verified on a fresh connection — so the
cohort will exclude them. Five configured entries matched nothing, three of them
structurally (PoolManager, zero, burn) for the reasons CHUMP's section records.

#### The cohort work set, derived before spending — AND THE RUN STOPPED BEFORE IT

```
swap transactions in window     17,829
candidate transactions          10,988
CANDIDATE WALLETS                2,360   <- the figure the cost is quoted from
  payment   2,360 x 17.1 CU  =  40,356 CU
  getCode  <= 2,360 x 26 CU  =  61,360 CU
  realistic                  ~101,716 CU = $0.046    ceiling 400,000 (3.9x headroom)
  worst case, 8 tx per wallet ~566,400 CU  <- EXCEEDS the ceiling
```

**The worst case exceeds the ceiling and that is stated rather than hidden.** It
assumes every wallet fails all eight of its candidate transactions; CHUMP measured 16
of 636 — **2.5%** — so the realistic figure governs. If it ever trips, the ceiling
stopping the phase and naming where is the guard working, not a failure.

**2,360 candidates against CHUMP's 636 and PONS's 16,910** puts CASHCAT in the middle
of the range, and the cost is quoted from its own count rather than from either.

#### STEPS 8–11: TAGS, TIMESTAMPS, PRICES, DRY RUN — all clean

**Step 8, tags.** 2,245 stored, **0 refreshed, 0 manual left alone, 0 removed**, and
the `token_windows` row written. Every zero is stated: this is a first load, so there
was nothing to refresh and nothing to remove, and a cohort that later shrinks is the
case those counts exist for. **Casing checked before the upsert and after it: all
2,245 tags are lowercase and all carry `source = auto`**, so the exact-string match
the upsert depends on cannot silently insert a second row per wallet.

**Step 9, timestamps: 55,076 needed, 55,076 already stored, 0 to fetch, 0 CU.**
Confirmed rather than assumed. The sweep carried `blockTimestamp` on every log, which
is what the Alchemy route buys, and CASHCAT is the second token after CHUMP to pay
nothing here. It took **50.8 s** to establish that, all of it the materialised
work-set query over 4.38M swaps and 10.6M transfers.

**Step 10, prices.** 75.6 s, 0 CU.

```
token/USD ticks    1,223,666   discarded by the 100x fence   26
token/ETH ticks    3,114,970   discarded by the 100x fence   14
derived native buckets 5,947   discarded by the 10x fence     0   <- the soundness signal
buckets with no USDG side        254
cashcat_usd_prices   5,947 buckets written
native_usd_prices    5,947 derived and NOT written -- CASHCAT does not own the series
```

**CASHCAT'S OWN SERIES STARTS BEFORE ITS WINDOW OPENS, WHICH IS THE OPPOSITE OF
CHUMP.** Reported separately from the chain's, because they answer different
questions and CHUMP is the cautionary case:

| | CHUMP | CASHCAT |
|---|---|---|
| own series | 49 buckets, 45,293,150–61,693,150 | **5,947 buckets, 833,150–62,143,150** |
| first own bucket vs window | **entirely AFTER the window closed** | **833,150, one bucket BEFORE it opens** |
| window buckets with an own price | **0 of 295 equivalent** | **111 of 295** |
| own USD range | $0.0108–$0.2434 | $0.00236–$0.31042, median $0.12190 |

**111 of 295 is not full coverage and does not need to be.** A trade row is priced
from the COUNTER side through `native_usd_prices`, which after the extension covers
**295 of 295** window buckets. The own series drives the dashboard's price line, so
CASHCAT's early chart is populated where CHUMP's was blank — and the 184 window
buckets without one are buckets where CASHCAT had no USDG trade, which is a gap and
stays a gap.

**The chain's series was not touched by this token**: `nativeUsdNotWritten: 5947`,
`nativeUsdOwner: false`. Its three provenances over CASHCAT's life stand at 9,715
token-incidental, 629 market-derived and 18 market-repaired — the 629 being the 489
that existed plus the 140 this session added.

**Step 11, dry run — the counts reconcile exactly:**

```
rows 97,834 = buy 22,977 + sell 18,925 + transfer_in 38,762 + transfer_out 17,170
tradeRows 41,902 + transfersWritten 55,932 = 97,834
usdNull 56,185 - 55,932 transfers (null by definition) = 253 unpriced TRADE rows, 0.60%
wallets 2,241 of the 2,245 cohort
floors: token-raw 8,932 swaps, paid-raw 185 swaps, token-amount 26 rows, USD 217 rows
```

#### STEP 12 RAISED ON ITS OWN PRICE GATE, AND THE CAUSE IS DEGENERATE SWAPS

```
6 stored prices fall outside 10x their OWN bucket's derived price
(worst ratio 1,047.6, 33,096 compared, 8,553 in buckets the token's own series never priced)
```

**The write rolled back and nothing was stored — verified on a fresh connection:
`wallet_transactions` for CASHCAT is 0 and the phase is recorded `failed`.** This is
the per-bucket check added on 2026-09-13 doing exactly what it was rebuilt to do: on
CHUMP it found **0 of 10,215** outside 10x with a worst ratio of 6.58, and here it
finds real outliers on a token that has them.

**Decoded before concluding, per the standing rule.** Both sampled transactions are
multi-swap dust routes:

| | |
|---|---|
| `0x26b93d2fe1cdc63c23372708b77e58e52f0c2c1fd77d60eb94b285725a20c629` | block 24,075,201. A v4 swap **and** a v3 swap on the charted pool `0xa70fc67c…`, moving **0.000000026030829251 tokens** — 2.6 × 10⁻⁸ — against 0.00094 ETH. Implied price **$68,113,790**. |
| `0x3a75d06669ed92cb5638126df20dc0014e6e585f6065db02bf327ede0ff36dfa` | block 13,987,215. **Three** v4 swaps across three pools, near-zero token sides, 9.236481 USDG on one. Implied price **4.6 × 10¹⁸**. |

**This is step 10's degenerate swap, appearing at ROW level where nothing fences it.**
The series is protected — the 100x tick fence discarded 26 USD and 14 native ticks
during derivation — but a row's `price_usd` is `usd_amount / token_amount` computed
from the swap's own amounts, with **no fence at all**. The four floors in step 11
catch dust by SIZE and these pass them: `0x81f55a09…` carries **18,225 tokens**
against 0.0000149 ETH, which clears every floor and implies **$0.00000156** — 34,066x
below its bucket.

**Measured across every comparable swap, not just the six rows:**

```
swaps compared                        4,354,225
outside 10x                                  80    0.0018%
outside 100x                                 38
USD carried by the outliers             $31,548    of $2,077,563,596 = 0.0015%
outlier swaps below the 0.001 token floor 12,566   <- caught by the floors, never rows
```

**Negligible in value and absurd in price**, which is precisely the combination the
document says to explain rather than accept. The 80 carry fifteen-thousandths of a
percent of the volume; what they would carry into the table is a `price_usd` wrong by
up to three orders of magnitude, on rows that otherwise look ordinary.

#### WHY THE FLOORS DID NOT CATCH THEM — settled from the code, not inferred

**The question had to be settled before touching the check**, because if the floors
should have caught these rows then the defect is the floors and the check merely
reported it. Three possibilities, and only the third survives:

| | |
|---|---|
| the price check runs BEFORE the floors | **FALSE.** `intake.ts` calls `planOrWrite(…, commit=true, …)` — which applies every floor inside `buildRows` — and only then `checkPricesAgainstTicks`, which reads `wallet_transactions` after the insert. |
| the floors are not applied on this path | **FALSE.** `planOrWrite` → `buildRows` → `tradeLegs`; floors 1 and 2 in `tradeLegs` at rows.ts:181/185, floors 3 and 4 in `buildRows` at rows.ts:309/316. |
| **the floors are applied and these survived for a nameable reason** | **TRUE, and the reason is below.** |

**Measured per floor across all 80 outlier swaps:**

| floor | where it applies | passes | caught |
|---|---|---|---|
| 1 · `token_raw_units: 1` | the **SWAP's** token side, in RAW units | **80 of 80** | **0** |
| 2 · `paid_raw_units: 1` | the **SWAP's** counter side, in RAW units | **80 of 80** | **0** |
| 3 · `token_amount: 0.001` | the **ROW's** transfer amount | 30 | **50** |
| 4 · `usd: 0.01` | the **ROW's** allocated USD | 33 | 47 |
| **all four** | | **29** | 51 |

**FLOORS 1 AND 2 CATCH NOTHING HERE AND CANNOT.** They are **one raw unit** — 10⁻¹⁸
of a token. A "microscopic" side of 2.6 × 10⁻⁸ tokens is **26,030,829,251 raw
units**, ten orders of magnitude above the floor. Those two floors exist to reject an
exactly-zero side, and they do only that.

**FLOOR 3 IS A ROW-LEVEL FLOOR ON THE TRANSFER, NOT ON THE SWAP.** This is the whole
explanation and it was got wrong once before being measured: the 2.6 × 10⁻⁸ figure is
the SWAP's token side, while `cfg.floors.tokenAmount` is compared against
`formatUnits(leg.raw)` — the amount that actually MOVED to the wallet. Where the two
coincide the floor does its job, catching 50 of the 80 and 26 rows in the dry run.

**The 29 survivors are the opposite shape.** A large, legitimate transfer — 18,225
tokens in `0x81f55a09d6969f89f80affa30b06afbde8173286e64a9d761aeada0537f6dc26` —
against a swap counter side of **0.0000149 ETH**. The token side passes floor 3
comfortably, the USD of $0.0358 passes floor 4, and the implied price is
**$0.00000156** against a bucket median of $0.0531: **34,066x low**.

**THE FOUR FLOORS BOUND EACH SIDE INDEPENDENTLY. NOTHING BOUNDS THE RATIO BETWEEN
THEM.** A row's `token_amount` comes from the transfer and its `usd_amount` from
`groupUsd × share`, derived from the swaps — two different sources — so a row can be
entirely reasonable on both axes separately and absurd as a quotient. **The price
check is the only thing in the pipeline that looks at the quotient**, which is exactly
why it fired and exactly why tuning it would be the wrong move: its 10x is not a
threshold question when the error is 1,047x.

#### THE PROPOSED FIX — fence the row price, store NULL beyond it

**Step 10 already fences ticks at 100x and reports what the fence caught. The row
writer has no equivalent, and that asymmetry is the defect.** The fix is to give
`buildRows` the test the pipeline is missing:

> **A row whose implied price falls outside `native_fence_multiple` of its OWN
> bucket's derived price keeps its token amount and stores a NULL USD.**

**NULL rather than dropped**, for reasons this document already holds elsewhere: the
movement is real and its token amount is verifiable; section 5 says a null is never a
zero and step 11 says a null-USD row is unpriced rather than small; position sums and
`inflated-pnl` run on token amounts and stay correct. Dropping would lose a genuine
movement, and the floors already exist for dust by size.

**Two consequences that must be stated rather than discovered:**

- **The check becomes a backstop that should report zero**, and zero then means
  something — the same relationship the 10x native fence already has with "0 discarded
  is the signal the derivation is sound". It is not circular: the writer enforces, the
  check verifies, and a non-zero count after this is a real defect.
- **Rows in buckets the token's own series never priced CANNOT be fenced** — 8,553 of
  33,096 compared on CASHCAT. They keep a counter-derived price with no independent
  reference, which is honest and is the residual this fix does not close.

**THE DECISION WAS THE OPERATOR'S AND HAS NOW BEEN TAKEN** — "do not re-run the write
until that question is answered and the fix is documented and deployed". Every
available remedy changes what gets a USD, which is a definition, so they are recorded
with it:

| option | effect |
|---|---|
| **fence the row price against its bucket, store NULL beyond it** | consistent with the tick fence and with "unpriced is honest"; loses 6 rows' USD, keeps their token amounts |
| drop the rows entirely | loses real movements; the floors already exist for dust and these are not dust by size |
| widen the check's multiple | hides a 1,047x error to admit six rows — the document forbids adjusting a number to fit |
| leave the gate as it is | the intake cannot complete; correct today, not a resting place |

**The first is the only one consistent with what this document already does elsewhere**
— step 10 fences ticks and reports what the fence caught — and it is the one taken.

#### AS IMPLEMENTED — one fence, both paths, and the check verifies it

`buildRows` in `src/adapters/token-updates/rows.ts` takes the token's own USD series as
`ownUsdByBucket` and applies the rule above immediately before pushing each row. It uses
**`native_fence_multiple` — the SAME constant step 10 fences ticks with**, not a second
number invented for rows. `RowStats` gained two counts that are always reported:

| count | meaning |
|---|---|
| `nullUsdBecauseOutsideFence` | the fence fired; token amount kept, USD and price NULL |
| `rowsNotFenceable` | the row's bucket has no own-series price, so no test was possible |

**`rowsNotFenceable` is reported precisely because it is the residual.** A row that
cannot be tested is not a row that passed, and collapsing the two would turn this fix
into the "clean pass" illusion section 9 lists as a standing failure mode.

**BOTH WRITERS, NOT JUST THE INTAKE.** `planOrWrite` (`src/intake/write.ts`) loads the
series once per run — not per slice, which would let two slices fence against two
different reads — and the hourly `token-updates` adapter loads it per cycle through the
new `loadTokenUsdForRange`. Step 15's rule that the two paths share one buy rule is not
optional here: fencing only the intake would leave the hourly job writing the very rows
the intake nulls, into the same table. That is the two-paths-one-table defect this
document has already recorded four times.

In the adapter, **a stored bucket price beats one derived this cycle**, because
persistence never rewrites an existing bucket — fencing against a value the run computes
but will not store would test rows against a price that exists nowhere.

**The check and the writer read the same column, which is why this closes.**
`checkPricesAgainstTicks` compares `wallet_transactions.price_usd` against the bucket's
`pons_usd`; the fence nulls exactly that column on exactly those rows, so they leave the
check's population rather than being excused from it. **The expected result is now
`outside: 0`, and a non-zero count is a real defect rather than a threshold to widen.**

`src/cli/dropped-buys.ts` also calls `buildRows` and is deliberately left unfenced: it
writes nothing and exists to show what the buy rule discarded, so a USD it never stores
cannot mislead.

#### STEPS 11 AND 12: 97,834 ROWS, AND THE FENCE TOOK EXACTLY THE SIX

**Step 11, the dry run: 107.9 s, 0 CU.** It reconciles in both directions, which is
the whole point of running it:

```
rows                     97,834
  buy            22,977  }
  sell           18,925  }  = tradeRows        41,902
  transfer_in    38,762  }
  transfer_out   17,170  }  = transfersWritten 55,932   41,902 + 55,932 = 97,834
cohort                    2,245
wallets appearing in rows 2,241     <- 4 cohort wallets have no row at all
usdNulledByFence              6     <- the SIX step 12 rejected, and only those
rowsNotFenceable          7,676     <- bucket has no own-series price; not a pass
floors  swapsBelowTokenRaw 8,932  swapsBelowPaidRaw 185
        rowsBelowTokenAmount  26  rowsBelowUsd      217
```

**`usdNulledByFence: 6` is the fix landing exactly on its target and nothing else.**
The check had reported 6 prices outside 10x; the fence nulled 6 rows. Had it nulled
substantially more, the remedy would have been over-broad and this document would be
recording that instead.

**Step 12, the write: 148.3 s, 0 CU, `rows_stored: 97,834`.**

```
stored prices against their own bucket
  compared      33,104
  notComparable  8,553    <- bucket the token's own series never priced
  outside            0    <- WAS 6, worst 1,047.6x
  worstRatio      6.541
usd_total_check  implied price $0.016029, absurd: false
```

**`outside: 0` with `worstRatio` 6.54 against a 10x fence.** The backstop reports zero
and the margin is real rather than marginal. CHUMP's equivalent was 0 outside, worst
6.58x — two tokens, independently, sitting just inside the same fence.

**VERIFIED ON A FRESH CONNECTION, not from the runner's exit.** `wallet_transactions`
holds **97,928** rows for CASHCAT, and the 94-row difference is fully accounted for:

| | rows | |
|---|---|---|
| `block_number <= 62,152,931` | 97,834 | the intake's, matching `rows_stored` exactly |
| `block_number > 62,152,931` | 94 | the hourly monitor's, written before this run |
| total | 97,928 | |

Every side reconciles the same way (buy 22,984 = 22,977 + 7, sell 18,932 = 18,925 + 7,
transfer_in 38,802 = 38,762 + 40, transfer_out 17,210 = 17,170 + 40), and the stored
sums match the run's to the last digit: **$66,733,515.0085** and
**4,163,215,575.2476 tokens**.

**THE SEAM WITH THE HOURLY MONITOR IS EXACT, AND IT WAS CHECKED FROM DATA RATHER THAN
FROM THE YAML COMMENT.** `max(to_block)` over `token_sweep_progress` is **62,152,931**
across all three streams (swap-v3, swap-v4 and transfer all swept 88,836..62,152,931);
`cashcat-updates` seeds its cursor at **62,152,931**; and the monitor's 94 rows all
sit above it. No gap, no double-write.

#### THE 56,191 NULLS ARE NOT A PRICING FAILURE, AND THE RAW SHARE MISLEADS

57.4% of CASHCAT's rows carry a null USD, which sounds alarming and is not. Split by
reason it is almost entirely structural:

| reason | rows | |
|---|---|---|
| **transfer rows** | **55,932** | `usdAmount: null` **by construction** — a transfer has no counter side, so there is no price to derive. This is every transfer row, 38,762 in + 17,170 out |
| trade rows genuinely unpriced | 259 | buy 167, sell 92 |
| | 56,191 | |

**So the figure that means anything is 41,643 of 41,902 trade rows priced — 99.38%,
with 0.62% unpriced.** Of all 56,191 nulls, only **221** fall in a bucket where
`native_usd_prices` has no entry; the ETH/USD series covers 83,150–63,153,150 in 10,462
buckets and is not the constraint.

**Quote the trade share, not the row share.** A token whose wallets move it around a lot
has more transfer rows and would look worse on the raw share while being priced better.
The denominator has to be the rows that can carry a price.

#### STEP 13: SCORED, AND METRIC 5'S MAXIMUM IS EXACTLY 1/3 — A STRUCTURAL CEILING

**2,245 wallets scored, 66 flagged `inflated-pnl`.** All three pump points were already
stored and match the config exactly, so nothing was written for them:
`2026-07-07T20:00Z`, `2026-08-04T00:00Z`, `2026-08-19T20:00Z`.

| | wallets | score range |
|---|---|---|
| `weight_used` 1.0 | 2,238 | 0.0911 – 0.4456 |
| `weight_used` 0.875 | 1 | 0.0965 |
| `weight_used` 0 — **unscored, score NULL** | 6 | — |
| | **2,245** | mean 0.2214, p50 0.2119, p90 0.3064 |

**The six weight-0 wallets carry a NULL score, not a low one**, which is the correct
outcome and worth stating because a zero would have been indistinguishable from a
genuinely worthless wallet. In `order by score desc` Postgres sorts those NULLs FIRST,
which reads at a glance as "the top-scoring wallets have no metrics at all" — they are
the unscored ones. Anyone reading a ranked list must use `nulls last`.

##### METRIC 5'S ACTUAL DISTRIBUTION, AND THE CEILING IS 1/n_pumps

```
n 2,245   null 6   zero 1,544   min 0
p50  0.00000000
p90  0.17437416
p99  0.33333333
max  0.3333333333333333   <- exactly 1/3
wallets exactly at 1/3            168
wallets ABOVE 1/3                   0     <- REPORTED: the count is zero
```

**`prePumpShare` is the MEAN over pumps of each pump's pre-48h buy share**
(`src/scoring/metrics.ts:204-213`). CASHCAT's three pumps are weeks apart, so their
48-hour windows are **disjoint** — 07-05 20:00Z–07-07 20:00Z, 08-02 00:00Z–08-04 00:00Z,
08-17 20:00Z–08-19 20:00Z. **A buy dollar can therefore fall in at most ONE window**, so
the shares sum to at most 1 and their mean is at most **1/n_pumps**. On this token that
is 1/3, and 168 wallets sit exactly on it.

**Proven on an individual record, not asserted from the aggregate.** Wallet
`0x0300e281a7affee0c7b70a2f4cfa5dda16be4112` has exactly **one** priced buy —
**$3,555.03** at **2026-07-06T04:27:27Z**, inside pump 1's window
(`0x3570dca7bb23174bf4e65858924f6f6804a73653d3b9359c25c3fbfe120a5837`). Its shares are
(1, 0, 0); their mean is 0.3333333333333333; that is the stored value.

**WHY THIS IS A DEFECT AND NOT A CURIOSITY.** `normalised.prePumpShare` is the raw value
passed through unchanged — no rescaling to the cohort — and the weight table assigns
`prePumpShare: 0.05`. So on a three-pump token the metric can contribute at most
**0.05 x 1/3 = 0.0167**, a THIRD of its stated weight, and a wallet that bought its
entire position inside a pre-pump window — the exact behaviour this metric exists to
find — is recorded as scoring 0.33 out of 1.

**It is also not comparable across tokens.** A one-pump token's ceiling is 1.0, a
three-pump token's is 0.333. Identical behaviour on two tokens produces different
contributions for no reason but how many pumps were configured, which silently reweights
the composite between tokens.

**THE REMEDY IS A DEFINITION CHANGE AND IT WAS MADE ON 2026-09-14.** The candidates as
they were put to the operator:

| option | effect |
|---|---|
| **take the MAX over pumps instead of the mean** | **TAKEN.** "did they load up before any pump" — reaches 1.0, comparable across tokens, and a wallet buying before two pumps is not penalised for it |
| divide by the share's own ceiling (1/n) | rescales to 0..1 but keeps the mean's meaning: buying before ALL pumps still cannot be distinguished from buying before one |
| union the windows, then one share | cleanest arithmetic, reaches 1.0, loses per-pump structure metric 6 relies on |
| leave it | metric 5 keeps a third of its weight on this token and a different fraction on the next |

**The figures in this CASHCAT section were computed with the MEAN and are left as they
were.** They are what that run produced. The definition and the measured effect of the
change across every window are in step 13 and in the subsection below.

#### STEPS 14-17: PAGE EXECUTED, MONITOR HEALTHY, WATCHLIST WAS STALE BY 4

**Step 14 — the page was EXECUTED in a DOM, not built and assumed.**
`scripts/verify-tokens-page.mjs <base> CASHCAT 0x020b...18b4`:

```
token tabs           AI 3508 | CASHCAT 2245 | CHUMP 523 | INDEX 7239 | PONS 14219
tab selected         CASHCAT 2245              script errors 0
count line           2245 of 2245 wallets - 97928 transactions (page 1 of 23)
wallet rows          100 rendered, 100 with a score, 0 unscored, 0 partial-weight
top scores           0.4456, 0.4443, 0.4425    <- matches wallet_scores exactly
exclude inflated-pnl 2245 -> 2179 (removed 66)
expansion mint       MATCHES 0x020bfC650A365f8BB26819deAAbF3E21291018b4
metric rows          8 of 8, 0 dropped as null
```

**97,928 on the page is the database's figure**, intake plus the monitor's 94, so the
page and the store agree without either being adjusted to the other.

**Step 15 — `cashcat-updates` is running and was running before this write.** 19 runs,
`last_status` success at 22:30:54Z, `consecutive_failures` 0, recent cycles writing
7, 5, 27 and 0 records in 2.7–3.2 s. **The zero cycle is reported rather than omitted**:
an hour with no CASHCAT activity is a legitimate result for this monitor.

**Step 17 — THE WATCHLIST WAS STALE AND THE STALENESS WAS VISIBLE IN ITS NUMBERS.**
Before the refresh CASHCAT held **4** memberships against **113** slots, scored
0.0300–0.7879 — a range `wallet_scores` does not contain. Both facts point the same
way: those 4 were qualified at 22:48Z from scores computed over the **94 monitor rows**
that existed before the intake write landed at 22:53Z. **A watchlist row whose score is
outside its own token's score range is stale by construction, and is worth checking for
directly.**

After `run-once wallet-scores`:

| tag | cohort | scored | null | slots | admitted | cutoff | max |
|---|---|---|---|---|---|---|---|
| **CASHCAT-P1** | **2,245** | **2,239** | **6** | **113** | **113** | **0.3142** | **0.4456** |
| CHUMP-P1 | 523 | 522 | 1 | 27 | 27 | 0.2195 | 0.5897 |
| AI-P1 | 3,508 | 3,496 | 12 | 176 | 176 | 0.2640 | 0.7581 |
| PONS-P1 | 13,823 | 13,735 | 88 | 692 | 692 | 0.4412 | 0.6025 |
| INDEX-P1 | 3,316 | 3,311 | 5 | 166 | 166 | 0.3054 | 0.5326 |
| INDEX-P2 | 4,267 | 4,259 | 8 | 214 | 214 | 0.3311 | 0.6094 |

**Every window admitted exactly its slot count**, so the 5% cut is the only thing
binding — no window ran short of qualifying wallets.

**The watchlist effect of adding CASHCAT: 1,279 rows / 1,185 wallets -> 1,388 / 1,289**
(+114 memberships, -5 removed). **7 of CASHCAT's 113 also sit on another token's
watchlist** — INDEX-P1 3, PONS-P1 3, INDEX-P2 1 — and wallets on two or more tokens rose
from 65 to 70. **CASHCAT's cohort is therefore very nearly disjoint from the others**,
which is what the cross-token overlap is for: 106 of 113 are new faces.

#### CASHCAT'S COST: 327,660 CU, ABOUT $0.147

| phase | CU | ceiling | |
|---|---|---|---|
| identity | 816 | 2,000 | |
| windows | 1,100 | 5,000 | |
| pools | 480 | 100,000 | |
| sweep | 218,230 | 800,000 | 3.7x headroom |
| scope | 2,896 | 50,000 | plus 2,714 on the superseded first run |
| conventions | 0 | 50,000 | reads stored logs only |
| cohort | 101,424 | 400,000 | 3.9x headroom |
| tags, timestamps, prices, dryrun, write | 0 | 0 | no RPC by design |
| **total** | **327,660** | | **~$0.147 at 0.45/MCU** |

**Wall clock measured this session: dry run 107.9 s, write 148.3 s, scoring 13.7 s for
all six windows.** No phase approached 3x its expectation, so no investigation was
triggered. **Every ceiling held with real headroom and none was raised.**

#### STEP 7: COHORT 2,245, AND IT RECONCILES EXACTLY

**78.9 s, 101,424 CU.** The work set was re-derived before spending rather than taken
from the earlier session's figure, and came back identical: **2,360 candidate wallets**
over 17,829 swap transactions, ~101,716 CU against a 400,000 ceiling — 3.9x headroom,
so the guard did not trip.

```
candidate wallets for payment      2,352    (2,360 derived in SQL before the run)
  proven free from token_payment_logs  0    <- REPORTED, and structurally zero here
  proven over RPC                  2,289
  no payment in any transaction       63     2,352 = 2,289 + 63
code-checked at the window's END block 2,289
  excluded as deployed contracts      44
  EIP-7702 delegated accounts KEPT   160
COHORT                              2,245     2,289 - 44 = 2,245
excluded earlier: infrastructure 1,916, round-trippers 22, pools 126
unused exclusions: the zero address and 0xb01ca24b... matched nothing -- reported
```

**`token_payment_logs` proved 0 of 2,352, and here the zero is STRUCTURAL rather than
merely expected.** That table covers blocks **15,115,287–56,693,145**; CASHCAT-P1 ends
at **3,789,108**. The overlap is not small, it is **empty** — the fast path could not
have proved a single wallet no matter who traded. On CHUMP the zero meant "these buyers
did not also buy PONS"; here it means "this table cannot see this era at all". **Two
identical zeros with different meanings, and the difference is worth stating** —
step 7's "not worth sweeping for a new token" holds for a third reason on this token.

**1,916 wallets excluded as infrastructure is the router work paying off.** Six routers
were persisted before this phase ran, five of them absent from
`config/infrastructure.yaml`; without the post-sweep scope re-run those 1,916 sends
would have been attributed to buyers. **That is the PONS defect avoided for the second
token running**, and on a far larger scale than CHUMP's 285.

**Only 22 round-trippers against CHUMP's 1,806**, despite CASHCAT having 133x the
swaps. The per-transaction round-trip test is finding almost nothing here because
CASHCAT's arbitrage happens BETWEEN pools rather than within one — the same behaviour
the conventions guard excluded 80–90% of v4 pairs for. **Two independent tests seeing
the same structure from different sides.**

**160 EIP-7702 delegated accounts kept, 7.1% of the cohort**, against CHUMP's 29 (5.5%)
and AI's 315 (9.0%).

**The cohort is held in `token_intake_state` under `cohort:CASHCAT-P1` and NOT written
to `wallet_tags`.** Verified on a fresh connection: tags **0**, rows **0**, windows
**0**, scores **0**. The stop is real.

#### STEP 6, AFTER THE GUARD: UNANIMOUS, 2,505 of 2,505

Re-run 2026-09-14 with the one-swap-per-transaction guard (step 6, shared from
`intake/adjudicable.ts`). **7,381 ms, 0 CU** — the phase reads stored logs and takes
its bounds from `token_sweep_progress`.

| venue | region | in region | sampled | **excluded** | tested | agreeing | convention |
|---|---|---|---|---|---|---|---|
| v3 | in-window | 17,314 | 800 | 45 | 755 | **755** | pool |
| v4 | in-window | 2,741 | 800 | **718** | 82 | **82** | swapper |
| v3 | before-window | 5,312 | 800 | **0** | 799 | **799** | pool |
| v4 | before-window | 29 | 29 | 24 | 5 | **5** | swapper |
| v3 | after-window | 2,366,347 | 800 | 98 | 702 | **702** | pool |
| v4 | after-window | 1,989,098 | 800 | **638** | 162 | **162** | swapper |

**Every cell agrees with itself and the two venues remain opposite** — v3 the POOL
perspective, v4 the SWAPPER perspective — which is the fifth token to confirm it and
the first to do so with the guard in place.

**THE EXCLUSION RATES ARE THE REAL FINDING, AND THEY ARE LOPSIDED.** v4 excludes
**80–90%** of every sample; v3 excludes **0–12%**:

```
v4  in-window     718 of 800   89.8%       v3  in-window      45 of 800    5.6%
v4  before         24 of  29   82.8%       v3  before          0 of 800    0.0%
v4  after-window  638 of 800   79.8%       v3  after-window   98 of 800   12.3%
```

**THE v4 VERDICT RESTS ON 82 IN-WINDOW TESTS, NOT ON 800, AND THAT IS THE NUMBER TO
CARRY FORWARD.** The unanimous 2,505 is dominated by v3 (2,256 of it). CASHCAT's v4
convention is established on **82 in-window, 5 before-window and 162 after-window
tests** — unanimous in all three, and a far thinner base than the total suggests. It is
enough to proceed because step 6 is a check rather than a source of direction, but
**anyone re-reading this should not take 2,505 as the weight behind a v4 amount here.**

**Nine in ten of CASHCAT's v4 swaps sit in a transaction holding more than one
CASHCAT swap.** That is what its v4 side *is*: routers splitting and arbitraging
across its 398 trading v4 pools, rather than end users buying on one. It also explains
why the unguarded check produced exactly 11 disagreements rather than hundreds — the
pairs it admitted were mostly the wrong ones, and only a minority of those happened to
land on the wrong side of the sign.

**v3 before-window excludes ZERO of 800**, which is stated rather than omitted: a
guard that never fires in a cell is a result about that cell, and it says CASHCAT's
early v3 trading is plain single-pool swapping.

**The before-window region is REAL here, unlike CHUMP's.** CASHCAT's window opens at
846,162 against a deployment at 88,836, so 757,326 blocks of life precede it and they
hold **5,312 v3 and 29 v4 swaps**. CHUMP's before-window was empty by construction
because its window started at its deployment block; CASHCAT is the first token to
exercise all six cells with data in every one.

**v4/before-window tested only 5 swaps** and that is reported rather than hidden. It
is above zero, so the "a venue present in a region with nothing tested" raise does not
fire — correctly, because 29 swaps of which 24 are multi-swap is a real property of
the data and not a sample that failed to reach the venue.

#### STEP 6 AS IT FIRST FAILED — kept, because the cause is the transferable part

```
sign conventions are not unanimous: v4/in-window 779/790
```

**11 disagreements in 790 tested — 1.39%**, which lands in the same 1.4–2.0% band this
document records for AI. There it was decoded and proved NOT to be a convention
difference. **Here it was decoded too, and it is not a convention difference either —
but the CAUSE is a different one, and it is a defect in the check rather than in the
data.**

**Decoded, with hashes, before any conclusion.** Both transactions have the identical
shape:

| | `0x414077b6ec56a58e91c751d8319280986069cdf70350ec4639e35e6e5d6316cf` (block 903,126) |
|---|---|
| `tx_to` | `0x7a31dd32…`, a **router contract**; `tx_from` an EOA |
| swaps | **TWO v4 Swaps, on TWO DIFFERENT CASHCAT/ETH pools** — `0x604867…` and `0x74739c…` |
| amounts | one pool ~**+42.58** CASHCAT, the other ~**−41.19** |
| transfers | PoolManager → router **1.387354610014814208**, then router → EOA, the same amount |

`0x3ce6aa42f979ec20f7eea83c01e0254a02989f168e14230db7121464cb2010d5` (block 1,352,363)
is the same: two CASHCAT pools, and **1.084888446085611403** out to the user.
**Confirmed against `pool_meta`: all three pool ids are CASHCAT pools.**

**So a router buys on one CASHCAT pool and sells on another inside one transaction, and
only the NET leaves the PoolManager.** `verifyConventions` pairs **each** swap against
that single net transfer, so on a two-swap transaction one of the two must appear to
disagree. The 11 are arithmetic, not evidence about a convention.

**THE GUARD THAT WOULD CATCH IT EXISTS — IN THE OTHER IMPLEMENTATION.**
`build-cohort.ts` requires `spt.n = 1`, one swap of this token in the transaction,
before counting a pair as evidence. `verifyConventions` has no such test: it checks
only that the pool moved in one direction and that the transaction had at least one
transfer. **That is the "two implementations of one rule" trap for the fourth time,
and this time the RUNNER'S is the weaker one.**

**It does not need `v4_swaps_all`.** Both hops here are CASHCAT pools, so the token's
own `token_swap_logs` can see them — a `count(*) per tx_hash > 1` test suffices.
That matters because **`v4_swaps_all` holds 0 rows anywhere inside CASHCAT-P1**, so the
adjudicator step 7 reaches for is unavailable for this token, and a fix that depended
on it would fix nothing here.

**The run stopped at step 6 and nothing downstream was written**: no cohort, no tags,
no rows. The conventions phase is recorded `failed`, which is honest, and the cohort's
2,360-wallet work set was derived but never spent.

#### The flow probe: NOT RUN, and it could not even be PRICED yet

Step 3 says to price the probe before deciding, from the count of addresses that both
sent and received the token. **That count comes from stored transfers and CASHCAT has
none**, so the probe cannot be priced before the sweep, let alone justified. It is
off, reported as **"NOT RUN"** rather than as a zero, and the decision can be revisited
against real transfer data afterwards. **The pricing step being unavailable is itself
worth recording: the document's decision procedure assumes transfers already exist.**

---

### BONER — `0x98096d17e191B3dA1d5f99a6D7b3584351b11E18`

**IN PROGRESS 2026-09-15. Nothing loaded yet** — verified on a fresh connection before
anything was written: `tokens` **RETURNED NO ROWS**, `token_intake_state` **RETURNED NO
ROWS**, and tags, rows, windows, swaps, transfers and `pool_meta` all **0**.

```
window BONER-P1   2026-08-20T00:00:00-04:00 -> 2026-08-30T12:00:00-04:00
pump              2026-08-30T12:00:00-04:00   <- IS the window end, like CHUMP's pump 1
charted pool      0x9c89b04303dfa76f3f6fb02c2b77be0e8a00ab8fa00d507119acd54ab3e8640d
                  a 32-BYTE v4 POOL ID, not an address. Recorded, never filtered on.
pair              BONER/HIMS, v4
```

#### WHAT BEARS ON IT: THIS IS THE SECOND BRIDGE EVER, AND THE DOCUMENT NAMED IT

**Step 4 names this token by name.** The bridge-decimals defect — `?? 18` where the
token's own decimals raised — was fixed on 2026-09-14 and the entry says it "was
dormant only because AI is the only token with a bridge and NVDA's `tokens` row
exists. **BONER is queued and needs a HIMS bridge, so it stops being dormant on the
next intake.**" This intake is that next intake. **The fix is about to be exercised
for the first time, and the way to exercise it is to make HIMS resolvable BEFORE the
prices phase rather than to discover the raise.**

**Three consequences, none optional:**

1. **HIMS needs its own identity run before the prices phase.** A bridge gets its
   `tokens` row from a separate identity run and nothing in the prices phase checks
   that it happened. With the fix in place a missing row now STOPS the job instead of
   scaling every bridge amount by 10^12.
2. **HIMS is resolved by ADDRESS, never by symbol.** Two tokens on this chain answer
   `symbol()` with "NVDA", and the impostor's address ends `1e18` like a crowd of junk
   counters — **BONER's own address ends `1E18`**, which is the same vanity suffix and
   is worth noticing rather than reading as a signal. The address comes from the
   charted pool's `Initialize` currencies, read from the chain.
3. **`bridge_usd_prices` is keyed `(chain, bridge, bucket_block)` and section 9 warns
   that two tokens pricing through ONE bridge on different grids would interleave two
   series in one table.** Checked before starting: the table holds **one bridge, NVDA,
   4,471 buckets on residue 1433**, and `bridge_assets` appears in exactly two files —
   `intake/ai.yaml` and `monitors/ai-updates.yaml` — both naming NVDA. **Nothing else
   can price through HIMS, so HIMS will be priced by BONER alone and the two-grid
   hazard does not fire.** It is confirmed rather than assumed, and it fires the moment
   a third token wants HIMS.

#### BONER ALREADY HAS DIRECT PRICING POOLS, WHICH AI DID NOT — so the bridge is a
#### question to be answered by SWAP SHARE, not a foregone conclusion

The watcher has been recording BONER since 2026-09-13 and its 128 rows already name
BONER's counter assets, for free and before any sweep:

| counter | rows | priced |
|---|---|---|
| `0xccee82fe…3d09` — the HIMS candidate | 44 | **0** |
| USDG | 34 | 34 |
| WETH | 27 | 27 |
| AI `0x2E8c3116…` | 15 | 0 |
| native ETH | 8 | 8 |

**69 of 128 already price without any bridge at all**, which is the opposite of AI:
AI's charted NVDA pair was 56% of its swaps and the hop was worth **4.4x its cohort**,
where BONER has live USDG, WETH and native pools. **That makes the bridge a decision
rather than a necessity**, and step 3's rule decides it: *weigh the venue split by
SWAPS, never by pool count*, and step 4's second hop is justified by what share of the
token's market it recovers. **The 44 unpriced HIMS rows are the lower bound on what
the hop would buy and they are a watcher sample, not the token's market.**

**BONER also trades against AI**, which the AI findings predicted — "BONER and CASHCAT
trade against AI" — and those 15 rows are correctly unpriced: AI is a memecoin, not a
recognised pricing asset, and pricing BONER through AI would price a memecoin against a
memecoin. **AI is not a bridge candidate here**, whatever its volume.

#### `v4_swaps_all` CANNOT SEE THIS WINDOW, AND THAT IS ARITHMETIC RATHER THAN A PROBE

`v4_swaps_all` spans **15,115,267–42,695,454**, confirmed from the table. PONS-P1 ends
at 42,691,407 on 2026-08-21, so the table was built to that date and **BONER-P1 opens
on 2026-08-20 and closes on 2026-08-30**. At 35,622 blocks/hour the window's closing
bound sits roughly eight million blocks past the table's ceiling.

**So the free v4 count is a lower bound over at most the first day of a ten-day
window, and quoting a venue split from it would repeat CHUMP's error in CASHCAT's
direction.** CHUMP's free query said 13 v4 swaps where the sweep found 10,722;
CASHCAT's said 879,297 where the sweep found 1,991,868. **The coverage is checked
against the window before the figure is quoted, not after**, and the split is quoted
from the sweep.

#### STEPS 1–3 AS MEASURED, and the identity constant holds for a SIXTH token

| phase | wall-clock | CU | against estimate |
|---|---|---|---|
| identity | **805 ms** | **816** | ~800 — **exact, and 816 for the sixth token running** |
| windows | **470 ms** | 560 | ~1,040 for one window — **46% under**, the start instant short-circuited |
| pools | **990 ms** | 240 | ~500 — **52% under**, 4 sparse `eth_getLogs` for 388 candidates |

```
name "Boner Coin"   symbol BONER   decimals 18   supply 999,946,321.609311065068912732
deployment block    41,726,520          head at identity 63,252,853
BONER-P1            41,726,520 .. 50,134,751     8,408,231 blocks
pools               388 candidates = 379 v4 from Initialize + 9 v3 from the factory
flow probe          NOT RUN -- reported as such, never as a zero
```

**THE WINDOW START RESOLVED TO THE DEPLOYMENT BLOCK EXACTLY, which is the low-bound
clamp firing for the second time after CHUMP.** `2026-08-20T00:00:00-04:00` returned
41,726,520 — the deployment block itself — because `resolveWindows` passes it as the
search's low bound and `blockForInstant` opens `if (target <= loTs) return lo`. The
window therefore opens where the token opens, and **`before-window` will be
`41,726,520..41,726,519`, empty by construction** — the shape section 6 says must be
reported as RETURNED NO ROWS rather than omitted. It also explains the 46% CU
under-run: one bound short-circuited instead of bisecting.

**The supply matches the `token_decimals_cache` read from 2026-09-15 to the last
digit** — 999946321609311065068912732 raw against the identity phase's
999,946,321.609311065068912732. **Two independent reads of the same contract through
different code paths agreeing exactly** is the cross-check the supply backfill never
had, arriving for free.

**The charted pool was created IN THE DEPLOYMENT BLOCK.** `0x9c89b043…8640d` carries
`block: 41726520`, so there is no bonding curve here — the same finding PONS records.

#### HIMS IS `0xccee82fe024c36fa15e1005ede3e9e4787e23d09`, READ FROM THE CHAIN

Resolved from the charted pool's own `Initialize` currencies, **by address**:

```
currency0  0x98096d17e191b3da1d5f99a6d7b3584351b11e18   BONER itself
currency1  0xccee82fe024c36fa15e1005ede3e9e4787e23d09   the bridge
symbol     HIMS       name "Hims & Hers Health • Robinhood Token"    decimals 18
supply     110,184.084      <- a tokenised EQUITY, the same shape as NVDA
```

**Exactly ONE token on this chain answers `symbol()` with "HIMS"** — checked, and it is
this one, so the NVDA impostor problem does not repeat here. **It is still matched by
address**, because the check that found one today is a measurement with a date on it
and a second HIMS can be deployed at any time.

**BONER's own address ends `1E18`** — the vanity suffix the AI findings record for a
crowd of junk counters. **It is a coincidence of address space and says nothing about
the token**, noted here only so a future reader does not read it as a signal.

#### THE VENUE SPLIT BY POOLS IS THE OPPOSITE OF THE SPLIT BY SWAPS — a THIRD time

**Step 3's rule — weigh the split by SWAPS, never by pool count — has now misled on
three consecutive tokens, and BONER is the widest gap yet.** Measured over the
968,935 blocks of the window that `v4_swaps_all` can see:

| counter | pools (all 388 candidates) | swaps over the covered blocks |
|---|---|---|
| **HIMS** | **3** | **8,874 — 84.5%**, on ONE pool |
| USDG | **155** | 56 — **0.5%** |
| native ETH | 80 | 931 |
| AI | 5 | 637 |

**155 USDG pools carry half a percent of the swaps; three HIMS pools carry
eighty-four.** By pool count BONER reads as a USDG token with a bridge it barely
needs. By swaps it is a HIMS token, and the hop is its market rather than an
optimisation. CHUMP looked 96% v4 by pools and was 96.1% v3 by swaps; CASHCAT was the
mirror; **BONER is the same error with a 50-to-1 ratio in the other direction.**

**THE 128 WATCHER ROWS POINTED THE RIGHT WAY AND WOULD HAVE BEEN A WEAK BASIS.** They
gave HIMS 44 rows against USDG's 34 and WETH's 27 — the right ORDER, but 34% rather
than 84.5%, because a watchlist sample is 28 wallets' trades and not the token's
market. **It is worth reading before a sweep and never worth quoting as the split.**

#### A ZERO FROM `v4_swaps_all` THAT WAS MY QUERY, NOT THE COVERAGE

The first count of BONER's v4 swaps returned **0 swaps across 0 pools**, and the
obvious reading was the coverage artefact the INDEX findings name — the table stops at
42,695,454 and the window runs to 50,134,751. **That reading was wrong and the zero
was mine.** The query addressed the stored candidate list as
`detail->'candidates'` where `detail` **is** the array, so the subquery matched no
pool ids at all and the join had nothing to join to.

Corrected, the same range gives **10,498 swaps across 10 pools, 41,726,586–42,695,034**.

**Section 7's rule caught it: when a query disagrees with itself, suspect the query.**
The tell was that `pools` came back 0 as well — a genuine coverage artefact would
match the pools and find no swaps in them. **A zero that arrives with a second zero
beside it is usually one fault, not two findings**, and this document had the shape
recorded for the INDEX case, which is exactly why it was tempting to file it there.

**The real coverage limit, stated properly:** `v4_swaps_all` sees
41,726,520–42,695,454 of an 8,408,231-block window — **968,935 blocks, 11.5%** — and
**only 21 of BONER's 388 pools were created inside it**. So 10,498 is a lower bound
over the first ninth of the window across a twentieth of the pools, and the split
above carries that limit with it. **The sweep replaces it; nothing is quoted from the
free query as final.**

#### HIMS AS A PRICING SOURCE: 131 in-scope pools, and a SECOND token answers "HIMS"

`intake/hims.yaml`, modelled on `intake/nvda.yaml`, run before BONER's scope so the
bridge's `tokens` row exists before anything prices through it.

| phase | wall-clock | CU | |
|---|---|---|---|
| identity | 692 ms | **816** | the constant holds for a **SEVENTH** token |
| windows | 978 ms | 1,100 | 55 `eth_getBlockByNumber` |
| pools | 1,925 ms | 480 | 669 candidates — 660 v4, 9 v3 |
| scope | 1,777 ms | 2,194 | 84 `eth_call`; **131 in scope, 538 rejected** |

```
HIMS in-scope pools        USDG 108 v4 + 2 v3 = 110
                           native ETH 13 v4
                           WETH  6 v4 + 2 v3 = 8      total 131
deployment block           20,950,062     -- 20.8M blocks BEFORE BONER
supply                     110,184.084    -- a tokenised equity, like NVDA
```

**A SECOND TOKEN ANSWERS `symbol()` WITH "HIMS", AND I SAID THERE WAS ONLY ONE.** The
check above was made against `token_decimals_cache`, which holds only what the watcher
has happened to touch, and it found one. **HIMS's own scope phase — which reads
`symbol()` from each counter contract — found `0xdaab75e5bdc200180f72ae3c531fd560f5377c01`
answering "HIMS" with one pool.** The NVDA situation exactly, on the very next bridge.

**The correction matters less than what it says about the check.** A cache is a record
of what was asked, not of what exists, and "exactly one token answers X" is only ever
true of the set that was read. **The address is what made this harmless**: everything
keyed on `0xccee82fe…3d09` from the charted pool's `Initialize`, so the impostor was
never a candidate. It has **0 pools with the real HIMS** — the pool that surfaced it
pairs HIMS with the impostor.

**NVDA appears as a HIMS counter with 5 pools and is correctly classified
`no-usd-reference`** — the recursive scope rule holding by itself. A bridge's series
may come only from pools pairing it with a RECOGNISED pricing asset, and pricing HIMS
through NVDA would price one bridge against another.

#### BONER SCOPE: 241 in scope, and the bridge is what buys 84.5% of the market

**2,766 CU, 241 of 388 in scope, 147 rejected.** Routers `probed: 0` — correct and
expected, because scope runs before the sweep and there are no transfers to probe.
**It is not evidence BONER has no routers** and detection is re-run after the sweep.

| counter | venue | in-scope pools |
|---|---|---|
| USDG | v4 155 + v3 1 | 156 |
| native ETH | v4 | 80 |
| **HIMS** | v4 | **3** |
| WETH | v3 | 2 |
| | | **241** |

**Those three HIMS pools are the entire point of the bridge.** Without `bridge_assets`
they are out of scope and produce **no rows at all** — not null-priced rows — and with
84.5% of the swaps that is the token's market discarded. It is the AI/NVDA case again
at a different ratio: AI's hop was worth 4.4x its cohort on 56% of swaps.

#### DENSITY: 142x SPREAD, THE WIDEST RECORDED HERE

Probed from the DEPLOYMENT BLOCK across the range actually to be swept — five samples,
11 requests, **960 CU / $0.00043**, 0 refusals of either kind:

| range | blocks | logs | logs/block |
|---|---|---|---|
| 41,726,520–41,926,520 (deployment) | 200,001 | 16,784 | 0.0839 |
| 45,000,000–45,100,000 | 100,001 | **56** | **0.0006** — the floor |
| 50,000,000–50,100,000 | 100,001 | 1,707 | 0.0171 |
| 56,000,000–56,100,000 | 100,001 | 8,536 | **0.0854** — the peak |
| 63,100,000–63,200,000 (near head) | 100,001 | 3,877 | 0.0388 |

**142.3x between the sparsest and densest sample**, against CHUMP's 91x, CASHCAT's 58x
and AI's 16x. **The peak is at 56M — fourteen million blocks after the window closed
and seven million before head** — and the floor at 45M sits *inside* the token's
post-window life. **A density taken from the window would have been 1.8x too generous;
one taken from the sparsest point, 142x too tight.**

**Sizing the sweep from the blocks actually to be read**, 41,726,520 → 63,255,841 =
21,529,321 blocks:

```
at the densest 0.0854   natural span  70,258   -> 306 requests per stream
at the mean    0.0452   natural span 132,861   -> capped at 100,000 -> 215 per stream
three streams (transfer, swap-v3, swap-v4 x 1 chunk of 500 for 238 pools)
                                   ~645-918 requests x 60 CU = ~39,000-55,000 CU
ceiling in config                   600,000    -- a backstop, not the estimate
```

**THE DEPLOYMENT-BLOCK FIX SAVES MORE HERE THAN ON ANY TOKEN YET.** BONER deployed at
41,726,520, so a sweep from block 0 would have paid
`ceil(41,726,520 / 100,000) = 418` wasted requests per stream-pass across three
streams — **1,254 requests, 75,240 CU, $0.034** — against CHUMP's 42,660 and CASHCAT's
240. **The waste scales with how LATE a token launched**, and BONER is the latest
loaded here, which is the rule's own prediction confirmed at a third point.

#### THE SWEEP: THE BATCHING FIX MEASURED AT LAST — 3,202 rows/sec, 2.57x CASHCAT

**Section 7 said "BONER is the first token that will measure it, and the figure to
record then is rows/second against CASHCAT's 1,248." This is that figure.**

```
duration        627,069 ms = 10.45 min
cost             55,450 CU  =  924 eth_getLogs x 60 + 1 eth_blockNumber x 10, EXACTLY
logs             v3 66,764   v4 391,009   transfer 1,549,971   TOTAL 2,007,744
coverage         all three streams 21,534,845 / 21,534,845 blocks, 0 gaps, 0 overlaps
blocks skipped   41,726,520 below the deployment block -- the fix, in the run's own log
```

| | CHUMP | CASHCAT | **BONER** |
|---|---|---|---|
| rows written | 687,982 | 14,957,528 | **2,007,744** |
| wall-clock | 13.1 min | 199.8 min | **10.45 min** |
| **rows/second** | 875 | **1,248** | **3,202** |
| rows/request | 371 | 4,113 | 2,173 |

**2.57x CASHCAT's throughput, and the comparison is honest but not clean.** CASHCAT
wrote 7.4x more rows, and a bigger job has more opportunity to amortise — so this is
not a controlled before-and-after on the same data, exactly as section 7 warned when it
called the improvement EXPECTED rather than measured. **What can be said: the first
sweep after the fix moved rows 2.57x faster than the last one before it, and nothing
in `pg_stat_activity` showed the backend parked in `ClientRead` between sub-second
inserts this time.** A true measurement still needs one token swept both ways, which
nothing justifies paying for.

**THE CU ESTIMATE LANDED INSIDE ITS RANGE AND THE REQUEST COUNT LANDED ON THE DENSEST
SAMPLE.** I sized 645–918 requests and 39,000–55,000 CU from the density probe; the run
took **924 requests and 55,450 CU** — 0.7% above the top of the range. The per-stream
figure is the tell: **308 requests per stream against the 306 the densest sample
predicted.** Sizing a sweep from the DENSEST probed sample, not the mean, is what made
this land — the mean would have said 215 per stream and been 30% low.

**The v4 stream used ONE chunk.** 238 in-scope v4 pools against the 500-id limit, so
the topic array never split and the request count was not multiplied. CASHCAT's 583
pools needed 2 chunks and paid for it; this is the same rule not biting.

**A PROGRESS TABLE THAT STAYS EMPTY IS THE KNOWN DEFECT, NOT A STALLED RUN.** Five
consecutive polls of `token_sweep_progress` over nine minutes returned **RETURNED NO
ROWS** while the sweep was running normally, because the runner wraps the whole phase
in one transaction and nothing commits until it ends — the still-open item in section 9,
which CHUMP demonstrated with eight empty polls followed by 412,997. **The log file and
`ps` are the progress signals through the runner; the progress table is not**, and
knowing that is what kept this from being escalated at the 3x mark.

#### THE VENUE SPLIT FROM THE SWEEP, and it differs in-window from over the life

**Both figures matter and quoting one would mislead** — the rule CASHCAT established:

| | v3 | v4 | |
|---|---|---|---|
| **full life** | 66,764 — 14.6% | 391,009 — **85.4%** | 171 v4 pools traded, 2 v3 |
| **inside BONER-P1** | **0 — RETURNED NO ROWS** | 73,845 — **100%** | 63 v4 pools traded |

**BONER-P1 is entirely v4. Its v3 market did not exist yet inside the window** — both
v3 pools are WETH pools that traded only after it closed. The cohort therefore comes
from v4 alone, while cost basis and realised PnL over the full life take 14.6% from v3.

**The counter split, in-window, from the sweep:**

| counter | swaps | share | pools traded |
|---|---|---|---|
| **HIMS** | **54,270** | **73.5%** | 1 |
| USDG | 11,950 | 16.2% | 49 |
| native ETH | 7,625 | 10.3% | 13 |

**The free `v4_swaps_all` query said 84.5% and the sweep says 73.5%** — the right ORDER
and an 11-point overstatement, on a 6.1x undercount of the raw number (8,874 against
54,270). **Treated as a lower bound it was useful; quoted as the split it would have
been wrong**, which is what the rule asks for.

**Over the full life HIMS is only 41.7%** — 190,918 of 457,773 — against USDG's 34.8%
and WETH's 14.6%. **The bridge matters far more to the cohort than to the accounting**,
and a single "BONER is a HIMS token" would be wrong for half the work.

**68 in-scope pools never traded at all**, reported rather than omitted: a pool in
scope with no swaps is a real result and is why "pools in scope" is the wrong
denominator for a venue split.

#### ROUTERS: 8 PROBED, 8 IDENTIFIED — the first token with no distributor at all

**11.5 s, 2,974 CU** on the re-run after the sweep, against `probed: 0` before it.

| address | recipients | sends | in a swap tx | verdict |
|---|---|---|---|---|
| `0xb92fe925…` | 5,799 | 18,761 | 64.2% | router — **in the config list** |
| `0x39b38686…` | 216 | 9,001 | 80.7% | router — new |
| `0xe492912f…` | 141 | 341 | **100.0%** | router — new |
| `0xb300000b…` | 87 | 406 | 94.3% | router — new |
| `0xb477751b…` | 87 | 602 | 58.5% | router — new |
| `0x8f10b468…` | 69 | 11,233 | 65.1% | router — new |
| `0x6e2a35a7…`, `0x542298e7…` | | | | routers — new |

**Every candidate cleared the bar: 58.5%–100.0%, nothing at 0.0%.** PONS found 39 of
72, INDEX 19 of 40, CHUMP 3 of 4, CASHCAT 6 of 7 — **BONER is the first token where the
discriminator rejected nobody**, so it separated nothing here. That is not the rule
failing; it is a token whose two-way addresses happen to all be routers. **Seven of the
eight are absent from `config/infrastructure.yaml`**, and `0xb01ca24b…` matched nothing
and is reported as unused.

#### CONVENTIONS: THE v4 IN-WINDOW SAMPLE WAS 100% EXCLUDED, AND NOTHING RAISED

| venue | region | in region | sampled | **excluded** | tested | agreeing | convention |
|---|---|---|---|---|---|---|---|
| v3 | in-window | **0** | — | — | — | — | **RETURNED NO ROWS** |
| **v4** | **in-window** | **73,845** | **800** | **800** | **0** | — | **undetermined** |
| v3 | after-window | 66,764 | 800 | 250 | 550 | **550** | pool |
| v4 | after-window | 317,164 | 800 | 699 | **82** | **82** | swapper |
| both | before-window | **0** | — | — | — | — | **RETURNED NO ROWS**, by construction |

**THE RUN DID NOT RAISE AND THAT IS CORRECT, BY THE RULE THE DOCUMENT ALREADY
SEPARATES.** Step 6 distinguishes a sample that never REACHED a venue — the defect,
which raises — from one that reached it where every swap was ambiguous, which is a
property of the data and raises only if the venue is established in **no region at
all**. v4 is established after-window at 82 of 82. So the guard behaved exactly as
specified.

**What it means is still uncomfortable and must be said plainly: BONER's v4 convention
INSIDE ITS COHORT WINDOW rests on ZERO tested pairs.** Every one of the 800 sampled
in-window v4 swaps sits in a transaction carrying more than one BONER swap. CASHCAT's
worst cell was 89.8% excluded; **this is 100.0%**, and it is the first cell on any token
to exclude its entire sample.

**The cause is visible in the same run: 8 routers, none rejected, and 54,270 of the
window's 73,845 swaps on ONE HIMS pool.** A market that is one deep pool plus eight
routers is a market where almost every transaction touches BONER more than once.

**The honest reading of the verdict:** the v4 swapper convention holds on **82 pairs
from the after-window region and nothing else**, and direction never depends on it —
step 6 is a check and direction always comes from the transfer. **Raising the v4 sample
cap for this token is the way to buy in-window evidence back**, and it was not done
here because the cohort does not depend on it. **Anyone re-reading BONER's v4 amounts
should see 82, from outside the window, rather than "unanimous".**

#### THE COHORT: 1,352, AND IT RECONCILES TO THE CU EXACTLY

**59.7 s, 64,750 CU.**

```
raw buyers in window                  8,931
  excluded as infrastructure         14,703   <- the 8 routers paying off
  excluded as round-trippers         32,640
  excluded as pools                       0
candidate wallets for payment         1,471
  proven free from token_payment_logs     0   <- REPORTED; the table ends at 56,693,145
  proven over RPC                     1,445
  no payment in any transaction          26     1,471 = 1,445 + 26
code-checked at the window's END block 1,445
  excluded as deployed contracts         93
  EIP-7702 delegated accounts KEPT       95
COHORT                                1,352     1,445 - 93 = 1,352
unused exclusions                     0xb01ca24b... matched nothing -- reported
```

**The CU decomposes exactly, with no residual:**

```
payment  1,493 transactions x 15 CU = 22,395
       +   319 receipts      x 15 CU =  4,785   = 27,180  <- reported paymentCu
getCode  1,445 survivors     x 26 CU = 37,570
                                       -------
                                        64,750  <- the phase's cu_spent, exactly
```

**319 of 1,493 transactions needed a receipt — 21.4% — against 14% on PONS and 13.9% on
CASHCAT.** That is the first material departure from a constant this document had twice
called worth trusting. **More of BONER's buyers paid in an ERC-20 rather than native
ETH**, which fits a token whose market is a HIMS pair rather than an ETH pair: paying in
HIMS is an ERC-20 leg, and the cheap native test cannot answer it. **The constant is a
property of how a token is QUOTED, not of the chain**, and this is the counter-example
that shows it.

**95 EIP-7702 delegated accounts kept, 7.0% of the cohort**, against CASHCAT's 7.1%,
AI's 9.0% and CHUMP's 5.5%.

**`token_payment_logs` proved 0 of 1,471, and the zero is STRUCTURAL rather than
merely expected**, as it was on CASHCAT for the opposite reason: that table covers
15,115,287–56,693,145 and BONER-P1 runs 41,726,520–50,134,751, so the overlap is real
— but the table stopped growing when the hourly job was paused and holds only wallets
that paid into a *PONS* pool. A BONER buyer appears only if they also bought PONS.

#### THE PUMP POINT IS STORED, and metric 5's ceiling is 1.0 here

`npm run pump-points -- intake/boner.yaml --commit`, dry-run first: **inserted 1,
already present 0**. Verified on a fresh connection —
`token_events` holds one `pump` row at **2026-08-30 16:00:00+00**, which is
`2026-08-30T12:00:00-04:00` carrying its offset.

**ONE pump, and it IS the window end.** CHUMP and CASHCAT had the same shape and it
capped metric 5 at 1/n_pumps under the old mean. **With one pump the ceiling is
1/1 = 1.0 and the effect that misled three tokens cannot arise here** — and since
2026-09-14 the metric is the maximum anyway. Recorded as a prediction for step 13, not
an assumption.

#### HIMS'S SPREAD AGAINST DIRECT TRADES CANNOT BE MEASURED YET, AND SAYING SO IS THE
#### ANSWER

Step 4 requires it: *two bucketed medians multiplied compound their error — report the
spread against direct token/USD trades in the same buckets rather than assuming it
small.* **It is not measurable at the step 7 stop, and the reason is structural rather
than an omission.**

```
HIMS in-scope pools        131   (USDG 110, native ETH 13, WETH 8)
HIMS swaps SWEPT             0   -- intake/hims.yaml carries sweep ceiling 0, deliberately
HIMS bridge series           0 buckets
HIMS swaps, LOWER BOUND  5,005 across 18 pools, 35,581,659..42,694,912, from v4_swaps_all
```

**The lower bound carries the usual coverage limit and it bites hard here**: the table
ends at 42,695,454 and BONER-P1 runs to 50,134,751, so those 5,005 swaps see **none of
the window past 42.7M** and touch 18 of HIMS's 127 in-scope v4 pools.

**Why the spread needs more than BONER's own data.** The comparison is
`BONER -> HIMS -> USD` against `BONER -> USD` in the same buckets. BONER's side of both
is already swept — it has 3 HIMS pools and 156 USDG pools in scope. **The missing term
is HIMS/USD, which can only come from HIMS's OWN pools against pricing assets**, and
deriving it from BONER's numbers would be circular: it would compute HIMS/USD *from*
the BONER/USDG price it is supposed to validate.

**What it costs to complete**, sized from the blocks actually to be read —
20,950,062 to head is 42.3M blocks at the 100,000 cap:

```
swap streams only (v3 + v4 x 1 chunk of 127 pools)   ~846 requests   ~50,800 CU  ~$0.023
all three streams as the runner sweeps them         ~1,269 requests  ~76,100 CU  ~$0.034
```

**NVDA is the precedent that says swaps alone suffice: it holds 2,742,472 swaps and
ZERO transfers**, and its bridge series derives fine. **A bridge needs ticks, not
attribution.**

---

## 9. Rules here the code does not implement

- **OPEN, found on BONER 2026-09-15: THE COHORT PHASE SPENDS WITHOUT PRINTING A WORK
  SET.** Its log goes straight from `phase starting` to `phase finished` having spent
  **64,750 CU**, and there is no line anywhere between them stating the candidate count
  the spend was sized from. Grepped: the whole run emits `intake starting`,
  `phase starting`, `phase finished`, `STOPPED FOR REVIEW` and the schema lines, and
  nothing else.

  **CHUMP and CASHCAT look like counter-examples and are not.** Both findings sections
  record "the cohort work set, derived before spending" — but that derivation was done
  by the OPERATOR in SQL at the preceding STOP, never by the phase. **The phase has
  never printed one on any token**, and the discipline held only because somebody
  stopped and ran a query by hand each time.

  **On BONER nobody did, and that is my error as much as the code's.** Running
  `--continue` from the conventions stop chains conventions into cohort in one
  invocation, so 64,750 CU was spent against a figure nobody saw — the exact failure
  step 9 names for `eth-usd-series` ("it spent against a figure nobody saw") and the
  reason `--stop-after` exists. **`--stop-after conventions` was the control that
  should have been used and was not.**

  **The outcome was sound — the phase's own report reconciles to the CU exactly
  (1,493 x 15 + 319 x 15 + 1,445 x 26 = 64,750), and a retrospective derivation gives
  31,589 in-window swap transactions behind 1,471 candidates.** That is luck about the
  size of the token, not the rule working. **The fix is for the phase to derive and log
  its candidate count before the first paid call**, which is what step 9's one-derivation
  rule already requires of every job that spends.

- **OPEN, found on BONER 2026-09-15: NOTHING IN THE REPOSITORY EVER WRITES
  `tokens.role`.** Step 14 says "a token loaded only to price another is not a tracked
  token. `tokens.role` records which it is", and `db.ts` declares the column
  `not null default 'tracked'` — so **every identity run writes `tracked` and no code
  path ever writes `pricing-source`.** NVDA's role was set by hand, outside the intake
  and outside every dry-run discipline here, and nothing recorded that it was a manual
  step.

  **HIMS surfaced it by repeating it.** Loading the second bridge ever put
  `role = 'tracked'` on a token with no window, no cohort and no rows — which is
  exactly the state step 14 describes as making NVDA "a dashboard tab for a token
  nobody is tracking, with nothing in it". Two live readers filter on the column:
  `token-price` (`where role = 'tracked'`, every minute) and the dashboard
  (`server.ts`).

  **It did NOT fail this time, and the reason is worth recording rather than being
  relieved by.** NVDA failed `token-price` every minute because it had no pool with a
  recognised quote at the liquidity floor; **HIMS has 110 USDG pools**, so the same
  monitor priced it without complaint — `last_status` success, `consecutive_failures`
  0, across every cycle after the identity run. **The defect is identical and only the
  blast radius differed**, which is the kind of near-miss that stays invisible unless
  it is written down.

  **The fix applied now is the same manual one NVDA got**, scoped to one row and
  dry-run first. **The fix NOT applied is the code change**: the intake should take
  the role from the config — `intake/nvda.yaml` and `intake/hims.yaml` both exist
  precisely to say "this is a pricing source" and neither can. Until then, **every
  future bridge needs the same manual UPDATE and a reader has no way to know that from
  the code.**

- **FIXED 2026-09-14 — metric 5 (`prePumpShare`) could not exceed 1/n_pumps, so it
  carried a fraction of its stated weight and was not comparable between tokens.** It
  averaged each pump's pre-48h buy share over the pumps; pre-windows more than 48 hours
  apart are disjoint, so the shares sum to at most 1 and the mean to at most 1/n. The
  normalised value is the raw one unchanged, so a weight of 0.05 delivered at most
  0.0167 on a three-pump token and the full 0.05 on a one-pump token. Measured on
  CASHCAT: max exactly **0.3333333333333333**, 168 wallets on it, **zero above**.
  Proven on `0x0300e281a7affee0c7b70a2f4cfa5dda16be4112`, whose single priced buy of
  $3,555.03 sits in one window and scored exactly 1/3.

  **The metric is now the MAXIMUM over pumps**, changed in the one implementation,
  `src/scoring/metrics.ts`. The definition, the alternatives that were rejected, and
  the measured effect on every window are in step 13 and in section 8 under CASHCAT.

  **Kept here rather than deleted, because the diagnosis is the reusable part.** Three
  tokens recorded a maximum on exactly 1/n — PONS 1/3, CHUMP 1/2, CASHCAT 1/3 — and
  this document read each as a finding about wallets, having itself written down that
  "a maximum landing exactly on 1/n_pumps is the signature". **A value that repeatedly
  lands on a round function of a CONFIGURED COUNT is a property of the code.** It took
  three tokens and two years of pump counts to ask that question.

- **FIXED 2026-09-13, and this entry read as OPEN until 2026-09-14 — `--continue`
  could not cross two adjacent STOP phases, so the runner deadlocked between `pools`
  and `scope`.** Found on CHUMP, the first token driven through the runner end to end
  rather than phase-by-phase with the standalone CLIs. **The fix shipped the same day
  and this paragraph went on describing it in the present tense**, which is the second
  instance in two days of a section-9 entry outliving the defect it records — the
  first was PONS's routers. **Re-read the code before believing an entry here.**

  **One part of it IS still live and is separated out below**: clearing works when one
  stop is outstanding, and mis-selects when two are.

  `stoppedOn` is assigned inside a loop over `PHASES` with no break, so **the LAST
  stopped phase wins**; and clearing a stop only does `done.add(stoppedOn)` in
  memory — **the phase's stored status is never changed from `stopped` to
  `complete`.** So: run 1 stops at `pools`. Run 2 with `--continue` clears `pools`
  in memory, runs `scope`, stops, and leaves BOTH rows reading `stopped`. Run 3
  computes `stoppedOn = scope` because it is later in the order, adds only `scope`
  to `done`, finds `pools` neither complete nor cleared, re-runs it, and stops
  there again. It never reaches the sweep, and every further `--continue` repeats
  the same two phases.

  **This is why the standalone CLIs exist.** INDEX and the PONS rebuild were driven
  with `sweep-transfers`, `load-swaps`, `build-cohort`, `write-rows`,
  `derive-prices` and `score` called individually, which is a working path and hides
  the defect. The runner's own promise — "IT STOPS WHERE THE DOCUMENT STOPS", five
  phases ending in review — is only true for the first two stops.

  **The fix, shipped: persist the cleared stop as `complete` when it is cleared**, so a
  phase that has already produced its report and had its stop cleared never re-runs.
  Taking the first stopped phase rather than the last would also unblock progress,
  but it leaves stale `stopped` rows behind and the state table then no longer
  describes what happened.

- **STILL OPEN: with TWO stops outstanding, `--continue` clears the LATER one and
  re-runs the earlier.** `stoppedOn` is still assigned by a loop with no break, so the
  last stopped phase in `PHASES` order wins. Sequentially that never bites — each stop
  is cleared before the next is created — but it bites the moment two are outstanding
  at once, which is what `--redo <earlier phase>` produces while a later phase sits
  stopped. The cleared phase is then marked `complete` **without having re-run**, which
  is worse than the deadlock it replaced: the deadlock made no progress and this makes
  false progress. Avoid creating two outstanding stops; `--stop-after` below is how.
- **The runner wraps each PHASE in one transaction, so step 5's "commit progress per
  range" does not happen through it.** `run()` calls
  `withTransaction(app.pool, (c) => fn(rpc, c))`, so every row a 13-minute sweep writes
  is invisible until the phase commits — verified on CHUMP, where eight consecutive
  polls read 0 transfers and the ninth read 412,997. A sweep that dies mid-phase leaves
  **nothing**, which is the opposite of the property step 5 requires and which the
  standalone `sweep-transfers` CLI does provide. Progress is also unobservable while it
  runs, so the 3x wall-clock rule has nothing to check.
- **FIXED 2026-09-13: the timestamp work-set derivation was a single unmaterialised
  statement and hung for 10m34s on CHUMP.** Kept because it is the THIRD instance of
  one shape — after the 19-minute router query and the 17-minute conventions query —
  and because the tell was a `pg_stat_activity` row rather than anything in the job's
  own log, which had not yet printed its work-set line. Two `order by 1` sorts over a
  `::text` cast were fixed in `fill-timestamps` at the same time; they ordered blocks
  lexicographically and changed no value.

- **FIXED 2026-09-13 — EVERY PHASE AFTER `identity` RAN WITH UNRESOLVED BOUNDS ON A
  RESUMED RUN, and this is the FOURTH time that defect has produced a clean pass over
  an empty range.** `firstBlock` and `head` are produced by the identity phase and
  held in local variables; a STOP ends the process, so on any resumed run both are
  **0** and each consuming phase either re-fetched `head` itself or silently used
  zero. The roll-call:

  | token | phase | what it reported |
  |---|---|---|
  | AI | scope / routers | detection over `between 0 and 0` — *0 routers*, a clean pass |
  | INDEX | windows | fell back to raw config bounds, both `undefined` |
  | CHUMP | conventions | after-window region `44,992,964..0`, dropped — **262,954 swaps, 95.6% of the token**, unverified |
  | CHUMP | **prices** | `derivePricesForLife(…, 0, 0)` — **0 ticks, 0 buckets, 0 written, in 9 ms**, reported as success |

  **`dryrun` and `write` take the same two variables and were never reached with
  them**, so this was caught one phase before it mattered most: the write counts
  existing rows with `block_number between firstBlock and head`, which over `0..0`
  returns **0** — and zero is that check's *passing* answer. It would have stored
  nothing and reported success.

  The fix is one resolver, `ensureBounds`, called by `run()` before every phase after
  `identity`: it reads the deployment block back from the stored identity report and
  **raises rather than defaulting**.

  **`head` comes from what was SWEPT, not from the chain, once a sweep exists** —
  `max(to_block)` over `token_sweep_progress`. Two reasons, and the second is the
  stronger. `prices`, `dryrun` and `write` carry a CU ceiling of **0**, because they
  read the database and nothing else, so resolving head over RPC made the ceiling
  refuse `eth_blockNumber` — the ceiling working exactly as designed, and the bound
  had to come from somewhere free. More importantly, **a phase after the sweep must
  be bounded by the blocks that were READ**, not by where the chain has since got to:
  the live head includes blocks nothing has swept, and a range running past the data
  is how a count over an unread region reads as a real zero. Before any sweep exists
  there is nothing stored and those earlier phases all carry a real ceiling, so the
  RPC route is taken then. Putting it in
  `run()` rather than in each phase means a phase cannot be added that forgets it,
  and it is deliberately the ONLY implementation — the bespoke copy written for the
  conventions phase an hour earlier was deleted, because two implementations of one
  rule drift.

- **The conventions check sampled ACROSS venues and skipped regions computed from
  unset bounds.** FIXED 2026-09-13, found on CHUMP. Two independent faults in one
  phase, and both of them report a pass:

  1. `order by block_number limit 800` over a region, one result shared by both
     venues. CHUMP's first 800 in-window swaps are all v3, so its 18 in-window v4
     swaps were never sampled, and `tested: 0` passed because the raise fired only on
     `tested > 0`.
  2. `head` and `firstBlock` are set by the phases that fetch them, and a resumed run
     skips those phases, so both were **0**. The after-window region became
     `44,992,964..0`, failed `to <= from`, and was silently dropped — **262,954
     swaps, 95.6% of the token's total, never verified**.

  It now resolves `head` from the chain and `firstBlock` from the stored identity
  report, samples per venue per region, reports an empty region as RETURNED NO ROWS
  rather than skipping it, and raises on an inverted region rather than dropping it.

  **Two things look alike in a `tested: 0` and only one is a bug**, so they are
  separated rather than both raising: a sample that never REACHED the venue is the
  defect and raises per region; a sample that reached it where every swap was
  ambiguous is a real property of the data, is reported with its `sampled` count, and
  raises only if that venue is established in **no region at all**.

- **FIXED 2026-09-13 — `--redo <phase>`. The runner had NO WAY TO RE-RUN A
  COMPLETED PHASE, and step 7 requires exactly that for `scope`.** Step 7 says router detection must run after the sweep and
  names the remedy — "Re-run scope after the sweep, or move detection to the cohort
  step". Detection lives inside the `scope` phase, `scope` runs before the sweep, and
  `run()` returns immediately for any phase whose stored status is `complete`. So the
  documented remedy cannot be carried out through the runner at all: there is no
  `--redo <phase>` and no flag of any kind.

  CHUMP is the worked case. Its scope phase probed **0** candidates and persisted
  **0** routers, which is indistinguishable from a token with none, and the cohort
  phase would then have run against `config/infrastructure.yaml` alone — **the exact
  defect recorded against PONS**, whose 13,095-wallet cohort was built with zero
  behavioural routers persisted.

  Without it the phase's stored status had to be reset by hand, which is a database
  write outside the runner and therefore outside the dry-run discipline every other
  write here obeys. `npm run intake -- <cfg> --redo scope` now clears the stored
  status for exactly the named phase and nothing else, rejects a name that is not a
  phase, and **copies the previous report to `<phase>:superseded` before clearing
  it** — the state table is the only record of what a phase actually did, and
  overwriting it would destroy the figure the re-run exists to be compared against.
  It reports the row it cleared rather than asserting it did.

  Moving detection into the cohort phase would also work and would remove the need to
  re-run anything at all; that is the better fix and is not done.

- **FIXED 2026-09-14: the runner swept from block 0 rather than the token's
  deployment block — and it had ALREADY BEEN FIXED BY ACCIDENT, which nobody
  checked.** CHUMP's sweep read 23,791,950 blocks that cannot contain the token:
  **711 of its 1,853 recorded requests, 42,660 CU, $0.0192 — 38.4% of the sweep and
  30.0% of the whole intake** — and those 711 requests returned **0 logs between
  them**, which is the proof rather than the argument.

  **The accident is the part worth recording.** `ensureBounds`, added the day before
  for an unrelated defect, resolves `firstBlock` from the stored identity report
  before every phase after `identity` — so from that commit onward the sweep was
  already starting at the deployment block. Nothing said so, no test covered it, and
  the document still carried the defect as open. **A fix that arrives as a side
  effect of another fix is indistinguishable from no fix at all until someone reads
  the code path end to end.** The `|| 1` fallbacks at the `windows` and `pools` call
  sites were dead for the same reason and are removed, because a fallback that can
  never fire hides the guarantee it was standing in for.

  **A SECOND DEFECT WAS INTRODUCED BY THAT SAME FIX, and it is live.** `ensureBounds`
  resolves `head` from `max(to_block)` over `token_sweep_progress` whenever a sweep
  exists. That is right for every phase AFTER the sweep — they must be bounded by
  blocks actually read — and **wrong for the sweep itself**: on `--redo sweep` the
  sweep would be bounded by where the *previous* sweep stopped, could never extend to
  the current head, and `checkCoverage` would report clean coverage over a stale
  range. The same applies to `pools` and `scope`, which enumerate against the chain.
  `LIVE_HEAD_PHASES` now names the four phases that read the chain — `windows`,
  `pools`, `scope`, `sweep` — and they take the live head; everything after takes the
  swept one. **A bound that is correct for one half of a pipeline and wrong for the
  other cannot be a single value**, which is what the first version of `ensureBounds`
  assumed.
- **`decodeSwap` threw a bare TypeError on a v4 log with no `topics[1]`.** FIXED
  2026-09-13. A v4 pool id lives in `topics[1]`, so a log reconstructed from stored
  columns has none, and the conventions phase died three frames down with
  `Cannot read properties of undefined (reading 'toLowerCase')` — on CHUMP, the first
  token whose conventions check ran against reconstructed v4 logs. It now takes an
  optional `knownPool`, which the conventions loop already had and never used, and
  raises with a message naming the cause when neither is available. **The fix keeps one
  decode implementation** rather than a second written to avoid the line.
- **FIXED 2026-09-13: a swallowed query error silently rolled back an entire write
  phase while it reported success.** `select ... max(total_supply) from tokens`
  references a column that has never existed, and it was wrapped in
  `.catch(() => 0)`. The failed statement aborted the transaction, the following
  `COMMIT` returned the tag `ROLLBACK` without raising, and the phase status was
  written by a SEPARATE transaction that committed — so the log read
  `rows_stored: 3200` and `intake complete` over an empty table. Caught only by
  querying on a fresh connection. `withTransaction` now raises when COMMIT returns
  ROLLBACK, which covers every caller, and the supply is read from the stored
  identity report and raises if absent. Never fired before because CHUMP is the
  first token driven through the runner end to end.

- **FIXED 2026-09-13: `checkPricesAgainstTicks` compared every row against the
  token's WHOLE USD series rather than against its own bucket**, which assumes the
  series spans the token's life. CHUMP's covers 1.3% of it — 49 USDG-derived buckets,
  all after its window closed — so **1,749 correct rows were rejected and the write
  refused**. Now compared per bucket at the native fence: 0 of 10,215 outside 10x.
  Proven on decoded swaps first, including a 0.23% agreement between the WETH route
  and a direct USDG quote in the one era where both exist.

- **FIXED 2026-09-13: the intake wrote `native_usd_prices` for every token, ignoring
  the one-owner-per-chain rule.** `pricing.derives_native_usd` has named the owner
  since the rule was written and the monitors honour it, but `plan.ts` never read the
  key, so it was not a valid intake option and `persistAllPrices` wrote the shared
  series regardless. **It surfaced as `deadlock detected`** on CHUMP's prices phase
  against an `index-updates` run overlapping it by two seconds — a symptom, where the
  defect is a second writer of a chain-level table. The intake now reads the key,
  defaults to false, still derives in memory, and reports the buckets it did not
  write.

- **FIXED 2026-09-13: the per-token `<ticker>_usd_prices` table was created by no
  code.** `SCHEMA` creates `pons_usd_prices` and nothing else, so `index_usd_prices`
  and `ai_usd_prices` were made by hand and CHUMP's prices phase failed with
  `relation "chump_usd_prices" does not exist` **after deriving the entire series**.
  The configured `tables.token_usd` is now created when missing, its name validated
  against `^[a-z][a-z0-9_]*$` first. Found alongside it: the two hand-made tables
  declare `pons_usd` and `ticks` `NOT NULL` while `pons_usd_prices` — the one the
  schema creates — has them nullable, so the definition and the deployed shape had
  already diverged with nothing reporting it.

- **STILL OPEN, found on CASHCAT 2026-09-14: `verifyConventions` has NO
  ONE-SWAP-PER-TRANSACTION GUARD, so a multi-pool route reads as a convention
  disagreement.** It raised `v4/in-window 779/790` on CASHCAT — 11 of 790, 1.39% —
  and decoding two of them settled it: a router buys on one CASHCAT/ETH v4 pool and
  sells on another **inside one transaction**, and only the NET leaves the
  PoolManager. `verifyConventions` pairs EACH swap against that single net transfer,
  so on a two-swap transaction one of the two must appear to disagree.

  Hashes, for anyone re-checking:
  `0x414077b6ec56a58e91c751d8319280986069cdf70350ec4639e35e6e5d6316cf` (block 903,126,
  +42.58 on `0x604867…` against −41.19 on `0x74739c…`, 1.387 out) and
  `0x3ce6aa42f979ec20f7eea83c01e0254a02989f168e14230db7121464cb2010d5` (block
  1,352,363, 1.085 out). All three pool ids are CASHCAT pools per `pool_meta`.

  **`build-cohort.ts` already has the guard — `spt.n = 1` — and `verifyConventions`
  does not.** Two implementations of one rule for the fourth time on this project,
  and this time the RUNNER's is the weaker one, which inverts the usual direction:
  the standalone CLI is the careful path here.

  **The fix does not need `v4_swaps_all`**, and that matters: both hops are the
  token's own pools, so `token_swap_logs` can see them and a `count(*) per tx_hash`
  test suffices. **`v4_swaps_all` holds 0 rows anywhere inside CASHCAT-P1** — its
  coverage starts 11.3M blocks after the window ends — so a fix routed through that
  table would fix nothing for this token.

  **NOT FIXED, deliberately.** The conventions check decides whether every amount this
  system stores can be trusted, so changing what it counts as evidence is a change to
  what "verified" means for every token. That is an operator's call, and CASHCAT's
  intake is stopped at step 6 until it is made.

- **FIXED 2026-09-14 — `eth-usd-series` REPORTED A WORK SET IT DID NOT USE, printing
  `buckets_missing_in_range: 0` on CASHCAT and then writing 140.** Its
  "BEFORE THE FIRST REQUEST" figure is derived from
  `wallet_transactions … usd_amount is null` — buckets needed by rows that are ALREADY
  unpriced — which is a repair tool's work set and was right for INDEX, whose 6,052
  nulls existed before the fix. **CASHCAT has no rows yet**, deliberately: its intake
  stops at step 7. So the stated work set was empty while the sweep went on to derive
  and insert 140 genuinely missing buckets.

  **The outcome was right and the reporting was not**, which is the combination this
  document treats as dangerous. Step 9's rule is explicit — *there is ONE derivation,
  used by both the estimate and the fetch; if the two disagree the job stops rather
  than spending against a figure nobody saw* — and here they disagreed by 140 buckets
  and 3,600 CU. It spent against a figure nobody saw, and it happened to be spending
  worth doing.

  **The fix: the reported work set is now the one the job acts on** — every whole
  bucket on the grid inside `--from..--to` that has no stored price. The
  repair-oriented figure is kept beside it as `buckets_needed_by_unpriced_rows`,
  clearly labelled, because it is genuinely the right question when repairing a token
  whose nulls already exist. Neither question is lost and neither is mistaken for the
  other.

  **The residual is now explained rather than merely absent.** Not every candidate
  bucket can be filled — a bucket where the market never traded stays a gap, by step
  10's rule — so the run reports `still_missing` after writing, with that reason. On
  CASHCAT that is 18 of 158, all in the sparse 93,150–743,150 region. **A work set
  that shrinks between the estimate and the write is fine; one that shrinks without
  saying why is the defect.**

  Pre-filling before rows exist is strictly better than repairing afterwards — nothing
  is written wrong and nothing needs reinserting — and the tool can now say so before
  it starts.

- **`token_swap_logs` is created by no code in this repository.** Every reader
  assumes it exists because the first intake made it by hand. A fresh database
  fails at the first read. Its shape is recorded in step 5.
- **FIXED 2026-09-13, kept for the pattern: `token_events` was written by no code
  either.** `SCORES_SCHEMA` creates it and `scoring/run.ts` reads it, and pump
  points — an operator input listed in section 2 alongside the token address and
  the window — reached it by no path in the repository. Every earlier token's pumps
  were inserted by hand, exactly as `token_swap_logs` was, so a fresh database
  would have scored nothing: `scoreWindow` raises when a token has no pump events,
  which is correct and would have been unexplainable. `pump_points` in an intake
  config was inert — `plan.ts` never read the key. Found on CHUMP because it is the
  first token whose pumps nobody had already inserted. **A table that is created
  and read but never written is a missing step, not a missing row.**
- **One bridge cannot serve two tokens with different bucket anchors.**
  `deriveBridgeUsd` runs on the grid of the token being priced, and
  `bridge_usd_prices` is keyed `(chain, bridge, bucket_block)` with no room for a
  second grid — so a second token pricing through NVDA on its own anchor would
  interleave two series in one table. The same applies to `native_usd_prices`,
  keyed `(chain, block_number)` with no token column, which already holds PONS's
  buckets at residue 3150 and AI's at 1433. Both are correct today because each
  reader finds its own; neither is correct once a third token arrives. Give the
  shared series a chain-level anchor before that happens.

- **Nothing scores Solana.** `MOS` (519 wallets across 4 windows) and `USELESS`
  (1,615 across 3) are tagged and have rows, and `wallet_scores` holds nothing
  for either. The scorer is correctly Robinhood-scoped after it once scored them
  from a Robinhood monitor, but the document describes scoring as covering every
  window and no window of these two is covered.
- **NVDA is PARTIALLY COLLECTED BY DESIGN, and two consequences follow.** Its
  1,443,064 in-scope swap blocks carry no `block_times` row, and it has **0 stored
  transfers** against 2,742,472 swaps. Both are correct for a pricing source — it
  needs swaps for the bridge series and nothing else — and both cost nothing today
  because it has no cohort, no tags and no rows. **Both become blockers the moment
  NVDA is tracked**: the bridge series is derived from swaps whose blocks the code
  cannot date, and router detection reads `token_transfer_logs`, which is why NVDA's
  stored scope report reads `probed 0 / identified 0`. **That zero is correct for the
  data collected and is not evidence NVDA has no routers.** Recorded here so a future
  reader does not mistake a deliberate partial collection for a clean result.

- **The shared series still has no chain-level anchor.** Partly addressed on
  2026-09-13: ETH/USD is now derived from the dedicated WETH/USDG market and the
  coverage hole below 5,363,150 is filled. The FRAGMENTATION is not fixed. The
  series is still written on the residue-3150 grid because that is what PONS and
  INDEX read, `counterUsdResolver` still looks up native prices on the *token's*
  anchor rather than the chain's, and AI's **4,172 buckets at residue 1433 remain
  unreadable** by the other two tokens. A third anchor would still fragment it
  further. The fix is a chain anchor for `native_usd_prices` plus a resolver that
  uses it for the native series while keeping the token's anchor for the token's
  own and for bridges.
- **76 stored ETH/USD buckets disagree with the market by 5–10% and still stand.**
  The 18 over 10% were overwritten on 2026-09-13 under the exception recorded in
  step 10; 2–5% is inside the tolerance nobody acts on; **5–10% was a judgement
  call that was not taken.** Same-bucket measurement: 291 compared, mean 4.47%,
  median 3.22%, 194 over 2%, 94 over 5%, 18 over 10%.
- **AI's own ETH/USD buckets have never been examined for this.** The repair ran on
  the residue-3150 grid, which AI does not read — **0 AI rows were affected**. Its
  4,172 buckets at residue 1433 were derived the same by-product way and are
  presumed to carry the same defect. Examining them needs the market derivation run
  on AI's grid, which is cheap now that the market swaps are stored.
- **The chain's ETH/USD series was an accident of which tokens were loaded, and
  a dedicated market existed that nothing read.** FIXED 2026-09-13; kept for the
  lesson. `native_usd_prices` is
  chain-level but derived per token, existing only where a tracked token traded
  against both a native asset and USDG inside one bucket. It therefore begins at
  5,363,150 — the bucket of INDEX's first USDG swap — leaving 6,052 INDEX rows
  below it unpriced, and its earliest buckets rest on a **single USDG tick**,
  swinging 1,877 → 1,434 → 1,653 across 110,000 blocks. Meanwhile **48 WETH/USDG
  and ETH/USDG pools exist, the earliest since block 50,716, with 264,078 swaps
  in the gap alone** (probed 2026-09-12, $0.0045). Derive ETH/USD from those
  pools on a chain-level anchor, which fixes the gap and the single-tick buckets
  together, and also removes the two-residue fragmentation — 5,473 buckets at
  3150 and 4,172 at 1433 that no single reader can both see.
- **PROPOSAL, not a defect: allow a window bound to be a BLOCK as well as an
  instant.** Section 2 requires an offset-qualified instant and `plan.ts` rejects
  anything else, which is correct as it stands — a bare local time is a different
  moment depending on who reads it. But an instant is **1-to-10 against blocks on
  this chain** (section 3), so where the intended bound is a specific block — a
  deployment block, a window that starts where the token starts — an instant cannot
  express it exactly. Evidence: ten blocks share timestamp 1785462270, and
  CHUMP-P1's start instant would resolve to 23,791,940 if the search began at block
  1. Through the runner it resolves to the deployment block 23,791,950, because
  `resolveWindows` clamps the low bound to it — so the proposal is about expressing
  intent directly, not about a wrong answer being produced today.

  It is recorded as a proposal because **a window bound is the most load-bearing
  definition in this document** — it decides cohort membership, metric 3's
  denominator, and the `token_windows` row the dashboard and scorer read — and it is
  not a change to make inside an intake. CHUMP was loaded with an instant bound ten
  blocks before its deployment instead, which contains no CHUMP and therefore
  changes no cohort. Deciding it needs an operator, not a run.
- **A config comment asserted coverage the data contradicts.** `intake/index.yaml`
  justifies its bucket anchor by claiming the shared series spans "its whole
  life"; 7.47M blocks of INDEX's life sit outside that span. Claims like this
  need checking against the series they name, in config as much as in this
  document.

- **FIXED 2026-09-13: the watcher derives ETH/USD for its own slice in memory.** The
  priced share went 40.0% → 2.4% (as the gap to the stored series grew) → **67.6%**,
  and the "no ETH/USD bucket" reason is now zero. Kept here for two lessons: a figure
  I first reported as a fixed ~36% was **not a constant but a growing gap**, and the
  fix was a fourth option none of the three I first listed — worth pausing for when
  every available option costs something. `native_usd_prices`
  reaches 61,553,150 because the hourly job derives it an hour behind, while the
  watcher reads to within 200 blocks of head — 21,792 blocks past the series on its
  first run, against a 10,000-block bucket. 69 of 189 rows could not price. The
  three options and their costs are in step 17; **the choice has not been made.**
  Token amounts are unaffected and always correct.

### REPLAY: were PONS, AI and INDEX exposed to CHUMP's four fixes? — 2026-09-14

**Each of the four "success over nothing" fixes shipped with one token's evidence.
This replays them against stored data, read-only, for every other token. Three come
back CLEAN, and a clean result is a result.** The structural fact that makes most of
them clean is worth stating first:

**PONS, AI, INDEX and NVDA have only FOUR stored phase rows each — `identity`,
`windows`, `pools` (stopped), `scope` (stopped).** They have no `sweep`,
`conventions`, `cohort`, `tags`, `timestamps`, `prices`, `dryrun` or `write` row,
because the runner deadlocked at `scope` (the first entry in this section) and they
were finished with the standalone CLIs. **Three of the four defects live in runner
phases those tokens never ran.**

#### 1. `withTransaction` / the silent ROLLBACK — CLEAN for all three

| token | exposed? | why |
|---|---|---|
| PONS | **no** | rows written by `write-rows.ts` |
| AI | **no** | same |
| INDEX | **no** | same |
| CHUMP | yes, fixed | the only token that ran the runner's `write` phase |

`write-rows.ts` has **no `total_supply` query, no `.catch` returning a default, and
no `begin`/`commit` at all** — it runs in autocommit, so each statement is its own
transaction and there is no enclosing transaction for a failed statement to abort.
Both halves of the defect are absent, not merely unfired.

**Reports checked against the tables, which is the consequence rather than the code
path.** Every stored `pools` report's `candidates` figure equals the length of its own
stored candidate list, exactly, for all five tokens — 1,234 / 5,040 / 317 / 58 /
12,105. No phase is recorded `complete` over an empty table.

**`scope.in_scope` is LOWER than `pool_meta` for every token that has an hourly
monitor, and equal for the one that does not**, which is the explanation rather than a
discrepancy:

| token | scope report `in_scope` | `pool_meta` now | hourly monitor |
|---|---|---|---|
| PONS | 617 | 672 | yes |
| AI | 350 | 367 | yes |
| INDEX | 196 | 201 | yes |
| CHUMP | 51 | 52 | yes |
| **NVDA** | **536** | **536** | **none — and it matches exactly** |

The adapter enumerates pools every run and adds newly created in-scope ones, which is
step 3's "re-derive the pool set every run" working. **NVDA is the control**: the only
token without an hourly monitor is the only one where the two agree. `pool_meta` has
no `created_at`, so this is a natural experiment rather than a per-row proof, and that
limit is stated rather than glossed.

#### 2. `ensureBounds` / zero-valued bounds recorded as success — CLEAN for all three

Every stored bound is non-zero and plausible:

```
                deployment_block   identity head   windows:resolved
PONS                   8,963,150      59,819,241   15,115,267..42,695,454
AI                     9,721,433      58,215,021   18,275,461..32,206,441
INDEX                  1,670,725      59,031,666   1,693,406..9,800,208  and  25,165,577..44,130,852
CHUMP                 23,791,950      61,665,392   23,791,950..44,992,963
NVDA                      45,898      58,269,658   18,275,461..32,206,441
```

**No stored report carries an all-zero figure set.** AI's stored `scope` report reads
`probed 16 / identified 15` — **not** the `probed: 0` this document records for it.
That zero came from a run over `0..0` that was superseded; the stored state carries
the corrected measurement. **A defect that has been re-run away leaves no trace in the
store, so the store cannot be used to find it — only to confirm the current state is
sound.**

#### 3. Conventions sampled across venues — ONE TOKEN EXPOSED, and it never fired

The old sampler took `order by block_number limit 800` per region and handed one
result to both venues. Replayed against every token's stored swaps:

| token | region | in region | old sampler's first 800 | verdict |
|---|---|---|---|---|
| PONS | in-window | v3 291,207 · v4 480,924 | v3 241 · v4 559 | covered both |
| PONS | before-window | v3 146,851 · v4 85,454 | v3 798 · v4 2 | covered both |
| PONS | after-window | v3 1,655,527 · v4 883,386 | v3 388 · v4 412 | covered both |
| AI | in-window | v3 48,310 · v4 121,621 | v3 248 · v4 552 | covered both |
| AI | before-window | **RETURNED NO ROWS** | — | see below |
| AI | after-window | v3 485,076 · v4 1,469,106 | v3 316 · v4 484 | covered both |
| **INDEX** | **in-window** | **v3 3,469 · v4 32,678** | **v4 800, v3 0** | **WOULD HAVE MISSED v3** |
| INDEX | before-window | v4 194 only | v4 194 | covered both |
| INDEX | after-window | v3 247,188 · v4 309,434 | v3 229 · v4 571 | covered both |
| CHUMP | in-window | v3 12,013 · v4 18 | v3 800, v4 0 | missed v4 — the original finding |

**INDEX has the identical defect shape as CHUMP, in the opposite direction**: its
in-window region opens on 32,678 v4 swaps before the first of its 3,469 v3 swaps, so a
first-800 sample is entirely v4. **It never fired.** INDEX's conventions were measured
by `build-cohort.ts`, which computes them "from everything stored" with **no LIMIT** —
its recorded figures are 22,838 and 62,550 for v3, far beyond any 800-row sample. The
exposure was latent and the second implementation is what happened to save it, which
is a poor reason to be safe.

**AI's `before-window` RETURNED NO ROWS, and that is a COVERAGE ARTEFACT, not an
absence.** AI's first swap is ~547 blocks after its deployment at 9,721,433, but its
stored swaps begin at **18,275,462** — inside its window — because its v4 swaps were
copied from `v4_swaps_all`, which starts at 15,115,267, and its v3 sweep covered the
window. **Roughly 8.5M blocks of AI's early life were never collected.** This is
exactly the trap the INDEX findings name: *a zero from a table whose coverage you have
not checked is not a finding.* AI's before-window convention therefore rests on no
stored evidence at all, in either the old code or the new.

#### 4. Routers — CLEAN for all four loaded tokens; NVDA's zero is explained

| token | persisted `router:%` rows | stored report probed / identified | verdict |
|---|---|---|---|
| PONS | **39** | 72 / 39 | persisted; the cohort used them |
| AI | **15** | 16 / 15 | persisted |
| INDEX | **19** | 40 / 19 | persisted |
| CHUMP | **3** | 4 / 3 | persisted |
| **NVDA** | **0** | **0 / 0** | **zero probed, recorded as a clean pass** |

76 `router:%` rows in the table, and every loaded token's count matches its report's
`identified`. **The step 7 claim that PONS has zero persisted routers was stale by two
days** and is corrected above.

**NVDA's zero is correct for the data collected and must still be reported.**
`detectRouters` reads `token_transfer_logs`, and NVDA has **0 transfers stored**
against 2,742,472 swaps — it was loaded as a pricing source, so its swaps were swept
for the bridge series and its transfers never were. There was nothing to probe.
Benign today (no cohort, no tags, no rows) and **it becomes a real gap the moment NVDA
is tracked**, alongside its untimed swaps already recorded below.

### AUDIT: swallowed errors that emit a plausible value — 2026-09-14

Grepped for every `.catch` returning a value, every `??`/`||` default on a query
result, every SQL `coalesce` to a numeric default, and the RPC error paths. **One is
live.**

**FIXED 2026-09-14 — `src/cli/intake.ts:1063`, a bridge's decimals defaulted to 18.**

```ts
const bdec = (await c.query(`select decimals from tokens where mint=$1`, [bridge]))
  .rows[0]?.decimals ?? 18;          // now: raises, naming the bridge
```

A bridge with no `tokens` row — or a null `decimals`, which `??` also caught — silently
became **18 decimals**, and `bdec` scales every bridge amount in `deriveBridgeUsd`.
That is the factor-of-10^12 case steps 1 and 4 name by name, and **USDG has 6**. The
token's own decimals raised fifteen lines above; the bridge's did not. It now raises
with the bridge address in the message, matching `decodeUint8`'s *"the value is
unknown, not zero"* four lines away.

**It was dormant, not safe, and it stops being dormant on the next intake:** AI is the
only loaded token with a bridge and NVDA's `tokens` row exists, but **BONER is queued
and needs a HIMS bridge**. A bridge gets its `tokens` row from a separate identity run,
and nothing in the prices phase checked that this had happened.

**FIXED 2026-09-14, the disclosure half — `src/cli/build-cohort.ts:217–223`,
`coalesce(av.n, 1)`.** **The coalesce stands**: it *is* the fallback to the token's own
count that step 7 describes, and inside `v4_swaps_all`'s coverage a missing row
genuinely means no v4 swap. What was wrong is that the same `NULL` means "not
collected" outside that coverage, the test then admits the leg as unambiguous, and the
code comment promised it "says so" while nothing counted it. The conventions log now
reports how many compared transactions fall outside the covered range. **A fallback
that is not counted is indistinguishable from a test that passed.**

**STANDS, with the reasoning recorded so it is not re-flagged —
`src/adapters/postgres-disk.ts:196`, WAL bytes `coalesce((select sum(size) from
pg_ls_waldir()), 0)`.** I flagged this on 2026-09-13 and it does not survive
measurement:

- **The default is unreachable.** `sum()` returns `NULL` only over zero rows, and a
  live WAL directory is never empty — measured 2026-09-14: **8 files, 134,217,728
  bytes**, with the role holding permission. A role *without* permission makes
  `pg_ls_waldir()` **raise**, failing the monitor visibly rather than returning zero.
- **It feeds no decision.** The alert threshold is `volume.usedMB / volume.sizeMB` from
  the provider, and the growth projection compares `volume_used_bytes` to
  `volume_used_bytes` — deliberately, with a comment recording that using `total_bytes`
  once produced *"2.2 days until full"* for a database that had just been emptied.
  `wal_bytes` is context in a display field and a history column.
- **Making it honest costs a migration.** `wal_bytes` and `total_bytes` are
  `bigint NOT NULL`, so a genuine "not measured" needs `drop not null` on two live
  columns — and the schema file already records that `create table if not exists` will
  not do it.

  **Unreachable, decision-free, and a migration to improve: it stays.** Were it ever to
  feed a threshold, this reasoning expires with it.

**Everything else checked and SAFE, with the reason in each case:**

- Every `main().catch(err => { log.error(…); process.exit(1) })` — logs and exits
  non-zero. The correct top-level handler.
- `rowCount ?? 0` throughout — node-pg types `rowCount` as nullable; a failed statement
  throws, so the `??` satisfies the type checker and is never an error path.
- `rows[0]?.x ?? 0` over an **aggregate with no GROUP BY** (`write.ts:139–140`,
  `sweep.ts:270–272`, `server.ts:343–344`) — such a query always returns exactly one
  row, so the default is unreachable. `sweep.ts` additionally **raises** if the covered
  count does not equal the expected one.
- `src/intake/blocktimes.ts:113` — `return null` on a transient transport error is a
  **retry signal**, which is the three-category rule in section 3 implemented, not a
  value.
- `src/intake/monitor-check.ts:39` — an unreadable monitors directory returns null and
  the caller **raises**. It fails closed.
- `src/store/db.ts:363` — `rollback().catch(() => {})` sits inside a handler that
  rethrows the original error.
- `src/sinks/discord.ts:212` — a failed body read becomes `''` inside a diagnostic
  string for an already-failing request; no figure is derived from it.
- `src/web/tokens-page.ts:786` — stores an **error marker** and renders it, rather than
  substituting a value.
- `decodeUint8` **throws** on `0x`: *"contract returned no data; the value is unknown,
  not zero"*, and `RpcClient` raises on `body.error` and on a null/undefined `result`.
  The `balanceOf` fix is holding.
- `server.ts:397–400` — `coalesce(sum(usd_amount), 0)` is paired with a `priced` count
  and `tok_priced`, so "no priced rows" stays distinguishable from a real zero, which
  is what step 14's unknown-average rule needs.

One further limitation is a property of the chain rather than a gap in the code:

- **A bucket median is still a median over ~17 minutes.** The window-median bias
  measured elsewhere (95.56 whole-window against 127.17 and 97.41 for the
  halves) has never been measured on this chain. Measure it on a token that
  moved.

**Closed on 2026-09-12**, and kept here because the pattern recurs: three
separate tables kept members a cohort no longer had — `wallet_tags`,
`wallet_scores`, and `wallet_transactions` rows for dropped wallets. All three
were upsert-only. **Whenever a membership can change, every table derived from it
needs a removal path, not just an upsert**, and the check belongs in the write
itself rather than in a later report.

Also closed: the block-timestamp step took the metered route for 717,340 blocks
while this document had said since the first intake to test the free
alternatives first. Both are now implemented; the point is that each sat here
unimplemented while work was built on top of it.

When something is found that this document requires and the code does not do,
it goes here, and it is a defect in the code.
