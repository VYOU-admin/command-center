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

> **EVERY RETURN FIGURE IN THE TABLE ABOVE IS MARK-TO-MARKET AND OVERSTATED.** The price
> was taken from ANY swap, buys included, so a honeypot's series of trapped buyers scored as
> a gain, and a launch with no exit scored 0 rather than −100%. Recomputed from REAL SELLS
> ONLY the same cells are **+0.286 / +0.050 / +0.174 / +0.109** — the midpoint window loses
> two thirds. **5.7% of corpus-era rule launches and 11.3–13.0% of recent ones could never be
> sold by anybody**, and ~4% of trades the rule actually ENTERS in the recent era are
> unrecoverable total losses. See "THE BACKTEST WAS MARK-TO-MARKET" in section 6 before
> relying on any number in this table.
>
> **~~AND THE BRACKET THAT LEFT IS NOW CLOSED~~ — THOSE FIGURES MEASURE THE POOL'S PRICING
> CURVE AND NOT WHETHER A SELL WOULD EXECUTE.** `exit-simulate` used an unreachable
> `amountOutMinimum`, which `SWAP_EXACT_IN_SINGLE` checks BEFORE `SETTLE_ALL` pulls the
> token — so no transfer ever executed in any of the 1,046 launches. "+0.246 / +0.323 /
> +0.174" and "our sell would have executed on 71–77%" are **INFERRED, not measured**.
> Proven on CME: minOut 2^127 reports a healthy price at the same block where minOut 1
> reverts `TRANSFER_FROM_FAILED`. See 6A.3.
>
> **AND THE LIVE RUN MEASURED THE ONE THING NONE OF IT DID: the T0 round trip is −1.989%
> median, which IS the LP fee, so there is no edge before the hold — and 11 of 12 pools
> became unsellable DURING the hold.** See 6A.

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

### 2E. THE PRE-BUY SELLABILITY CHECK — SPECIFIED 2026-09-17, NOT YET BUILT

**THIS IS A SPECIFICATION AND THE CODE DOES NOT IMPLEMENT ANY OF IT.** Written after
CME cost $10, and written first per rule 2. It is listed in section 7C as a path that
does not exist, and it must stay there until the code and its drill exist. **The
feasibility measurements below were taken; the check itself was not built.**

**NOTHING IN THE RULE ASKED WHETHER A TOKEN COULD BE SOLD BEFORE BUYING IT.** The entry rule
is a launchpad, a fee tier and a creation-to-first-swap gap. The exit is simulated at +90 s
from a BORROWED holder, which is ninety seconds after the money is committed. CME
(`0x9261e120400445635590c15e632d6514dfe8fea8`, trade 614) is what that costs: every transfer
path reverts `Error("blacklisted")`, the buy succeeded, and the position cannot be sold by us
or by anyone else who bought it.

**THE BUY LEG AND THE SELL LEG WERE NEVER THE SAME QUESTION, AND THE RULE ONLY EVER ASKED THE
FIRST.** A honeypot is precisely a token where the first succeeds and the second cannot.

#### THE RESEARCH FIRST, BECAUSE THE DESIGN HAD TO COME OUT OF IT

**PREVALENCE IS NOT A TAIL RISK.** *Why Trick Me: The Honeypot Traps on Decentralized
Exchanges* (arXiv 2309.13501) sampled **10,000 random Uniswap V2/V3 pools and found 8,443
abnormal** — traders "can exchange valuable assets for fraudulent tokens in liquidity pools
but are unable to exchange them back". Whatever definition sits behind that 84%, it places
CME inside the normal case for a random launch pool rather than outside it.

**THE FULL TAXONOMY, AND WHAT A PRE-BUY SIMULATION CAN DO ABOUT EACH.** GoPlus's token
security schema is the most complete field enumeration available and is used here as the
checklist rather than anybody's recollection:

| mechanism | what the seller experiences | pre-buy simulation? |
|---|---|---|
| **blacklist** (`is_blacklisted`) | our address is refused on transfer | **YES** |
| **whitelist-only** (`is_whitelisted`) | only privileged addresses may sell | **YES** |
| **transfer disabled / pausable** (`transfer_pausable`) | `setTrading(false)`, `pause()` | **YES while off — NO once flipped later** |
| **`cannot_sell_all`** | part of the balance sells, the whole balance does not | **ONLY AT FULL SIZE** |
| **anti-whale / max-tx / max-wallet** (`is_anti_whale`) | a cap below our position | **ONLY AT FULL SIZE** |
| **dynamic sell tax** (`slippage_modifiable`) | the tax is raised to 90–100% later | **NO** |
| **PER-ADDRESS tax** (`personal_slippage_modifiable`) | a tax set for OUR address alone | **NO** |
| **trading cooldown** (`trading_cooldown`) | a wait keyed to OUR purchase | **NO** |
| **upgradeable proxy** (`is_proxy`) | implementation swapped after we are in | **PARTLY** — proxy-ness is visible, the swap is not |
| **`owner_change_balance`** | our balance is rewritten | **NO** |
| **mintable** (`is_mintable`) | dilution | **NO** |
| **`external_call`** | sell behaviour depends on a contract that can change | **NO** |
| **liquidity removal** | the pool pays nothing | **NO** — and it is not a token property |
| **`can_take_back_ownership`, `hidden_owner`, `selfdestruct`** | ownership reappears | **NO** |

**THE TWO THAT NEITHER THE OPERATOR NOR I NAMED, AND THEY ARE THE IMPORTANT HALF:**

**1. `cannot_sell_all` IS A SEPARATE FLAG FROM `is_honeypot`, AND IT DEFEATS A SMALL-SIZE
CHECK BY CONSTRUCTION.** GoPlus carries it as its own field precisely because a contract can
permit a partial sale and refuse a complete one. **A check that passes on one raw unit and
fails on the real position is worse than no check**, because it converts an unknown into a
false assurance. OpenLiquid's guide describes the same shape from the seller's side: *"you
can technically sell, but only fractions of a cent."* This is why the check below simulates
the FULL expected position size and why the operator required it.

**2. `personal_slippage_modifiable` — THE "SNIPER" TOKEN — SETS A TAX FOR ONE ADDRESS, AND
CHOOSES THE ADDRESS AFTER IT BUYS.** GoPlus added the field in v1.1.12 after finding
contracts with a function that sets a per-address transaction tax so that *"trades on these
addresses cannot be implemented"*. Their description of who gets chosen is the part that
matters: **"large coin holders are often set to a separate high tax rate"**, while the owner
keeps the ability to pull liquidity.

**NO PRE-BUY SIMULATION CAN SEE THIS, AND THE REASON IS STRUCTURAL: THE PENALTY DOES NOT
EXIST FOR US UNTIL WE HOLD.** It is also the one mechanism where our own position size is a
RISK FACTOR rather than merely a detection parameter. At $10 the bot is nobody's large
holder, which is a mitigation by accident rather than by design, and it is recorded as an
accident so that raising the position size is understood to raise this exposure with it.

**AND THE CLASS THAT DEFEATS ANY PRE-BUY CHECK AT ALL: DELAYED ACTIVATION.** Multiple
sources describe contracts that behave normally for the first N buys and then flip a switch
that blocks sells — a timed blacklist keyed on block height or timestamp, a `setTrading(false)`
kill switch pulled once liquidity has accumulated, or a sell tax raised to 100% after enough
buyers are in. **The verdict at T0 is correct and then stops being correct.** A proxy makes
it cheaper still: the bytecode a checker reads is benign and the implementation behind the
`delegatecall` is swappable at will.

**CME IS 181 BYTES OF CODE — A PROXY.** That was measured before the research, and the
research says what it means: the contract we could have inspected was not the contract that
refused us.

**SO, STATED BEFORE ANY OF IT IS BUILT, WHAT THIS CHECK BUYS:**

- It catches what is TRUE AT BUY TIME: blacklists, whitelist-only selling, transfer disabled,
  size caps, a tax already set, and a pool that pays nothing.
- **It cannot catch anything the owner does after we are in**, and the research says that
  class is deliberate and designed to defeat exactly this check.
- **That is why 2E-2 exists** — the same question asked again the moment the buy confirms, so
  the window in which an owner must act to trap us is seconds rather than ninety.

#### THE OBSTACLE, AND THE MEASUREMENT THAT REMOVED IT

**WE CANNOT SELL TOKENS WE DO NOT HOLD, AND PRE-BUY WE HOLD NOTHING.** That is why the exit
check borrows a holder in the first place. Borrowing one pre-buy would answer a different
question than the operator asked — *can that address sell*, not *can we* — and it is the
wrong question for exactly the per-address mechanisms above.

The research's preferred answer is a buy-and-sell round trip inside one `eth_call`. **It does
not work here:** our Permit2 allowance for a token we have never held is zero, so the sell leg
would revert `AllowanceExpired(0)` on every token ever tested. **A check that refuses
everything is the filter-matched-nothing failure with the sign flipped**, and it would have
looked like a working honeypot detector.

**SO THE PREREQUISITE WAS MEASURED RATHER THAN ASSUMED: DOES THIS RPC HONOUR `eth_call` STATE
OVERRIDES?** It does, and the proof is not the absence of an error:

```
eth_call to an address with no code, NO override        -> 0x
eth_call to the same address, code overridden with
  604260005260206000f3  (PUSH1 0x42; MSTORE; RETURN)    -> 0x..0042
```

**A `0x` RESULT AND A SILENTLY-IGNORED PARAMETER ARE INDISTINGUISHABLE**, which is why the
first probe — overriding a balance and calling a no-op — was thrown away as worthless. The
code override returns a value that can only exist if the override was applied.

**THAT MAKES THE OPERATOR'S REQUIREMENT LITERALLY ACHIEVABLE: THE SELL IS SIMULATED FROM OUR
OWN ADDRESS, AT THE FULL EXPECTED POSITION SIZE**, with the balance and both allowances
supplied by override rather than borrowed from somebody else.

**EVERY OVERRIDE IS VERIFIED BY READING IT BACK THROUGH THE CONTRACT'S OWN VIEW FUNCTION.**
A storage slot written at the wrong index is not an error — it is a silent no-op that leaves
the real value in place, and the sell would then fail for want of a balance and be recorded
as a honeypot. Measured on CME:

```
balance slot   12   keccak(us . 12)                     read back via balanceOf      VERIFIED
allowance slot 13   keccak(permit2 . keccak(us . 13))   read back via allowance      VERIFIED
permit2 slot    1   keccak(router . keccak(token .
                      keccak(us . 1)))                  read back via allowance      VERIFIED
                                                        28 RPC calls for all three
```

**THE SLOT INDEX IS DISCOVERED, NOT GUESSED.** CME keeps balances at slot 12 and allowances
at 13 — not the 0 and 1 a hand-written constant would have assumed — so the discovery loop
writes a magic value at each candidate index and asks the contract what it now believes.
**If no index reads back, the answer is UNKNOWN and the candidate is DISQUALIFIED**, because
a token whose storage we cannot model is a token whose sell we cannot simulate.

#### THE DISQUALIFYING CONDITIONS, STATED EXPLICITLY

```
SELL REVERTS        the sell from OUR address at FULL size reverts   -> DISQUALIFY
SELL PAYS NOTHING   actual out = 0                                   -> DISQUALIFY
EXTREME TAX         out is below MAX_SELL_TAX_BPS of the buy's in    -> DISQUALIFY
PROXY               token code is under PROXY_CODE_MAX_BYTES         -> DISQUALIFY
SLOTS NOT FOUND     balance or allowance slot does not read back     -> DISQUALIFY (UNKNOWN)
UNREADABLE          any probe returns 0x or errors                   -> DISQUALIFY (UNKNOWN)
```

**EVERY REVERT REASON IS DECODED RATHER THAN COUNTED.** `Error(string)` is unwrapped —
`"blacklisted"` is the literal string CME returns — and a four-byte custom selector is matched
against a table computed by `keccak`, never copied from a website: `V4TooLittleReceived`,
`AllowanceExpired`, `TRANSFER_FROM_FAILED`. **A bare `execution reverted` with no payload is
recorded as exactly that and is still disqualifying**: a failure we cannot name is not a
failure we may ignore.

**AN UNKNOWN DISQUALIFIES, WHICH IS THE OPPOSITE OF EVERY OTHER UNKNOWN IN THIS PROJECT.**
Elsewhere `0x` means "do not treat this as zero" and the job raises rather than continues.
Here the asymmetry runs the other way: refusing a good launch costs one missed trade, and
admitting a honeypot costs the entire position. **The check fails CLOSED, and it records
WHICH WAY it failed**, so a disqualification for want of evidence stays distinguishable from
one on evidence — the two mean different things about the population and must not be summed.

**IF IT DISQUALIFIES MOST LAUNCHES THAT IS A FINDING ABOUT THE POPULATION.** The arXiv figure
is 84% abnormal, so a high rejection rate is the expected result and not grounds to loosen
anything. The measured rate and its reason breakdown are recorded in section 6.

#### 2E-2. THE RE-CHECK AFTER THE BUY, BECAUSE A PRE-BUY ANSWER HAS A SHELF LIFE

**A pre-buy check cannot see an owner who flips a switch after we are in**, and the research
says that class is engineered for exactly this. So the same simulation runs again **the moment
the buy's receipt is mined** — now needing no overrides at all, because we finally hold the
token and the approvals have just been granted. **It is the strongest form of the question and
it is only available after the money is committed.**

```
BUY mined -> balanceOf -> APPROVALS -> RE-CHECK the sell at our REAL balance
   sellable      -> `holding`; exit at +90 s as normal
   NOT sellable  -> EXIT AT ONCE. Do not wait for the horizon.
   cannot exit   -> `needs_exit`, HALT the mode, and say so
```

**WAITING OUT A HORIZON THAT CANNOT HELP IS THE FAILURE THIS CLOSES.** CME sat for ninety
seconds and then entered a ladder that could never clear, because the obstacle was never the
slippage bound. **An exit that is impossible does not become possible by waiting**, and those
ninety seconds are ninety seconds in which an owner can do the other things in the table.

**IT EXITS IMMEDIATELY RATHER THAN MARKING THE ROW AND MOVING ON.** If the sell is impossible
the position is already lost and saying so early is all that is left; if it is merely
*degraded* — a tax that now takes most of the output — the immediate exit takes what remains
rather than what remains after another ninety seconds of the same. **The two are separated by
the decoded reason, not by a status flag.**

#### WHAT IT COSTS PER CANDIDATE

```
eth_getCode  proxy check                                     1 call     26 CU
slot discovery, balance + allowance, worst case             48 calls 1,248 CU
permit2 read-back                                            1 call     26 CU
the buy simulation, for the expected position size           1 call     26 CU
the SELL simulation, our address, full size, 3 overrides     1 call     26 CU
                                                          ------------------
worst case per qualifying candidate                         52 calls 1,352 CU = $0.0006
measured on CME (slots at 12 and 13)                        31 calls   806 CU
```

**Against the loop's measured 156,872 CU for 34 qualifying trades**, adding ~27,000 CU worst
case is a **17% increase in RPC cost** — and it is charged on QUALIFYING candidates only,
after the launchpad, fee and gap filters, so it does not scale with the 516 candidates a run
sees. **$0.02 a run against a loss measured at $10 on its first occurrence.**

#### SOURCES

- *Why Trick Me: The Honeypot Traps on Decentralized Exchanges*, arXiv 2309.13501 — 8,443 of
  10,000 sampled Uniswap V2/V3 pools abnormal; taxonomy organised by attack effect; detection
  by historical data analysis combined with transaction simulation.
- *A Geth-based detection system for ERC20 honeypot contracts in Ethereum*, Discover Computing
  (Springer, 2025) — blacklists keyed on the recipient being the DEX pool, with the sender
  checked against a mapping; static data-flow analysis over bytecode.
- **GoPlus Security token-security schema** — the field enumeration used as the checklist
  above, including `cannot_sell_all`, `is_anti_whale`, `transfer_pausable`,
  `trading_cooldown`, `slippage_modifiable` and `personal_slippage_modifiable`.
- **GoPlus, "Why can't I sell my token when others can? — the Sniper token"** — a per-address
  tax, targeted at large holders, shipped as `personal_slippage_modifiable` in v1.1.12.
- *The contract is clean — for now* (dev.to) — timed blacklists by block height or timestamp,
  `setTrading(false)` / `pause()` kill switches, fee escalation to 100%, proxy delegation with
  a swappable implementation.
- *I added live sell simulation to my token risk API* (dev.to) — temporal honeypots that behave
  normally for the first N buys; static analysis reads bytecode at rest and cannot see runtime
  sell-blocking.
- *Honeypot Checker* (OpenLiquid) — max-sell-amount presenting as "you can technically sell,
  but only fractions of a cent"; cooldown manipulation; balance manipulation where the
  displayed balance is not the holdable one.

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
| max daily loss | **$50** | **raised from $15 on 2026-09-17, operator-approved, on the measured loss distribution — $15 halted 33.3% of bootstrapped days. See section 6.** |
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

### THE BACKTEST WAS MARK-TO-MARKET, AND HERE IS THE REALISABLE NUMBER — 2026-09-17

**EVERY RETURN FIGURE IN THIS DOCUMENT WAS COMPUTED FROM THE PRICE IMPLIED BY ANY SWAP,
BUYS INCLUDED.** `launch-backtest` prices a launch as `abs(counter)/abs(token)` with no
direction filter and marks a pool at an offset with the LAST swap at or before it. **A
honeypot's price series is made entirely of trapped buyers**, so it rises monotonically and
the backtest scored it as a gain; and **a launch with no trade between entry and exit carries
its entry mark forward, so `p_out = p_in` and the return is EXACTLY ZERO.** An unsellable
position is not flat. It is −100%.

`realised-backtest` recomputes the same four windows with one change: **the exit price may
only come from a swap that is a SELL, and a launch with no such swap scores −1.0.** Zero CU —
this is the already-collected corpus. The launch sets reconcile with section 1 (22,246 against
the published 14.66% of 150,791; MIDPOINT 253 against 252).

#### THE SIGN CONVENTION, AND THE CIRCULAR VALIDATION THAT WAS REJECTED

`v4_swaps_all` names no direction. The obvious check — join to `v4_swap_tx.side` — returns
**761 of 761 with zero exceptions and proves nothing**, because `route-probe` populated that
column by selecting rows on the very sign in question. **It recovers its own filter.**

Validated instead against `tx.value` on single-swap native-ETH transactions, where the ETH
actually sent is independent of the amounts: **142 consistent, 2 not.** Both counter-examples
were opened rather than dismissed — `0x47e256a8…` sent 0.001 ETH and RECEIVED 0.0249,
`0x57b92bd5…` sent 0.00002 and received 0.00356. **Both are sells carrying a dust value, so
`tx.value > 0` was the weak proxy and not the amounts.** The convention is the swapper's
perspective: token amount negative is a SELL.

#### 1. THE PUBLISHED MEDIANS AGAINST THE REALISED ONES

At the published horizon (entry +15 s, exit +45 s), denominator every rule-qualifying launch,
no-fill scored 0 exactly as section 1 does:

| window | published mark-to-mark | REALISED, sells only | change |
|---|---|---|---|
| HOLDOUT-ERA | +0.298 | **+0.286** | −4% |
| MIDPOINT | +0.145 | **+0.050** | **−66%** |
| CALM | +0.226 | **+0.174** | −23% |
| SELLOFF | +0.134 | **+0.109** | −19% |

**THE PUBLISHED MEDIANS ARE OVERSTATED, BY TWO THIRDS IN THE WORST WINDOW AND BY A FIFTH TO A
QUARTER IN THE TWO THAT MATTER MOST.** The corpus era barely moves, which is itself the
finding: **the mark-to-market bias grew with the honeypot rate**, and the honeypot rate
doubled after the corpus (below).

At the horizon the bot actually ships (`EXIT_DELAY_BLOCKS`, +90 s) the realised medians are
**+0.624 / +0.243 / +0.301 / +0.207**.

#### 2. HOW MANY OF THE RULE'S LAUNCHES COULD NEVER BE SOLD

**A reverted transaction emits no logs**, so every sell in the corpus is proof that some
non-pool holder's transfer succeeded — and a pool with ZERO sells in its entire history is one
where that never happened to anybody.

| window | rule launches | never a sell, EVER | rate | of those, bought MORE THAN ONCE | rate |
|---|---|---|---|---|---|
| HOLDOUT-ERA | 22,246 | 1,260 | **5.66%** | 969 | 4.36% |
| MIDPOINT | 253 | 15 | **5.93%** | 9 | 3.56% |
| CALM | 230 | 26 | **11.30%** | 18 | 7.83% |
| SELLOFF | 563 | 73 | **12.97%** | 51 | 9.06% |

**THE UNSELLABLE RATE MORE THAN DOUBLED BETWEEN THE CORPUS ERA AND THE RECENT WINDOWS — 5.7%
to 11.3–13.0%** — and it moves with the return decay section 1 records without explaining.
Corpus-wide across all 184,572 pools that ever swapped, **31,641 (17.14%) never saw a sell.**

**VALIDATED ON INDIVIDUAL RECORDS, NOT ON THE RATE.** The worst in the corpus:

```
0xd66002c132b5215e86ae94700ed2e38ca07e61dc   123 buys   0 sells   over 2,565 blocks
0x6ab0c58b1ca9185c27b57ef30adcbf4a9e13ab76   105 buys   0 sells   over 1,820 blocks
0x679ea06c488ed96048aa8147f841520ff23a573b    99 buys   0 sells   over 1,530 blocks
CALM    0xc047e40b9d982890e624a5328c375a616cb4bcbb    12 buys   0 sells
SELLOFF 0x645183ab27e2bca4e52ffcd9cbe2a2900554195d    12 buys   0 sells
```

