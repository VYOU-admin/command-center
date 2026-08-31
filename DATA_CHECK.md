# pumpfun-early-window — data integrity check

Read-only. Queried against production on **2026-08-25**, between **18:21 and
18:33 UTC**. Nothing was modified.

The RPC-derived collection went live at **17:44:38 UTC**, so the window under
examination is roughly **37–49 minutes long**. Every figure below is restricted
to tokens launched at or after that moment.

⚠️ **The dataset is growing while it is being measured.** Tokens arrive at about
25 per minute, so counts taken minutes apart do not reconcile. Where the same
quantity appears twice with different values, both are correct as of their own
query. Each section states its own n.

⚠️ **Nothing here is old enough to have completed its six-hour window.** The
+1h, +2h, +3h and +6h outcome marks are structurally unreachable at this age and
report n=0 for that reason, not because they failed.

---

## 1. Volume

### Tokens ingested per hour

| hour (UTC) | tokens |
|---|---:|
| 2026-08-25 17 (partial, from 17:44) | 762 |
| 2026-08-25 18 (partial, to 18:21) | 925 |

**n = 1,687 tokens in ~37 minutes** ≈ 45.6/min.

### Snapshots per hour

| hour (UTC) | snapshots | distinct mints |
|---|---:|---:|
| 2026-08-25 17 (partial) | 16,568 | 745 |
| 2026-08-25 18 (partial) | 30,273 | 1,676 |

**n = 46,841 snapshots.** A later count over the same window returned 49,736.

### Count by keep_reason

| arm | n |
|---|---:|
| dropped | 1,114 |
| not yet decided (younger than 10 min) | 446 |
| activity | 72 |
| control | 55 |

**n = 1,687.** Of the 1,241 decided, 5.8% cleared the activity floor and 4.4%
were drawn into the control arm.

### Graduations

**n = 14** tokens launched since the fix have graduated. The same 14 are all the
graduation events recorded in the window.

---

## 2. Is the data real

### 2.1 Back-filled snapshots

A back-filled token has several marks sharing one `snapshot_at`. A token with no
back-fill has as many distinct write instants as it has snapshots.

| tokens | zero back-fill | some back-fill | fully back-filled |
|---:|---:|---:|---:|
| 1,676 | **1,676** | 0 | 0 |

**All 1,676 tokens have zero back-filled snapshots.** This is the expected
result.

### 2.2 Distinct prices per token across the early window (≤600s)

**n = 1,676.**

| distinct prices | tokens | of which zero trades |
|---:|---:|---:|
| 1 | 635 | 167 |
| 2 | 364 | 0 |
| 3 | 219 | 0 |
| 4 | 115 | 0 |
| 5 | 78 | 0 |
| 6 | 37 | 0 |
| 7 | 37 | 0 |
| 8 | 35 | 0 |
| 9 | 19 | 0 |
| 10 | 19 | 0 |
| 11–20 | 72 | 0 |
| 21–29 | 35 | 0 |
| 30 | 12 | 0 |

**635 tokens have exactly 1 distinct price; 167 of those (26.3%) had zero
trades.** The remaining ~468 traded yet show one price.

A follow-up query two minutes later (n = 648 one-price tokens) broke those down
by trade count:

| trade count | one-price tokens | multi-price tokens |
|---|---:|---:|
| 0 trades | 171 | 0 |
| 1 trade | 115 | 2 |
| 2–3 trades | 221 | 115 |
| 4–10 trades | 69 | 233 |
| 11+ trades | 72 | 713 |

And, of the 477 one-price tokens that had traded:

| | n |
|---|---:|
| all trades already counted at the 15s mark | 336 |
| traded after the first mark | 32 |
| too young to have a 600s row to compare | 109 |

**336 of them had every one of their trades before the first snapshot at 15s**,
so all subsequent marks record the same post-trade price. 32 traded after the
first mark and still show a single distinct price.

### 2.3 Null counts at the 5-minute mark

**n = 1,449 rows at `seconds_since_launch = 300`.**

