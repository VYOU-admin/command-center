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

## Pool resolution

Query DexScreener's token-pairs endpoint for the mint:

    GET https://api.dexscreener.com/token-pairs/v1/solana/<mint>

It returns a bare JSON array of every indexed pair holding the mint, each with
`pairAddress`, `dexId`, `baseToken`, `quoteToken`, `liquidity.usd` and
`volume.h24`.

**Read swaps from every pool, not only the charted one.** The charted pair is
how the operator found the token; it is not a filter. A wallet that bought the
same token in a different pool during the window is still a buyer, and
restricting to one pool silently undercounts the cohort.

Record the resolved pool list — address, dex, base and quote mints, liquidity,
24h volume — **before reading any swaps**, so the set that was read is on record
independently of what the read returned.

**No liquidity floor is applied by default.** A tiny pool contributes few rows
and costs little. If a token resolves to a large number of pools, stop and
report the list rather than reading all of them: the cost is linear in pools
and the operator should choose.

### Pairs where the mint is the quote asset

A pair may hold the mint as its *quote* asset (`quoteToken.address == mint`)
rather than its base. Buying the mint there means selling the base token. This
is handled for free by the direction rule below, which keys off which side the
mint is on rather than assuming a position — so such pairs need no special
casing and are included.

## Direction

**A buy is a swap in which the wallet receives the mint.**

Determine direction from the wallet's net token-balance change for the mint
across the transaction: positive means received, negative means sent.

**Do not assume the mint is the base asset.** A pool can hold it as the quote
asset, and a fixed base/quote assumption inverts every result in that pool —
recording sellers as buyers — while producing plausible-looking rows. Key the
direction off which side of the swap the mint is actually on.

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
- **`wallet_tags` is never touched by the delete.** Tags live in their own table
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
