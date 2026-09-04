# Solana token intake

Standing procedure for ingesting a Solana token's buyer cohort. A run is given
a mint, ticker, charted pair, a time window and a tag, and follows this file.
Nothing here is specific to any one token.

`FAILURE_MODES.md` at the repo root governs. Read it before a run.

---

## Purpose

Collect every wallet that bought a given token during a specified time window,
record each individual purchase, and tag the wallet with that window's label.

- **One run per window.** A window is a contiguous UTC time range.
- **Results accumulate.** Running a second window for the same token adds to
  what is already stored; it does not replace it.
- **The operator chooses windows,** by looking at a chart and deciding which
  periods matter. The pipeline does not detect or propose windows. It is told
  where to look.

A wallet that bought in two windows is a member of both cohorts. It gets
purchase rows under both tags and two tag rows. That is the correct result, not
a duplicate.

## Per-run inputs

| input | meaning |
|---|---|
| mint | Base58 token mint address. **Case-sensitive.** |
| ticker | Short symbol, used for the tag prefix and display. |
| charted pair | The pool address the operator was looking at when they chose the window. Recorded, not used as a filter. |
| window start | UTC timestamp, inclusive. |
| window end | UTC timestamp, **inclusive**. |
| tag | `TICKER-P<n>`. `n` distinguishes purchase periods within one token's history — P1 is the first window ingested, not a rank or a quality score. |

## Recording the window

**Every run writes its `token_windows` row, before or alongside the purchase
rows.** The row records the window as commissioned: the mint, the tag, the start
and end the operator specified, and a short label such as `accumulation` or
`spike`.

**A window that produced purchases but has no `token_windows` row is a defect.**
It means a cohort exists whose definition was never written down, and the only
remaining description of it is the rows themselves.

**The window is not derived from the purchases.** The first and last buy inside
a window are not the window: a run over 12:00–14:00 whose earliest buy landed at
12:09:01 still covered 12:00–14:00. Deriving the bounds from `token_purchases`
would silently redefine the period as whatever happened to trade, and would
shrink a quiet window to nothing.

**The re-run path must not drop it.** Re-running a token and window deletes and
reinserts that window's `token_purchases` rows; `token_windows` is left alone,
exactly as `wallet_tags` is. The definition of the window outlives any
particular ingestion of it. If the operator is correcting the window bounds
themselves, that is an update to the `token_windows` row and a re-run, not a
delete.

## Pool resolution

Query DexScreener's token-pairs endpoint for the mint:

    GET https://api.dexscreener.com/token-pairs/v1/solana/<mint>

It returns a bare JSON array of every indexed pair holding the mint, each with
`pairAddress`, `dexId`, `baseToken`, `quoteToken`, `liquidity.usd` and
`volume.h24`.

**Read swaps from every in-scope pool, not only the charted one.** The charted pair is
how the operator found the token; it is not a filter. A wallet that bought the
same token in a different pool during the window is still a buyer, and
restricting to one pool silently undercounts the cohort.

Record the resolved pool list — address, dex, both mints, which side was judged
the pricing asset, liquidity, 24h volume — **before reading any swaps**, together
with the pools excluded and why, so the set that was read is on record
independently of what the read returned.

**No liquidity floor is applied by default.** A tiny pool contributes few rows
and costs little. If a token resolves to a large number of pools, stop and
report the list rather than reading all of them: the cost is linear in pools
and the operator should choose.

### Which pairs are in scope

**A pair is in scope only when the target mint is the token the pair prices.**
A pair belonging to a different token, which merely uses the target mint as its
pricing side, is out of scope regardless of its liquidity or volume. Those pools
are that other token's market; a wallet trading there is buying or selling that
token, and sweeping them in inflates the cohort with people who were never
trading ours.

**Do not decide this from the base/quote labels.** DexScreener flipped the
labelling on one real pool between two runs a day apart: the same
`pairAddress` was reported as `WAIFU/MOS` with MOS as the quote, and later as
`MOS/WAIFU` with MOS as the base. Any rule keyed on `baseToken.address ==
mint` would have classified the same pool two different ways on two days.

