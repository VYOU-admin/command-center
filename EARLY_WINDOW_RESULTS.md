# Early window: what happened if you bought at 5 minutes

Read-only analysis of `pumpfun-early-window`. Queried from production
**2026-08-25 08:06 UTC**.

---

## Read this first: the monitor is 76 minutes old

It started collecting at 06:50 and has **76 minutes of data**. Three of the four
marks you asked about are in the future.

| | |
|---|---|
| Tokens tracked | **87** (56 random sample, 31 graduates) |
| Tokens with a 5-minute baseline | **85** (54 random, 31 graduates) |
| Deepest snapshot reached | **4,200s (70 min)** |

**Tokens old enough for each mark:**

| Mark | Old enough | Snapshot exists | Verdict |
|---|---:|---:|---|
| +20m | 70 | **70** | answerable |
| +1h | 22 | **20** | **n < 30 — reported, no conclusions drawn** |
| +3h | **0** | **0** | not answerable |
| +6h | **0** | **0** | not answerable |

Restricted to the random sample — which is what "every sampled token" means —
the +1h population is **15 tokens**. Quartiles of that are four tokens each.

**Consequence: questions 3 and 4 cannot be answered at all.** They are set out
below with the numbers that make them unanswerable, rather than filled in with
figures that would look like results.

### Two populations, kept separate

The 31 `graduate`-reason tokens are adopted **because they graduated**. Pooling
them with the random sample would be survivorship bias of the most direct kind,
so every table below states which population it covers. "Every sampled token"
means the **random sample**.

---

## 1. The shape

### Random sample — return from the 5-minute price

| Mark | Eligible | Found | Dead before | % positive | Median | p25 | p75 | p90 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| +20m | 45 | **45** | 0 | 2% | **0.0%** | −0.1% | 0.0% | 0.0% | +10.5% |
| +1h | 13 | **13** | 0 | 0% | **0.0%** | −24.4% | 0.0% | 0.0% | 0.0% |
| +3h | 0 | 0 | — | — | — | — | — | — | — |
| +6h | 0 | 0 | — | — | — | — | — | — | — |

⚠️ **+1h is 13 tokens. No conclusion is drawn from that row.**

**Counting dead tokens as −100% produces identical tables**, because **zero
tokens are flagged dead yet**. A token is only marked dead after 60 minutes of
silence, and the dataset is 76 minutes old — the flag has barely had time to
fire. The "both ways" comparison you asked for is not yet distinguishable, and
that is a property of the clock, not of the tokens.

### Why almost every number is exactly 0.0%

This is the real finding, and it is not a bug:

| | Random sample |
|---|---:|
| Tokens with a 5-min baseline | 56 |
| **Traded at all after 5 minutes** | **20 (36%)** |
| Never traded again | **36 (64%)** |
| Median new trades after 5 min | **0** |

For roughly two-thirds of sampled tokens the curve receives **no further trades
after minute five**. Every later snapshot carries the last trade's price forward,
so the computed return is exactly zero at every mark.

⚠️ **A 0% return here does not mean you broke even. It means there was no
market.** The price is a stale last-trade print, not a bid. Selling into it is
not possible at that number, and treating these as "flat" would overstate the
outcome of actually holding.

### The tokens that did keep trading — n = 20

Return from the 5-minute price to the last observation (median hold ≈ 44 min):

| n | Up | Median | p25 | p75 | Min | Max |
|---:|---:|---:|---:|---:|---:|---:|
| **20** | **4** | **−2.6%** | −37.4% | 0.0% | −98.4% | +11.9% |

⚠️ **20 tokens — below the 30 threshold, so no conclusion is drawn.** Reported
because it is the only subgroup where a return is a real number rather than a
frozen print. Directionally: 4 of 20 up, a p25 of −37% and a floor of −98%.

---

## 2. Best exit — the perfect-timing ceiling

Peak price between +5m and the end of observation.

⚠️ **This is not a 6-hour ceiling.** Observation ends at a median of **44
minutes**, so the peak is censored at roughly that horizon. The question as
posed cannot be answered until tokens have lived six hours.

| Population | n | Median peak | p75 | p90 | Max | Median time to peak |
|---|---:|---:|---:|---:|---:|---:|
| Random | 52 | **0.0%** | 0.0% | 0.0% | +29.8% | 6.0 min |
| Graduates | 30 | 0.0% | 0.0% | 0.0% | 0.0% | 6.0 min |

