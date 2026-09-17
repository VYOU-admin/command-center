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
wallet address      0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a  (supplied by the
                    operator 2026-09-16; ADDRESS ONLY -- no key, no signing path)
wallet balance      $126.73, READ FROM THE CHAIN 2026-09-16 by npm run wallet-probe.
                    native 52,569,197,952,034,720 wei = 0.05256919795203472 ETH at
                    ETH/USD 2,410.735 from the chain's own series. WETH 0,
                    USDG 0.000001 (ONE raw unit of a 6-decimal token -- dust, and
                    reported rather than rounded to zero). nonce 130, code 0x, a
                    plain EOA. chainId confirmed 0x1237 = 4663. Control read of the
                    v4 PoolManager through the identical path: 19,964.71 ETH,
                    1,757.92 WETH, 42,536,952.25 USDG -- the reader works.
arming              PASSES BOTH. $126.73 against MAX_CONCURRENT 5 x $10 = $50
                    required, and against the $100 MAX_DEPLOYED_USD cap. The boot
                    path armed for the first time on 2026-09-16 (mode
                    dry-run-capgate) -- every earlier run either had no wallet or
                    refused, so the ALLOW direction had never been observed.
mode                dry-run only. Five runs to date; see section 6.
limits              the six rails of section 4, all enforced in bot/rails.ts and
                    all exercised by npm run rail-drill (26 of 26)
trades to date      0 REAL. 107 hypothetical rows across every dry-run mode.
capital approved    $100 total, $10 per position (operator, 2026-09-16), and since
                    2026-09-16 ENFORCED as MAX_DEPLOYED_USD rather than stated here
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
| **max deployed** | **$100** | **the hard capital cap — the wallet is personal and the bot is not entitled to all of it. See below.** |
| max trades/day | 40 | ~8% of the 485/day available in the SELLOFF window |
| max daily loss | $15 | 15% of capital |
| consecutive simulation reverts | 3 | a broken calldata shape must stop at once |
| kill switch | a Postgres row, re-read on a fresh connection every tick | a memory flag dies with the container and cannot be set from outside |

**A kill-switch READ FAILURE halts.** An unreachable database is not permission to keep
trading.

### THE HARD CAPITAL CAP — `MAX_DEPLOYED_USD = 100`, added 2026-09-16

**THE BALANCE IS NOT A BUDGET, AND UNTIL NOW NOTHING IN THE BOT SAID SO.** The arming
gate asks one question — *can this wallet cover what the rails can put at risk at once* —
and `MAX_CONCURRENT × MAX_POSITION_USD = $50` is the whole of it. That question has no
upper side. **A wallet holding $5,000 passes it with a factor of a hundred to spare**,
and nothing else in the bot bounded the total; the "$100 capital approved" in section 0
was a sentence in a document, enforced by no code. This rail is the enforcement.

**THE REASONING, WHICH IS NOT A RISK CALCULATION.** This is the operator's personal
wallet, not an account funded for the bot. The bot is entitled to a stated amount of it
and to no more, whatever the wallet happens to hold on any given day. A limit derived
from the balance would rise every time the operator was paid, which is precisely
backwards — a bot's mandate must not grow because its owner's savings did.

> **THE QUANTITY IT BOUNDS.** `deployed = the cost basis of every open position + the
> day's realised LOSSES`. A trade is admitted only when
> `deployed + MAX_POSITION_USD <= MAX_DEPLOYED_USD`.

Five properties, each of which is a decision rather than an implementation detail:

- **IT IS FORWARD-LOOKING, AND HAS TO BE.** Testing `deployed >= 100` after the fact
  would admit the trade that takes it to $110. The rail asks whether the trade *about to
  be placed* would breach the cap, and the prospective size is exactly
  `MAX_POSITION_USD` because `positionWei()` sizes every position at it.
- **REALISED LOSSES COUNT, WHICH IS WHAT MAKES IT A CAPITAL CAP RATHER THAN A
  CONCURRENCY LIMIT IN DOLLARS.** A bot that loses $10 and reopens has the same open
  basis and less money. Counting the day's losses makes the cap a bound on what the day
  can COST, not on what happens to be open at an instant.
- **PROFIT DOES NOT CREATE HEADROOM.** The loss term is `max(0, −pnl)`, so a profitable
  day leaves the cap exactly where it was. A gain in the bot's ledger is not a mandate to
  risk more of the operator's wallet, and the symmetric form would quietly turn one good
  morning into a larger afternoon.
- **AN OPEN POSITION WITH NO RECORDED COST BASIS MAKES `deployed` UNKNOWN, AND UNKNOWN
  BLOCKS.** `sum(position_usd)` over rows where one is null silently contributes zero,
  which is this project's most-recorded failure shape — the `balanceOf` reader that
  turned 490 HTTP 429s into plausible zero balances. The rail counts those rows
  separately and refuses rather than under-reporting exposure.
- **IT IS READ FROM POSTGRES, NEVER COUNTED IN MEMORY**, for the reason every other rail
  is: a container replacement must not let the bot forget what it already has at risk.

**IT CANNOT BIND UNDER TODAY'S OTHER RAILS, AND THAT IS STATED RATHER THAN LEFT TO BE
DISCOVERED.** `MAX_CONCURRENT 5 × $10 = $50` of open basis plus `MAX_DAILY_LOSS_USD $15`
caps `deployed` at **$65**, comfortably below $100, so on the live path one of those two
fires first every time. **The cap is a backstop against the other rails being raised**,
not a constraint that fires today — and that is exactly why it must be tripped
deliberately rather than waited for. A rail whose threshold is unreachable is the easiest
kind to get wrong and the hardest to notice.

**THE ARMING GATE IS UNCHANGED AND STAYS THE $50 QUESTION.** The bot still reads the
balance and still refuses below `MAX_CONCURRENT × MAX_POSITION_USD`, because arming
without enough to cover what the rails permit means a rail meant to bound exposure is
instead bounded by running out of money. **The balance decides whether the bot may start;
the cap decides how much it may ever deploy.** The two are reported side by side and
neither is derived from the other.

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

### THE FEE SANITY CHECK — an allow-list, and why not a bound, 2026-09-16

Dry run 1 produced three pools at `fee=803369` from launchpad `0x58daec…`, and all
three reverted in simulation. The question was what bound would have rejected them.

**Population.** 1,070 rule-qualifying launches whose Initialize transaction target is
one of the two launchpads, in blocks 63,216,393–64,216,393. Attribution required
reading the Initialize transactions: 752 reads, 11,280 CU, **$0.00508**, 752 resolved,
0 failed. "Exit available" means at least one swap in the pool between +150 and +450
blocks of its first swap — the window this bot would have to sell into.

The three tiers real launchpads use dominate and behave alike:

| fee | n | % of pop | exit available | median return |
|---|---|---|---|---|
| 500 | 359 | 33.6% | 86.9% | +0.271 |
| 10000 | 157 | 14.7% | 92.4% | +0.063 |
| 100 | 58 | 5.4% | 86.2% | +0.150 |

Everything else is a long tail of one-off tiers, mostly with no exit at all.

**The bound loses to the allow-list, which is the finding:**

| rule | n | % of pop | exit available | median | mean |
|---|---|---|---|---|---|
| allow-list {100, 500, 10000} | 574 | 53.6% | **88.3%** | **+0.144** | **+0.319** |
| bound `fee <= 10000` | 696 | 65.0% | 76.7% | +0.100 | +0.268 |

The 122 extra pools a `<= 10000` bound admits are dominated by two arithmetic runs from
a single launchpad — `9111, 9121, …, 9841` and `10881, 10891, …, 11201`, each stepping
by 10, one pool per tier. **Zero of the 33 pools in the second run had an exit
available.** A factory that walks the fee integer sits just under whatever round number
a threshold would pick, so magnitude cannot separate it; membership of the three tiers
real launchpads actually use can.

`ALLOWED_FEES = [100, 500, 10000]`, enforced in `bot/rule.ts`, secondary to the
launchpad and never a substitute for it.

**What it would have done to dry run 1:** rejected the 3 pools at 803369, all of which
reverted. 24 rows become 21, and 7 reverts become 4 — a predicted revert rate of
**19.0%** against the 29.2% actually recorded.

### THE SAFETY RAILS ARE NOW RAILS, AND EVERY ONE HAS BEEN TRIPPED — 2026-09-16

`MAX_CONCURRENT` and `MAX_DAILY_LOSS_USD` were constants in `config.ts` that no code
read. They were documentation. All five rails now live in `bot/rails.ts`, the single
implementation, and every figure is read from Postgres rather than counted in memory —
a container replacement must not let the bot forget it already lost $14 today.

Two rails **halt** rather than skip: a run of reverts and a breached daily loss are
statements about the strategy or the chain, not about one pool, and continuing to the
next launch would repeat the mistake within seconds. Concurrency and daily count are
ordinary capacity limits and correctly skip.

`npm run rail-drill -- --commit` exercises each rail one below its threshold and at it,
on `chain='drill'` so tripping the kill switch cannot halt the live dry run. **13 of 13
cases passed**, cleanup verified on a fresh connection (0 rows, 0 control rows):

```
PASS  MAX_CONCURRENT at 4 open (one below)      ALLOW
PASS  MAX_CONCURRENT at 5 open (at the rail)    BLOCK  [5 open >= 5]
PASS  MAX_DAILY_LOSS_USD at -$14                ALLOW
PASS  MAX_DAILY_LOSS_USD at -$15                BLOCK  [-15.00 <= -15]
PASS  daily PnL of +$20 (profit, same size)     ALLOW
PASS  MAX_CONSECUTIVE_REVERTS at 2              ALLOW
PASS  MAX_CONSECUTIVE_REVERTS at 3              BLOCK  [3 >= 3]
PASS  a clean simulation after the run          ALLOW
PASS  MAX_TRADES_PER_DAY at 39                  ALLOW
PASS  MAX_TRADES_PER_DAY at 40                  BLOCK  [40 >= 40]
PASS  kill switch not set                       ALLOW
PASS  kill switch set by an outside writer      BLOCK  [kill switch: rail drill]
PASS  kill switch cleared                       ALLOW
```

The profit case is not decoration. Writing the daily-loss test as `abs(pnl) >= MAX`
would halt the bot for **making** $15, and only a test in both directions catches it.

### BOOT RECONCILIATION, EXERCISED AGAINST REAL ROWS — 2026-09-16

It had only ever run against zero open rows, which proves it can count to nothing.
`npm run reconcile-drill -- --commit` seeds the cases a container replacement actually
leaves behind. **7 of 7 passed**, cleanup verified on a fresh connection.

| case | seeded | outcome |
|---|---|---|
| 1. buy landed, never sold | `holding`, balance > 0 | → `needs_exit` |
| 2. intent that never broadcast | `intent`, balance 0 | → `closed_unfilled` |
| 3. row says holding, chain says zero | `holding`, balance 0 | → `closed_unfilled` |
| 4. open rows, no wallet configured | `holding` | **HALT**, row untouched |
| 5. balance unreadable | `holding`, non-contract token | **HALT**, row untouched |

