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
STATUS              BUILT, DRY RUN ONLY. It cannot broadcast: no private key is
                    read anywhere, and src/bot/rpc.ts refuses
                    eth_sendRawTransaction and every signing method BY NAME.
mode                dry-run (the only mode that exists)
first dry run       2026-09-16, 65 minutes, 24 hypothetical trades recorded
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
| `0x8876789976de…` **Universal Router** | 181 | **46.1%** | 17 | **both legs** |
| `0x5a1d33c4b150…` | 73 | 23.2% | 83 | both legs |
| `0x1cbaf24d53fe…` | **0** | — | 108 | **BUY ONLY** |
| `0xf5576dee97a4…` | 34 | 10.8% | 59 | both legs |

**The most-used BUY route cannot sell at all.** A bot built on `0x1cbaf24d…` would have
to exit through a different contract, doubling the integration surface. **The Universal
Router does both** and is the only path here with a verifiable interface.

**CORRECTION, 2026-09-16.** The buy/sell split above was first reported as 66 buys and
132 sells for the Universal Router. That was wrong: the original 446-row probe predated
the `--side` flag and took the first entry-moment swap in EITHER direction, and the
repair then labelled all 446 as buys. Recomputing direction from the sign of the token
side reclassified **78 of them as sells**. The corrected counts are **368 buys and 393
sells overall**, and the Universal Router is **17 buys against 181 sells** — heavily a
SELL venue here, not the balanced picture first reported. Seventeen observed buys is
still enough to decode and simulate the buy path, which is done below.

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

### THE `inputs` BLOB — decoded, constructed and simulated, 2026-09-16

**The blob is no longer opaque.** `inputs[0]` is itself `abi.encode(bytes actions,
bytes[] params)` — round-trip MATCH on every sample. Three action sequences appear,
each one byte per action:

| direction | actions | params sizes | n |
|---|---|---|---|
| sell | `0x060c0f` | 352 / 64 / 64 | 175 |
| buy | `0x060c0e` | 384 / 64 / 96 | 9 |
| buy | `0x060c0f` | 384 / 64 / 64 | 5 |
| sell | `0x060c0f` | 384 / 64 / 64 | 3 |
| sell | `0x060c0e` | 384 / 64 / 96 | 3 |
| buy | `0x060b0e` | 352 / 96 / 96 | 1 |

**THE LAYOUT DOES DIFFER BY CASE AND IS STATED PER CASE**, not described once and
assumed. `params[0]` comes in two widths and the difference is a single extra word:

```
352 bytes: ((currency0,currency1,fee,tickSpacing,hooks), zeroForOne, amountIn,
            amountOutMinimum, hookData)
384 bytes: ((currency0,currency1,fee,tickSpacing,hooks), zeroForOne, amountIn,
            amountOutMinimum, <extra word>, hookData)
params[1]  (inputCurrency, amountIn)                  -- 64 bytes
params[2]  (outputCurrency, minOut)                   -- 64-byte form
           (outputCurrency, recipient, minOut)        -- 96-byte form
```

**Every field verified against a value known independently of the blob:**

| field | evidence |
|---|---|
| the five PoolKey fields | equal `v4_pool_init` for that pool — **175/175, 9/9, 5/5, 3/3, 3/3** |
| `amountIn` | equals the realised `|amount|` in that transaction's Swap log — **100%** |
| `zeroForOne` | equals the trade direction — **100%** |
| `hookData` | empty — **100%** |
| the extra 384-word | **always zero**, every sample |
| `params[1]` currency | equals the INPUT currency — verified per shape |
| `params[2]` currency | equals the OUTPUT currency; the 96-byte form's second field equals `tx.from` |

**`amountOutMinimum` is 0 in 9 of 9 native-ETH buys** but set in 172 of 175 sells — the
buyers observed here take no slippage protection at all and the sellers do. **The bot
sets its own on both legs; this is recorded as what others do, not as a default to copy.**

### THE CONSTRUCT TEST — 190 of 198 byte-for-byte

Built the whole blob from POOL DATA AND POLICY ALONE — currencies, fee, tickSpacing and
hooks from `v4_pool_init`, direction from the trade, size from the amount, recipient from
the sender — and compared against what was actually sent.

```
MATCH 190   NO MATCH 8   of 198 Universal Router transactions
```

**All 8 failures are one thing**: those callers put `uint256` max in `params[1]` as a
settle-everything sentinel instead of the exact amount. **That is a caller's policy
choice, not a field that could not be constructed.**

**Fields that had to be read from the observed transaction, and what each one is:**

| field | why it was read | can the bot construct it? |
|---|---|---|
| `amountOutMinimum` | the trader's slippage bound | **YES — the bot sets its own** |
| `minOut` in `params[2]` | same | **YES** |
| the action-sequence byte | which take-form the caller used | **YES — the bot picks one** |

**Nothing essential had to be read.** Every remaining field is pool data, a derived
direction, a size the bot chooses, its own address, or a bound it sets.

### SIMULATED AT THE HISTORICAL BLOCK — 6 of 6 returned, 0 reverts

