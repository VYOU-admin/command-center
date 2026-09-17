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
STATUS              BUILT, KEYED, AND ABLE TO ARM (2026-09-16). The preflight
                    list is EMPTY: fill-not-modelled was accepted by the
                    operator, so `launchbot --live` NO LONGER REFUSES.
                    **npm run launchbot -- --live TRADES REAL MONEY.** There is
                    no second flag and nothing will ask. What still gates it:
                    an explicit --live (never an env var -- one that looks like
                    an attempt RAISES), a key deriving BOT_WALLET_ADDRESS on
                    chain 4663, a balance covering $50, and a clean boot sweep.
                    What bounds a mistake is the SIX RAILS, not the preflight --
                    $15 of realised loss halts the mode. src/bot/rpc.ts still
                    refuses eth_sendRawTransaction BY NAME on the read path in
                    every mode, and scripts/check-live-gate.mjs still fails the
                    BUILD if any file but bot/signer.ts reads a key.
first dry run       2026-09-16, 65 minutes, 24 hypothetical trades recorded
wallet address      0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a  (supplied by the
                    operator 2026-09-16)
wallet variable     BOT_WALLET_ADDRESS IS SET as a Railway service variable, 2026-09-16,
                    to that same address -- so createBroadcaster's address guard now
                    COMPARES rather than being skipped, confirmed by re-running
                    signer-check (the inert-guard warning is gone).
signing key         BOT_PRIVATE_KEY IS SET as a Railway service variable, 2026-09-16.
                    CONFIRMED by npm run signer-check to control exactly that
                    address, on chainId 4663, through a transport that cannot
                    broadcast. The key is never logged, returned or transmitted;
                    only its length (66 = 0x + 64 hex) is ever reported.
                    A live run RAISES without BOT_WALLET_ADDRESS -- see section 2A.
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
mode                dry-run by default and six dry runs to date (section 6).
                    'live' EXISTS as of 2026-09-16 and CAN NOW ARM: it needs an
                    explicit --live flag, an empty prerequisites list and a key,
                    AND IT HAS ALL THREE as of 2026-09-16. It has never been
                    run with the loop ticking; the boot path has, with
                    --minutes 0, which armed and traded nothing.
limits              the six rails of section 4, all enforced in bot/rails.ts and
                    all exercised by npm run rail-drill (32 of 32)
kill switch         keyed (chain, mode) since 2026-09-16: AUTOMATIC halts are
                    mode-scoped, MANUAL halts chain-wide. npm run halt-control
                    is the operator's side and the only writer of the sentinel.
slippage bound      1000 bps, changed from 300 on 2026-09-16 on measured
                    evidence -- section 4
exit retry ladder   [1000, 1343], two rungs, re-derived at the new bound
live gate           20 of 20 cases in npm run live-gate-drill; the static gate
                    passes over 132 source files and is proven able to fail
prerequisites       ZERO outstanding. fill-not-modelled ACCEPTED by the operator
                    2026-09-16; approvals-not-inline CLOSED the same day
                    (section 2D). An empty list does NOT mean the bot is safe --
                    it means the things known to be missing are no longer
                    missing. Section 7 categories B, C and D stay open in full.
the trade           FOUR transactions since 2026-09-16: BUY -> APPROVE -> PERMIT2
                    APPROVE -> (at +90 s) SELL, each confirmed by its receipt before
                    the next is sent. Section 2D. The BUY was never broadcast at all
                    before that pass -- the broadcaster reached only the exit paths.
trades to date      0 REAL TRADES. 107+ hypothetical rows across the dry-run modes.
live boot           EXERCISED 2026-09-16 with --minutes 0: the whole boot sequence ran
                    and the loop never ticked. Broadcaster address matched, wallet gate
                    ALLOWED in live mode for the first time ($126.90 vs $50), reconcile
                    and the needs_exit sweep both found nothing, "launchbot starting
                    live TRUE". Zero transactions; verified on a fresh connection that
                    mode live holds no rows and entry_tx is null everywhere.
                    THE LOOP'S LIVE PATH HAS STILL NEVER EXECUTED.
stored rows         117, counted: dry-run 40, r3 34, stuck 1, r5 32, gate 3, send 1,
                    approvals 6. fill_status is 'dry-run' on 117 of 117 and gas_usd is
                    non-null on 0, which is the evidence no live row has been written.
first real tx       2026-09-16. TWO APPROVALS, both mined, nonces 130 and 131:
                    0x999fdb79...2669  USDG.approve(Permit2, 1)        block 65,017,856
                    0x178977d3...55c0  Permit2.approve(USDG, router, 1) block 65,017,859
                    Total gas $0.0128. NOT a trade -- a bounded approval of one raw
                    unit of USDG, chosen so the signer could be wrong on a call that
                    moves nothing. It was wrong twice; see section 6.
capital approved    $100 total, $10 per position (operator, 2026-09-16), and since
                    2026-09-16 ENFORCED as MAX_DEPLOYED_USD rather than stated here
```

**~~NOTHING IN THIS REPOSITORY HAS EVER WRITTEN TO A CHAIN~~ — FALSE SINCE THE TWO
APPROVALS OF 2026-09-16**, and this paragraph went on asserting it while ALSO saying four
lines later that the signer had been constructed. **It contradicted itself inside itself**,
which is what a paragraph edited three times without being re-read looks like.

**WHAT IS TRUE NOW.** Two approvals have been signed and mined, `0x999fdb79…` and
`0x178977d3…`, for $0.0128 of gas. **No TRADE has been signed**: no buy and no sell, so
every return figure in this document is still a simulation. `eth_sendRawTransaction` is
named in exactly two files — `bot/rpc.ts` to refuse it on the read path and to gate the
broadcast client, and `bot/signer.ts` as its one caller — and private-key handling exists
in `bot/signer.ts` alone, where the build gate confines it over 132 files and is proven able
to fail.

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

### 2A. LIVE MODE — BUILT 2026-09-16, DEFAULTING OFF, AND PROVEN OFF

**IT EXISTS AND, SINCE 2026-09-16, IT CAN ARM.** The operator's requirement was that live
mode be built and provably off *before* any key was added, so that when the key arrived
there was nothing for it to do wrong. **That requirement is discharged**: the key arrived,
the prerequisites emptied one at a time with evidence, and the last was accepted. This
section describes the gates as they were built and as they still stand — what changed is
that **gate 2 is now satisfied rather than refusing.** Nothing in this section signed or
broadcast anything at the time it was written; the two approvals came later.

#### FOUR INDEPENDENT GATES, AND EACH ONE ALONE IS SUFFICIENT

| gate | where | what it refuses |
|---|---|---|
| 1. the mode | `bot/mode.ts` | live requires an explicit `--live`. Never a config file, never an env var, never a default. |
| 2. the prerequisites | `bot/live-preflight.ts` | refuses to ARM while any listed item is outstanding. **ZERO are, as of 2026-09-16** — four were closed with evidence and the last was accepted. This gate no longer refuses. |
| 3. the key | `bot/signer.ts` | the ONLY file that may read a key or construct a signer. None is set. |
| 4. the transport | `bot/rpc.ts` | `ReadOnlyRpc` refuses every signing method BY NAME in every mode; `BroadcastRpc` cannot be CONSTRUCTED outside live. |

**AN ENVIRONMENT VARIABLE THAT LOOKS LIKE AN ATTEMPT TO GO LIVE RAISES RATHER THAN BEING
IGNORED.** `BOT_LIVE`, `LAUNCHBOT_LIVE`, `BOT_MODE`, `LIVE` and `BOT_GO_LIVE` are all
named in `mode.ts` in order to refuse them — and they raise **even alongside the real
flag**, so nobody can come away believing the variable is the control. Silently ignoring
one would leave an operator thinking the bot is live when it is not, which is the
`bridge_assets` failure this document already records: an option accepted and doing
nothing is worse than one refused.

**THE FLAG CANNOT BE COMBINED WITH `--run-label`.** A label grants a run its own
`MAX_TRADES_PER_DAY` budget, which is exactly the wrong thing to hand a live run: two live
runs must share one day's allowance rather than each getting a fresh one.

#### `BroadcastRpc` CANNOT BE CONSTRUCTED, WHICH IS STRONGER THAN A REFUSED CALL

The obvious design is one client that permits broadcasting when `mode.live`. **That is
exactly wrong**, and the reason generalises: it would mean every existing call site — the
dry run, every drill, every measurement CLI, `wallet-probe` — silently gains the ability
to broadcast the moment something hands it a live mode, and the guarantee would rest on
none of them ever being handed one by accident.

So **`ReadOnlyRpc` refuses forever, in every mode including live**, and a live path must
reach for `BroadcastRpc` explicitly and by name. **Broadcasting is opt-in per call site,
not a property the process acquires.** In every non-live mode there is no object in the
process that can reach the broadcast at all.

`BroadcastRpc` also **still refuses the node-side signing methods even in live mode**: this
bot signs locally with its own key and never asks a node to sign for it, so a node-side
signing method is either a misconfiguration or an unlocked account.

#### THE PROOF IS TWO CHECKS THAT ANSWER DIFFERENT QUESTIONS

**THE STATIC GATE IS THE STRONGER ONE, AND IT RUNS ON EVERY BUILD.**
`scripts/check-live-gate.mjs` is wired into `npm run build`, so a commit that starts
reading a key from a second place, constructs a signer elsewhere, or names the broadcast
outside the two files allowed to, **cannot be built and therefore cannot be deployed**.

```
live-gate: 132 source files checked, 2 permitted mention(s) in comments
  OK  the private-key environment variable: confined to [src/bot/signer.ts]
  OK  ethers' signing primitives:          confined to [src/bot/signer.ts]
  OK  eth_sendRawTransaction:              confined to [src/bot/rpc.ts, src/bot/signer.ts]
  OK  eth_sendTransaction:                 confined to [src/bot/rpc.ts]
  OK  live mode from an environment variable: confined to [src/bot/mode.ts]
live-gate: PASS
```

**IT IS KNOWN TO BE ABLE TO FAIL.** A probe file containing
`process.env['BOT_PRIVATE_KEY']` was added to `src/bot/` and the gate failed with exit 1,
naming the file and line; removing it passed again. A gate nobody has made fail is not a
gate — this document's own standard, applied to itself.

**Two refinements it forced, both worth recording.** It first failed on two *doc comments*
describing the refusal, which cannot execute — so comment mentions are permitted **and
counted** (`2 permitted mention(s)`) rather than silently stripped, because a filter that
quietly declines to look at text is the shape this project calls a clean pass over
nothing. And it carries a **stale-rule check**: if a rule's pattern matches nothing
anywhere in `src/`, the capability was renamed or deleted and the rule now guards nothing,
so it FAILS rather than passing forever.

**THE RUNTIME DRILL IS THE WEAKER ONE AND SAYS SO.** `npm run live-gate-drill` proves the
refusals fire on the paths it exercises; it cannot prove no other path exists, which is
the actual requirement. **20 of 20 cases**, spending nothing and touching nothing:

```
createBroadcaster in dry-run                         REFUSED  no key read, no signer built
createBroadcaster in a LABELLED dry-run              REFUSED
new BroadcastRpc in dry-run / labelled dry-run       REFUSED  cannot be constructed
ReadOnlyRpc.call(...) for all 8 forbidden methods    REFUSED  by name
BOT_LIVE=1 with no flag                              REFUSED  raises, not ignored
LAUNCHBOT_LIVE=true with no flag                     REFUSED
BOT_MODE=live WITH --live                            REFUSED  the var raises anyway
--live combined with --run-label                     REFUSED
createBroadcaster LIVE with no key                   REFUSED  at startup, not mid-trade
new BroadcastRpc in LIVE mode                        ALLOWED  <- the path EXISTS
ReadOnlyRpc still refuses the broadcast in LIVE      REFUSED  per call site, not per process
BroadcastRpc refuses eth_sign in LIVE                REFUSED  we sign locally
```

**THE ONE `ALLOWED` CASE IS THE IMPORTANT ONE.** A gate that refuses because the
capability was never written is indistinguishable from one that refuses because it is off.
That case proves the build is not simply missing the feature.

**The drill takes the broadcast method's name from `FORBIDDEN_METHODS` rather than typing
it**, for two reasons: the build gate refused this file when it was typed, correctly, and
widening the allow-list to admit a test would have weakened a static guarantee for
convenience — and a drill that types its own copy of the deny-list is testing its copy.

#### LIVE WITH NO KEY REFUSES AT STARTUP, NOT MID-TRADE

Explicitly required, and the order inside `createBroadcaster` is the mechanism: **not live
→ refuse before the key is even looked for.** A non-live process must not so much as read
the variable, because "we read it and did not use it" is weaker than "the read is
unreachable", and a key in a process's memory is a key that can reach a crash dump or a
log line. Only when live does it look, and then a missing key raises immediately:

```
LIVE MODE REQUIRES BOT_PRIVATE_KEY AND IT IS NOT SET. Refusing to start rather than
failing mid-trade: a bot that arms, finds a launch and only then discovers it cannot
sign has spent the compute units and may hold a position.
```

Three further startup refusals sit behind it, none of which can be reached today: a
**malformed** key raises distinctly from a missing one; the **chain id is confirmed**
before anything can be signed for it, because a correctly signed transaction for the wrong
chain is a perfectly valid transaction somewhere else; and the key's address must **equal
`BOT_WALLET_ADDRESS`**, or every rail, balance read and reconciliation would be about one
account while the signing was about another.

#### ONE IMPLEMENTATION — WHERE EACH RULE LIVES, AND NOTHING FORKS FOR LIVE

**The mode decides whether a broadcaster exists and NOTHING else.** Every rule below is
the same object on both paths:

| rule | the one place it lives | forks for live? |
|---|---|---|
| the mode itself | `bot/mode.ts` — `resolveMode` | n/a, it IS the decision |
| the quote | `bot/quote.ts` — `quote()` | **no** |
| the rails | `bot/rails.ts` — `checkRails`, `evaluateRails`, `deployedUsd` | **no** |
| the entry rule and sizing | `bot/rule.ts` — `qualifies`, `positionWei`, `minOut` | **no** |
| the calldata | `bot/calldata.ts` — `buildSwap`, `buildTokenApprove`, `buildPermit2Approve` | **no** |
| the exit executor | `bot/exit-exec.ts` — `executeExit`, used by the loop AND the boot sweep | **no** |
| the retry ladder | `bot/exit.ts` — `exitWithRetry` | **no** |
| reconciliation | `bot/reconcile.ts` — `reconcileOnBoot`, `clearNeedsExit` | **no** |
| the price conventions | `bot/price.ts` | **no** |
| "is this mode hypothetical" | `bot/mode.ts` — `isDryRunMode` | **no** |

**TWO THINGS MOVED TO KEEP THAT TRUE, AND THEY ARE THE INTERESTING PART OF THIS PASS.**

`launchbot.ts` **used to parse `--run-label` and build its own mode string.** Adding live
mode beside it would have created a second place deciding whether the bot is about to
spend real money — the two-implementations trap with money attached. It now calls
`resolveMode` and holds no mode logic.

`isDryRunMode` **already existed in `src/web/trades-page.ts`**, and writing the same
two-line test into the mode module was the obvious move. That would have put the page's
idea of "is this real money" and the bot's idea of it in two places that can drift — and
the `/trades` banner has already announced "THIS PAGE CONTAINS LIVE TRADES" over 34
hypothetical rows once, because a caller re-implemented this as an equality check. It now
lives in `bot/mode.ts` and the page re-exports it.

#### THE PREREQUISITES THAT REFUSE TO ARM, AS DATA RATHER THAN A COMMENT

`bot/live-preflight.ts` carries the list, and live mode raises while it is non-empty. **A
`TODO` in a source file does not stop a process; this does.** The dangerous shape is not a
missing feature but a PARTIAL one — a live loop whose buy broadcasts and whose sell does
not would open real positions it cannot close, which is the single worst outcome available
to this bot.

| id | what is missing | why arming anyway is unsafe |
|---|---|---|
| ~~`sell-not-broadcast`~~ | **CLOSED 2026-09-16** — the broadcaster is threaded through `exit-exec` and forwarded by both callers. See 2C. | — |
| `approvals-not-executed` | neither setup transaction has ever run | without both allowances every exit reverts for a reason unrelated to the pool |
| `fill-not-modelled` | `fill_status` is the literal `dry-run` | every return figure is mark-to-market; a live fill competes for the same block |
| `stuck-rows-can-halt` | 7 `needs_exit` rows in `dry-run-r5` | the kill switch is chain-wide, so a dry-run boot failure would halt live trading |

**~~THREE REMAIN~~ — NONE REMAIN as of 2026-09-16.** The three named here were
`approvals-not-executed` (replaced by `approvals-not-inline`, then closed in section 2D),
`stuck-rows-can-halt` (renamed `dry-run-boot-halts-the-chain`, closed by the kill-switch
scope split) and `fill-not-modelled` (**accepted by the operator** — see section 6).
`launchbot --live` no longer exits 1 here.

**An empty list does not mean the bot is safe**, and it is not a substitute for the
operator's judgement — it means the things known to be missing are no longer missing.
Section 7's categories B and C stay open regardless.

### 2C. THE LADDER SENDS — `sell-not-broadcast` CLOSED 2026-09-16

**The broadcaster is threaded through `exit-exec.ts` and forwarded by BOTH callers** — the
boot sweep (`clearNeedsExit`) and the in-loop exit — so there is still ONE executor and
one submission path. Nothing forks: the quote, the ladder, the bound, the calldata and the
recording are the same objects in the same order, and the only difference is what happens
after the simulation returns.

#### THE LADDER CLIMBS ON SIMULATIONS AND SENDS ONLY THE RUNG THE POOL ACCEPTED

Broadcasting each rung in turn is the obvious shape and it is worse in three ways:

- **it pays gas for rungs that were always going to revert;**
- **it loses the diagnosis.** A mined failure gives `status: 0` and nothing else, while an
  `eth_call` gives the decoded `V4TooLittleReceived bound=… actual=…` that made these
  numbers readable at all — the whole reason `revert-decode` had to be written;
- **it turns every rung into an in-flight transaction**, which is the one failure the
  ladder cannot safely retry.

So the simulation runs **in live mode too** — free, fast, diagnostic — and only the
accepted bound is signed and sent. The price is a race: the pool can move between the call
and the broadcast, so a sent transaction can still revert. That is inherent, and it is
handled rather than hidden — **a mined revert is an ordinary attempt failure and the ladder
continues.**

#### `ExitUnrecoverableError` — THE SAFETY PROPERTY THIS CHANGE REQUIRED

**While `send` was an `eth_call`, every failure was safe to retry.** Nothing had been
submitted, so climbing to a wider bound cost nothing. **Once `send` broadcasts, one failure
mode stops being safe: a transaction whose outcome is unknown.** The ladder's ordinary
behaviour would widen the bound and send a SECOND sell while the first may still be in
flight — and two sells of one position is not a retry, it is a second position we do not
have.

So `send` now rejects in two distinguishable ways, and five conditions take the second:

| condition | ladder | why |
|---|---|---|
| the simulation refused | **continues** | nothing was sent; the next rung is safe |
| broadcast mined, `status: 0` | **continues** | settled, nothing in flight, the price moved between call and send |
| **no receipt inside the timeout** | **STOPS** | the sell may still land. Neither confirmed nor failed. |
| **the broadcast itself rejected** | **STOPS** | a throw is not proof nothing was sent — a transport error can arrive after the node accepted it |
| **allowances do not cover the position** | **STOPS** | every rung fails identically; no bound fixes it. Nothing is sent. |
| **`sellFrom` is not the signer** | **STOPS** | the simulation would be about another wallet while the broadcast is ours |
| **`forceOptimism` set** | **STOPS** | a control that makes rungs fail on purpose must not touch real money |

**The stop is RECORDED before it raises**, because that is the case a human has to
reconstruct from the table afterwards.

#### THREE THINGS THE WIRING HAD TO FIX RATHER THAN ASSUME

**1. THE RECEIPT POLL NEEDED ITS OWN WAIT.** The in-loop caller passes a no-op for
`ctx.wait` deliberately, so a dry run does not sleep 5 s between rungs. Had the receipt
poll shared it, a live broadcast would have spun without delay against the endpoint —
two different concerns behind one injection point, which is how a test control leaks into
a live path.

**2. BOTH CALLERS READ THE BORROWED HOLDER'S BALANCE.** `exit_sim_from` is the pool's
first-swap sender, borrowed because in dry run we hold nothing. On a live path the balance
to read and the account to sign as are both ours; getting that wrong would simulate
someone else's ability to sell and then broadcast ours, with `amountIn` taken from their
balance. Both callers now derive the seller from the broadcaster when one is present, and
`executeExit` refuses if the two disagree — **the fix and the backstop, not one or the
other.** Live also sells the WHOLE balance rather than capping at the stored quote, which
is the documented rule the boot sweep already followed.

**3. THE ALLOWANCE READS WERE INLINE IN `approve-setup`.** The exit path needs them, so
they are extracted to `bot/allowance.ts` and both import `checkSellReadiness`. **The side
that grants an allowance and the side that checks it disagreeing about sufficiency is how
a bot sells into a revert it had already been told about** — and it would have been the
eighth recorded instance of the two-implementations trap.

#### THE DRILL: 10 OF 10, WITH A TEST DOUBLE, AND IT SAYS SO

`npm run exit-broadcast-drill -- --commit`, on `chain='drill'`. No key exists, so the only
way to run these branches is a **test double** in place of the broadcaster — and the drill
prints what that proves and what it does not in its own output.

```
PASS  no broadcaster -> simulated, NOTHING sent            sent=0, 0 receipts polled
PASS  live + simulation fails -> NOTHING sent, exhausts     sent=0
PASS  live + simulation passes -> sent ONCE, status 1       filled on attempt 1
PASS  live + status 0 -> ordinary failure, ALL RUNGS ran     sent=2 of 2
PASS  live + NO RECEIPT -> UNRECOVERABLE, exactly ONE send  a second send here would be
                                                            a second sell of one position
