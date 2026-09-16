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

**The SELL leg is NOT MEASURED and this is a real gap.** The probe sampled entry-moment
trades only. Selling the token back requires the token approved to whatever contract
executes the sell, which is an extra transaction and extra gas per token, and it is not
known whether that path takes the same target or the same shape. **This must be
measured before any design is built on it.**

### What is NOT established, and what closes it

1. **`w3` is unidentified.** Setting it wrong either reverts (safe) or does something
   unintended (not safe). **Closes free**: sample more callers of this selector and see
   whether it is constant per caller.
2. **The function cannot be NAMED.** There is no keccak256 in this environment — the
   dependencies are `exceljs, pg, rss-parser, yaml`, and Node's `crypto` offers
   `sha3-256`, which is a different padding and is NOT keccak256. So a candidate
   signature cannot be checked against an observed selector. `ROBINHOOD.md` records
   that a fabricated hash has shipped here once, so no selector is asserted from
   memory. **Closes for the cost of one audited dependency.**
3. **No ABI source exists.** `ROBINHOOD.md` records Blockscout returning HTTP 403
   behind Cloudflare on every API path: it is a link target for humans.
4. **The write-path RPC methods are UNPRICED.** `eth_sendRawTransaction`,
   `eth_getTransactionCount`, `eth_gasPrice` and `eth_estimateGas` do not appear in the
   provider cost table `ROBINHOOD.md` section 6 records. They are not guessed here.

**THE GATE: a byte-for-byte dry run.** Construct calldata for a trade that already
happened and compare it against that transaction's observed input. If it matches except
for amount, recipient and deadline, the shape is confirmed by the strongest test
available. **No broadcast before that passes.**

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