| column | nulls |
|---|---:|
| id, monitor_id, mint, snapshot_at, seconds_since_launch | 0 |
| curve_sol, virtual_sol, token_reserves, virtual_token_reserves | 0 |
| mcap_sol, price_sol, mcap_usd, price_usd, sol_usd | 0 |
| trades, buys, sells, buy_volume_sol, sell_volume_sol | 0 |
| unique_buyers, unique_sellers | 0 |
| post_graduation, price_source, has_market, phase, is_outcome_mark | 0 |
| **largest_buy_sol** | **164** |
| **price_usd_effective** | **11** |
| **dex_liquidity_usd, dex_volume_24h, dex_txns_24h, dex_price_usd** | **1,437 each** |
| **holder_count** | **1,449 (100%)** |

Three of these warrant flagging:

- **`holder_count` is null on every row.** Across all 49,736 snapshots since the
  fix, **0 are non-null**. The column exists in the schema and is never written.
- **`dex_*` are null on 1,437 of 1,449 (99.2%).** Only 12 rows at the 5-minute
  mark carry DexScreener data, consistent with 14 graduates in the window.
- **`largest_buy_sol` is null on 164 rows**, which matches rows with no buys.

### 2.4 Snapshot spacing

Expected grid: every 15s to 300s (20 marks), then every 30s to 600s (10 marks) =
**30 marks**. Restricted to tokens old enough to owe all 30.

| tokens due all 30 | complete | with gaps | min marks | max marks |
|---:|---:|---:|---:|---:|
| 1,241 | **1,241** | **0** | 30 | 30 |

**No token has a gap.** The per-mark missing-count query returned no rows.

---

## 3. The 5-minute picture

**n = 1,526 tokens with a 300s snapshot**, split by what the 10-minute decision
later did with them:

| group | n |
|---|---:|
| did not clear the floor | 1,219 |
| not yet decided | 234 |
| cleared the activity floor | 73 |

The "not yet decided" group is reported separately rather than merged, since its
outcome is unknown.

### Curve SOL at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 1e-9 | 3e-9 | 0.0040 | 0.099 | 23.35 |
| undecided | 234 | 0 | 1e-9 | 9e-9 | 0.0100 | 0.460 | 85.01 |
| cleared floor | 73 | 0.430 | 1.87 | 4.42 | 36.40 | 85.01 | 85.01 |

⚠️ **The median non-clearing token holds 3 lamports.** A dedicated breakdown of
all 1,574 snapshots at the 300s mark:

| curve SOL band | snapshots |
|---|---:|
| exactly 0 | 202 |
| < 1e-6 (1–999 lamports) | 837 |
| 1e-6 … 0.01 | 125 |
| 0.01 … 1 | 301 |
| ≥ 1 | 109 |

**1,039 of 1,574 (66%) sit at or below one millionth of a SOL.**

⚠️ **One token that did not clear the floor held 23.35 SOL at 5 minutes**, and
an undecided one held 85.01. The floor is evaluated on curve SOL at 600s, not at
300s, so a token can be above it at 5 minutes and below it at 10.

### Market cap (SOL) at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 27.96 | 27.96 | 27.98 | 28.89 | 338.30 |
| undecided | 234 | 0 | 27.96 | 27.96 | 27.96 | 28.99 | 410.88 |
| cleared floor | 73 | 14.00 | 31.55 | 36.81 | 136.96 | 410.88 | 410.88 |

27.96 is the creation-instant market cap; the median non-clearing token has not
moved from it.

### Trade count at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 2 | 7 | 24 | 75 | 1,937 |
| undecided | 234 | 0 | 1 | 8 | 40.5 | 188.7 | 1,024 |
| cleared floor | 73 | 1 | 10 | 31 | 256 | 981.8 | 2,385 |

### Buy count at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 1 | 4 | 12 | 37 | 910 |
| undecided | 234 | 0 | 1 | 4 | 19 | 89.8 | 489 |
| cleared floor | 73 | 1 | 7 | 22 | 145 | 459.2 | 1,280 |

### Sell count at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 1 | 3 | 12 | 36 | 1,027 |
| undecided | 234 | 0 | 0 | 4 | 21 | 90 | 535 |
| cleared floor | 73 | 0 | 3 | 13 | 105 | 445.0 | 1,105 |

### Unique buyers at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 1 | 3 | 7 | 18 | 808 |
| undecided | 234 | 0 | 1 | 3 | 12 | 39.7 | 431 |
| cleared floor | 73 | 1 | 7 | 16 | 99 | 316.0 | 747 |

### Unique sellers at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 1 | 2 | 7 | 16 | 795 |
| undecided | 234 | 0 | 0 | 3 | 11 | 38 | 425 |
| cleared floor | 73 | 0 | 3 | 8 | 69 | 253.4 | 548 |