PASS  live + broadcast rejects -> UNRECOVERABLE             attempted_sends=1
PASS  live + allowances short -> UNRECOVERABLE, NOTHING sent
PASS  live + sellFrom is a BORROWED holder -> refused        0 rpc calls at all
PASS  live + forceOptimism -> refused
PASS  the unrecoverable stop is RECORDED before it raises
```

**WHAT IT PROVES: the orchestration** — a simulation precedes every send, only the accepted
rung is sent, a receipt decides, and an unconfirmed send stops the ladder at one
transaction. **WHAT IT DOES NOT PROVE: signing, gas estimation, nonce handling, or the
chain accepting our bytes.** Those stay untested until section 8's approval.

#### THE DRILL'S FIRST RUN FOUND A DEFECT IN LIVE DATA, AND IT WAS NOT THE NEW CODE

It failed 9 of 10 on *"the unrecoverable stop is RECORDED before it raises"* — 0 attempts
found. The stop WAS recorded; it was recorded **under the wrong chain**.
`exit-exec`'s attempt insert carried the literal `'robinhood'` rather than taking the chain
from its caller, so a drill running on `chain='drill'` — and deleting `chain='drill'`
afterwards — left **three orphan rows in the live chain's table**, one against trade id
336, which is not a trade at all.

**THAT MATTERS BECAUSE `bot_exit_attempts` IS A MEASUREMENT TABLE, NOT A LOG.** Run 4's
rung table — *39 attempts across 17 trades, one rescued at rung 2* — was derived from these
rows, so false rows there corrupt a future derivation rather than merely sitting around.

`ExitExecContext.chain` is now **required rather than defaulted**, because a default is
what made it possible: every caller already knows its chain, and one that does not should
not be writing attempt rows. `npm run purge-orphan-attempts` removed what the defect had
already written, reconciling **46 → 43 with 0 orphans remaining** — and **43 is exactly the
legitimate count this document already records** (run 4's 39 plus the boot fixture's 4).

**An orphan is defined by the JOIN, not by a date or a shape.** Deleting rows that "look
like the drill's" would be a guess, and a guess that deletes a real attempt destroys
evidence.

**This is the drill earning its place on its first run**, and the defect it found was
pre-existing rather than part of the change it was written to test.

### 2B. THE TWO SETUP TRANSACTIONS — `npm run approve-setup`

Section 2 established that a sell pulls the token through Permit2 and needs two grants:
`token.approve(PERMIT2, amount)` then `Permit2.approve(token, ROUTER, amount, expiry)`.
Both were measured over 40 real sells, **40 of 40 had a prior approval, and neither has
ever been executed by this project.**

**IT IS A SEPARATE CLI SO THAT THE FIRST TRANSACTION THIS PROJECT EVER SIGNS IS A BOUNDED
APPROVAL AND NOT A TRADE.** An approval for a stated amount to a named spender is the
smallest, most inspectable thing the signing path can be pointed at. A trade commits
capital and depends on a quote, a rail, a pool and an exit. **If the signer is wrong, this
is where it should be wrong.**

#### EXACT AMOUNT, NOT UNLIMITED — AND THE MEASUREMENT CUTS THE OTHER WAY

Section 2 measured **46 approvals to a router for a FINITE amount against 19 to Permit2
for `uint256` MAX**, so unlimited is the norm for the Permit2 route specifically. That is
what Permit2 is for: approve once, unlimited, and let the per-spender allowance carry the
bound and the expiry.

**This approves an EXACT AMOUNT anyway, and not because the measurement is wrong.** It
describes traders whose position size is unbounded and whose token set is stable. This
bot's position is bounded at `MAX_POSITION_USD` = $10, and **every token it touches is a
launch minutes old from a launchpad it does not control** — a contract nobody has read,
which may carry a transfer hook, a blacklist or an owner-mint. An unlimited allowance on
such a token is an open-ended claim on whatever balance the wallet ever holds of it,
granted to a spender chosen by whoever deployed it. **The cost of being wrong is bounded by
the allowance, so the allowance is bounded.**

**The price is stated rather than hidden:** an exact amount means one pair of approvals per
token per trade, measured at $0.00751 each — **$0.015 per round trip, about 0.15% of a $10
position**, inside the 1.8–1.9% round trip already recorded and changing no decision.

#### WHAT IT DOES BEFORE IT DOES ANYTHING

- **Reads both allowances from the chain first** and SKIPS what already covers the amount —
  reported as `SKIP`, never as done. An approval already in place is a different fact from
  one this run granted.
- **An unreadable allowance is UNKNOWN and REFUSES**, never treated as absent. `0x` is not
  zero; sending an approval against a state that could not be established is the
  plausible-value-on-an-error-path failure with a signature attached.
- **Honours Permit2's EXPIRY.** A non-zero amount whose expiration has passed is worthless
  and must not read as already granted — the one way this differs from a plain ERC-20
  allowance, and the one a check written from the ERC-20 shape would miss.
- **Sizes the amount from the BALANCE read from the chain**, not from the stored quote —
  the same rule the exit executor already follows. An allowance below the balance leaves
  part of the position unsellable.
- **Refuses to size against a zero balance** rather than approving zero, which would grant
  nothing while reporting success.
- **Dry by default**, and `--commit` alone is not enough: broadcasting also needs `--live`
  and a key.
- **Re-reads both allowances from the chain afterwards** and raises if they do not cover the
  amount. A transaction the node accepted is not an allowance that is set — the
  fresh-connection rule in its on-chain form.

**ITS WRITE HALF HAS NEVER RUN AND CANNOT RUN IN THIS BUILD.** It reaches
`createBroadcaster` at a real call site and is refused there. The read half works and is
exercised below.

### 2D. THE TRADE SENDS ALL FOUR TRANSACTIONS — `approvals-not-inline` CLOSED 2026-09-16

**A LIVE TRADE IS FOUR TRANSACTIONS AND ONLY ONE OF THEM WAS WIRED.** Section 2C threaded
the broadcaster through `exit-exec` and closed `sell-not-broadcast`; the two approvals were
carried as `approvals-not-inline`. Reading the path end to end before writing that wiring
found a third thing, upstream of both:

> **THE BUY WAS NEVER BROADCAST EITHER.** `broadcaster` reached `clearNeedsExit` and the
> per-tick exit sweep and **nothing else**. The entry was an `eth_call` and then an insert:
> a `holding` row carrying `fill_status = 'dry-run'` and an `exit_due_block`, for a position
> nothing had bought. A live run would have opened rows against tokens it did not hold and
> tried to sell them ninety seconds later.

**It was masked by the prerequisites list refusing to arm**, which is the same masking that
hid the wallet-gate defect when the key arrived: a guard that stops the run also stops
anyone finding out what the run would have done. **`approvals-not-inline` could not honestly
be closed while this was true** — wiring approvals to a buy that does not happen would have
met the prerequisite's words and left the risk exactly where it was, which is the trap
`approvals-not-executed` was replaced to avoid one pass earlier.

So this pass wires the whole trade: **BUY → APPROVE → PERMIT2 APPROVE → (at +90 s) SELL.**

#### WHERE IN THE SEQUENCE: AFTER THE BUY, AND THE DECIDING REASON IS NOT THE OBVIOUS ONE

Both orders are defensible and the choice was made on evidence rather than preference.

| | grant BEFORE the buy | **grant AFTER the buy** |
|---|---|---|
| the amount | **only a quote exists** | **the balance, read from the chain** |
| gas on a refused entry | paid, every time | **never paid** |
| window holding with no approval | none | **~300 ms of a 90,000 ms hold** |

**THE DECIDING ARGUMENT IS THE AMOUNT, AND IT IS THE ONE NEITHER ORDER MAKES OBVIOUS.**
Section 2B's policy is an EXACT amount and never unlimited, and the exit's rule is that the
amount sold is *the balance read from the chain, never the stored quote*. **Before the buy
there is no balance — only a quote this document measures to be wrong.** Section 6 records a
2–3% residual over-quote whose distribution straddles our own bound, and the error runs in
both directions. An allowance sized on a quote that comes in below the fill leaves the tail
of the position **unsellable**, which is the precise failure the exact-amount policy exists
to bound. Granting first therefore forces a choice between an unlimited allowance — refused
by section 2B, on a contract nobody has read — and a padded guess, which is a number
invented to cover an error whose size is unknown. **Granting after removes the question:
`balanceOf` is the answer.**

The other two reasons agree with it and neither would have been sufficient alone:

- **THE COST IS ONLY PAID ON TRADES THAT FILLED.** At the measured entry revert rate the
  pre-approve order spends $0.0128 on every refused entry, for an allowance on a token the
  wallet will never hold.
- **THE EXPOSURE WINDOW IS SUB-SECOND AGAINST A 90-SECOND HOLD.** The two real approvals of
  2026-09-16 landed in blocks 65,017,856 and 65,017,859 — **three blocks, ~300 ms**, both
  receipts served on the first poll. `EXIT_DELAY_BLOCKS` is 900 blocks = 90 s. So "holding
  with no approval" is **0.3% of the hold**, and it is at the START of the hold, which is
  the half where the exit is not due.

#### WHAT HAPPENS WHEN ONE LEG SUCCEEDS AND THE OTHER DOES NOT

**THE APPROVAL SUCCEEDS AND THE BUY FAILS: IT CANNOT ARISE IN THIS ORDER, AND THAT IS
ITSELF AN ARGUMENT FOR THE ORDER.** The buy is first and the grant is gated on its receipt,
so a failed buy simply never reaches the approval. Had the order been reversed, the outcome
would be a live allowance to Permit2 and to the router on a token the wallet does not own.
Nothing moves — an allowance without a balance grants a claim on nothing — but it is a
standing grant on a launch-minute contract, left behind by a trade that did not happen, and
it is exactly what section 2B bounds the amount in order to survive.

**THE BUY SUCCEEDS AND THE APPROVAL FAILS IS THE CASE THAT MATTERS, AND IT MUST NOT LEAVE A
POSITION THE BOT CANNOT CLOSE.** The three receipt outcomes are three different facts and
each gets its own response, which is why `bot/receipt.ts` returns rather than throws:

| the approval | the position | the mode |
|---|---|---|
| mined, status 1 | `holding`, normally | continues |
| **mined, status 0** | **`needs_exit`** | **HALTS** |
| **no receipt inside the timeout** | **`needs_exit`** | **HALTS** |
| **the broadcast itself rejected** | **`needs_exit`** | **HALTS** |

**`needs_exit` RATHER THAN A NEW TERMINAL STATUS, AND THE REASON IS A DEFECT THIS DOCUMENT
ALREADY PAID FOR.** The tokens are ours and the position is real. `needs_exit` is the one
state `clearNeedsExit` acts on at boot, and the exit path now grants what is missing before
it sells — so the failed approval is RETRIED there, against a token the wallet demonstrably
holds. A terminal status would repeat `exit_exhausted`: seven positions in a status no sweep
contained, which this document records finding months of assumption later.

**IT HALTS BECAUSE AN APPROVAL THAT REVERTS IS A STATEMENT ABOUT THE TOKEN, NOT ABOUT THIS
POOL.** A freshly launched contract that refuses a standard `approve` — a blacklist, a
transfer hook, a non-standard return — will refuse the next one from the same launchpad
seconds later. That is the reasoning `MAX_CONSECUTIVE_REVERTS` already uses, and halting
here costs one mode's remaining launches against the alternative of opening positions that
cannot be sold, one every few seconds. **Halts have been mode-scoped since earlier the same
day, so a live halt stops live and nothing else.**

**THE HALT STOPS NEW TRADES AND NOT THE RESOLUTION OF THIS ONE.** The row is `needs_exit`
before the halt is written, so the next boot of that mode sweeps it whether or not a human
has cleared anything — and `halt-control` refuses to clear a mode while it still has
`needs_exit` rows, which points the operator at the position rather than at the switch.

#### THE NONCE: ONE BROADCAST IN FLIGHT AT A TIME, AND THE RECEIPT IS THE GATE

`signer.send` reads the nonce per transaction as `'pending'`, deliberately, so a replaced
container cannot reuse one. **On a node that does not track the mempool `'pending'` equals
`'latest'`**, so two sends before the first is mined take the SAME NONCE and the second
replaces the first. `approve-setup` hit this on the first real pair and `bot/receipt.ts`
exists because of it.

**THE RULE IS ABSOLUTE AND IT IS NOW THE WHOLE TRADE'S RULE RATHER THAN ONE CLI'S:**

```
send -> awaitReceipt -> MINED is the ONLY outcome that permits the next send
```

so a trade is a strict chain and never a batch:

```
BUY        send -> receipt MINED -> balanceOf, the exact amount
APPROVE 1  send -> receipt MINED
APPROVE 2  send -> receipt MINED
SELL       (at +90 s) simulate the ladder, send the accepted rung -> receipt
```

**A BUY THAT REPLACED ITS OWN APPROVAL WOULD BE THE SAME FAILURE ONE STEP WORSE** than the
one `approve-setup` found, because a replaced approval is a missing allowance while a
replaced buy is a missing position that the row says exists. Neither can happen: there is
never a second transaction in flight, and the two non-mined outcomes both stop the chain
rather than continuing past an unconfirmed send.

**THE SELL LEG ALREADY HAD THIS PROPERTY AND KEEPS IT.** `ExitUnrecoverableError` stops the
ladder on an unconfirmed broadcast, so no second sell is ever sent; what this pass adds is
the same guarantee for the buy and the two approvals, through the same `awaitReceipt`.

#### ONE IMPLEMENTATION, AND `approve-setup` NOW CALLS IT RATHER THAN BEING COPIED

`src/bot/approvals.ts` — `ensureSellReadiness` — is the only thing that decides what to
approve and grants it. **It was extracted rather than written**, because the alternative was
the ninth recorded instance of the two-implementations trap, in the place this document
already names as the worst for it: *the side that grants an allowance and the side that
checks it disagreeing about sufficiency is how a bot sells into a revert it had already been
told about.*

| what | where it lives | who calls it |
|---|---|---|
| reading both allowances, expiry included | `bot/allowance.ts` — `checkSellReadiness` | approvals, exit-exec |
| building both approvals | `bot/calldata.ts` — `buildTokenApprove`, `buildPermit2Approve` | approvals only |
| deciding, granting, confirming, re-reading | **`bot/approvals.ts` — `ensureSellReadiness`** | the loop, `exit-exec`, `approve-setup` |
| waiting for a receipt | `bot/receipt.ts` — `awaitReceipt` | all of them |

**`approve-setup` IS NOW A THIN CLI OVER IT.** Everything that made the first real
transactions correct — skip what already covers, refuse an unreadable allowance rather than
treating it as absent, honour the Permit2 expiry, re-read from the chain afterwards and
raise if the grant did not land — moved into the module unchanged and is now what the loop
runs too. The CLI keeps only its argument parsing, its balance-sizing default and its
reporting.

**THE EXIT PATH GRANTS RATHER THAN REFUSING, AND AT THE LAST POSSIBLE MOMENT.**
`exit-exec`'s step 2 used to raise `ExitUnrecoverableError` when the allowances were short.
It now calls `ensureSellReadiness` there instead — **after the rung's simulation has passed
and immediately before the broadcast**, so gas is never spent granting an allowance for a
pool that was not going to pay anyway. It is naturally at-most-once per exit: once the grant
lands it covers every later rung. If the grant cannot be made the error is still
`ExitUnrecoverableError`, because no bound fixes a missing allowance.

That is what makes a failed inline grant recoverable: the boot sweep re-enters through the
same executor and the approval is attempted again, against a balance the chain confirms.

#### THE COST, AS A KNOWN PER-TRADE LINE RATHER THAN AN ESTIMATE

**$0.0128 per token per trade — MEASURED, on our own two receipts**, against the $0.015 that
other people's receipts implied. It is **0.13% of a $10 position**, and it is now in the
round-trip table in section 6 as a measured line rather than an external one.

**It is unavoidable and it is not a choice this design makes.** Every token is a launch
minutes old, so no allowance can predate the buy; the only way to pay it less often is an
unlimited allowance, which section 2B refuses for reasons that have nothing to do with cost.

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

### THE KILL SWITCH HAS TWO SCOPES — CHANGED 2026-09-16, operator-approved

| | |
|---|---|
| **was** | `bot_control` keyed on `chain`. Every halt chain-wide. |
| **is** | keyed `(chain, mode)`. **Automatic halts are mode-scoped; manual halts are chain-wide.** |
| **why** | a dry run holds nothing, so its inability to close a hypothetical position said nothing about live exposure — and stopped live trading anyway. **Demonstrated twice in one afternoon.** |

**THE TWO SCOPES ARE NOT A REFINEMENT OF ONE IDEA. THEY ANSWER DIFFERENT QUESTIONS.** A
human reaching for the switch wants EVERYTHING to stop and cannot be required to know
which modes are running — a mode-scoped emergency stop is not an emergency stop. An
automatic halt is a statement about the run that raised it.

```
mode = '*'          CHAIN-WIDE. Only `halt-control` writes it. Stops every mode.
mode = <a mode>     THAT MODE ONLY. What the bot itself raises.
```

**THE BOT CANNOT RAISE A CHAIN-WIDE HALT, AND `state.halt()` REFUSES THE SENTINEL.** `mode`
is a REQUIRED parameter rather than one defaulting to `'*'`, because **a default is exactly
how every automatic halt became chain-wide in the first place** — and making it required
meant the compiler found all eight call sites instead of silently preserving the old
behaviour. The refusal is asserted in the drill rather than assumed.

**A CHAIN-WIDE HALT IS CHECKED FIRST AND REPORTED AS SUCH**, so a manual stop is never
masked by a mode's own row, and a log line says WHICH row stopped the bot:
`[CHAIN-WIDE] …` against `[mode dry-run-r5] …`.

#### THE MIGRATION IS IDEMPOTENT, WHICH IT HAD TO BE

`BOT_SCHEMA` runs on **every boot**, so `drop constraint` then `add primary key` unguarded
would fail the second time and take the whole statement — and every boot — with it. The
swap is guarded on the key's COLUMN COUNT, so the branch is false once the key is already
`(chain, mode)`: **genuinely idempotent rather than merely surviving.** Verified by running
the schema three times in succession, exit 0 each time, and the key still reads
`PRIMARY KEY (chain, mode)`.

**Existing rows backfill to the sentinel** because they WERE chain-wide by construction —
there was no other kind. The one extant row was already cleared, so the backfill changed
no behaviour; it only labelled history with the scope it actually had.

#### THE GUARDS DIFFER BY SCOPE, DELIBERATELY

| clearing | guard |
|---|---|
| a **MODE**'s automatic halt | **REFUSES while that mode has `needs_exit` rows.** The halt is a statement about an unresolved position; clearing it while the position is unresolved is the failure it exists to prevent. |
| the **CHAIN-WIDE** manual halt | **no guard, full disclosure.** Releasing a manual stop is the same human's decision as setting it, and a guard would mean an operator who hit the switch could be prevented from releasing it by a condition they had already accepted. It reports everything outstanding per mode instead. |

**Clearing the chain-wide halt does NOT clear a mode's own** — separate rows, cleared
separately, so releasing the manual stop cannot silently release an unresolved position.

#### 32 of 32 IN THE DRILL, AND THE CASE THAT MATTERS EXPECTS *ALLOW*

`rail-drill` now exercises **two modes**, because a single-mode drill can show that a halt
blocks and **cannot show the property this change actually bought**:

```
PASS  AUTOMATIC halt on 'drill' blocks 'drill'                       BLOCK
PASS  AUTOMATIC halt on 'drill' does NOT block 'drill-other'         ALLOW  <- THE POINT
PASS  MANUAL chain-wide halt blocks 'drill'                          BLOCK
PASS  MANUAL chain-wide halt ALSO blocks 'drill-other'               BLOCK
PASS  a chain-wide halt is REPORTED as chain-wide, not the mode's own BLOCK
PASS  state.halt() REFUSES the sentinel — the bot cannot stop every mode
```

#### WHAT CLEARS IT, AND WHO

**`npm run halt-control`** — the operator's side, and the only thing that writes the
sentinel. `--status` shows every scope with the `needs_exit` rows per mode beside it;
`--halt-chain`, `--clear-chain` and `--clear-mode` each require a reason so the record
never goes blank. Dry by default, verified on a fresh connection.

**The bot still cannot clear any halt.** Nothing in `launchbot`'s path clears a row: a
process that can switch off the thing that switched it off has no kill switch.
`resolve-unsellable`'s old `--clear-halt` moved here, because with two scopes "clear the
halt" stopped being one action and keeping a clearer there would have been a second
implementation of this one.

### THE PREVIOUS DECISION, KEPT BECAUSE THE REASONING IS WHAT CHANGED

**THIS WAS THE 2026-09-16 DECISION TO LEAVE IT ALONE, AND IT WAS SUPERSEDED THE SAME DAY**
by the change above, once the "one specific consequence" it identified turned out to fire
twice in an afternoon. It is kept because the reasoning is what the change was built from:
chain-wide is right for the reason the switch exists and wrong for one consequence, and
**the resolution was to split the scopes rather than to pick one of them.**

**WHY CHAIN-WIDE IS RIGHT.** The kill switch's whole purpose is *stop everything now, from
outside, without a deploy*. An operator reaching for it is not in a position to know which
modes are running, and a switch that required naming the right one would fail exactly when
it is needed. A mode-scoped emergency stop is not an emergency stop.

**THE CONSEQUENCE, STATED PLAINLY: ONE STUCK DRY-RUN ROW CAN HALT LIVE TRADING.** The
automatic halts — an unresolvable position at boot, a breached daily loss, a run of
reverts — call the same `halt()`. So a dry run that cannot clear a `needs_exit` row would
stop a live run that has nothing to do with it. **This is live today**: 7 `needs_exit` rows
sit in mode `dry-run-r5`, and the next boot of that mode will act on them.

**AND THAT IS THE WRONG SCOPE FOR AN AUTOMATIC HALT, WHICH IS A REAL DEFECT AND NOT A
DESIGN CHOICE.** A dry run holds nothing and risks nothing, so its inability to close a
hypothetical position is not a statement about live exposure. The correct design is
**manual halts chain-wide, automatic halts scoped to the mode that raised them** — a single
boolean row keyed on `chain` cannot express both.

**IT WAS NOT CHANGED IN THAT PASS, DELIBERATELY** — re-keying an exercised rail is an
operator's decision rather than a side effect of building live mode. **The operator took
it the same day**, and the proposed fix recorded here is what was implemented: manual
halts chain-wide, automatic halts scoped to the mode that raised them.

**WHAT CLEARS IT, AND WHO.** Only a human, from outside the bot, with counts reconciled:

```sql
-- READ FIRST. Never clear a halt without reading why it was set.
select chain, halted, reason, updated_at from bot_control where chain = 'robinhood';

