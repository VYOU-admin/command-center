# PONS run state — resume from here

Written 2026-08-31. Nothing has been written to `wallet_pnl` or
`wallet_clusters` for this token. AI has not been touched.

## Supplied inputs (pool discovery is abandoned; identifiers come from the operator)

    --token           0x39dBED3a2bd333467115dE45665cC57F813C4571
    --pool            0x10cc6bd38112cac182db90b6a71d8bb5939526ba
    --mcap-threshold  10000000

## Derived and verified (steps 1-2 complete)

| Field | Value | Source |
|---|---|---|
| DEX / version | uniswap **v3** | DexScreener `token-pairs/v1/robinhood/{token}` |
| Base token | PONS `0x39dBED3a2bd333467115dE45665cC57F813C4571` | supplied |
| Base decimals | **18** | `decimals()` on the token |
| Base supply now | 1,000,000,000 | `totalSupply()` |
| **Quote token** | **WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`** | DexScreener |
| **Quote decimals** | **18** | `decimals()` — DexScreener does not return decimals |
| Pool created | 2026-07-13T20:42:21Z | DexScreener `pairCreatedAt` |
| **Pool creation block** | **8,963,150** | binary search on block timestamp |
| **Head block at run start** | **51,141,570** | `eth_blockNumber` |
| Span | 42,178,420 blocks | — |
| Liquidity / mcap | $5.7M / $273M | DexScreener |

**The quote is WETH, an ERC-20 — not native ETH.** NTF's quote was native, so
its decode read `preBalances`/`postBalances`. PONS must read WETH `Transfer`
logs instead. This is the main V3-vs-V4 difference beyond the event shape.

## Swap pull — checkpointed, RESUMABLE, currently stopped

    script      scripts/pons_pull_swaps.py
    checkpoint  <scratch>/pons_swaps.jsonl     (6,328 swaps)
    state       <scratch>/pons_swaps.state     (6 windows done)
    cursor      block 9,113,155  (0.36% of span)
    stopped at  window 9,113,156-9,125,656 — "exhausted retries"

Re-running the script resumes from the state file; completed windows are
skipped. The failure is a public-RPC transport stall, not a data problem.

Event: Uniswap V3 `Swap`
`0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67`
V3 pools are their own contract, so the pool address is the log address and
`amount0`/`amount1` are int256 deltas from the POOL's perspective (positive =
into the pool). V4 differs: one PoolManager singleton, poolId in topic1, int128
amounts from the SWAPPER's perspective.

Density observed: ~6,328 swaps in the first 0.36% of the span. Full-history
projection is therefore high (order 10^5-10^6) and uncertain.

## NEXT STEP — threshold-derived receipts bound (standard pipeline step)

Not a PONS special case. Every future token gets the same treatment.

1. Resume the swap pull to completion (free, public RPC).
2. Build the mcap curve: swap-implied price x supply-at-that-block.
3. Find the **last block where mcap < $10,000,000**.
4. Bound the Alchemy receipts phase at that block.
5. Report before starting receipts:
   - last sub-threshold block and timestamp
   - swaps in the bounded range vs total in full history
   - unique transactions in range and the wall-clock receipts estimate
   - whether mcap crossed $10M once or several times, with the block range of
     **each** sub-threshold period (mcap is not monotone; later dips count)

Rationale: a wallet whose first buy was above threshold is out of the cohort by
policy, so its receipt is wasted spend. A fixed "first N days" only approximates
the boundary and misses later dips back under the threshold.

Receipts cost at NTF's measured 10.6 req/s: 50k txs ~1.3h, 150k ~4h, 500k ~13h.

## LOCKED CONSTRAINTS — carry verbatim, do not re-derive

- **`tx.from` is the trader only ~46% of the time** on this chain. Smart-account
  wallets and ERC-4337 bundlers make the signer a relayer. Use balance deltas.
- **Router order-splitting: split by the swap's own pool amount minus its fee.**
  A router can route one order through several pools of the same token;
  attributing the wallet's whole net to one pool inflated NTF by up to **1381x**.
- **Circular arb: exclude rows where the PoolManager both sends and receives the
  token in one transaction.** The attributed wallet is a tip recipient, not the
  trader. This was 5.2% of NTF rows, and wallet *identity* is wrong there, not
  just the amount.
- **Measure the fee rate from unambiguous single-swap trades. Do not assume 2%.**
  NTF was exactly 2.0000% on buys and 0% on sells at both p1 and p99, but that is
  a property of that token's hook, not of the venue.
- **Supply from mint/burn events, never a constant.** NTF burned 4.9% of supply
  mid-window, enough to move a wallet across a $100k threshold.
- **Decode from balance deltas at ANY call depth.** Aggregators CPI into the AMM;
  a top-level program check found 0 of 20 CATE swaps.
- **FIFO, not net flow; unsold inventory valued at zero** and surfaced through
  `remaining_tokens`. Deterministic tie-break `(block_time, signature)`.
- **Quote asset is detected, never assumed** — NTF was native ETH, PONS is WETH.

## Cohort policy (canonical, adopted for all tokens)

Has a first buy in this pool, `first_buy_mcap_usd` below threshold, not an
excess seller, circular-arb rows excluded.

## Reporting gate

Report before loading: quote token, measured fee rate, supply curve, trades
decoded, wallets attributed, validation split by attribution path, mcap
distribution with percentiles and histogram, the threshold applied (flag if it
captures under 3% or over 40%), cohort size, median PnL, top 10, and a
hand-checkable FIFO walkthrough for the top wallet. **Stop there. Do not load
until the operator confirms.**

---

## Window bound — REPLACES the threshold-derived bound (2026-08-31)

The threshold-derived bound is abandoned for PONS. The 4.2 hours of pulled data
was an artifact of a transport stall at block 9,113,156, not a property of the
token, so it could not be used to locate a $10M crossing (highest mcap in the
pulled range was $528,072, 5.3% of threshold).

New standard input, supplied per token like the mcap threshold:

    --window-hours <N>   measured from the first swap in the tracked pool

For PONS: `--window-hours 4`.

| Field | Value |
|---|---|
| window_hours | 4 |
| first swap block | 8,963,150 |
| first swap timestamp | 2026-07-13T20:42:21Z |
| window ends | 2026-07-14T00:42:21Z |
| **boundary block** | **9,106,777** |
| swaps in window | **5,662** |
| unique transactions in window | **5,657** |
| fully covered | **yes** (pull reached 4.18 h) |
| swaps past boundary, discarded | 666 |

The boundary block was found by binary search on real block timestamps, not by
interpolating a seconds-per-block rate, which would drift across 143,627 blocks.

The mcap threshold ($10,000,000) remains a recorded input and is still computed
per wallet as `first_buy_mcap_usd`. It no longer bounds the pull.

## Balance spec — TWO columns, never one

    implied_balance  tokens_bought - tokens_sold, from decoded swaps in the
                     tracked pool within the window
    onchain_balance  balanceOf read at head, one call per cohort wallet,
                     NEVER inferred from buys minus sells
    balance_delta    onchain_balance - implied_balance
    balance_match    boolean; tolerance chosen from the observed distribution,
                     not an arbitrary constant. Report the tolerance and why.

The block at which the balanceOf reads were taken is recorded on every row.

**A per-wallet mismatch is expected and is not an error.** `implied` covers the
tracked pool within the window; `onchain` is the whole chain at head. A negative
delta means disposal outside the window or outside the tracked pool. A positive
delta means acquisition elsewhere. Both are information, not bugs.

Aggregate divergence IS a decode check, and is reported as one: match count and
percentage, the distribution of `balance_delta`, and the match rate split by
attribution path. A path-specific divergence points at the decoder rather than
at real off-window activity.

## Additional per-wallet columns

    tokens_bought, tokens_sold      native token units
    unrealized_pnl_usd              onchain_balance valued at the pool price
                                    read at head, with price and block stamped
                                    on the row
    still_holding                   boolean

## Circular-arb rule on V3

The rule was defined for V4, where one PoolManager singleton both sends and
receives the token in a single transaction. PONS is V3: each pool is its own
contract, so the analogue is the POOL CONTRACT itself both sending and
receiving. The row count it catches must be reported. **If it catches zero, say
so plainly** — a filter that matches nothing has looked like success on this
project at least five times.

## Dashboard tab must surface

window_hours, first and last swap timestamps, block range, swaps in window,
unique transactions, fully-covered flag, and both balance columns plus
balance_delta.

---

## Run complete (2026-08-31) — reported, NOT loaded

Nothing written to `wallet_pnl` or `wallet_clusters`. AI untouched.
Output: `data/pons_wallet_pnl.csv` (1,046 rows).

### Measured, not assumed

| Quantity | Value |
|---|---|
| Fee rate | **0.0000% both sides** (buy n=3,458, sell n=2,194; median ratio 1.000000) |
| Circular arb (V3 analogue) | **1 transaction** — caught something, not zero |
| Trades decoded | 5,660 from 5,657 txs (4 multi-swap) |
| Wallets attributed | 1,057 (cohort 1,046) |
| USD method | constant $1,769.72/ETH — ETH moved 1.5% over the window, under the 5% bar |
| Pool price at head | $0.25632716 (block 51,165,960), mcap $256,327,163 |

V3 takes its fee inside pool accounting rather than as a token-side skim, so 0%
is the correct answer here and not a decode failure. NTF's 2% came from a V4
hook, which is a property of that token, not of the venue.

### DEFECT FOUND AND FIXED — silent zero balances

The first `balanceOf` pass mapped any absent `result` to `0.0`. **490 of 1,046
reads were HTTP 429 and became fake zero balances**, which then presented as
"332 wallets hold tokens on our books but nothing on chain" — a decode crisis
that did not exist. `scripts/pons_balances.py` now retries per response and
aborts rather than emitting a value the node never returned. Corrected counts:
nonzero at boundary 44 -> **382**; still_holding 117 -> **170**.

Same family as the fabricated `Transfer` topic hash earlier in this run, which
matched zero logs across 100k blocks and looked like a clean pull.

### Decode validation (boundary block 9,106,777)

| Check | Result |
|---|---|
| Transfer-log completeness (raw net == on-chain) | **1,046/1,046 (100.0%)** |
| Decode implied == on-chain, all wallets | 983/1,046 (94.0%) |
| **Wallets that only ever touched this pool** | **476/476 (100.0%)** |
| ... of those, with a NONZERO balance | **154/154 (100.0%)** |
| Mismatched wallets having off-pool transfers | **63/63 (100.0%)** |

The pool-only subset is the check that carries weight: where the tracked pool is
the whole story the decode reproduces chain state exactly, including 154 nonzero
amounts. Every single mismatch involves movement outside the pool, which is scope
rather than error. Head-block matching is intentionally NOT used as a decode
check — head is six weeks past the window, so disagreement there is expected.

### Threshold captured everything — it is doing no work

`--mcap-threshold 10000000` admitted **1,051 of 1,051 wallets (100.0%)**.
First-buy mcap ran $2,800 to **$394,932**, so the ceiling is 25x above the
highest value any wallet actually bought at. The cohort is defined entirely by
the 4-hour window, not by the threshold. Flagged rather than silently accepted.

### Results

Cohort 1,046 (1,051 sub-threshold buyers minus 11 excess sellers, 5 overlap).
Realized $78,192 total; median **$0.32**; 534 winners / 259 losers / 253 flat.
Top wallet $5,622. 170 still holding, $7,868,329 unrealized — highly concentrated,
median holder just $2. Only 1 wallet opened with a sell.
