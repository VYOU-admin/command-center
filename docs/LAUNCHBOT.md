# Launch Bot — Robinhood Chain

The one document for **writing** to Robinhood Chain. Reading it is
`docs/ROBINHOOD.md`; that document is not restated here and is not re-derived here.

---

## Why this is a second document, and not part of ROBINHOOD.md

`ROBINHOOD.md` rule 4 says **nothing gets its own new document**, and that rule was
earned: intake definitions drifted across four files until they contradicted each
other, and twice a definition was found wrong only after work had been built on it.
Splitting is normally the mistake. Three things make this the exception, and they are
recorded here so the exception is auditable rather than convenient:

1. **A different failure mode.** `ROBINHOOD.md` governs READING the chain, where a
   defect costs compute units and a wrong number. This governs WRITING to it, where a
   defect costs money that does not come back.
2. **A different reader.** `ROBINHOOD.md` is 8,000+ lines and is read in full every
   session. Folding trading procedure into it makes every intake session pay to read
   trading, and every trading session pay to read intake.
3. **A different lifecycle.** Intake procedure changes when a token is loaded. This
   changes when a trade is placed, which is far more often.

**Where the bot depends on something `ROBINHOOD.md` establishes — chain facts, the
Alchemy-versus-public-RPC rules, sign conventions, topic hashes, container and deploy
hazards — it is REFERENCED, never restated.** Those are not re-derived here, and a
disagreement between the two documents is resolved by re-measuring, not by preferring
one.

---

## The four rules that keep this document true

1. **This document is read in full before any trading work begins.** Not skimmed, not
   searched — read. Then say what in it applies to the change in front of you.
2. **Any bug, workaround or measurement updates this document first and the code
   second.** The document is the specification; the code is an implementation of it.
3. **A rule here that the code does not implement is a defect in the code.** Always,
   and in that direction. The code is never the authority.
4. **Nothing trading-related gets a third document.** If it matters, it goes here.

**Every number in this document is a measurement with its provenance, or it is marked
as a GUESS. No figure gets in without one or the other.**

---

## 0. What is loaded right now

*Updated on every change of state. This is the first thing a session needs.*

```
STATUS              NOT BUILT. Scoping complete, execution path partially
                    established, awaiting operator approval of the design.
wallet address      NOT CONFIGURED -- no wallet variable exists on the Railway
                    service (checked 2026-09-16: DATABASE_URL, ALCHEMY_API_KEY and
                    Discord webhooks only)
wallet balance      UNVERIFIED -- the operator states ~$24 of ETH on chain 4663;
                    this has not been read from the chain by any code here
mode                n/a -- no bot exists
limits              n/a -- see section 4 for the proposed values
trades to date      0
capital approved    $100 total, $10 per position (operator, 2026-09-16)
```

**Nothing in this repository has ever written to a chain.** Verified 2026-09-16:
no `eth_sendRawTransaction`, no transaction signing, no private-key handling anywhere
under `src/`.

---

## 1. The measured basis

Four windows, all measured with one binary and one set of definitions. **The corpus era
is the anomaly; the recent level is the expectation.**

| window | blocks | what it is | launches |
|---|---|---|---|
| **HOLDOUT-ERA** | 15,115,267–42,695,454 | the `v4_swaps_all` corpus, 31.9 days | 150,791 |
| **MIDPOINT** | 52,200,000–53,200,000 | midpoint of the untested gap, ETH −0.14% drift | 8,029 |
| **CALM** | 60,700,000–61,700,000 | flattest ETH stretch, +0.14% drift | 6,717 |
| **SELLOFF** | 63,216,393–64,216,393 | ETH −4.06% drift | 5,016 |

Each 1M-block window is ~28 hours at the measured 0.1 s block time; the corpus window
is ~32 days. **All three recent windows are single days and the corpus column is a
monthly average — they are not like-for-like in duration.**

**The rule** — `fee ∈ {500, 10000}` and creation-to-first-swap gap 11–600 blocks,
enter at the first trade after +15 s, exit at the first trade after +45 s:

| | HOLDOUT | MIDPOINT | CALM | SELLOFF |
|---|---|---|---|---|
| share of launches | 14.66% | 3.14% | 3.33% | 10.83% |
| survival to 5 min | 56.6% | 62.7% | 44.6% | 51.6% |
| median return (mark-to-mark) | **+0.298** | +0.145 | +0.226 | +0.134 |
| median NET at $10, all rule pools, no-fill = 0 | **+0.243** | not computed | **+0.163** | **+0.075** |
| median NET at $100 | +0.194 | not computed | +0.150 | +0.059 |
| no-fill rate | 16.75% | not computed | 20.54% | 21.77% |
| rule trades per day | 697.6 | not computed | 200.8 | 485.8 |