-- CLEAR. Scoped to one chain, and the reason is kept for the record.
update bot_control set halted = false, reason = 'cleared by <operator>: <why>',
       updated_at = now()
 where chain = 'robinhood';
```

**The bot cannot clear its own halt and must never be given a path to.** A process that can
switch off the thing that switched it off has no kill switch. `halt()` only ever sets; the
only clearing path is a human with a database connection — which is also why the switch is
a row rather than a flag: it can be set and cleared while the bot is mid-flight, without a
deploy. Both directions were exercised in `rail-drill` (*kill switch set by an outside
writer* → BLOCK, *cleared* → ALLOW), and one real halt has been set and cleared this way:
the boot-exit fixture on 2026-09-16, with counts reconciled before and after.

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

### THE BOUND MOVED: 300 → 1000 bps — 2026-09-16, operator-approved

| | |
|---|---|
| **was** | `SLIPPAGE_BPS = 300` — derived before any trade existed |
| **is** | `SLIPPAGE_BPS = 1000` |
| **decided** | 2026-09-16, by the operator, on the `revert-economics` evidence in section 6 |
| **decided by** | a measurement, NOT a tuned constant — see what that means below |

**WHAT THE OLD VALUE WAS AND WHY IT WAS ALWAYS PROVISIONAL.** 300 bps came from p90
round-trip slippage at $10 (1.085% / 0.350% / 0.549% across three windows), halved per
leg, plus three ticks of the observed ~0.8% per-tick drift for the 5 s detection latency:
0.54% + 2.4% ≈ 2.94%. That derivation was sound and it answered the wrong question — it
sized the bound against how much the price MOVES, and never asked what refusing a trade
COSTS.

**WHAT THE MEASUREMENT FOUND.** Section 6 carries it in full. In one line: **the trades
the 300 bps bound admitted had a median return of 0.000 in the recent era and the ones it
refused had +0.439**, and refused trades had BETTER exit availability in all four
historical windows. The bound fires when a pool's price moved away from our quote, and a
pool whose price is moving is a pool that is trading — so it was selecting, with some
precision, for pools where nothing was happening. Banded, it refused **34 tradeable
launches to avoid 3 dead ones.**

**WHY 1,000 AND NOT THE ARGMAX.** The objective the operator specified — maximise median
return over every qualifying launch — is FLAT from 1,350 to 9,400 bps, so it does not
identify a value; and its answer is arithmetic rather than economic, because over half of
launches score zero and the median jumps when that mass crosses the 50th percentile. The
binding constraint is the one this document already derived for the retry ladder: **above
roughly 1,600 bps the accepted haircut exceeds the recent-era median gross return of
+0.157–0.180**, at which point a filled trade loses more than the trade makes. That makes
the defensible range **1,000–1,600 bps**, and **1,000 is its conservative end** — taken
for the same reason +90 s was taken over +180 s for the exit horizon.

**WHY THIS IS A DECISION ON EVIDENCE AND NOT A TUNED CONSTANT**, stated so a future reader
can check rather than trust:

- The entry price of every refused trade is **exact, not modelled**: an unreachable
  `amountOutMinimum` makes the router report its own output, so what a refused trade would
  have filled at is read from the chain rather than estimated.
- **Every launch was probed the same way**, accepted and refused alike, so nothing branches
  on the outcome being measured.
- The result **replicates on two disjoint populations with two different methods** — 100
  oracle-priced launches and 25,367 modelled ones, whose block ranges do not overlap at
  all.
- **The failures are recorded beside it.** MIDPOINT is flat at every bound and no bound
  rescues it; the argmax is a plateau; the objective's own 34% answer is rejected as an
  artefact; and the whole pass is biased toward widening by the `no-exit = 0` convention,
  which was re-run at `−1` and changed nothing.
- **The individual records were checked**, with counter-examples: the three refused trades
  that LOST carry the three smallest shortfalls in the set.

**WHAT DOES NOT CHANGE.** The bound is still OURS and not theirs — the 9 of 9 native-ETH
buys observed on this chain set `amountOutMinimum` to 0 and take no protection whatever,
and that is still not copied. **`buildSwap` still REFUSES a non-positive bound rather than
defaulting it.**

**WHAT WOULD MOVE IT AGAIN: logged LIVE slippage, which does not exist.** Every figure
behind 1,000 bps is a simulation against historical state, and the quantity that would
re-derive it — what our own fills actually cost — has never been observed.

#### THE RETRY LADDER IS RE-DERIVED, AND IT GOT SHORTER RATHER THAN RESCALED

`EXIT_RETRY.BOUND_BPS` was `[300, 449, 608, 1343]` — the shortfall quantiles over the
launches a 300 bps first rung missed. **That set is a function of the first rung**, so at
1,000 bps the old ladder was answering a question the bot no longer asks, and two of its
rungs now sit below the entry bound and are subsumed by it.

**IT IS NOW `[1000, 1343]`, TWO RUNGS, AND THE SECOND IS A NATURAL BREAK RATHER THAN A
QUANTILE.** At a 1,000 bps first rung exactly **7 of 100** oracle-priced launches still
miss, and they split perfectly:

```
4 launches need EXACTLY 1343 bps   -> all four HAVE an exit, all return +138.4%
3 launches need 6067 / 6401 / 8445 -> all three have NO EXIT AT ALL
```

**The gap between 1,343 and 6,067 bps coincides exactly with the dead-pool boundary.**
Every launch a third rung could reach is a pool nothing will buy at any price — which is
the finding the retry drill and the boot fixture both produced from the other direction:
*a retry ladder rescues a mispriced quote, not a dead pool.*

**THE NAIVE QUANTILES WOULD HAVE SHIPPED A DEFECT.** At n=7 the p25 and the median are
both 1,343, so the mechanical derivation gives `[1000, 1343, 1343, 6234]` — a **duplicate
rung**, which `exitWithRetry`'s own contract calls one attempt logged twice, plus a final
rung of 62% against a median gross return of 16–18%. **Reading the individual launches
instead of an interpolated quantile is what caught it**, and it is the same lesson the
`1/n_pumps` metric taught in `ROBINHOOD.md`: a value landing on a round function of a
configured count is a property of the arithmetic.

**THE STOPPING RULE IS UNCHANGED IN INTENT AND SHARPER IN EFFECT.** It stopped at the p75
because a rung past it accepts a haircut larger than the position's whole expected gain.
Here the p75 is 6,234 bps, so **the p75 rule and the economic rule now disagree, and the
economic rule wins** — it is the reason the p75 rule existed.

**n IS 4 FOR THE SECOND RUNG**, thinner than the 11 the old ladder rested on, and stated
rather than buried.

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
| gas: buy + sell | $0.071–$0.084 | 200 real receipts per era — still OTHER PEOPLE'S |
| gas: two approvals | **$0.0128** | **MEASURED ON OUR OWN RECEIPTS**, 2026-09-16 — see below |
| RPC, per trade | $0.0021 | 156,872 CU / 34 trades |
| **total** | **$0.177 – $0.190** | **1.8%–1.9% of a $10 position** |

**THE APPROVAL LINE IS THE ONLY ONE THAT IS OURS, AND IT REPLACED AN ESTIMATE THAT WAS 17%
HIGH.** $0.015 came from other traders' receipts at $0.00751 each; our own two came to
$0.0128 for the pair. The table moves by a tenth of a cent and the conclusion does not move
at all — which is the useful result, because it says the remaining external figures are
probably close too. **`gas_usd` is still NULL on every stored row**: no buy or sell of ours
has been mined, so two of the four legs above have never been checked against anything we
paid for. `ROUND_TRIP_GAS_USD` in `bot/config.ts` carries each figure with its provenance
and the loop reports the whole table at the end of every run, so the document is no longer
the only place it exists.

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

### ARE THE REVERTS OPPORTUNITY OR PROTECTION? — MEASURED 2026-09-16

**THEY ARE OPPORTUNITY. The bound was costing money, and it was costing it by ADVERSE
SELECTION rather than by being slightly tight.** `npm run revert-economics`. **The bound
was 300 bps when this was measured and is 1000 bps as of 2026-09-16 on this evidence** —
see *THE BOUND MOVED* in section 4. Read the figures here as the case for that change, not as a
description of the current configuration.

#### THE METHOD, AND WHY THE ENTRY PRICE OF A REFUSED TRADE IS EXACT

`V4TooLittleReceived(uint256,uint256)` carries `(minAmountOutReceived, amountReceived)`, so
an unreachable `amountOutMinimum` turns the router into an oracle for its own output at our
size and block — the mechanism the quote fix already established. **Every launch is probed
the same way, accepted and refused alike**, so nothing branches on the outcome being
measured. Had the bound admitted a refused trade we would have filled at `amountIn /
amountReceived`, which already contains the fee and our own impact, and the exit is the
first trade strictly after the mark exactly as the published grid does.

**Refusal is MONOTONE in the bound** — `minOut = floor(quoted x (10000-b)/10000)` — so each
launch has one critical bound and every candidate bound is arithmetic over one simulation
rather than another simulation. The accept test uses `minOut`'s own integer arithmetic and
**the run asserts it agrees with the real `rule.minOut()` on all 100 launches: 0
disagreements**, because a float threshold shadowing an integer policy is the trap this
document records six times.

```
bot launches            107      ground truth obtained   100
no oracle answer          7      all "execution reverted" for another reason — excluded
                                 from every figure rather than folded in at zero
