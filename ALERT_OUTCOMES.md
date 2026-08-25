# What happened after the alerts fired

Read-only analysis of the 81 tokens in `solana_top_membership` that have fired a
Discord alert, measured against `solana_token_observations`.

Queried from production at **2026-08-25 05:41 UTC**. Most recent monitor run:
04:50 UTC. 50 runs exist, spaced a median of 61 minutes apart.

---

## Read this before the numbers

Four things constrain how much these results can carry. None of them are
fixable after the fact; they are properties of the data that exists.

**1. The dataset is barely two days old.** The earliest alert is 2026-08-23
02:13. Median time elapsed since alert is **23.2 hours**. That is why the +48h
row is nearly empty and the +24h row is half-empty — not because tokens vanished,
but because the future has not happened yet.

**2. "Eligible" and "found" are different numbers, and both are reported.**
*Eligible* = enough wall-clock time has passed for that horizon's ±90-minute
window to have opened. *Found* = an observation actually exists in that window.
A token that alerted 10 hours ago is not missing from +24h; it is simply not
eligible. Conflating the two would understate coverage and overstate attrition.

**3. The alert timestamp is the MOST RECENT alert, not the first.** The column
`last_alerted_at` is overwritten when a token re-enters the top 20 after the
24-hour cooldown (`solana-tokens.ts:716`). 70 of 81 tokens have left the top at
least once, and 7 currently in the top have also previously exited — so for an
unknown subset the measurement window starts at a *re*-alert. The first alert is
not recoverable from the schema.

**4. Returns are computed from `price_usd`.** As a check, the same returns were
computed from `mcap`: at +24h, **zero** tokens differed by more than 5
percentage points between the two. The price series is internally consistent.

Percentiles are linear-interpolated. "%>0" is the share of *found* observations
with a positive return.

---

## a. Return distribution at each horizon — all alerted tokens

n at alert = **81** (every one has an observation at alert time; the median
offset between alert and its observation is 0.00 minutes, because the alert is
raised inside the same write).

| Horizon | Eligible | Found | Median | p25 | p75 | Min | Max | % positive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| +6h | 72 | **68** | −15.2% | −42.6% | +0.3% | −99.7% | +265.0% | 25% |
| +12h | 65 | **59** | −38.3% | −76.7% | +4.5% | −99.4% | +1010.1% | 27% |
| +24h | 41 | **31** | −61.5% | −83.6% | −20.4% | −99.6% | +122.7% | 10% |
| +48h | 6 | **6** | −53.5% | −89.0% | −32.1% | −95.3% | −19.9% | 0% |

⚠️ **The +48h row is six tokens.** Not a distribution — six numbers. Its p25 and
p75 are the 2nd and 5th of six values. It should be read as an anecdote, not a
result. The +24h row (n=31) is thin too.

The direction is consistent across every horizon that has meaningful n: the
median alerted token is **down at 6 hours, further down at 12, and further down
again at 24**. At +24h only 3 of 31 tokens were above their alert price.

For context, the levels at alert time: median market cap **$128,369** (p25
$60,047, p75 $231,814), median liquidity **$30,012** (p25 $20,141, p75 $45,062).
Median completeness 1.00; 11 of 81 alerted below full signal coverage, the
lowest at 0.70.

---

## b. Split by score at alert

**The requested `<70` band is empty.** The lowest score among all 81 alerted
tokens is **77**. This is structural, not coincidence: alerts fire only on entry
to the top 20 by score, and the enrichment cap means at most 25 tokens are scored
per run — so the alerting pool is the high-scoring tail by construction.

| Band | Tokens |
| --- | ---: |
| `<70` | **0** |
| `70–84` | **6** |
| `85+` | **75** |

### Score 70–84 — **6 tokens**

| Horizon | Eligible | Found | Median | p25 | p75 | Min | Max | % positive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| +6h | 6 | **6** | −11.5% | −24.4% | −8.6% | −36.5% | +3.1% | 17% |
| +12h | 5 | **5** | +4.3% | −19.9% | +5.5% | −27.5% | +27.6% | 60% |
| +24h | 4 | **4** | −64.5% | −67.9% | −56.7% | −69.5% | −42.4% | 0% |
| +48h | 0 | **0** | — | — | — | — | — | — |