**Costs, all measured, none assumed.** Median round-trip slippage from realised impact
(see `ROBINHOOD.md` for the method): 0.52% / 0.20% / 0.26% at $10 across HOLDOUT / CALM
/ SELLOFF, rising to 5.19% / 2.01% / 2.58% at $100. Gas from 200 real receipts per era:
$0.0219 / $0.0809 / $0.0557 per round trip. **Corpus-era pools were 2–2.6x thinner per
dollar than recent ones** — thin pools are not the recent problem.

**The p25 is 0.00000 in every window at $100.** Roughly a fifth of qualifying launches
never fill at all.

**THE DECAY IS STRUCTURAL AND IT BROKE EARLY.** The midpoint window — ten days after
the corpus ends — already shows the rule at +0.145. All three post-corpus windows sit
near half the holdout. The first ten days after the corpus ceiling are untested, so the
break is located within them but not dated.

**THE FEE TIER IS THE LAUNCHPAD.** Within the rule the two are near-perfectly
collinear: `fee=10000` is essentially always launchpad `0x58daec3116aa…`, and
`fee=500` essentially always `0x8366a39cc670…`, which is the PoolManager itself
(direct creation). The decay is one launchpad's output getting worse — `0x58daec3116aa…`
went +0.296 on 1,100 holdout pools to +0.056 on 156 selloff pools while its share of
rule pools fell 73.3% → 28.8%.

**Creator identity (`tx.from` of the Initialize transaction) is useless**, measured:
219 distinct creators for 224 CALM pools, and across all four windows exactly ONE
creator has 15 or more rule pools. There is no deployer fleet to track.

---

## 2. The execution path

**PARTIALLY ESTABLISHED. It is not yet safe to broadcast.** What follows was derived by
reading 446 real entry-moment trades on rule-qualifying pools (route-probe,
2026-09-16, 6,690 CU) — never assumed.

### The routing target is FRAGMENTED, and that is the first finding

17 distinct `to` addresses across 446 trades; the most-used carries **24.2%**. **None
of them is a pool-creation target** — trading and creation go through different
contracts. There is no single "the router" on this chain to integrate with. A bot does
not need to match what others do; it needs ONE path that works.

| routing target | trades | share | selector | native value |
|---|---|---|---|---|
| `0x1cbaf24d53fe930fce8eff149fa797d2611da149` | 108 | 24.2% | `0xc1120e3d` | **108 of 108** |
| `0x5a1d33c4b150cdd80e06ecbd737b3d0ee777fa66` | 83 | 18.6% | `0x7169b574` | 0 |
| `0x8876789976decbfcbbbe364623c63652db8c0904` | 66 | 14.8% | `0x24856bc3`, `0x3593564c` | 17 |
| `0xf5576dee97a4a28e1f67a6e92b7148abaea625c8` | 59 | 13.2% | `0x7169b574` | 0 |

`0x7169b574` appears on five different targets at a constant 1,546-character calldata,
which is consistent with several deployments of one contract. Not investigated further.

### The dominant native-ETH path, decoded from observation

Target `0x1cbaf24d53fe930fce8eff149fa797d2611da149`, selector `0xc1120e3d`, calldata a
constant 324 bytes = 10 words. Words identified by matching against values already
known for the same pool from `v4_pool_init`:

| word | value | how it was established |
|---|---|---|
| w0 | `0x8876789976decbfcbbbe364623c63652db8c0904` | CONSTANT across samples; a persisted router in `ROBINHOOD.md` |
| w1 | `0x8366a39cc670b4001a1121b8f6a443a643e40951` | CONSTANT; the v4 PoolManager |
| w2 | the token | matches `currency1` for that pool |
| w3 | **UNIDENTIFIED** | varies by caller but **recurs identically across different pools**, so it is caller configuration, not a per-trade amount |
| w4 | `amountOutMinimum` | **12 of 12** below the realised output at 0.879–0.949 of it |
| w5 | recipient | equals `tx.from` |
| w6 | deadline | a plausible unix second |
| w7 | `0x2710` = 10000 | CONSTANT; the pool's fee tier |
| w8 | `0xc8` = 200 | CONSTANT; the pool's tickSpacing |
| w9 | zero | CONSTANT; the pool's hooks address |

w0/w1/w2/w7/w8/w9 are a v4 **PoolKey**; w4/w5/w6 are the ordinary bound-recipient-deadline
triple. **Nine of ten words are identified with evidence. One is not.**