9,202 CU = $0.0041
```

#### QUESTION 2: THE REFUSED TRADES ARE THE BETTER TRADES, IN EVERY POPULATION

At the configured +90 s, denominator every qualifying launch, no-exit scoring zero:

| population | n | accepted median | refused median | accepted exit | refused exit |
|---|---|---|---|---|---|
| **BOT, oracle ground truth** | 100 | +0.202 | **+0.462** | 90.5% | 78.4% |
| HOLDOUT-ERA, modelled | 23,979 | +0.588 | **+0.764** | 66.6% | **83.2%** |
| MIDPOINT | 483 | 0.000 | **+0.354** | 44.8% | **87.7%** |
| CALM | 283 | 0.000 | **+0.499** | 50.7% | **83.7%** |
| SELLOFF | 622 | +0.021 | **+0.430** | 59.4% | **76.2%** |
| **POST-CORPUS pooled** | **1,388** | **0.000** | **+0.439** | **51.4%** | **80.5%** |

**In the recent era — the one this document says is the expectation — the trades our bound
ADMITS have a median return of exactly ZERO, and the ones it REFUSES have a median of
+0.44.** That is not a tight bound, it is a bound pointed the wrong way.

**THE MECHANISM IS ADVERSE SELECTION, AND THE EXIT COLUMN IS WHERE IT SHOWS.** In all four
historical windows the refused trades have BETTER exit availability than the accepted ones,
and accepted exit-availability rises monotonically as the bound widens — 51.4% → 56.6% →
60.5% → 62.2% at 300/500/1000/2000 bps in the post-corpus set. **The bound fires when a
pool's price moved away from our quote in the seconds before execution, and a pool whose
price is moving is a pool that is trading.** Our bound is therefore selecting, with some
precision, for pools where nothing is happening.

**THE BOT'S OWN SET IS THE ONE PLACE THE EXIT COLUMN POINTS THE OTHER WAY** — 78.4% refused
against 90.5% accepted — and it is stated rather than smoothed. It is n=100 against 25,367,
and it is the only disagreement between the two datasets.

#### QUESTION 3: BANDED BY SHORTFALL, AND THE BANDS ARE NOT ALIKE

Ground truth, 37 refused at 300 bps. `ratio` = our bound / what the pool would actually pay:

| band | n | exit found | median | % positive |
|---|---|---|---|---|
| marginal `< 1.04` | 21 | 90.5% | +0.126 | 76.2% |
| **mid `1.04–1.20`** | 13 | 76.9% | **+1.384** | 76.9% |
| wide `1.20–2.55` | 1 | **0%** | 0 | 0% |
| extreme `>= 2.55` | 2 | **0%** | 0 | 0% |

**The bound is refusing 34 tradeable launches to avoid 3 dead pools.** The three in the
wide and extreme bands have ZERO exit availability — nothing would have bought them at any
price, which is exactly the "a retry ladder rescues a mispriced quote, not a dead pool"
finding arriving from the entry side. That protection is real and it is 3% of the sample.

**In the post-corpus historical set the extreme band is EMPTY — 0 of 590 refusals** — and
the three populated bands run +0.343 / +0.586 / +0.359 on 82.8% / 76.4% / 90.4% exit
availability. **There, the bound buys no protection at all.**

#### THE INDIVIDUAL RECORDS, AND THE COUNTER-EXAMPLES ARE THE INTERESTING HALF

A bound is a definition, and `CLAUDE.md` requires a definition change to be proven on
individual records before an aggregate is acted on. The five best refused launches:

```
trade 124 pool 0x6b8dc58aa9f87b86… fee 500  shortfall x1.0620  1.825e-10 -> 8.228e-10  +350.8%
trade 126 pool 0x4ffbc47125bc1a21… fee 500  shortfall x1.0733  2.448e-10 -> 7.238e-10  +195.7%
trade 153 pool 0xe86f34219e6afbcd… fee 500  shortfall x1.0756  2.989e-10 -> 8.643e-10  +189.1%
```

**And every one of the three refused trades that LOST has one of the SMALLEST shortfalls in
the set** — x1.0025, x1.0031, x1.0068, returning −15.8%, −19.6% and −20.9%:

```
trade 159 pool 0xc07b374d15e3f1a1… shortfall x1.0025  4.813e-11 -> 4.051e-11  -15.8%
trade 143 pool 0x95483524455d740e… shortfall x1.0031  5.038e-11 -> 4.050e-11  -19.6%
trade 156 pool 0x846f4da8f2e4c1b7… shortfall x1.0068  5.119e-11 -> 4.049e-11  -20.9%
```

**SO WITHIN THE REFUSED SET, MISSING BY MORE PREDICTED DOING BETTER** — which is the
momentum reading of the whole finding, visible in individual records rather than inferred
from a mean. **IT IS A HYPOTHESIS AND NOT ESTABLISHED**: the post-corpus bands are NOT
monotone in the same way (mid +0.586 beats wide +0.359), so the pattern holds in n=29 and
does not replicate cleanly at n=590.

**One thing noticed and not chased:** those three losers exit at 4.049e-11, 4.050e-11 and
4.051e-11 — three different pools agreeing to four significant figures. Consistent with a
launchpad minting from one template, and recorded rather than passed over.

#### QUESTION 4: THE DERIVED BOUND — AND THE OBJECTIVE AS SPECIFIED IS NOT USABLE

Median return over every qualifying launch, refused scoring zero, no-fill zero:

| bound | BOT median (n=100) | BOT revert | POST-CORPUS median (n=1,388) | POST-CORPUS revert |
|---|---|---|---|---|
| **300 (current)** | **+0.098** | **37%** | **0.000** | **42.5%** |
| 500 | +0.155 | 18% | 0.000 | 30.8% |
| 1000 | +0.181 | 7% | 0.000 | 14.6% |
| 2000 | +0.205 | 3% | +0.091 | 5.2% |
| argmax | +0.205 at **1350** | 3% | +0.184 at **3800** | 0.1% |

**THE ARGMAX IS A PLATEAU, NOT A PEAK, AND REPORTING ITS LEFT EDGE WOULD BE PRESENTING A
TIE AS A FINDING.** The objective is identical at every bound from 1350 to 9400 on the bot
set and from 3800 to 9400 post-corpus. **The objective as specified therefore does not
identify a bound** — it says only "wider than 300", and its maximum is wherever the loop
happens to reach first.

**AND IT SAYS 34% FOR A REASON THAT IS ARITHMETIC RATHER THAN ECONOMIC.** More than half of
all launches contribute exactly zero at the current bound, so the median is pinned at 0 and
jumps when widening pushes the zero mass below the 50th percentile. The objective is
measuring *what fraction of launches produce a positive outcome*, not the size of returns.

**THE ECONOMIC CEILING IS THE ONE THIS DOCUMENT ALREADY DERIVED FOR THE RETRY LADDER**, and
it binds far below the plateau: the ladder stops at the p75 because *any bound past it
guarantees a loss larger than the position's whole expected gain*. The recent-era median
gross at +90 s is **+0.157 to +0.180**, so **a bound above roughly 1,600 bps is
self-defeating by definition** — it accepts a haircut bigger than the trade's own expected
return. **The defensible range is therefore 1,000–1,600 bps, and the operator decides
inside it.** At 1,000 bps the bot-set revert rate falls 37% → 7% and the post-corpus falls
42.5% → 14.6%.

**THE `no-exit = 0` CONVENTION DID NOT CHANGE THE ANSWER, AND IT WAS CHECKED RATHER THAN
ASSUMED.** A position nothing will buy is a total loss, not a flat trade, so the whole
derivation was re-run at `no-exit = −1`: **identical at every bound, on both populations.**
The reason is structural — the no-exit mass sits below the median either way, so the median
never crosses it. That is a robustness result and it is the one place where a convention
this document worried about turned out not to matter.

#### QUESTION 5: THERE IS NO DRIFT TO EXPLAIN

**29.2 → 31.3 → 32.4 → 40.6% IS SAMPLING NOISE AT n = 16–34.** Against the pooled 34.0%
(36 of 106):

| run | n | reverted | rate | standard error | z |
|---|---|---|---|---|---|
| 1 | 24 | 7 | 29.2% | 9.7% | −0.50 |
| 2 | 16 | 5 | 31.2% | 11.8% | −0.23 |
| 3 | 34 | 11 | 32.4% | 8.1% | −0.20 |
| 4 | 32 | 13 | 40.6% | 8.4% | **+0.80** |

**Every run is inside 0.8 standard errors of the pooled rate.** There is no trend here and
there never was one; four points that each sit within one standard error of a constant are
a constant.

**The second check says the same thing from the other side.** Re-quoted with today's single
quote implementation at the canonical entry block, the refusal rate per run is **35.9% /
40.0% / 36.7%** — flat — and the two candidate causes are both absent:

- **The over-quote did not grow.** Median 1.021 → 1.026 → 1.027, and the p90 FELL, 1.155 →
  1.096 → 1.107.
- **The launchpad mix moved and the rate did not follow.** `0x58daec31…` ran 54% → 27% →
  40% of launches while the revert rate stayed inside 36–40%.
- Pool depth did not move monotonically either: our size over the first swap's notional ran
  0.074 → 0.089 → 0.059.

**A caveat that belongs with this, not buried:** the re-quote is a reconstruction, not a
replay — the live runs simulated at `latest` at the moment they decided, while this probes
at the canonical entry block with one quote. **36 of 100 verdicts differ between the two**,
which is why the as-run series and the re-quoted series are reported separately and neither
is called the other.

#### QUESTION 6: THE HISTORICAL WINDOWS, AND WHAT IS MODELLED IN THEM

**25,367 launches across the four swept windows**, zero CU, on the pre-committed
`md5(pool_id)` split. `actualOut` there is **MODELLED** as the price a real trade got at our
entry mark — a genuine trade at a genuine price, missing only our own marginal impact,
which is measured at a 0.17% median and has fired twice in 66 live trades. `b*` is nearly
size-independent because `amountIn` cancels out of the quoted price except inside that
impact term, so the reconstruction barely depends on each era's ETH/USD.

**THE MODEL COULD NOT BE SCORED AGAINST THE ORACLE ON THE SAME POOLS, AND THAT IS STATED
RATHER THAN SKIPPED.** The bot's launches sit at blocks 64,385,531–64,897,470 and the
SELLOFF window ends at 64,216,393: **the overlap is exactly zero.** What the two give
instead is arguably better — **two disjoint populations, two different methods, the same
conclusion in the same direction.**

**MIDPOINT IS THE ONE WINDOW WHERE WIDENING DOES NOTHING**, and it is the window this
document already records as flat at every exit horizon: `median_all` is 0.000 at every bound
from 0 to 9,400, and `beats_current` is FALSE. **A bound change is not a fix for a window
where the entry has no edge** — the identical conclusion the exit-horizon study reached.

#### WHAT THIS DOES NOT SETTLE

- **Widening admits trades, it does not make them fill.** Every figure here is
  mark-to-market against a later trade in the pool; `fill_status` is still the literal
  `dry-run` and nothing models winning a fill against competing buyers in the same block.
- **The exit leg is unchanged and still borrowed.** A wider entry bound puts the bot into
  more positions, and the exit is the leg this document calls its most important open
  question.
- **Costs do not bind but they do not vanish.** A round trip is 1.8–1.9% of a $10 position;
  at a 1,000 bps bound the accepted haircut is up to 10% on top of that, which is inside the
  recent-era median gross and nowhere near it at 3,400.

### LIVE MODE BUILT AND PROVEN OFF — 2026-09-16

The design is section 2A. This is what running it produced, on the deployed container
carrying commit `a972e78`, verified from `/app/dist` before anything was launched.

**THE STATIC GATE, over the deployed source:** 135 files, 2 permitted comment mentions,
every rule confined, `PASS`, exit 0. **And it is known to be able to fail** — a probe file
containing `process.env['BOT_PRIVATE_KEY']` made it exit 1 naming the file and line, and
removing it passed again.

**THE RUNTIME DRILL: 20 of 20**, `BOT_PRIVATE_KEY` not set, so the no-key case is a real
demonstration rather than a vacuous one — which the drill reports either way.

**`launchbot --live` ON THE REAL CONTAINER, exit code 1:**

```
WARN  LIVE MODE REQUESTED   mode=live
      the explicit flag was passed. Every gate below must clear before anything can be
      signed, and no key exists in this build.
ERROR REFUSING TO ARM IN LIVE MODE: 4 prerequisite(s) outstanding.
  1. [sell-not-broadcast] ... a live BUY with a simulated SELL opens real positions the
     bot cannot close ...
  2. [approvals-not-executed] ...