**123 people bought a token over four minutes and not one of them ever got out.** That is CME
before CME, 123 times over, in a window this project measured and called +0.298.

**THE NUMBER THAT MATTERS OPERATIONALLY IS SMALLER AND WORSE.** Most never-sellable pools have
no buy at or after the +15 s entry mark, so the rule never enters them. Of launches the rule
BOTH enters and can never sell: **105 of 22,246 in HOLDOUT (0.47%), but 8 of 230 in CALM
(3.5%) and 21 of 563 in SELLOFF (3.7%).** **In the recent era roughly one trade in 27 is a
total loss with no recovery available at any horizon or any bound.** The live run hit one in
two, which is a small sample sitting inside that rate rather than outside it.

#### 3. THE TWO FAILURE MODES ARE NOT THE SAME RISK

At +90 s with the generous sell window, of the launches scored −100%:

| window | −100% total | token NEVER sellable | pool DIED |
|---|---|---|---|
| HOLDOUT-ERA | 4,069 | 105 | 3,964 |
| MIDPOINT | 40 | 1 | 39 |
| CALM | 51 | 8 | 43 |
| SELLOFF | 116 | 21 | 95 |

**THE DEAD-POOL BUCKET IS FOUR TO FORTY TIMES THE HONEYPOT BUCKET, AND ONLY THE HONEYPOT ONE
IS WHAT 2E CAN PREVENT.** A pre-buy sellability check cannot see a pool that still has buyers
at entry and none at exit. **Building 2E removes the smaller of the two problems.**

#### 4. WHETHER THERE IS AN EDGE ON TOKENS THAT COULD ACTUALLY BE SOLD

Restricting to launches where a sell ever printed — the population a perfect pre-buy check
would leave — at +90 s:

| window | all launches | SELLABLE ONLY | with the bot's real 10 s ladder |
|---|---|---|---|
| HOLDOUT-ERA | +0.624 | +0.670 | +0.622 |
| MIDPOINT | +0.243 | +0.275 | **−1.000** |
| CALM | +0.301 | +0.323 | **0.000** |
| SELLOFF | +0.207 | +0.276 | **0.000** |

**EXCLUDING HONEYPOTS BARELY MOVES THE MEDIAN — +3 to +7 POINTS — BECAUSE THEY ARE ONLY ~4% OF
ENTERED TRADES.** The third column is the finding that matters: **when the exit is restricted
to a sell printing within 10 seconds of our horizon, which is what the bot's ladder actually
does, the median in all three recent windows is ZERO or −100%, and the p25 is −1.00000.**

**AND THE HONEST LIMIT OF THAT COLUMN, STATED RATHER THAN LEFT TO FLATTER THE CONCLUSION:
THE ABSENCE OF SOMEBODY ELSE'S SELL IS NOT PROOF THAT WE COULD NOT SELL.** We would have been
the seller. A quiet pool and an unsellable one look identical in this data, so the 10 s column
overstates the loss for every pool that was merely illiquid, exactly as the +300 s column
overstates the gain by waiting for a pump it did not commit to (median delay 2–9 s past the
horizon, p90 up to 30 s).

**SO THE REALISABLE RETURN IS A RANGE AND NOT A NUMBER, AND THE DATA ALREADY COLLECTED CANNOT
NARROW IT:**

```
recent-era median, entry +15 s, hold +90 s
   pessimistic   0.000        a quiet pool treated as unsellable
   optimistic   +0.21 .. +0.30   waiting up to 300 s for somebody else to sell
   PUBLISHED    +0.134 .. +0.226 (mark-to-market)  --  sits INSIDE the bracket
```

**THE PUBLISHED FIGURE IS NOT A REALISABLE RETURN, BUT NEITHER IS IT SIMPLY WRONG BY A FACTOR:
it is a point estimate inside a bracket this corpus cannot close.** Closing it needs our own
sell simulated at each historical block — which is the 2E machinery, applied backwards, and it
costs CU rather than nothing.

**WHAT IS CERTAIN AND NEEDS NO BRACKET:** ~4% of entered trades in the recent era are
unrecoverable total losses, the unsellable rate doubled after the corpus, and **every exit
figure in section 6 was simulated from a BORROWED holder that had already sold successfully —
measured, therefore, on the population that could sell.** All costs in section 1 (0.20–5.19%
slippage, gas) still come off every figure above, which are GROSS.


### THE BRACKET IS CLOSED: OUR OWN SELL, SIMULATED AT EVERY HORIZON BLOCK — 2026-09-17

**`realised-backtest` left a range because it inferred our exit from whether SOMEBODY ELSE
sold.** Bounded to the bot's real 10 s ladder the recent-era median was 0.000; allowed to
wait 300 s for another trader it was +0.21–0.30. **Neither was the question.** This replaces
the inference with a simulation of OUR OWN round trip, from OUR address, at OUR size, at the
historical entry and exit blocks — and it produces a number rather than a range.

```
1,046 rule-qualifying launches  x  2 position sizes  =  2,092 simulated round trips
169,322 CU in 34 seconds        against a 600,000 ceiling set before the first call
```

**COST: 169,322 CU.** At this project's own measured rate — CASHCAT's 327,660 CU billed at
$0.147 — that is **$0.076**. The rate is derived from our records and is NOT read from the
provider, which `ROBINHOOD.md` section 7 requires be said rather than implied.

#### THE METHOD, AND WHAT WAS MEASURED BEFORE ANY OF IT WAS BUILT

**An unreachable `amountOutMinimum` makes the router revert `V4TooLittleReceived(min,
actual)`**, so a 26-CU `eth_call` reads exactly what the swap would have paid at our size
and at that block, with no modelling anywhere. The selector is computed by keccak.

**THREE THINGS HAD TO BE TRUE AND ALL THREE WERE MEASURED FIRST:**

```
the archive block is served at 52.5M                          YES
eth_call WITH a state override at a HISTORICAL block          YES  <- previously untested
the buy leg reports its own output                            YES  379,080 tokens / 0.004 ETH
```

The middle line is the one that decided feasibility: section 2E proved overrides work at
`latest` and section 2 proved `eth_call` works historically, and **their combination had
never been exercised.**

**FOUR OVERRIDES, EACH VERIFIED RATHER THAN ASSUMED.** Pre-buy we hold nothing, so the sell
needs a balance and two allowances. Permit2's slot 1 is read back through its own
`allowance()` once per run; the token's balance and allowance slots are DISCOVERED per token
and verified by reading the contract's own view back. **A slot written at the wrong index is
not an error — it is a silent no-op that leaves the real value in place**, and the sell would
then fail for want of a balance and be recorded as a pool that would not pay.

**SIX DISTINCT STORAGE LAYOUTS APPEARED** — balance slots {0,5,2,4,3,8} against allowance
{1,6,3,5,4,9}, always adjacent — which is why discovery is a loop rather than a constant, and
why trying the already-seen indices first collapsed the cost from a 1.41M-CU worst case to
169,322.

**OUR ETH BALANCE IS OVERRIDDEN DELIBERATELY.** The wallet's real balance at a block in
2026-08 is a fact about the operator's spending, not about the pool.

#### WHAT IS ALREADY INSIDE THE NUMBER, SO IT IS NOT SUBTRACTED TWICE

**The router's reported output is what the pool would actually have paid**, so it is already
net of the LP fee on that leg and already net of our own price impact at our own size.
**Subtracting section 1's measured slippage or the fee tier on top of these figures would
double-count both.** The only cost left to take off is GAS, which is charged in ETH outside
the swap: **$0.0967 a round trip** — buy $0.0405 and sell $0.04339 from other traders'
receipts, and the two approvals at **$0.0128 measured on our own**.

#### 2. WOULD OUR SELL HAVE EXECUTED — AND MOSTLY, YES

| window | launches | **our sell EXECUTED** | pool pays ZERO | sell REVERTED | buy reverted | slots unknown |
|---|---|---|---|---|---|---|
| MIDPOINT | 253 | **195 — 77.1%** | 22 | 0 | 35 | 1 |
| CALM | 231 | **174 — 75.3%** | 37 | 0 | 18 | 2 |
| SELLOFF | 562 | **400 — 71.2%** | 123 | 14 | 24 | 1 |

**THE FAILURES ARE OVERWHELMINGLY DEAD POOLS, NOT TOKENS THAT REFUSED US.** Decoded by
frequency over all 2,092 round trips:

```
pays_zero                   364 rows / 182 launches   the pool would have paid NOTHING
not attempted, buy failed   154 rows /  77 launches   we could never have entered
custom 0x90bfb865            26 rows /  13 launches   UNIDENTIFIED
slots not found               8 rows /   4 launches   UNKNOWN, counted on its own line
custom 0x7c9c6e8f             2 rows /   1 launch     UNIDENTIFIED
```

**`0x90bfb865` AND `0x7c9c6e8f` ARE UNIDENTIFIED AND ARE RECORDED AS SUCH.** 56 candidate
signatures were hashed by keccak — every v4, Universal Router and Permit2 error this project
could name — and **none matched**. They are carried as known unknowns exactly as `w3` and
`0xc1120e3d` are, rather than guessed at. **`0x90bfb865` appears on BOTH legs** — 36 buys and
26 sells — and a selector that blocks both directions is far more likely to be a pool
condition than a token refusing us.

**NOT ONE SELL REVERTED WITH A BLACKLIST STRING.** `Error("blacklisted")` — the literal
payload CME returns — appears **ZERO times in 2,092 simulated sells**, and that zero is
stated rather than omitted. The honeypot rate `realised-backtest` measured at 3.5–3.7% of
ENTERED trades does not show up here as a refused transfer, because those pools mostly fail
the buy leg or pay zero first.

#### 3. THE NUMBER, AT BOTH SIZES, NET OF GAS

Denominator every rule-qualifying launch. A buy that could not execute scores **0** — no
position was taken, so no money was lost. A sell that reverts or pays zero scores **−1.0**.

| window | n | p25 | **GROSS median** | p75 | **NET of gas, $10** | **NET of gas, $5** | % positive |
|---|---|---|---|---|---|---|---|
| MIDPOINT | 253 | 0.00000 | **+0.25591** | +0.560 | **+0.24624** | +0.23825 | 67.2% |
| CALM | 231 | −0.00087 | **+0.33262** | +0.588 | **+0.32295** | +0.31415 | 67.1% |
| SELLOFF | 562 | −0.99952 | **+0.18378** | +0.600 | **+0.17411** | +0.16567 | 61.4% |

**THE MEAN AGREES WITH THE MEDIAN IN SIGN AND IN MAGNITUDE, WHICH A BARBELL NEED NOT DO AND
IS THE CHECK THAT MATTERS.** Medians are what the operator asked for, but a median hides a
distribution with −100% in it, so the mean is reported beside it as the test of whether the
losses eat the winners. **They do not:**

| window | mean NET at $10 | launches at −100% | share | p90 | best |
|---|---|---|---|---|---|
| MIDPOINT | **+0.208** | 29 | 11.5% | +0.81 | +2.36 |
| CALM | **+0.302** | 45 | 19.5% | +0.81 | +9.78 |
| SELLOFF | **+0.174** | 156 | 27.8% | +1.35 | +5.75 |

**$10 BEATS $5 NET, AND THE REASON IS GAS RATHER THAN IMPACT.** Gross, the smaller position
is very slightly BETTER — +0.33349 against +0.33262 in CALM — which is our own price impact,
and it measures **0.09% of the position at $10.** That is the first direct measurement of
our marginal impact at trade size on this chain, and it confirms what the loop already
suggested when its impact term fired twice in 66 trades: **impact is not a binding constraint
at these sizes.** Gas is: $0.0967 is 0.97% of $10 and **1.93% of $5**, so halving the
position doubles the cost share and nothing else improves.

#### THE CROSS-CHECK THAT MATTERS MOST, AND IT IS INDEPENDENT

`realised-backtest`'s generous column — exit at the first sell by ANYBODY within 300 s of the
horizon — gave **+0.243 / +0.301 / +0.207** at +90 s. This binary, which never looks at
anybody else's trade and asks the pool directly, gives **+0.256 / +0.333 / +0.184** gross.

**TWO METHODS WITH NOTHING IN COMMON BUT THE LAUNCH SET AGREE WITHIN 1 TO 3 POINTS.** The
optimistic end of the bracket was the right end, and **the pessimistic end was an artefact of
treating a quiet pool as an unsellable one** — exactly the limitation that column was
labelled with when it was published.

#### VALIDATED ON INDIVIDUAL RECORDS, PER DECILE

SELLOFF at $10, one launch per decile, every row a real ETH-in against a real ETH-out:

```
d1   0x01cdf4260af9de3123c5   0.004086 -> 0.0000000   -1.0000   the pool pays nothing
d2   0x04f64a44e80468eb2b30   0.004086 -> 0.0000000   -1.0000
d4   0x004ab3b9ee40fa3fee37   0.004086 -> 0.0034540   -0.1547
d6   0x04de29f229bd854b8842   0.004086 -> 0.0052197   +0.2774
d8   0x0038940b35614fca11a0   0.004086 -> 0.0065027   +0.5913
d9   0x0070339fb9c5b036d82e   0.004086 -> 0.0071920   +0.7600
d10  0x0092ee81d15c725591ad   0.004086 -> 0.0156288   +2.8247
```

**A smooth two-sided spread with no degenerate values**, and the whole of the loss side is
pools paying zero rather than a modelling artefact.

#### WHAT THIS STILL DOES NOT SETTLE, STATED RATHER THAN LEFT TO BE INFERRED

- **`fill-not-modelled` IS UNCHANGED AND IS THE LARGEST REMAINING UNKNOWN.** Every figure
  above assumes we are in the trade. A live buy competes for the same block as everyone else
  who saw the same launch, and nothing here models winning that race.
- **OUR OWN BUY IS NOT IN THE EXIT STATE, AND THAT MAKES THIS CONSERVATIVE.** The buy pays
  its price impact on the way in, and the price support it would have left in the pool is not
  received on the way out. The size of that error is our impact, measured above at **0.09%**,
  so the direction is safe and the magnitude is negligible.
- **THE p25 IS −0.99952 IN SELLOFF.** The median is positive and **more than a quarter of
  SELLOFF launches are near-total losses.** This is a strategy whose expectation rests on a
  long right tail, not on most trades working.
- **Four launches could not be simulated at all** (slots not found) and are scored −1.0 in
  the headline. They are 0.4% of the population and move no figure, but they are counted
  rather than dropped.


### FOUR FIXES BEFORE AN UNATTENDED RUN — 2026-09-17

The operator raised `MAX_DAILY_LOSS_USD`, asked for the two defects that killed the first
live run to be fixed and exercised, and for 2E to be built. **Every one is exercised
rather than asserted, and two of the exercises are real transactions.**

#### 1. `MAX_DAILY_LOSS_USD` 15 -> 50, AND THE OLD VALUE WAS FIRING ON A THIRD OF DAYS

**$15 was an arithmetic relationship to another rail — "15% of the $100 capital" — chosen
before the loss distribution existed.** It is 1.5 positions, so two total losses breach
it, against a total-loss rate `exit-simulate` measured at 13.3%-29.0% by window.

`daily-loss-derive` bootstraps 20,000 days of `MAX_TRADES_PER_DAY` draws from the 1,046
measured round trips and asks what fraction of days each candidate halts. **It is the
RUNNING minimum that matters, not the day's close** — a day ending at +$40 having passed
through -$55 was halted at -$55.

| threshold | POOLED | MIDPOINT | CALM | SELLOFF |
|---|---|---|---|---|
| **$15** | **33.3%** | 11.5% | 25.1% | **45.5%** |
| $25 | 19.0% | 3.8% | 12.2% | 30.1% |
| $40 | 7.7% | 0.7% | 4.1% | 15.5% |
| **$50** | **4.0%** | **0.2%** | **2.0%** | **9.9%** |
| $75 | 0.7% | 0.0% | 0.3% | 2.7% |

**THE DATA OFFERS NO NATURAL BREAK.** The curve runs smoothly from 33% to 0.1%, so $50 is
an operator preference informed by the rate rather than a value the distribution
identifies — the same standing this document gives `top_percent`. What the measurement
settles is the direction: **a rail that stops a positive-expectation mode on one day in
three is mistaking an ordinary day for a bad one.**

**EVERY FIGURE IS A FLOOR.** The bootstrap draws independently and real launches
correlate — one launchpad shipping a bad template produces a run of losses more readily
than independence implies — so the true rate at any threshold is at least the one shown.

**`MAX_DEPLOYED_USD` WAS NOT RAISED WITH IT, AND IT SHADOWS THE NEW RAIL.** `deployed` is
open basis plus realised losses, so with concurrency full ($50 open) only **$40** of
losses is admitted before the cap blocks — below the $50 rail. The operator approved a
larger daily loss, not a larger total exposure. **The worst case of a run is therefore
still ~$100, not $50**, against a wallet holding $126.90.

**rail-drill: 32 of 32 at the new value**, every case derived from the constant rather
than typed, so raising it could not silently make a case breach two rails at once and
pass its expectation while proving nothing about which fired.

#### 2. THE NONCE IS TRACKED, AND THE PROOF IS THREE REAL TRANSACTIONS

**`eth_getTransactionCount('pending')` LAGS A RECEIPT WE HAVE ALREADY CONFIRMED.** Trade
614's STEP 2 was rejected `nonce too low: tx: 136 state: 137`. The chain now SEEDS the
counter and confirmed sends ADVANCE it; a broadcast that threw INVALIDATES it.

**IT IS INVALIDATED BEFORE THE BROADCAST AND SET AFTER, NEVER THE OTHER WAY ROUND**, so a
throw anywhere between leaves it invalid — the only honest state, since a throw is not
proof nothing was sent.

**A DRILL AGAINST A TEST DOUBLE WOULD HAVE TESTED THE DOUBLE'S ARITHMETIC**, so
`nonce-drill` sends three bounded USDG approvals of one raw unit — the shape section 8
step 5 chose for the first transaction this project ever signed, for the same reason: if
the nonce handling is wrong it is wrong on a call that moves nothing.

```
send 1  0xd1ad8b91…  nonce 138   tracked null (seeded from the chain)   23 ms, 1 poll
send 2  0x33d73839…  nonce 139   tracked 139                            23 ms, 1 poll
send 3  0x8c683f4d…  nonce 140   tracked 140                            21 ms, 1 poll

PASS  a fresh signer tracks NOTHING and must seed from the chain
PASS  every send was MINED
PASS  the nonces READ BACK FROM THE CHAIN are strictly consecutive   138 -> 139 -> 140
PASS  the nonce the signer TRACKED equals the one the chain recorded
PASS  between any two SENDs there is a RECEIPT
PASS  resyncNonce() drops the tracked value                          before=141 after=null
6 of 6, 990 CU
```

**`'pending'` DID NOT LAG ON THIS RUN, AND THAT IS REPORTED AS NO LAG RATHER THAN AS
PROOF.** All three sends agreed with the chain. The lag is intermittent — it fired once,
on trade 614, and cost the run — so its absence here says nothing about whether the old
code was safe. **What IS proven is the property the fix needed**: the tracked value equals
the nonce the chain recorded, on every send, and no second transaction is ever in flight.

**THE COMPILER FOUND BOTH TEST DOUBLES** when the three new members were made required
rather than optional, which is the same result making `mode` required produced for
`state.halt()`. Both now mirror the invalidate-then-set discipline.

#### 3. THE APPROVAL DEADLOCK, AND THE CONTROL IS WHAT MAKES THE FIX MEAN ANYTHING

`exit-exec` granted the Permit2 approval only AFTER the rung's simulation returned — and
a position with missing allowances **cannot get a simulation to return**: it reverts
`TRANSFER_FROM_FAILED` or `AllowanceExpired` first. So the one path written to make a
failed inline grant recoverable could never run, and a `needs_exit` row whose approvals
never landed was permanently unsellable.

**THE FIX LETS THE DECODED REASON DECIDE**, rather than moving the grant earlier
unconditionally — which would spend gas on pools that were never going to pay. Matching is
on the decoded payload, never a substring of a bare message: `execution reverted` carries
no information and guessing from it is how an unrelated failure triggers a grant nobody
asked for.

```
PASS  DEADLOCK: simulation fails on the ALLOWANCE -> grant fires, simulation RETRIED,
      ONE sell sent                                     approvals=2 sells=1 raised=""
PASS  DEADLOCK: the grant cannot be made -> UNRECOVERABLE, NO SELL sent
PASS  CONTROL: V4TooLittleReceived with allowances short -> NO grant attempted   sent=0
exit-broadcast-drill 14 of 14
```

**THE CONTROL IS THE CASE THAT MATTERS.** A fix that granted on every simulation failure
would pass the first case and would spend gas on approvals for dead pools. The third case
is what proves the predicate discriminates between the token refusing us and the pool
declining to pay.

**THE BEFORE-STATE IS ESTABLISHED BY CONSTRUCTION RATHER THAN BY RUNNING THE OLD CODE**,
and that is stated rather than glossed: with the grant reachable only after a simulation
that throws, case 6b's input produced `EXIT EXHAUSTED` with zero approvals and zero sells.
The old code was not re-run to watch it fail.

#### 4. THE PRE-BUY SELLABILITY CHECK IS BUILT — AND A THIN POOL DOES NOT DISQUALIFY

2E as specified, using the override machinery `exit-simulate` proved over 2,092 historical
round trips: our own sell, from our own address, at the full position size, before the buy
is broadcast, with the balance and both allowances supplied by state override and **every
override verified by reading it back through the contract's own view.**

**IT RUNS ONLY ON A CANDIDATE WHOSE BUY ALREADY SIMULATES CLEAN**, so it is charged on
trades we would actually take. **It runs in dry run too, and blocks there**, so a dry run's
qualifying rate is the rate live would get.

