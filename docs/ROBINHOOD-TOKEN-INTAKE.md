# Robinhood Chain token intake

The standing procedure for loading an EVM token on Robinhood Chain (chain 4663).
Sibling of `docs/SOLANA-TOKEN-INTAKE.md`: the reporting discipline and
verification requirements there apply here unchanged. What differs is the chain.

Every figure quoted below was measured during the PONS intake. Where a number
appears, it was verified against the chain or the database, not recalled.

## Purpose

Identify who bought a token, roughly how much they bought, roughly what they
paid, roughly what they made, and whether they still hold. Approximate is
acceptable on the dollar figures. **Wallet coverage and attribution correctness
are what matter** — no real buyer dropped, no trade credited to the wrong
address.

## Per-run inputs

- token contract address, checksummed as the chain returns it
- the charted pair, for the dashboard header
- one or more cohort windows, as wall-clock times with a timezone
- nothing else. Pools, decimals, and prices are all read, never supplied.

## Chain facts, measured

```
chain id                 4663 (0x1237)
genesis                  2026-04-30
block time               ~0.1 s
public RPC               https://rpc.mainnet.chain.robinhood.com
Alchemy                  https://robinhood-mainnet.g.alchemy.com/v2/{key}
uniswap v4 PoolManager   0x8366a39cc670b4001a1121b8f6a443a643e40951
explorer                 https://robinhoodchain.blockscout.com/
DexScreener slug         robinhood
```

**The Alchemy key is a Railway service variable**, and also lives in the local
`.env`. It was originally passed per command over `railway ssh` to avoid a
redeploy; that was abandoned when the incremental job had to run on a schedule
inside the container, where a per-command variable cannot be seen. Do not
re-derive the per-command pattern, and do not read a missing-key error as
evidence the variable was wiped — check `railway variables` first.

**The public RPC serves logs but not historical state.** `eth_getCode` at any
past block returns `{"code":-32000,"message":"metadata is not found"}`. Alchemy
is archival and answers the same call. Any step needing historical state must
use Alchemy.

**Blockscout is not usable programmatically.** Every API path tested returned
HTTP 403 behind a Cloudflare interstitial: `/api/v2/blocks`,
`/api/v2/blocks/{n}`, and the legacy `/api?module=block&action=...`. It is a
link target for humans, not a data source.

## Step order

Steps marked **STOP** end with a report and wait for review. The rest run
through.

1. Chain reconnaissance and token identity — read `name`, `symbol`, `decimals`,
   `totalSupply` from the contract
2. Window bounds → block numbers, by bisecting block timestamps
3. Pool enumeration, v3 and v4 — **STOP**
4. Counter-asset identification and scope — **STOP**
5. Swap sweep, full life
6. Cohort — **STOP** before writing `wallet_tags`
7. Block timestamps for the rows to be written
8. Native price derivation — **STOP**
9. Write `wallet_transactions` — **STOP** on the dry run
10. Dashboard deploy and DOM verification

The STOPs are where a wrong answer is cheap to correct and expensive to carry
forward. Scope, cohort membership and pricing each propagate into everything
downstream.

## Pool enumeration

**Never trust the DexScreener listing as complete.** It caps its response at 30
pairs. For PONS it listed **30 of 91** v3-style pools and **14 of 792** v4 pools.
Three pools it listed did not exist on-chain at the time — they were initialised
later, after the enumeration range ended.

### v3 — `token0()` / `token1()`

Derive candidates from transfer flow, then test each on-chain. A pool both
receives and sends the token; so do routers, so flow alone does not identify a
pool.

- take every address that both received and sent the token
- `eth_getCode` — a pool is a contract
- `token0()` (`0x0dfe1681`) and `token1()` (`0xd21220a7`) — a pool answers both,
  a router reverts

A revert is **the answer**, not a failure: it means "this contract has no such
function, so it is not a pool". Retrying reverts is how a classifier spends five
rounds re-asking 1,664 settled questions.