launchbot --live EXIT=1
```

**It refused BEFORE reading a balance, reconciling a row or spending a compute unit** —
the live gate is ordered first in the boot sequence for exactly that reason.

**AND THE ENV VAR RAISES RATHER THAN BEING IGNORED**, which was the requirement that live
can never be enabled by a variable alone:

```
BOT_LIVE=1 node dist/cli/launchbot.js --minutes 1   ->  EXIT=1
   "BOT_LIVE is set to "1", and it does NOT control live mode."
```

Note what that means: **setting the variable does not quietly give you a dry run either.**
The process refuses outright, so an operator who believed the variable was the control
finds out immediately rather than watching a "live" run that is a simulation.

**`approve-setup`, READ HALF, against the USDG dust the wallet holds:**

```
owner 0x4ab5…cb4a   token 0x5fc5…d168   amount_raw 1   (sized from the BALANCE)
step 1  token.approve(Permit2, 1)              current allowance 0        SEND
step 2  Permit2.approve(token, router, 1, exp) current 0, expiration 0    SEND
DRY RUN — NOTHING SENT        exit 0
```

Both allowance reads succeeded against the real contracts, so **Permit2 exists and answers
at `0x0000…78ba3`** — previously an address taken from a measurement, now a contract that
has been called. **The write half refused as designed:**

```
approve-setup --live --commit   ->  EXIT=1
   "LIVE MODE REQUIRES BOT_PRIVATE_KEY AND IT IS NOT SET"
```

That is the real call site reaching `createBroadcaster` and being refused there, not a
drill.

#### THE DRY RUN STILL WORKS, AND THE NEW BOUND SHOWS ITS FIRST LIVE SIGN

The mode refactor rewired how `launchbot` decides its mode, so a plain dry run was re-run
to confirm nothing broke — `mode dry-run-gate`, 12 ticks, 1,858 CU:

```
qualified 3   simulated 3   simClean 3   simReverted 0   slippage_bps 1000
```

**ZERO REVERTS OF THREE, where 300 bps measured 29.2 / 31.3 / 32.4 / 40.6% across four
runs.** `revert-economics` predicted the rate would fall to about 7% at this bound, and
3 of 3 is consistent with that — **but n=3 is three observations and this is not evidence
of anything.** It is recorded because it is the first live data point in the direction the
offline measurement predicted, and the figure to watch on the next full run is the revert
rate against that 7%.

### THE RECEIPT TIMEOUT, MEASURED — 2026-09-16

`npm run receipt-timing --samples 60`, 2,970 CU. It runs **the same poll loop `exit-exec`
runs after a broadcast**, against the same endpoint, the instant a block appears at head —
so the figure is the one that matters rather than a proxy for it.

#### THE TIMEOUT COVERS TWO THINGS AND ONLY ONE IS MEASURABLE WITHOUT A KEY

| | | |
|---|---|---|
| **B. RECEIPT AVAILABILITY** | **MEASURED** | **60 of 60 served on the FIRST ask.** median 20 ms, p90 24 ms, max 36 ms, 0 reached the cap |
| **A. INCLUSION** | **NOT MEASURED** | nothing here can send, and another party's submission time is in no available method |

**There is effectively no indexing lag on this endpoint**: once a block is at head, its
receipts are queryable immediately. That is the half the loop was written to survive, and
it turns out to cost nothing.

**A IS THE DOMINANT TERM AND IT IS BOUNDED RATHER THAN MEASURED.** Observing somebody
else's transaction cannot substitute: a transaction in a block carries no record of when it
was offered, and the mempool is in none of these methods. What the run does bound it with:

```
block interval        100.52 ms   6,936 ms of wall clock over 69 blocks
congestion            gas used median 1.27 M, max 9.55 M, against a 2^50 nominal limit
tx per block          median 8, max 48
head retreats         0 observed
```

**THE BLOCK INTERVAL INDEPENDENTLY REPRODUCES `ROBINHOOD.md`'S ~101 ms BY A DIFFERENT
METHOD.** That document measured it from chain timestamps over 935,564 blocks and 94,548 s;
this measured wall clock through the Alchemy endpoint over 69 blocks. **Two methods, two
orders of magnitude apart in sample size, agreeing to half a percent** — which is worth
more than either alone, and is the first confirmation of that constant from outside its own
derivation.

**Congestion is not a factor**, so a fee-paying transaction should be included in the next
block or two — an inference from the gas figures, not an observation of our own
transaction, and labelled as such.

#### THE VALUE STAYS AT 60 s, AND IS NOW JUSTIFIED RATHER THAN ARBITRARY

The expected total is **~250 ms**, so the constant is **240x it**. That margin is deliberate:

- **THE ASYMMETRY IS SEVERE.** Firing early raises `ExitUnrecoverableError`, stops the
  ladder at one transaction, and leaves a position for a human to reconcile against the
  chain. Firing late only makes the bot wait on a $10 position.
- **THE DOMINANT TERM IS UNMEASURED.** Tightening towards a figure whose largest component
  has never been observed would be deriving precision from the half that happens to be
  measurable — a bound of one's own presented as a fact, which is the failure this document
  keeps recording.

**WHAT NO TIMEOUT COVERS:** a transaction never included at all — underpriced or dropped.
Nothing distinguishes that from a slow one, which is exactly why reaching this bound raises
UNRECOVERABLE rather than counting as a failed attempt.

#### IT IS NOW INSTRUMENTED, SO THE UNMEASURED HALF MEASURES ITSELF

`bot_exit_attempts` gains **`receipt_wait_ms`** and **`receipt_polls`**, written on every
broadcast attempt. **The first real exits therefore measure the inclusion half that this
pass could not**, from our own transactions rather than from other people's blocks, and the
timeout is re-derived from that rather than staying a margin for ever.

Verified on a fresh connection: both columns exist, and **0 of 43 attempt rows carry a
timing — because no exit has ever been broadcast.** That zero is the honest state of it.

#### TWO DEFECTS THIS MEASUREMENT FOUND IN ITSELF, AND ONE IN THE SCHEMA

**THE FIRST RUN REPORTED A 155 ms BLOCK INTERVAL, AND IT WAS MEASURING MY OWN POLL RATE.**
Against `ROBINHOOD.md`'s ~101 ms, 53% high. The cause: at a ~115 ms effective poll period
head sometimes advances TWO blocks between observations, and the tool counted that as one
gap. **10 of 59 observations did exactly that.** The fix is to record how many blocks head
advanced and divide elapsed by BLOCKS, which is immune to the poll rate — and the corrected
figure is the 100.52 ms above.

**This is the third instance of one shape in this document**: `surv_1h` reading 0.02%
because it measured its own window cap, the +600 s horizon reading exactly 0.00000 because
it asked for a trade after its own last tick, and now a block interval reading the
sampler's period. **A figure that disagrees with an established constant by tens of percent
is the tell**, and the established constant is what caught it.

**THE FIRST RUN ALSO REPORTED CONGESTION AS 0% AT BOTH THE MEDIAN AND THE MAX**, which
tells a reader nothing and is indistinguishable from a statistic never computed. The raw
figures are now reported beside it — and they are the interesting part: the gas limit is
`2^50`, a nominal value, so the percentage was always going to be meaningless and the
absolute gas used is the only informative number.

**AND THE SCHEMA CHANGE HAD TWO BUGS, ONE OF WHICH ANNOUNCED ITSELF.** The `alter table`
statements were first written ABOVE the `create table if not exists` they alter — which
would have worked on this container, where the table already exists, **and failed on a
rebuild**, since an alter on a missing table is an error that aborts the whole statement.
That is the shape `ROBINHOOD.md` records for `token_swap_logs`. The second bug was louder:
the comment explaining the first used backticks to quote SQL identifiers, and `BOT_SCHEMA`
is a backtick template literal, so it terminated the string and broke the build instantly.

### THE KEY ARRIVED, AND WHAT WAS CONFIRMED — 2026-09-16

`BOT_PRIVATE_KEY` is set as a Railway service variable. **The signer reads it, and it
controls exactly the expected address.**

```
npm run signer-check -- --live --expect 0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a

key_variable            BOT_PRIVATE_KEY    present, 66 chars (= 0x + 64 hex)
derived_address         0x4ab56f6a15b7b17948c624c68462c2b825d2cb4a
expected_address        0x4ab56f6a15b7b17948c624c68462c2b825d2cb4a
MATCHES                 TRUE
chain_id_confirmed      4663
builds_a_transaction    false          60 CU, exit 0
```

**THE KEY IS NEVER LOGGED, RETURNED OR TRANSMITTED.** Only its LENGTH is reported, because
a wrong-length value is the likeliest way a key is mis-pasted and a length is not secret.
Nothing in this document, any log line or any stored row contains any part of it.

#### WHY THIS NEEDED A NEW CLI RATHER THAN AN EXISTING PATH

Neither existing route could answer "does this key control the address we think it does"
safely. `launchbot --live` refuses at `assertLiveReady` **before** `createBroadcaster` is
reached, so it never derives an address at all. `approve-setup --live` without `--commit`
exits before the broadcaster is built, and **with** `--commit` it would BROADCAST —
**confirming a key by sending a transaction is the opposite of confirming it first.**

`signer-check` calls the one function the live path uses, reports the address, and stops.

**IT CANNOT BROADCAST, STRUCTURALLY.** It hands `createBroadcaster` a **`ReadOnlyRpc`**,
so the signer it returns has a transport that refuses all 8 broadcast and signing methods
by name — even a future edit calling `.send()` there would be refused by the transport
rather than by this file's good intentions. No calldata, no nonce read, no gas estimate.

**`--expect` IS REQUIRED AND ITS COMPARISON IS THE TOOL'S OWN.** The guard inside
`createBroadcaster` compares the derived address against `BOT_WALLET_ADDRESS` — and is
**skipped entirely when that variable is unset**, so relying on it would let "confirmed"
mean "nothing was compared".

#### THE DRILL'S CASE 6 LOST ITS PREMISE, AND SAID SO

`live-gate-drill` asserted *live mode with no key refuses at startup*. A key now exists, so
that premise is gone — and **section 8 step 4 predicted this in advance**: *"case 6 becomes
vacuous the moment a key exists and the drill SAYS SO."*

The expectation now follows the world and **asserts the opposite instead**: with a key
present, live mode must CONSTRUCT a signer. That is not a softer test, it is a different
and equally real one — **it is the only way to tell "the gate is off" from "the feature was
never built"**. The drill reports which assertion it made, so a pass here cannot be read as
proof of the other. **20 of 20**, and the no-key refusal stands on the runs made before the
key arrived, recorded in 2A.

#### AND ENUMERATING THE PREREQUISITES FOUND A DEFECT THE KEY MADE LIVE

`launchbot`'s wallet gate carried this note: *"a dry run may proceed without one ... **a
live mode must not, and none exists**"*. It was written when live mode did not exist, so
the second clause was a description of the world rather than a guarantee — **and nothing
enforced it.** The branch warned and carried on.

**So a live run would have armed with no balance check at all**, leaving the capital rails
bounded by running out of money rather than by the rails. `ROBINHOOD.md` rule 3 exactly: a
documented guarantee the code does not implement is a defect in the code, always in that
direction.

**It was masked only because `assertLiveReady` refuses first** — it would have surfaced the
moment the prerequisites list emptied, which is the worst possible time to find it. A live
run with no `BOT_WALLET_ADDRESS` now RAISES, naming both consequences: no balance to gate
on, and the in-signer address guard inert.

#### WHAT THE KEY'S PRESENCE CHANGES ELSEWHERE, STATED RATHER THAN ASSUMED

The variable is on the SERVICE, so it is in the environment of **every** process in that
container — including the scheduler running the nine monitors. **Nothing in that path can
reach it**: `check-live-gate` confines every read of the variable to `bot/signer.ts`, and
no monitor calls `createBroadcaster`. It is inert there rather than merely unused.

**And setting it replaced the container**, as `ROBINHOOD.md` says a variable change does —
deployment `4757e002`, pid 1 restarting at 01:52:54. Nothing was running, so nothing was
lost; the commit was re-verified from `/app/dist` before any of the above ran.

### THE 7 STUCK ROWS ARE RESOLVED, AND RESOLVING THEM FOUND THE REAL HAZARD — 2026-09-16

`BOT_WALLET_ADDRESS` set to the wallet, and all 7 `needs_exit` rows resolved. **The
interesting part is what the second half exposed.**

#### THE SEVEN, AND HOW EACH WAS ESTABLISHED

The boot sweep processes `order by id`, and **137 is first** — so if it exhausts, the other
six are never reached. That was checked before booting rather than discovered:

| | outcome | evidence |
|---|---|---|
| **137** | `closed_unsellable` | ladder exhausted with **`actual=0` at BOTH rungs** — the pool pays nothing |
| 141, 144, 153, 157, 158, 162 | `closed_unfilled` | the borrowed holder holds none of the token; *"now holds nothing on chain"* |

**All seven shared ONE borrowed holder**, which had sold six of the tokens and still held
137's. The boot halted the chain on 137 exactly as section 4 said it would, the other six
were untouched, and a second boot after 137 was resolved cleared them and reported *"every
needs_exit row is resolved; the bot may now arm"*.

**THE NEW 2-RUNG LADDER REACHED THE SAME ANSWER IN TWO ATTEMPTS** where the old four would
have spent two more on a pool paying zero — the re-derivation earning its keep on its
first real use.

#### `resolve-unsellable` PROVES THE PREMISE, AND IT REFUSED TWICE

A tool that marks a position unsellable because somebody said so is a tool for making an
inconvenient loss disappear. So it re-establishes the premise through **`executeExit`
itself**, with no broadcaster, and branches on what the chain says. **It refused on two of
the five it was pointed at** — trades 334 and 335, whose pools reported paying MORE than
zero:

> *"exhausted the ladder but the pool did NOT report paying zero … that is a MISPRICED
> QUOTE or a bound too tight, not a dead pool — the position is sellable at some price and
> marking it unsellable would hide that."*

**That refusal is the tool working**, and it is the ladder's own distinction — *a retry
rescues a mispriced quote, not a dead pool* — arriving from the bookkeeping side.

#### THE HAZARD IS THE DRY-RUN LIFECYCLE, NOT SEVEN ROWS — AND IT RECURRED IN MINUTES

Four `holding` rows left by this session's own verification runs (their 1-minute windows
ended before the +90 s exit came due) were cleaned up by booting their modes. **That
re-created the exact condition and re-halted the chain**, and the mechanism is deterministic:

```
reconcileOnBoot reads the BORROWED holder's balance   (deliberate: asking OUR balance
                                                       would report every hypothetical
                                                       position as closed)
  -> the borrowed holder usually still holds
  -> the row becomes needs_exit
  -> the sweep tries to sell a dead launch pool AS SOMEBODY ELSE
  -> exhausts -> halt(), chain-wide
```

**So `stuck-rows-can-halt` was the wrong prerequisite.** It named seven rows; the condition
is that **any dry run ending with an open position arms a landmine for its next boot.** It
is renamed `dry-run-boot-halts-the-chain` and its closing condition is now section 4's open
item — **automatic halts scoped to the mode that raised them** — not a one-off cleanup.

#### AND A DRY-RUN ROW IS A SIMULATION, NOT A POSITION

334 and 335 could be resolved by neither path: the unsellable route refused (their pools
pay), and the boot sweep would exhaust and halt again. **They would have sat in
`needs_exit` for ever with a chain-wide halt attached.**

The way out is to stop treating them as positions. A dry-run row **was never broadcast, so
we hold nothing** — and that is verified rather than assumed: `--simulated` reads OUR
balance and requires zero, and refuses on a live mode by `isDryRunMode`. Both read 0 while
their borrowed holders held 7.5e23 and 1.2e24, which is the whole point: **the borrowed
holder's balance is evidence about the borrowed holder.** Resolved `closed_simulated`.

#### FINAL STATE, ON A FRESH CONNECTION

```
the 7 rows        137 closed_unsellable | 141,144,153,157,158,162 closed_unfilled
the 4 leftovers   333,338 closed_unsellable (actual=0) | 334,335 closed_simulated
rows still HELD   RETURNED NO ROWS
deployed capital  $0.00 over 0 positions
kill switch       halted FALSE, reason names what was resolved and how
```

**The halt was cleared last, and only then** — the clearing guard refuses while any
`needs_exit` row remains anywhere on the chain, which is why it had to be. It refused
correctly when tried early.

### THE FIRST REAL TRANSACTIONS — 2026-09-16

**`npm run approve-setup -- --token <USDG> --live --commit`.** Two approvals, both mined.
The first signatures this project has ever produced, and deliberately **not a trade**:

```
STEP 1  0x999fdb793e25d2bc71f4889acd5d27e4fca79be60a0ff4496023240985402669
        USDG.approve(Permit2, 1)              nonce 130  block 65,017,856  status 1
        type 2   gasUsed 57,892   effectiveGasPrice 50,770,000