`eth_call` of the CONSTRUCTED calldata against the Universal Router at `block - 1`, with
the original sender and value (26 CU each, 6 calls, $0.00007):

```
returned 6   reverted 0   other error 0
```

**Two of the six were cases where the constructed calldata deliberately DIFFERS from the
observed** — the sentinel cases above — and they returned too, so the exact-amount
construction is independently valid rather than merely reproducing what was sent.
**`eth_call` at a historical block works on this endpoint**, which is `ROBINHOOD.md`'s
"every step that needs historical state needs Alchemy" holding for state as well as code.

### THE APPROVAL LEG — two patterns, both measured

40 sells, one `eth_getLogs` each (2,400 CU, $0.00108). Topic and selector both COMPUTED:
`Approval(address,address,uint256)` = `0x8c5be1e5…`, `approve(address,uint256)` =
`0x095ea7b3`.

```
sells with a prior approval  40 of 40        without  0
  46 approvals  to a ROUTER directly, for a FINITE amount
  19 approvals  to Permit2 (0x000000000022d473030f116ddee9f6b43ac78ba3), uint256 MAX
```

**Unlimited is NOT the norm overall — it is the norm for Permit2 and not for direct
routers.** Sellers going straight to a router approve a finite amount; the Permit2 users
approve unlimited once, which is what Permit2 exists for.

**ONE THING IS STILL OPEN AND IT IS NARROW.** The decoded Universal Router calls carry
`commands = 0x10` only — a single action, with no permit command in the batch. So the
token must already be spendable by whatever pulls it, and for the Permit2 route that
normally needs a SECOND grant (token → Permit2, then Permit2 → router) which would emit
its event on the Permit2 contract, not on the token, and was therefore outside this
sweep. **Whether the Universal Router path costs one setup transaction or two is not
established.** At $0.0075 per approval the difference is ~0.075% of a $10 position
either way, so it changes no decision — but it is a real unknown and it is not guessed.
It closes by sweeping Permit2's own events for these sellers, or by using a router that
takes a direct allowance.

### WHAT IS CONSTRUCTIBLE END TO END, IN ONE LINE

**Both swap legs are fully constructible and simulate clean; the ERC-20 approval is a
standard verified call; the only unestablished item is whether the Permit2 route needs a
second setup transaction.**

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

Hard-coded in `src/bot/config.ts`. Not configuration: `ROBINHOOD.md` records that monitor
options are persisted into `monitors.config`, so a YAML value is a database value and a
database value is editable by anything with a connection.

| rail | value | why |
|---|---|---|
| max position | $10 | operator, 2026-09-16 |
| max concurrent | 5 | $50 of $100 at risk, leaving headroom for a stuck exit |
| max trades/day | 40 | ~8% of the 485/day available in the SELLOFF window |
| max daily loss | $15 | 15% of capital |
| consecutive simulation reverts | 3 | a broken calldata shape must stop at once |
| kill switch | a Postgres row, re-read on a fresh connection every tick | a memory flag dies with the container and cannot be set from outside |

**A kill-switch READ FAILURE halts.** An unreachable database is not permission to keep
trading.

**ONE IMPLEMENTATION OF EVERY RULE**, called by the dry-run path and by any future live
path. A dry run over different code proves nothing about the live path.

| rule | the one place it lives |
|---|---|
| calldata construction | `src/bot/calldata.ts` — `buildSwap`, `buildTokenApprove`, `buildPermit2Approve` |
| entry rule | `src/bot/rule.ts` — `qualifies()` |
| position sizing | `src/bot/rule.ts` — `positionWei()` |
| slippage bound | `src/bot/rule.ts` — `minOut()`, constant in `config.ts` |

**The slippage bound is 300 bps and it is OURS.** The 9 of 9 native-ETH buys observed on
this chain set `amountOutMinimum` to 0 and take no protection; that is not copied.
Derived from p90 round-trip slippage at $10 (1.085% / 0.350% / 0.549% across the three
windows), halved per leg, plus three ticks of the observed ~0.8% per-tick drift to cover
the 5 s detection latency: 0.54% + 2.4% ≈ 2.94%. **`buildSwap` REFUSES a non-positive
bound rather than defaulting it.** It is a first value to be re-derived from logged live
slippage, not a measurement of itself.

---

## 5. What every trade logs

*Proposed. See the design.*

---

## 6. Findings, as they arrive

### FIRST DRY RUN — 2026-09-16, 65 minutes, live launches

```
ticks                760        Initialize logs seen     238
candidates           211        qualified                 24   (11.4% of candidates)
simulated             24        simulated CLEAN           17
                                simulated REVERTED         7   (29.2%)
skipped by a rail      0        RPC cost      102,479 CU = $0.046 for 65 min
```

**24 qualifying launches in 65 minutes is ~532/day**, above the 200–486/day the
backtest windows measured.

#### WHAT THE DRY RUN REVEALED THAT THE BACKTEST DID NOT