Case 5 is the one worth keeping: `eth_call` to a non-contract returns `0x`, and the
error was `Cannot convert 0x to a BigInt` followed by a halt. A `?? 0` on that path
would have produced a perfectly plausible zero balance and silently closed a position
that was still open — the exact defect this project records for a `balanceOf` reader
that turned 490 HTTP 429s into zero balances.

**A fixture the drill refused to fake.** The first version looked for a token the
PoolManager holds none of, to produce the zero-balance case. There is no such token —
the PoolManager custodies every v4 pool's liquidity — and the drill stopped with
`refusing to seed cases whose balances were not actually measured` rather than
inventing one. The zero case is a different **wallet**, not a different token, and
reconciliation runs twice, which is what the two situations actually look like for a
bot that has one wallet.

### THE EXIT LEG, SIMULATED — and the honest limit of it

At entry time the tokens are not held. Simulating the sell from our own address would
revert for a reason that says nothing about the pool — an empty wallet — and would
report a 100% exit-revert rate that is an artefact.

So the sell is simulated **from an address that actually holds the token**: the sender
of the pool's own first swap, whose balance is read before use, selling `min(balance,
our quoted size)`.

**What this proves:** the pool accepts a sell of this size, the calldata is well-formed,
and no hook blocks selling.
**What it does not prove:** our wallet's approval state. That is a separate leg, measured
separately in section 2 — two setup transactions, ERC-20 → Permit2 and Permit2 → router.

Every outcome is its own stored value — `clean`, `reverted`, `no_holder_found`,
`holder_zero_balance`, `probe_failed` — and the three "could not be attempted" values
are counted separately from `reverted`. A partial check reported as a full one is the
failure this document exists to prevent.

### THE PRICE BACKFILL, AND A RECIPROCAL THAT REPORTED TOTAL LOSS — 2026-09-16

`px_30s / px_60s / px_120s / px_300s` were null on every row. `npm run price-backfill`
fills them with one `eth_getLogs` per trade (60 CU): the v4 Swap event indexes the pool
id as topic 1, so a single filtered request returns exactly that pool's swaps over the
300 seconds after entry. 24 attempted, **22 filled, 2 pools had no swaps in the window,
0 read failures, 1,440 CU ($0.00065)**. Verified on a fresh connection: 20/21/22/22
non-null across the four columns. A window that has not elapsed is left **null** and
counted; a null means "not yet observable" and a zero would mean "the price went to
zero", and the two must never be confused.

**The first grid it produced was a median return of −1.0000 at every horizon, with best
equal to worst.** That is not a market outcome. `entry_price` held the *quote rate*
(tokens per pricing unit, which is what `expectedOut` needs to size a buy) while the
backfill computed a *token price* (pricing units per token). They are exact reciprocals,
so the ratio was about 1e-30 and rendered as "lost everything". Proof, from the rows
themselves — the two multiplied should be ≈ 1 if they are inverses:

```
entry_price x px_30s = 1.122, 1.130, 1.141, 1.160, 1.170, 2.318
```

They are, and that deviation from 1 **is** the price move.

This is the two-implementations-of-one-rule defect this project has now recorded six
times. `bot/price.ts` is the single implementation of both conventions, named so a call
site shows which is in play, and `launchbot` and `price-backfill` both go through it.
It was caught only because −1.0000 exactly, with zero spread, is impossible. A subtler
mismatch would have been believed.

### THE WITHIN-RULE EXIT GRID — a hypothesis, not a finding

Recomputed against the correct entry reference, over dry run 1's own 22 priced launches:

| horizon | n priced | n null | median return | % positive | best | worst |
|---|---|---|---|---|---|---|
| **+30s (the implemented rule)** | 20 | 4 | **+0.205** | 100.0% | +4.951 | +0.107 |
| +60s | 21 | 3 | +0.312 | 95.2% | +4.951 | −0.519 |
| +120s | 22 | 2 | +0.511 | 95.5% | +5.975 | −0.519 |
| +300s | 22 | 2 | +0.821 | 95.5% | +6.974 | −0.519 |

Restricted to the new fee allow-list (n=21): +0.205 at 30s, +0.835 at 300s.

**Holding longer was monotonically better, and the bot's +30s is the worst of the four
cells.** `EXIT_DELAY_BLOCKS` has NOT been changed on this evidence and must not be.
This is 22 launches in one 70-minute window, it is not a holdout, and 100% positive at
+30s is a statement about that window rather than about the strategy. It is recorded
here as a hypothesis to be tested on a window not yet touched, which is the same
standard applied to creator identity in ROBINHOOD.md.

The honest reading of the +30s column is narrower and more useful: across those 20
launches there was no cell where exiting at +30s lost money, which is weak evidence that
the exit is *safe*, and no evidence at all that it is *optimal*.

### SECOND DRY RUN — 2026-09-16, 70 minutes, live launches

Started 10:53Z under the fee allow-list, the five real rails and the exit simulation.

```
ticks 819   initializes 239   candidates 204   qualified 35
simulated 16   simClean 11   simReverted 5     skippedRail 19
exitClean 2    exitReverted 14  exitNotAttempted 0
110,848 CU   $0.04988
```

**THE FEE BOUND DID NOT MOVE THE REVERT RATE, and that is the headline.**

| run | n | reverted | revert rate |
|---|---|---|---|
| 1 — no fee bound | 24 | 7 | 29.2% |
| 2 — allow-list active | 16 | 5 | **31.3%** |

The prediction in section 6 was 19.0%: remove the three 803369-tier pools, which were
0-for-3, and the rest should hold. It did not happen. The allow-list worked exactly as
designed — **zero** pools outside {100, 500, 10000} were traded, confirmed by query —
and the reverts simply moved to the allowed tiers: 2 of 9 at fee 500, 2 of 5 at 10000,
1 of 2 at 100. On n=16 against n=24 the difference is noise in both directions.

The honest conclusion: **the 803369 tier was not the cause of the revert rate, only a
visible correlate of it.** Removing it removed three bad pools and told us nothing about
the other four reverts, which were always the interesting ones. A filter that removes
the cases you already understood does not improve the number you were trying to explain.

**A RAIL FIRED IN PRODUCTION, UNPLANNED.** `MAX_TRADES_PER_DAY: 40 >= 40` blocked 19
launches from 11:39Z onward. Run 1's 24 rows and run 2's 16 both fall on 2026-09-16, so
the day's budget was genuinely spent. This is correct behaviour and the first time a
rail stopped real work rather than a drill — but it means run 2 is a **truncated
sample**: it observed 70 minutes of launches and was only permitted to act on the first
46 of them. Its 31.3% is over 16 trades, not over the hour.

### THE EXIT LEG REVERTED 14 OF 16 — and 9 of those are the fixture, not the pool

Every one arrived as a bare `execution reverted` with no reason string. An 87.5% failure
rate with no cause attached is not a measurement, so `npm run exit-diagnose` read both
approvals the sell path requires (section 2) for each borrowed holder — 32 calls, 832
CU, $0.00037:

| exit outcome | ERC-20 → Permit2 | Permit2 → router | n |
|---|---|---|---|
| reverted | **zero** | **zero** | 9 |
| reverted | nonzero | nonzero | 5 |
| clean | nonzero | nonzero | 2 |

**9 of the 14 reverts are the borrowed wallet having granted no approvals**, which is
exactly what the design anticipated: the fixture is the first swap's sender, who has no
reason to have approved a router path they did not use. Those nine say nothing about
whether our exit would work.

That leaves the only defensible figure: **of the 7 fixtures that did hold both
approvals, 2 exits simulated clean and 5 reverted.** n=7 is far too small to conclude
from, and it is reported here as the number that is actually about the pool rather than
about the fixture. It is markedly worse than the entry leg's 68.8% clean, and it is the
single most important open question in this document — the exit is the leg that has
never been demonstrated end to end, and this is the first evidence that it is harder
than the entry rather than easier.

**What this run changed about the method, not just the numbers:** the headline 87.5%
was wrong to state on its own, and the only reason it was not stated is that the design
named the confound before the measurement was taken. Writing down what a check does not
prove, at the time the check is written, is what made a two-minute diagnosis possible
instead of a wrong finding.

### THE EXIT GRID, BOTH RUNS, ON THE CORRECTED ENTRY PRICE

40 rows, 36–38 priced depending on horizon:

| horizon | n priced | n null | median return | % positive | worst |
|---|---|---|---|---|---|
| **+30s (implemented)** | 36 | 4 | +0.223 | 100.0% | +0.073 |
| +60s | 37 | 3 | +0.317 | 97.3% | −0.519 |
| +120s | 38 | 2 | +0.478 | 97.4% | −0.519 |
| +300s | 38 | 2 | +0.715 | 94.7% | −0.519 |

Run 2 alone, all 16 priced with no nulls — the allow-list is why, since the 803369 pools
that produced run 1's nulls had no swaps at all:

| horizon | median | % positive | worst |
|---|---|---|---|
| +30s | +0.240 | 100.0% | +0.073 |
| +60s | +0.335 | 100.0% | +0.059 |
| +120s | +0.396 | 100.0% | +0.063 |
| +300s | +0.540 | 93.8% | −0.022 |

**The monotone shape replicated in run 2 independently of run 1.** That is worth more
than either run alone, and it is still not a holdout: both runs are the same afternoon
on the same chain, and a regime that favours holding would produce this in both. The
exit delay has not been changed. Two consistent samples are a reason to design the test,
not to skip it.

Note also that the +30s column has a **positive worst case in both runs** — across 36
launches there was no cell where exiting at +30s lost money. That is weak evidence the
exit is safe and no evidence at all that it is optimal, which remains the honest reading.

### THE EXIT HORIZON, ON THE PRE-COMMITTED HOLDOUT — 2026-09-16

Both dry runs put the configured +30 s last of four horizons. That was 36 launches from
one afternoon. This settles it properly.

**THE SPLIT IS THE ONE `launch-search.ts` FIXED BEFORE ANY HYPOTHESIS WAS FORMED** —
first hex character of `md5(pool_id)`, `0`-`7` search, `8`-`f` holdout — now extracted
into `bot/holdout.ts` so a second implementation cannot bucket pools differently and
still call its result a holdout. Ten horizons out to +600 s, entry at +15 s, every
launch in `ALLOWED_FEES` with a gap of 11–600 blocks, across all four swept windows.
Zero CU.

**Pooled, 12,782 search against 12,624 holdout:**

| horizon | SEARCH median | HOLDOUT median | exit found (holdout) | median GIVEN an exit |
|---|---|---|---|---|
| +15 s | 0.118 | 0.120 | 84.3% | 0.163 |
| **+30 s (configured)** | **0.242** | **0.249** | 81.8% | 0.320 |
| +45 s | 0.316 | 0.318 | 76.4% | 0.435 |
| +60 s | 0.393 | 0.394 | 74.2% | 0.567 |
| +90 s | 0.560 | 0.565 | 70.9% | 0.845 |
| +120 s | 0.660 | 0.662 | 67.9% | 1.054 |
| **+180 s** | **0.674** | **0.676** | 62.3% | 1.380 |
| +300 s | 0.425 | 0.476 | 55.2% | 1.793 |
| +450 s | 0.000 | 0.000 | 47.8% | 2.072 |
| +600 s | 0.000 | 0.000 | 30.1% | 2.089 |

**The holdout reproduced the search half cell for cell** — every horizon within ~0.005,
the same peak, margin +0.427 against +0.432. The survivor is **+180 s**.

**THE TWO COLUMNS MUST BE READ TOGETHER AND THAT IS WHY BOTH ARE THERE.** `median given
an exit` rises monotonically all the way to +600 s (2.09) — waiting always improves the
price. `exit found` falls from 84% to 30% — waiting steadily removes the chance of
selling at all. The peak of the median over EVERY launch is where those two cross, and
past +300 s the no-exit zeros take the median entirely.

#### THE POOLED NUMBER IS THE CORPUS ERA, AND THE CORPUS IS THE ANOMALY

94.5% of that population is the corpus window, which `ROBINHOOD.md` establishes as the
outlier. Restricted to the three post-corpus windows — 707 search, 689 holdout:

| horizon | SEARCH | HOLDOUT |
|---|---|---|
| +30 s | 0.057 | 0.060 |
| +90 s | **0.157** | 0.157 |
| +120 s | 0.155 | 0.171 |
| +180 s | 0.080 | **0.180** |

**The two halves disagree about the peak: search says +90 s, holdout says +180 s.** At
n≈700 the ranking inside the 90–180 s plateau is not resolved, and saying otherwise
would be reading noise.

#### PER WINDOW, BOTH HALVES — WHICH IS WHERE THE ROBUST ANSWER IS

| window | half | +30 s | +90 s | +180 s | +300 s |
|---|---|---|---|---|---|
| MIDPOINT (n≈242) | search / holdout | 0.000 / 0.001 | 0.022 / 0.008 | 0.002 / 0.000 | 0 / 0 |
| CALM (n≈142) | search / holdout | 0.164 / 0.202 | **0.268 / 0.323** | 0.092 / 0.339 | 0 / 0 |
| SELLOFF (n≈313) | search / holdout | 0.104 / 0.089 | 0.204 / 0.199 | **0.296 / 0.372** | 0.000 / 0.369 |

**+90 s beats +30 s in 6 of 6 window×half combinations. +180 s beats it in 4 of 6**,
failing in MIDPOINT (both halves) and CALM (search only). **The robust statement is
that the configured +30 s is beaten everywhere by something in the 90–180 s band; the
exact point inside that band is not established.**

#### THE FAILURES, WHICH ARE MOST OF THE GRID

- **+450 s and +600 s are exactly 0.00000 in every era and every half.** More than half
  of launches have no trade to exit into by then, and the zeros own the median.
- **+300 s is 0.00000 in all three recent windows** while reading +0.425/+0.476 pooled.
  It survives only on corpus-era pools.
- **MIDPOINT is flat at every horizon** — 0.000 to 0.022 across the whole grid, both
  halves. The rule barely functions in that window at all, and no exit horizon rescues
  it. A horizon change is not a fix for a window where the entry has no edge.
- **The magnitude does not transfer between eras.** +180 s is +0.676 pooled and +0.180
  in the recent holdout — a factor of nearly four. Only the ORDERING transfers.

#### TWO DEFECTS THIS GRID FOUND IN ITSELF

**The longest horizon could never fill.** The first run loaded ticks to exactly +600 s
and then asked the +600 s horizon for a trade strictly after +600 s. There is none by
construction, so the cell reported `exit_found: 0` and a median of exactly 0.00000 — my
own boundary presented as a market result. `ROBINHOOD.md` records the identical shape in
`surv_1h`. Ticks now run 300 s past the longest horizon, derived from the measured
median exit fill delay of 1.1–4.5 s, and the censoring bound moves with them.

**The exit could re-select the entry tick.** On a quiet pool the entry fills LATER than
an early horizon mark, and a plain `off > mark` would then return the entry trade itself
and report a return of exactly 0 — which looks like an ordinary flat result, not a
defect. The exit is now strictly after BOTH the mark and the entry fill.

**`EXIT_DELAY_BLOCKS` HAS NOT BEEN CHANGED.** The operator decides.

### WHY A THIRD OF TRADES REVERT: IT IS OUR OWN SLIPPAGE BOUND — 2026-09-16

The revert rate did not move when the fee allow-list went in, so the cause was still
unknown. `npm run revert-decode` re-simulates each failed entry at the block we would
have traded and captures the revert payload `RpcClient` discards when it turns the
response into an Error. 12 trades, 1,524 CU, $0.00069.

**THE CAUSES CLUSTER ON ONE FIELD:**

```
11x  V4TooLittleReceived(uint256,uint256)   <- our own amountOutMinimum
 1x  empty revert payload (0x), no reason
