# Token findings

One section per token. What was actually discovered while loading it — the
surprises, the traps, and the things that turned out not to be true.

`docs/ROBINHOOD-TOKEN-INTAKE.md` is the procedure. `docs/DEFINITIONS.md` is what
the words mean. This is what each individual token taught us.

**Every token appends to this file before it is called done.**

---

## PONS — `0x39dBED3a2bd333467115dE45665cC57F813C4571`, Robinhood Chain

First EVM intake. Cohort `PONS-P1`, 13,095 wallets, window 2026-07-21 to
2026-08-21 (blocks 15,115,285 – 42,691,407). 181,477 rows in
`wallet_transactions`.

### The two venues use opposite sign conventions

```
          in-window    before window   after window
v3        394/394      299/299         290/290       POOL perspective
v4        164/164      294/294         154/154       SWAPPER perspective
```

Unanimous in all three regions. Assuming one convention for both would have
inverted every v4 buy into a sell across 480,924 rows, with plausible totals
throughout. **Direction is taken from the transfer instead**, which does not
depend on getting a convention right.

### USDG has 6 decimals

Every other counter asset on the token had 18. USDG was the counter on 238 of
381 in-scope pools, so assuming 18 would have inflated most of the token's
dollar figures by 10^12. One further counter, PONTIFUL, also had 6.

### DexScreener knew 14 of 792 v4 pools

It caps its response at 30 pairs and is not sorted by liquidity. It listed 30 of
91 v3-style pools, and 28 of the 40 in-scope v3 pools were absent from it —
including one carrying 53,688 transfers, the 7th busiest pool on the chain. The
3rd, 4th and 5th busiest v4 pools were absent. **Enumerate on-chain; use the API
only to annotate.**

### The window held 31% of the token's swaps

772,131 of 2,459,873. The other 1.46M happened after the window closed, and they
are exactly the sell-side data that cost basis and realised PnL depend on. The
sweep runs full chain life, not the window.

### Price buckets are anchored at the first swap block, not at zero

All 4,528 stored buckets satisfy `block % 10000 == 3150`, because the intake
anchored them at 8,963,150. A bucket function anchored at zero looks up 54930000
where the stored bucket is 54933150 — matching nothing, pricing every row null,
and writing a second series interleaved with the first.

### The router investigation, and how it came out

An aggregate suggested the cohort was missing **34,744 router-fronted buyers**.
Decoding transactions disproved it twice over:

1. Pool addresses were filtered out of the sender side of the query but not the
   recipient side. In a routed *sell* the router sends PONS *to* the pool, so
   22,904 of one router's 150,027 sends had the PoolManager as recipient and
   were counted as wallets. See FAILURE_MODES 25.
2. "In a transaction containing a swap" was standing in for "bought". After
   correcting the recipient side, **2 of 40** sampled recipients had given up
   any value; 38 had not. See FAILURE_MODES 26.

Genuine router-fronted buys do exist — `0x2dbe2e74f24aa04b16766d3b2911746f4c1c2d492f9899b96928122b0281f3b2`
is one, paying 661.015389 USDG for 24,818.149587 PONS — but at roughly 1 in 40,
not the dominant case. Defensible estimate: **~1,477 of 29,542, 95% interval
roughly 175–5,000.** Not acted on.

Routers are also under-enumerated. `config/infrastructure.yaml` lists 3, and
behaviour identifies at least 5, discriminated by the share of an address's
sends that sit inside a swap transaction (routers 72.5–98.3%, distributors 0.0%).

### The custodial EIP-7702 flow

The dominant pattern behind those router receipts is custodial: **a single
funding EOA, `0xf70da97812cb96acdf810712aa562db8dfa3dbef`, pays the USDG**, a
router routes, and the token is delivered to a **user's EIP-7702 delegated
account**. 96% of 150 sampled router recipients were 23-byte delegated accounts;
3.3% plain EOAs; 0.7% larger contracts. **0 of the 150 were in the cohort.**

Those accounts are excluded twice over today: once because their counterparty is
the router rather than the pool, and again because the contract check treats
23 bytes of code as a contract.

### The contract check is wrong, and it costs 2,001 wallets

An EIP-7702 account has exactly 23 bytes: `0xef0100` + a 20-byte delegate. Of
3,275 candidates excluded at the window-end block:

```
  811  EOA                          (excluded for some other reason)
2,001  EIP-7702 delegated account   wrongly excluded -- these are wallets
  463  deployed contract            correctly excluded
```

Cohort would be **15,096 rather than 13,095, +15.3%**. The 396 `PONS-P1-T` hop
wallets are unaffected — all 396 are plain EOAs at that block. The wider hop
table is affected: sampled 250 per level, hop 1 is 14.8% delegated, hop 2 18.8%,
hop 3 8.8%; hop 0 (the cohort itself) is 100% EOA, as it must be.

### No bonding curve

First pool `Initialize` is in the **same block** as the token deployment
(8,963,150), so there is no pre-pool period in which a curve could have run.

### Scoring

Min-max across the cohort, deliberately, so outliers dominate. The consequence
is that **70% of the nominal weight sits on money metrics that contribute 0.8%
of the median wallet's score** — the ranking of the typical wallet is driven by
earliness, hold time and buy-size trend. Pre-pump share is zero for over 75% of
the cohort with a maximum of exactly 1/3, meaning no wallet bought inside the
48 hours before more than one of the three pumps.

---

## AI — `0x2E8c31162b855A2ffa90F6F8634643Ad6F111e18`, Robinhood Chain

**Not yet loaded.** Findings below are from the pricing-route reconnaissance
only; no sweep has run and no rows exist.

Deployed at block 9,721,433. Decimals 18, symbol `AI`. Charted pool
`0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27`, AI/NVDA,
v4.

### 4,856 pools against 4,481 distinct counter assets

```
v4 Initialize, AI as currency0    4,638 logs
v4 Initialize, AI as currency1      202 logs
v3 PoolCreated, AI as token0         10 logs
v3 PoolCreated, AI as token1          6 logs
```

AI is overwhelmingly the *pricing* asset for other tokens rather than the priced
one — the same pattern PONS showed with its derivatives, an order of magnitude
larger. Reading `symbol()` and `decimals()` for all 4,481 counters is 232,000 CU
on its own and is not worth doing; scope the contract reads to the pricing
assets plus the busiest counters.

### The scope rule would discard the token's main market

```
                            life swaps    window swaps
in-scope (USDG/WETH/ETH)       102,938          49,779
AI/NVDA (the charted pool)     160,284          71,834
other counters                  15,995               5
```

NVDA is 56% of AI's swaps and **59% of the window's**. Under the current rule
those pools are excluded entirely — they produce no rows at all, not null-USD
rows — so the cohort would come from 41% of window activity.

**NVDA is itself priceable on-chain**: 512 NVDA pools against pricing assets
(238 USDG, 164 WETH, 110 native ETH) carrying 226,454 swaps, 85,376 of them
inside the AI window. An AI → NVDA → USD second hop needs no off-chain equity
feed. The runner does not implement one.

### 92% of AI's pools carry a launchpad hook

4,465 of 4,843 v4 pools have a non-zero hooks address, across 34 distinct hook
contracts; one — `0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544`, 25,533 bytes —
covers 4,424 of them. Two pools name `0x…dead0030`, which is not a contract.

**The PoolManager still emits its own `Swap` for hooked pools** — verified on
three of them (9,175, 5 and 132 events), not assumed from source — and **no hook
emits the `Swap` topic itself**. Sweeping `Swap` from the PoolManager is
therefore complete for hooked pools.

### No bonding curve

First pool `Initialize` is in the same block as deployment (9,721,433) and the
first swap on an AI pool follows 547 blocks later, about 55 seconds. The
launchpad graduates into a pool immediately rather than running a curve.

### v4_swaps_all already covers 59% of AI's life

```
coverage      15,115,267 .. 42,695,454   27,580,187 blocks
AI life        9,721,433 .. 56,291,305   46,569,872 blocks
AI-P1 window  18,275,473 .. 32,206,224   ENTIRELY inside coverage
AI swaps held 279,217
```

5,393,834 blocks before coverage and 13,595,851 after would need sweeping. The
reuse saves the v4 swap sweep over the covered range only — `v4_swaps_all` holds
no transfers, and attribution and direction both come from transfers.

### Two of the queued tokens trade against AI

BONER and CASHCAT both appear as AI counter assets. Not acted on.