For PONS this found **91 pools where DexScreener knew 30**, and 28 of the 40
in-scope pools were unlisted, including one carrying 53,688 transfers — the 7th
busiest pool on the chain.

### v4 — `Initialize` events are authoritative

**v4 pools have no contracts.** The PoolManager singleton holds every pool's
reserves, so `eth_getCode` and `token0()` cannot see them, and transfers show the
PoolManager as the counterparty rather than the pool.

The authoritative enumeration is the `Initialize` event, which carries the pool
id and both currencies as indexed topics:

```
topic0    0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438
topics[1] pool id      topics[2] currency0     topics[3] currency1
data      5 words: fee, tickSpacing, hooks, sqrtPriceX96, tick
```

Query it filtered by the token in `topics[2]` and again in `topics[3]`:

```
eth_getLogs {address: PoolManager, topics: [INIT, null, <token padded>]}
eth_getLogs {address: PoolManager, topics: [INIT, null, null, <token padded>]}
```

That is the complete list of pools ever created for the token, in ~130 calls
across full chain life. For PONS: **875 pools, 540 in scope**.

**Do not take this topic hash on trust.** It was identified by sampling
PoolManager logs with no topic filter, grouping by `topic0`, and picking the
signature with four topics and two address-shaped words — then confirmed by
querying a known pool id and checking the token appeared as a currency. A
fabricated topic matches zero logs and reads as a clean sweep.

The other PoolManager signatures found the same way:

```
0x40e9cecb...  Swap              3 topics, 192 data bytes  (id, sender)
0xf208f491...  ModifyLiquidity   3 topics, 128 data bytes  (id, sender)
0x1b3d7edb...  ERC-6909 accounting
```

`ModifyLiquidity` matters for reconciliation: liquidity provision moves the token
through the PoolManager without being a swap.

### Re-derive per run

Pools are created continuously. Between two enumerations 12 hours apart, PONS
gained **83 new v4 pools, 8 of them in scope**. Enumerate at the start of each
run against the current head, and report what is new.

## Scope

A pool is in scope only when the counter side is a recognised pricing asset:

```
WETH          0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73   18 decimals
USDG          0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168    6 decimals
native ETH    0x0000000000000000000000000000000000000000   18 decimals
```

Everything else is out. For PONS that excluded 51 v3 pools and 335 v4 pools
whose counter side was another memecoin — mostly derivatives launched *against*
the token (Tampons, Strapons, Capons, XPONS, Ponsi), where the token is the
pricing asset rather than the priced one.

**Apply the rule to v4 as well as v3.** The first pass applied it only to v3, so
the v4 filter still contained PONS/NVDA, PONS/STONKBROKER, PONS/MEME and PONS/AI.
Pricing a memecoin against a tokenised equity produces a plausible number derived
from an oracle nobody verified.

**Read the counter token's `symbol()` before deciding.** Of 48 unidentified
counter assets on PONS, all 48 resolved; none was a stablecoin; four were
tokenised equities (SPY ×2, NVDA, FAMI) that have real off-chain prices and are
still excluded, because their on-chain price depends on a bridge or oracle that
has not been verified and they carried 2,062 transfers out of 5.76M.

## Swap sweep

Sweep **full chain life, not the window**. The PONS cohort window held **772,131
of 2,459,873 swaps — 31%**. 1.46M swaps happened after the window closed, which
is exactly the sell-side data that cost basis and realised PnL depend on.

```
v3   address = in-scope pool addresses, topic0 = Swap_v3
v4   address = PoolManager, topic0 = Swap_v4, topics[1] = the token's pool ids
```

Filter v4 by the pool ids from `Initialize`. An unfiltered PoolManager sweep
returns every v4 swap on the chain — 33.2M rows and 14 GB for one month.

Commit progress per range, and gap-check the whole range on a fresh connection
when it finishes: `sum(to_block - from_block + 1)` must equal the span exactly,
and a window function over the ranges must find zero gaps.

## Sign conventions — measure, never assume

