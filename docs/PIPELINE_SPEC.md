# Wallet PnL pipeline — specification

What the pipeline does, in the order it does it, and what every output means.
Written from five tokens actually run end to end. It documents the pipeline as
it exists, including the parts that are still per-token scripts rather than one
command.

---

## 1. Purpose

Identify which wallets bought a token early, roughly how much they bought, what
they paid, what they sold for, their realised PnL, and whether they still hold.

Approximate is acceptable on money. Exact is required on wallet identity, cohort
membership, token amounts and balances. USD error up to ~5% changes no decision;
attributing a trade to the wrong address does.

## 2. Inputs

    --token           base token contract address
    --pool            pool identifier: a contract address on v3, a bytes32 poolId on v4
    --mcap-threshold  USD market cap ceiling for cohort membership
    --window-hours    trading window, measured from the first swap in this pool
    chain             'robinhood' (EVM 4663) or 'solana'

Pools are **supplied, never discovered**. Automatic pool discovery was abandoned
after it selected the wrong venue.

## 3. Steps, in order

Run by `scripts/run_token.py`, one command, checkpointed under
`<scratch>/run/<TOKEN>/` so a crash resumes without re-pulling:

    python3 scripts/run_token.py --token <addr> --pool <addr|poolId> \
        --mcap-threshold <usd> --window-hours <n> --chain robinhood

It stops after the report and never writes to Postgres. `--load` builds the load
payload only; applying it stays a separate, explicit act.

Every constraint in section 4 is recorded by `pipeline/constraints.py`. A
constraint that is never recorded counts as SKIPPED and the run aborts before
reporting — silence is not evidence.

1. **Resolve the pool.** DexScreener gives venue, version and the counter-asset;
   confirm on-chain. On v3 read `token0()`/`token1()` from the pool rather than
   inferring order from address sort.
2. **Read decimals** for base and quote from their contracts. Never assume 18.
3. **Window.** Find the first swap in this pool, add `--window-hours`, and locate
   the boundary block by **binary search on actual block timestamps**. Never
   interpolate a seconds-per-block rate; it drifts across 10^5 blocks.

   **The boundary is the LAST block whose timestamp is ≤ the window end.** This
   chain produces sub-second blocks, so many blocks share a single timestamp and
   "the boundary block" is ambiguous within that tied second — on PONS, blocks
   9,106,777 through 9,106,786 all carry timestamp 1783989741. Taking the last
   is the stricter reading of "at or before the window end"; taking the first
   silently truncates the window by the width of the tie. The two readings differ
   by nine blocks and one swap on PONS.
4. **Resolve the quote asset to USD** (§5).
5. **Choose the USD method** from the quote's movement across this window:
   spread ≤ 5% → a constant; above → per-trade hourly. A measurement, not a
   preference.

   **The constant is the mean of the price points inside the window, ±1 hour.**
   Series are fetched with a wider margin so the window edges can be
   interpolated, but that margin must not enter the average: including it prices
   the cohort partly on hours it never traded in. The two conventions differ by
   0.05% on PONS.
6. **Pull swaps** in the window from the public RPC, paced and checkpointed.
7. **Reconstruct supply.** `totalSupply()` at the first and boundary blocks via
   archive, plus every mint/burn Transfer inside the window. The two must
   reconcile: start + mints − burns == end.
8. **Fetch receipts** for every in-window transaction (Alchemy, batched).
9. **Measure the fee** from unambiguous single-swap trades (§6.4).
10. **Detect round-trippers** — wallets that both receive from and send to the
    pool inside one transaction (§6.3).
11. **Decode and attribute** each swap by wallet balance delta, with
    infrastructure excluded at the candidate stage (§6.5).
12. **Timestamp** every distinct trade block.
13. **Market cap at first buy** per wallet; apply the threshold; drop excess
    sellers. That is the cohort.
14. **Read balances** with `balanceOf` at the boundary block and at head.
15. **Pull all base-token transfers** in the window, to identify wallets that
    only ever touched this pool.