STEP 2  0x178977d39724dd5d4f11415611d9d6bc568549857b8e8ad5a08fa6a664d955c0
        Permit2.approve(USDG, UniversalRouter, 1, expiry)
                                              nonce 131  block 65,017,859  status 1
        type 2   gasUsed 47,554   effectiveGasPrice 49,080,000
TOTAL   0.00000527312716 ETH = $0.0128        nonce 130 -> 132
```

**THE AMOUNT IS ONE RAW UNIT OF USDG — 0.000001.** The only token the wallet held, which is
what section 8 step 5 specified, and the point of it: *if the nonce handling, the gas
estimation, the chain id or the encoding is wrong, it is wrong on a call that moves
nothing.* **It was wrong twice, and both times nothing moved.**

#### DEFECT 1: THE SIGNER WAS HANDED THE READ-ONLY TRANSPORT

The first attempt was refused by our own deny-list:

> *eth_sendRawTransaction is refused by ReadOnlyRpc BY NAME, in every mode including live.*

`createBroadcaster(mode, rpc)` was passing a `ReadOnlyRpc`, while a `BroadcastRpc` was
built beside it and **thrown away with `void sender`**. Nothing was signed and no gas was
spent.

**THE LAYERED DEFENCE WORKED, AND THE TELL WAS AN UNUSED VARIABLE IN A MONEY PATH.** The
thing that was supposed to be able to broadcast could not, and it failed loudly rather than
doing something else. Worth recording that **the identical line is correct in
`signer-check`**, which hands `createBroadcaster` a read-only transport deliberately so the
signer it builds cannot send — a feature there and a defect here, which is why the
transport is now chosen explicitly at each call site instead of being whatever variable was
in scope.

#### DEFECT 2: A LEGACY TRANSACTION ON A CHAIN WITH A BASE FEE

The second attempt was rejected by the node:

> *max fee per gas less than block base fee: maxFeePerGas 49,556,000 baseFee 49,626,000*

**Two faults in one line.** The signer built a LEGACY (type 0) transaction, and this chain
has a base fee — so `gasPrice` must be at or above it, and `eth_gasPrice` was **0.14% below
the base fee** by the time the node saw it. At the measured 100.52 ms block interval the
base fee moves between the read and the send, so a figure used verbatim loses that race at
random.

**HEADROOM IS FREE UNDER EIP-1559 AND IS NOT UNDER LEGACY**, which is why the fix was to
change the transaction TYPE rather than add a margin. A type-2 transaction is charged
`baseFee + tip` and the remainder of `maxFeePerGas` is never spent; a legacy one is charged
its whole `gasPrice`, so the same margin would be paid on every transaction for ever.
**The receipts confirm it**: `maxFeePerGas` 101,040,000 against 50,770,000 actually charged
— the headroom was carried and not spent.

**`maxPriorityFeePerGas` came back 0** from `eth_maxPriorityFeePerGas`, so this chain has no
priority market and `effectiveGasPrice` is the base fee. Recorded because a tip of zero is
a real answer here and would look like a defect anywhere else.

**Nothing landed from either failure and the nonce was not consumed** — still 130 before the
successful attempt, verified from the chain.

#### THE INCLUSION HALF OF THE RECEIPT TIMEOUT IS NOW MEASURED

`receipt-timing` could measure receipt AVAILABILITY exactly and **could not measure
inclusion**, because nothing could send. These two transactions are the first measurement
of it:

```
STEP 1   receipt_wait_ms 20   receipt_polls 1
STEP 2   receipt_wait_ms 16   receipt_polls 1
```

**Both served on the FIRST poll**, and that wait spans submission through inclusion to
availability. So the 60,000 ms timeout is roughly **3,000x the measured total** — the margin
this document argued for on asymmetry grounds now has data under it rather than only
reasoning. `bot_exit_attempts.receipt_wait_ms` captures the same figure for every future
broadcast.

#### AND THE FIRST GAS FIGURE THIS PROJECT HAS FROM ITS OWN TRANSACTIONS

Every gas cost in this document has come from **other people's receipts**. Section 2
measured an approval at $0.00751, so $0.015 for the pair.

**Measured on our own: $0.0128.** The external figure was **17% high**, which is close
enough to leave every costing that rests on it standing — and it is the first time one of
those figures has been checked against a transaction we actually paid for.

#### `approvals-not-executed` IS MET AND IS NOT SIMPLY CLOSED

Both setup transactions have now been executed, so the prerequisite's literal condition is
met. **Closing it there would have marked the risk resolved while the thing that actually
prevents it stayed unbuilt.**

Every token the bot trades is a launch minutes old, so **no allowance for it can predate the
buy** — it has to be granted between the buy and the sell, and nothing in the loop does
that. A live trade would buy, `checkSellReadiness` would correctly refuse to broadcast the
sell, `ExitUnrecoverableError` would halt the mode, and the position would be stuck: the
buy-without-a-sell outcome that `sell-not-broadcast` was closed to prevent, arriving by a
different route.

It is therefore replaced by **`approvals-not-inline`**, and the cost is now known rather
than estimated: **$0.0128 per token per trade, 0.13% of a $10 position.**

### THE APPROVALS ARE INLINE, AND THE BUY WAS NEVER BROADCAST — 2026-09-16

The design is section 2D. This is what building and running it produced.

#### THE FINDING THAT CAME FIRST: `broadcaster` NEVER REACHED THE ENTRY

Reading the path end to end before wiring the approvals — which is what closing a
prerequisite is supposed to involve — found that **`broadcaster` was referenced in exactly
three places in `launchbot.ts`, and all three are the exit**: `clearNeedsExit`, the
per-tick sweep's `seller`, and the `executeExit` call. The entry was an `eth_call` and then
an insert.

```
grep -n "broadcaster" src/cli/launchbot.ts   ->  boot construction, then ONLY exit paths
```

So a live run would have opened a `holding` row carrying `fill_status = 'dry-run'` and an
`exit_due_block`, for a position nothing had bought, and tried to sell it ninety seconds
later. **Wiring approvals to that would have satisfied `approvals-not-inline`'s words
exactly** — the loop would have granted allowances for a token it did not hold — which is
the trap `approvals-not-executed` was replaced to avoid one pass earlier, arriving from the
other side.

**IT WAS MASKED BY THE PREREQUISITES LIST REFUSING TO ARM.** That is the second time a
guard has hidden a defect on this bot: the wallet gate's missing raise surfaced only when
the key arrived and somebody enumerated what a live run would do. **A guard that stops a
run also stops anyone finding out what the run would have done**, so a list of what is
missing is not a substitute for reading the path.

#### AND THE SAME DEFECT AS THE FIRST REAL TRANSACTION WAS STILL LIVE IN THE LOOP

`launchbot` built its broadcaster as `createBroadcaster(BOT_MODE, rpc)` — handing the
signer the **`ReadOnlyRpc`**, which refuses `eth_sendRawTransaction` by name in every mode
including live. That is the identical line that made the first real approval fail, and
`approve-setup` was fixed on it the same day. **The other call site kept the defect and
nothing reported it.**

Every send the bot made would have been refused by its own deny-list — loudly, with nothing
signed and no gas spent, which is the layered defence working and is not a reason to have
shipped it. **Fixing a defect at the call site that failed leaves it at every other call
site**, and the only thing that finds the others is reading them. Both now choose the
transport explicitly and by name.

#### THE DRY RUN: THE APPROVAL PATH IS REACHED ON EVERY TRADE AND NOTHING IS SENT

`--run-label approvals --minutes 14`, mode `dry-run-approvals`:

```
ticks 164   initializes 46   candidates 40   qualified 6
simulated 6   simClean 6   simReverted 0        skippedRail 0
approvalPlanBuilt 6   approvalPlanFailed 0   approvalPlanSkipped 0
buysBroadcast 0   approvalsGranted 0   entryReverted 0   entryUnresolved 0
exitsDue 6   exitClean 3   exitReverted 3   ladderRungs {1: 3}
23,748 CU = $0.01069
```

**6 of 6 reached the approval path and built both grants.** The allowances were READ from
the real contracts for the real wallet and came back `0` and `0 expiring 0 (EXPIRED)` every
time — which is the correct answer and the point of the design: *no allowance for a
launch-minute token can predate the buy.* Both steps planned `SEND`, `will_send: false`,
and **`approvalPlanFailed` and `approvalPlanSkipped` are both zero and are reported as
zero.**

**WHAT ONE TRADE WOULD HAVE SENT, in order, from the run's own log:**

```
1. BUY    amountIn=4142052944978300 minOut=16258709345086349298892
2. APPROVE token->Permit2            amount=18065232605651499220992
3. APPROVE Permit2->UniversalRouter  amount=18065232605651499220992
4. (at +90 s) SELL amountIn=18065232605651499220992 minOut=3727847650480470

approvals_amount_from: "the QUOTED output — HYPOTHETICAL, nothing was bought"
```

**THE AMOUNT'S PROVENANCE IS ON THE LINE, AND IT HAS TO BE.** A dry run has no balance to
read, so the plan is sized on the QUOTE and says so. A live trade sizes on the BALANCE read
after the buy mined — which is the whole reason the grant comes after the buy, and the two
figures differ by exactly the quote error the bound exists to absorb. A log line that did
not distinguish them would make a dry-run plan look like what a live trade approves.

**NOTHING WAS BROADCAST, VERIFIED CHAIN-WIDE RATHER THAN PER MODE**: `entry_tx is not null`
returns **0 rows across the whole of `bot_trades`**, `buysBroadcast` and `approvalsGranted`
are 0, and every one of the run's 6 rows carries `fill_status = 'dry-run'`.

#### THE FULL ROUND TRIP, NOW THAT EVERY LEG IS KNOWN

Reported by the run itself rather than only by this document:

| leg | $ | provenance |
|---|---|---|
| gas, buy | 0.0279–0.0405 | ESTIMATED — 200 real receipts per era, other traders |
| **gas, both approvals** | **0.0128** | **MEASURED ON OUR OWN RECEIPTS** |
| gas, sell | 0.04339 | ESTIMATED — median of 40 sampled real sells |
| **gas total** | **0.0841–0.0967** | |
| LP fee, both legs | 0.0654 | run 3's own fee mix, weighted |
| slippage, both legs | 0.026 | realised impact at $10, SELLOFF |
| RPC | 0.00178 | 23,748 CU / 6 trades, this run |
| **TOTAL** | **$0.1773 – $0.1899** | **1.75%–1.88% of a $10 position** |

**ONE OF THE FOUR GAS LEGS IS OURS AND THREE QUARTERS OF THE GAS IS STILL SOMEBODY
ELSE'S.** `gas_usd` is NULL on all **117** stored rows, counted rather than inferred. The figure moved by a tenth of a cent
against the previous table and the conclusion did not move at all — **costs are still not
the binding constraint** against a median gross of +0.374 at +90 s.

#### 0 ENTRY REVERTS OF 6, AND 9 OF 9 CUMULATIVE AT THE NEW BOUND

| run | bound | n | reverted | rate |
|---|---|---|---|---|
| 1–4 | 300 bps | 106 | 36 | **34.0% pooled** |
| gate check | 1000 bps | 3 | 0 | 0% |
| **this run** | **1000 bps** | **6** | **0** | **0%** |

`revert-economics` predicted the rate would fall from 37% to about **7%** at 1,000 bps.
**Nine consecutive clean simulations is consistent with 7% and is not evidence of it** —
at a true 7% the chance of nine clean is 52%, so this run distinguishes nothing. It is
recorded because it is the second sample in the predicted direction and because the figure
to watch on the next full run is the rate against that 7%, not against zero.

#### THE EXIT, AND THE LADDER DID NOT CLIMB ONCE

**3 clean and 3 exhausted, every fill on rung 1.** The three exhausted are the familiar
result rather than a new one: `V4TooLittleReceived … actual=0` at both rungs — *a retry
ladder rescues a mispriced quote, not a dead pool.* The borrowed-holder confound is
unchanged and these say nothing about whether our own exit would work.

**The three `needs_exit` rows this produced were resolved rather than left**, because a dry
run left with an open position arms its own next boot (section 7). `resolve-unsellable
--simulated` read **OUR** balance as `0` on all three against borrowed holders still
holding 2.2e23 — which is the distinction that makes the tool safe — and set
`closed_simulated`. Verified on a fresh connection afterwards: **HELD rows anywhere on the
chain RETURNED NO ROWS, deployed capital $0.00 over 0 positions, kill switch not halted.**

#### THE DRILLS

| drill | result |
|---|---|
| **`approval-drill`** (new) | **13 of 13** |
| `exit-broadcast-drill` | **11 of 11**, including the two cases that changed |
| `rail-drill` | 32 of 32 |
| `live-gate-drill` | 20 of 20 |

**THE ORDERING IS ASSERTED FROM A RECORDED TRACE, NOT FROM A SEND COUNT.** A count cannot
tell "two sends, each confirmed" from "two sends fired back to back", and the second is the
nonce hazard. Every send and every receipt poll is appended to one trace and the invariant
is checked over the sequence — *between any two SENDs there must be a RECEIPT* — and **the
checker is proven able to fail**, by being handed `SEND -> SEND -> RECEIPT` and rejecting
it. A check nobody has made fail is not a check.

**TWO OF THE DRILL'S FIRST THREE FAILURES WERE THE MODULE CORRECTLY REFUSING A FIXTURE I
HAD MIS-SCRIPTED**, which is worth recording because it is the drill working in the
direction nobody designs for:

- The "both short" case granted both allowances and then RAISED, because the fixture left
  the Permit2 expiration at 0 — so the re-read found a non-zero amount that had already
  expired and refused to call it ready. **A real grant sets a future expiry; my fixture did
  not, and `ensureSellReadiness` caught a worthless grant a test intended to be valid.**
- The "expired grant" case did not fire because the drill's injected clock started at 0 and
  the fixture's expiry was 1. The rule was right and the clock was wrong.

The third was mine in the other direction: I scored a throwing broadcast as zero sends.
**A throw is not proof nothing was sent** — the raise says exactly that — so counting it as
zero would have been the plausible-value-on-an-error-path mistake inside the drill written
to catch it. It counts as one send, and what is asserted is that nothing follows it.

#### `exit-broadcast-drill` CASE 7 CHANGED MEANING, AND A NEW CASE PROVES THE CHANGE BOUGHT SOMETHING

Case 7 asserted *allowances short -> UNRECOVERABLE, NOTHING sent*. `exit-exec` now GRANTS
rather than refusing, so "nothing sent" would pass only by the exit having done nothing —
which is what the change exists to stop. It now asserts **NO SELL was sent**, which is the
property that actually matters, and a new case 7b shows the other half:

```
live + allowances short and UNGRANTABLE -> UNRECOVERABLE, NO SELL sent   sells=0
live + allowances short but the GRANT LANDS -> approvals then ONE sell   approvals=2 sells=1
```

**Only the second shows that a position which WAS unsellable becomes sellable.** A
refusal-only path can always be shown to refuse.

### THE LAST PREREQUISITE IS ACCEPTED, AND THE LIST IS EMPTY — 2026-09-16

**`fill-not-modelled` IS ACCEPTED BY THE OPERATOR.** That was always one of its two stated
closing conditions — *"accepted as a known unknown by the operator, or measured from the
first live fills"* — and it is the one that can be reached without trading, because the
other requires the very thing it gates.

```
LIVE_PREREQUISITES.length === 0
npm run launchbot -- --live   NO LONGER REFUSES AT THE PREFLIGHT
```

#### WHAT WAS ACCEPTED, STATED PRECISELY RATHER THAN AS A LABEL

**Every return figure in this document is MARK-TO-MARKET against a later trade in the
pool.** `fill_status` has been the literal `dry-run` on all **117** rows — measured, and it is 117 of 117 rather than "every live row so far", because no live row has ever been written. The entry price is
what a real trade got at our entry mark and the exit price is the first trade strictly after
the horizon — both real prices from real trades, and **neither is a trade of ours.**

What is therefore unmodelled is narrow and it is not small:

- **WINNING THE FILL.** A live buy competes for the same block as everyone else who saw the
  same launch. The measured +0.374 median at +90 s assumes we are in.
- **OUR OWN MARGINAL IMPACT AT THE MOMENT OF THE FILL.** The impact term has fired twice in
  66 live trades, because at +15 s after a pool's first swap almost no pool has the four
  consecutive swaps it needs. So the quote is fee-only in practice and our own $10 moves the
  price by an amount nothing has measured.
- **THE NO-FILL RATE, WHICH IS MEASURED AND IS THE HONEST HALF.** 16.75%–24.21% of rule
  launches never filled in the offline grids, and those were scored ZERO rather than
  dropped. So the published medians already carry a fifth of the population at zero for
  exactly this reason. **What is unmodelled is whether OUR no-fill rate is that one.**

#### WHY IT CANNOT BE CLOSED ANY OTHER WAY, WHICH IS THE WHOLE ARGUMENT

**The quantity is unobservable from outside a live trade.** A transaction in a block carries
no record of when it was offered, the mempool is in none of the available methods, and
`receipt-timing` already established that watching somebody else's transaction cannot
substitute — the same wall that stopped the inclusion half of the receipt timeout being
measured until we sent something ourselves.

So the choice was never "measure it or accept it". It was **accept it and measure it, or
neither.** A prerequisite whose only evidence lies past itself is a prerequisite that never
closes, and keeping it would have been a permanent refusal dressed as diligence.

#### WHAT IS NOW THE ONLY THING BETWEEN `--live` AND A REAL TRADE

This is the part that must be stated plainly rather than left to be inferred. **The
preflight was the gate that could not be satisfied by accident; it is gone.** What remains
is four gates that CAN all be satisfied, and on this container three of them already are:

| gate | satisfied today? |
|---|---|
| an explicit `--live` on the command line, never an env var, never a default | **it is the operator typing it** |
| `BOT_PRIVATE_KEY`, deriving `BOT_WALLET_ADDRESS`, on chain id 4663 | **YES** — confirmed by `signer-check` |
| `BOT_WALLET_ADDRESS` set, balance ≥ `MAX_CONCURRENT × MAX_POSITION_USD` = $50 | **YES** — $126.73 |
| boot reconciliation and the `needs_exit` sweep both clean | **YES** — HELD rows RETURNED NO ROWS |

**SO `npm run launchbot -- --live` NOW TRADES REAL MONEY.** There is no further
confirmation, no second flag, and nothing that will ask. That is the intended state and it
is the reason this entry exists: the document should not have to be read backwards to
discover it.

#### WHAT BOUNDS A MISTAKE, AND IT IS THE RAILS RATHER THAN THE PREFLIGHT

An accidental `--live` — a stray flag, a copied command — is bounded by six hard-coded
rails, every one of them exercised in `rail-drill` (32 of 32):

```
MAX_POSITION_USD        $10 per position
MAX_CONCURRENT          5          -> $50 of open basis at once
MAX_DEPLOYED_USD        $100       -> cost basis + the day's realised LOSSES
MAX_TRADES_PER_DAY      40
MAX_DAILY_LOSS_USD      $15        -> HALTS, does not skip
MAX_CONSECUTIVE_REVERTS 3          -> HALTS
kill switch             a row, re-read on a fresh connection every tick
```

**The worst case of a stray `--live` left running is therefore bounded at $15 of realised
loss before the mode halts itself**, plus whatever open basis is mid-flight, against a
wallet holding $126.73. `--minutes` defaults to 60, so it does not run for ever either.
**That bound is real and it is the reason accepting this prerequisite is not the same as
removing the last protection** — the preflight was never what limited the damage.

#### WHAT MEASURES IT ONCE THE FIRST LIVE TRADES EXIST

Accepting it does not make it known, and the columns that will answer it already exist:

| what | where |
|---|---|
| did we fill, and what did we get | `bot_trades.executed_out` against `quoted_out`, and `BUY FILLED`'s `fill_vs_quote` |
| how long inclusion took | `bot_trades.entry_block` against the block we decided in |
| the realised entry slippage | `realised_slippage_entry`, NULL on all 117 rows today |
| our own no-fill rate | a mined-and-reverted buy is `closed_unfilled` with `fill_status='live-reverted'` |

**The figure to watch is `fill_vs_quote` on the first live buy**, because it is the first
check of the 2–3% over-quote against a fill we paid for, and the 1,000 bps bound rests
entirely on simulations of it.

#### AND THE PREFLIGHT'S OWN HEADER IS NOW THE OPERATIVE SENTENCE

`bot/live-preflight.ts` has said this since it was written, and an empty list is exactly
when it starts mattering:

> **THIS IS NOT A SUBSTITUTE FOR THE OPERATOR'S JUDGEMENT** and it is not a claim that an
> empty list means the bot is safe. It means the things known to be missing are no longer
> missing.

**Section 7's categories B, C and D stay open in full.** No buy or sell of ours has ever
been broadcast, every exit attempt to date was simulated from a borrowed holder, `gas_usd`
is NULL on every row, and the inline approval path is proven only against a test double.

#### THE LIVE BOOT RAN END TO END FOR THE FIRST TIME, AND TRADED NOTHING

Every gate in the live boot sequence had only ever been observed REFUSING. With the list
empty they can all be observed passing, and `--minutes 0` is how: the boot runs in full and
`while (Date.now() < until)` is false on the first test, so the loop never ticks.

**Checked before running it, not after:** `bot_trades` for mode `live` **RETURNED NO
ROWS**, HELD rows anywhere on the chain **RETURNED NO ROWS**, and the kill switch clear —
so `reconcileOnBoot` and `clearNeedsExit` had nothing to act on and could not sell
anything. That mattered, because on a live path those two now sell for real.

```
npm run launchbot -- --live --minutes 0                             EXIT=0