### What the wallet must hold and approve

**The BUY leg needs neither a wrap nor an approval.** `tx.value == |amount0|` in **12 of
12** sampled trades — the ETH is attached to the transaction as native value. The
wallet holds native ETH and spends it directly.

**The SELL leg is measured — see below.** It requires an approval, it routes through a
different set of contracts than the buy, and the most-used buy route cannot sell at all.

### THE SELL LEG, measured 2026-09-16 (route-probe --side sell, 315 trades, 4,725 CU)

**The sell path is NOT the same set as the buy path, and the difference decides the
design.**

| routing target | sells | share | buys | verdict |
|---|---|---|---|---|
| `0x8876789976de…` **Universal Router** | 132 | **41.9%** | 66 | **both legs** |
| `0x5a1d33c4b150…` | 73 | 23.2% | 83 | both legs |
| `0x1cbaf24d53fe…` | **0** | — | 108 | **BUY ONLY** |
| `0xf5576dee97a4…` | 34 | 10.8% | 59 | both legs |

**The most-used BUY route cannot sell at all.** A bot built on `0x1cbaf24d…` would have
to exit through a different contract, doubling the integration surface. **The Universal
Router does both** and is the only path here with a verifiable interface.

314 of 315 sells attach no native value, as expected: the token goes in, not ETH.

### AN APPROVAL IS REQUIRED, AND IT IS EFFECTIVELY PER TRADE

Measured over 40 sampled sells (approval-probe, 3,600 CU), sweeping `Approval` logs from
each token filtered to that seller:

```
sells with a prior approval by that seller   40 of 40
sells without one in a 200,000-block lookback  0
spenders approved   0x5a1d33c4b150…  22      <- a router taking a direct allowance
                    0x000000000022d473030f116ddee9f6b43ac78ba3  17   <- Permit2
                    0x9713b78021cf…  17
                    0xf5576dee97a4…   8
```

**It is one approval PER TOKEN, and since every trade is a different newly-launched
token, that is one approval per trade.** This is not an inference from the sample: the
token did not exist before its own launch, so no allowance for it can predate the trade.

**Gas, from real receipts (median):**

| leg | cost |
|---|---|
| approval | **$0.00751** |
| sell | **$0.04339** |
| buy | $0.0279 (SELLOFF) – $0.0405 (CALM), measured earlier |
| **round trip incl. approval** | **≈ $0.079 – $0.092** |

**THIS CORRECTS AN EARLIER FIGURE.** Section 1's round-trip gas of $0.0219 / $0.0809 /
$0.0557 was `2 × a single-leg median` sampled from ENTRY transactions — all buys. The
sell leg actually costs more ($0.0434 against a buy-side sample), and the approval was
not counted at all. **The true round trip is 15–40% higher than reported there.** On a
$10 position that is **0.79%–0.92%** rather than 0.56%–0.81% — a correction of ~0.1–0.2
percentage points against a median near +15%, so it does not change the decision, but
the earlier number was wrong and is superseded here.

### THE FUNCTION SELECTORS, VERIFIED

`ethers` was added for keccak256 — chosen over `js-sha3` because the same package
supplies ABI encoding for the reconstruction below and transaction signing for the bot,
and hand-rolling secp256k1, RLP and EIP-1559 is exactly what loses money.

**It immediately cross-checked this project's own records.** All three topic hashes
`ROBINHOOD.md` carries as read off the chain reproduce exactly from keccak of their
signatures — `Transfer`, `Initialize` and `Swap`. The document and the hash function now
confirm each other.

| selector | signature | verified |
|---|---|---|
| `0x3593564c` | `execute(bytes,bytes[],uint256)` | **YES** |
| `0x24856bc3` | `execute(bytes,bytes[])` | **YES** |
| `0xc1120e3d` | — | **NO candidate matched** |
| `0x7169b574` | — | **NO candidate matched** |
| `0x4d819a2a` | — | **NO candidate matched** |

So `0x8876789976de…` is a **Uniswap Universal Router**, a published interface. The three
unmatched selectors are custom contracts with no obtainable ABI — `ROBINHOOD.md` records
Blockscout returning HTTP 403 on every API path.

### THE BYTE-FOR-BYTE TEST

Decode each observed input with the verified signature, re-encode the decoded values, and
compare against the original bytes.

```
execute(bytes,bytes[],uint256)   3 samples (1 buy, 2 sells)   MATCH, MATCH, MATCH
execute(bytes,bytes[])           3 samples (3 sells)          MATCH, MATCH, MATCH
   every one: commands = 0x10  (one command)   inputs = 1 element
```

