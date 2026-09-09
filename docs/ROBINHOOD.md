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

**A wallet that bought in two windows belongs to both cohorts.** It gets rows
under both tags and two tag rows. That is correct, not a duplicate.

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

**Test the free alternatives before committing to a metered one, and report what
each can and cannot do.** The measurement takes minutes; the assumption costs
whatever the job costs. A block-timestamp fetch was once queued as ~13,000 paid
calls without either alternative having been tried — the public RPC served the
same batched request perfectly, 100 blocks per request in 448 ms, for free, and
the explorer was unusable at any price. Neither fact was known when the paid job
was planned, and only one of them would have been guessed correctly.

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

Every step has a **compute-unit ceiling set before it starts**, inside the job.
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

**Filter v4 by pool id.** An unfiltered PoolManager sweep returns every v4 swap
on the chain — 33.2M rows and 14 GB for one month. A 540-entry topic array is
accepted.

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
> **Identify them by behaviour, not from a list.** For PONS, behaviour finds
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

On Alchemy this step is usually free: `blockTimestamp` arrives with the logs
during the sweep. It exists for the blocks that arrive without one.

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
block, or its DEPLOYMENT block where the first swap cannot be read.** The
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

**Never rewrite a bucket that is already stored.** A stored bucket was computed
by a run that saw the whole bucket; recomputing gains nothing and silently
replaces reviewed history. Three were rewritten before this was caught.

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

**The hourly job and the intake share ONE buy rule, and a change to one is a
change to both.** The hourly job is not a simplified version of the intake — it
runs the same `tradeLegs`, so whatever decides who bought during a load also
decides it every hour afterwards. This is why a rejected rule kept running: the
payment check was measured wrong against 40 decoded transactions, and the
scheduled job went on applying it to every hour it advanced, writing an
incomplete set of buys with nothing raised. Whenever the definition of a buy
moves, both callers move with it, and the hourly job is re-run from a cursor
early enough to cover what the old rule dropped.

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

**Append this token's section to the findings at the end of this document before
calling it done.** What surprised you, what the numbers were, what turned out not
to be true. That is what the next token reads.

---

## 5. What a null means, per field

**A null is never a zero.** Zero is a measurement; null is the absence of one.

| field | null means |
|---|---|
| `wallet_transactions.usd_amount` | the swap's price bucket had no derivable rate |
| `wallet_transactions.price_usd` | the same |
| `wallet_transactions.counterparty` | not recorded — every PONS trade row, all 182,616 of them as of 2026-09-07 |
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
| public RPC pacing | 4,000 ms clean, 800 ms gave 15/20 refusals | **measured** |
| price bucket | 10,000 blocks (~17 min) | derived from the measured block time |
| bucket anchor | the token's first swap block | **measured** per token |
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
15,115,285–42,691,407). **179,736 rows at intake; 182,616 as of 2026-09-07**, the
difference written by the hourly job. (An earlier figure of 181,477 appeared here
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

### AI — `0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18`

**Loaded 2026-09-09.** Cohort `AI-P1`, **3,508 wallets**, window 2026-07-24
12:00 → 2026-08-09 16:00 Eastern (blocks 18,275,461–32,206,441), **31,896 rows**,
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

## 9. Rules here the code does not implement

- **`token_swap_logs` is created by no code in this repository.** Every reader
  assumes it exists because the first intake made it by hand. A fresh database
  fails at the first read. Its shape is recorded in step 5.
- **One bridge cannot serve two tokens with different bucket anchors.**
  `deriveBridgeUsd` runs on the grid of the token being priced, and
  `bridge_usd_prices` is keyed `(chain, bridge, bucket_block)` with no room for a
  second grid — so a second token pricing through NVDA on its own anchor would
  interleave two series in one table. The same applies to `native_usd_prices`,
  keyed `(chain, block_number)` with no token column, which already holds PONS's
  buckets at residue 3150 and AI's at 1433. Both are correct today because each
  reader finds its own; neither is correct once a third token arrives. Give the
  shared series a chain-level anchor before that happens.

One further limitation is a property of the chain rather than a gap in the code:

- **A bucket median is still a median over ~17 minutes.** The window-median bias
  measured elsewhere (95.56 whole-window against 127.17 and 97.41 for the
  halves) has never been measured on this chain. Measure it on a token that
  moved.

When something is found that this document requires and the code does not do,
it goes here, and it is a defect in the code.