16. **FIFO PnL** per wallet.
17. **Report and stop.** Load only on explicit confirmation.
18. **Load**, then verify with live queries from a fresh connection.

## 4. Locked constraints

Carried verbatim across every token. Each was paid for once.

- **`tx.from` is the trader only ~46% of the time** on chain 4663. Smart accounts
  and ERC-4337 bundlers make the signer a relayer. Attribute by balance delta.
- **Decode from balance deltas at ANY call depth.** Aggregators CPI into the AMM;
  a top-level program check found 0 of 20 CATE swaps.
- **Router order-splitting: use the swap's OWN pool amount minus its OWN fee.**
  Attributing a wallet's whole transaction net to one pool inflated NTF by 1381x.
- **Circular arb: exclude the tip recipient, at swap granularity** (§6.3).
- **Measure the fee rate; never assume it.** NTF 2%, PONS 0%, AI 1%.
- **Supply from mint/burn events, never a constant.** NTF burned 4.9% mid-window.
- **FIFO, not net flow**, unsold inventory valued at zero and surfaced through
  `tokens_still_held`. Deterministic tie-break `(block, logIndex)`.
- **Quote asset is detected, never assumed.**
- **Infrastructure is excluded globally**, not per venue (§6.5).

## 5. Quote → USD, resolved by route

`scripts/pipeline/quote_pricing.py`. Tiers, most direct first:

| tier | quote is | route |
|---|---|---|
| 0 | a USD stablecoin | 1.0, verified not assumed |
| 1 | native or wrapped native | CoinGecko ETH/USD hourly |
| 2 | any other ERC-20 | price it on-chain against a tier-0/1 asset |

**A tier-2 reference pool must predate the window.** NVDA's deepest USD pool by
current liquidity was created after the AI window closed; ranking on depth alone
would have priced the window from a pool that did not exist. Candidates are
filtered on creation time **before** being ranked on depth, and the chosen pool
must contain swaps inside the window — coverage is reported, never assumed.

## 6. The parts that are subtle

### 6.1 V3 versus V4

| | v3 | v4 |
|---|---|---|
| pool | its own contract | one PoolManager singleton |
| identified by | contract address | bytes32 poolId in topic1 |
| amounts | int256, **pool** perspective | int128, **swapper** perspective |
| Swap topic0 | `0xc42079f9…` | `0x40e9cecb…` |

V4 `int128` amounts are ABI **sign-extended into 32-byte words** and must be
masked to the low 128 bits before the sign test. Without the mask a negative
amount decodes as ~10^60.

### 6.2 Solana

Decode pool-side from `preBalances`/`postBalances` at any depth. Graduation
matters: a pump.fun token that graduates trades on PumpSwap, and "largest
holder" stops identifying the venue.

### 6.3 Circular arb, and why granularity matters

The rule is "the pool both sends and receives the token in one transaction", and
the reason is that the attributed wallet is a **tip recipient**, not a trader.

Applied per **transaction** it destroys data. On AI it matched 59.6% of
transactions, because a 1% token-side hook fee makes the PoolManager pay a
recipient which dumps its cut back into the pool in the same transaction.
Excluding those transactions discarded **2,122 genuine buys**.

Applied per **swap** it is correct: identify round-trippers and refuse to
attribute any swap to them, leaving the buyer in that transaction intact. AI has
exactly 2 round-trippers; PONS has 0.

### 6.4 Fee measurement

Ratio of the attributed trader's token delta to the swap's pool amount, over
transactions with exactly one swap of that side, with round-trippers removed
from candidates. Report median with p1 and p99: a flat ratio is a real fee, a
scattered one means the decoder is mismatching legs.

Restricting to strictly one-swap transactions is too narrow on some tokens — it
left AI with 20 buy samples, so the window is one swap **of that side**.

### 6.5 Infrastructure exclusion