### Buy volume (SOL) at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 0.0025 | 1.001 | 8.00 | 17.68 | 369.47 |
| undecided | 234 | 0 | 0.0010 | 1.977 | 14.01 | 49.98 | 287.92 |
| cleared floor | 73 | 0.717 | 4.63 | 24.49 | 102.96 | 207.70 | 548.00 |

### Largest buy (SOL) at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| did not clear | 1,219 | 0 | 0.0025 | 0.444 | 2.96 | 4.94 | 24.55 |
| undecided | 234 | 0 | 0.0010 | 0.988 | 3.00 | 5.00 | 59.26 |
| cleared floor | 73 | 0.197 | 1.87 | 4.89 | 7.57 | 19.43 | 85.01 |

### Largest buy as a share of curve SOL at 5 minutes

| group | n | min | p25 | median | p75 | p90 | max |
|---|---:|---:|---:|---:|---:|---:|---:|
| cleared floor | 73 | 0.057 | 0.281 | 0.588 | 1.00 | 2.52 | 11.00 |
| did not clear | 1,219 | 0.082 | 47.3 | 9,876,542 | 438,957,037 | 1.0e9 | 5.0e9 |
| undecided | 234 | 0.058 | 5.18 | 67,489,712 | 447,811,448 | 9.9e8 | 5.9e9 |

⚠️ **This ratio is not usable for the two non-clearing groups.** Their
denominator is dust (§3, curve SOL): dividing by 1–3 lamports produces values up
to 5×10⁹. The ratio is only meaningful for the cleared-floor group, where the
median largest buy is **59% of the curve**, and a quarter of tokens have a
single buy exceeding the entire curve balance (ratio ≥ 1 at p75).

---

## 4. Outcome marks

| mark | tokens with it | live | frozen |
|---|---:|---:|---:|
| +30m (1800s) | 328 | 29 | 299 |
| +1h (3600s) | 0 | — | — |
| +2h (7200s) | 0 | — | — |
| +3h (10800s) | 0 | — | — |
| +6h (21600s) | 0 | — | — |

**91% of +30m marks are frozen** (299 of 328) — written for tokens that were no
longer trading.

The marks past +30m have **n=0 because no token is old enough**. The oldest is
~49 minutes.

### Coverage against tokens old enough to owe the mark

| mark | tokens old enough | tokens with mark | missing |
|---|---:|---:|---:|
| +30m | 444 | 403 | **41** |
| +1h … +6h | 0 | 0 | — |

⚠️ **41 tokens old enough to owe a +30m mark did not have one at query time.**
Their state:

| stop_reason | arm | n | min age | max age |
|---|---|---:|---:|---:|
| still tracking | dropped | 38 | 1800s | 1833s |
| still tracking | control | 2 | 1833s | 1833s |
| still tracking | activity | 1 | 1823s | 1823s |

**All 41 are aged between 1800s and 1833s** — within 33 seconds of the mark. All
are still being tracked; none were stopped or resolved. Marks are emitted on a
1-second tick but committed on the 30-second drain, so a token that has just
crossed 1800s has not yet had its row written. No token older than 1833s is
missing the mark.

### Death rule

Of tokens **dropped at the 10-minute decision** — the ones that stopped being
sampled — and old enough to owe a +30m mark:

| dropped tokens owed +30m | received the +30m mark |
|---:|---:|
| 321 | 295 |

**295 of 321 (92%)** received the forced mark despite having been dropped, and
the 26 outstanding fall in the same sub-33-second commit lag described above.
Separately, 299 of the 328 +30m marks written are flagged frozen, i.e. written
for tokens with no trade since the previous snapshot.

**The death rule is not deciding the outcome horizon**: tokens that were dropped
and tokens that had gone quiet both still receive their forced observation.

---

## 5. Graduates

**n = 14.**

| graduates with early rows | zero back-fill | first mark at 15s | min distinct prices | max distinct prices |
|---:|---:|---:|---:|---:|
| 14 | **14** | **14** | 1 | 1 |

**All 14 have real t=0 snapshots** — no back-filling, and every one starts at the
15-second mark rather than at adoption.

### Per graduate

