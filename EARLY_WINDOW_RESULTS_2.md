# Early window, second pass: buying at 5 minutes

Read-only analysis of `pumpfun-early-window`, using `price_usd_effective` and
treating `has_market = false` as **no market**, not a flat return.

Queried from production **2026-08-25 14:33 UTC**. Collection window: **463
minutes (7.7 hours)**. 423 tokens tracked — **291 random sample**, 132
graduates.

Random sample and graduates are reported separately and never pooled. Graduates
are adopted *because* they graduated.

---

## The headline

**14.5% of sampled tokens still had a market at 20 minutes. 4.5% at one hour.
0.7% at three hours. None at six.**

Everything below follows from that. The return questions are answerable only on
a shrinking survivor pool; the survival question is answerable on all 289 — and
that is where every usable signal turned out to live.

---

## 1. The shape — random sample

n with a 5-minute effective price: **289**.

### +20m — eligible by age: 289

| | n | % positive | Median | p25 | p75 | p90 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| (a) still trading | **42** | 31% | **−1.9%** | −13.2% | +0.1% | +10.2% | **+87.6%** |
| (b) all, no-market = −100% | **289** | 4% | **−100.0%** | −100.0% | −100.0% | −11.4% | +87.6% |
| (c) no market | **247** | | | | 85.5% of eligible | | |

### +1h — eligible by age: 289

| | n | % positive | Median | p25 | p75 | p90 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| (a) still trading | **13** ⚠️ | 23% | −8.2% | −56.4% | −1.1% | +20.7% | +29.8% |
| (b) all, no-market = −100% | **289** | 1% | **−100.0%** | −100.0% | −100.0% | −100.0% | +29.8% |
| (c) no market | **276** | | | | 95.5% of eligible | | |

⚠️ **13 tokens. No conclusion drawn from row (a).**

### +3h — eligible by age: 278

| | n | % positive | Median | p25 | p75 | p90 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| (a) still trading | **2** ⚠️ | 0% | −62.9% | −69.7% | −56.1% | −52.0% | −49.3% |
| (b) all, no-market = −100% | **278** | 0% | **−100.0%** | −100.0% | −100.0% | −100.0% | −49.3% |
| (c) no market | **276** | | | | 99.3% of eligible | | |

⚠️ **2 tokens.**

### +6h — eligible by age: 82

| | n | % positive | Median | Max |
|---|---:|---:|---:|---:|
| (a) still trading | **0** | — | — | — |
| (b) all, no-market = −100% | **82** | 0% | **−100.0%** | −100.0% |
| (c) no market | **82** | | 100.0% of eligible | |

**Not one of the 82 tokens old enough to reach six hours still had a market.**

### Survival

| Mark | Still had a market | of eligible |
|---|---:|---:|
| +20m | **42** | 289 (14.5%) |
| +1h | **13** | 289 (4.5%) |
| +3h | **2** | 278 (0.7%) |
| +6h | **0** | 82 (0.0%) |

Reading (a) against (b): among the 14.5% that were still tradeable at 20
minutes the median was −1.9% and the best was +87.6%. Across all 289, treating
an untradeable token as a total loss, the median is −100%.

---

## 1b. Graduates — and a limitation this exposed

**`has_market` does not work for graduated tokens, and the earlier "0% survival"
reading was an artifact of that, not a fact about the tokens.**

`has_market` counts *bonding-curve* trades. After graduation the curve is
complete and trading moves to the AMM, so the flag reads false almost always:

| | |
|---|---:|
| Post-graduation graduate snapshots | 9,460 |
| …with `has_market = true` | **68 (0.7%)** |
| …with a DEX price | 6,852 |
| Graduates whose DEX price actually moved | **129 of 131** |

So 129 of 131 graduates were demonstrably trading while the flag said they were
not. Applying the `has_market` filter to graduates removes essentially all of
them, which is why section 1 above shows zero survivors for that group — a
measurement artifact.

Measured correctly on DEX price, first to last observation (median hold ≈ 51
minutes):

| n | Up | p25 | Median | p75 | p90 | Max |
|---:|---:|---:|---:|---:|---:|---:|
| **131** | **46** | −96.9% | **−85.9%** | +15.8% | +50.6% | **+2370.3%** |

⚠️ Outcome-selected. Every one of these graduated, which almost none of the
random sample did. **Not comparable to section 1 and not to be read as what
buying a sampled token looks like.**

---

## 2. Best exit — perfect timing

Peak of `price_usd_effective` between +5m and +6h, restricted to tokens with a
market after 5 minutes.