`config/infrastructure.yaml`, global and not per-venue, applied **at the
candidate stage** so an excluded address never becomes a row. Currently: the v4
PoolManager, the zero address, the burn address, and three routers, each with a
stated reason. Per-run additions resolved by the pipeline: the tracked pool
contract, and that token's round-trippers.

This is global because a venue-scoped list silently fails on another venue. The
v4 PoolManager entered the PONS cohort — a v3 token — as a trader holding 19.8%
of its unrealised total.

## 7. Outputs

### `wallet_pnl` — one row per (wallet, token)

| column | meaning |
|---|---|
| `wallet`, `token`, `chain`, `quote_asset` | identity |
| `first_buy_time_utc`, `last_sell_time_utc` | real block timestamps, not interpolated |
| `n_buys`, `n_sells` | attributed swaps in this pool and window |
| `sol_in`, `sol_out` | quote paid / received. **Legacy name from the CATE era; the unit is `quote_asset`, not SOL.** |
| `realized_pnl_sol` | FIFO PnL in the quote asset |
| `realized_pnl_usd` | the above converted by `rate_basis` |
| `tokens_bought`, `tokens_sold` | base-token units, net of the measured fee |
| `implied_balance` | bought − sold, from decoded swaps in **this pool, this window** |
| `onchain_balance` | `balanceOf` at `balance_block`. **Never inferred.** |
| `balance_delta`, `balance_match` | the comparison; a per-wallet mismatch is information, not a bug |
| `tokens_still_held` | unsold FIFO inventory |
| `unrealized_pnl_usd` | `onchain_balance` at `price_usd`, stamped with `price_block` |
| `still_holding`, `sold_out` | booleans |
| `has_off_pool_activity` | had a base-token transfer whose counterparty was not the pool. **Includes router hops, so it over-counts genuine off-venue activity.** |
| `first_buy_mcap_usd` | swap-implied price × supply at that block × quote USD |
| `pre_window_entry` | first action was a sell, so cost basis is unseen |
| `rate_basis` | the USD method, in words, shown in the UI |
| `tag`, `tag_source` | editable; `tag_source='manual'` is never overwritten |

**`sol_in`/`sol_out` record the pool leg.** Measured on AI and PONS, the quote
asset does not reach the wallet in 99.9% and 98.9% of cases respectively — a
router supplies it inside the transaction. The columns are correct as "what the
pool leg was denominated in"; they are not "what the wallet spent".

### `wallet_pnl_tokens` — one row per (token, chain)

Window bounds and block range, swaps and unique transactions, `fully_covered`,
venue and version, quote asset with address and decimals, measured fee rates,
supply, USD method and basis, price and balance blocks, cohort size, the decode
check in words, and `mcap_threshold_usd` with **`threshold_binding`** and a
reason. That flag exists so a threshold column is never misread as a filter that
selected something.

### `wallet_clusters` — PK `(chain, wallet, signal, cluster_id)`

Star clustering: one signer is one cluster, never chained. A wallet may belong to
several clusters, so the dashboard joins it as a **lateral aggregate** — a plain
join would multiply a wallet into several union rows.

Infrastructure signers are removed by a **degree gap**: sort cluster sizes, find
the largest empty run, cut above it. PONS 2..19 then 95 (gap 76); AI 2..11 then
197 (gap 140).

## 8. Validation checks

| check | what it proves |
|---|---|
| supply reconciliation | the supply curve, independent of a single read |
| fee p1 vs p99 spread | flat = a real fee; scattered = mismatched legs |
| swaps decoded + excluded == swaps pulled | nothing silently dropped |
| **pool-only subset**: implied == on-chain at the boundary | **the decode itself** |
| transfer-log net == on-chain balance | the transfer pull is complete |
| match rate split by attribution path | a path-specific gap accuses the decoder |
| circular-arb / exclusion counts | reported as numbers, including zero |
| cross-route quote price agreement | order-of-magnitude sanity on an unfamiliar quote |
| window coverage measured against chain head | the pool was old enough to fill the window |
| dry-run counts, then live queries from a fresh connection | the write actually happened |
| union invariant `count(*) == count(distinct (wallet, token))` | no fan-out |
| served page executed in a DOM, rows counted | the page works |