**A THIN POOL IS NOT A HONEYPOT, AND THAT NARROWS 2E's DRAFT DELIBERATELY.** The draft
disqualified on an extreme tax and on proxy-ness; neither survives contact with the
measurement. `Error("blacklisted")` appeared **ZERO times in 2,092 simulated sells**, so
the unrecoverable case is rare while thin pools are most of the population — and refusing
them would repeat the `revert-economics` mistake of selecting against pools where anything
is happening. **Proxy-ness is recorded on the row and does not disqualify**: it is a proxy
for the risk where the sell simulation is the direct test of it.

```
DISQUALIFY   the sell REVERTS, decoded          the token refuses us
DISQUALIFY   the sell pays EXACTLY ZERO         a dead pool
DISQUALIFY   the storage slots cannot be found  UNKNOWN -- fails closed, counted apart
PASSES       the sell pays LITTLE but non-zero  thinness is the bound's business
```

**`unsellable_prebuy` SITS OUTSIDE `NON_TERMINAL` AND `HELD`**, so it is terminal by
construction and deploys no capital — nothing was bought — and no sweep will ever look for
it. The qualifying rate and the reason breakdown are reported by the run itself.


### THE UNATTENDED RUN LOST $120 AGAINST A $50 LIMIT — 2026-09-17

**ONE DEFECT BLINDED ALL THREE CAPITAL RAILS AT ONCE, AND THE BOT KEPT BUYING BECAUSE IT
BELIEVED IT HELD NOTHING.** Anyone reading this document for what the bot does must read
this section before any return figure in it.

```
live trades today          13        wallet  $107.98 -> $7.71
realised loss             -$120      approved daily limit  $50
pools that paid ANYTHING    0 of 13  every one actual=0 at every rung
positions recovered         0        all resolved closed_unsellable
```

#### THE MECHANISM, WHICH IS ONE LINE IN THE WRONG ORDER

The per-tick exit sweep checked `exit_sim_from` for NULL **before** resolving who the
seller is:

```
if (!d.exit_sim_from) { status = 'closed_unsimulatable'; continue; }   <- ran FIRST
const seller = broadcaster === null ? d.exit_sim_from : broadcaster.address;
```

**LIVE ROWS CARRY `exit_sim_from = NULL` BY DESIGN.** Section 2D writes it null precisely
so boot reconciliation reads OUR balance rather than a borrowed holder's. **So every live
position reached that branch and was closed without one exit attempt, while the wallet
still held every token** — verified on chain afterwards, five balances all non-zero.

The line that computes the seller was always correct. It simply ran after the check that
made it unreachable.

#### WHY IT COST $120 RATHER THAN $10: THE STATUS IS IN NO SET

`closed_unsimulatable` is in neither `NON_TERMINAL` nor `HELD`. So an abandoned position
left, simultaneously:

| rail | what it reads | what it saw |
|---|---|---|
| `MAX_CONCURRENT` | `NON_TERMINAL` | **0 open** — so it kept opening more |
| `MAX_DEPLOYED_USD` | `HELD` | **$0 deployed** — never bound |
| `MAX_DAILY_LOSS_USD` | `sum(net_pnl_usd)` | **$0** — and the rows carried NULL anyway |
| boot reconciliation | `NON_TERMINAL` | nothing to reconcile |
| the `needs_exit` sweep | `needs_exit` | nothing to sweep |

**THE BOT OPENED THIRTEEN POSITIONS BECAUSE IT BELIEVED IT HAD NONE.** This is the
"stranded in a status nothing sweeps" shape this document already records for
`exit_exhausted` — and that entry called it a consequence rather than a hazard. **It is a
hazard, it recurred on live money, and it recurred while unattended.**

#### AND THE DAILY-LOSS RAIL COULD NOT HAVE FIRED EITHER WAY

`net_pnl_usd` has been NULL on every row ever written, so `MAX_DAILY_LOSS_USD` summed to
exactly $0 over four real total losses before this run even started. **Raising it from $15
to $50 changed nothing until `resolve-unsellable` was made to write the loss.** Section 7D
recorded this as "expected for a dry run"; on a live path it is the rail not existing.

#### THE PRE-BUY CHECK WORKED AND IT WAS NOT THE PROBLEM

`sellChecked 2, sellOk 2, disqualified 0` on the first run, and every one of the 13 tokens
**transfers freely** — `Error("blacklisted")` appeared nowhere. Every loss was a pool that
**paid at buy time and paid nothing ninety seconds later.** 2E answers *can this token be
sold*; it does not and cannot answer *will this pool still exist at the horizon*, and
`realised-backtest` already measured that dead pools outnumber honeypots four-to-forty
times. **The check is working as specified and the specification does not cover this.**

#### WHAT ELSE THIS SURFACED

- **THE ARMING GATE BLOCKS ITS OWN RECOVERY.** At $7.71 the boot refuses — balance below
  `MAX_CONCURRENT x MAX_POSITION_USD` — and the refusal happens BEFORE `clearNeedsExit`.
  **A wallet drained by its own open positions cannot boot to sell them.** The guard that
  stops new trades also stops the recovery of existing ones, which is the same shape as
  the defect above. `resolve-unsellable` now accepts a LIVE `holding` row past its horizon
  as the way out; the ordering itself is NOT fixed and is in section 7.
- **A transient receipt poll ended the FIRST launch after ninety seconds** — fixed, drilled
  15/15, and confirmed working in production at `receipt_wait_ms 1037` against the usual
  15-23 ms.
- **The nonce fix held throughout.** Thirteen buys and twenty-six approvals, every receipt
  on the first or second poll, no replacement, no `nonce too low`.

#### WHAT WAS NOT LOST, AND IT IS THE ONLY GOOD NEWS

**Every position was recovered to a truthful terminal state rather than left open**: 0
HELD rows, $0 deployed, `net_pnl_usd` now -$120 and readable by the rail that should have
stopped it. The chain-wide halt is SET.


## 6A. POST-MORTEM OF THE LIVE RUN — NUMBERED, WITH COSTS — 2026-09-17

**$120.01 of ETH went in across 12 real buys and ZERO came back.** Every figure below is
read from the chain by `npm run post-mortem`, not from the bot's log, and each is tagged
**MEASURED** or **INFERRED**. Read this before any return figure anywhere in this document.

**THE POPULATION IS 12, NOT 13. [MEASURED]** `bot_trades` holds 13 live rows; row 704 is
`sim_reverted` with `fill_status='dry-run'` and carries no `entry_tx` — it never bought.

### 6A.1 THE ACCOUNTING

`eth_in` 4.1046e15 wei each ($10.00 at $2436.31/ETH). `eth_recovered` **0 on all 12**.
Every token is still held and every pool now reads `liquidity = 0`.

| id | symbol | fee | liquidity at OUR buy | sell AT THE BUY BLOCK | would it EXECUTE at +90 s |
|---|---|---|---|---|---|
| 613 | OZZY | 10000 | 1.065e22 | **ok**, 4.0257e15 (−1.99%) | no — pool pays 0 |
| 614 | CME | 100 | 3.464e22 | **ok**, 4.0794e15 (−0.68%) | **no — `Error("blacklisted")`** |
| 705 | WORLDMONEY | 500 | 2.222e23 | **ok**, 4.1005e15 (−0.10%) | no — pool pays 0 |
| 706 | INJ | 10000 | 8.234e21 | **ok**, 4.3641e15 (+6.32%) | no — pool pays 0 |
| 798 | AMPL | 500 | 7.028e23 | **ok**, 4.1005e15 (−0.10%) | **YES**, 4.0393e15 (−1.59%) |
| 799 | Fly | 10000 | 1.065e22 | **ok**, 4.0229e15 (−1.99%) | no — pool pays 0 |
| 800 | Fly | 10000 | 1.065e22 | **ok**, 4.0229e15 (−1.99%) | no — pool pays 0 |
| 801 | Fly | 10000 | 1.065e22 | **ok**, 4.0229e15 (−1.99%) | no — pool pays 0 |
| 802 | Fly | 10000 | 1.065e22 | **ok**, 4.0229e15 (−1.99%) | no — pool pays 0 |
| 803 | Fly | 10000 | 1.065e22 | **ok**, 4.0229e15 (−1.99%) | no — pool pays 0 |
| 804 | PORTNOY | 500 | 1.414e23 | **ok**, 4.1005e15 (−0.10%) | no — pool pays 0 |
| 805 | Fly | 10000 | 1.065e22 | **ok**, 4.0229e15 (−1.99%) | no — pool pays 0 |

**THE STORAGE LAYOUT WAS VALIDATED RATHER THAN ASSERTED. [MEASURED]** `liquidity` is read
by `extsload` on the PoolManager at `keccak(poolId ‖ 6) + 3`, a layout this project had
never verified on this chain. It agrees with the router oracle on **12 of 12** records —
`liquidity = 0` exactly where the pool pays nothing, 0 disagreements, 0 unreadable — so
the layout is confirmed by twelve records rather than by a constant.

### 6A.2 THE NUMBERED FAILURES

**1. THE +90 SECOND HOLD IS THE ENTIRE LOSS. [MEASURED] — cost ~$110 of the $120.**
**12 of 12 sells would have EXECUTED at the block we bought in. 11 of 12 would not 90
seconds later.** Ten because the pool's liquidity went to zero during the hold; one
(CME) because we were blacklisted during the hold. **The bot did not buy dead pools. It
bought live pools and held them until they died.**

**2. THERE IS NO EDGE AT T0, AND THE MEASURED COST IS EXACTLY THE LP FEE. [MEASURED] —
this is why the strategy cannot work at $10.** Buying and selling in the SAME block:

```
median T0 round trip   -1.989%        mean  -0.715%
the pool's fee, both legs, for that tier:
  fee=10000  ->  -2.000%    measured -1.989%   difference 0.011%
  fee=500    ->  -0.100%    measured -0.100%   difference 0.000%
  fee=100    ->  -0.020%    measured -0.683%   difference -0.663%
gas, one round trip, $0.177-$0.190 on $10   ->  -1.77% to -1.90%
NET at T0 WITH A PERFECT INSTANT EXIT       ->  -3.82% median
```

**The T0 round trip IS the fee, to within a hundredth of a percent on 11 of 12.** So
every penny of claimed edge came from price appreciation DURING the hold — and the hold
is what made 11 of 12 unsellable. **A strategy whose T0 cost is −3.8% net needs the hold
to work, and the hold is the thing that failed.**

**3. THE ORACLE NEVER EXECUTED A TRANSFER, SO IT COULD NOT MEASURE SELLABILITY.
[MEASURED] — this invalidates the method behind four separate decisions.** See 6A.3.

**4. SIX OF TWELVE BUYS WERE ONE ACTOR AND THE BOT COUNTED THEM AS SIX BETS.
[MEASURED] — cost ~$60.** Six rows carry the symbol `Fly` on six different token
addresses, **all six ending `b3d3`**, and **five report an IDENTICAL T0 sell price of
4022915396486724 wei** on five different pools. 613 (OZZY) carries the identical
liquidity value as all six. One actor deployed the same template repeatedly over ~3,000
blocks and the bot bought every instance, including five AFTER the first had already
failed. **Nothing in the rule, the rails or the sellability check looks at whether a
candidate is the same thing we just lost money on.**

**5. NOTHING READABLE BEFORE THE BUY WOULD HAVE DISQUALIFIED ANY OF THE TWELVE.
[MEASURED] — and this is the uncomfortable one.** Liquidity was non-zero on 12 of 12 and
the sell would have executed on 12 of 12. **The claim that "Fly had $0 liquidity" is
false of the moment we bought**: Fly's pools held 1.065e22 of liquidity and would have
paid us 4.0229e15 wei. The pre-buy sellability check ran, gated the buy, and passed
correctly. **A pre-buy check is the wrong instrument for this failure and cannot be made
into the right one.**

**6. THE ONE PROPERTY THAT SEPARATES A DRAINABLE POOL FROM A LOCKED ONE IS NEVER READ.
[INFERRED — the lever is identified, its value is not yet measured].** Every loss in
group 1 is liquidity removal. Whether an LP position can be withdrawn is a readable
property of the position, and no call the bot makes looks at it. This is the only
candidate lever that addresses failure 1 at the point of entry.

**7. THE EXIT HORIZON WAS CHOSEN ON A SURVIVORSHIP METRIC. [MEASURED]** The horizon study
scored `exit found` as "a swap exists in the window". A pool whose liquidity is pulled
produces no swap, was counted as no-exit, and **no-exit scored 0 rather than −100%** — so
+90 s won a comparison computed over the pools that survived to be measured. The live run
is that bias paying out: the horizon that maximised the metric is the horizon over which
83% of pools died.

**8. EVERY BACKTEST TREATED LAUNCHES AS INDEPENDENT DRAWS. [MEASURED via failure 4]**
`daily-loss-derive` bootstrapped 20,000 trading days by sampling launches independently
and reported that a $50 rail halts 4.0% of days. With one actor supplying half the
population, a run of losses is far likelier than independent sampling implies. **Every
halt probability in that derivation is a floor, and the floor is looser than stated.**

**9. `fill-not-modelled` WAS THE WRONG ACCEPTED UNKNOWN. [MEASURED]** It was the last
prerequisite and it was accepted on the argument that only live fills could close it. The
live fills came in at **`fill_vs_quote` 0.92 to 1.00** — the fill was never the problem.
**The prerequisite list named a risk that did not materialise and did not name the two
that did** (the hold, and the status that blinded the rails).

**10. `closed_unsimulatable` BLINDED ALL THREE CAPITAL RAILS. [MEASURED] — cost the
difference between $50 and $120.** Recorded in full in the previous section.

**11. `net_pnl_usd` WAS NEVER WRITTEN, SO THE DAILY-LOSS RAIL READ $0. [MEASURED]**
Recorded in full in the previous section.

### 6A.3 THE ORACLE DEFECT, IN FULL, BECAUSE FOUR DECISIONS REST ON IT

An unreachable `amountOutMinimum` was used everywhere as an oracle for what a pool would
pay, on the reasoning that `V4TooLittleReceived(min, actual)` reports the router's own
output. **It does. And `SWAP_EXACT_IN_SINGLE` checks that bound INSIDE the swap action and
reverts there — before `SETTLE_ALL` pulls the token.** So the call short-circuits before
any transfer executes.

**PROVEN ON CME AT ITS OWN EXIT BLOCK. Identical overrides, identical block, only the
bound differing: [MEASURED]**

```
minOut = 2^127   ->  V4TooLittleReceived actual=4863353094845813    "a healthy price"
minOut = 1       ->  Error("TRANSFER_FROM_FAILED")
raw transfer     ->  Error("blacklisted")
```

**THE PRE-BUY HONEYPOT CHECK WOULD THEREFORE HAVE PASSED A HONEYPOT.** `bot/sellability.ts`
used the unreachable bound, so the one thing it was built to catch is the one thing it
could not see.

**WHAT ELSE INHERITS IT, and each of these is now INFERRED rather than MEASURED:**

| figure | what it actually measured |
|---|---|
| `exit-simulate`'s "+0.174 to +0.323 realisable median NET" | the pool's pricing curve. No transfer executed. |
| "our sell would have executed on 71–77% of launches" | the curve quoted a non-zero price on 71–77%. **Not execution.** |
| `revert-economics`' "what a refused trade would have filled at" | the curve, at that size |
| `SLIPPAGE_BPS = 1000` and the `[1000, 1343]` ladder | derived from the same curve figures |

**THE FIX IS TWO CALLS, NOT ONE.** `simulateSellAt` now takes the price from the
unreachable bound AND the executability from a **reachable** bound of 1, which runs the
whole path including the settle. They are reported separately because they answer
different questions, and on CME they disagree.

**AND IT CHANGES THE CME STORY. [MEASURED]** At the entry block CME's raw transfer
SUCCEEDS and the sell RETURNS; at the exit block both fail. **We were blacklisted between
the buy and the exit.** CME was not a readable honeypot — it is the delayed-activation
class section 2E names as undetectable by any pre-buy check, and the earlier diagnosis
that it "was a honeypot we should have caught" was wrong.

### 6A.4 ONE MEASUREMENT CAVEAT, STATED RATHER THAN BURIED

**The T0 sell is simulated against a pool state that does not contain our own buy.
[INFERRED effect, bounded]** So it credits us with selling into the pre-buy price. On 11 of
12 the T0 round trip lands within 0.011% of the LP fee, which bounds our impact at
essentially nothing at $10. **INJ (706) is the exception at +6.32%** — the smallest pool in
the set at 8.234e21 — where the gap says our $10 moved that pool ~8% and the simulation
does not charge us for it. Read 706's T0 figure as optimistic by roughly that much.


---

## 6B. RAILS, STOPS AND AN OFF SWITCH — 2026-09-17

Part 2 of the post-mortem brief. **No live trading happened in this pass and the
chain-wide halt stayed set throughout** — it is still set as this section is written,
and every figure below comes either from the twelve real positions of section 6A or
from a drill.

**This section was written after the code, which is backwards and is the thing rule 2
of this document exists to prevent.** It is recorded here rather than quietly fixed
because the four rules at the top are not decoration.

### 6B.1 The rail values, and where each number comes from

| Rail | Was | Now | Where the number comes from |
|---|---|---|---|
| `MAX_POSITION_USD` | $10 | **$1** | The operator's instruction. The next live test exists to **observe selling** across many tokens at a size where being wrong costs nothing. At $1, the twelve losses of section 6A would have cost $12, not $120. |
| `MAX_TRADES_PER_RUN` | *did not exist* | **10** | The operator's instruction. **Counted in the process, not queried** — see 6B.2. |
| `MAX_DEPLOYED_USD` | $100 | **$15** | 10 × $1 plus headroom. Derived from the two rails above, never typed independently, so raising one cannot leave this one stale. |
| `MAX_DAILY_LOSS_USD` | $50 | **$5** | MEASURED: 11 of 12 positions returned −100% and one returned −1.6%, so expected loss is ≈$0.92 per $1 trade. $5 is reached after five or six total losses — half the run's budget — which is the point at which continuing is a decision rather than an accident. |
| `MAX_CONCURRENT` | 5 | 5 | Unchanged. |
| `MAX_TRADES_PER_DAY` | 40 | 40 | Unchanged. |
| `STOP_LOSS_BPS` | *did not exist* | **2000** | See 6B.3. **Deliberately inert on the measured population.** |
| `LOSER_DEADLINE_BLOCKS` | *did not exist* | **1200 (120 s)** | The operator's value, kept as a backstop. See 6B.5 for why it is not the mechanism. |

### 6B.2 Why `MAX_TRADES_PER_RUN` is counted in the process

**The $120 was not lost because a limit was missing.** `MAX_CONCURRENT`,
`MAX_DEPLOYED_USD` and `MAX_DAILY_LOSS_USD` were all set and all enforced. They failed
together, for one reason: a single status defect — every live position written
`closed_unsimulatable` — made those positions invisible to the queries all three rails
read from. Three independent-looking rails shared one dependency and it broke.

`MAX_TRADES_PER_RUN` is therefore held as an integer in the loop and incremented on
every **broadcast** (not every fill — a reverted buy still spent gas and still used an
attempt). **A counter in the process cannot be routed around by a wrong status.** It is
a second *kind* of limit rather than a fourth instance of the first kind.

Reaching it **ends the run** rather than skipping the launch. Ten attempts is the whole
budget; having spent it there is nothing left to do but shut down with the positions
still open so the exit path can work them.

### 6B.3 The stop loss — and the measurement says a *price* stop is the wrong instrument

There was no stop loss of any kind before today. This is the derivation, and it does not
end where it was expected to.

`decay-trajectory` walked all twelve live positions from their buy block out to +300 s,
taking **two** measurements at each step — the price, and whether our own sell would
actually execute (the distinction section 6A.3 exists for):

```
became unsellable within +5 s      7 of 12
                  within +10 s     3 of 12
                  within +20 s     2 of 12
                  never             1 of 12   (798, flat at -1.6% out to +300 s)

worst price observed WHILE STILL SELLABLE    median -2.0%,  min -2.0%,  n=12
```

**−2.0% is the LP fee.** [MEASURED] Every position went from a normal price to
unsellable in a single step. There is no gradual decline anywhere in the population for
a price stop to fire on.

That leaves no honest way to derive a price-stop percentage:

- Tighter than the fee → fires on every trade the instant it opens.
- Looser than the fee → fires on none of the twelve.
- **There is no value in between that the data supports**, and choosing one anyway
  would be exactly the reasoning-forward-from-a-model this pass exists to stop.

So `STOP_LOSS_BPS = 2000` is set **to be provably inert on the measured population** —
ten times the widest observed non-fatal decline. **MEASURED: it would have fired on 0 of
12.** It is a backstop against a decline shape nobody has yet observed, and it is
labelled as one. `rail-drill` asserts it does *not* fire at −200 bps; if that case ever
flips, the stop has been tightened onto the fee and the bot will sell everything on
entry.

**The instrument the measurement does support is a sellability poll.** Every open
position is now probed every tick — *"would our own sell execute right now"*, with a
**reachable** `amountOutMinimum`, because an unreachable one short-circuits inside the
swap action before `SETTLE_ALL` and reports a healthy price on a token that refuses
transfers (6A.3). The instant it stops executing, the position is called and sold.

**AND ITS LIMIT IS MEASURED AND HAS TO BE STATED: 7 of 12 died within 5 seconds.** The
loop ticks at roughly 5 s, so **even a perfect poll running every tick would have caught
at most 5 of the 12.** The only thing that catches the other seven is not holding at
all — an `EXIT_DELAY_BLOCKS` decision, not something a stop can fix. The poll is real
and it is not a solution.

### 6B.4 The zero-liquidity gate — the readable fact nobody read

`Fly` was bought **three times into pools whose liquidity was literally `0`** at the
moment of purchase. That number is one `eth_call`:

```
extsload(keccak256(poolId ‖ uint256(6)) + 3)  on the PoolManager   — 26 CU
```