The median peak of 0.0% at 6.0 minutes is the same artifact: for a token that
stopped trading, the highest price after the baseline **is** the baseline, and
the "peak" lands on the first snapshot after it. Only 0 of 52 random tokens
peaked at their final observation, so almost nothing was still climbing when
observation ended.

The graduate row reading 0.0% everywhere is not real, and is explained below.

---

## 3. Does anything at 5 minutes predict the 1-hour return?

## Not answerable.

The random sample has **15 tokens** with both a 5-minute baseline and a
+1h snapshot. Splitting 15 tokens into quartiles gives **four tokens per
bucket** — against your own instruction not to draw conclusions below 30.

Every requested feature (curve SOL, trade count, buy/sell ratio, unique buyers,
largest buy share, buy volume, initial mcap) is present and populated at 5
minutes. The obstacle is entirely the outcome side: there is no +1h return
distribution to split against.

There is a second obstacle that will persist even once n grows. Of the 15
tokens, most have a +1h return of exactly 0.0% because they stopped trading —
so the outcome variable is near-constant, and no feature can separate against a
constant. A meaningful version of this question needs either a longer horizon or
a population restricted to tokens still trading at the mark.

**No feature ranking is produced.**

---

## 4. Cutoffs

## Not answerable.

This depends entirely on question 3, which produced no ranking. Choosing a
threshold from four-token buckets would be fitting to noise, and the resulting
"fraction of tokens surviving the cutoff" would be a number with no support
behind it.

---

## A defect this analysis exposed

**For graduated tokens, `price_sol` is frozen and meaningless after
graduation.** This is not a collection failure — the right data is being stored —
but the column silently means different things before and after graduation.

Once a token graduates, its bonding curve completes and all trading moves to the
AMM. The monitor's program-wide subscription watches the **bonding curve
program**, so it sees no further trades. `price_sol` therefore holds its
graduation-instant value forever.

One graduate's actual series:

```
t=  15s   price_sol=4.109e-7   dex_price_usd = —
t= 300s   price_sol=4.109e-7   dex_price_usd = —
t= 360s   price_sol=4.109e-7   dex_price_usd = 5.630e-5
t= 660s   price_sol=4.109e-7   dex_price_usd = 5.575e-5
t=1020s   price_sol=4.109e-7   dex_price_usd = 1.111e-4
t=1440s   price_sol=4.109e-7   dex_price_usd = 1.122e-4
```

`price_sol` reports **0% change**. The token's real price roughly **doubled**.

`price_usd` does not help either — it is `price_sol × sol_usd`, so it drifts only
with SOL, tracking the wrong asset entirely.

**The DexScreener enrichment is working and covers the gap**: 33 of 34 graduates
have `dex_price_usd`, averaging 38.7 snapshots and 6.8 distinct prices each. It
is simply a different column, and any return analysis has to know to switch.

### Graduates measured correctly, on DEX price

First to last DEX price, median hold 34 minutes:

| n | Up | Median | p25 | p75 | p90 | Max |
|---:|---:|---:|---:|---:|---:|---:|
| **33** | **14** | **−0.6%** | **−93.4%** | +16.3% | +47.9% | **+433.8%** |

A real distribution with an enormous spread — a p25 of −93% alongside a max of
+434%. ⚠️ **n = 33, and these are outcome-selected**: every one is a token that
graduated. This is not what buying a random sampled token looks like, and the
two must not be compared.

---

## What would change this

**Time, for questions 1 and 2.** Nothing is wrong with the collection — +3h and
+6h simply have not happened. At 24 hours of collection the random sample should
hold roughly 1,300 tokens with several hundred reaching +6h, which is enough for
every table above.

**A design decision, for questions 3 and 4.** Two obstacles are structural
rather than temporal:

1. **Post-graduation price needs `dex_price_usd`**, and nothing in the monitor
   marks which column is authoritative for a given row. A `price_source` column,
   or writing the DEX price into `price_usd` once graduated, would remove a trap
   that any future analysis will otherwise fall into.
2. **Two-thirds of sampled tokens have no market after 5 minutes.** Their return
   is definitionally zero at every horizon. Any predictive question needs either
   the outcome defined on tokens still trading at the mark, or an explicit
   "no market" label so a frozen print is never read as a flat return.

Neither is fixed by waiting.