| mint (first 14) | early marks | write instants | distinct prices | trades by 600s | launch→graduation |
|---|---:|---:|---:|---:|---:|
| HhnGyAnMVSYdNN | 13 | 13 | 1 | 1 | 0s |
| Ez8cQ9PdVVrzRA | 15 | 15 | 1 | 1 | 0s |
| FtEGFyYvR82n1W | 30 | 30 | 1 | 1 | 0s |
| G3bFXB7KTqcpsU | 30 | 30 | 1 | 1 | 0s |
| 2hwdahbzsnpWTG | 3 | 3 | 1 | 1 | 0s |
| 8k9bUoWmDrYbD7 | 30 | 30 | 1 | 3 | 0s |
| BCRMnD8zq4F7kY | 30 | 30 | 1 | 1 | 0s |
| BdvNf2crmqQPhW | 30 | 30 | 1 | 1 | 0s |
| DcARxhBDniWHH3 | 30 | 30 | 1 | 7 | 0s |
| Ebf3ax5b8DyKJ6 | 30 | 30 | 1 | 1 | 0s |
| GdJ1t1pqvCjG6P | 15 | 15 | 1 | 187 | 8s |
| EVpszSRyQok4M6 | 30 | 30 | 1 | 159 | 8s |
| 3fL6pSmx48KSZC | 30 | 30 | 1 | 42 | 9s |
| 3H1GWh6tPoqrMa | 30 | 30 | 1 | 105 | 19s |

### Time from launch to graduation

**n = 14.**

| min | p25 | median | p75 | p90 | max |
|---:|---:|---:|---:|---:|---:|
| 0.000s | 0s | **0.0005s** | 6.05s | 8.76s | 19.25s |

⚠️ **Ten of 14 graduated in under one second, and every graduate shows exactly 1
distinct curve price.** Both were checked rather than assumed:

| bucket | n | max curve SOL reached | max trades | post-graduation snapshots | DEX-priced snapshots |
|---|---:|---:|---:|---:|---:|
| < 1s | 10 | 85.005 | 7 | 377 | 377 |
| ≥ 1s | 4 | 85.005 | 187 | 179 | 179 |

All 14 reached **85.005 SOL**, the bonding-curve completion threshold — the same
maximum reached by non-graduating tokens that cleared the floor (85.005 across
68 tokens). All 14 have post-graduation snapshots priced from DEX. The sub-second
graduations are therefore recorded as filling the curve on as few as 1–7 trades.

⚠️ **Consequence for the early window on these tokens:** a token that graduates
at t≈0 has no curve-trading phase left to observe, so `price_sol` never changes
across its 30 early marks. That is why all 14 show 1 distinct price. Their price
movement, where it exists, is in `dex_price_usd` / `price_usd_effective`, not in
the curve columns. **The early-window curve features are constant for every
graduate in this sample**, and this is not caused by back-filling — the rows are
genuinely distinct observations of an unchanging value.

---

## Summary of things that look wrong

| # | Observation | n |
|---|---|---|
| 1 | `holder_count` is null on every snapshot ever written | 0 of 49,736 non-null |
| 2 | `largest_buy / curve SOL` is meaningless for non-clearing tokens; denominator is 1–3 lamports | 1,453 of 1,526 |
| 3 | 66% of 5-minute snapshots hold ≤ 1e-6 SOL on the curve | 1,039 of 1,574 |
| 4 | 41 tokens past 1800s lack their +30m mark — all within 33s, attributable to the 30s drain commit lag | 41 of 444 |
| 5 | 10 of 14 graduates completed the curve in under 1 second | 10 of 14 |
| 6 | Every graduate has exactly 1 distinct curve price across its early window | 14 of 14 |
| 7 | 32 tokens traded after the 15s mark yet show a single distinct price | 32 of 477 |
| 8 | A token at 23.35 SOL at 5 min did not clear a 1 SOL floor at 10 min | 1 |

Items 1 and 2 are defects in what is stored. Items 3, 5, 6 and 8 are properties
of the tokens as recorded, not of the recording. Item 4 resolves itself within
one drain. Item 7 is unexplained at this sample size.

## What is clean

- **1,676 of 1,676** tokens have zero back-filled snapshots
- **1,241 of 1,241** tokens due a full early grid have all 30 marks, no gaps
- **0 nulls** on 25 of 33 snapshot columns at the 5-minute mark, including every
  curve, price, market-cap and counter column
- **14 of 14** graduates retain genuine t=0 snapshots starting at the 15s mark
- Forced outcome marks are written for dropped and frozen tokens alike