| Population | n | Median peak | p75 | p90 | Max | Median time to peak |
|---|---:|---:|---:|---:|---:|---:|
| Random | **84** | **+0.1%** | +1.0% | +23.0% | **+221.1%** | **7.0 min** |

- Positive peak: **46 of 84**
- Time to peak: p25 6.0 min, p75 16.0 min, max 65.0 min
- Median age at last market: **19.5 min** — the peak is censored by this

⚠️ **Not a six-hour ceiling.** No random token had a market past three hours, so
the search interval is effectively 5–65 minutes. The median time to peak of 7
minutes is only two minutes after the entry point.

Even with perfect exit timing and hindsight, the median sampled token that kept
trading returned **+0.1%**. Half the upside sits in the top decile: p90 +23%,
max +221%.

---

## 3. Does anything at 5 minutes predict the 1-hour return?

**The return question cannot be answered: only 13 tokens have a +1h return.**
Quartiles of that are three tokens each.

**But your instinct was right — the signal is in surviving at all.** Survival is
observable on all 289, and it separates strongly. Ranked by AUC for still having
a market at 20 minutes:

| Rank | Feature @5m | AUC (survive 20m) | AUC (survive 1h) |
|---:|---|---:|---:|
| 1 | **Curve SOL** | **0.871** | **0.931** |
| 2 | **Unique buyers** | **0.842** | **0.898** |
| 3 | **Trade count** | 0.821 | 0.868 |
| 4 | Buy volume (SOL) | 0.780 | 0.832 |
| 5 | Buy/sell ratio | 0.727 | 0.686 |
| 6 | Initial mcap | 0.680 | 0.746 |
| 7 | Largest buy / curve SOL | 0.359 → **0.641 inverse** | 0.178 → **0.822 inverse** |

### Curve SOL @5m — AUC 0.871 / 0.931

| Quartile | n | Range | Alive @20m | Alive @1h | Median return @20m (survivors) |
|---|---:|---|---:|---:|---:|
| Q1 | 72 | 0 – 1e-09 | **1 (1%)** | 0 (0%) | +0.1% (n=1) ⚠️ |
| Q2 | 72 | 1e-09 – 1.1e-08 | 2 (3%) | 0 (0%) | +0.1% (n=2) ⚠️ |
| Q3 | 72 | 1.1e-08 – 0.0283 | 7 (10%) | 1 (1%) | 0.0% (n=7) ⚠️ |
| Q4 | 73 | 0.0285 – 85 | **32 (44%)** | **12 (16%)** | −3.8% (n=32) |

⚠️ Note the ranges: Q1–Q3 are all effectively **zero** SOL (top of Q3 is 0.028).
In practice this feature is near-binary — "has any meaningful SOL in the curve
at five minutes" — rather than a continuous scale.

### Unique buyers @5m — AUC 0.842 / 0.898

| Quartile | n | Range | Alive @20m | Alive @1h | Median return @20m (survivors) |
|---|---:|---|---:|---:|---:|
| Q1 | 72 | 0 – 1 | 2 (3%) | 0 (0%) | +0.1% (n=2) ⚠️ |
| Q2 | 72 | 1 – 3 | 4 (6%) | 0 (0%) | −0.2% (n=4) ⚠️ |
| Q3 | 72 | 3 – 11 | 7 (10%) | 2 (3%) | 0.0% (n=7) ⚠️ |
| Q4 | 73 | 12 – 560 | **29 (40%)** | **11 (15%)** | −5.7% (n=29) ⚠️ |

### Trade count @5m — AUC 0.821 / 0.868

| Quartile | n | Range | Alive @20m | Alive @1h | Median return @20m (survivors) |
|---|---:|---|---:|---:|---:|
| Q1 | 72 | 0 – 2 | 2 (3%) | 0 (0%) | −0.3% (n=2) ⚠️ |
| Q2 | 72 | 2 – 8 | 5 (7%) | 1 (1%) | +0.2% (n=5) ⚠️ |
| Q3 | 72 | 8 – 44 | 7 (10%) | 3 (4%) | −0.9% (n=7) ⚠️ |
| Q4 | 73 | 48 – 2060 | **28 (38%)** | 9 (12%) | −4.8% (n=28) ⚠️ |

### Largest buy / curve SOL — inverse, and the most interesting

| Quartile | n | Range | Alive @20m | Alive @1h | Median return @20m (survivors) |
|---|---:|---|---:|---:|---:|
| Q1 | **21** ⚠️ | 0.092 – 0.832 | **13 (62%)** | **8 (38%)** | −42.2% (n=13) |
| Q2 | 21 ⚠️ | 0.845 – 1.22 | 6 (29%) | 2 (10%) | −1.7% (n=6) |
| Q3 | 21 ⚠️ | 1.36 – 5.87 | 8 (38%) | 2 (10%) | −2.4% (n=8) |
| Q4 | 21 ⚠️ | 6.89 – 1120 | 7 (33%) | **0 (0%)** | −1.2% (n=7) |