**The comparison actually used.** For each pair, take its two mint addresses,
`baseToken.address` and `quoteToken.address`, without caring which is which.
One of them is the target mint. Look at *the other one*:

- if the other mint is a recognised **pricing asset** — a stablecoin or wrapped
  SOL — the pair prices our token against it, and the pair is **in scope**;
- otherwise the other mint is some other project's token, our mint is serving
  as that pair's pricing side, and the pair is **out of scope**.

Recognised pricing assets, as a set of mint addresses:

    USDC  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
    USDT  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB
    wSOL  So11111111111111111111111111111111111111112

This is a set membership test on the counter-side mint. It is symmetric, so it
gives the same answer whichever way DexScreener labels the pair.

**Known limitation, stated rather than hidden.** A genuine market for our token
quoted in some third token — MOS/BONK, say — would be excluded by this rule,
because BONK is not in the pricing-asset set. That is the safe direction to err:
including another project's pool corrupts the cohort with wallets that never
touched our token, while excluding an exotic quote pair loses only the buyers
who used it. Extend the set above when such a pair is real and material, and say
so in the run report.

#### Worked example: the pool that was excluded

    EVw13whn1d8dy1fggVFkeaeVgAWNnemFf6fMgtJM9ZDQ   orca
    the two mints: 9yPNMiAGREqUe8yjP2UyHPC6vc69oBikgHcH8Qf5G6ha  (WAIFU)
                   4ChT49V1iazP2XUGtycGkEsS6pRMqvGfUbqvRC9Z91ZT  (MOS, the target)
    counter-side  = WAIFU, which is NOT in the pricing-asset set
    verdict       = OUT OF SCOPE

This is WAIFU's pool. MOS is its pricing side. It was wrongly included in the
first MOS run at roughly $5 of liquidity, and the rows it produced were deleted
once the rule was corrected.

## Direction

**A buy is a swap in which the wallet receives the mint.**

Determine direction from the wallet's net token-balance change for the mint
across the transaction: positive means received, negative means sent.

**Do not assume the mint is the base asset.** A pool can hold it as the quote
asset, and a fixed base/quote assumption inverts every result in that pool —
recording sellers as buyers — while producing plausible-looking rows. Key the
direction off which side of the swap the mint is actually on.

**A positive net delta is not enough — it must clear one raw unit.** Summing
signed transfers in floating point leaves residue on a delta that is really
zero: a wallet that received and sent the same amount inside one transaction
comes out at `2.8e-14` tokens rather than `0`, and `got > 0` accepts it as a
purchase. Require the net amount to be at least one raw unit (`1 / 10^decimals`,
so `0.000001` at six decimals) before a leg becomes a row. Guarding only the
paid side is not sufficient; the token side needs its own floor.

The damage is not in the money — these rows carry no meaningful USD and no
total moves when they are removed. It is in the cohort: each one is a wallet
that appears to have bought and never did, and it gets tagged into the window
like any other buyer.

## Attribution

**The buyer is the owner of the token account that received the mint.** Not the
fee payer, not the first signer. On Solana these differ routinely: aggregators,
relayers and smart-wallet programs all sign for someone else.

Read the owner from the transaction's `preTokenBalances` / `postTokenBalances`,
which carry an explicit `owner` field per balance entry, and compute the net
delta per owner per mint. This works at any call depth and does not require
decoding the instruction layout of every DEX program.

## Pricing

USD is derived **per swap, from that swap's own two sides**. No external price
API is introduced.

- **Stablecoin-quoted pool** — direct. USD is the stablecoin amount moved; the
  per-token price is that divided by the mint amount.
- **SOL-quoted pool** — the swap gives a MOS/SOL rate. Convert using a SOL/USD
  price derived from *the same token's* stablecoin-quoted pool swaps within the
  same window, so both figures share a baseline and a time basis.
- **No stablecoin-quoted pool for the window** — report it and stop. Do not
  substitute a rate from elsewhere.

`usd_amount` is **null** when it cannot be derived. Never zero. A reader cannot
distinguish a measured zero from an absent measurement, and a zero dollar
purchase is a plausible-looking lie.