**The two venues use opposite conventions on this chain.**

```
v3   POOL perspective     pool sent the token  => amount negative
v4   SWAPPER perspective  swapper received     => amount positive
```

Measured by comparing each swap's token-side amount against the actual token
transfer in the same transaction, in three separate regions:

```
          in-window    before window   after window
v3        394/394      299/299         290/290       POOL, unanimous
v4        164/164      294/294         154/154       SWAPPER, unanimous
```

Assuming one convention for both would have inverted every v4 buy into a sell —
480,924 rows, with plausible totals throughout and nothing to indicate a problem.
Verify both, inside and outside the window, before writing.

## Direction comes from the transfer

The sign convention establishes which side is the token and how large the counter
amount is. **Direction does not come from it.** A wallet that received the token
in a transfer bought; one that sent it sold. That is directly observable and
unambiguous, and it does not depend on getting a convention right.

The buyer is the address on the non-pool side of the transfer — not the swap's
`sender` or `recipient` topic, which is routinely a router.

## Decimals — read per contract

```
PONS   18      WETH   18      USDG    6      native ETH 18 (by protocol)
```

**USDG has 6 decimals, not 18.** Applying 1e18 to it inflates every USDG-quoted
figure by 10^12, and USDG is the counter asset on 238 of the 381 in-scope pools.
One counter token on the PONS list (PONTIFUL) had 6 decimals where every other
had 18. Read `decimals()` from each contract; treat a `0x` return as unknown, not
as 18 and not as 0.

## Contract exclusion — at the window's end block

`eth_getCode` must be evaluated at **the cohort window's end block**, not at
`latest`. This needs Alchemy; the public RPC cannot answer it.

An address that was an ordinary wallet when it bought is a buyer, whatever it
became afterwards. Checking at `latest` cost **581 wallets on PONS — 4.6% of the
cohort** — because they have since adopted EIP-7702 delegation and now return 23
bytes of code (`0xef0100` plus an address).

**It cuts both ways.** Six wallets had a delegation *during* the window and
revoked it later: they were smart accounts when they bought, so excluding them is
correct, and a `latest` check wrongly included them. The `latest` check was wrong
in both directions.

Apply `config/infrastructure.yaml` at the candidate stage, before the code check,
so an excluded address never becomes a row. For PONS it matched 4 of 6 entries;
report the 2 that matched nothing rather than omitting them.

A failed `eth_getCode` must **throw**. It has no legitimate error, so anything
other than a result is a failed read, and recording it as "no contract here" is
how a pool or router becomes a wallet.

## USD

Derive per swap from the swap's own two sides. **Null where underivable, never
zero.**

- **USDG-quoted**: dollars directly, at 6 decimals
- **WETH- and ETH-quoted**: needs a native price — see below
- **anything else**: out of scope, so it never reaches this stage

Allocate USD across wallets by each wallet's share of the token moved in that
transaction and pool. A transaction can carry several wallets on one pool.

### Floors — three of them, and each catches something different

```
token side ≥ 1 raw unit    caught 0 rows on PONS
paid side  ≥ 1 raw unit    caught 22 rows
token amount ≥ 0.001       caught 1 row carrying $980,393.99
USD ≥ $0.01                caught 5,301 rows, largest $0.00999987
```

The **paid-side floor** catches what the token-side floor does not: a leg where
the wallet received real tokens and gave up float residue.

The **token-amount floor** is the one that is easy to omit. A USD-only floor lets
through a row with 1.7e-6 tokens and $980,394 of allocated USD — a price of
$5.79e11 per token, and **0.87% of the token's entire USD volume, invented**. It
arises when a transaction's swap moved a near-zero token amount against a large
counter amount, so the proportional allocation assigns almost all of it to a
wallet that received almost nothing.

**Rows with null USD are never dropped by a USD floor.** Unpriced is not small.
Two of the 2,266 unpriced PONS rows carried token amounts in the thousands.

## Deriving the native price from the token itself