```

**`0x8b063d73` was identified by computing keccak of candidate signatures**, not by
lookup — `ROBINHOOD.md` records a fabricated hash shipping here once. `0x5bf6f916`,
returned by every at-head replay, is `TransactionDeadlinePassed()`: the stored deadline
was `now + 300 s` during the dry run, which confirms the at-head column says nothing
and the historical block is the right question.

**THE ERROR STATES WHAT BOUND WOULD HAVE CLEARED**, and the distribution is the finding:

| | min | p25 | median | p75 | p90 | max |
|---|---|---|---|---|---|---|
| our bound / what the pool would pay | 1.015 | 1.041 | 1.225 | 2.543 | 13.70 | 31.71 |
| implied one-leg slippage needed | 1.49% | 3.90% | **18.35%** | 60.7% | 92.7% | 96.85% |

**This is not a bound that is slightly too tight. It is bimodal.** A quarter of the
rejections are marginal — 1.5% to 3.9%, just outside our 3% — and the rest are pools
where our quote is wrong by a multiple.

**THE ROOT CAUSE IS THE QUOTE, NOT THE BOUND.** `expectedOut` takes the realised price
of the pool's FIRST swap and extrapolates it linearly to our $10, with **no price-impact
term anywhere**. On a pool whose first trade was a few dollars, a $10 buy moves the
price far more than that extrapolation admits, and the router correctly refuses. Every
tier and both launchpads are represented among the 11, so this is not a property of any
launchpad — it is a property of our own arithmetic.

**Widening the bound therefore cannot be the whole answer**, and the measured
distribution says so: a bound that rescued the median would be accepting an 18.35%
haircut against a measured median gross return of +16% (recent era). **It is recorded
here and the quote is NOT yet fixed** — that is a change to what the bot believes a
trade is worth, which is a definition.

### EXIT RETRY: A LADDER THAT IS THE MEASURED QUANTILES — 2026-09-16

An exit that reverts and is abandoned leaves the bot holding a token it cannot sell,
which is the worst outcome available to it. `bot/exit.ts` is the one implementation.

| attempt | bound | provenance |
|---|---|---|
| 1 | 300 bps | the configured bound — p90 round-trip slippage at $10 plus three ticks of drift |
| 2 | 400 bps | the measured **p25** shortfall, 3.90%, rounded up |
| 3 | 1,835 bps | the measured **median** shortfall — half of all observed rejections clear here |
| 4 | 6,070 bps | the measured **p75** shortfall — the last rung worth climbing |

**IT STOPS AT THE p75 DELIBERATELY.** The p90 shortfall is 92.7%, indistinguishable from
giving the tokens away, and the measured median gross return means any bound past the
p75 guarantees a loss larger than the position's whole expected gain. **A rung that can
only turn a small loss into a total one is not a rescue.**

**THE INTERVAL IS 5 SECONDS**, from the measured median exit fill delay of 1.1–4.5 s
across all ten horizons: long enough that a new trade has landed and the quote has
genuinely moved, so a retry is a fresh attempt rather than the same one repeated. Four
attempts complete within ~15 s.

**EVERY ATTEMPT RE-QUOTES, EVERY ATTEMPT IS RECORDED BEFORE THE NEXT BEGINS, AND
EXHAUSTION RAISES** — it does not return a status a caller may ignore, because the
position is still open and a status field eventually gets unchecked.

**n IS 11.** That is a thin base for a four-rung ladder and it is stated rather than
buried. These are a first schedule to be re-derived from logged live exits.

#### THE DRILL — 12 of 12, INCLUDING A REAL REVERT AGAINST A LIVE POOL

`npm run exit-retry-drill -- --commit`. The forced failure uses the **measured** median
quote optimism of 1.2248, not a round number, so the early rungs fail for exactly the
reason the ladder was built for.

```
PASS  the ladder is the measured quantiles, in order        300,400,1835,6070
PASS  a rung past the measured data RAISES
PASS  an unquotable pool RAISES rather than selling blind
PASS  a bound that zeroes minOut RAISES
PASS  a first-attempt success stops the ladder
PASS  two failures then a fill reports the rung that worked  filled on 3
PASS  the widening bound is applied per attempt              300,400,1835
PASS  EXHAUSTION RAISES rather than returning a status
PASS  every attempt was recorded before the raise            4 recorded
PASS  the raise says the position is still open
PASS  a REAL V4TooLittleReceived was produced against a live pool
```

**The live half is the one worth reading, and its result is not the happy one:**

```
#1 @300bps  failed — V4TooLittleReceived bound=29760802800000 actual=0
#2 @400bps  failed — V4TooLittleReceived bound=29453990400000 actual=0
#3 @1835bps failed — V4TooLittleReceived bound=25051232460000 actual=0
#4 @6070bps failed — V4TooLittleReceived bound=12057727320000 actual=0
outcome: RAISED — EXIT EXHAUSTED, THE POSITION IS STILL OPEN
```

**`actual = 0` at every rung. The pool would pay NOTHING**, so no bound could ever have
rescued it, and the ladder exhausted and raised rather than widening toward zero. That
is the correct behaviour and it is also the limit of what a retry can do: **a retry
ladder rescues a mispriced quote, not a dead pool.** The tokens in that fixture are
unsellable at any bound, and the honest response is to be loud about it.

**A DEFECT THE DRILL FOUND IN ITSELF.** Its first version priced the fixture from a swap
in the last 200,000 blocks; the fixture pool — a dead launch, which is what most of
these are — had none, so the live half reported `NOT RUN`. Honest and useless: the whole
point is that a retry path nobody has exercised is not a retry path. It now prices from
the trade's own stored `px_entry`, and a holder who no longer holds the token raises
rather than running a test whose premise is false.

### THE NIGHTLY CHECK IS ADAPTIVE, AND IT RECOMMENDS ONLY — 2026-09-16

`npm run nightly-check` backfills the price at EVERY horizon for every trade the bot
took and reports which horizon would have been best. **It never writes
`EXIT_DELAY_BLOCKS`.** A rule that rewrites its own parameters will chase noise into a
bad regime with nobody able to say when it changed — and this project has the evidence:
the fee-tier rule was measured at +0.298, decayed to +0.145 within ten days, and nothing
in the data announced it. A bot re-fitting itself nightly would have followed that decay
down without a line in any log.

**THE TWO THRESHOLDS ARE DERIVED FROM THE HOLDOUT STUDY ABOVE, not chosen:**

- **Minimum sample 140.** The two halves agreed on the direction in 6 of 6 window×half
  combinations, and the smallest per-window sample where they still agreed is CALM at
  **141 holdout / 144 search**. Below that they start disagreeing about which horizon
  wins. **At `MAX_TRADES_PER_DAY = 40` a single day can never reach it**, so the check
  accumulates over a trailing window and reports how many days it drew on.
- **Margin 0.25.** Two independent halves measuring the SAME quantity at that sample
  size differed by **0.247** (CALM, +180 s: 0.339 against 0.092). That is the
  measurement's own noise floor, so a smaller margin would fire on disagreement one
  dataset produces by itself.

**FIRST RUN — the thresholds working in opposite directions, which is the useful case:**

```
sample 40   min_sample 140   sample_sufficient FALSE
configured +30s  median 0.19889
best       +180s median 0.56804     margin 0.36915   threshold 0.25   MATERIAL
would_alert FALSE      alert_sent FALSE
backfill 40 trades, 400 horizon rows, 275 filled, 2,400 CU
```

**The margin IS material and the alert correctly did NOT fire**, because 40 trades is
below the sample where the offline halves agreed. A check that alerted here would be
alerting on a third of the evidence it needs.

**THE BOT'S OWN 40 LIVE TRADES INDEPENDENTLY REPRODUCE THE PEAK AT +180 s** — 0.154 /
0.199 / 0.240 / 0.288 / 0.353 / 0.377 / **0.568** / 0.560 / 0.217 / 0.000 across the ten
horizons, with exit-availability falling 34 → 14 of 40. That is a third dataset agreeing
with the corpus holdout and the recent holdout on the ordering. **It is also closer in
MAGNITUDE to the corpus era than to the recent windows, which is unexplained** and is
not read as evidence for either.

### THE EXIT HORIZON CHANGED: +30 s → +90 s — 2026-09-16, operator-approved

| | |
|---|---|
| **was** | `EXIT_DELAY_BLOCKS = 300` — exit at **+30 s** after entry |
| **is** | `EXIT_DELAY_BLOCKS = 900` — exit at **+90 s** after entry |
| **decided** | 2026-09-16, by the operator, on the holdout evidence below |
| **decided by** | a measurement, NOT a tuned constant — see what that means below |

**THE EVIDENCE.** `exit-horizon` swept ten horizons out to +600 s across all four swept
windows, on the `md5(pool_id)` split `launch-search.ts` fixed before any hypothesis was
formed. Per window and per half, no-fill and no-exit scored zero over EVERY rule launch:

| window | half | +30 s | +90 s | +180 s |
|---|---|---|---|---|
| MIDPOINT | search / holdout | 0.000 / 0.001 | 0.022 / 0.008 | 0.002 / 0.000 |
| CALM | search / holdout | 0.164 / 0.202 | **0.268 / 0.323** | 0.092 / 0.339 |
| SELLOFF | search / holdout | 0.104 / 0.089 | 0.204 / 0.199 | **0.296 / 0.372** |

**+90 s beats +30 s in 6 of 6 window×half combinations. +180 s beats it in only 4 of 6**,
failing in MIDPOINT on both halves and CALM on the search half.

**WHY THIS IS A DECISION ON EVIDENCE AND NOT A TUNED CONSTANT**, stated so a future
reader can check rather than trust:

- The split was **committed before any hypothesis existed** and is the same one an
  earlier, unrelated search used. It was not chosen to make this result come out.
- The grid ran **identical code on both halves**; the holdout reproduced the search half
  cell for cell, every horizon within ~0.005.
- **The failures are recorded beside the survivor** — +450 s and +600 s are exactly
  0.00000 everywhere, +300 s survives only on corpus-era pools, and MIDPOINT is flat at
  every horizon.
- The value taken is **the conservative end of the band**, not the best cell. The best
  pooled cell is +180 s at +0.676; it was not taken.

**THE BAND'S UPPER END IS UNRESOLVED AT n≈700 AND MUST NOT BE READ AS SETTLED.** On the
three recent windows alone the search half peaks at +90 s and the holdout half at
+180 s. Two independent halves of one dataset disagree about where inside 90–180 s the
optimum sits; at that sample size the disagreement IS the measurement's noise floor.
**+90 s is the point that survives everywhere. +180 s may well be better and is not
established.**

What would move it: a window nobody has looked at, or `nightly-check` reaching its
140-trade minimum on the bot's own trades. That check alerts and cannot write the value.

### THE QUOTE: THE MISSING TERM WAS THE POOL'S OWN FEE, AND THE FIX DOES NOT FIX THE REVERTS

The retry ladder treats the symptom. This is the attempt at the cause, and **the honest
result is that it does not materially reduce the reverts** — reported here rather than
shipped as a success.

#### Ground truth, and why it is exact

`V4TooLittleReceived(uint256,uint256)` carries `(minAmountOutReceived, amountReceived)`.
Setting `amountOutMinimum` to an unreachable value therefore turns the router into an
oracle for its OWN output at our exact size and block, at 26 CU, with no assumption
anywhere. **Nothing else available on this chain answers "what would $10 actually have
got".** 40 trades, one `eth_getLogs` and one `eth_call` each, **3,440 CU = $0.00155**.

#### What the first attempt got wrong, measured rather than argued

The price-impact term was built first, on the reasoning that linear extrapolation was
what the reverts proved wrong. The reasoning was right and **the term was the wrong one**:

```
measured IMPACT      median 0.17%   p90 0.37%   max 47.41%
measured OVER-QUOTE  median 2.50%   p90 16.0%   97.4% of trades over-quoted
```

Impact is an order of magnitude too small to explain the shortfall. Worse, requiring
enough observations to measure it **refused 26 of 40 trades** — a cure worse than the
disease, and that refusal was withdrawn on the measurement.

#### The missing term was the fee, and it is exact

The pool's declared `fee` is taken off every swap before any curve arithmetic and is
stated in the pool key already carried on every row. On a 1% tier the last realised
price implies 1% more output than any trader can get, **every time, deterministically**.

The quote is now `linear × (1 − fee) × (1 − impact)`, in `src/bot/quote.ts`.

**IT BEHAVES EXACTLY AS ARITHMETIC SAYS IT SHOULD, which is how we know it is not
double-counting:**

| fee tier | n | over-quote before | after the fee term |
|---|---|---|---|
| 100 (0.01%) | 3 | 1.0210 | 1.0210 |
| 500 (0.05%) | 18 | 1.0310 | 1.0300 |
| 10000 (1%) | 15 | 1.0250 | **1.0130** |
| 803369 (80.3%) | 3 | 14.127 | **2.778** |

The 1% tier moved by 1.2 points and **no tier fell below 1.0**. A tier dropping under
1.0 would have meant the fee was already inside the realised price and was being taken
twice; none did.

#### THE HONEST RESULT: IT DOES NOT MATERIALLY REDUCE THE REVERTS

| | old quote | corrected quote |
|---|---|---|
| recorded reverts that would clear | **4 of 11** | **4 of 11** |
| over-quote, median | 1.025 | 1.021 |
| over-quote, share above 1.0 | 97.4% | 82.1% |
| trades refused outright | 0 | **0** |

**Four of eleven, both ways. The fix does not move the number it was built to move**,
and that is the finding rather than a disappointment to be explained away.

#### WHAT IT DOES DO, AND IT IS WORTH HAVING

- **It removes a term that was simply wrong.** A 1% fee IS taken; quoting as though it
  were not is an error whether or not it causes a revert.
- **It cuts the SIZE of the miss by 4.5x.** The shortfall on trades that still fail went
  from a p75 of 6,070 bps to **1,343 bps**. The failures are the same trades; they now
  fail by far less, which is what makes a retry ladder able to rescue them at all.
- **It catches the pool where our own size is the problem** — one measured a 47.4%
  impact, and a quote that ignores that is not merely imprecise.

#### THE RESIDUAL, WHICH IS NOW BOUNDED AND NOT IDENTIFIED

**A ~2–3% over-quote remains on every real tier, independent of the fee** — 2.1% at
tier 100, 3.0% at 500, 1.3% at 10000 — and neither the fee nor the measured 0.17%
impact explains it. **Our slippage bound is 300 bps and sits exactly on top of that
residual**, which is the revert mechanism stated precisely: the bound is not too tight
in general, it is calibrated to the median of an error whose distribution straddles it.

Candidates not yet separated: our own impact being larger than a consecutive-swap
estimator can see at n≈3 observations; price movement between the last observed swap and
execution. **It is recorded as bounded and unidentified rather than guessed at.**

#### ONE IMPLEMENTATION, AND THE OLD ONE IS DELETED

The quote lives in **`src/bot/quote.ts`** and is called by the entry path, the exit path,
the retry ladder and the dry run. `rule.expectedOut` is **deleted**, not left dead: an
unused second implementation is one import away from being the live one, and this
project has recorded that failure six times — most recently a price convention
implemented twice as reciprocals, reporting a median return of −1.0000.

#### THE LADDER IS RE-DERIVED, BECAUSE ITS RUNGS WERE CALIBRATED AGAINST THE DEFECT

`EXIT_RETRY.BOUND_BPS` was `[300, 400, 1835, 6070]` — the shortfall quantiles under the
OLD quote. Re-measured under the corrected quote over the 14 of 39 trades whose bound
still misses:

```
p25 449 bps   median 608 bps   p75 1,343 bps   p90 6,067 bps   max 8,445 bps
```

The ladder is now **`[300, 449, 608, 1343]`**. It still stops at the p75, and that rule
is now sharper rather than weaker: the p75 of 13.4% sits just BELOW the recent-era
median gross return of +16%, where the old p75 of 60.7% was four times above it. **The
last rung is for the first time an economically coherent rescue rather than a pure
damage limit.**

### THIRD DRY RUN — 2026-09-16, 95 minutes, live launches

The first run under the +90 s horizon, the corrected quote and the re-derived ladder.

```
ticks 1,108   initializes 658   candidates 516   qualified 34
simulated 34  simClean 23   simReverted 11        skippedRail 0
exitClean 8   exitReverted 26   exitNotAttempted 0
quoteRefused 0   quoteReadFailed 0
quoteBasis  fee-only 32   fee+impact 2
156,872 CU = $0.07059     exit_delay_blocks 900 (the new +90 s)
```

**THE RAIL DID NOT CAP THE SAMPLE. `skippedRail: 0`**, against 19 blocked launches in
run 2. The run used mode `dry-run-r3` so `MAX_TRADES_PER_DAY` counted its own budget,
which is the remedy section 7 had recorded and rule 3 made a defect in the code. **34
trades over 95 minutes is a full run, not a truncated one**, and it reached 34 of its
40-trade budget without touching it.

#### THE REVERT RATE DID NOT MOVE, EXACTLY AS THE QUOTE CHECK PREDICTED

| run | horizon | quote | n | reverted | rate |
|---|---|---|---|---|---|
| 1 | +30 s | linear | 24 | 7 | **29.2%** |
| 2 | +30 s | linear | 16 | 5 | **31.3%** |
| **3** | **+90 s** | **fee + impact** | **34** | **11** | **32.4%** |

**The quote fix did not move the revert rate**, which `quote-check` predicted before the
run — 4 of 11 recorded reverts would clear under either quote. The prediction holding is
worth as much as the number: the offline measurement and the live run agree.

**THE CAUSE IS UNCHANGED AND IS STILL OURS.** Decoding all 23 reverts across the three
runs: **18 `V4TooLittleReceived` — our own bound — and 5 bare reverts with no payload.**
The shortfall distribution across all of them is min 1.015, p25 1.092, median 1.199,
p75 2.543, p90 13.70.

**By fee tier, run 3:**

| fee | n | entry clean | entry revert | exit clean |
|---|---|---|---|---|
| 500 | 22 | 18 | 4 (18%) | 8 |
| 10000 | 10 | 5 | **5 (50%)** | **0** |
| 100 | 2 | 0 | **2 (100%)** | 0 |

The 1% tier reverts at 50% against the 0.05% tier's 18%, and **not one of its ten
exits simulated clean**. That is a tier-level split the allow-list does not make, and it
is n=10 — recorded as something to watch, not acted on.

#### THE IMPACT TERM IS NEARLY DEAD IN THE LIVE LOOP

**`fee-only 32, fee+impact 2`.** At the entry moment — +15 s after a pool's first swap —
almost no pool has the four consecutive swaps the impact median needs. The term that
took the most work is active on **6% of trades**, and the exact fee term carries
essentially all of the correction in practice. It is kept because the 2 where it did
fire are exactly the pools where our size is the problem, and because one historical
pool measured a 47.4% impact — but its practical contribution is near zero and saying so
is more useful than the effort implies.

`quoteRefused: 0` and `quoteReadFailed: 0` — the refusal paths did not fire at all, so
they remain untested against live data.

#### THE EXIT LEG GOT WORSE, NOT BETTER: 26 OF 34 REVERTED

Against run 2's 14 of 16. Section 6 already establishes that this figure is dominated by
the borrowed fixture's approvals rather than by the pool — 9 of run 2's 14 had neither
approval — and nothing in this run changes that confound. **It is not evidence the exit
is failing more; it is the same unmeasurable quantity measured again on a larger sample.**

#### THE EXIT GRID AT THE NEW +90 s HORIZON

`nightly-check`, over all 71 trades with a full window elapsed, exit-availability beside
every median as required:

| horizon | n | exit found | median | % positive |
|---|---|---|---|---|
| +15 s | 71 | 64 | 0.209 | 88.7% |
| +30 s (the OLD rule) | 71 | 63 | 0.258 | 87.3% |
| +45 s | 71 | 62 | 0.317 | 87.3% |
| +60 s | 71 | 61 | 0.337 | 85.9% |
| **+90 s (CONFIGURED)** | 71 | **60** | **0.374** | 84.5% |
| +120 s | 71 | 59 | 0.410 | 83.1% |
| +180 s | 71 | 55 | 0.606 | 77.5% |
| +300 s | 71 | 43 | 0.646 | 59.2% |
| +450 s | 71 | 41 | **0.710** | 56.3% |
| +600 s | 71 | 25 | **0.000** | 35.2% |

**The change is vindicated on the bot's own trades: +90 s (0.374) against the old
+30 s (0.258).** Exit-availability falls only 63 → 60 across that move, so the gain is
not bought by giving up the ability to sell.

**The nightly check did NOT alert**, and both thresholds are why: the margin to the best
cell (+450 s) is 0.336 and material against the 0.25 threshold, but the sample is 71
against a 140 minimum. **A material margin on an insufficient sample is exactly the case
the minimum exists for**, and it is the first time both conditions have been exercised in
opposite directions on one run.

The +450 s peak here disagrees with the offline holdout, where +450 s is **exactly
0.00000 in every window and both halves**. 71 trades from one afternoon do not overturn
12,624 holdout launches, and the disagreement is recorded rather than resolved.

#### THE FULL ROUND TRIP, ON A $10 POSITION

| component | cost | provenance |
|---|---|---|
| LP fee, both legs | **$0.0654** | run 3's own fee mix, weighted: 0.654% round trip |
| slippage, both legs | ~$0.026 | 0.26% at $10, measured from realised impact (SELLOFF) |
| gas: buy + sell | $0.071–$0.084 | 200 real receipts per era |
| gas: two approvals | $0.015 | ERC-20 → Permit2 and Permit2 → router, $0.00751 each |
| RPC, per trade | $0.0021 | 156,872 CU / 34 trades |
| **total** | **$0.179 – $0.192** | **1.8%–1.9% of a $10 position** |

**Costs are not the binding constraint.** Against a median gross of +0.374 at +90 s on
the bot's own trades, or +0.157–0.180 in the recent-era holdout, a 1.9% round trip is
noise. **The binding constraints are the 32.4% revert rate and exit availability**, not
the money a completed trade costs.

**RPC for the run: 156,872 CU = $0.07059 for 95 minutes = $1.07/day**, consistent with
run 1's $1.11/day. The per-candidate tick read the corrected quote needs did not move it
materially, because it is charged only on the 34 qualifying launches rather than on all
516 candidates.

#### `/trades` ANNOUNCED LIVE TRADES OVER A DRY RUN, AND MY VERIFIER PASSED IT

The run label introduced mode `dry-run-r3`. The page's dry-run test was
`mode === 'dry-run'`, an exact string match, so 34 hypothetical rows were banded
**"THIS PAGE CONTAINS LIVE TRADES"** and chipped red. The banner exists for exactly one
reason — so nobody reads a dry run as real money a week later — and it said the opposite.

**The verifier passed it, which is the worse half.** It asserted the banner *states a
mode*, not that it states the *correct* one: presence rather than truth. It now fails
when every row is a dry-run mode and the banner claims live, and when any dry-run row is
chipped live. Both checks were confirmed to FAIL against the unfixed page before the fix
deployed, so they are known to be able to fail.

`isDryRunMode` is the one predicate, used by the banner, the totals blocks and the row
chips, so those three cannot disagree. Re-verified in a DOM after the fix: **74 rendered
= 74 claimed, 2 mode blocks never summed, 17 of 17 checks pass.**

#### A BUILD THAT NEVER STARTED, AND THE DEPLOYMENT LIST IS WHAT FOUND IT

The push carrying the banner fix was rejected once with `remote: fatal error in
commit_refs`, landed on retry — and **started no build**. `git ls-remote` showed the
commit on the remote while the container sat on its predecessor for eight minutes.
`ROBINHOOD.md` says to check the deployment list at ~3x rather than wait; the list's
newest entry named the previous commit, so nothing was building. An empty commit
re-triggered it and it deployed in under two minutes. **A webhook that did not fire and
a slow build are indistinguishable from inside the container.**

#### A CONTAINER REPLACEMENT DESTROYED THE FIRST ATTEMPT AT THIS RUN

The 95-minute run was launched, and 13 seconds later the container was replaced —
deployment `cfec4c06` → `20559cbc`, pid 1 restarting at 18:38:03 — taking the process
and `/app/run3.log` with it. I had polled for a *new* deployment id and launched against
the first one that appeared, which was itself about to be superseded. `ROBINHOOD.md`
records this exact shape: *a check that read the top row passed against the previous
deployment because the new one did not exist yet.*

**The relaunch waited for the id to be STABLE across three reads sixty seconds apart,
and confirmed `RAILWAY_GIT_COMMIT_SHA` equalled local HEAD and that the built files
carried `EXIT_DELAY_BLOCKS = 90` and `BOUND_BPS: [300, 449, 608, 1343]`** before
starting. Cost of the lost attempt: about 25 seconds of compute units.

### CATEGORY A CLOSED — 2026-09-16

The four items that "would lose money on the first live trade". Each is implemented and
each is EXERCISED, because this document's own standard is that a path nobody has run is
not a path.

#### 1. `needs_exit` IS ACTED ON, AT BOOT, BEFORE ARMING

`clearNeedsExit` runs after reconciliation and before the loop starts, which is section
2 rule 3 stated exactly: *a position whose buy landed and whose sell did not is exited
immediately at boot, before the bot arms itself for new launches.*

- **The amount sold is the balance read from the chain**, never the stored quote. A
  quote is what we expected; a balance is what is there.
- **A position that cannot be exited HALTS THE BOT AND RAISES.** It does not return a
  status a caller may ignore, and the bot does not arm. Rule 4: one stuck position is
  bad, one stuck position plus a bot opening more is what the rule exists to prevent.
- **A row whose balance is now zero is resolved, not exited.** The chain saying the
  position is gone is resolution.

**PROVED IN THE REAL BOOT PATH, NOT A DRILL.** `seed-stuck` seeded one `needs_exit` row
from a fixture whose premise was measured first — a pool whose exit had already
simulated clean, attributed to that trade's own holder, whose balance was read and
confirmed non-zero before the row was written. Then `launchbot` was started normally:

```
BOOT: STUCK POSITIONS FOUND — EXITING BEFORE ARMING   found 1
  attempt 1 @300bps   V4TooLittleReceived bound=1445157297157294 actual=0
  attempt 2 @449bps   V4TooLittleReceived bound=1422958489190651 actual=0
  attempt 3 @608bps   V4TooLittleReceived bound=1399269828340341 actual=0
  attempt 4 @1343bps  V4TooLittleReceived bound=1289765641390793 actual=0