⚠️ **21 tokens per quartile — below 30, no conclusion drawn.** Defined only for
the 84 tokens with more than 0.01 SOL in the curve. Directionally it is the
sharpest thing here: the least concentrated quartile had **38% alive at one
hour** versus **0%** for the most concentrated. Low concentration means many
buyers contributed; high concentration means one buy was the whole curve. Worth
re-running once n supports it.

### The pattern that runs through every table

**The quartile with the best survival has the worst median return among its
survivors**, in all seven features. That is not a paradox:

- A token with no market has a carried-forward price and a return of exactly
  0.0% — which *looks* better than a real, traded −4%.
- So Q1–Q3's "returns" of ≈0% are almost entirely frozen prints on n = 1–7.
- Q4's −3.8% is the only figure among them computed on tokens that could
  actually be sold.

This is precisely the trap `has_market` was added to expose, and it is visible
in every row above.

---

## 4. Cutoffs

Thresholds maximising Youden's J for **survival to +20m**. Base rate: 42 of 289
= **14.5%**.

### Curve SOL @5m ≥ 0.0185

| | |
|---|---:|
| Tokens above cutoff | **77 / 289 = 26.6%** |
| Of those, alive @20m | **34 / 77 = 44.2%** |
| Below cutoff, alive @20m | 8 / 212 = **3.8%** |
| Youden J | **0.635** |
| Median return @20m, above | −3.5% (n=34) |
| Median return @20m, below | +0.1% (n=8 ⚠️) |

**A 3× lift on the base rate, and an 11× difference across the threshold.**

### Unique buyers @5m ≥ 17

| | |
|---|---:|
| Tokens above cutoff | **58 / 289 = 20.1%** |
| Of those, alive @20m | **29 / 58 = 50.0%** |
| Below cutoff, alive @20m | 13 / 231 = **5.6%** |
| Youden J | 0.573 |
| Median return @20m, above | −5.7% (n=29 ⚠️) |
| Median return @20m, below | +0.1% (n=13 ⚠️) |

**The single cleanest survival filter: a coin flip above it, 1-in-18 below.**

### Trade count @5m ≥ 22

| | |
|---|---:|
| Tokens above cutoff | **102 / 289 = 35.3%** |
| Of those, alive @20m | **34 / 102 = 33.3%** |
| Below cutoff, alive @20m | 8 / 187 = **4.3%** |
| Youden J | 0.534 |
| Median return @20m, above | −3.8% (n=34) |
| Median return @20m, below | +0.1% (n=8 ⚠️) |

⚠️ **The return rows under every cutoff rest on 8–34 tokens.** The *survival*
rows use all 289 and are the trustworthy part. A cutoff here buys you a token
that can still be sold in twenty minutes — it does not buy you a positive
return, and nothing in this dataset says it does.

---

## What this does and does not support

**Supported:**

- Survival collapses fast and predictably: **14.5% → 4.5% → 0.7% → 0%** across
  20m, 1h, 3h, 6h.
- **Five-minute features predict survival strongly**, AUC 0.87 for curve SOL and
  0.84 for unique buyers at 20 minutes, rising to 0.93 and 0.90 at one hour.
- Simple thresholds give a real lift: curve SOL ≥ 0.0185 takes the survival rate
  from 14.5% to 44.2% while keeping 26.6% of tokens.
- Even with perfect hindsight exit timing, the median surviving token peaked at
  **+0.1%**, typically **7 minutes** after entry.
- Graduates on DEX price: median **−85.9%**, but a p90 of +50.6% and a max of
  +2370% — a distribution dominated by its tail.

**Not supported:**

- **Any claim about the +1h return.** 13 tokens. The requested quartile analysis
  on return is not possible and was not produced.
- Anything at +3h (n=2) or +6h (n=0) for the random sample.
- Any read on the concentration feature. 21 per quartile.
- **That these features predict profit.** They predict *tradeability*. Among
  survivors, the high-feature quartiles had the *worst* median returns. Survival
  and return are different questions and only the first is answered here.

**What would change it:** time, and only for the return questions. The survival
result is already on firm ground at n=289. The +1h return needs the survivor
pool to grow — at the current 4.5% survival rate that means roughly 700 sampled
tokens for 30 survivors, about two more days of collection. The +6h return may
never be answerable from the random sample at all, since zero of 82 eligible
tokens reached it with a market intact.