**1. NEARLY A THIRD OF QUALIFYING LAUNCHES PRODUCE CALLDATA THAT REVERTS.** 7 of 24
reverted on `eth_call` against the live pool. **The backtest had no equivalent of this
number because it never simulated anything** — it computed returns from prices that
already existed. A trade that cannot execute is not a trade, and this is a cost the
measured +15% median never carried.

**2. THE FEE TIER AND THE LAUNCHPAD ARE NO LONGER COLLINEAR, and the live data broke
the tie within an hour.**

| launchpad | fee | pools | simulated clean |
|---|---|---|---|
| `0x58daec3116aa…` | 10000 | 10 | 8 |
| PoolManager (direct) | 500 | 9 | 8 |
| `0x58daec3116aa…` | **803369** | 3 | **0** |
| `0x58daec3116aa…` | 100 | 2 | 1 |

**One launchpad now emits four fee tiers.** The backtest measured them as
near-perfectly collinear; that has already ended. **Making the launchpad primary was
right — and it is also, on its own, too permissive**: every one of the three pools it
produced at an 80% fee reverted. The backtest's "extreme fee is poison" finding appears
here as a simulation revert rather than as a bad return, which is a cheaper way to learn
it. **A fee sanity check belongs in the rule, and it is recorded here before being
written.**

**3. THE RPC COST IS 2.4x THE ESTIMATE.** Section 2 priced a 5 s Initialize poll at
$0.47/day. The measured run costs **$1.11/day**, because the estimate counted only that
poll: the loop also pays a second `eth_getLogs` per tick to find first swaps, one
`eth_getTransactionByHash` per candidate to read the launchpad, and one `eth_call` per
simulation. 760 ticks x 2 getLogs = 91,200 CU of the 102,479. **The earlier figure was
not wrong so much as incomplete, and it is superseded.**

**4. The observed creation-to-first-swap gap on qualifying launches** ran 4.9 s to
49.8 s with a mean of 12.0 s. The rule's 11–600 block window bounds this by
construction, so it is a description of what passed rather than of all launches.

**5. Position sizing and the bound held exactly**: 24 of 24 at $10.00, and
`min_out / quoted_out` = 0.97000 on every one — the 300 bps bound applied without
exception.

#### TWO DEFECTS THE DRY RUN FOUND IN ITSELF, BOTH MINE

**The entry rule could never fire.** Detection passed `initBlock + 1` as the first-swap
block, because at Initialize time the first swap has not happened. The gap was therefore
1 on every candidate, below the 11-block minimum, and the first run saw launches and
qualified none of them. Pools are now held pending until their first Swap lands and are
judged on the real gap — which also improved the quote, since it now comes from a traded
price rather than from the initial `sqrtPriceX96`.

**THE LAUNCHPAD ADDRESS WAS FABRICATED.** The config carried
`0x58daec3116aa2cc3c60f7c1bdf9c895f7d1d0e35`: the first twelve characters came from a
truncated `0x58daec3116aa…` in this project's own notes and **the remaining twenty-eight
were invented**. The real address is `0x58daec3116aae6d93017baaea7749052e8a04fa7`. It
matched nothing, so every launch was rejected with "launchpad not in the list". This is
the fabricated-constant failure `ROBINHOOD.md` records for a topic hash — *a fabricated
topic matches zero logs and reads as a clean sweep* — repeated with an address, three
passes after that rule was quoted back. **A TRUNCATION IN A DOCUMENT IS NOT AN
IDENTIFIER.** Both addresses are now read from `v4_pool_creator` with their counts beside
them.

#### THE /trades TAB

Verified by executing the served page in jsdom, per `ROBINHOOD.md` step 14:

```
rendered data rows 24    page claims 24 of 24    script errors 0
banner states the mode                     every one of 24 rows carries a mode label
totals grouped per mode (1 block)          24 token links well-formed
mode filter -> 24 rows                     launchpad filter -> 15 of 24
a malformed filter is ignored, not applied
verify-trades-page: PASS
```

**Totals are computed per mode and never summed across modes.** A dry-run gain and a
live gain are different quantities; adding them gives a number true of nothing.

---

## 7. Rules here the code does not implement

- **The exit leg is constructed but never executed, even in dry run.** `buildSwap`
  produces the sell calldata and it is stored on every trade row, but nothing simulates
  it against the pool as it would exist 30 seconds later, and nothing measures the
  realised exit. The +30/+60/+120/+300 s price backfill specified in section 5 is
  likewise not yet written: the columns exist and are null.
- **No fee sanity check.** The launchpad filter alone admitted three pools at an 80% fee
  and all three reverted. Section 6 records the evidence; the rule does not yet act on it.
- **`MAX_CONCURRENT` and `MAX_DAILY_LOSS_USD` are defined and not enforced.** A dry run
  holds no position and realises no loss, so neither has a code path yet. They must gain
  one before any live mode exists, and until then they are documentation rather than
  rails.
- **Boot reconciliation has never been exercised against a real open position**, only
  against zero rows. Its behaviour on a genuinely stuck position is specified and
  untested.