It is readable at any block, including the block before the buy. Nothing read it,
because the bot's only notion of a pool's health was the router's quote — and the
router's quote against an unreachable bound never reaches the pool's ability to pay.

**The exact call is above and the exact threshold is: liquidity strictly greater than
zero.** The threshold is zero and not a floor because the operator's instruction was
explicit — do not disqualify launches that are merely thin — and because no non-zero
floor is derivable from twelve positions. **`null` is not zero and is also a refusal:**
an unreadable pool is one we know nothing about, and declining costs $1 where proceeding
cost $120.

The reader is shared with `post-mortem.ts` rather than reimplemented, because two
readers of the same fact are two chances to be wrong about it. The storage layout is
**CONFIRMED, not inferred** — it agreed with the independent router oracle on all 12
positions.

### 6B.5 When a position is called a loser

Four triggers, checked in order of how fast the measurement says they matter:

1. **Sellability stop** — our sell no longer executes. *The primary instrument.* 11 of
   12 died this way.
2. **Price stop** — `STOP_LOSS_BPS` below the fill. **Fired on 0 of 12** (6B.3).
3. **Horizon** — `exit_due_block`, the ordinary planned exit.
4. **Loser deadline** — `LOSER_DEADLINE_BLOCKS` past entry, still open.

**A correction to the brief, stated plainly: the decisive window is 5–20 seconds, not
2–3 minutes.** [MEASURED, n=12] A 2-minute deadline is six to twenty-four times slower
than the window that decided every one of the twelve, and **would have changed the
outcome of none of them.** It is kept because it does address something real — a
position that is neither sellable nor resolvable, which is how five rows were left
stranded — but it is a backstop, and `rail-drill` asserts it does not fire at 200 blocks
(20 s) to keep that fact visible in the drill output rather than only in this document.

**The query that finds open positions changed too, and that mattered more than any
threshold.** It used to carry `and exit_due_block <= head`, so a position was looked at
**exactly once**, 90 seconds after the buy and never before. By then every outcome had
been settled for over a minute. It now selects every `holding` row every tick and the
decision is made per row.

### 6B.6 "Stop opening positions on similar candidates"

MEASURED on the twelve: **six carried the symbol `Fly`, five shared an identical T0 sell
price, and seven shared an identical pool liquidity value.** One actor, one template,
deployed repeatedly — and **five of the six `Fly` buys were made after the first had
already failed to sell.** Nothing in the bot connected them.

A template is now keyed on the pool's liquidity at first swap — the fact that grouped 7
of the 12 — and registered per candidate before the buy. When any position on a template
is called for any reason other than a clean horizon exit, **every later candidate
matching it is skipped for the rest of the run.** It is registered *before* the exit is
attempted, because an exit can take several ticks and the next candidate on the same
template can arrive inside that window — which is precisely what happened.

The key is deliberately coarse. A false skip costs one $1 trade; a false pass cost $10.

### 6B.7 The off switch

**The kill switch existed for the whole live run and the only way to write it was a CLI
on a laptop the operator did not have.** A control that requires a laptop is not a
control during the period it is needed.

`/trades` now carries it, above everything else on the page:

- **STOP takes one tap and asks nothing.** A dialog in front of the stop button is a
  defect in the exact scenario the button was built for.
- **START asks once, and the confirmation is enforced on the server** as well as in the
  browser — the endpoint is reachable directly, and that is the point.
- **The state is stated in words** — `STOPPED` or `RUNNING` — because a red button can
  mean "it is stopped" or "press to stop" and the operator does not have time to work
  out which.
- **START clears the chain-wide row only.** A mode-scoped halt the bot raised for itself
  is a statement that something specific is still wrong, and pressing START on a
  dashboard is not a diagnosis of it. Those are listed on the page with the plain
  statement that the bot is still stopped, and cleared deliberately through the CLI.
- **The open-position count sits next to STOP**, because stopping prevents new buys and
  does **not** close what is held. Five positions were stranded that way and STOP must
  not read as "flat".

### 6B.8 What is exercised, what is asserted, and what is neither

`rail-drill`: **54 cases, 54 passed, 0 failed**, cleanup verified on a fresh connection
at 0 rows in both `bot_trades` and `bot_control`. Run against deployed commit `4c7c304`.

| Item | Status |
|---|---|
| The eight rail values | **EXERCISED** — each at the threshold and one below |
| `MAX_TRADES_PER_RUN` | **EXERCISED** — at 0, at 9, at 10, through the same predicate the loop calls |
| The price stop | **EXERCISED** — including the −200 bps case that must *not* fire |
| The loser deadline | **EXERCISED** — including the 200-block case that must *not* fire |
| **The trigger ordering** | **EXERCISED — 10 cases.** The important one: unsellable *with* the horizon also reached must resolve to `sellability_stop`, or the position is filed as a planned exit and **its template is never blocked** |
| The three-state poll | **EXERCISED** — `null` triggers nothing on its own, does **not** stop the horizon firing, and does not let the price stop fire on an unverified mark |
| The pool-key reconstruction the poll depends on | **EXERCISED — `poolid-check`: 130 of 130 records, 0 disagreements.** `token.toLowerCase() < counter.toLowerCase()` reproduces the logged pool id |
| The on/off control, in the browser | **EXERCISED IN A DOM** — buttons clicked, `fetch` and `confirm` recorded, 130 rows rendered |
| The on/off endpoint, for real | **EXERCISED** — start refused without `confirm`, stop accepted without one, and a start pressed while a mode halt stands reports it. That report was **confirmed accurate by calling `isHalted`**, which still returned halted for that mode |
| The nonce fix | **EXERCISED ON REAL TRANSACTIONS** — nonces 138 → 139 → 140 |
| The Permit2 deadlock fix | **EXERCISED AGAINST A SCRIPTED TRANSPORT ONLY** — see 6B.9 |
| **The exit loop's own wiring** | **NOT EXERCISED.** The predicates and the ordering are; the loop that calls them is not. See below. |
| The sellability stop firing on a live position | **NOT EXERCISED.** It cannot be while the chain is halted. |
| The zero-liquidity gate refusing a real pool | **NOT EXERCISED** for the same reason. |

**The last three lines are the honest limit of this pass and they are not a formality.**
Every *decision* Part 2 added is now tripped by a drill, but the loop that reads a
`holding` row, runs the poll, calls `decideExitTrigger` and registers the blocklist has
not itself been run — **not even in dry run, because the chain-wide halt blocks every
mode including `dry-run`, and clearing it was out of scope for this pass.** The
extraction into pure predicates is what makes the *logic* testable; it does not test the
wiring. The first dry run after the halt is lifted is where that gets exercised, and it
should be treated as the real test of Part 2 rather than as a formality — this document
already records two occasions where correct logic was reached by no caller.

### 6B.9 The two fixes from 2E, and one honest gap

**The nonce defect is fixed and exercised on real transactions.** The signer tracks the
nonce across a trade — chain-seeded, advanced on a confirmed send, invalidated on a
throw, with invalidation happening *before* broadcast and the set happening *after* —
and retries once on `nonce too low`. Proven on a real sequence: **138 → 139 → 140**,
ordering held.

**The Permit2 approval deadlock is fixed.** Step 1 now runs a simulate-grant-retry loop,
and the retry decision is made on the **decoded revert payload** (`AllowanceExpired`,
`InsufficientAllowance`, `Error(string)` containing `TRANSFER_FROM_FAILED` or
`ALLOWANCE`) rather than on a substring of a message. `exit-broadcast-drill` passes 15/15
with a discriminating control case.

**And the gap, stated rather than buried: the deadlock fix was exercised against a
scripted transport, not against real transactions.** Exercising it for real needs a
position whose approval has actually expired or been partially spent, which needs a live
buy — and the chain-wide halt is set, every pool from the live run pays `actual=0`, and
the wallet holds $7.71. There is no way to construct that case right now. **This is a
guard that passes a drill and has never fired in anger**, which is the same category the
four original rails were in before they cost $120. It belongs on the list in section 7,
not in a summary that reads as done.

---

## 6C. EXTERNAL CLAIMS, CHECKED AGAINST THE CHAIN — 2026-09-18

Part 3 of the post-mortem brief. Every claim below arrived as an **unverified
third-party assertion** and is reported as HELD, FAILED, or UNTESTABLE against what the
chain says. **No live trading happened; the chain-wide halt stayed set throughout.**

The claims trace to a public project, `nirholas/hood-oracle`, plus NOXA's own
documentation and `nirholas/robinhood-chain-alerts`. Sources are named in 6C.9.

### 6C.1 The scoreboard

| # | claim | verdict |
|---|---|---|
| 3A.i | bots watch a launchpad factory, not raw pool creation | **PARTLY HELD** — but the named factory is dead and we already watch the live one |
| 3A.ii | NOXA locks the LP permanently | **HELD** — 40 of 40 sampled pools untouched |
| 3A.ii | NOXA tokens deploy to vanity addresses ending 4663 | **FAILED** — 3 of 60,142 |
| 3A.iii | SwapRouter02 / QuoterV2 / WETH addresses | **HELD** — all three confirmed, internally consistent |
| 3A.iv | "a few dozen a week" | **FAILED** — ~10,600 v4 pool initializations a *day* |
| 3A.v | bundlers buy across many wallets in the launch block | **FAILED as the typical case** — median 1 sender |
| 3A.vi | a real buy-then-sell round trip before the buy | **HELD, and we lacked it** — built in Part 2 |
| 3A.vi | refuse a quote with no price-impact figure | **HELD, and WE STILL VIOLATE IT** — see 6C.7 |
| 3A.vii | wait up to 90 seconds observing | **FAILED** — 17.3% of launches die inside that window |
| 3A.viii | price-independent outcome labels at 24 h | **HELD as sounder than ours was** |
| 3A.ix | `maxCreatorLaunches` | **UNTESTABLE — and that is the finding** |
| 3A.ix | sequencer feed gives 100–300 ms lead | **UNTESTED BY US** — documented, not verified |

### 6C.2 3A.iv — the launch rate, and it had to be resolved first

**The NOXA Launch Factory at `0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB` is real and
it is dead.** [MEASURED]

```
factory code size                        22,811 bytes — it exists
launch events, whole chain                   60,142
first launch                          block  61,869
LAST LAUNCH                           block 6,880,646  =  2026-07-11T10:44:33Z
blocks since                             59,709,965    =  SIXTY-NINE DAYS
active days                                      26    median 71 launches/day
peak day                                     18,653    2026-07-10
```

**The first window I swept returned zero logs and that was not the answer.** 300,000
blocks back from head found nothing; reading that as "a quiet launchpad" would have been
the filter-matched-nothing failure this project keeps hitting. Widening to the whole
chain hit the *response-size cap* instead — which proves the opposite, that the logs are
numerous and old.

**The live population, measured two ways because the first was coverage-limited:**

```
from v4_pool_init x block_times   median   987 pools/day   <- only 15.6% of rows are dated
from v4_pool_init by BLOCK NUMBER median 10,600 pools/day  <- all 678,441 rows
                                  median  9,522/day against a pricing asset
```

The second is the honest figure; the first is a floor produced by incomplete
`block_times` coverage, and **reporting it alone would have understated the rate
tenfold.**

And the launchpad our own trades came from, `0x58daec3116aae6d93017baaea7749052e8a04fa7`,
is **very much alive**: 90,106 logs in 25 hours, its most recent **7 blocks before the
measurement**.

**So "a few dozen a week" is wrong by roughly four orders of magnitude, and our own
"200–480 qualifying a day" was conservative.** Fresh measurement over 22.2 hours: 9,615
`Initialize` events, 7,749 with exactly one pricing side.

### 6C.3 3A.i — we were already watching the right launchpad

The brief's framing is that working bots watch a factory while we watch raw
`Initialize`. The chain says something more specific:

```
our 130 bot_trades rows, by Initialize target
  0x8366a39cc670…  69   the PoolManager itself — created directly, no launchpad
  0x58daec3116aa…  61   THE LIVE LAUNCHPAD
our rows whose token NOXA launched                    0 of 130   (0.00%)
```

**Zero.** Not because we were looking in the wrong place but because NOXA stopped
launching two months before the bot ran. `ROBINHOOD.md` section 8 had already identified
`0x58daec…` as this chain's dominant launchpad, and the vanity-4663 token `TWOCANDLES`
traces back through exactly that address — so `0x58daec…` is where the current
NOXA-style launches come from, and **the brief's address is a stale one.**

The claim is still directionally right in one respect: we treat a launchpad launch and
an arbitrary pool creation identically, and 6C.6 shows they perform very differently.

### 6C.4 3A.ii — the LP lock HOLDS, the vanity claim FAILS

**Locked: HELD.** [MEASURED] 40 NOXA pools sampled deterministically, `liquidity()` read
now: **40 of 40 non-zero, and every one carries the identical value
`36819258015569838458222`.** Identical liquidity across forty pools means **not one has
been added to or withdrawn from** — which is what a locked, template-minted,
single-sided position looks like. *Precisely stated: this proves no LP has been pulled,
not that pulling is impossible.*

**Vanity 4663: FAILED.** [MEASURED] 3 of 60,142 distinct NOXA tokens end `4663` —
**0.005%**, against 0.92 expected by chance alone. NOXA's own documentation says *"every
token deploys to a vanity address ending in 4663"*, and **the chain contradicts its
publisher.** Confirmed on individual records, not just the aggregate: the last five NOXA
launches are `cashcoin`, `HOODMAXXING`, `TURWIMA`, `DEBTCAT`, `doginhood` — `symbol()`
resolved on every one, and not one address ends `4663`.

Nor is it a live pattern elsewhere: **0 of 836 token sides** in 418 V3 pools created over
25 hours end `4663`.

### 6C.5 3A.iii — the V3 addresses hold, and V3 is the *safer* venue

All three confirmed and mutually consistent: [MEASURED]

```
SwapRouter02  0xCaf681a6…5cb2   factory()=0x1f7d7550…2efa   WETH9()=0x0Bd7D308…AD73
QuoterV2      0x33e885ed…a9e7   factory()=0x1f7d7550…2efa   WETH9()=0x0Bd7D308…AD73
WETH          0x0Bd7D308…AD73   symbol()="WETH"
```

**And the honest cost answer is the opposite of what "a second execution path" suggests:
the defects that cost $120 are largely V4-SPECIFIC.**

| what hurt us on v4 | on v3 |
|---|---|
| no quoter — we used a revert payload as a price oracle, and §6A.3 is the result | **`QuoterV2` works.** MEASURED: `quoteExactInputSingle` returned `amountOut` 4.84e22 and `gasEstimate` 94,173 on a live pool, no revert |
| `liquidity` needed `extsload` and an inferred storage layout | `liquidity()` is a public view on the pool contract |
| Permit2's two-step approval, which deadlocked | a plain ERC-20 `approve` to the router |
| the pool has no contract; the key must be reconstructed and verified | the pool **is** a contract |

We already have V3 *decoding* from CHUMP and CASHCAT. What is missing is the calldata
builder and the approval path — **and both are simpler than their v4 equivalents.**

**One thing is NOT established and must not be assumed: whether `QuoterV2` detects a
transfer-refusing token.** That needs the same paired single-variable test §6A.3 used,
and we have no V3 honeypot to run it against. Until then, a V3 path gets the same
reachable-bound round trip, not a quoter reading.

### 6C.6 3C — every filter measured on our own data

**The corpus's sell leg had to be re-measured before any of this meant anything.**
`bot_exit_sim` priced its sells with the unreachable bound, so `sell_status='ok'` there
means *the pool would have quoted a price*, not *we could have sold*. Re-simulated with
a **reachable** bound at both ends, no-exit scored **−100%**, filters evaluated on
pre-buy information only:

```
filter                                  n   dead  dead%   p25     median   net    >gas
ALL — no filter                        965   196  20.3%  -23.6%  +27.46% +25.53%  69%
A  liquidity > 0 at entry              965   196  20.3%  -23.6%  +27.46% +25.53%  69%
B  sell EXECUTES at entry (firewall)   952   183  19.2%  -16.3%  +28.23% +26.30%  70%
D  >= 2 distinct buyers before entry   150    58  38.7% -100.0%  +16.11% +14.18%  54%
E  < 3 senders in the launch block     965   196  20.3%  -23.6%  +27.46% +25.53%  69%
F  launchpad 0x58daec (the live one)   449    51  11.4%   +8.2%  +25.15% +23.22%  79%
G  created direct on the PoolManager   471   134  28.5% -100.0%  +40.27% +38.34%  63%
B + G                                  458   121  26.4% -100.0%  +43.97% +42.04%  65%
```

**A NEAR-MISS WORTH RECORDING: the first version of this table was circular.** Run with
the sell simulated at the exit, "filter on `sell_executes`" filtered on *the outcome
being measured* — it reported 769 survivors, **0.00% unsellable**, median +40.27%. That
is survivorship wearing a filter's label, and it is the same defect that produced the
original +15% headline. Two different filters returning an identical +40.27% is what gave
it away. The filter is now taken from the entry point and the outcome from the exit, and
the dead column is printed beside every row so it cannot recur.

**What the filters actually buy:**

- **The zero-liquidity gate disqualifies 0 of 965.** Every corpus pool had liquidity at
  entry. It would not have saved a single one of these — it is there for `Fly`, which the
  corpus does not contain.
- **The firewall disqualifies 1.35% at entry and 19.2% of outcomes, and moves the median
  by +0.77 points.** It is a tail-cutter, not an edge.
- **`F`, the live launchpad, has the best RISK profile in the table** — dead rate 11.4%
  against 20.3%, **the only p25 that is positive (+8.2%)**, and 79% beating gas. `G`,
  direct creation, has the higher median (+40.27%) and a p25 of −100%.
- **`D` (minimum unique buyers) makes things WORSE** — it cuts the population 84% and
  *doubles* the dead rate to 38.7%. The filter that looked most sensible on paper is the
  one the data rejects.

### 6C.7 THE ANSWER, AND IT DEPENDS ENTIRELY ON WHICH POPULATION YOU ASK ABOUT

The corpus says +27.46% median. **The live run was 0 for 12.** Both cannot describe the
same launches — and the dates say they need not. The corpus's newest first swap is block
**64,213,112**; the live run bought at **65,428,336–65,443,821**, entirely after it.

So the identical measurement was run on launches from **the last 22.2 hours**:

```
candidates with one pricing side in the window        7,749
sampled                                                 700
  never traded at all                                   421   (60.1%)
  had a first swap                                      279
  buy could NOT execute                                 106
  sell probe unreadable                                  25
SCORED                                                  148 pools / 124 distinct tokens

could not be sold at the exit          33   22.30%
per-POOL      p25 -99.99%   MEDIAN -22.16%   p75 +36.43%   net -24.09%
per-TOKEN     p25 -100.0%   MEDIAN +12.41%   p75 +44.08%   net +10.48%
share beating gas                            45.27%
```

**THE CLUSTERING IS THE WHOLE STORY, AND IT IS THE SAME SHAPE AS THE LIVE RUN.** One
token appeared in **16 separate pools**. A median over pools weights a prolific deployer
by however many pools it opened, and those are the losers — which is exactly why six of
the twelve live positions carried the symbol `Fly` and five were bought after the first
had already failed. **Deduplicating by token flips the sign, from −22.16% to +12.41%.**

That is direct evidence for the template blocklist built in 6B.6: it is the mechanism
that moves the bot's experience from the per-pool number toward the per-token one.

**PLAINLY, AS ASKED:**

- **Is there an edge?** On distinct tokens, the median is **+12.41% gross, +10.48% net of
  gas [MEASURED, n=124, last 22 hours]**. On pools taken indiscriminately there is not:
  **−24.09% net.** The edge, if it exists, *is* the deduplication.
- **How much decay?** The corpus said +27.46% on the same measurement. The current
  population says +12.41% per token. **Roughly half, over about three weeks.**
- **How many launches a week?** ~8,380 candidates a day with a pricing side, of which
  ~40% ever trade, giving roughly **10,000 distinct tradeable tokens a week.** Not a few
  dozen. At 10 trades per run the binding constraint is us, not supply.
- **AND IT IS NOT ACTIONABLE YET.** A quarter of tokens are −100%. 22.3% cannot be sold
  at the horizon. The only real-money test of any of this returned −100% on twelve of
  twelve. Under the standing rule, **this measurement does not become a decision until
  one real observation confirms it** — which is precisely what the $1 / 10-trade
  configuration in 6B exists to buy.

**WHAT WOULD PROVE THIS WRONG:** a $1 run over ~10 distinct tokens whose realised
outcomes cluster near −100% rather than near the +12% median. That is a cheap test and it
is the next thing to do.

### 6C.8 One claim we hold and still violate

3A.vi's second half: *"a quote that returns no price-impact figure is REFUSED, never
assumed to be zero."*

**`bot/quote.ts` returns `basis: 'fee-only'` when the pool has too few observations to
compute depth, and `launchbot.ts` trades on it with `impactPct = 0`.** A failed tick
*read* is correctly skipped; a successfully-read-but-insufficient tick set is not. **All
three of the live run's qualified trades were `fee-only`** — 100% of the run traded on a
quote with no impact figure, against a $10 position in pools whose liquidity we now know
ranged down to 8.2e21.

This is the standing rule that an error path must never emit a plausible default, in a
place nobody had looked: a missing impact figure becoming `0%` is exactly such a default.
It is on the list in section 7.

### 6C.9 3B — my own research, and what contradicts the list