The pool-only subset is the check that carries weight. Head-block agreement is
not a decode check: head is weeks after the window, so disagreement is expected.
A whole-cohort match rate is also weak when most wallets end at zero — `0 == 0`
holds regardless of what happened in between.

## 9. Venue and quote variants proven

| token | chain | venue | quote | fee buy/sell | cohort |
|---|---|---|---|---|---|
| CATE | solana | pump.fun → PumpSwap | SOL (native) | — | 556 |
| CYBERLEEK | solana | Raydium CPMM | SOL (native) | — | 268 |
| NTF | robinhood | uniswap v4 | ETH (native) | 2% / 0% | 511 |
| PONS | robinhood | uniswap v3 | WETH (ERC-20) | 0% / 0% | 1,045 |
| AI | robinhood | uniswap v4 | NVDA (arbitrary ERC-20) | 1% / 0% | 1,163 |

Covered: both Uniswap versions, native and ERC-20 quotes, a quote with no
CoinGecko listing, hook fees and no fee, and both chains.

## 10. Known gaps and hardcoded values

- **Constants live in `config/pipeline.yaml`** — topic hashes, selectors, RPC
  endpoints, rate limits, the chain-4663 PoolManager. They must be copied from
  working code, never recalled: a fabricated Transfer topic once matched zero
  logs across 100,000 blocks and looked like a clean pull.
- The **scratchpad path** is still a default in `run_token.py`, overridable with
  `PIPELINE_SCRATCH`.
- **Head-block figures move between runs.** `onchain_balance`,
  `unrealized_pnl_usd` and `price_usd` are read at head, which means "now", so
  re-running a token changes them even when the decode is byte-identical. Head is
  pinned in the window checkpoint so a resumed run stays self-consistent. The
  PONS reload moved 19 balances and 162 unrealized figures for this reason alone.
  Only `boundary_balance`, read at a fixed in-window block, is stable across runs.
- **Receipts are filtered to two token addresses** (base and quote) at pull time.
  Native value and all other token legs are discarded, so questions about what a
  wallet actually spent cannot be answered later without a re-pull.
- **`has_off_pool_activity` counts router hops**, so the pool-only subset is
  conservative rather than complete.
- **The threshold has not yet bound on any token.** PONS admitted 1,051/1,051
  and AI 1,173/1,173. Both cohorts are defined by the window.
- **`same_transaction` clustering yields 0** on PONS and AI, for structural
  reasons, and 131 clusters on NTF. Recorded, not suppressed.
- **NTF covers one pool of 65**, about 60.7% of its swap activity.
- **CATE and CYBERLEEK predate the canonical cohort policy** and were built under
  earlier rules; NTF's policy is canonical.
- **Solana vault/venue detection breaks for graduated tokens** — reported, unfixed.
- **DexScreener is a single point of failure** for venue and pair discovery.
- **`pyyaml` is required** by the infrastructure loader and is not in
  `package.json`; it is a Python-side dependency installed locally.
- Balance reads are cheap but **not free**: two `balanceOf` calls per cohort
  wallet, batched 20 at a time with per-response retry.

## 11. Out of scope

- Automatic pool discovery. Pools are supplied.
- Multi-pool aggregation. One pool per token per run; a wallet's true position
  may be larger.
- Anything outside the window. The window is the unit of analysis.
- Live or incremental updates. Each run is a finished analysis loaded once.
- Naming the asset a wallet actually spent (§7), which the current receipt filter
  cannot answer.
- Tax, cost-basis or accounting treatment beyond FIFO with zero-valued unsold
  inventory.
- Wallet identity beyond on-chain clustering signals. No off-chain attribution.
