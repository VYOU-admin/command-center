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
| **PONS** `0x39dBED…4571` | tracked | `PONS-P1` 13,823 · `PONS-P1-T` 396 | 504,137 | 14,138 | 61,173,149 | `token-updates` ✅ | 13,823 |
| **INDEX** `0x56910D…9870` | tracked | `INDEX-P1` 3,316 · `INDEX-P2` 4,267 | 156,981 | 7,230 | 61,193,149 | `index-updates` ✅ | 7,583 |
| **AI** `0x2E8c31…1e18` | tracked | `AI-P1` 3,508 | 59,863 | 3,507 | 61,181,432 | `ai-updates` ✅ | 3,508 |
| **CHUMP** `0x0E0d2C…C21B` | tracked — **IN PROGRESS** | `CHUMP-P1` not yet tagged | 0 | 0 | not swept | **none yet** | never |
| **NVDA** `0xd0601c…9eec` | **pricing-source** | none | 0 | 0 | 59,111,432 | none — correct | never |
| **MOS** `4ChT49…91ZT` | tracked (**Solana**) | `MOS-P1..P4` 519 | 1,534 | 486 | none | none | **never** |
| **USELESS** `Dz9mQ9…bonk` | tracked (**Solana**) | `USELESS-P1..P3` 1,615 | 10,458 | 1,462 | none | none | **never** |

```
row breakdown  PONS  buy 115,084  sell 76,195  transfers 312,193
               INDEX buy  58,934  sell 29,318  transfers  68,471
               AI    buy  22,976  sell 14,764  transfers  21,852
price series   pons 5,171  index 5,488  ai 4,171  bridge(NVDA) 4,065
native ETH/USD 10,159 buckets: 9,652 token-incidental, 489 market-derived,
               18 market-repaired.  trade rows with null USD: AI 169, PONS 67, INDEX 0
watchlist      1,248 memberships, 1,151 distinct wallets, top 5%
monitors       token-updates, index-updates, ai-updates, token-price, wallet-scores,
               watchlist-watch, oil-prices, postgres-disk  all enabled, 0 failures/24h
watcher        watchlist_activity: 303 rows, 103 tokens (mostly UNTRACKED), cursor
               61,595,492.  67.6% of trades priced since it derives ETH/USD per slice.
               /watchlist tab: DOM-verified 303 rendered = 303 claimed, 0.38 MB
```

**CHUMP IS PART-LOADED AND A FRESH SESSION MUST READ ITS FINDINGS SECTION BEFORE
TOUCHING IT.** Steps 1–4 are complete and stored; steps 5–17 are not started. Its
config is `intake/chump.yaml`, its state is in `token_intake_state`, and what is known
about it — including two things that were measured the wrong way first — is in section
8 under CHUMP, with the v3-path lessons in the V3-ONLY subsection that follows it.

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
most of it:

| phase | CHUMP | CU | against estimate |
|---|---|---|---|
| identity | **0.8 s** | 816 | ~800 — exact |
| windows | **0.6 s** | 600 | ~1,040 for one bound — 42% under, because the start instant short-circuited |
| pools | **1.3 s** | 490 | ~500 — exact |
| scope | **0.6 s** | 478 | 2 `eth_call` × 10 distinct counters + head |
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

**The behaviour-detected routers were never persisted for PONS, so its cohort
never used them.** `effectiveExclusions` reads `token_intake_state` for
`router:%` rows; PONS has **zero** of them, so the 13,095-wallet cohort was
built against the **3 router addresses in `config/infrastructure.yaml`** and
nothing else. The "30 routers where the list holds 3" recorded above came from
an analysis that ran once and was never stored, so the pipeline never applied
it. Over PONS-P1, **62 senders clear the 50-recipient bar**. This is a live
discrepancy between what this section requires and what the stored cohort used;
PONS is frozen and it has not been acted on.

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
5  pre-pump share    5%    share, already 0..1
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

**Watch pre-pump share on every token.** On PONS it is zero for more than 75% of
the cohort with a maximum of exactly 1/3, meaning no wallet bought inside the 48
hours before more than one of the three pumps. **A maximum landing exactly on
1/n_pumps is the signature.** If it repeats, that 5% is being spent on a metric
that separates almost nobody.

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
2. **The cohort used the 3 configured router addresses.** Behaviour finds **62
   senders clearing the 50-recipient bar** over PONS-P1, and none was ever
   persisted, so `effectiveExclusions` returned the config list alone. A router
   the list misses gets the trade attributed to it instead of to the buyer.
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

**PART-LOADED 2026-09-13. Steps 1–4 complete and stored; 5–17 not started.** "Chump
Coin", 18 decimals, supply 1,000,000,000, deployed at block **23,791,950**
(2026-07-31T01:44:31Z), 5,225 bytes of code. Cohort `CHUMP-P1` not yet tagged.

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


## 9. Rules here the code does not implement

- **`--continue` cannot cross two adjacent STOP phases, so the runner deadlocks
  between `pools` and `scope`.** Found on CHUMP, the first token driven through the
  runner end to end rather than phase-by-phase with the standalone CLIs.

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

  **The fix is to persist the cleared stop as `complete` when it is cleared**, so a
  phase that has already produced its report and had its stop cleared never re-runs.
  Taking the first stopped phase rather than the last would also unblock progress,
  but it leaves stale `stopped` rows behind and the state table then no longer
  describes what happened.
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

- **The runner sweeps from block 0, not from the token's deployment block.** CHUMP's
  sweep covered 61,698,121 blocks where the token has existed for 37.9M, so 23.8M
  blocks that cannot contain it were read: ~238 requests, ~14,280 CU, $0.0064 per
  stream-set. Step 5's "sweep full chain life" means the TOKEN's life. The deployment
  block is already known — the identity phase stores it and passes it as `firstBlock`
  to the windows phase — so this is a one-line scope fix, not a new measurement.
- **`decodeSwap` threw a bare TypeError on a v4 log with no `topics[1]`.** FIXED
  2026-09-13. A v4 pool id lives in `topics[1]`, so a log reconstructed from stored
  columns has none, and the conventions phase died three frames down with
  `Cannot read properties of undefined (reading 'toLowerCase')` — on CHUMP, the first
  token whose conventions check ran against reconstructed v4 logs. It now takes an
  optional `knownPool`, which the conventions loop already had and never used, and
  raises with a message naming the cause when neither is available. **The fix keeps one
  decode implementation** rather than a second written to avoid the line.
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
- **NVDA's swaps are untimed.** 1,443,064 in-scope swap blocks carry no
  `block_times` row. It costs nothing today because NVDA is a pricing source with
  no rows, but the bridge series is derived from swaps whose blocks the code
  cannot date, and the rule that `loadSlice` enforces everywhere else does not
  reach it.

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