⚠️ Six tokens, thinning to four. The +12h median of +4.3% rests on **five
observations, of which three were positive**. This is not evidence that mid-score
tokens do better — it is what five numbers look like. No comparison against the
85+ band is statistically meaningful at this size.

### Score 85+ — **75 tokens**

| Horizon | Eligible | Found | Median | p25 | p75 | Min | Max | % positive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| +6h | 66 | **62** | −15.6% | −49.1% | +1.0% | −99.7% | +265.0% | 26% |
| +12h | 60 | **54** | −40.1% | −81.5% | −4.3% | −99.4% | +1010.1% | 24% |
| +24h | 37 | **27** | −53.5% | −84.9% | −15.5% | −99.6% | +122.7% | 11% |
| +48h | 6 | **6** | −53.5% | −89.0% | −32.1% | −95.3% | −19.9% | 0% |

This band is 93% of the sample, so it tracks the all-tokens table closely. The
practical consequence: **the score is not currently separating anything**,
because almost everything that alerts scores 85 or above. A discriminator whose
values all sit in one band cannot discriminate.

---

## c. Split by age at alert

| Band | Tokens |
| --- | ---: |
| 6–12h | **57** |
| 12–24h | **13** |
| 24h+ | **11** |

Median age at alert is 7.0 hours — most alerts fire close to the 6-hour minimum
eligibility age. Oldest at alert: 144.3 hours.

### Age 6–12h — **57 tokens**

| Horizon | Eligible | Found | Median | p25 | p75 | Min | Max | % positive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| +6h | 48 | **46** | −14.0% | −37.5% | −0.1% | −99.7% | +265.0% | 24% |
| +12h | 44 | **42** | −34.5% | −65.9% | −5.2% | −99.3% | +1010.1% | 21% |
| +24h | 26 | **18** | −57.5% | −74.5% | −12.0% | −86.1% | +122.7% | 11% |
| +48h | 2 | **2** | −25.8% | −28.7% | −22.8% | −31.6% | −19.9% | 0% |

⚠️ The +48h row is **two tokens**. Median of two values is their mean. Ignore it.

### Age 12–24h — **13 tokens**

| Horizon | Eligible | Found | Median | p25 | p75 | Min | Max | % positive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| +6h | 13 | **12** | −14.4% | −58.9% | +11.9% | −99.5% | +67.7% | 33% |
| +12h | 12 | **11** | +4.3% | −89.2% | +16.5% | −99.4% | +73.9% | 55% |
| +24h | 9 | **8** | −82.8% | −99.4% | −43.3% | −99.6% | +65.1% | 12% |
| +48h | 2 | **2** | −64.5% | −79.9% | −49.0% | −95.3% | −33.6% | 0% |

⚠️ Thirteen tokens. The +12h median of +4.3% with 55% positive sits between a
p25 of −89.2% and a p75 of +16.5% — the spread is enormous relative to the
central value. The apparent "12-hour bump" here and in the 70–84 score band is
the same handful of tokens appearing in both cuts.

### Age 24h+ — **11 tokens**

| Horizon | Eligible | Found | Median | p25 | p75 | Min | Max | % positive |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| +6h | 11 | **10** | −17.5% | −63.9% | −8.8% | −99.4% | +2.9% | 20% |
| +12h | 9 | **6** | −66.5% | −80.3% | −29.0% | −99.3% | +5.1% | 17% |
| +24h | 6 | **5** | −49.5% | −84.4% | −22.6% | −99.4% | −18.2% | 0% |
| +48h | 2 | **2** | −83.8% | −89.0% | −78.6% | −94.2% | −73.4% | 0% |

⚠️ Eleven tokens, thinning to two.

**On all three age bands:** the 6–12h band holds 57 of 81 tokens and the other
two hold 13 and 11. Only the first band has enough tokens for its percentiles to
mean much, and only at +6h and +12h. No age effect can be claimed from this.

---

## d. Tokens that stopped returning a DexScreener row