launchbot failed: BOOT EXIT EXHAUSTED on trade 132. THE POSITION IS STILL OPEN
                  and the bot has NOT armed.
```

**`actual = 0` at every rung — the pool pays nothing**, so no bound could rescue it. The
ladder exhausted, halted the chain, and refused to arm. All four attempts were read back
from `bot_exit_attempts` afterwards, which is the proof each was persisted *before* the
next began rather than flushed at the end.

**The fixture is the same lesson the drill's live half found: a retry ladder rescues a
mispriced quote, not a dead pool.** The fixture was resolved to `closed_unsellable` with
that reason recorded, and the halt it correctly set was cleared with counts reconciled
before and after.

#### 2. THE LADDER IS WIRED INTO THE LOOP

The loop no longer simulates the exit at entry time. **A clean buy OPENS a position**
carrying an `exit_due_block`, and **every tick closes each position whose horizon has
arrived — before looking for new launches**, because an open position is money at risk
and a launch nobody has seen yet is not.

`--force-exit-optimism` is the deliberate test control: it inflates the exit re-quote so
the early rungs must miss and the ladder must climb. It cannot affect a live path because
there is no live path.

#### 3. THE EXIT RE-QUOTES AT EXIT TIME

`src/bot/exit-exec.ts` is **the one exit executor**, used by the boot path and the loop
alike. Every attempt re-reads the pool's swaps up to NOW and calls `bot/quote.ts` again.

The old bound came from the ENTRY quote. On a pool whose median move over the horizon is
+37% (`nightly-check`, 71 trades) that is a bound computed for a price that will not
exist by the time we sell — and the entry quote is itself the one measured to over-quote
by 2–3%. **Selling at +90 s against a +0 s bound is not a measurement of the exit.**

Re-quoting per attempt is also the ladder's own contract: `exitWithRetry` states that a
retry resubmitting the same calldata against the same bound is one attempt logged four
times.

#### 4. THE WALLET IS AN ADDRESS AND A BALANCE READ FROM THE CHAIN

`src/bot/wallet.ts`. **No private key is read, here or anywhere**, and this adds no
signing path — `eth_getBalance` is a read and `ReadOnlyRpc` still refuses every signing
and broadcast method by name.

The gate is `MAX_CONCURRENT × MAX_POSITION_USD` = **$50** — the most the rails will ever
let be at risk at once. Arming below it means a rail meant to bound exposure is instead
bounded by running out of money, and that surfaces as a reverting broadcast rather than
as a refusal. **An unreadable balance refuses too** — never zero, never sufficient.

**THE REFUSAL IS EXERCISED, NOT JUST WRITTEN.** Against an address read and confirmed
empty first:

```
WALLET BALANCE, READ FROM THE CHAIN
   address 0x9f3c7a1b5e2d8046ac71fe3092bd45a6c8e10d77
   balance_wei 0   balance_eth 0   eth_usd 2409.95   balance_usd 0
   required_usd 50   can_arm FALSE