**This is a real test because the arguments are DYNAMIC.** `bytes` and `bytes[]` carry
offsets, lengths and padding that must all be reproduced exactly, so a byte-for-byte
round trip constrains the layout.

**The same test on `0xc1120e3d` also matches, and that match means much less.** Its ten
arguments are all STATIC, and any 320-byte body decodes as ten static words and
re-encodes identically — the round trip is close to tautological there. It confirms the
layout is ten static words; it confirms nothing about the function.

**WHAT REMAINS UNRESOLVED ON THE UNIVERSAL ROUTER PATH:** the `commands` byte is `0x10`
in every sample and the single `inputs` element is an opaque blob whose internal layout
is not verified here. Encoding a NEW trade requires constructing that blob. **That is the
remaining gap and it is the next thing to close, before any code.**

### `w3` — carried as a known unknown, with its values enumerated

Across 108 transactions on `0xc1120e3d`, `w3` takes **exactly two values**, shared by 80
distinct senders:

```
0x…6f97f428021e6e3ed0  = 2,058,538,012,765,370,334,928   n=55, 34 distinct senders
0x…905a6e5d8b0cdad0b4  = 2,662,847,395,176,824,623,284   n=53, 46 distinct senders
```

**It is a shared constant, not caller configuration and not a per-trade amount** — the
earlier reading of "caller config" is superseded. Its meaning is unidentified. **It no
longer blocks anything**, because the design routes through the Universal Router where
this word does not exist.

### BOOT RECONCILIATION — required before any code

`ROBINHOOD.md` records containers being replaced mid-job twice, once destroying a
session's files and once killing a running sweep. **A container replaced between the buy
and the sell leaves a position open with no process tracking it, and the token is not
something anyone will come back for.**

The rule: **a position is only real if Postgres says so, and the chain is the
adjudicator.**

1. **Write intent BEFORE broadcasting.** A row is inserted with status `intent` carrying
   the pool, the calldata, the value and the nonce, and committed, before
   `eth_sendRawTransaction` is called. A crash between the insert and the broadcast
   leaves a row that the chain can be asked about; a crash the other way round leaves a
   position nobody knows exists.
2. **On boot, load every row not in a terminal state and reconcile each against the
   chain** — by transaction hash where one was recorded, and by the wallet's token
   balance where one was not. The balance is the authority: a non-zero balance of that
   token means the buy landed whatever the row says.
3. **Any position whose buy landed and whose sell did not is EXITED IMMEDIATELY** at
   boot, before the bot arms itself for new launches. It is past its 45-second window by
   definition, so it is not a trade any more — it is an open exposure.
4. **Reconciliation failure halts the bot.** A position that cannot be resolved against
   the chain stops new trading rather than being abandoned, because the one thing worse
   than a stuck position is a stuck position plus new ones.
5. **The nonce is read from the chain on boot, never carried in memory**, so a replaced
   container cannot reuse one.

### RPC cost of running the bot

**The read side is priced. The write side is not.**

| | cadence | calls/day | CU/day | $/day |
|---|---|---|---|---|
| watch `Initialize` | every 2 s | 43,200 | 2,592,000 | **$1.17** |
| watch `Initialize` | every 5 s | 17,280 | 1,036,800 | **$0.47** |
| confirm receipts, 2 legs | per trade | 2 × trades | 30 × trades | $0.0135 per 1,000 legs |

A 5 s cadence is sufficient: the median launch is first traded 0.8 s after creation and
entry is at +15 s after that first trade, so a 5 s detection lag still leaves ~10 s.
**Submission and nonce/gas calls are unpriced and are not estimated.**

---

## 3. The entry and exit rule as implemented

*Not yet implemented. This is the specification the code must match.*

**THE LAUNCHPAD FILTER IS PRIMARY AND THE FEE TIER IS SECONDARY.** They are collinear
today and may not stay so; a fee-only filter would break silently on a defaults change,
which is exactly the decay already observed. The bot filters on the launchpad address —
the `to` of the Initialize transaction — and records the fee tier alongside without
depending on it.

---

## 4. Safety rails

*Proposed. Values and their reasons are in the design; every one is hard-coded, not
configuration, so a YAML edit cannot loosen a limit.*

---

## 5. What every trade logs

*Proposed. See the design.*

---

## 6. Findings, as they arrive

*Empty. Nothing has traded.*

---

## 7. Rules here the code does not implement

- **Everything.** No code exists yet. This section starts accumulating the moment it
  does.