## Reading swaps: which method, and what it costs

Two methods work. Which one you need depends on how far back the window is and
how busy the token is.

### Backwards pagination from the chain head — only for recent windows

`getSignaturesForAddress` paged with `before` from the head. Its cost scales
with **distance from now**, not with window length, because there is no slot or
time parameter — the walk is linear from the head.

For a token doing ~1,000 signatures every 15 seconds, a window 4.5 days back
needs roughly 25,000 pages *on one pool* before a single transaction is fetched.
Measured: six pages of 1,000 signatures walked back **93 seconds** of wall
clock. This method is fine for a window hours old and useless for one days old.

### type=SWAP paging from a window-end anchor — for anything older

Cost scales with **window length**, which is what makes distant windows
reachable.

1. Find the last slot at or before the window end. Batch `getBlockTime` probes
   20 to a request and narrow ~20x per round; both edges of a 2h15m window were
   pinned exactly in **12 requests / 164 sub-calls**.
2. Read that block with `transactionDetails:'signatures'` and take any
   signature from it.
3. Page `/v0/addresses/{pool}/transactions?type=SWAP&before=<that signature>`
   backwards until the timestamp falls below the window start.

**The anchor does not have to belong to the pool being queried.** A signature
from any transaction in a block at the window end bounds `before` correctly for
every pool. One anchor per window serves all pools, which removes the need to
hunt for a per-pool signature — a real problem for sparse pools, which appear in
0 of ~1,600 transactions in a given block.

**A 404 is not an error.** `Failed to find events within the search period`
means the API scanned a chunk and found no matches. Do not retry it and do not
treat it as the end. Advance the cursor with one `getSignaturesForAddress` page
— **1 credit instead of another 100-credit miss** — and continue. On a sparse
pool this was 4 of 8 requests.

### What the enhanced payload contains

It reproduces the pipeline exactly; it is not an approximation. Verified against
`getTransaction` on real data:

- `tokenTransfers` summed per owner gave **identical receiver sets and amounts**
  to `pre/postTokenBalances` net deltas on 20 of 20 transactions.
- `accountData[].nativeBalanceChange` **is** `postBalances - preBalances`:
  identical on **503 of 503** accounts compared. The paid-in-native-SOL test is
  therefore reproducible, which matters — it recovered 18% of one token's buys.

### Parameters: two are honoured, two are silently ignored

**Test every filter by checking it changes the result set.** On this endpoint:

| parameter | behaviour |
|---|---|
| `before` (signature) | **honoured** |
| `type=SWAP` | **honoured** — returns a different set, all of type SWAP |
| `source=RAYDIUM` | **honoured** |
| `until` | rejected outright, HTTP 400 |
| `startTime` | **accepted, returns 200, and silently ignored** |
| `slot` | **accepted, returns 200, and silently ignored** |

A bad value for `type` or `source` returns HTTP 404 rather than being quietly
dropped, so those two fail loudly. `startTime` and `slot` do not: they look like
they worked and constrain nothing. A bound that appears accepted and does
nothing produces a confidently wrong window, so a filter is only established as
working once a nonsense value has been shown to behave differently from a real
one.

## Credits, and the budget gate

From Helius's pricing page, which is the only authority — there is no usage API,
so **spend is computed as request-count x published unit cost, never read**:

    RPC calls                         1 credit
    getProgramAccounts, archival     10 credits
    DAS calls                        10 credits
    Enhanced Transaction API        100 credits per request

What Helius counts as "archival" is not documented at a URL that resolves;
`/docs/rpc/archival` is a 404. Assume RPC reads against windows more than a day
or two old may bill at 10x until that is settled.

**Project the credit cost before collecting, and stop if it does not fit.**
The per-pool figure is `window_seconds / seconds_covered_per_request x 100`.
Seconds covered per request varies enormously with pool activity and must be
measured per pool, not assumed from the busiest one — measured on one token:

    charted raydium CPMM   32.3 s/request      1,199 requests    119,900 credits
    meteora DLMM SOL       44.3 s/request        874 requests     87,400 credits
    orca wp SOL           217.2 s/request        179 requests     17,900 credits
    meteora DLMM USDC    3,478   s/request         12 requests      1,200 credits