There is no ETH/USD feed in this system. Derive it from the token being loaded:
a token/USDG swap gives the token in dollars, a token/WETH swap gives it in ETH,
and the ratio is ETH/USD. Same technique the Solana procedure uses for SOL.

**Bucketed medians, not per-tick pairing.** Bucket both series by block (10,000
blocks ≈ 17 minutes on this chain), take the median of each side per bucket, then
divide. A single bad tick cannot move a median; pairing individual ticks lets it
straight through.

**Fence at each stage, and report what each fence caught:**

```
token/USD ticks   median 8.83e-2   discarded 46 outside 100x
token/ETH ticks   median 4.68e-5   discarded 9,129 outside 100x
derived ETH/USD                    0 outside 10x -- nothing to discard
```

That last zero is the signal the derivation is sound.

**Leave gaps as gaps.** Of 4,655 buckets across PONS's life, 4,593 (98.67%) had
both sides. 40 had no USDG trade, 22 had no trade at all. Those 62 are not
interpolated, not carried forward, and swaps landing in them store null USD.

**Sanity-check against a live source, and say so if you cannot check the past.**
The derived series ran $1,614–$2,548 with a median of $1,911. The most recent
bucket read $2,480.88 against DexScreener's deepest live WETH/USDG pool at
$2,488.48 — **0.3% apart**, from an entirely independent derivation. Historical
levels could not be checked against any external source available here, and that
should be stated rather than implied.

## Reconciliation

Reconcile the swaps found against the transfers that moved the token through the
PoolManager. For PONS, using the full 875-pool list:

```
PoolManager token-transfer txs   384,385
v4 swap txs captured             385,901
unexplained                       18,792  (4.9%)
```

Sampling 40 unexplained transactions and reading every PoolManager event in them
returned **38 ModifyLiquidity and 0 Swap** — liquidity provision, correctly not a
swap. A residual that is explained is a result; a residual left unexplained is a
defect.

Scoping `token_swap_logs` to in-scope pools only raises the residual to 13.7%,
which decomposes exactly: 34,036 transactions swapping on out-of-scope pools plus
18,792 liquidity events = 52,828.

## Cost and rate ceilings

See `CLAUDE.md` for the measured figures. Two rules:

**Derive the work set from the rows you will write.** The PONS timestamp fetch
was scoped to every block in `token_swap_logs` — 1,379,236 — when the rows being
written needed 144,073, of which 92,598 were already stored. A 9.6× overshoot
that cost roughly 7M compute units.

**Put a hard ceiling inside the job**, not only on the account. State the
expected call count, sub-call count and cost before the first request, and stop
at the ceiling regardless of progress.

## Dashboard

The chain needs entries in the explorer table (`EXPLORERS` in
`src/web/tokens-page.ts`) and in the price adapter's `PRICING_QUOTES`. Both were
Solana-only and both failed silently for a new chain: a Solscan URL built from a
hex address resolves to nothing without an error, and a Solana-only quote set
rejects every pool on the new chain so the token is never priced while the
monitor still reports success.

A chain absent from the explorer table gets **no link** rather than a guessed one.

At this scale the page must not embed transaction rows: 191,728 rows produced a
69.3 MB page. Wallet totals are computed in SQL and a wallet's transactions come
from `/api/token-txs` on expansion — 4.22 MB, 0.33 s to parse and run.

## Scoring and score-quality flags

Scoring runs after the intake, over the cohort the window selected, and is
`npm run score -- <chain> <token> --tag <TAG>`. It reads the database only. Two
flags are **derived on every run** and stored in `wallet_scores.flags`, an array
so a wallet can carry both. They are deliberately NOT in `wallet_tags`: those
are cohort membership, these are statements about how far a score can be
trusted, and mixing them forces every tag query to know which kind it is reading.

### low-weight

A wallet whose score rests on **less than 0.8 of the total weight**. Nulls drop
out of the weighted sum and the remaining weights are renormalised, so a wallet
missing most of its metrics is otherwise directly comparable to one missing
none — and on PONS the **top-ranked wallet of 12,382 rested on 0.175 of the
weight**, its 22 buys all unpriced and its rank coming from hold time alone.