REFUSING TO ARM — BALANCE BELOW WHAT THE RAILS CAN PUT AT RISK
process exit code 3   —  and "launchbot starting" never printed
```

And the read path proved against funded addresses: `0x…0001` read **4.611062044573074
ETH = $11,112.43** and the v4 PoolManager read **20,337.86 ETH = $49,013,249.51**, both
at an ETH/USD of 2,409.95 taken from the chain's own series.

**THE OPERATOR'S WALLET IS STILL UNREAD, and that is the honest state.** No address was
supplied, so the "~$24" in section 0 remains a statement rather than a measurement. What
is now true is that the mechanism exists and works: point `BOT_WALLET_ADDRESS` at the
real address and the balance is read and gated. **At $24 against a $50 requirement, the
bot as configured would REFUSE TO ARM** — which is worth knowing before anyone tries.

#### A DEFECT THIS WORK INTRODUCED AND THE CHECK THAT CAUGHT IT

**The edit that replaced the old exit-simulation block DELETED the `insert into
bot_trades` that sat inside the replaced range.** The loop then ran for nine minutes
logging four `WOULD TRADE` lines over an **empty table**, with no error anywhere because
nothing threw.

This is `ROBINHOOD.md` step 12's worst recorded failure in miniature — a write that
reported "3,200 rows stored" against an empty table — and it was caught the same way and
by nothing else: **querying on a separate connection instead of believing the log.**

Two things changed. The insert checks `rowCount` rather than assuming, and **the run now
reconciles against the database on a fresh connection before it reports**: a run that
simulated trades and stored zero rows RAISES instead of printing a summary.

#### `RpcClient` DISCARDED THE REVERT PAYLOAD, MAKING A DECODE BRANCH UNREACHABLE

`RpcError` kept only `error.message` — for a custom error, the uninformative string
`execution reverted`. Every exit attempt was recorded as that while the chain had said
exactly which error and with what arguments, and the `V4TooLittleReceived` decode branch
in `exit-exec.ts` **could never fire**. `revert-decode` had already worked around it by
going to the transport directly, which is the tell that should have been read earlier.

`RpcError` now carries `data`. The boot-exit output above — `bound=… actual=0` — is that
fix, and an unreachable branch became a reachable one.

### FOURTH DRY RUN — 2026-09-16, 95 minutes, the first with a real exit lifecycle

The first run where a position is OPENED at entry and CLOSED later at its own horizon,
with the bound re-quoted at exit time and the ladder in the live path.

```
ticks 1,109   initializes 553   candidates 443   qualified 32
simulated 32  simClean 19   simReverted 13       skippedRail 0
exitsDue 19   exitClean 10  exitReverted 7       exitNotAttempted 2
ladderFired 8  ladderExhausted 7   ladderRungs {1: 9, 2: 1}
quoteRefused 0  quoteReadFailed 0  rowsNotStored 0  quoteBasis {fee-only: 32}
158,235 CU = $0.07121        exit_delay_blocks 900
VERIFIED ON A FRESH CONNECTION: simulated 32, rows stored 32
```

#### THE EXIT REVERT RATE, FRESH QUOTE AGAINST THE STALE-QUOTE BASELINE

| | stale quote (entry-time bound) | **fresh quote (re-quoted at exit)** |
|---|---|---|
| clean | 2 | **10** |
| reverted | 5 | **7** |
| clean share | 28.6% | **58.8%** |

**n=7 ON THE BASELINE IS FAR TOO SMALL TO CONCLUDE FROM, and that is not a formality.**
The baseline is the 7 run-2 fixtures that held both approvals, out of 14 reverts — the
rest were the borrowed wallet having granted none. Two clean against five reverted is
seven observations. A doubling of the clean share against a denominator of seven is
consistent with the fix working and equally consistent with noise, and nothing in this
run distinguishes them.

What can be said without a denominator argument: **the exit is no longer bounded by a
price that no longer exists**, which was true by construction before and is not now.

#### THE LADDER FIRED FROM INSIDE THE LOOP, AND RESCUED EXACTLY ONE EXIT

Read from `bot_exit_attempts` rather than from the counter:

| rung | bound | exits it cleared |
|---|---|---|
| 1 | 300 bps | 9 |
| **2** | **449 bps** | **1** |
| 3 | 608 bps | 0 |
| 4 | 1,343 bps | 0 |

**39 attempts across 17 trades, 10 of them successful, 5 with a decoded
`V4TooLittleReceived` payload.** The ladder fired 8 times — seven exhausted and **one
rescued at rung 2** — so on this run it converted one exit that the configured bound
missed into a fill, and could not save the other seven.

**Seven exhausted is the number to carry forward, not the one rescue.** The drill and
the boot fixture both found the same thing: where the pool pays nothing, no rung helps.

#### THE ENTRY REVERT RATE WENT UP, AND IT IS NOT THE TIER MIX

| run | horizon | quote | exit | n | reverted | rate |
|---|---|---|---|---|---|---|
| 1 | +30 s | linear | at entry | 24 | 7 | 29.2% |
| 2 | +30 s | linear | at entry | 16 | 5 | 31.3% |
| 3 | +90 s | fee+impact | at entry | 34 | 11 | 32.4% |
| **4** | **+90 s** | **fee+impact** | **re-quoted at +90 s** | **32** | **13** | **40.6%** |

**Nothing in this pass touched the ENTRY path**, so the rise is not caused by the exit
work. It is also not a tier-composition effect — the rate is flat across tiers this run:
fee 500 at 38.9% (7 of 18), fee 10000 at 38.5% (5 of 13), fee 100 at 100% (1 of 1).

On n=32 against n=34 the difference between 32.4% and 40.6% is within what these runs
have already shown between each other, and the residual over-quote that causes these
reverts is still bounded and unidentified. **It is recorded as unexplained rather than
attributed to this pass's changes.**

#### `needs_exit` ROWS CREATED AND RESOLVED

```
run 5's own boot            found 0   exited 0     (a fresh mode has no history)
seeded fixture              created 1  resolved 1  (closed_unsellable, pool pays 0)
in-loop exhausted exits     7 -> now marked needs_exit for the NEXT boot to retry
```

**The seven exhausted exits exposed a real defect in this pass's own work.** They were
first written as `exit_exhausted`, which is **not in `NON_TERMINAL`** — so the next boot
would never have looked at them again, and a position the ladder failed to sell would
have been quietly forgotten by the one routine written to find exactly that. They are
now `needs_exit`, which is the state the boot sweep exists for, and a position the ladder
could not clear now is precisely one to retry when the pool has moved.

#### THE WALLET ON THIS RUN

`BOT_WALLET_ADDRESS` was unset, so the run logged **NO WALLET CONFIGURED** and proceeded
— which a dry run may do because it holds nothing and broadcasts nothing. The balance
was **UNREAD rather than assumed**. The gate itself was exercised separately and in both
directions; see category A above.

#### THE IMPACT TERM DID NOT FIRE ONCE

`quoteBasis {fee-only: 32}` — zero of 32 quotes had the four consecutive swaps the
impact median needs, against 2 of 34 last run. **Across 66 live trades the impact term
has now fired twice.** The exact fee term carries the entire correction in practice.

### THE WALLET ADDRESS WAS WRONG, AND EVERY FIGURE TAKEN AGAINST IT WAS TRUE OF NOBODY — 2026-09-16

**The address this document carried, `0x4Cc7aF1CB1D0d12b0DDaD35b39f00ea28e0F0d4A`, was
not the operator's.** It was a placeholder that reached section 0 as though it had been
supplied, and everything measured against it — `native 0 wei, WETH 0, USDG 0, nonce 0`,
the refusal to arm, the conclusion that *"the ~$24 the operator stated is not on this
chain at this address"* — was a correct reading of an address nobody owns. The real
address is **`0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a`**.

**THIS IS THE FABRICATED-CONSTANT FAILURE FOR THE THIRD TIME ON THIS PROJECT, AND THE
SECOND TIME WITH AN ADDRESS.** `ROBINHOOD.md` records a made-up `Transfer` topic hash
that matched zero logs across 100,000 blocks and read as a clean sweep; section 6 above
records a launchpad address whose last twenty-eight characters were invented and which
rejected every launch as "not in the list". **A wrong address does not error. It returns
a perfectly well-formed answer about somewhere else**, and here that answer was zero —
the single most plausible value a wallet can hold, and the one this document had already
built a whole refusal path around.

**WHAT THE CONTROL READ DID AND DID NOT BUY.** The previous read was careful in the way
this project asks for: it proved the READER worked, by reading the PoolManager through the
same path and getting 20,097 ETH. That check was sound and it passed, and it could never
have caught this — **a control proves the instrument, not the subject.** Nothing in a
balance read can tell you that you are pointed at the wrong wallet, and the only thing
that would have is the operator reading the address back, which is what happened.

**THE `nonce 0` WAS THE TELL AND IT WAS READ THE WRONG WAY ROUND.** The old address had
never transacted on this chain, and that was written down as *"unused rather than drained,
which points at another chain, another address, or funds not yet moved"* — the right list
of possibilities with the likeliest one, *another address*, treated as an aside. **The
real wallet has nonce 130.** An address the operator uses has a transaction history; an
address with none is more likely to be the wrong address than an untouched one.

#### WHAT IT ACTUALLY HOLDS

```
npm run wallet-probe -- --address 0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a
516 CU = $0.00023