LIVE MODE REQUESTED
LIVE BROADCASTER CONSTRUCTED   0x4ab56f6a15b7b17948c624c68462c2b825d2cb4a
                               transport: BroadcastRpc
WALLET BALANCE, READ FROM THE CHAIN
   balance_usd 126.90   required_usd 50   can_arm TRUE   covers_cap TRUE
boot reconciliation: no non-terminal rows          examined 0
boot: no needs_exit positions                      found 0
launchbot starting   live TRUE   broadcast "POSSIBLE -- a live broadcaster exists"
VERIFIED ON A FRESH CONNECTION   rows_in_this_mode 0
launchbot LIVE run complete   qualified 0  simulated 0  buysBroadcast 0
```

**FIVE THINGS RAN FOR THE FIRST TIME AND EVERY ONE IS THE ALLOW DIRECTION:**

| | never run before because |
|---|---|
| `assertLiveReady` PASSING | the list had never been empty |
| `createBroadcaster` from **`launchbot`** | it refused for want of a key, then for want of a preflight |
| the broadcaster over a **`BroadcastRpc`** | the line was fixed in this pass — it had been handing the signer the read-only transport |
| the wallet gate's **ALLOW in LIVE mode** | live had never got past gate 2. It was proven in dry run and in the refuse direction only |
| `launchbot starting` with `live: true` | — |

**THE ADDRESS ON THE BROADCASTER IS THE FIRST THING TO CHECK AND IT MATCHES.**
`0x4ab56f6a…cb4a` is the configured wallet, derived from the key by `ethers` and compared
inside `createBroadcaster` against `BOT_WALLET_ADDRESS`. That guard was inert until the
variable was set and is now doing work on the live path.

**NOTHING WAS WRITTEN AND NOTHING WAS SENT, VERIFIED ON A FRESH CONNECTION AFTERWARDS:**

```
rows in mode live, ANY status                RETURNED NO ROWS
entry_tx or exit_tx set anywhere             0
HELD rows anywhere                           RETURNED NO ROWS
deployed capital                             $0.00 over 0 positions
fill_status across all 117 rows              dry-run, 117 of 117
gas_usd non-null                             0
bot_exit_attempts with a receipt timing      0
```

**AND THE REMAINING GATES WERE RE-CHECKED RATHER THAN ASSUMED TO HAVE SURVIVED.** Removing
a gate is exactly when to confirm the others still refuse:

```
BOT_LIVE=1                        EXIT=1    raises; does NOT quietly give a dry run
LAUNCHBOT_LIVE=true               EXIT=1
BOT_MODE=live WITH --live         EXIT=1    the var raises even beside the real flag
--live --run-label x              EXIT=1    a label grants its own daily budget
live-gate-drill                   20 of 20
approval-drill                    13 of 13
rail-drill                        32 of 32
exit-broadcast-drill              11 of 11
```

**WHAT IT DOES NOT PROVE, AND IT IS THE LARGER HALF.** Zero ticks means no candidate was
qualified, no buy was signed, no approval was granted and no exit was attempted. **The
loop's live path — everything after `launchbot starting` — has still never executed.** What
this establishes is that the boot no longer refuses and that arming does not write or send
anything by itself, which is the precondition for step 8 rather than a substitute for it.

#### FOUR CLAIMS IN THE CODE AND THREE IN THIS DOCUMENT WERE STALE BEFORE THIS CHANGE

Emptying the list meant re-reading everything that asserted it was non-empty, and most of
what was found had already stopped being true one or two passes earlier:

| where | claimed | when it stopped being true |
|---|---|---|
| section 0 | *"LIVE MODE EXISTS AND IS PROVABLY OFF"* | the key arrived |
| section 0 | *"NOTHING IN THIS REPOSITORY HAS EVER WRITTEN TO A CHAIN … No key is set, so the signer has never been constructed"* | **the two real approvals** — and the paragraph contradicted ITSELF, saying four lines earlier that the signer *had* been constructed |
| section 2A | *"refuses to ARM while any listed item is outstanding. Four are."* | three passes of closures ago |
| section 8 | *"NOTHING IN THIS LIST HAS BEEN DONE … the bot cannot arm and no key exists"* | steps 1–6 are struck through immediately below it |
| `launchbot.ts` header | *"gated three deep: … no key exists so no signer can be constructed"* | the key arrived |
| `launchbot.ts` boot | *"assertLiveReady -> the prerequisites list is non-empty, so live cannot arm"* | this change |
| `signer-check.ts` | *"`launchbot --live` refuses at `assertLiveReady` BEFORE `createBroadcaster`"* | this change |

**THE WALLET-GATE COMMENT PREDICTED THIS EXACT MOMENT AND THE PREDICTION HELD.** It reads:
*"It was masked only because `assertLiveReady` refuses first; it would have surfaced the
moment the prerequisites list emptied, which is the worst possible time to find it."* That
moment is now, and the defect it describes was fixed two passes ago — so the list emptied
onto a raise rather than onto a live run with no balance check. **A comment that names when
a latent defect will surface is worth more than one that names the defect**, and this is the
first time one of them has come due here.

**A claim about state has to be re-checked against the state whenever the state changes** —
`ROBINHOOD.md`'s own rule, applied to a document that had drifted three ways at once.

#### AND I MADE THE SAME MISTAKE IN THE SAME PASS: 113 ROWS WAS ARITHMETIC, NOT A COUNT

The entry above and section 7 both said `gas_usd` is NULL on **113** rows. **The real
figure is 117**, and it reconciles exactly:

```
dry-run            40      dry-run-gate        3
dry-run-r3         34      dry-run-send        1
dry-run-stuck       1      dry-run-approvals   6
dry-run-r5         32                        ---
                                              117