A 6-request sample per pool is enough to project and cheap to take. Assuming
every pool is as dense as the busiest one overstated the total by a wide margin.

State the projection and the decision explicitly before writing anything. If it
exceeds the working budget, stop and report which subsets fit rather than
quietly collecting less.

## Multi-pool scope when no pool dominates

One token had a single pool carrying 57% of volume across four pools covering
99%; another had one pool carrying essentially all of it. Where no pool
dominates, collecting only the charted pair silently drops every wallet an
aggregator routed elsewhere.

The set covering 99% of in-scope volume is the useful cut. Below that the tail
is cheap — the pools under 1% of volume cost hundreds of credits, not tens of
thousands — so the cut is about the dense secondary pools, not the long tail.

## Collecting in passes

When a token's full collection does not fit one budget, split it by pool and
run passes. Two rules make a partial state safe:

- **Write purchase rows progressively**, per pool per window, not accumulated in
  memory and flushed at the end. A run that dies mid-window then leaves a
  truthful partial record rather than nothing.
- **Write the `token_windows` row only when the window is complete across every
  pool in scope.** A window with purchase rows and no `token_windows` row is the
  signal that it was interrupted or is mid-pass. Because the dashboard legend
  reads from `token_windows`, such a window renders with no legend entry — which
  is correct: a half-collected cohort must not look complete.

## Reading swaps: Helius limits

Measured on this project's key. These are hard numbers, not guidance:

- **Batch ceiling is between 28 and 32 sub-calls per HTTP request.** 20, 24 and
  28 return HTTP 200. 32, 40, 100 and 148 return **HTTP 429 within ~20ms**.
- A refusal is not transient: 40 sub-calls stayed refused across three attempts
  with 12 second backoff. It is a size ceiling, not a rate limit.
- **A refusal degrades the following few seconds** — back-to-back requests after
  a 429 are also refused.
- **8 chunks of 20, spaced 5 seconds, is measured clean** — 8/8 with zero
  sub-errors in 40.7 seconds.
- **There is no usage API.** `/v0/usage`, `/v0/credits` and `/v0/health` all
  return `Method not found`, and RPC responses carry no credit headers. The
  Helius dashboard is the only source of credit figures, and a human has to
  read it.

A batched JSON-RPC call returns **per-item errors inside an HTTP 200**. Inspect
every response body. A read that requests a set must confirm every requested
item came back and abort rather than emit a partial result.

## Idempotency

Re-running a token and window is safe and is the intended way to correct a run.

- The run **deletes that token+window's `token_purchases` rows and reinserts
  them.** Scoped to `(mint, window_tag)` — never wider.
- **Neither `wallet_tags` nor `token_windows` is touched by the delete.** Tags live in their own table
  so that operator edits survive a re-run. A re-run re-asserts `auto` tags via
  upsert; it does not remove `manual` ones.
- **Dry-run counts are reported before the delete**, including zeros. On a first
  run the existing-row count is 0, and that zero is stated rather than omitted —
  an omitted line is indistinguishable from a check that never ran.

## Schema

Three tables, created in the spine's migration path.

### `tokens` — one row per tracked token

| column | type | meaning |
|---|---|---|
| `mint` | text PK | Base58 mint address, case preserved |
| `chain` | text not null | `solana` |
| `ticker` | text not null | Short symbol |
| `name` | text | Full name if known |
| `decimals` | integer not null | Mint decimals, read from chain |
| `charted_pair` | text | Pool the operator was charting |
| `created_at` | timestamptz not null | |

### `token_purchases` — one row per buy leg, append-only within a window