The threshold was chosen against the distribution rather than picked:

```
weight_used   wallets      what is missing
1.000          12,296      nothing
0.875              67      earliness only
0.825              18      earliness and buy-size trend
0.175               1      six of the eight metrics
0.000             713      unscored entirely
```

It is bimodal, so 0.5 and 0.8 make the identical cut of 1 wallet; 0.9 would
catch 86. **Re-derive this table for each token before accepting 0.8** — a token
with a smoother distribution needs a different number, and the point of the
flag is comparability, not the constant.

### inflated-pnl

A wallet whose **position is below -0.001 tokens**: it sold more than it bought,
so it acquired the difference off-market and its PnL counts the sale but not the
purchase. On PONS this is 2,088 wallets, 1,839 of them scored and 249 unscored
sell-only wallets. It is applied whether or not the wallet is scored, because it
is a fact about the wallet rather than about its score.

**The floor is not zero, and it is not optional.** 589 PONS wallets are negative
by less than a millionth of a token, the smallest by 3e-18 — one wei — which is
rounding residue from proportional allocation, not a purchase. `-0.001` is the
same materiality floor the row writer already applies to a token amount.

**Compute the position in SQL, in `numeric`.** See FAILURE_MODES: the same count
in JavaScript doubles gave 2,098 where numeric gives 2,682.

### The flags clear themselves

The array is REPLACED on every scoring run, never appended to, and the position
sums include the transfer sides. Once transfer rows are collected for a token, a
wallet that acquired off-market is no longer negative and the flag is simply not
re-applied. Nothing has to be cleared by hand; the one-statement
`array_remove(flags, 'inflated-pnl')` exists only for clearing it before a
re-score.

### Two things to watch on the next token

**Pre-pump share may carry almost no information.** On PONS metric 5 is **zero
for more than 75% of the cohort, with a maximum of exactly 1/3** — meaning no
wallet bought inside the 48 hours before more than one of the three pump points.
A maximum that lands exactly on 1/n_pumps is the signature of that. Check it per
token before assuming the metric is doing work: if it repeats, the 5% weight is
being spent on a metric that separates almost nobody, and it is a question about
the metric rather than about the token.

**86 scored PONS wallets have no buy row inside the window they were selected
by** — 67 missing earliness only, 18 missing earliness and buy-size trend, 1
missing six metrics. They are in the cohort because they RECEIVED the token from
a pool inside the window, which is what cohort selection measures, but none of
their buy rows land in it. This is an **open question about cohort construction,
not a data-quality problem**: the transfer that qualified them is real. Either
the swap behind it was on an out-of-scope pool, or it reached them through a
path the row writer attributes elsewhere. Resolve it on a token where the
numbers are small enough to trace individually.

## Failure modes seen

### DexScreener's listing read as the complete pool set

It caps at 30 pairs and knew 14 of 792 v4 pools. The 3rd, 4th and 5th busiest
PONS v4 pools were absent from it. Enumerate on-chain; use the API only to
annotate liquidity and volume.

### The scope rule applied to one venue and not the other

v3 pools were filtered to recognised pricing assets and v4 pools were not, so the
v4 set still contained PONS/NVDA and PONS/STONKBROKER. Apply scope once, to
everything, from a single list of pricing assets.

### The cohort built from one venue

The first PONS cohort came from v3 pools only, because v4 pools are not transfer
counterparties — the PoolManager is. It missed **3,067 wallets, 23.5% of the
final cohort**, who bought exclusively on v4. When a venue's pools are invisible
to the obvious query, that is not evidence they are inactive.

### A wallet's average cost divided by tokens it did not pay for

Unpriced rows must leave **both** sides of the average-cost division. Keeping
their tokens in the denominator while their dollars are absent understates the
basis of exactly the wallets whose data is weakest.