```

**113 came from adding this run's 6 rows to a 107 this document recorded at the
`migrate-stuck-status` stop.** 107 was correct when it was measured and stopped being
correct twice before I reused it — `dry-run-gate` wrote 3 rows and `dry-run-send` wrote 1
in between. **A total derived by arithmetic on a stale figure is not a measurement**, and
the rule it breaks is the one `ROBINHOOD.md` states for findings sections: *a snapshot
written into a findings section is stale the next hour; current counts live in section 0
and nowhere else.*

**What the count DID confirm is worth more than the count**: `fill_status` is `dry-run` on
**117 of 117**, so none of the new `live-pending` / `live-filled` / `live-unknown` values
this pass introduced has ever been written, and `gas_usd` is non-null on **0**. Those two
are the evidence that the live entry path has never run, and they were measured rather
than reasoned about.

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

- **A 2–3% RESIDUAL OVER-QUOTE IS BOUNDED AND NOT IDENTIFIED.** It WAS the revert
  mechanism when the bound was 300 bps and sat on top of it; at 1000 bps the bound clears
  the residual with room, which is why the measured revert rate falls to 7%. The residual
  itself is still unexplained and would matter again at any tighter bound. **The "drift" in the revert rate
  is CLOSED — it was never a trend.** 29.2 / 31.3 / 32.4 / 40.6% are all within 0.8
  standard errors of the pooled 34.0% at n=16–34, and re-quoted under one implementation
  the rate is flat at 35.9 / 40.0 / 36.7%. What remains open is the residual itself, not
  its movement.
- ~~The 300 bps bound is costing money~~ — **CHANGED TO 1000 bps, 2026-09-16,
  operator-approved.** Measured over 100 oracle-priced launches and 25,367 modelled ones.
  The conservative end of the defensible 1,000–1,600 range was taken. **What remains open
  is that every figure behind it is a simulation**: no live trade has produced a realised
  slippage, so the number that would re-derive this does not exist yet.
- **The exit's success rate is measured on 17 attempts**, 10 clean. Better than the
  stale-quote baseline's 2 of 7, and both samples are too small to separate the fix from
  noise.
- **`gas_usd` is null on every row.** The round trip is still costed from external
  measurements — but the APPROVAL half is now measured from our own transactions at
  $0.0128 for the pair, against the $0.015 those external receipts implied, so that
  estimate is 17% high and the rest of them are probably close too.
- **`fill_status` is the literal `dry-run` on all 117 rows, and nothing models winning the
  fill against competing buyers in the same block.** ~~It is a live prerequisite~~ —
  **ACCEPTED BY THE OPERATOR 2026-09-16** and removed from `bot/live-preflight.ts`. It stays
  here because accepting it did not measure it: what is unmodelled is winning the fill and
  our own marginal impact at the moment of it, and the only thing that can close it is live
  fills. **The published medians already score a measured 16.75%–24.21% no-fill rate as
  ZERO**, so the population carries a fifth at zero for this reason; what is unknown is
  whether OUR rate is that one. `executed_out`, `realised_slippage_entry` and
  `BUY FILLED`'s `fill_vs_quote` are the columns that will answer it, and all are NULL.
- **Every exit is still simulated from a BORROWED holder.** In dry run we hold nothing,
  so a clean exit proves the pool accepts the sell and not that our approvals would
  permit it. Two setup transactions are measured in section 2; neither has been executed.

### C. Paths that exist and have never executed

- **The impact term has fired twice in 66 live trades.** Effectively inert.
- **NO EXIT HAS EVER BEEN BROADCAST.** The path exists and its orchestration is drilled,
  but `bot_exit_attempts` contains no row whose detail came from a real receipt — every
  attempt ever recorded is an `eth_call`. `receipt_wait_ms` is NULL on all of them, even
  though the column now has real figures from the two approvals.
- **`quoteRefused` and `quoteReadFailed` are 0 across every run.** Both refusal branches
  are unexercised against live data.
- **The nightly check has never delivered an alert.** Its thresholds have been exercised
  in opposite directions; the delivery path has not.
- **`MAX_CONCURRENT` and `MAX_DAILY_LOSS_USD` have never bound outside the drill.** Dry
  run realises no loss, and `MAX_CONCURRENT` has not been reached because positions close
  within ~105 s of opening.
- ~~No transaction has ever been signed or broadcast~~ — **FALSE as of 2026-09-16.** Two
  approvals were signed and mined, `0x999fdb79…` and `0x178977d3…`, total gas $0.0128.
  **No TRADE has been signed**, and every return figure in this document is still a
  simulation.
- **THE SIGNER IS PROVEN ON APPROVALS ONLY.** Nonce, chain id, EIP-1559 fees, encoding and
  receipt confirmation have all executed for real — on `approve` calls to a token and to
  Permit2. The swap calldata has never been signed, and `buildSwap`'s output has only ever
  been `eth_call`ed.
- **NO BUY HAS EVER BEEN BROADCAST, AND UNTIL 2026-09-16 NO CODE PATH COULD HAVE.** The
  broadcaster reached `clearNeedsExit` and the per-tick exit sweep and nothing else; the
  entry was an `eth_call` followed by an insert. Section 2D wires it, `approval-drill`
  proves the ordering against a test double, and **it has still never run against the
  chain** — `fill-not-modelled` keeps live from arming.
- **THE INLINE APPROVAL PATH IS PROVEN ONLY AGAINST A TEST DOUBLE.** `approval-drill` is 13
  of 13 and proves the ORDERING — a second transaction is never sent before the first has a
  receipt, MINED is the only outcome that continues, an unreadable allowance refuses without
  sending, an expired Permit2 grant is not mistaken for a live one, and an already-granted
  allowance is SKIPPED. **It proves nothing about signing, gas estimation, nonce derivation
  or the chain accepting our bytes**; the two real approvals of 2026-09-16 are the evidence
  for those, and they were sent by a CLI rather than by the loop.

### D. Structural, and stated so they are not rediscovered

- **`bot_horizon_prices` and `bot_exit_attempts` accumulate and nothing prunes them.**
- ~~An automatic halt is chain-wide when it should be mode-scoped~~ — **FIXED 2026-09-16,
  operator-approved.** `bot_control` is keyed `(chain, mode)`; `state.halt()` refuses the
  chain-wide sentinel; 32 of 32 in `rail-drill`, including the case that proves one mode's
  halt leaves another alone. See section 4.
- **THE SUPERSEDED REASONING, kept because it is what the fix was built from:** `bot_control` is
  keyed on `chain`, which is RIGHT for a manual emergency stop — an operator reaching for
  it cannot be required to name the right mode — and WRONG for the automatic halts, which
  call the same `halt()`. A dry run holds nothing, so its inability to clear a hypothetical
  position is not a statement about live exposure, yet it would stop a live run.
  **Decided 2026-09-16 to leave it unchanged**: re-keying an exercised rail is an
  operator's decision, not a side effect of building live mode. The proposed fix is manual
  halts chain-wide and automatic halts scoped to the mode that raised them, which one
  boolean row keyed on `chain` cannot express. Section 8 step 1 mitigates it procedurally
  instead. See section 4 for the full decision and the clearing procedure.
- **THE LIVE BROADCAST CALL SITE EXISTS AND HAS NEVER EXECUTED.** `approve-setup` reaches
  `createBroadcaster` at a real call site and is refused there; the signer has never been
  constructed because no key is set. The refusals are demonstrated (`live-gate-drill`, 20
  of 20) and confined statically (`check-live-gate`, over 132 files, proven able to fail),
  but **no line of the signing or broadcasting code has ever run against a real key**, and
  that stays true until section 8 step 5.
- ~~The loop never broadcast the BUY~~ — **CLOSED 2026-09-16, section 2D.** It was not on
  any list: the prerequisites named the approvals and the sell, and the entry was assumed
  wired because the row said `holding`. **A guard that stops a run also stops anyone finding
  out what the run would have done** — the same masking that hid the wallet gate when the
  key arrived, two passes earlier.
- ~~`launchbot` handed the signer the READ-ONLY transport~~ — **FIXED 2026-09-16.** The
  identical line `approve-setup` was fixed on when it hit it on the first real transaction,
  left standing here. Every send the bot made would have been refused by its own deny-list —
  loudly, with nothing signed, which is the layered defence working and is not a reason to
  have shipped it. **Fixing a defect at the call site that failed leaves it at every other
  call site**, and nothing reported that. Both call sites now choose the transport
  explicitly and by name.
- ~~`exit-exec` simulates and does not send~~ — **CLOSED 2026-09-16.** The broadcaster is
  threaded through and forwarded by both callers; the ladder climbs on simulations and
  sends only the rung the pool accepted. Section 2C.
- **THE SEND PATH IS PROVEN ONLY AGAINST A TEST DOUBLE.** `exit-broadcast-drill` is 10 of
  10, and a double proves the ORCHESTRATION — simulation before send, one send per accepted
  rung, a receipt deciding, an unconfirmed send stopping the ladder. **It proves nothing
  about signing, gas estimation, nonce handling or the chain accepting our bytes.** No line
  of `signer.ts` has run against a real key.
- ~~The receipt timeout is 60 seconds and is not measured~~ — **MEASURED 2026-09-16, and
  KEPT at 60 s with its reasoning.** The receipt-availability half is measured exactly (60
  of 60 on the first ask, max 36 ms); the inclusion half **cannot be measured without
  sending** and is bounded from a 100.52 ms block interval and absent congestion. The
  constant is 240x the ~250 ms expected total, deliberately, because firing early is far
  more expensive than firing late and the dominant term is unobserved. **What remains open
  is the inclusion half itself** — `bot_exit_attempts.receipt_wait_ms` and `receipt_polls`
  now capture it, and are NULL on all 43 rows because no exit has ever been broadcast.
- **The +450 s peak on the bot's own trades contradicts the offline holdout**, where
  +450 s is exactly 0.00000 in every window and both halves. Unresolved.
- **THE REFUSED-TRADE MOMENTUM PATTERN IS A HYPOTHESIS.** Within the bot's 29 refused
  launches that had an exit, a LARGER shortfall predicted a better return — the three that
  lost carry the three smallest shortfalls (x1.0025–x1.0068) and the five best missed by
  6–8%. The post-corpus bands do not reproduce it monotonically (mid +0.586 beats wide
  +0.359), so it holds at n=29 and not at n=590. **If it is real the shortfall is a signal
  rather than only a cost**, which is a different change from widening a bound and is not
  proposed here.
- **Three refused losers exit at 4.049e-11, 4.050e-11 and 4.051e-11 on three different
  pools** — four significant figures apart, consistent with one launchpad minting from a
  template. Noticed, recorded, not chased.
- **The stored `hooks` values are one byte short** on rows written before that decoder
  was fixed. Deterministic, so grouping is unaffected.
- ~~Every dry run that ends with an open position halts the CHAIN at its next boot~~ —
  **CLOSED 2026-09-16 by the scope split.** It now halts ITS OWN MODE, which is correct:
  that mode does have an unresolved position. Live is untouched. The mechanism below is
  kept because it is still what happens within a mode, and a dry run left with an open
  position still needs resolving before that mode will arm again.
  Demonstrated twice on 2026-09-16, the second time within minutes of the first cleanup.
  `reconcileOnBoot` reads the borrowed holder's balance — deliberately, so hypothetical
  positions are not all reported closed — that holder usually still holds, the row becomes
  `needs_exit`, and the sweep then tries to sell a dead launch pool as somebody else,
  exhausts, and calls chain-wide `halt()`. **Until automatic halts are mode-scoped (section
  4), a dry run must be left with no open position**, which in practice means running it
  long enough for every position to reach its +90 s exit. `resolve-unsellable --simulated`
  is the way out when one is stuck.
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

---

## 8. WHAT STILL HAS TO HAPPEN BEFORE THE FIRST REAL TRADE

*Written 2026-09-16, before any of it has started. The sequence is here so it can be
reviewed in advance rather than reconstructed afterwards.*

**~~NOTHING IN THIS LIST HAS BEEN DONE~~ — STEPS 1 TO 7 ARE DONE**, which the strikethroughs
below have shown for some time while this line went on denying it. Live mode exists, the key
is supplied and confirmed, the two setup transactions are mined, and **the prerequisites list
is EMPTY as of 2026-09-16**. What remains is step 8, the first live run, and step 9,
reconciling it.

### WHAT THE OPERATOR SUPPLIES — two things, and only the first is secret

1. ~~**A private key**~~ — **SUPPLIED 2026-09-16 and CONFIRMED.** `BOT_PRIVATE_KEY` is a
   Railway service variable and `signer-check` verified it controls
   `0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a` on chainId 4663, without building or
   sending anything.
1b. **`BOT_WALLET_ADDRESS`, set to that same address.** Not yet set. Without it the arming
   gate has no balance to check and `createBroadcaster`'s address guard is inert — **a
   live run now RAISES rather than proceeding**, so this is required rather than advisable. `bot/signer.ts` is the only file that may read it
   and the build gate enforces that. **It must be the key for that exact address** — the
   signer refuses if it derives anything else, because every rail, balance read and
   reconciliation is about the configured address.
2. ~~A decision on the kill-switch scope~~ — **TAKEN 2026-09-16.** Automatic halts are
   mode-scoped, manual halts chain-wide, implemented and drilled 32 of 32.

**A NOTE ON WHERE THE KEY GOES, WHICH IS NOT DECIDED HERE.** `ROBINHOOD.md` records that
setting a Railway service variable **replaces the container**, so putting a key there while
anything is running destroys it — and a key in a service variable is readable by anything
with access to the project. Whether the key lives as a service variable, is passed per
command over SSH, or the live run happens somewhere else entirely is an operator decision
that should be made before step 3, not during it.

### THE ORDERED SEQUENCE

| # | step | what it is | why it is here and not later |
|---|---|---|---|
| ~~**1**~~ | ~~Resolve the 7 stuck rows~~ | **DONE 2026-09-16** — 137 `closed_unsellable` on proven `actual=0`, the other six `closed_unfilled` by the boot sweep. And the reason it mattered is **gone**: automatic halts are mode-scoped, so a dry run's failure can no longer halt live. | — |
| ~~**2**~~ | ~~Close `sell-not-broadcast`~~ | **DONE 2026-09-16** — the broadcaster is threaded through `exit-exec` and forwarded by both callers; 10 of 10 in `exit-broadcast-drill`. See 2C. | it was the one remaining code change that had to precede a key, and it is no longer outstanding |
| ~~**3**~~ | ~~Supply the key~~ | **DONE 2026-09-16**, confirmed by `signer-check` to control the expected address on chainId 4663. | — |
| ~~**4**~~ | ~~Re-run the gates with the key present~~ | **DONE 2026-09-16** — 20 of 20, with case 6 flipping its assertion and reporting that it did. | — |
| ~~**5**~~ | ~~THE FIRST REAL TRANSACTION: a bounded approval~~ | **DONE 2026-09-16.** `0x999fdb79…` and `0x178977d3…`, both mined, $0.0128. Two defects surfaced on a call that moved nothing, which is exactly what this step was for. | — |
| ~~**6**~~ | ~~Verify the approval from the chain~~ | **DONE** — the CLI re-read both allowances (1 and 1, expiry set) and an independent process re-read both receipts, nonces and the gas actually paid. | — |
| ~~**7**~~ | ~~Clear the prerequisites list~~ | **DONE 2026-09-16.** `approvals-not-inline` removed with the evidence in section 2D; **`fill-not-modelled` ACCEPTED by the operator** and removed. `LIVE_PREREQUISITES.length === 0` and `launchbot --live` no longer refuses at the preflight. Exercised with `--minutes 0`: the live boot ran end to end and traded nothing. | it is data, not a comment, and each removal is an edit somebody signs off |
| **8** | **One live run, bounded hard** | `npm run launchbot -- --live --minutes <small>` | the rails already bound it: $10 a position, 5 concurrent, $100 deployed, 40 trades a day, $15 daily loss |
| **9** | **Reconcile from a fresh connection** | rows, allowances, balance, `bot_control` | a clean exit is not evidence; this is the standing rule and it applies hardest here |

### THE FIRST REAL TRANSACTION WAS AN APPROVAL, NOT A TRADE — AND IT EARNED ITS PLACE

**It ran on 2026-09-16 and it was wrong twice**: the signer was handed a read-only
transport, and it built a legacy transaction on a chain with a base fee. **Both failures
cost nothing and consumed no nonce**, which is precisely the argument for choosing an
approval as the first signature rather than a trade. A trade would have tested the same
signer plus a quote, a rail, a pool, a bound and an exit, and would have failed
informatively about none of them.

**The original reasoning, which held:** `token.approve(PERMIT2, <exact amount>)` — one ERC-20 approval, for
a stated amount, to a named spender, on a token the wallet already holds. Roughly **$0.0075
of gas**. It is chosen as the first signature because it is the smallest and most
inspectable thing the signing path can be pointed at: if the nonce handling, the gas
estimation, the chain id or the encoding is wrong, **it is wrong on a call that moves
nothing.**

A trade would test the same signer plus a quote, a rail, a pool, a bound and an exit, and
would fail informatively about none of them.

**The second transaction is the matching `Permit2.approve(...)`.** Only after both have
landed and been re-read from the chain does anything in step 8 have a working sell path.

### WHAT LAUNCHING LIVE LOOKS LIKE — written 2026-09-16, before it has been done

**NO PREREQUISITE REMAINS.** `fill-not-modelled` was ACCEPTED by the operator on
2026-09-16 — every return figure in this document is mark-to-market against a later trade
in the pool, a live fill competes for the same block, and nothing but live fills can close
it. Section 6 carries what was accepted and what still measures it.

**SO THE COMMAND BELOW NOW TRADES REAL MONEY.** It does not refuse, there is no second
flag, and nothing will ask.

#### THE COMMAND

```
npm run launchbot -- --live --minutes 10
```

**`--live` cannot be given by an environment variable, cannot be combined with
`--run-label`, and every variable that looks like an attempt to enable it RAISES.** There
is no other form of this command.

#### WHAT IT DOES BEFORE IT TRADES, IN ORDER, AND WHAT STOPS IT AT EACH STEP

| # | what | stops it if |
|---|---|---|
| 1 | `assertLiveReady` | any prerequisite is outstanding — **none is, so this now PASSES.** It still runs first, before a balance is read or a compute unit is spent, so a future entry added to that list refuses at the cheapest possible moment. |
| 2 | `createBroadcaster` over a `BroadcastRpc` | no `BOT_PRIVATE_KEY`; a malformed one; the endpoint's chain id is not 4663; the derived address is not `BOT_WALLET_ADDRESS` |
| 3 | the wallet gate | `BOT_WALLET_ADDRESS` unset — a live run RAISES rather than arming unchecked; or the balance is below `MAX_CONCURRENT × MAX_POSITION_USD` = $50. **Exit code 3.** |
| 4 | `reconcileOnBoot` | any non-terminal row cannot be adjudicated against the chain → HALT |
| 5 | `clearNeedsExit` | any stuck position cannot be exited → HALT and RAISE, and the bot does not arm |
| 6 | the loop arms | — |

**Steps 4 and 5 now SELL FOR REAL**, which they never have. A `needs_exit` row reaching a
live boot is exited with our own key, and the exit path grants any missing approvals first.

#### WHAT A SINGLE TRADE THEN DOES

```
qualify -> rails -> quote -> SIMULATE the buy (eth_call, free)
        -> INSERT the row as `intent`, committed, BEFORE anything is signed
        -> BUY          send -> receipt   MINED is the only outcome that continues
        -> balanceOf    the EXACT amount, ours, from the chain
        -> APPROVE 1    send -> receipt
        -> APPROVE 2    send -> receipt
        -> `holding`, exit_due_block = the BUY'S OWN BLOCK + 900
        ... 90 seconds ...
        -> SELL         simulate the ladder, send the accepted rung -> receipt
```

**Never two transactions in flight.** A mined-and-reverted buy is terminal and costs the
gas. Anything else that leaves the position possibly open marks it `needs_exit` and HALTS
THE MODE.

#### WHAT TO WATCH, IN THE ORDER IT MATTERS

1. **`LIVE BROADCASTER CONSTRUCTED`** and the address on it. If that address is not
   `0x4aB56F6a15b7B17948C624C68462C2b825D2Cb4a`, kill it.
2. **The first `BUY BROADCAST` and its `BUY RECEIPT`.** This is the first swap this project
   has ever signed. `receipt_wait_ms` should be tens of milliseconds — the two approvals
   measured 20 ms and 16 ms, both on the first poll. **A wait in the seconds is new
   information and the 60 s timeout is 3,000x what has been observed.**
3. **`BUY FILLED` and its `fill_vs_quote`.** The quote is measured to over-quote by 2–3%;
   this is the first time that has been checked against a fill we paid for. **It is also
   the number that decides whether the 1,000 bps bound is right**, and nothing else can
   produce it.
4. **`APPROVALS — WHAT WILL BE GRANTED`, then two receipts.** Both should mine within a
   block or two of each other, for about $0.0128.
5. **`LIVE TRADE UNRESOLVED`** — the line that means a position is open and the mode has
   halted. If it appears: **do not clear the halt.** Read `bot_trades` for the row, read
   the wallet's balance of that token on the chain, and let the next boot of that mode
   sweep it. `halt-control` refuses to clear a mode that still has `needs_exit` rows, which
   is the guard pointing at the position rather than at the switch.
6. **The exit at +90 s** — `EXIT BROADCAST`, then a receipt. `bot_exit_attempts` gets the
   first `receipt_wait_ms` any exit has ever carried.

#### THE STOP, FROM OUTSIDE, WITHOUT A DEPLOY

```
npm run halt-control -- --halt-chain "<why>" --commit
```

A row, re-read on a fresh connection every tick, chain-wide. **The bot cannot clear it.**

#### WHAT IS STILL UNKNOWN WHEN THE FIRST LIVE TRADE ENDS

- **Whether we won the fill** — that is `fill-not-modelled`, and accepting it is what
  launching means.
- **What our own slippage is.** Every figure behind the 1,000 bps bound is a simulation.
- **Whether the exit works from our own wallet.** All 17 exit attempts to date were
  simulated from a BORROWED holder. The first live exit is the first honest data point.
- **What a buy and a sell cost us in gas.** Three quarters of the round-trip gas is still
  other people's receipts, and `gas_usd` is NULL on every row.

### WHAT WILL STILL BE UNKNOWN AFTER ALL NINE STEPS

Stated here so the list is not mistaken for a safety proof:

- **No live fill has been won.** Every return figure in this document is mark-to-market
  against a later trade in the pool. `fill-not-modelled` is accepted as a known unknown,
  not closed.
- **The 1000 bps bound rests entirely on simulation.** The quantity that would re-derive
  it — what our own fills actually cost — does not exist until step 8 produces some.
- **The exit's success rate is measured on 17 borrowed-holder attempts.** The first real
  exit is the first honest data point.
- **The second ladder rung rests on n=4.**
- **`gas_usd` is null on every row**; the round trip is costed from external measurements,
  never from this bot's own trades.