Sources: [`nirholas/hood-oracle`](https://github.com/nirholas/hood-oracle),
[`nirholas/robinhood-chain-alerts`](https://github.com/nirholas/robinhood-chain-alerts),
[`nirholas/robinhood-chain-sdk`](https://github.com/nirholas/robinhood-chain-sdk),
[NOXA's docs](https://fun.noxa.fi/docs),
[TrustSwap's launchpad comparison](https://trustswap.com/robinhood/launchpad),
[Gigabots, "Sniping Sucks"](https://medium.com/gigabots/sniping-sucks-4d4c99b45881).

**Contradictions found, in order of how much they matter:**

1. **"The Odyssey" is negligible, by the same author's own numbers.** `hood-alerts`'
   verification run reports **NOXA 2,621 launches against Odyssey 4**, with 110 curve
   trades and **1 graduation**. The brief presents them as a pair. They are not.
2. **Odyssey is a bonding curve, so it has no pool at launch at all.** The SDK's own
   example notes NOXA launches "appear instantly with a pool" while Odyssey launches
   "start on a bonding curve" — meaning our `Initialize` watcher structurally *cannot*
   see an Odyssey launch until it graduates. That is a real architectural gap, and it
   applies to 4 launches.
3. **`hood-oracle`'s model is bootstrapped from a different chain.** Its prior is fitted
   on *"~296k pump.fun launches"* with "SOL buckets re-denominated to ETH at recorded
   rates". A conviction score for Robinhood Chain launches whose prior comes from Solana
   is exactly the shape of error this document exists to catch.
4. **Its defaults contradict this chain's measured behaviour.** `stopLossPct` defaults to
   30% — but §6B.3 measured the worst decline *while still sellable* at −2.0%, so a 30%
   price stop fires on nothing here. `maxHoldSeconds` defaults to 1,800 s against a
   measured decisive window of 5–20 s. `maxConcurrentPositions` defaults to 1, which is
   stricter than our 5 and looks wiser given the clustering.
5. **Nobody publishes a win rate.** `hood-oracle` states no P&L and defaults to simulate
   mode. The one practitioner assessment I could find argues sniping is structurally
   unprofitable — bribes to builders, gas in failed races, transfer taxes on quick
   flips, and insiders dumping on snipers. **No source I found publishes a positive
   realised return with a method attached.**
6. **The launchpad landscape is much wider than two names** — Pons, Flap, hood.fun,
   Bankr, Virtuals, Clanker, Openfair, RobinPad all appear in third-party coverage. Our
   own data already shows 12 distinct `Initialize` targets across 969 corpus pools.

**What corroborates the list:** the firewall round trip (we lacked it and now have it),
the refusal to accept a missing impact figure (we still violate it), price-independent
outcome labels (sounder than our original mark-to-market), and the bundler *mechanism*
being real even though it is not the median case.

**And 3A.ix's sequencer feed — 100–300 ms of lead over RPC — is documented by the SDK
and UNVERIFIED BY US.** It is the one claim on the list with a plausible mechanism that
we have not tested, and if it holds it is a latency advantage no filter can substitute
for. Testing it needs a WebSocket subscription we have never opened.

---

## 6D. POOLS.TRADE — 4A AND 4B, 2026-09-19

Part 3 checked NOXA (dead) and The Odyssey (4 launches) and **never looked at
Pools.trade, Uniswap Labs' own launchpad.** This is that check. **No live trading; the
chain-wide halt stayed set throughout.**

### 6D.1 A CORRECTION FIRST: `0x58daec…` IS NOT A LAUNCHPAD

**MEASURED, from the contract's own views:**

```
0x58daec3116aae6d93017baaea7749052e8a04fa7
  name()   = "Uniswap v4 Positions NFT"
  symbol() = "UNI-V4-POSM"
```

**It is the Uniswap v4 PositionManager.** `ROBINHOOD.md` section 8 calls it "a
launchpad", built a finding on it — *"the dominant launchpad decayed five-fold"* — and
**I repeated that claim in Part 3 and in §6C.** It is wrong.

So `tx.to` on an `Initialize` transaction is **not a launchpad identifier at all.** Both
values we ever saw are Uniswap's own contracts:

| address | what it actually is |
|---|---|
| `0x8366a39cc670…` | the **PoolManager** — `initialize()` called directly |
| `0x58daec3116aa…` | the **PositionManager** — initialize + mint via `multicall` |

A real launchpad sits in front of both. **Every conclusion in §6C that used the word
"launchpad" for these two is really about which Uniswap entry point was used**, and
`ROBINHOOD.md`'s decay finding rests on the same misidentification. The filters still
measured something real; the label was wrong.

### 6D.2 4A — Pools.trade, identified on chain

All three claimed addresses carry code. [MEASURED]

```
factory         0x000000e200088d55c39a11f609e5f667729ad49b   13,380 bytes
entry, current  0x0000ffffbe8efe702c8703ae3477ff5de3d319c0    4,127 bytes
entry, original 0x00004c4ccc709ef590f7c81102c0689f0263d4e9    3,747 bytes
```

**The factory emits exactly ONE event.** Found by pulling its logs with **no topic
filter** and grouping by `topic0`, per the rule that a topic is never taken on trust:

```
topic0  0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4
        1 topic, 512 data bytes — everything unindexed
        data word 0 = the token; then a metadata tuple of four strings
```

Word 0 being the token was confirmed by `symbol()` resolving on six consecutive
records — **BCAT, Bcat, WhiteBull, ASKR, BabyChimp, BIDDY** — not by reading the ABI.

**THE FACTORY IS SWEPT, NOT THE ENTRY CONTRACTS, AND THAT IS THE POINT.** The brief
warns that Crowd Launch auctions fire from a fresh contract per auction and that
filtering on the current entry contract drops ~40% of launches. The **factory address is
constant**, so sweeping it catches every launch whatever entry point produced it.

**One launch, decoded end to end** — BCAT, `0xb968a173…a90d`: [MEASURED]

```
TokenCreated   factory, block 66,660,815
Initialize     SAME BLOCK, SAME TRANSACTION
               currency0 = 0x0 (native ETH)   currency1 = BCAT
               fee = 2500 (0.25%)   tickSpacing = 25   hooks = 0x0 (none)
tx.to          0x0000ffffbe8efe702c8703ae3477ff5de3d319c0   the current entry contract
tx.value       3.8 ETH                the creator funds it in the creation transaction
totalSupply    1e27 raw / 18 decimals = exactly 1,000,000,000
```

**Every structural claim about Pools.trade holds**: fixed 1 billion supply (6 of 6
records), a v4 pool, 0.25% fee, created atomically with the token.

**The launch rate, from BLOCK NUMBERS.** Part 3 computed a rate from `block_times` and
undercounted **tenfold** because only 15.6% of rows were dated; this buckets by block
number over 864,000-block days.

```
TokenCreated events, 30 days        14,823    distinct tokens 14,823
launches per day                    median 424    max 1,192
most recent launch                  326 blocks before the measurement — LIVE
share of the chain's v4 initializations       602 of 10,456 = 5.76%
```

**The reported "11,437 launches on 5 August" is a launch-day figure, not a rate.** The
sustained rate is ~424/day. That is still four orders of magnitude above "a few dozen a
week", and Pools.trade is **5.76% of this chain's v4 pool creation**, not the majority.

### 6D.3 WHY WE TRADED ZERO OF THEM — WE FILTERED THEM OUT, TWICE

**0 of our 130 rows were Pools.trade tokens, and it is NOT because we never saw them.**

```
ALLOWED_FEES = [100, 500, 10000]      Pools.trade uses 2500        -> REJECTED
LAUNCHPADS   = [PositionManager, PoolManager]
                                      entry is 0x0000ffff…          -> REJECTED
our own traded fee tiers: {100: 8, 500: 69, 10000: 50, 803369: 3}
```

The bot's watcher sees these `Initialize` events — exactly one pricing side, native ETH
paired — and the rule discards every one **on two independent allow-lists, both derived
from the corpus whose launchpad attribution was wrong.** A filter that matches nothing
was treated as a finding, at the level of the entry rule itself.

### 6D.4 INSTANT vs CROWD LAUNCH — distinguishable for free

[MEASURED, 120 creating transactions sampled deterministically]

```
TokenCreated whose transaction ALSO contains an Initialize   111 (92.5%)   fee 2500 on all 111
TokenCreated with NO same-transaction Initialize               9  (7.5%)
```

**They are distinguishable at creation time at zero extra cost**: the `Initialize` event
is either in the same transaction as `TokenCreated` or it is not. An Instant Launch is
tradeable in the creation block, so **our watcher can see 92.5% of Pools.trade launches
at the moment they become tradeable.** The remaining 7.5% have no pool at creation and
are invisible to an `Initialize` watcher until one appears.

`fee = 2500` is a perfect proxy for the canonical pool on this population — **111 of 111
here and 362 of 362 in the 4B window.**

### 6D.5 4B — THE LOCK. THE HEADLINE NUMBER OF THIS PASS

**TWO WEAKER TESTS WERE TRIED FIRST AND BOTH FAILED, each instructively.**

1. **`liquidity == 0` is the wrong quantity.** The v4 pool state's `liquidity` at offset
   3 is the **active liquidity at the current tick**, not the position's existence. A
   single-sided position has a bounded range and reads zero when price leaves it, with
   the position untouched. Calling that a rug is the measure-the-wrong-quantity error
   §6A.3 exists to record.
2. **"Does the PoolManager still hold the token" DOES NOT DISCRIMINATE.** It returned
   **0 of 150 drained for Pools.trade and 0 of 150 for the control.** A test that gives
   the same answer to both groups is not a test. The PoolManager is a singleton
   custodying every pool's reserves, so its balance never cleanly reaches zero.

**The exact question is "was liquidity withdrawn from this pool", and v4 emits exactly
that.** `ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)`, topic derived from
the signature and **confirmed against real logs on BCAT's pool**, matching
`ROBINHOOD.md`'s truncated `0xf208f491…`. Data word 2 is `liquidityDelta`, signed:
**negative means removed.** One sparse `eth_getLogs` per pool.

**REFUTATION CONDITION, STATED BEFORE THE MEASUREMENT:** any material share of canonical
Pools.trade pools showing a negative `liquidityDelta` disproves the lock. And separately:
the test only counts if the **control shows withdrawals** — otherwise a zero means
nothing.

**Pools created 24–48 hours before the measurement, same window for all three groups:**

| group | n | liquidity WITHDRAWN | active liquidity now 0 |
|---|---|---|---|
| **Pools.trade, canonical** (same tx as `TokenCreated`) | 150 | **0 — 0.0%** | 7 (4.7%) |
| Pools.trade token, **someone else's pool** | 150 | 56 — **37.3%** | 55 (36.7%) |
| **everything else** | 150 | 55 — **36.7%** | 83 (55.3%) |

**THE LOCK HOLDS, AND THE TEST DISCRIMINATES.** Zero withdrawals across 150 canonical
pools against ~37% in both controls. Every canonical pool *had* `ModifyLiquidity` events
— 0 with none — so the filter is not matching nothing; the events exist and are all
positive (autocompounding fees).

**10 of our 12 live losses were liquidity pulled during the hold. On this population
that failure mode did not occur once in 150 pools.**

**AND THE TRAP, WHICH IS THE OTHER HALF OF THE RESULT.** Filtering on *"this token came
from Pools.trade"* rather than *"this is the pool Pools.trade created"* admits **433
secondary pools a day that other people opened on those tokens, and 37.3% of those have
liquidity withdrawn — statistically identical to the chain at large.** A bot using the
loose rule gets unlocked copies of locked tokens. **The correct filter is
`Initialize.transactionHash == TokenCreated.transactionHash`**, with `fee == 2500` as the
cheap proxy.

### 6D.6 What 4B does NOT establish

**A held lock is not a sellable position, and §6A.3 is the record of confusing those.**
A pool can keep every unit of its liquidity and still pay nothing for our tokens — the
price can collapse inside a locked range, and the token itself can refuse transfers. The
only measured claim here is that **liquidity was not withdrawn.** Whether we could have
sold, and at what, is 4C's question and is not answered above.

Also not established: the CREATOR's position. BCAT's creation transaction carried **3.8
ETH of the creator's own money** [MEASURED], which is consistent with the claim that
Instant Launch lets the creator buy in the launch block. That is 4E and is not measured
here.

---

## 6E. 4C — THE RETURN ON THE POOLS.TRADE POPULATION, AGAINST A CONTROL

Same method as §6C's table: our own simulated buy, our own simulated sell with a
**REACHABLE** bound, at **$1**, no-exit scored **−100%**, deduplicated by token, over
7 days. **Groups defined entirely by creation-time facts — nothing here filters on an
exit-time property**, because §6C already produced one circular table that way.

### 6E.1 THE MEASUREMENT COULD NOT RUN AT FIRST, AND THE DEFECT WAS MINE

**The first run returned ZERO scored rows for Pools.trade: all 250 tokens came back
`slots_not_found`.** A filter matching nothing is a suspected defect, not a finding, and
two separate defects were behind it.

**1. The slot scan cannot see a namespaced layout.** `simulateSellAt` discovered the
balance slot by scanning `keccak256(owner ‖ i)` for small integers `i`. That finds an
ordinary Solidity mapping and finds **nothing** on a contract whose base slot is derived
from a hash. `eth_createAccessList` reports exactly which slots a call touches, whatever
the layout, and it is now asked first with the integer scan as fallback. Two constraints,
both measured:

- **It is not archival here** — a historical block returns `metadata is not found`. So
  the slot is discovered at `latest`, which is sound because a storage **layout** is a
  property of the code, not of a block.
- **It can return several slots.** Each candidate is verified by overriding it and
  reading the contract's own view back **at the target block**. A wrong slot cannot
  survive that, and that read-back is what makes discovering at one block and using it
  at another safe.

**2. An allowance that is already infinite needs no slot — and that was the real
blocker.** With the balance slot found, the allowance slot still failed. [MEASURED]
`allowance(anyone, Permit2)` on a Pools.trade token returns `0xffff…ffff` and **the
access list for that call is EMPTY** — the function short-circuits and reads no storage.
**These tokens hard-code an infinite Permit2 allowance for every holder.** There was no
slot because there was no *need* for one, and the code read the absence of a slot as an
inability to measure.

After the fix, the same token: `executes: true`, `ethOut` non-zero, **4 RPC calls instead
of 25.** One real observation before spending on the population.

**A consequence worth carrying: the Permit2 two-step approval deadlock of §6B.9 — the
guard that has never fired in anger — does not apply to this population at all. There
is nothing to approve.**

### 6E.2 AND A GAS ERROR I MADE, CORRECTED

I first wrote round-trip gas as **0.193%** of a $1 position, by dividing §6C's 1.93%-of-$10
figure by ten. **Gas is a fixed number of wei and does not scale with position size.**
The absolute cost is ~$0.193, so at $1 it is **19.3% of the position** — I divided where
I should have multiplied, a factor of 100.

**This is decision-relevant, not a rounding note: at $1, gas alone is 19.3%, and no
strategy on this chain can be net-positive at that size.** It does not invalidate the $1
test — §6B.1 says plainly that size is *instrumentation, not a profit attempt*. It does
mean **the GROSS figures are the ones that say whether the strategy works**, and both
sizes are now reported side by side.

### 6E.3 THE RESULT

Window `60,654,784..66,702,784` (7.0 days). 99,575 v4 initializations, 72,882 with
exactly one pricing side, **2,503 canonical Pools.trade** and 70,379 control. Sampled
260 per group, evenly spread by block.

| | **POOLS.TRADE** | **CONTROL** |
|---|---|---|
| sampled → scored | 260 → **256 (98.5%)** | 260 → **106 (40.8%)** |
| distinct tokens | 256 | 101 |
| **UNSELLABLE at horizon** | **0 — 0.00%** | 12 — **11.32%** |
| liquidity = 0 at horizon | **0 — 0.00%** | 11 — 10.38% |
| p25 | **−11.07%** | **−99.91%** |
| **median, gross** | **−0.54%** | −43.45% |
| p75 | +13.50% | +43.56% |
| median net @ $10 | **−2.47%** | −45.38% |
| median net @ $1 | −19.84% | −62.75% |
| per-token median | −0.54% | −28.19% |
| share beating gas @ $1 | 17.19% | 34.91% |

**FOUR THINGS THIS SAYS, IN ORDER OF IMPORTANCE.**

**1. NOT ONE OF 256 POOLS.TRADE LAUNCHES WAS UNSELLABLE AT THE HORIZON.** Against
11.32% of the control. §6D could only show that liquidity was not withdrawn; **this is
the thing §6D explicitly could not establish — that the lock translates into being able
to sell.** It does. 10 of our 12 live losses were liquidity pulled during the hold, and
that failure mode did not occur once here.

**2. THE CATASTROPHIC TAIL IS GONE.** p25 is **−11.07%** against **−99.91%**. On the
control a quarter of launches lose essentially everything; on Pools.trade the 25th
percentile loses eleven percent. **That is the single biggest difference between the two
populations and it is what the lock buys.**

**3. AND THERE IS STILL NO EDGE AT THE CURRENT EXIT RULE.** The median is **−0.54%
gross**. Pools.trade charges **0.25% per leg = 0.50% round trip**, so **−0.54% is the
fee and essentially nothing else.** This is the same shape §6A found at T0 on the old
population: the 90-second hold adds nothing. Net of gas it is −2.47% at $10 and −19.84%
at $1.

**4. THE UPSIDE IS COMPRESSED TOO, WHICH IS THE HONEST COST OF THE SAFETY.** p75 is
**+13.50%** against **+43.56%**. A permanently locked, autocompounding, single-sided
position is a much tighter market in both directions. Anyone hoping the lock removes the
downside while leaving the upside should read those two columns together.

**ATTRITION IS PART OF THE RESULT AND IS REPORTED, NOT DROPPED.** 256 of 260 Pools.trade
candidates were scoreable against 106 of 260 control. The control loses most of its
sample to *never traded within 2,000 blocks* or *the buy could not execute*; **98.5% of
Pools.trade launches are tradeable at our entry because the creator buys in the launch
block**, which is 4E's subject.

**ONE CAVEAT ON THE CONTROL, STATED PLAINLY.** Its median moved from −10.76% at n=55 to
−43.45% at n=106 between two runs of the same code. **That is a noisy sample and its
median should not be quoted to two decimals.** The Pools.trade figures are stable across
runs at n=256. The comparison that survives the noise is the *shape* — 0% vs ~11%
unsellable, −11% vs −100% at p25 — not the exact medians.

### 6E.4 What this does and does not license

- **It does support fishing here rather than where we were.** Zero unsellable, no
  catastrophic tail, and the entry rule currently rejects the whole population (§6D.3).
- **It does not support trading it at a 90-second horizon**, at any size. The median is
  the fee.
- **It says nothing about a different exit**, which is 4D's question and the obvious next
  one: with a 0% unsellable rate and a +13.50% p75, whether anything captures that
  upside is now a live question rather than a hopeless one.
- **No live trading happened. The chain-wide halt stayed set throughout.**

---

## 6F. 4D-0 — THE ENTRY, MEASURED AS A FREE VARIABLE

**+15 seconds was discarded before this ran.** It came from a corpus study whose
launchpad attribution was wrong (§6D.1), whose sell oracle never executed a transfer
(§6A.3), and whose exit horizon was chosen on a survivorship metric (§6C). Nothing about
it is load-bearing. This measures entry timing from scratch on **canonical Pools.trade
launches**, with the **exit held constant** so an entry effect cannot be confused with
an exit effect.

### 6F.1 THE BLOCKER FIRST — 4D-5, THE LIVE GATE

`checkSellable` now carries both fixes §6E.1 made to `simulateSellAt`. Exercised against
**12 real Pools.trade tokens**, with the old integer-scan path re-run on the same token
in the same call so the comparison is a measurement and not a memory:

```
BEFORE  integer scan found both slots        0 of 12   -> slots_not_found = REFUSE TO BUY
AFTER   gate returns ok                      8 of 12
        the other 4: reason = sell_pays_zero, ethOut = 0 -- the gate correctly
        refusing pools that genuinely pay nothing now, which is not a defect
tokens with an effectively infinite Permit2 allowance   12 of 12  (MAX_UINT256)
```

**The refutation condition was stated in advance — a high BEFORE count would have meant
these tokens were never the problem. It came back 0 of 12.** The old gate would have
refused every one of the launches §6E.3 measures at 0 of 256 unsellable.

**And an incidental finding worth carrying into 4D-1: 4 of 12 pools sampled from the
last ~5.5 hours pay ZERO now.** §6E measured 0% unsellable at +90 s. **Sellability
therefore decays somewhere between 90 seconds and a few hours**, and 4D-1 must measure
where rather than assume the lock holds at 24 h.

### 6F.2 OUR DETECTION LAG IS ZERO BLOCKS — AND THAT IS NOT THE CONSTRAINT

[MEASURED, n=13 detections over 200 s, 5,513 polls]

```
lag, blocks behind head when the poll first returns the log
  min 0   median 0   p75 0   max 0
first-poll round trip  54-73 ms
```

**An `eth_getLogs` poll returns an `Initialize` log in the same block it was produced.**
Detection is not what stops us being early.

**BUT THE POLL RATE THAT BUYS IT IS THE REAL COST, AND IT IS PRICED HERE RATHER THAN
ASSUMED:**

```
5,513 polls / 200 s = 27.6 polls per second
per poll: eth_blockNumber 10 CU + eth_getLogs 60 CU = 70 CU
                          385,910 CU per 200 s
                        6,946,380 CU per hour   = $3.13/hour
                                                = $75.02 per day
```

**$75 a day against a $7.71 wallet, to buy sub-second detection that §6F.4 shows is
worth 0.13 percentage points of median.** One poll per second gives a lag of at most
~10 blocks and costs **$2.70/day**. **The cheap poll is the correct one**, and that is a
measurement rather than a preference.

### 6F.3 WE CANNOT REACH BLOCK 0, AND THE REASON IS STRUCTURAL

**The creator's buy is inside the creation transaction itself.** BCAT's `TokenCreated`,
the pool's `Initialize` and the creator's 3.8 ETH all sit in one `multicall` (§6D.2).
**No external party can be in someone else's transaction.** The earliest block any bot
can occupy is N+1.

[MEASURED] **Exactly one address buys in the launch block — median 1, maximum 1 across
120 launches.** There is no race for block 0 because there is no block-0 slot to race
for. The "creator buys first so outside bots cannot" claim is structurally true and
needs no latency advantage to enforce.

### 6F.4 THE PRICE PATH IS FLAT — THERE IS NO EARLY MOVE TO CATCH

Median price relative to the pool at +0 blocks, read from `slot0`. **A price, not a
quote** — it excludes our size and the fee. [MEASURED, n=120 per row]

| offset | median | p25 | p75 |
|---|---|---|---|
| +1 blk (0.1 s) | **0.00%** | 0.00% | 0.00% |
| +2 blk | 0.00% | −0.15% | 0.00% |
| +5 blk | 0.00% | −0.15% | 0.00% |
| +10 blk (1 s) | 0.00% | −0.15% | 0.00% |
| +30 blk (3 s) | −0.05% | −0.17% | 0.00% |
| +60 blk (6 s) | −0.11% | −0.26% | −0.05% |
| +300 blk (30 s) | −0.42% | −3.28% | −0.11% |

**Nothing happens.** The price does not run after launch; it drifts very slightly down.
**The creator's launch-block buy is the whole of the early move**, and it is inside a
transaction we cannot join.

### 6F.5 RETURN BY ENTRY OFFSET, EXIT HELD CONSTANT — ENTRY TIMING BARELY MATTERS

Exit fixed at init + 900 blocks (90 s). $1. No-exit = −100%. [MEASURED, n=120 per row]

| entry | dead | p25 | median | p75 | p90 |
|---|---|---|---|---|---|
| **+0 blk** | 10 | −4.27% | **−0.22%** | **+10.98%** | **+33.42%** |
| +1 blk | 10 | −4.27% | −0.29% | +10.98% | +33.42% |
| +2 blk | 10 | −4.27% | −0.32% | +10.98% | +33.42% |
| +5 blk | 10 | −4.27% | −0.35% | +10.98% | +33.42% |
| +10 blk | 10 | −4.27% | −0.35% | +10.98% | +33.42% |
| +30 blk | 10 | −4.38% | −0.48% | +10.73% | +33.35% |
| +60 blk | 10 | −4.34% | −0.54% | +10.73% | +33.35% |
| **+150 blk (15 s)** | 10 | −2.10% | −0.54% | +9.65% | +33.18% |
| +300 blk (30 s) | 10 | −1.97% | −0.54% | +4.45% | +31.12% |

**ENTERING FIFTEEN SECONDS EARLIER IS WORTH 0.32 PERCENTAGE POINTS OF MEDIAN** (−0.54%
→ −0.22%). Every offset's median is the 0.50% round-trip fee, within noise. **The entry
offset is not where the answer is.**

Two things that do move, in opposite directions:

- **p25 is BETTER late** — −1.97% at +300 against −4.27% at +0. Waiting avoids some
  early damage.
- **p75 is better early** — +10.98% at +0 against +4.45% at +300. Waiting gives up
  upside.
- **p90 is flat at ~+33% everywhere.** The tail does not care when you enter.

`dead = 10 of 120` at **every** offset — unsellability is a property of the launch, not
of when we bought it.

### 6F.6 THE COUNTERPARTY, AND THE ONE STRONG SIGNAL IN THIS PASS

[MEASURED, 120 launches, decoded from the launch block's own `Swap` logs]

```
distinct buyers in the launch block    median 1, MAXIMUM 1      <- only ever the creator
share of the 1,000,000,000 supply taken in the launch block:
    p25  2.52%      median  3.79%      p75  58.20%      max  64.16%
```

**THAT DISTRIBUTION IS BIMODAL AND IT IS THE MOST ACTIONABLE THING IN 4D-0.** Half of
creators take 2–4% of supply. **The top quartile take 58–64% — nearly two thirds of the
entire float, bought at the launch price, one block before anyone else can act.**

If we buy at +1 block from a creator holding 64% of supply at a lower basis, **that is
who we are buying from and that is who can sell into us.** The share is readable from
the launch block's `Swap` log **before we buy at +1**, which makes it a creation-time
filter and not an exit-time one.

**This is a hypothesis, not a finding: it has not yet been crossed with returns.** 4D-1
splits on it.

### 6F.7 What 4D-0 settles

- **Detection is solved and cheap.** 0-block lag; sub-second polling costs $75/day and
  buys 0.13 points; one poll a second costs $2.70/day. Take the cheap one.
- **Block 0 is unreachable and it does not matter.** The creator is inside the creation
  transaction; the price does not move afterwards anyway.
- **Entry timing is not the free parameter that rescues this.** Every offset's median is
  the fee.
- **The tail is real and flat across entry: p90 ≈ +33% at every offset, with 8.3%
  unsellable.** Whether anything captures it is entirely an EXIT question, which is
  4D-1.
- **The creator's supply share is the one strong creation-time signal found so far.**

---

## 6G. 4D-1 — THE HORIZON GRID. NO FIXED ENTRY/EXIT PAIR HAS POSITIVE EXPECTANCY

Three entry offsets crossed with ten holding periods, on **canonical Pools.trade
launches** and a control at the same cells. $1. No-exit = **−100% in the cell**, never
dropped. **Nothing is filtered on an exit-time property**, and `dead%` sits beside every
median so the circularity §6C caught cannot recur.

n = **200 per Pools.trade cell**, 80–91 per control cell. Window
`63,269,189..65,861,189` plus a second overlapping pass — see 6G.5.

### 6G.1 THE GRID — POOLS.TRADE, ENTRY +1 BLOCK

| hold | dead% | pulled% | p10 | p25 | median | p75 | p90 | **mean** | **SUM** | win% | best |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 15 s | 6% | **0%** | −11.3% | −0.5% | −0.2% | +0.4% | +5.1% | −6.0% | −11.91 | 37% | +155% |
| **30 s** | 6% | **0%** | −33.0% | −0.5% | **+0.3%** | +2.7% | +25.4% | **−2.7%** | **−5.49** | **53%** | +121% |
| 90 s | 5% | **0%** | −82.5% | −49.0% | −0.4% | +11.0% | +41.6% | −12.7% | −25.36 | 47% | +104% |
| 5 m | 4% | **0%** | −82.5% | −82.3% | −11.3% | +31.5% | +85.5% | −10.4% | −20.83 | 37% | +224% |
| 15 m | 4% | **0%** | −82.8% | −82.5% | −60.9% | −5.1% | **+136.3%** | −19.9% | −39.71 | 21% | +360% |
| 30 m | 4% | **0%** | −83.5% | −82.5% | −81.9% | −34.2% | −3.4% | −27.8% | −55.54 | 8% | **+2672%** |
| 1 h | 4% | **0%** | −83.5% | −82.5% | −82.2% | −48.8% | −16.1% | −55.1% | −110.20 | 2% | +1151% |
| 2 h | 4% | **0%** | −83.5% | −82.5% | −82.2% | −48.8% | −16.1% | −62.4% | −124.73 | 1% | +407% |
| 6 h | 4% | 1% | −83.5% | −82.5% | −82.2% | −48.9% | −19.6% | −65.9% | −131.88 | 0% | −0.0% |
| 24 h | 4% | 1% | −83.5% | −82.5% | −82.2% | −49.0% | −20.3% | −66.4% | −132.89 | 0% | −0.1% |

`+10` and `+150` are within noise of `+1` at every horizon, confirming §6F.5's flatness
survives a long hold. Full rows are in the run output.

### 6G.2 THE HEADLINE: EVERY ONE OF THE THIRTY CELLS HAS A NEGATIVE SUM

**Not one Pools.trade cell, at any entry offset or any horizon, has a positive mean or a
positive sum.** [MEASURED, n=200 per cell]

The best is **entry +1, hold 30 s**: median **+0.3%**, win rate **53%**, and still
**mean −2.7%, SUM −5.49 over 200 trades.** A 53% win rate with a negative mean is the
signature of small wins and large losses, and the 6% that cannot be sold at all are
enough on their own to do it.

**THE +2672% BEST OUTCOME DOES NOT RESCUE ANYTHING.** At the 30-minute hold, one
position returned twenty-seven times its stake and the cell's mean is still **−27.8%**.
That is the whole case for reporting the sum next to the median: the tail is real, it is
large, and **it is not large enough.**

### 6G.3 THE LOCK HOLDS FOR TWENTY-FOUR HOURS. SELLABILITY DOES NOT DECAY. VALUE DOES

Three separate things that §6E could not separate, now separated:

- **`pulled%` is 0% at every horizon out to 6 h and 1% at 24 h.** [MEASURED] The
  permanent-lock claim holds on a fresh 200-pool sample across a full day. §6D measured
  it at 24–48 h on 150 pools; this confirms it per-horizon from the creation block.
- **`dead%` FALLS with time — 6% at 15 s to 4% at 24 h.** Sellability does not decay; it
  slightly improves. **This settles the worry §6F.1 raised** when 4 of 12 pools "paid
  zero": those sells *executed* and paid almost nothing, which is a price collapse and
  not an unsellable token. The two are different and the grid keeps them in different
  columns.
- **Value collapses hard.** Median **+0.3% at 30 s → −82.2% by 1 h**, and it stays there.
  p25 is already −49% at 90 seconds.

**So the token is sellable the whole time and there is nothing left to sell.** That is a
worse problem than a rug, because no sellability check can see it coming.

### 6G.4 THE CONTROL SAYS THE EFFECT IS THE POPULATION, NOT TIME

| | dead% 15 s → 24 h | pulled% 15 s → 24 h | median 15 s | mean 24 h |
|---|---|---|---|---|
| **POOLS.TRADE** | **6% → 4%** | **0% → 1%** | −0.2% | −66.4% |
| **CONTROL** | **18% → 58%** | **3% → 44%** | −97.4% | −96.0% |

The control's unsellability **triples** and its withdrawals go from 3% to **44%**, while
Pools.trade's barely move. **The shape difference is the population.** And the control is
so much worse at every cell — median −97.4% at fifteen seconds — that Pools.trade is
plainly the right pond even though nothing in it is profitable yet.

**ONE METHODOLOGICAL CAVEAT, STATED BECAUSE IT MATTERS FOR THE CONTROL ONLY.** This grid
anchors entry at `init + offset`. For Pools.trade that is the right anchor — the creator
buys in the creation transaction, so initialization *is* first trade (§6F.3). **For the
control, a pool may be initialized long before anything trades on it**, so `init + 1`
can mean buying into a pool with no market. That is part of why the control looks worse
here than in §6E.3, which anchored on the first swap. **The control's absolute figures
are therefore not comparable across sections; its time-SHAPE is what this table is for.**

### 6G.5 A REPRODUCIBILITY FLAW I CREATED AND FIXED

The window end was derived from `head`, so a second run sampled a **different**
population, the resume logic could not match, and a re-run intended only to reprint the
table with two extra columns **re-bought the entire grid** — another ~800,000 CU, and
every cell's n doubled from 100 to 200. The larger sample is genuinely better and the
figures above use it, but the spend was avoidable. `GRID_TO_BLOCK` now pins the window
and the report states whether it was pinned.

### 6G.6 What is still open, and what 4D-1 does NOT settle

**4D-1 rules out every FIXED entry/exit pair. It does not rule out a path-dependent
exit, and it would be wrong to read it that way.** A fixed horizon forces a position to
be held through the collapse in 6G.3; a take-profit or a trailing stop does not. The
grid shows exactly the shape such a rule would feed on:

```
at  5 m   median -11.3%   p90  +85.5%
at 15 m   median -60.9%   p90 +136.3%
```

**A rule that exits a winner near its peak and a loser early is measuring something this
grid structurally cannot.** That is 4D-2, and it is the last open question before the
honest answer in 4D-3.

**What would refute a negative verdict in 4D-2:** a trigger rule whose SUM over the same
200 positions is positive after the 0.50% round trip and gas. **What would confirm it:**
every trigger rule's sum still negative, which — given that the median collapses faster
than the p90 rises after five minutes — is the more likely outcome on this evidence.

---

## 6H. 4D-2 AND 4D-3 — THERE IS NO STRATEGY HERE. THE ANSWER IS NO

Twenty exit rules, walked over **200 canonical Pools.trade positions** entered at +1
block, on the same pinned window as §6G. The path at each sample point is **our own
simulated sell with a REACHABLE bound** — not the pool price, for the reason in 6H.1.
The 0.50% round trip is inside every figure; gas is subtracted separately as the
**absolute** $0.193 it is (§6E.2).

### 6H.1 TWO METHOD DECISIONS THAT CHANGED THE ANSWER

**The path is our proceeds, not the pool price.** For a Pools.trade pool `currency0` is
native ETH and `currency1` the token, so v4's `price = token1/token0` is **tokens per
ETH**, which moves *inversely* to a token position's value. §6F.4's price table is in
that convention. A flat line is flat inverted, so §6F.4's conclusion survives — **but a
TRIGGER does not.** Every take-profit built on that series would have fired on the wrong
side. Simulating the sell costs five calls instead of one and removes the question.

**MY FIRST GRID UNDER-TESTED THE STOPS, AND THE OUTPUT SAID SO.** `TP +50% SL -20%` and
`TP +50% SL -30%` returned *identical* sums with a p25 of −82.4%. A −20% stop exiting at
−82% has not been tested, it has been sampled too coarsely. The grid had a 150-second
hole exactly where §6G shows the collapse. **Reporting that negative would have been
reporting an artefact of my own sampling as a property of the market.** The grid was
doubled in resolution from 20 s to 12 m and it moved real numbers — `TP +25%` went from
a −1.9% median to **+25.9%**.

### 6H.2 THE RESULT — ALL TWENTY RULES NEGATIVE

| rule | p25 | median | p75 | p90 | mean | **SUM** | win% | SUM @$10 | SUM @$100 |
|---|---|---|---|---|---|---|---|---|---|
| **TP +200% cap 15m** | −82.5% | −58.6% | +68.1% | +203.3% | **−2.0%** | **−3.99** | 28% | −7.85 | **−4.38** |
| TP +200% SL −30% | −82.4% | −48.9% | +54.2% | +203.2% | −3.2% | −6.49 | 27% | −10.35 | −6.88 |
| TP +25% cap 15m | −60.9% | **+25.9%** | +35.2% | +44.7% | −4.3% | −8.66 | **55%** | −12.52 | −9.05 |
| **BASELINE fixed 30 s** | −0.5% | +0.3% | +3.3% | +23.3% | −4.5% | −9.01 | 52% | −12.87 | −9.39 |
| TRAIL 20% cap 5m | −80.0% | −8.8% | +32.3% | +111.7% | −6.1% | −12.12 | 42% | −15.98 | −12.50 |
| TP +100% cap 15m | −82.5% | −49.0% | +102.4% | +123.2% | −7.2% | −14.44 | 31% | −18.30 | −14.83 |
| TRAIL 30% cap 15m | −82.4% | −54.5% | −0.2% | +139.5% | −15.5% | −31.04 | 25% | −34.90 | −31.42 |
| BASELINE fixed 15m | −82.5% | −60.9% | −4.1% | +157.1% | −13.4% | −26.80 | 23% | −30.66 | −27.19 |

*(eight of twenty shown; all twenty are in the run output and all twenty are negative)*

**PATH-DEPENDENT EXITS DO BEAT THE BEST FIXED HORIZON** — `TP +200%` at SUM −3.99
against the 30-second baseline's −9.01 — **and not one of them reaches zero.**

**THE STOPS DO NOT HELP AND SOMETIMES HURT.** `TP +50%` alone is −22.23; adding a −20%
stop makes it **−25.40**. The stop exits positions that would have recovered, and it
never catches the ones it was bought for. 6H.3 is why.

### 6H.3 THE MECHANISM — THE LOSS IS NOT A PATH, IT IS AN EVENT

**101 of 200 positions end below −70%. In 95 of those 101 the entire fall happens inside
ONE sample interval.** [MEASURED] Six are gradual. The median final value of that group
is **exactly −82.5%**, repeated across pools — the signature of one template, not of a
market.

**Decoded at block resolution on pool `0x03216ffe61e7…`, whose path reads
`+40s = +2.3%`, `+60s = −82.0%`:**

```
blk +453   our position +2.3%
blk +454   ONE TRANSACTION   ETH +3.5702 out   TOKEN -582,003,607 in
           tx 0x4c26b5c48a41f8ba
blk +455   our position -82.0%
```

**582,003,607 of 1,000,000,000 is 58.2% of the entire supply, sold in a single
transaction — and 58.20% is EXACTLY the p75 creator share §6F.6 measured.** This is the
creator selling the whole allocation they bought inside the creation transaction,
roughly forty-five seconds after launch.

**THAT IS WHY NO EXIT RULE CAN WORK.** The pool never prints a price between +2.3% and
−82%. There is no −20% to stop out at, no −30%, no trailing level in between. Block 453
is +2.3% and block 454 is −82%. **A perfect tick-by-tick bot with zero latency sees
exactly the same two numbers we do.** Stop losses, trailing stops and take-profits are
all instruments for trading a *path*; this is an *event*, and the only defence against
an event is not being in the position when it happens.

And §6F.3 already established the other half: **the creator's buy is inside the creation
transaction, so we cannot be earlier than them, and §6F.4 measured no price move between
their buy and their dump.** We are not early to a rally. **We are the exit liquidity.**

### 6H.4 4D-3 — THE HONEST ANSWER

**Is there ANY entry/exit pair whose net expectancy over the sample is positive?**

**No.** Thirty fixed cells in §6G and twenty trigger rules here — **fifty rules, all
negative, on 200 positions.** The best of all fifty is `TP +200% cap 15m` at **−2.0% per
trade before gas**, −4.38 summed over 200 trades even at a $100 position size.

**There is no strategy here, and I am not going to reach for a filter to rescue it.**

**WHAT WOULD REFUTE THIS.** A rule whose SUM over these same 200 stored paths is
positive after the 0.50% round trip and gas. The paths are in `bot_exit_path` and any
new rule can be evaluated against them **for free** — no RPC, no new spend. That is the
cheapest possible refutation and it is available to anyone who wants to try one.

**ONE PRE-REGISTERED HYPOTHESIS REMAINS UNTESTED, AND IT IS NOT A RESCUE.** §6F.6 flagged
the creator's supply share as bimodal — p25 2.52%, p75 58.20% — *before* any of this was
measured, and 6H.3 shows the dump size matching that p75 exactly. Splitting the
population on it is a legitimate next measurement rather than a fishing expedition.
**But it is not an argument that a strategy exists**, for two reasons that should be
stated plainly: it would at best identify a subset to avoid, leaving a smaller
population whose own expectancy is unmeasured; and the half with small creator shares
still has to clear a 0.50% fee and gas on a median that has never, across four passes
and every population measured, come out above the fee.

### 6H.5 4D-4 — SIZE, AND OUR OWN IMPACT

**Size does not rescue it.** Gas is absolute: $0.193 a round trip, so 19.3% of a $1
position, 1.93% at $10, 0.193% at $100. The best rule's SUM goes −7.85 at $10 to −4.38
at $100 — **better, and still negative.** A rule losing 2.0% per trade before costs
loses at every size. **$100 is also the whole wallet, which last read $7.71.**

**OUR OWN IMPACT, BOUNDED AS §6A.4 REQUIRES.** Every sell here is simulated into a pool
that does not contain our own buy. Against the 3.57 ETH of depth decoded in 6H.3:

- at **$1** our buy is 0.000562 ETH = **0.016% of pool depth** — immaterial, and the
  figures above stand as measured;
- at **$10**, 0.16%;
- at **$100**, 0.0562 ETH = **1.6%** of depth, which is material and would make the
  $100 column **optimistic** — the one column where the number looks least bad.

**Impact is worst at the earliest entry, which is exactly where §6F.5 showed the p75 is
best.** That does not change the verdict, because the verdict is negative at every size
and would only become more so.

---

## 6I. 4F-1 AND 4F-2 — UNCAPPED RULES FAIL; THE CREATOR-SHARE SPLIT SEPARATES

Two spends, both stated because the brief required zero new RPC unless justified.
**The stored paths ended at 30 minutes**, and §6G puts the best single outcomes at
+2,672% (30 m), +1,151% (1 h), +407% (2 h) and −0.0% by 6 h — so the peaks an uncapped
rule exists to ride sat **outside** the stored path. Running "uncapped" to the end of a
30-minute path is a 30-minute cap wearing a different name. Four points were added at
40/60/90/120 min (**$0.05**), and creator share was read from each pool's own launch
block (**$0.005**) because it is in no table we hold. **All 200 paths now reach 120
minutes; zero were truncated.**

### 6I.1 4F-1 — UNCAPPING MAKES IT DRAMATICALLY WORSE

| rule | p25 | median | p75 | p90 | mean | **SUM** | win% | **SUM−best** |
|---|---|---|---|---|---|---|---|---|
| BASELINE fixed 30 s | −0.5% | +0.3% | +3.3% | +23.3% | −4.5% | −9.01 | 52% | −11.34 |
| BASELINE TP+200% cap 15 m (§6H best) | −82.5% | −58.6% | +68.1% | +203.3% | −2.0% | **−3.99** | 28% | −7.98 |
| TRAIL 20% UNCAPPED | −82.3% | −60.5% | −4.9% | +54.4% | −34.8% | −69.64 | 21% | −71.73 |
| TRAIL 30% UNCAPPED | −82.5% | −69.8% | −30.3% | +38.5% | −46.8% | −93.51 | 12% | −95.61 |
| TRAIL 50% UNCAPPED | −82.5% | −81.1% | −48.9% | −15.1% | −62.2% | −124.40 | 3% | −126.50 |
| half at +100%, trail 30% uncapped | −82.4% | −54.2% | +18.4% | +84.2% | −26.6% | −53.14 | 28% | −56.49 |
| ladder 25/25/25 + trail 30% uncapped | −81.9% | −46.3% | +15.9% | +95.2% | −19.1% | −38.24 | 29% | −43.30 |
| **HOLD to 120 min, no rule** | −82.5% | −82.2% | −49.0% | −20.0% | −67.4% | **−134.81** | **0%** | −134.80 |

**Every uncapped rule is worse than the capped baseline, most of them by an order of
magnitude.** The best uncapped variant (−38.24) is ten times worse than `TP +200%`
capped at 15 minutes (−3.99).

**AND THE "LET WINNERS RUN" THESIS DIES ON ONE LINE: holding to 120 minutes has a win
rate of ZERO.** Not one of 200 positions is positive at two hours. There is no 50x to
wait for — §6H.3 showed why, and it is the same reason: the creator's single-transaction
dump takes the position to −82% and it never comes back.

**NO OUTLIER CARRIES ANY RESULT.** `SUM−best` — the same sum with the single best
position removed — moves the figures by 2 to 5 points on sums of 40 to 130. On the
120-minute hold it moves by **0.01**. Nothing here rests on one trade.

### 6I.2 4F-2 — THE CREATOR-SHARE SPLIT SEPARATES, AND IN THE OPPOSITE DIRECTION

**The pre-registered hypothesis was that a LARGE creator share is the danger signal.**
§6F.6 measured it as bimodal and §6H.3 decoded a dump of 58.2% of supply — exactly the
p75. The natural reading was that high-share launches are the ones that dump on you.

**That is backwards. Under a 30-second hold, the high-share bucket is the profitable
one.** [MEASURED]

| bucket | n | dead% | p25 | median | p75 | mean | **SUM** | win% |
|---|---|---|---|---|---|---|---|---|
| share < 5% | 34 | **32%** | −100.0% | −7.4% | −0.1% | −34.7% | −11.80 | 24% |
| 5–10% | 14 | 0% | −11.3% | −11.3% | −0.5% | −4.4% | −0.61 | 7% |
| 10–20% | 8 | 0% | −0.4% | −0.4% | +23.3% | −1.9% | −0.15 | 38% |
| 20–40% | 30 | 0% | −0.4% | −0.3% | +3.3% | −4.1% | −1.22 | 37% |
| **share ≥ 40%** | **114** | **0%** | **−0.3%** | **+1.1%** | **+4.2%** | **+4.2%** | **+4.78** | **71%** |

**THE HOLDOUT REPRODUCES IT.** Split on the parity of the pool id — fixed by the data,
not chosen after looking — with the refutation condition stated before the measurement:

| | n | dead% | median | mean | SUM | win% | net @$1 | net @$10 | net @$100 |
|---|---|---|---|---|---|---|---|---|---|
| share ≥ 40%, **all** | 114 | 0% | +1.1% | +4.2% | +4.78 | 71% | **−17.22** | **+2.58** | **+4.56** |
| share ≥ 40%, **half 0** | 49 | 0% | +1.1% | +3.4% | +1.65 | 65% | −7.81 | **+0.71** | +1.56 |
| share ≥ 40%, **half 1** | 65 | 0% | +1.1% | +4.8% | +3.13 | 75% | −9.42 | **+1.87** | +3.00 |
| share < 40%, all | 86 | 13% | −0.5% | −16.0% | −13.79 | 27% | −30.38 | −15.45 | −13.95 |

**Both halves positive, same sign, similar magnitude. The refutation condition — halves
disagreeing in sign, or either negative — did not occur.**

**AND THE MECHANISM IS MEASURED, NOT INVENTED.** On the 114 high-share launches, the
first collapse of more than 50 points appears at:

```
p10  60 s      p25  120 s      median  375 s (6.3 min)      p75  750 s
```

**A 30-second hold exits before the creator's dump.** §6H.3 decoded that dump at block
+454 ≈ 45 seconds on one pool; across the population its median is six minutes. The
high-share creator buys a large block at the launch price — which is *why* there is
anything to ride — and sells it minutes later. **We are still the exit liquidity; we
simply leave before the exit.**

### 6I.3 THE HONEST ACCOUNTING OF THAT RESULT

**At $1 it loses money.** Gas is an absolute $0.193, so 19.3% of a $1 position against a
+4.2% mean: **net −17.22 over 114 trades.** The $1 size is instrumentation (§6B.1) and
cannot be profitable at any edge this small.

**At $10 it is positive: +2.27% per trade, +$25.80 over 114 trades.** At $100, +4.01%
per trade. **This is the first positive expectancy measured in five passes.**

**IT IS ALSO UNFUNDABLE AS THINGS STAND.** 114 of 200 is 57% of canonical launches ≈
**242 a day**. At $10 a position with the current rails — `MAX_TRADES_PER_RUN 10`,
`MAX_POSITION_USD 1` — this needs the position size raised tenfold and $100 of working
capital. **The wallet last read $7.71.**

### 6I.4 THREE LIMITS ON THIS FINDING, STATED BEFORE ANYONE ACTS ON IT

**1. THE HOLDOUT CONTROLS FOR THE WRONG THING.** Splitting by pool-id parity tests
whether the result is an artefact of *particular pools*. It does **not** test whether it
survives a different *time*. §6C measured this chain's edge halving in three weeks, and
a within-window holdout cannot see that. **An out-of-time test on a later window is the
test that matters and it has not been run.**

**2. THE CREATOR-SHARE DISTRIBUTION MOVED BETWEEN TWO SAMPLES AND I CANNOT YET SAY
WHY.** §6F.6, on a **more recent** window (65.8M–66.7M), measured median share **3.79%**.
This pass, on an **older** window (63.3M–65.9M), measures median **49.9%** — while both
put p75 at **58.2%**, the same high mode. **If the population is shifting toward the
low-share bucket, the profitable bucket is shrinking**, and the figures above describe a
regime that may already be ending. This is the single biggest risk to the result and it
is cheap to check.

**3. n = 114 IN ONE THREE-DAY WINDOW.** A 71% win rate on a +1.1% median is a thin edge
carried by many small wins; it needs only a modest shift in the dump timing to invert.

**WHAT WOULD REFUTE THIS RESULT:** the high-share bucket's SUM coming out negative on a
later window, or the median collapse time moving earlier than 30 seconds. **Both are
measurable on stored machinery, and neither has been done.**

---

## 6J. 4G-1 — THE POPULATION IS SHIFTING *TOWARD* THE PROFITABLE BUCKET

### 6J.1 A CORRECTION: §6F.6's "MEDIAN CREATOR SHARE 3.79%" IS WRONG

**Re-measured over §6F.6's own window (65,815,455–66,715,455) by a single code path,
the median creator share is 58.2%, not 3.79%.** [MEASURED, n=69]

**It is not a method difference, and that was checked two ways rather than argued.**
Both call sites were read side by side — same `eth_getLogs` filter
(`topics = [swapV4, poolId]`, the pool's own init block alone), same v4
swapper-perspective sign convention, same "TOKEN side positive" selection, same 1e27
denominator. Then the two predicates that *did* differ (`c0 === native ETH` against
`PRICING.includes(c0)`) were run against each other on **25 individual records: 0
disagreements, because every canonical Pools.trade pool has `currency0 = native ETH`,
which makes the difference inert.**

**THE CAUSE IS THAT A MEDIAN IS THE WRONG STATISTIC FOR THIS QUANTITY.** Creator share
is strongly bimodal [MEASURED, n=1,395 across 30 days]:

```
  0– 5%   909  ███████████████████████████████████████
  5–10%   127  █████
 10–15%    45  ██
 25–30%    61  ███
 55–60%   135  ██████        <- the second mode, tight
 60–65%     7
```

**65.2% sit below 5% and a hard spike sits at 55–60%. There is almost nothing in
between.** With two modes and no middle, the median reports *whichever mode holds the
majority of the sample* and flips on a modest sampling difference — which is exactly
what happened between §6F.6's 120 pools and this pass's 69. **§6F.6's 3.79% should be
read as "the low mode was the majority in that sample", never as a population median.**

This is the same shape `ROBINHOOD.md` records for metric 5, where a statistic kept
landing on a round function of a configured count and was read as a fact about wallets
three times. **The robust statistic here is the SHARE AT OR ABOVE 40%**, which is also
the only one the strategy depends on, and it is what the table below reports.

### 6J.2 THE TREND — AND IT IS THE OPPOSITE OF THE RISK I FLAGGED

Canonical Pools.trade launches per day, full enumeration; creator share sampled at 45
pools a day. `≥40%/day` is **launches × sampled rate — INFERRED from a MEASURED rate**,
not a census.

| bucket | first block | launches | n | median | **≥40%** | **≥40%/day** |
|---|---|---|---|---|---|---|
| 47–69 | 40.6M–59.6M | 220–1,168 | 45 | 0.0–7.3% | **0.0–8.9%** | 0–41 |
| 70 | 60,480,000 | 220 | 45 | 3.6% | 0.0% | 0 |
| 71 | 61,344,000 | 217 | 45 | 4.6% | 2.2% | 5 |
| **72** | 62,208,000 | 497 | 45 | 5.6% | **11.1%** | 55 |
| **73** | 63,072,000 | 437 | 45 | 37.4% | **46.7%** | **204** |
| **74** | 63,936,000 | 432 | 45 | 49.9% | **62.2%** | **269** |
| **75** | 64,800,000 | 332 | 45 | 58.2% | **66.7%** | **221** |
| **76** | 65,664,000 | 320 | 45 | 58.2% | **60.0%** | **192** |
| **78\*** | 66,528,000 | 101\* | 45 | 58.2% | **60.0%** | 61\* |

*\* partial bucket — fewer blocks, so its launch COUNT is not comparable with a full
day; its share distribution is.*

**THE ≥40% BUCKET IS GROWING, NOT SHRINKING.** It sat at 0–9% for twenty-four days
(buckets 47–71), stepped up at bucket 72, and has held at **46.7% → 62.2% → 66.7% →
60.0% → 60.0%** for the five buckets since. **In absolute terms it went from ~0–40
launches a day to roughly 190–270 a day.**

**THE REGIME CHANGE IS AT BLOCK ~62.2–63.1M** and is a step, not a drift.

### 6J.3 WHAT THIS DOES AND DOES NOT MEAN FOR §6I

**GOOD:** §6I's sample window (63,269,189–65,861,189) sits **entirely inside the new
regime**, and the most recent measurable days are in the same regime at the same rate.
**§6I is not describing a regime that has already ended** — that specific risk, the one
I named as most likely to kill it, is **refuted.**

**BAD, AND IT REPLACES THE OLD RISK WITH A NEW ONE:** the regime is **about five days
old.** Everything §6I measured, and everything 4G-2 can measure, comes from those same
five days. **There is no long history to validate against, and a five-day-old regime can
end as abruptly as it began** — it began abruptly. A step change with no identified
cause is not a foundation.

**WHAT WOULD REFUTE THE TREND:** the ≥40% rate falling back toward 0–9% in the next
buckets. That is cheap to re-measure — `share-trend` is pinned, idempotent and costs
~$0.008 a day to extend.

**I have not projected anything**, per the brief. The table is what was measured; the
five buckets since the step are what exist.

---

## 6K. 5A — THE RUNNERS EXIST, AND THERE ARE ~179 A DAY

**Every exit rule this project has tested is discarded for this pass.** 5A labels the
OUTCOME only: from a +15 s entry, what did the token's own pool do over the next fifteen
minutes? No rule of ours is involved.

**Window PINNED `60,480,000..66,528,000` — seven full days spanning the §6J regime
change. n = 1,016 labelled launches.**

### 6K.1 THE METHOD, AND ITS DIRECTION IS VALIDATED RATHER THAN REASONED

The v4 `Swap` event carries **`sqrtPriceX96` as its third data word**, so one sparse
`eth_getLogs` per pool yields the whole mid-price path for **60 CU** — against ~75 sell
simulations at ~1,950 CU. **Thirty-two times cheaper**, and it is the token's own path
as the brief specified. Total spend: **66,360 CU ≈ $0.03.**

`currency0` is native ETH here, so v4's `price = token1/token0` is **tokens per ETH** and
moves *inversely* to a position's value — the inversion §6H.1 records. **That was not
trusted.** Every pool that also has a stored sell-proceeds path was cross-checked:

```
pools with both    41
agree              39        95.1%   CONFIRMED
```

### 6K.2 THE RESULT

Peak multiple over 15 minutes, from a +15 s entry: [MEASURED, n=1,016]

```
p50  +23.5%     p75  +125.3%     p90  +315.3%     p99  +1,381.6%     max  +19,417%
```

| tier | count | rate | **INFERRED per day** |
|---|---|---|---|
| **peak ≥ +50%** | 428 of 1,016 | **42.1%** | **~179** |
| peak ≥ +100% | 304 | 29.9% | ~127 |
| peak ≥ +200% | 168 | 16.5% | ~70 |

*Per-day counts are 424 canonical launches/day (§6J, a full enumeration) × the SAMPLED
runner rate — INFERRED, not a census.*

**The operator set the kill line at ~5 runners a day. It is 179 at the +50% tier and 70
at +200%. This is not supply-constrained by two orders of magnitude.**

### 6K.3 THE FINDING THAT EXPLAINS EVERY PRIOR FAILURE: TIME-TO-PEAK

**Time to peak, on the ≥+50% runners:** [MEASURED]

```
p25  246 s        median  490 s (8.2 min)        p75  768 s        p90  893 s
```

**The peak lands at a median of eight minutes, and every fixed exit this project has
tested sat on the wrong side of it.** §6G's grid held at 15 s, 30 s, 90 s — all *before*
the run — then jumped to 15 m, 30 m and beyond, *after* the collapse §6H.3 decoded. The
one cell nearest the peak, 5 m, is the only one whose p90 looked interesting (+85.5%).

**So "no strategy" in §6H was a true statement about the rules tested and a false
impression about the market.** The runs were there the whole time; the clock was never
pointed at them.

### 6K.4 THE CAVEAT THAT MATTERS, AND IT IS SMALLER THAN EXPECTED

**A mid-price peak is not a realisable return**, and §6A.3 is the record of confusing
those. Measured directly on the 41 pools that have both:

| | p25 | median | p75 | p90 |
|---|---|---|---|---|
| MID-PRICE peak | 0.0% | +41.6% | +140.2% | +318.1% |
| **REALISABLE peak** | 0.0% | **+32.7%** | **+110.4%** | **+217.9%** |

**The realisable gain retains a median 82% of the mid-price gain**, and the runner count
barely moves: **19 of 41 by mid-price, 17 of 41 by realisable.** [MEASURED, n=41]

So the labelling is a sound proxy — **but n=41 is thin, the p25 is 0.0% on both, and
every figure in 6K.2 should be read as roughly a fifth optimistic.** 5D must price a
real sell; nothing here is a return we could have banked.

### 6K.5 ONE THING THE PER-DAY TABLE SHOWS THAT §6J DID NOT

| bucket | n | median swaps in 15 min | ≥+50% |
|---|---|---|---|
| 70 | 150 | 12 | 27% |
| 71 | 144 | 25 | 40% |
| 72 | 150 | 9 | 31% |
| 73 | 147 | 49 | 42% |
| **74** | 143 | **464** | **65%** |
| **75** | 145 | **502** | 50% |
| 76 | 137 | 182 | 41% |

**The runner RATE is broadly stable at 27–65% across the regime change** — runners are
not a new phenomenon and did not arrive with it. **Trading ACTIVITY is not stable at
all**: median swaps per launch in the first fifteen minutes went from 9–49 to 182–502.
Whatever changed at bucket 73–74 changed how much gets traded, not how often something
runs.

### 6K.6 What 5A does and does not establish

- **ESTABLISHED:** runners are numerous — ~179/day at +50%, ~70/day at +200%. Supply is
  not the constraint.
- **ESTABLISHED:** the peak lands at a median of 8.2 minutes, which is why every fixed
  clock tested so far missed it.
- **NOT ESTABLISHED, AND IT IS THE WHOLE REMAINING QUESTION:** whether a runner is
  identifiable *before or at* our entry. 5A is an after-the-fact label and nothing more.
- **NOT ESTABLISHED:** that the peak is capturable. §6H.3 showed the fall is a single
  transaction, and a trailing stop on real proceeds lost badly in §6I.1. Exiting near an
  8-minute peak is a different problem from the ones already tested, and it is untested.

**WHAT WOULD REFUTE 6K.2:** a realisable-sell re-measurement on a larger sample showing
the ≥+50% rate far below 42%. The 41-pool cross-check puts it at 17/41 = 41.5%, which is
consistent — but that is 41 pools, not 1,016.

---

## 6L. 5B — 21 QUANTITIES TESTED, ONE REAL SEPARATOR

§6K labelled 1,016 launches; 428 are runners (peak ≥+50% within 15 min of a +15 s
entry). **This asks whether a runner was identifiable before or at our entry.**

**Two constraints decided what could be measured.** Nothing observable after **+15
seconds** — the operator enters there, so a quantity readable only at +60 s is useless
whatever it correlates with, and the cut-off is enforced in the query. And runners are
compared only with **non-runners from the same hour**: §6K.5 measured median swaps per
launch moving 9 → 502 across these days, so unstratified, chain activity would carry any
signal it liked. **133 hour buckets, 105 of them containing both classes.**

**The effect size is a stratified Cliff's delta, not a p-value** — `P(runner >
non-runner) − P(runner < non-runner)`, computed within each hour and pooled by pair
count. A t-test on a distribution whose p99 is +1,381% would be reporting the tail.
**The bar was set before the table was read: |δ| ≥ 0.15 and a visible median gap.**

### 6L.1 THE FULL TABLE — EVERYTHING TESTED, INCLUDING THE NULLS

| feature | med(runner) | med(non) | **δ** | verdict |
|---|---|---|---|---|
| **largest single buy by +15 s** | 3.200 | 0.150 | **+0.418** | **SIGNAL** |
| **creator supply share** | 56.0% | 5.6% | **+0.412** | **SIGNAL** |
| **creator ETH into creation tx** | 3.200 | 0.150 | **+0.412** | **SIGNAL** |
| **total ETH in by +15 s** | 3.202 | 0.161 | **+0.309** | **SIGNAL** |
| distinct buyers by +10 s | 4 | 4 | −0.226 | nothing |
| has emoji | 1 | 0 | **+0.169** | **SIGNAL** |
| distinct buyers by +5 s | 3 | 4 | **−0.169** | **SIGNAL** |
| swaps by +15 s | 5 | 5 | −0.151 | nothing |
| creator appears >1× in sample | 1 | 0 | +0.150 | nothing (at the bar) |
| distinct buyers by +15 s | 5 | 5 | −0.150 | nothing |
| sells by +15 s | 0 | 0 | −0.126 | nothing |
| sell/swap ratio by +15 s | 0 | 0 | −0.122 | nothing |
| someone sold inside +15 s | 0 | 0 | −0.130 | nothing |
| pool liquidity at init | 5.007e22 | 5.007e22 | +0.091 | nothing |
| best scored-wallet score | 0.3878 | 0.3878 | +0.077 | nothing |
| token name length | 8 | 8 | −0.058 | nothing |
| token symbol length | 5 | 5 | −0.036 | nothing |
| description length | 8 | 9 | +0.030 | nothing |
| symbol collides with a known token | 0 | 0 | +0.029 | nothing |
| **a SCORED wallet bought by +15 s** | 0 | 0 | **−0.024** | nothing |
| description empty | 0 | 0 | −0.010 | nothing |

### 6L.2 FOUR OF THE SIX "SIGNALS" ARE ONE VARIABLE — VERIFIED ON RECORDS

**MEASURED, n=1,016:**

```
creator_eth EXACTLY equals largest_buy_15s      952 of 1,016   93.7%
creator_eth is >95% of ALL ETH in by +15 s      649 of 1,016   63.9%
creator_share >= 40%   ->  median creator ETH   3.500
creator_share <  40%   ->  median creator ETH   0.150
```

**The creator's own launch buy IS the largest buy, IS most of the ETH that arrives in
the first fifteen seconds, AND is what the supply share measures.** Reporting four
signals would be reporting one four times — the collinearity trap `ROBINHOOD.md`
section 8 records for fee tier and launchpad.

**So: 21 quantities tested, THREE distinct separators.**

| | δ | size |
|---|---|---|
| **creator buy size** (4 collinear measures) | **≈ +0.41** | **medium** |
| has emoji | +0.169 | small |
| fewer distinct buyers by +5 s | −0.169 | small |

**And the two small ones must be read against 21 tests.** At that many comparisons a
couple of |δ| ≈ 0.17 results are what chance produces; only the δ ≈ 0.41 is clear of it.
**The honest count is one strong separator and two that need 5C to survive.**

### 6L.3 THE NULLS THAT MATTER MORE THAN THE SIGNALS

- **THE OPERATOR'S SCORED WALLETS DO NOT APPEAR. δ = −0.024, and only 27 of 1,016
  launches (2.7%) had ANY scored wallet buy within fifteen seconds.** [MEASURED] The
  hypothesis that the existing Discord alert system could front-run these is refuted at
  the entry point — **it is consistent with the operator's own observation that good
  wallets arrive 5–15 minutes late, and it means they arrive after the median 8.2-minute
  peak (§6K.3), not before it.**
- **Pool liquidity at init carries no information at all** — medians identical to four
  significant figures (5.007e22). It is a template constant, exactly as §6D.5 found for
  the lock. A filter on it would match everything.
- **No metadata feature separates**: name length, symbol length, description length,
  empty description, symbol collision — all |δ| ≤ 0.06. **Effort put into the listing
  does not predict a run**, with the marginal exception of an emoji.
- **Nothing about early SELLING separates.** Sells by +15 s, sell ratio, and whether
  anyone sold at all are all null. The dump that §6H.3 decoded happens at a median of
  six minutes — **far outside the window we can see before buying.**

### 6L.4 WHAT THIS CONFIRMS, FROM A SECOND DIRECTION

§6I found the **creator share ≥40% bucket** was the only profitable one, by splitting on
returns. 5B arrives at the same variable from a completely different route — by
labelling outcomes and asking what differs. **Two independent methods, one variable.**

That is the strongest thing in this pass. It is also the *only* substantial thing, and
**it has not yet been tested out of time** — §6I's holdout was pool-id parity, which
tests for a pool artefact and not for a regime. **5C is that test and it is free**, since
every feature is stored.

**WHAT WOULD REFUTE 6L.2:** the creator-buy δ falling below the bar on the later half of
the window. **WHAT WOULD CONFIRM THE TWO SMALL ONES ARE NOISE:** emoji and early-buyer
count failing to reproduce there — which, at 21 comparisons, is what I expect.

---

## 6M. 5C — ONE SIGNAL SURVIVES OUT OF TIME

**Zero RPC.** Split at the median initialization block — train earlier, test later — with
the split point derived from the data and printed before any delta was read.

```
1,016 pools   split at block 63,442,830
early  508 pools, runner rate 34.1%
late   508 pools, runner rate 50.2%
```

**AND IT IS A HARDER TEST THAN THE BRIEF INTENDED, WHICH WAS FLAGGED BEFORE RUNNING IT.**
§6J puts the regime change at ~63,072,000, **inside the early half** — so the early half
straddles two regimes and the late half sits entirely in the new one. A signal surviving
that survived a regime change; one that fails might fail only because the halves are
different markets. **So a second split, held entirely within the new regime, is reported
beside it.**

### 6M.1 THE RESULT

| feature | δ(early) | δ(late) | verdict |
|---|---|---|---|
| **creator ETH into creation tx** | **+0.533** | **+0.285** | **REPRODUCES** |
| *(collinear)* creator supply share | +0.533 | +0.285 | reproduces |
| *(collinear)* largest buy by +15 s | +0.545 | +0.285 | reproduces |
| *(collinear)* total ETH in by +15 s | +0.396 | +0.226 | reproduces |
| has emoji | +0.104 | +0.238 | **never trained** — below the bar on the training half |
| distinct buyers by +5 s | −0.279 | −0.038 | **DROPPED** |
| *control:* distinct buyers by +10 s | −0.380 | −0.049 | DROPPED |
| *control:* pool liquidity at init | +0.095 | +0.090 | not a signal |
| *control:* token name length | −0.104 | −0.027 | not a signal |

**Within the new regime only** (n=286 / 286, regime held constant):

| feature | δ(A) | δ(B) | verdict |
|---|---|---|---|
| **creator ETH into creation tx** | **+0.305** | **+0.263** | **REPRODUCES** |
| total ETH in by +15 s | +0.274 | +0.147 | DROPPED |
| has emoji | +0.271 | +0.116 | DROPPED |
| distinct buyers by +5 s | −0.076 | −0.019 | not a signal |

**ONE SIGNAL SURVIVES BOTH TESTS: the size of the creator's own launch buy.**

### 6M.2 WHAT THE CONTROLS SAY ABOUT THE ESTIMATOR

Three features that **failed** 5B were carried through deliberately. **None of them
"reproduced"** — `buyers by +10 s` trained at −0.380 and collapsed to −0.049, pool
liquidity and name length stayed flat in both halves. **The estimator is not
manufacturing structure**, which is what makes the one survivor worth believing.

**And `buyers by +5 s` behaved exactly like the controls: −0.279 → −0.038.** It was one
of 5B's two small signals; it is now dropped. §6L warned that at 21 comparisons a couple
of |δ| ≈ 0.17 is what chance produces, and that is what this was.

**`has emoji` never even trained.** Its pooled 5B value of +0.169 came apart into +0.104
on the early half — below the bar — so there was nothing to hold out. **A pooled effect
that does not survive being split was never a stable effect.**

**21 quantities tested → 3 candidates → 1 survivor.** That is the honest count.

### 6M.3 THE GAP IS VOLATILE BUT NOT DECAYING — CHECKED BECAUSE IT LOOKED LIKE IT WAS

The within-regime test showed medians of **3.500 (runner) against 3.400 (non-runner)** —
nearly touching, despite δ = +0.263. That looked like a closing gap, so it was measured
per day rather than assumed:

| day | n | runner% | med creator ETH, RUNNER | NON-RUNNER | gap |
|---|---|---|---|---|---|
| 70 | 150 | 27% | 0.132 | 0.050 | 0.082 |
| 71 | 144 | 40% | 1.000 | 0.050 | 0.950 |
| 72 | 150 | 31% | 1.000 | 0.140 | 0.860 |
| 73 | 147 | 42% | 1.900 | 0.150 | 1.750 |
| 74 | 143 | 65% | 3.500 | 1.500 | 2.000 |
| **75** | 145 | 50% | 3.500 | **3.400** | **0.100** |
| **76** | 137 | 41% | 3.500 | **0.300** | **3.200** |

**Day 75 is a single anomalous day** on which non-runners also carried large creator
buys. **Day 76 — the most recent measured — has the WIDEST gap of the seven (3.200
ETH).** The signal is not decaying; the within-regime medians converged because day 75
sits inside that window.

**What this does mean: day-to-day variance is very large** (gap 0.08 to 3.20 ETH,
runner rate 27–65%). Any rule built on this will have days where it separates nothing,
and **a live test short enough to land inside one day 75 would read as a failure.**

### 6M.4 Where this leaves 5D

- **The signal is:** a large creator buy in the creation transaction, readable at block 0,
  **before our entry at +15 s.** Median 3.5 ETH in runners against 0.05–1.5 ETH in
  non-runners on most days.
- **It reproduces out of time, across a regime change, and again within the regime.**
- **It is the same variable §6I found** by splitting on returns rather than outcomes —
  two independent methods, one answer.
- **It is not yet a trade.** §6K.4 measured the realisable peak at ~82% of the mid-price
  peak on n=41, and §6H.3 established the fall is a single transaction with no
  intermediate price. **Whether an 8.2-minute peak can actually be exited is untested**,
  and that — not the signal — is what 5D has to answer.

---

## 6N. 5D AND 5E — THE SIGNAL IS REAL AND IT IS NOT A TRADE

The one signal that survived 5C — **creator buy size**, threshold `creator_share >= 40%`
**pre-registered in §6I** before §6K–§6M existed — fires on **379 of 1,016 launches
(37.3%) ≈ 158 a day.** Entry at +15 s. Nine exit rules placed on §6K.3's measured
time-to-peak quantiles. **Every exit priced with a REAL simulated sell at a reachable
bound — no mid-price anywhere in 5D.**

### 6N.1 THE RULE WAS SELECTED ON THE TRAINING HALF AND IT FAILED ON THE HOLDOUT

Selection, **training half only** (n=48):

```
TP +50% or TRAIL 30%, cap p90     mean +14.2%   SUM +6.83   win 63%   <- SELECTED
TP +50%, cap p90                  mean +12.8%   SUM +6.15   win 63%
fixed hold to p25 (246 s)         mean +10.5%   SUM +5.05   win 58%
```

**Held out (n=331):**

| rule | p10 | p25 | median | p75 | mean | **SUM** | win% | maxDD | net@$100 |
|---|---|---|---|---|---|---|---|---|---|
| **TP +50% or TRAIL 30% — PRE-SELECTED** | −83.1% | −82.6% | +1.7% | +65.4% | **−4.3%** | **−14.35** | 50% | 29.92 | **−14.99** |
| fixed hold to +246 s | −82.8% | −82.4% | +19.1% | +41.5% | +0.3% | +1.13 | 62% | 14.58 | +0.49 |
| fixed hold to +490 s | −83.6% | −82.6% | −79.3% | +61.1% | −4.1% | −13.61 | 41% | 29.10 | −14.25 |
| TP +50%, cap p90 | −83.8% | −82.6% | +1.7% | +65.4% | −5.4% | −18.00 | 50% | 32.26 | −18.64 |
| TRAIL 30%, cap p90 | −83.4% | −82.6% | −82.2% | +1.7% | −28.6% | −94.65 | 25% | 110.92 | −95.29 |
| fixed hold to +768 s | −83.8% | −82.7% | −82.5% | +6.7% | −26.5% | −87.75 | 25% | 107.06 | −88.39 |

**THE PRE-SELECTED RULE IS NEGATIVE: SUM −14.35 over 331 trades, −14.99 net at $100.**

### 6N.2 THE ONE POSITIVE RULE IS INDISTINGUISHABLE FROM ZERO

`fixed hold to +246 s` came back **SUM +1.13, net @$100 +0.49.** It was **not**
pre-selected — it placed third in training. Reporting it as the finding would be picking
a rule after seeing the holdout, which the brief forbids and which is how every
overfitted backtest in this document was born. So it was tested against zero instead:

```
n 331    mean +0.34%    sd 69.8%    std error 3.84%
t-stat 0.089            95% CI  -7.2%  to  +7.9%
trades needed for the mean to be 2 SE from zero:  168,395
```

**A t-statistic of 0.089 is zero.** At ~158 qualifying launches a day, distinguishing
that mean from nothing would take **168,395 trades — about 1,066 days.** [MEASURED]

**And it is negative at $10** (−1.59% a trade) because absolute gas is 1.93% there. Only
at $100 does it clear gas, by +0.15% a trade, on a mean that is not different from zero.

### 6N.3 WHY — AND IT IS THE SAME REASON AS EVERY PRIOR PASS

**Look down the p10 and p25 columns: every rule, without exception, sits at −82% to
−84%.** The exit rule changes the median, the p75 and the win rate. **It does not move
the bottom quartile at all.**

§6H.3 decoded why on an individual record: the fall is **one transaction** — 582,003,607
tokens, 58.2% of supply, in a single block, taking the position from +2.3% to −82% with
no price in between. **No exit rule can fill at a price the pool never printed.**

So the picture is consistent across five passes:

- **The signal is real.** Creator buy size separates runners from non-runners, δ ≈ 0.41,
  reproduced out of time and within regime (§6M).
- **The runners are real.** 42% of launches peak ≥+50% within fifteen minutes (§6K).
- **And roughly a quarter of the signal's own population still gets dumped on**, at a
  price no stop can catch. The winners pay for some of it. They do not pay for all of it.

### 6N.4 5E — STATED PLAINLY

- **How many runners a day?** ~179 at +50%, ~127 at +100%, ~70 at +200% (§6K).
- **Does anything in the first 15 seconds separate them?** **Yes — one thing.** Creator
  buy size, δ ≈ 0.41. Twenty-one quantities were tested; the full list with every null is
  in §6L.1. **Notably: the operator's own scored wallets do NOT — only 27 of 1,016
  launches had any scored wallet buy within fifteen seconds.**
- **Does it reproduce out of time?** **Yes.** δ 0.533 → 0.285 across the median split,
  and 0.305 → 0.263 within the regime (§6M).
- **Is it a trade?** **No.** The pre-selected rule loses (SUM −14.35 held out). The best
  hindsight rule is +0.34% a trade with a t-statistic of 0.089 and would need ~1,066 days
  to distinguish from zero.
- **Worst drawdown:** 14.58 stake units on the best rule, 29.92 on the pre-selected one.
  **At $100 a trade that is a $1,458 drawdown** — against a wallet that reads $7.71.
- **Our impact:** median ETH in the pool at our entry is **3.512** (p10 2.917), so $1 is
  0.016% of depth, $10 is 0.16%, **$100 is 1.60% — 1.9% at the p10 pool.** The simulated
  sell does not contain our own buy, so **the $100 column is optimistic by about that
  much**, which is the only column that clears gas.

**WHAT WOULD REFUTE THIS.** An exit rule whose held-out SUM is positive by more than two
standard errors — on these same stored paths, at zero RPC cost, in `bot_trade_path`. Any
such rule must be named before it is scored, or it is a new hypothesis needing a fresh
holdout.

**ONE HONEST WEAKNESS IN THE DESIGN, STATED RATHER THAN BURIED.** The median-block split
put only **48** signal-firing launches in the training half against 331 in the holdout,
because the signal fires overwhelmingly in the post-§6J regime which *is* the later half.
**A rule chosen on 48 observations is a weak choice.** It does not rescue the result —
**eight of the nine rules are negative on the holdout and the ninth is zero** — but a
future pass wanting a fair selection needs a population that spans the regime evenly, and
that population does not exist yet because the regime is six days old.

---

## 7. Rules here the code does not implement

**ADDED 2026-09-19, from Part 4G-1:**

- **§6F.6's "median creator share 3.79%" IS WRONG and is corrected in §6J.1.** The same
  window re-measures at 58.2%. The quantity is bimodal — 65% below 5%, a spike at
  55–60%, almost nothing between — so its median flips on a sampling difference. Any
  figure in this document quoting a *median* creator share is unreliable; the **share at
  or above 40%** is the statistic to use.

**ADDED 2026-09-19, from Part 4C:**

- **`checkSellable` HAS THE SAME TWO DEFECTS `simulateSellAt` JUST HAD, AND IT IS THE
  LIVE PRE-BUY GATE.** §6E.1. It still discovers slots by integer scan only and still
  treats a missing allowance slot as fatal. **So the live gate would mark every
  Pools.trade launch unsellable and refuse to buy it** — the same population §6E.3
  measures at 0% unsellable. This must be fixed before any run that is meant to trade
  them.
- **Gas is an absolute cost and the $1 size makes it 19.3% of the position.** §6E.2. No
  configuration is net-positive at $1; the size is instrumentation and the document
  should never quote a net-at-$1 figure as a strategy result.

**ADDED 2026-09-19, from Part 4:**

- **`LAUNCHPADS` NAMES TWO UNISWAP CONTRACTS AND CALLS THEM LAUNCHPADS.** Section 6D.1.
  `0x58daec…` is the v4 PositionManager and `0x8366a3…` is the PoolManager. The rule's
  primary filter is therefore "which Uniswap entry point was used", not "which
  launchpad", and `rule.ts`'s own comment describing the launchpad as the productive
  signal is describing something else.
- **THE ENTRY RULE DISCARDS EVERY POOLS.TRADE LAUNCH.** Section 6D.3. `ALLOWED_FEES`
  excludes 2500 and `LAUNCHPADS` excludes the entry contract, so ~424 launches a day
  with a **measured 0% liquidity-withdrawal rate** are rejected twice over. This is the
  single highest-value fix on this list.
- **A LOOSE POOLS.TRADE FILTER IS WORSE THAN NONE.** Section 6D.5. Matching on the
  token's origin rather than on the creating transaction admits 433 secondary pools a
  day whose withdrawal rate is 37.3%, indistinguishable from the chain at large.

**ADDED 2026-09-18, from Part 3:**

- **A `fee-only` quote is traded on with `impactPct = 0`.** Section 6C.8. `bot/quote.ts`
  returns `basis: 'fee-only'` when a pool has too few observations to compute depth, and
  `launchbot.ts` proceeds with impact treated as zero. **All three of the live run's
  qualified trades were `fee-only`.** The rule this breaks is the standing one that an
  error path must never emit a plausible default. The fix is to refuse the trade, or to
  size it down, rather than to assume zero impact.
- **The exit loop's own wiring has never been executed.** Section 6B.8. Every decision
  Part 2 added is tripped by `rail-drill`, but the loop that reads a `holding` row, runs
  the sellability poll, calls `decideExitTrigger` and registers the blocklist has not run
  even in dry run, because the chain-wide halt blocks every mode.
- **The Permit2 deadlock fix has only ever been exercised against a scripted transport.**
  Section 6B.9.
- **Odyssey launches are structurally invisible to us.** Section 6C.9. They begin on a
  bonding curve with no pool, so an `Initialize` watcher cannot see one until it
  graduates. This is 4 launches by the only count available and is recorded for
  completeness rather than as a priority.
- **The sequencer feed's 100–300 ms lead is untested.** Section 6C.9. It is the only
  claim on the external list with a plausible mechanism that we have not measured.
- **`v4_pool_init` has block timestamps for only 15.6% of its rows**, which is why the
  launch rate had to be computed from block numbers instead. Any future per-day figure
  from that table via `block_times` will be a tenfold undercount.

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

- ~~**THE PRE-BUY SELLABILITY CHECK (2E) DOES NOT EXIST**~~ — **BUILT 2026-09-17**,
  `bot/sellability.ts`, wired into the loop before the buy and blocking in dry run too.
  **Its qualifying rate against live launches is still unmeasured** until a run reports
  one, and a thin pool deliberately does not disqualify.
- **THE POST-BUY RE-CHECK (2E-2) IS SPECIFIED AND STILL DOES NOT EXIST.** A position that
  becomes unsellable after entry still waits out the full +90 s horizon. The pre-buy check
  cannot see an owner who flips a switch after we are in, and this is the half that would.
- ~~**THE `exit-exec` ALLOWANCE DEADLOCK IS UNFIXED**~~ — **FIXED 2026-09-17.** A
  simulation failure decoding to an allowance error grants and retries once; a control
  case proves `V4TooLittleReceived` with short allowances attempts NO grant.
- ~~**THE NONCE IS STILL RE-READ PER TRANSACTION**~~ — **FIXED AND EXERCISED ON THREE
  REAL TRANSACTIONS 2026-09-17**, nonces 138 -> 139 -> 140. `'pending'` did not lag on
  that run, which is reported as no lag rather than as proof.
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

- **A TERMINAL STATUS IN NO SET IS A CAPITAL RAIL SWITCHED OFF.** `closed_unsimulatable`
  is in neither `NON_TERMINAL` nor `HELD`, and writing a live position into it blinded
  `MAX_CONCURRENT`, `MAX_DEPLOYED_USD`, `MAX_DAILY_LOSS_USD`, boot reconciliation and the
  needs_exit sweep at once — $120 of loss against a $50 limit. **Every status the code can
  write must be checked against both sets before it ships**, and nothing enforces that.
- **THE ARMING GATE BLOCKS ITS OWN RECOVERY, AND THIS IS NOT FIXED.** The wallet gate runs
  BEFORE `clearNeedsExit`, so a wallet drained by its own open positions refuses to boot
  and therefore cannot sell them. The recovery path is `resolve-unsellable` by hand. The
  gate should refuse to ARM while still permitting the sweep that closes existing
  positions.
- **`net_pnl_usd` IS WRITTEN ONLY BY `resolve-unsellable`.** A filled exit still records
  no PnL, so `MAX_DAILY_LOSS_USD` sees losses only once a position is written off and
  never sees a completed round trip.

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

### STEP 8 HAPPENED, AND IT BOUGHT A HONEYPOT — 2026-09-17, cost $10

**THE FIRST LIVE RUN MADE TWO TRADES AND NEITHER COULD BE SOLD. THE RULE AS WRITTEN BUYS
TOKENS THAT CANNOT BE SOLD, AND NOTHING IN IT EVER ASKED.** Anyone reading this document to
find out what the bot does must read that sentence before the ones about slippage bounds and
exit ladders, because it is the larger fact about the strategy.

| | trade 613 OZZY | trade 614 CME |
|---|---|---|
| entry | `0xaf9d5570…4ec0` | `0x72ad7ad9…c0a2` |
| token | `0x149dc603…9675` | `0x9261e120…fea8` |
| in | 0.004107 ETH ≈ $5 | 0.004107 ETH ≈ $5 |
| out | 17,736.6 tokens | never read — the run died first |
| why it cannot be sold | **the pool pays 0** at every rung | **the token refuses every transfer**: `Error("blacklisted")` |
| status | `closed_unsellable` | `closed_unsellable` |

**TOTAL REALISED LOSS $10, PLUS GAS.** It is inside the $15 mode halt, which is the rail
doing its job, and it is the first money this project has lost.

**THE TWO FAILURES ARE NOT THE SAME FAILURE, AND ONLY ONE IS A HONEYPOT.** OZZY's token
transfers fine; its pool has nothing to pay with. CME's pool is busy — 211 transfers in 4,000
blocks and 75 swaps after our own entry — and the token itself refuses to move. **A busy chart
is what a honeypot looks like from outside, not evidence against one**, because the buys are
real and only the sells are refused.

**THE EVIDENCE ON CME, DECODED PER ADDRESS RATHER THAN INFERRED FROM OUR OWN FAILURE:**

```
transfer(…, balance) simulated from each holder
  0x8366a39c…0951   the PoolManager     CAN transfer
  0x66eb8af3…      an ordinary holder   execution reverted: blacklisted
  0x63ad1742…      an ordinary holder   execution reverted: blacklisted
  0xc033240a…      an ordinary holder   execution reverted: blacklisted
```

**ONLY THE POOL CAN MOVE THE TOKEN.** Buys therefore succeed and every buyer is trapped,
which is the complete mechanism. Our own exit reverted `TRANSFER_FROM_FAILED` through the
router, which names the symptom; the per-holder simulations name the cause, and the two were
not the same finding. **The contract is 181 bytes — a proxy** — so the rules that refused us
are not in the bytecode anyone could have read.

**WHAT MADE IT COST THE FULL POSITION RATHER THAN PART OF IT** is that there was never a
moment when selling would have worked. There is no earlier exit, no tighter bound and no
faster ladder that recovers this; the only intervention that helps is **not buying**, which is
why 2E is a pre-buy check and not a better exit.

**AND THE RULE'S OWN MEASURED HISTORY DID NOT WARN US.** Four dry runs, 117 rows and an exit
grid were all built on simulations from BORROWED holders — an address that had already sold
successfully, and therefore an address that was never blacklisted. **Every exit figure in
section 6 was measured on the population that could sell.** That is a selection effect in our
own measurements, it was invisible until real money met a token that refused us, and it is
recorded in section 7D so it is not rediscovered.

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