| column | type | meaning |
|---|---|---|
| `id` | bigserial PK | |
| `mint` | text not null → `tokens(mint)` | |
| `wallet` | text not null | Owner that received the mint. Base58, case preserved |
| `signature` | text not null | Transaction signature |
| `pool` | text not null | Pool the swap executed in |
| `block_time` | timestamptz not null | On-chain time |
| `slot` | bigint not null | |
| `token_amount` | numeric not null | Mint units received, decimal-adjusted |
| `usd_amount` | numeric | **Null when underivable. Never 0 as a stand-in** |
| `price_usd` | numeric | Per-token USD price of this swap; null when underivable |
| `window_tag` | text not null | e.g. `MOS-P1` |
| `created_at` | timestamptz not null | |

Unique on `(signature, wallet, mint, pool)`. **Signature alone is not unique** —
one transaction can legitimately contain more than one swap leg, including two
legs for the same wallet in different pools.

Indexed on `(mint, window_tag)` and `(mint, wallet)`.

### `token_windows` — the windows as commissioned

| column | type | meaning |
|---|---|---|
| `id` | bigserial PK | |
| `mint` | text not null → `tokens(mint)` | |
| `tag` | text not null | e.g. `MOS-P1` |
| `window_start` | timestamptz not null | as specified, UTC |
| `window_end` | timestamptz not null | as specified, UTC, **inclusive** |
| `label` | text | short description: `accumulation`, `spike` |
| `created_at` | timestamptz not null | |

Unique on `(mint, tag)`. Written by the run, never derived from observed
purchases, never dropped by a re-run.

### `wallet_tags` — mutable, operator-editable

| column | type | meaning |
|---|---|---|
| `id` | bigserial PK | |
| `wallet` | text not null | Base58, case preserved |
| `mint` | text not null → `tokens(mint)` | |
| `tag` | text not null | |
| `source` | text not null | `auto` when written by a run, `manual` when edited in the dashboard |
| `created_at` | timestamptz not null | |
| `updated_at` | timestamptz not null | |

Unique on `(wallet, mint, tag)` — a wallet can carry several tags for one token.

## Failure modes seen

Append to this section as real ones surface. Seeded with two that are certain to
bite:

### Base58 lowercasing

Solana addresses are base58 and **case-sensitive**. EVM addresses are hex and
conventionally lowercased, and that habit leaks through shared helpers. On this
project it recurred four separate times before the teardown: on a read path, on
a write path, in a helper reused across chains, and in an API response field.
Each time the address was silently corrupted into something matching nothing —
rows written and then permanently invisible, or a page rendering zero results
with no error anywhere.

**Check any shared or reused helper for case normalisation before using it.**
DexScreener's own API returns `pairAddress` mixed-case but renders it lowercased
inside the `url` field, and browser URLs show the lowercased form — a pool
address copied from a browser will not resolve. Resolve addresses from the API
response, never from a URL.

### Base/quote inversion

A pool can hold the tracked mint as its quote asset. Assuming it is always the
base silently inverts direction for that pool, recording every seller as a
buyer. The rows look entirely normal. Key direction off which side the mint is
on, per swap.

### Receiving the token is not buying it

A wallet can finish a transaction holding more of the mint because it was sent
some, claimed an airdrop, or was paid a referral — inside a transaction that
merely touched the pool. Testing only "net mint delta > 0" classified **159 of
1,395 legs (11%) as purchases when the wallet gave up nothing at all.** One
received 12,913 MOS against a zero lamport delta; another received the mint and
a second token together, paying for neither.

The direction rule has two halves and both must be implemented: it is a *swap*
in which the wallet *receives* the token. Require evidence the wallet gave up
value in the same transaction — a negative delta in some other token, or native
SOL out beyond the transaction fee and any ATA rent it paid.

The threshold is not arbitrary if you look at the distribution first. Measured
here, legs with no token payment clustered at or below zero lamports (117 of
353), then nothing until real payments began; ATA rent is 2,039,280 lamports and
makes a natural floor.

**A wallet absent from the transaction cannot have paid in it.** 32 legs had
owners that appear in neither the static account keys nor the address-lookup-table
loaded addresses. Those are receipts into someone's account, not purchases by
them.

### Window-median pricing is biased when the token is moving