chainId       0x1237 = 4663, CONFIRMED BEFORE ANY BALANCE WAS READ
native        52,569,197,952,034,720 wei = 0.05256919795203472 ETH
              x $2,410.735 (native_usd_prices, the chain's own series) = $126.73
WETH          0
USDG          0.000001   <- ONE raw unit of a 6-decimal token. Dust, and it is
                            reported rather than rounded away: a null and a zero
                            and a dust balance are three different facts.
nonce         130        <- it HAS transacted on this chain
code          0x         -> plain EOA
CONTROL, same path, v4 PoolManager: 19,964.71 ETH, 1,757.92 WETH, 42,536,952.25 USDG
```

**THE OPERATOR'S STATED "~$24" IS STILL NOT WHAT IS THERE, and it is now wrong in the
other direction** — $126.73 against ~$24. That figure has never been a measurement and is
not treated as one; the chain is the authority and the chain says $126.73.

#### THE READ NOW HAS CODE BEHIND IT, WHICH IT DID NOT BEFORE

**`readWalletState` reads the native balance and nothing else.** The WETH, USDG, nonce and
code figures section 0 carried came from queries typed by hand at the time and were not
reproducible from anything in the repository — which is how a wrong address survives in a
document: there is nothing to re-run. `npm run wallet-probe` is now the committed path,
it performs the control read every time rather than only when the answer is inconvenient,
and it finishes by calling **the real `readWalletState`** so the arming verdict is not a
second implementation of the gate.

**`balanceOf`'s selector is COMPUTED with keccak, not typed.** Four bytes feel too small
to get wrong, and a wrong selector returns `0x` — which is exactly the value this file
exists to distinguish from a real zero.

#### ARMING, AGAINST BOTH LIMITS

| | | |
|---|---|---|
| balance | **$126.73** | read from the chain |
| MAX_CONCURRENT 5 x $10 | $50 required | **PASSES**, 2.5x over |
| MAX_DEPLOYED_USD | $100 cap | **PASSES**, the balance covers the whole cap |

**THE ALLOW DIRECTION OF THE ARMING GATE HAD NEVER RUN, AND NOW HAS.** Every previous boot
either had no wallet configured or refused with exit code 3, so the gate was proved in one
direction only — and this document's own standard is that a rail tested in one direction
is half a rail. Booted on the real address as mode `dry-run-capgate`:

```
WALLET BALANCE, READ FROM THE CHAIN  balance_usd 126.73  required_usd 50
                                     can_arm TRUE  max_deployed_usd 100  covers_cap TRUE
launchbot starting  mode dry-run-capgate   <- the line that never printed before
12 ticks, 9 initializes, 9 candidates, 0 qualified, 1,645 CU = $0.00074 for 1 minute
VERIFIED ON A FRESH CONNECTION: simulated 0, rows in this mode 0, rows_not_stored 0
```

**Zero qualified in a minute is the rule being selective, not a fault** — run 4 qualified
32 of 443 candidates over 95 minutes, and nine candidates is well inside the gap.

### THE SEVEN STRANDED ROWS ARE MIGRATED — 2026-09-16

`npm run migrate-stuck-status -- --commit`. The seven `exit_exhausted` rows now carry
`needs_exit`, the status `clearNeedsExit` actually reads, so the positions the exit ladder
could not sell are for the first time visible to the routine written to find them.

**THE DRY RUN PREDICTED THE BOOT OUTCOME, NOT JUST THE ROW COUNT, AND THAT IS THE POINT OF
IT.** "Seven rows updated" is not the consequence anybody cares about: a `needs_exit` row
is acted on at the next boot of its mode, before arming, and a row that cannot be exited
calls `halt()` — **which is keyed on CHAIN, so it would stop every mode on `robinhood`,
not just the one that failed.** These are precisely the rows whose ladder has already
exhausted once, so that was not a remote possibility and was worth reading the chain for.
The holder balance is read from the chain because that is what `clearNeedsExit` will read;
predicting from the row would be predicting our own record rather than its adjudicator.

```
rows                          7, all in mode dry-run-r5, $70 of cost basis
  will resolve without an exit   6   holder balance 0 -> closed_unfilled at boot
  will climb the ladder          1   trade 137, holder still holds 8.9e23 raw
  will halt immediately          0   every row carries an exit_sim_from
182 CU = $0.00008 to establish it
```

**SIX OF SEVEN HOLDERS HAVE SINCE SOLD, and that is why the migration is cheap rather
than dangerous.** The exit was always simulated from a BORROWED holder — the pool's first
swap sender — and most of them have moved on, so the chain will resolve those six as gone
rather than attempting anything. Only trade 137's holder still holds.

**The counts, stated before the write and reconciled after it on a fresh connection:**

| | before | expected | after, fresh connection |
|---|---|---|---|
| `exit_exhausted` | 7 | **0** | **0** |
| `needs_exit` | **0** — reported, not omitted | 7 | **7** |
| `bot_trades` total | 107 | 107 unchanged | **107** |
| `bot_control` (the kill switch) | — | untouched | **RETURNED NO ROWS** |

The update is scoped to `status` alone, **checks `rowCount` against the dry-run count and
rolls back on any mismatch** rather than adjusting the figure to fit, and an independent
process confirmed afterwards that all seven carry `needs_exit`, all seven carry a holder
address, and none carries `exit_exhausted`.

**THE DOCUMENT IS NOW TRUE WHERE IT WAS NOT.** Section 6 above asserted these rows "are
now `needs_exit`" on the strength of a code change; they were not, until this ran.

### THE HARD CAPITAL CAP, AND IT IS EXERCISED — 2026-09-16

`MAX_DEPLOYED_USD = 100`. The specification, the quantity it bounds and the reasoning are
in section 4; this is what running it proved.

**IT EXISTS BECAUSE THE BALANCE GATE HAS NO UPPER SIDE.** The wallet reads $126.73 today
and the gate's whole question is whether it covers $50. **Nothing in the bot bounded the
other direction** — the "$100 capital approved" line in section 0 was a sentence in a
document, enforced by no code, and a wallet that grew to $5,000 would have passed the same
gate with a factor of a hundred to spare. This is the operator's personal wallet and the
bot is entitled to a stated amount of it, not to whatever happens to be in it.

**IT CANNOT BIND ON THE LIVE PATH TODAY AND THAT IS STATED UP FRONT.** `MAX_CONCURRENT 5 x
$10 = $50` of open basis plus `MAX_DAILY_LOSS_USD $15` caps deployed capital at **$65**,
so one of those two fires first every time. **The cap is a backstop against those being
raised** — which makes it precisely the kind of rail that gets written wrong and never
noticed, and precisely the kind this document says must be tripped deliberately.

#### THE DRILL: 26 of 26, AND TEN OF THEM ARE THE NEW RAIL

`npm run rail-drill -- --commit`, **26 of 26**, on `chain='drill'` so nothing it does can
touch the live dry run. **Every cap case holds FOUR positions, one below `MAX_CONCURRENT`, so the cap is
the only rail that can fire** — otherwise a case would pass its BLOCK expectation while
testing concurrency. The cap admits while `deployed + $10 <= $100`, so $90 deployed is the
last admissible state:

```
PASS  $85 deployed (one below)                                    ALLOW
PASS  $90 deployed (the LAST admissible trade)                    ALLOW
PASS  $91 deployed (at the rail)                                  BLOCK
        MAX_DEPLOYED_USD: $91.00 deployed (open basis $91.00 + realised losses $0.00)
                          + $10 = $101.00 > $100
PASS  $79 open + $11 of realised losses = $90                     ALLOW
PASS  $80 open + $11 of realised losses = $91                     BLOCK   <- THE LOSS TERM
PASS  $91 deployed WITH a +$50 profitable day                     BLOCK   <- NO HEADROOM
PASS  an open position with a NULL position_usd                   BLOCK   <- UNKNOWN
        MAX_DEPLOYED_USD: deployed capital is UNKNOWN -- 1 open position(s) carry a
                          null position_usd, which sum() would silently treat as $0
PASS  $91 of 'needs_exit' positions, MAX_CONCURRENT seeing 0     BLOCK
PASS  $91 of 'exit_exhausted' positions, same                    BLOCK
```

**THE LOSS CASES USE $11, WHICH IS BELOW `MAX_DAILY_LOSS_USD`'S $15, DELIBERATELY.** A
$31 loss would have breached the cap and the daily-loss rail together, and the case would
have passed its expectation while proving nothing about which rail fired. Choosing the
loss so that only one rail can fire is what makes it a test of the loss TERM rather than
of the loss RAIL.

**THE PROFIT CASE IS NOT DECORATION, FOR THE SAME REASON THE DAILY-LOSS DRILL'S IS NOT.**
`max(0, −pnl)` and `−pnl` differ only on a profitable day, and the wrong one hands a bot
that made $50 in the morning an extra $50 of the operator's wallet in the afternoon.

**THE NULL CASE IS THE ONE THAT WOULD HAVE SHIPPED SILENTLY.** `sum(position_usd)` skips a
null, so an open position of unknown size contributes $0 and the cap reports headroom it
does not have. That is this project's most-recorded failure shape — the `balanceOf` reader
that turned 490 HTTP 429s into plausible zero balances — arriving inside the rail written
to prevent over-exposure. It is counted separately and refuses.

#### HALT OR SKIP: THE TWO TERMS BEHAVE DIFFERENTLY AND THE RAIL SAYS SO

A breached cap is not one condition. **Open basis clears by itself** — positions close,
deployed falls, the next launch is admissible — so that SKIPS, like concurrency.
**Realised losses never fall within a day**, so if the loss term alone leaves no room,
every further candidate for hours would re-run the same refusal; that HALTS, exactly as
`MAX_DAILY_LOSS_USD` does. An unknown basis halts too: it is a defect in stored state, not
a capacity condition. `deployedCapIsTerminal` is the one place that distinction lives, and
it was exercised as a pure function because the halting branch needs $90 of losses, which
`MAX_DAILY_LOSS_USD` makes unreachable through the database:

```
PASS  cap breached by OPEN BASIS alone           halts=false   deployed $100.00
PASS  cap breached with an $11 loss              halts=false   deployed $111.00
PASS  LOSSES ALONE leave no room ($100 lost)     halts=TRUE
PASS  an UNKNOWN basis                           halts=TRUE
```

#### WHAT THE DRILL CHANGED IN ITSELF

**Its `seed()` wrote every row with a NULL `position_usd`**, which was harmless until the
cap existed and then made *every* case block on "deployed is UNKNOWN" — so the
`MAX_CONCURRENT at 5` case would have gone on passing its BLOCK expectation while
testing the wrong rail entirely. **A case that blocks for the wrong reason passes.** Open
rows now carry a real basis unless the case is specifically about its absence.

**Cleanup verified from a SEPARATE PROCESS on a fresh connection**, not from the drill's
own report: `bot_trades` on `chain='drill'` **0**, `bot_control` **0**. And on the live
chain, **0 open rows and 0 open rows with a null `position_usd`** — so the new unknown-basis
branch cannot block the running dry run.

#### RE-AUDITING THE CAP FOUND A HOLE IN IT, AND THE DOCUMENT WAS WRONG ABOUT THE STORE

**The first version of the cap summed `position_usd` over `NON_TERMINAL`, and a position
the exit ladder COULD NOT SELL is not in that set.** `NON_TERMINAL` answers "what must
boot reconciliation resolve"; the cap asks a different question — *what is our money still
in* — and a stuck position is the clearest possible yes to the second while sitting
outside the first. **It is the worst kind of deployed capital, not the least**: money in a
token nothing has managed to sell. The cap would have read **$0 deployed** over it.

**AND `exit_exhausted` IS WORSE THAN `needs_exit`, BECAUSE NOTHING SWEEPS IT AT ALL.**
Section 6 above records the fix that replaced it: *"They were first written as
`exit_exhausted`, which is not in `NON_TERMINAL` — so the next boot would never have
looked at them again … They are now `needs_exit`."* **The code changed and the seven rows
did not.** Read from the store on 2026-09-16:

```
status                  n  with_basis  with_pnl   sum(position_usd)
simulated              51     51          0             510
sim_reverted           36     36          0             360
closed                 10     10          0             100
exit_exhausted          7      7          0              70   <- the seven
closed_unsimulatable    2      2          0              20
closed_unsellable       1      1          0              10
```

**Seven positions the ladder could not sell are, right now, in a status no set contains** —
not `NON_TERMINAL`, so boot reconciliation never examines them; not `needs_exit`, so
`clearNeedsExit` never sweeps them. This document asserted they had been migrated. They
had not. `ROBINHOOD.md`'s rule applies exactly: **a claim about stored state has to be
re-checked against the store whenever the store changes**, and "they are now `needs_exit`"
was a description of a code change written as though it were a description of data.

**The cap now uses a new `HELD` set** — `NON_TERMINAL` plus `needs_exit` and
`exit_exhausted` — and the drill guards it in the shape that would have hidden the hole:
`$91` of stuck positions **with `MAX_CONCURRENT` seeing 0 open**. Under the old set every
one of those cases would have returned ALLOW.

**`MAX_CONCURRENT` STILL USES THE NARROWER SET AND WAS DELIBERATELY NOT CHANGED.**
Widening a rail that has already been exercised changes what that rail means, and that is
an operator's decision rather than a side effect of adding a different one. It is carried
as open in section 7.

**THE THIRD THING THE STORE SAID: `net_pnl_usd` IS NULL ON ALL 107 ROWS.** No dry run has
ever realised a PnL, so the cap's loss term — and `MAX_DAILY_LOSS_USD` with it — reads
exactly $0 on live data no matter what happened. Both are exercised only in the drill.
That is expected for a dry run and it means **the loss half of the cap has never been
measured against anything real**, which is stated rather than left for someone to assume
from a passing drill.

## 7. Rules here the code does not implement

**CATEGORY A IS NOW CLOSED IN FULL, 2026-09-16.** Section 6 records each with the
evidence. Closing it does not make the bot live: there is still no signing path, no
private key is read anywhere, and every figure in this document is a simulation — see
category C.

### A. Would lose money on the first live trade

- ~~No code path sells a `needs_exit` row~~ — **CLOSED.** `clearNeedsExit` runs at boot
  before arming; a position it cannot clear halts and raises. Proved in the real boot
  path against a seeded, measured fixture.
- ~~The retry ladder is not wired into the loop~~ — **CLOSED.** It fired 8 times in run
  5 and rescued one exit at rung 2.
- ~~The exit's `minOut` comes from the entry quote~~ — **CLOSED.** Every attempt
  re-quotes from the pool's state at exit time, through the one executor the boot path
  also uses.
- ~~The wallet is empty~~ — **CLOSED, AND IT WAS THE WRONG ADDRESS.** The address this
  document carried was a placeholder, not the operator's; the real one is
  `0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a` and it holds **$126.73** —
  0.05256919795203472 ETH, nonce 130, plain EOA, chainId 4663 confirmed, with a control
  read on the same path. **Arming passes against both limits**, the $50 requirement and
  the $100 cap, and the boot path armed for the first time. The earlier "0 wei, nonce 0"
  was a correct reading of an address nobody owns — see section 6.
- **NEW, AND CLOSED IN THE SAME PASS — nothing bounded total exposure.**
  `MAX_DEPLOYED_USD = 100` now does, enforced in `bot/rails.ts` over the cost basis of
  open positions plus the day's realised losses, and exercised in both directions
  including the loss term, the profit case and an unknown basis. **It cannot bind under
  today's other rails** — they cap deployed capital at $65 — so it is a backstop, which
  is why it was tripped deliberately rather than waited for.

### B. Unmeasured, so no figure here is a profit figure

- **A 2–3% RESIDUAL OVER-QUOTE IS BOUNDED AND NOT IDENTIFIED**, and it is still the
  revert mechanism: our 300 bps bound sits on top of it. The entry revert rate has now
  run 29.2 / 31.3 / 32.4 / **40.6%** across four runs with no identified cause for the
  spread.
- **The exit's success rate is measured on 17 attempts**, 10 clean. Better than the
  stale-quote baseline's 2 of 7, and both samples are too small to separate the fix from
  noise.
- **`gas_usd` is null on every row.** The round trip is costed from external
  measurements, never from this bot's own trades.
- **`fill_status` is always the literal `dry-run`.** Nothing models winning the fill
  against competing buyers in the same block.
- **Every exit is still simulated from a BORROWED holder.** In dry run we hold nothing,
  so a clean exit proves the pool accepts the sell and not that our approvals would
  permit it. Two setup transactions are measured in section 2; neither has been executed.

### C. Paths that exist and have never executed

- **The impact term has fired twice in 66 live trades.** Effectively inert.
- **`quoteRefused` and `quoteReadFailed` are 0 across every run.** Both refusal branches
  are unexercised against live data.
- **The nightly check has never delivered an alert.** Its thresholds have been exercised
  in opposite directions; the delivery path has not.
- **`MAX_CONCURRENT` and `MAX_DAILY_LOSS_USD` have never bound outside the drill.** Dry
  run realises no loss, and `MAX_CONCURRENT` has not been reached because positions close
  within ~105 s of opening.
- **No transaction has ever been signed or broadcast.** There is no signing path, and
  every figure in this document is a simulation.

### D. Structural, and stated so they are not rediscovered

- **`bot_horizon_prices` and `bot_exit_attempts` accumulate and nothing prunes them.**
- **The +450 s peak on the bot's own trades contradicts the offline holdout**, where
  +450 s is exactly 0.00000 in every window and both halves. Unresolved.
- **The stored `hooks` values are one byte short** on rows written before that decoder
  was fixed. Deterministic, so grouping is unaffected.
- ~~Seven `exit_exhausted` rows are stranded in a status nothing sweeps~~ — **MIGRATED
  2026-09-16**, `exit_exhausted` 7 -> 0 and `needs_exit` 0 -> 7, all in mode
  `dry-run-r5`. What remains is not a defect but a consequence: **the next boot of
  `dry-run-r5` will act on them before arming**, and on the measured holder balances six
  resolve to `closed_unfilled` without an exit while one climbs the ladder. **If that one
  exhausts it calls `halt()`, which is keyed on CHAIN and stops every mode on
  `robinhood`.** That is rule 4 working rather than a fault, and clearing the halt is a
  deliberate operator action with counts reconciled, exactly as the boot-fixture halt was
  cleared earlier the same day.
- **`MAX_CONCURRENT` COUNTS A NARROWER SET THAN THE CAPITAL CAP DOES.** Concurrency uses
  `NON_TERMINAL`; the cap uses `HELD`, which also contains `needs_exit` and
  `exit_exhausted`. So five stuck positions plus five open ones is ten positions against
  a `MAX_CONCURRENT` of 5. Widening an exercised rail is a change to what it means and
  was not made as a side effect of adding a different rail.
- **`net_pnl_usd` IS NULL ON ALL 107 STORED ROWS, so the day's realised loss is
  structurally $0 on live data.** Both `MAX_DAILY_LOSS_USD` and the capital cap's loss
  term therefore read zero whatever happens, and both have only ever been exercised
  against seeded drill rows. A dry run realises nothing, so this is expected — but no
  figure either rail produces on the live path is a measurement of anything.
- **`MAX_DEPLOYED_USD` CANNOT BIND ON THE LIVE PATH AS THE RAILS STAND.** `MAX_CONCURRENT
  5 x $10` of open basis plus `MAX_DAILY_LOSS_USD $15` caps deployed capital at **$65**
  against a $100 cap, so one of those two always fires first. It is a backstop against
  those being raised and is exercised only in `rail-drill`, which constructs states the
  live path cannot reach. **Its HALTING branch needs $90 of realised losses**, which
  `MAX_DAILY_LOSS_USD` makes unreachable, so that branch is proved as a pure function and
  has never run against the database.
- **The balance and the cap are now the same size, which hides a distinction.** The wallet
  reads $126.73 against a $100 cap, so both the $50 gate and the cap pass comfortably and
  neither constrains the other. **A wallet between $50 and $100 is the case that separates
  them** — it may legitimately arm and trade, because the other rails bound deployed
  capital at $65 — and nothing has exercised it.

### The fee bound could not be derived from `v4_pool_creator`, because that table's scope is fee-filtered

Recorded 2026-09-16, while deriving the fee sanity check.

`src/cli/v4-creators.ts` builds its work set with `and i.fee in (500,10000)`
inside the pool selection. Every row in `v4_pool_creator` is therefore a pool at
one of those two tiers *by construction*. Asking that table "what fee tiers does
launchpad `0x58daec…` produce on rule-qualifying launches" returns "500 and
10000, 100% of 2,306 pools" — which is the filter reading itself back, not a
measurement. It is the same shape as an aggregate that confirms the hypothesis
it was built from, and it was caught only because the live dry run at head
produced pools at fee 100 and 803369 from that same launchpad, which the table
said could not exist.

The filter was correct for the question that tool was originally written for
(the tier is a fingerprint of the launchpad — compare like with like across the
two productive tiers). It is wrong for this question. The fee scope becomes a
`--fees` flag, defaulting to every tier, and the chosen scope is logged with the
work set so a future reader cannot mistake a narrowed population for the whole
one.

**The general rule this is an instance of:** a population assembled by a filter
cannot then be used to measure the distribution of the thing that filter keyed
on. Before quoting a distribution from a stored table, read the query that
populated it.


### Two more defects in `v4-creators`, both found by spending against them

Recorded 2026-09-16, closing the fee bound.

**The default fee scope parsed to `[0]`.** Making the scope a `--fees` flag introduced
`''.split(',')`, which is `['']`, and `Number('')` is `0`, which is finite. So the
no-flag default became `fee in (0)` and the work set collapsed from 1,425 pools to 55.
It was caught only by the `fee_scope` line added to the work-set log in the same commit;
without it the run would have reported a plausible 55-pool work set, priced it, and read
it. **A flag whose default silently narrows a population is the same failure as a filter
that matches nothing** — and the fix for both is to log the scope next to the count.

**The read set was a superset of the priced set.** The estimate counted transactions with
no resolved creator (752); the read loop selected every distinct `tx_hash` in the work
set (1,294). Re-running over a partly-collected window therefore priced $0.005 and
attempted $0.009, and the compute-unit ceiling stopped it at 16,920 CU **with nothing
stored**. The ceiling did its job. The read now applies the same `not exists` the
estimate applies, and refuses to spend at all if the two counts differ.

The rule: **price the work you are about to do, not a subset of it.** If an estimate and
a loop derive their sets separately, they will disagree, and the disagreement will
surface as a spend rather than as an error.