**None permanently.** All 81 alerted tokens have an observation in the most
recent run (04:50). Zero disappeared.

But the observations are far from continuous, and that is the real finding:

| Measure | Value |
| --- | ---: |
| Alerted tokens with ≥1 post-alert run | 79 (2 alerted on the final run) |
| Of those, tokens missing ≥1 observation | **64 of 79 (81%)** |
| Token-run slots since alert | 1,810 |
| Slots with no observation | **319 (17.6%)** |

**Hours from alert to the first missing observation** (the 64 affected tokens):

| Stat | Hours |
| --- | ---: |
| Min | 1.0 |
| p25 | 6.2 |
| Median | **15.3** |
| p75 | 27.3 |
| Max | 42.5 |

| Bucket | Tokens |
| --- | ---: |
| First gap within 6h of alert | 15 |
| 6–12h | 10 |
| 12–24h | 20 |
| 24h+ | 19 |

Worst offenders — these come back, so they are gaps, not deaths:

| Token | Missed / slots | First gap | Last seen |
| --- | ---: | ---: | ---: |
| `5AbfQ5tGU4YT…` | 34 / 46 | +1.0h | +47.6h |
| `4CwRX9ByUrEG…` | 29 / 48 | +4.0h | +50.6h |
| `CRFjYGMQdSzG…` | 11 / 19 | +3.0h | +21.3h |
| `FraL7qvcGGSy…` | 16 / 43 | +22.2h | +45.6h |

### Why the gaps happen

Not scheduler downtime: 50 runs, median spacing 61 minutes, and exactly one
outlier gap of 189 minutes on 08-24 14:42 (consistent with a deploy).

Not failed requests: zero `metrics chunk failed` entries in the logs.

It is **DexScreener omitting tokens from its response**. The most recent run
logged `universe=1157 observed=950` — 207 tokens were requested and simply came
back with no pair, with no error raised.

Omission correlates with size:

| Group | Tokens | Avg liquidity | Avg market cap |
| --- | ---: | ---: | ---: |
| Never missed a run | 15 | **$34,318** | $179,678 |
| Missed <25% of runs | 49 | $19,896 | $84,717 |
| Missed ≥25% of runs | 15 | **$14,746** | $51,384 |

Tokens that never missed a run carry roughly **2.3× the liquidity** of those
missing a quarter or more. The thinner the token, the likelier DexScreener drops
it from a batch response.

⚠️ **This biases the return tables, in a direction that flatters them.** A
missing observation is disproportionately a low-liquidity, likely-falling token.
At +24h, 10 of 41 eligible tokens had no row — and those 10 are more likely to be
the worst performers than the best. The true median return at +24h is probably
*worse* than the −61.5% reported.

---

## What can and cannot be concluded

**Supported by the data:**

- Alerted tokens are, at the median, **down at every horizon measured**, and
  progressively further down: −15% at 6h, −38% at 12h, −62% at 24h.
- At +24h, **3 of 31** tokens were above their alert price.
- The spread is extreme — +1010% and −99.7% both occur — so the median is doing
  real work and the mean would be meaningless.
- The alerting mechanism produces almost exclusively 85+ scores (75 of 81), so
  the score currently has no discriminating range in the alerted population.
- Observation coverage is 82.4% and its gaps are biased toward thin tokens.

**Not supported by this data:**

- Any claim about the `<70` score band. It is empty.
- Any comparison between score bands. One band has 6 tokens, the other 75.
- Any age effect. 57 of 81 tokens sit in one band.
- Anything at +48h. Six tokens overall, two per age band.
- Any claim that the apparent +12h uplift in the 70–84 and 12–24h cuts is real.
  Those are the same few tokens seen twice, on n=5 and n=11.
- Whether the *first* alert would show the same pattern as the most recent one.
  The schema does not retain first-alert time.

**The single most useful thing that would change this:** letting it run. Every
horizon beyond +12h is currently limited by elapsed time, not by anything in the
code. At two weeks of collection the +24h and +48h rows would have full n, and
the score bands would still be degenerate — that one needs an alerting change,
not patience.