Deriving SOL/USD once per window as `median(MOS/USD) / median(MOS/SOL)` takes
the two medians over differently-timed populations. During a spike that is a
systematic error, not noise: measured on MOS-P2, the whole-window figure was
95.56, while the first half gave 127.17 and the second 97.41.

Evaluated per swap the conversion collapses:

    usd = sol * SOL_USD = sol * (MOS_USD(t) / (sol/mos)) = mos * MOS_USD(t)

so price each SOL-quoted swap from the stablecoin-pool rate prevailing within a
couple of minutes of it. After that change both windows independently implied
SOL/USD near 95 with tight spreads — two windows seven hours apart agreeing is
the check that the earlier numbers were wrong.

### A failed patch that does not stop the command that follows it

Twice during this build a `python3` edit aborted on a failed assertion while the
shell went on to run the next command with the unpatched file. Once that sent an
empty schema, which `client.query('')` executed happily and reported as applied,
creating nothing. Once it re-wrote purchase rows with the pricing that was being
replaced.

Chain the edit and the command that depends on it with `&&`, and have the
consuming script re-check its own input — the migration script now refuses to run
unless the SQL it received declares the tables it expects by name.

### A pair of another token that uses ours as its pricing side

The first MOS run resolved four pools and read all four. One of them was
another token's pair that used MOS as its quote asset. It contributed no
independent buyers — every leg in it turned out to be an arbitrage transaction
that also touched the real pool — but it could have, and those wallets would
have been traders of a different token entirely.

The mistake was reading "every indexed pair holding the mint" as "every market
for the mint". They are not the same set. See "Which pairs are in scope" above
for the comparison that separates them, and note that the base/quote labels are
not stable enough to be that comparison.

### A degenerate swap becomes a price tick and poisons a whole window

Price ticks built as `abs(quote_amount) / abs(token_amount)` per swap will
occasionally include a swap whose token side is near zero against a normal quote
side. The ratio is then astronomically large, and it is indistinguishable from a
real tick in the series.

Measured on one window: 35 rows were priced at exactly **549,755,813,888** —
2^39, which is what a float ratio degenerates to — and the window's USD total
came to **$136,522,225,213,212,380**. The token's real price in that window was
about $0.095, and the stored ticks that *did* become purchase rows ranged
0.0885–0.1023. The bad tick came from a swap that never became a purchase row,
so inspecting the stored ticks afterwards showed nothing wrong.

The `±120s median` does not protect against this. A median defends against one
bad tick among several; where a lone degenerate tick is the only one near a
swap, it wins outright.

**Fence the tick series before using it.** Take the window median, then discard
any tick more than an order of magnitude away from it in either direction, and
report how many were discarded. A token's price does not move 10x inside a
collection window; a tick that says it did is a broken swap, not a price.

**Sanity-check the window total before reporting it.** A USD sum is the cheapest
possible tripwire here — $136 quadrillion is obvious where a single row at
549,755,813,888 might not be. Compare the implied price against the token's
market cap divided by supply and stop if it is absurd.

Re-pricing does not need new RPC: `usd = token_amount x price(t)` is
reproducible from stored rows, using the stablecoin-pool rows already written as
the tick series.

### Float residue passes a `> 0` test and invents buyers

`legsOf` rejected a leg only when the net token amount was `<= 0`. A wallet
whose receipts and sends cancel within one transaction nets to zero in exact
arithmetic but to `2.8e-14` in floating point, so the leg was written as a
purchase. 89 such rows existed across all four USELESS pools, and 10 wallets
had no other rows at all — they were tagged into P1, P2 and P3 as buyers who
never bought.

Two things hid it. The rows carry `$0.000000`, so no USD total looked wrong.
And an earlier re-pricing pass overwrote `price_usd` for every row from the
stored tick series, which replaced the absurd ratios these rows had with
in-range prices — the repair erased the symptom while leaving the cause.

It surfaced only because a stored price range (`1.2e-14 .. 0.25`) was compared
against the range of the ticks that were supposed to have produced it
(`0.065 .. 0.102`). That comparison is worth running after any collection:
**stored prices must fall inside the range of the ticks they came from**, and
anything outside it is a defect to explain rather than an outlier to accept.
