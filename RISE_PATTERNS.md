# Does anything at 5 minutes predict a rise?

Read-only analysis of `pumpfun-early-window`, all tokens with a 5-minute
snapshot and `price_usd_effective > 0`. Queried 2026-08-25 15:24 UTC, after
8.6 hours of collection.

**Cohort: 381 tokens — 289 random sample, 92 graduates.** Tagged throughout,
reported combined and separately. `has_market` is not used as a filter; the
frozen-price state is reported as its own column.

---

## The short answer

**No — and the two horizons you asked about cannot be evaluated at all.**

Three things block it, in order of how much they matter:

1. **+2h and +3h are unreachable.** n = 13 and n = 5.
2. **"Rose" is almost entirely sub-1% noise on frozen prices** in the random
   sample. Only 6 of 263 random tokens rose ≥10% at +30m.
3. **Every strong signal in the combined table is cohort detection**, not
   prediction — the best threshold found is literally "is this a graduate".

Each is evidenced below, and the requested tables are reported in full anyway.

---

## Reachability, and the frozen-price problem

| Cohort | Mark | n | % rose | **% frozen** | % has_market | Median return |
|---|---|---:|---:|---:|---:|---:|
| Combined | +30m | 348 | 34% | **78%** | 3% | −0.2% |
| Combined | +1h | 322 | 17% | **80%** | 1% | −0.8% |
| Combined | +2h | **12** ⚠️ | 17% | 8% | 25% | −26.0% |
| Combined | +3h | **5** ⚠️ | 0% | 0% | 40% | −57.4% |
| Random | +30m | 263 | 31% | 76% | 3% | −0.2% |
| Random | +1h | 246 | 11% | 78% | 2% | −0.7% |
| Random | +2h | **12** ⚠️ | 17% | 8% | 25% | −26.0% |
| Random | +3h | **5** ⚠️ | 0% | 0% | 40% | −57.4% |
| Graduates | +30m | 85 | 42% | 84% | **0%** | −61.7% |
| Graduates | +1h | 76 | 38% | 88% | **0%** | −94.3% |
| Graduates | +2h / +3h | **0** | — | — | — | — |

**Why +2h and +3h are empty:** median max snapshot age is 60 minutes for both
cohorts. Tracking stops 60 minutes after a token's last trade, and almost every
token stops trading well inside the first hour. The six-hour window only applies
to tokens that keep trading, and almost none do. **This is structural, not a
matter of collecting longer.**

`has_market` reads 0% for graduates at every mark — it counts bonding-curve
trades, and graduates trade on the AMM. The frozen-price column is the
cohort-neutral measure and is used throughout.

### "Rose" versus "rose meaningfully"

| Cohort | Mark | n | rose > 0 | rose ≥ 1% | **rose ≥ 10%** | rose ≥ 50% |
|---|---|---:|---:|---:|---:|---:|
| Combined | +30m | 348 | 34% | 13% | 8% (28) | 2% |
| Combined | +1h | 322 | 17% | 11% | 10% (29) | 2% |
| **Random** | **+30m** | 263 | **31%** | **4%** | **2% (6)** | 1% |
| **Random** | **+1h** | 246 | **11%** | **2%** | **2% (5)** | 0% |
| Graduates | +30m | 85 | 42% | 42% | 26% (22) | 7% |
| Graduates | +1h | 76 | 38% | 38% | 34% (26) | 8% |

For the random sample, "rose at all" collapses from 31% to 4% the moment you
require a 1% move. Those 31% are rounding noise on a price that has not traded
since minute five. **Six random tokens rose ≥10% at +30m; five at +1h.** No
analysis can be built on that.

For graduates the rises are real — 42% rose ≥1% — but see the confound below.

---

## The confound: features that identify the cohort

Graduates are adopted *at graduation*, so they have no history before that
moment. The tracker back-fills their early marks with adoption-time state, which
means their "5-minute features" are their **at-graduation curve state**.

| Feature | **AUC for "is a graduate"** | Graduate median / random median |
|---|---:|---|
| largest buy (SOL) | **0.966** | **85.01 / 0.854** |
| mcap (SOL) | **0.925** | **410.9 / 27.96** |
| unique sellers | 0.112 inverse | 0 / 3 |
| sell volume (SOL) | 0.112 inverse | 0 / 0.988 |
| sell count | 0.112 inverse | 0 / 4 |
| trade count | 0.195 inverse | 1 / 8 |
| initial mcap (SOL) | 0.763 | 410.9 / 28.42 |

Graduates' median return at +30m is **−61.7%**; random's is **−0.2%**. So any
feature that identifies the cohort inherits that difference wholesale.

The combined table's top features at +30m are mcap (0.823), curve SOL (0.813)
and largest buy (0.802) — the same three that identify cohort at 0.92–0.97. And
the best threshold the search finds is:

> **mcap ≥ 410.9** → 29% rose ≥10%, versus 3% below.

410.9 is exactly the graduates' back-filled median mcap. The cutoff is not a
price signal; it is a cohort label.

**Read the combined tables below with that in mind.** The per-cohort tables are
the ones that mean anything.

---

## 1. Quartiles

### Random sample, +30m — n = 263 (the cleanest cohort: real 5-minute features)

**curve SOL** (AUC 0.359 — *inverse*)

| Q | n | Range | % rose | Median | p75 | p90 | Max | Frozen |
|---|---:|---|---:|---:|---:|---:|---:|---:|
| Q1 | 65 | 0 – 1e-09 | **49%** | −0.0% | +0.2% | +0.3% | +1.1% | 77% |
| Q2 | 66 | 1e-09 – 1.3e-08 | 27% | −0.2% | 0.0% | +0.2% | +12.2% | 76% |
| Q3 | 66 | 1.3e-08 – 0.035 | 33% | −0.2% | +0.1% | +0.3% | +10.9% | 77% |
| Q4 | 66 | 0.046 – 85.01 | **14%** | **−3.2%** | −1.1% | +0.7% | **+76.6%** | 76% |

⚠️ **Q1's "49% rose" is not a rise.** Its p90 is +0.3% and its maximum is +1.1%
— every one of those rises is under one percent, on a price that is frozen 77%
of the time. Q4 is the only quartile with real movement (max +76.6%), and it is
the one that falls.

The same inverse pattern holds for unique buyers (0.363), trade count (0.367)
and buy count (0.370): Q1 ≈ 45% "rose", Q4 ≈ 17%, and Q4's median is −2.1%.

### Combined, +1h — n = 276

**largest buy (SOL)** (AUC 0.752 — but see the confound section)

| Q | n | Range | % rose | Median | p75 | p90 | Max |
|---|---:|---|---:|---:|---:|---:|---:|
| Q1 | 69 | 1e-07 – 0.198 | 9% | −0.7% | −0.4% | −0.1% | +331.0% |
| Q2 | 69 | 0.198 – 2 | 7% | −0.8% | −0.4% | −0.1% | +29.8% |
| Q3 | 69 | 2 – 6.9 | 14% | −0.9% | −0.5% | +0.2% | +15.5% |
| Q4 | 69 | 7 – 85.01 | **42%** | **−56.4%** | +16.0% | +43.8% | +113.4% |

Q4 rises more often *and* has a far worse median — the graduate signature: a
minority moon, the majority collapse. Q4's range topping out at 85.01 SOL is the
graduation threshold; this quartile is largely the graduate cohort.

### Graduates, +30m — n = 85, quartiles of 21–22 ⚠️

**initial mcap (SOL)** (AUC 0.693)

| Q | n | Range | % rose | Median | p90 | Max |
|---|---:|---|---:|---:|---:|---:|
| Q1 | 21 ⚠️ | 27.96 – 28.14 | 14% | −94.1% | +21.0% | +131.6% |
| Q2 | 21 ⚠️ | 28.49 – 410.9 | 38% | −76.0% | +193.6% | +325.1% |
| Q3 | 21 ⚠️ | 410.9 – 410.9 | 57% | +3.6% | +24.7% | +29.5% |
| Q4 | 22 ⚠️ | 410.9 – 410.9 | **59%** | **+6.7%** | +21.0% | +32.3% |

⚠️ Q3 and Q4 have an identical range (410.9 – 410.9) — the split inside them is
arbitrary. This is the back-fill artifact appearing directly in the quartile
boundaries.

---

## 2. AUC ranking

### For "rose at all" — contaminated by the noise described above

| Cohort | Mark | Top features |
|---|---|---|
| Combined | +30m | sell count 0.382*, unique sellers 0.383*, sell volume 0.388*, trade count 0.389* |
| Combined | +1h | largest buy 0.752, initial mcap 0.725, curve SOL 0.692, buyers/trade 0.687 |
| Random | +30m | curve SOL 0.359*, unique buyers 0.363*, trade count 0.367* |
| Random | +1h | largest buy 0.621, largest buy/curve 0.620, initial mcap 0.606 |
| Graduates | +30m | has twitter 0.268*, initial mcap 0.693, buyers/trade 0.662 |
| Graduates | +1h | initial mcap 0.696, has twitter 0.336*, largest buy/curve 0.637 |

`*` = inverse. ⚠️ **The sign flips between +30m and +1h in both the combined and
random cohorts** — activity predicts *not* rising at 30 minutes and *rising* at
an hour. A feature that reverses direction across adjacent horizons is measuring
an artifact, not an effect. The artifact is the frozen-price noise: at +30m the
"risers" are dead tokens drifting up by fractions of a percent.

### For "rose ≥ 10%" — the noise-free version

| Cohort | Mark | Risers | Top features |
|---|---|---:|---|
| Combined | +30m | 28 ⚠️ | mcap 0.823, curve SOL 0.813, largest buy 0.802 |
| Combined | +1h | 29 ⚠️ | largest buy 0.844, mcap 0.842, curve SOL 0.838 |
| **Random** | **+30m** | **6** ⚠️ | curve SOL 0.791, initial mcap 0.734, unique buyers 0.730 |
| **Random** | **+1h** | **5** ⚠️ | curve SOL 0.834, has twitter 0.174*, initial mcap 0.663 |
| Graduates | +30m | 22 ⚠️ | unique buyers 0.640, trade count 0.640, buy/sell ratio 0.640 |
| Graduates | +1h | 26 ⚠️ | initial mcap 0.665, has twitter 0.373*, buyers/trade 0.622 |

⚠️ **Every cell has fewer than 30 risers.** The combined AUCs of 0.82–0.84 are
the three cohort-identifying features. The random-sample AUCs of 0.79–0.83 rest
on **six and five risers** respectively — one token moving changes them by ~0.1.

Note the direction reverses again here: at "rose ≥10%", curve SOL is *positive*
(0.791) for the random sample, having been *inverse* (0.359) for "rose at all".
Same feature, same cohort, same mark — opposite sign depending on where the
threshold sits. That is what a null result looks like when most of the outcome
variable is noise.

---

## 3. Best thresholds for the top 3 features (outcome: rose ≥ 10%)

### Random, +30m — 6 risers total ⚠️

| Feature | Cutoff | Side | n | % rose ≥10% | Median | p90 |
|---|---:|---|---:|---:|---:|---:|
| curve SOL | 0.0345 | above | 67 | 7% | −3.1% | +2.9% |
| | | other | 196 | 1% | −0.1% | +0.3% |
| initial mcap | 29.55 | above | 103 | 5% | −0.4% | +0.5% |
| | | other | 160 | 1% | −0.2% | +0.3% |
| unique buyers | 4 | above | 134 | 4% | −0.6% | +0.3% |
| | | other | 129 | 0% | −0.1% | +0.3% |

⚠️ "7% versus 1%" is **5 of 67 against 1 of 196**. Every cutoff has a negative
median on both sides.

### Combined, +30m — the cohort cutoff

| Feature | Cutoff | Side | n | % rose ≥10% | Median | p90 |
|---|---:|---|---:|---:|---:|---:|
| mcap (SOL) | **410.9** | above | 68 | 29% | +3.1% | +36.4% |
| | | other | 280 | 3% | −0.2% | +0.3% |
| curve SOL | 1.029 | above | 95 | 24% | −8.3% | +29.3% |
| | | other | 253 | 2% | −0.2% | +0.3% |
| largest buy (SOL) | 10 | above | 71 | 28% | +0.5% | +29.5% |

410.9 is the graduates' back-filled mcap. This is a cohort filter.

### Graduates, +30m

| Feature | Cutoff | Side | n | % rose ≥10% | Median | p90 |
|---|---:|---|---:|---:|---:|---:|
| unique buyers | 1 | above | 62 | 32% | +3.6% | +44.4% |
| | | other | 23 ⚠️ | 9% | −93.2% | −2.1% |

trade count and buy/sell ratio give an identical split — at the back-fill values
these three features are the same variable.

---

## 4. Features where the top quartile beats the bottom on BOTH % rising and median return

This is the condition you asked to have listed explicitly.

| Cohort | Mark | Feature | Q1 %rose / median | Q4 %rose / median | n Q1/Q4 |
|---|---|---|---:|---:|---:|
| Combined | +30m | buyers per trade | 29% / −0.5% | 45% / −0.2% | 87/87 |
| **Random** | **+30m** | **largest buy / curve** | 5% / −26.2% | 10% / −1.8% | **20/20** ⚠️ |
| **Random** | **+1h** | **largest buy / curve** | 0% / −27.4% | 16% / −2.2% | **18/19** ⚠️ |
| Graduates | +30m | initial mcap | 14% / −94.1% | **59% / +6.7%** | 21/22 ⚠️ |
| Graduates | +30m | buyers per trade | 14% / −93.2% | 55% / +4.7% | 21/22 ⚠️ |
| Graduates | +30m | largest buy / curve | 27% / −95.2% | **62% / +7.0%** | 15/16 ⚠️ |
| Graduates | +30m | largest buy (SOL) | 27% / −95.2% | 62% / +7.0% | 15/16 ⚠️ |
| Graduates | +30m | curve SOL | 14% / −93.2% | 45% / −5.9% | 21/22 ⚠️ |
| Graduates | +30m | mcap (SOL) | 14% / −93.1% | 45% / −5.9% | 21/22 ⚠️ |
| Graduates | +30m | trade / buy count, buy-sell ratio, unique buyers | 14% / −93.2% | 41% / −19.7% | 21/22 ⚠️ |
| Graduates | +1h | initial mcap | 11% / −95.0% | **58% / +10.0%** | 19/19 ⚠️ |
| Graduates | +1h | largest buy / curve | 14% / −96.0% | 53% / +6.7% | 14/15 ⚠️ |
| Graduates | +1h | largest buy (SOL) | 14% / −96.0% | 53% / +6.7% | 14/15 ⚠️ |
| Graduates | +1h | buyers per trade | 11% / −93.2% | 53% / +6.7% | 19/19 ⚠️ |
| Graduates | +1h | sell count / volume, unique sellers | 37% / −95.7% | 42% / −62.9% | 19/19 ⚠️ |

**Reading this honestly:**

- **Only one feature qualifies in the random sample: `largest buy / curve`**, at
  both +30m and +1h, and it is the one feature that has now appeared as
  directionally interesting in three separate analyses. **But n is 18–20 per
  quartile**, and Q4's "16% rose" at +1h is 3 tokens. Both medians are still
  negative — Q4 is −2.2%, merely less bad than Q1's −27.4%.
- **The combined entry (`buyers per trade`) has decent n (87/87)** but both
  medians are ≈ −0.3%, i.e. it separates nothing of magnitude.
- **Every graduate entry is the back-fill artifact.** Q1 medians of −93% to −96%
  against Q4 medians of +5% to +10% look dramatic, but the "5-minute feature"
  is the token's state at graduation, and the quartile boundaries in several
  cases are identical values (410.9 – 410.9). These rows describe which
  graduates were already large when adopted, not what was visible at 5 minutes.

---

## Conclusion

**Nothing at five minutes reliably predicts a rise, and the data cannot answer
the 2–3 hour version of the question at all.**

- **+2h (n=13) and +3h (n=5) are unreachable**, because tracking ends 60 minutes
  after a token's last trade and almost all stop trading within the hour.
- In the random sample, **6 tokens rose ≥10% at +30m and 5 at +1h**. Every AUC
  and every cutoff for that cohort rests on those.
- The combined table's strongest signals (AUC 0.80–0.84) are the three features
  that identify the graduate cohort at AUC 0.92–0.97, and its best threshold is
  the graduates' own back-filled median.
- Feature directions **reverse** between +30m and +1h, and between "rose > 0"
  and "rose ≥ 10%". Signals that flip sign under small changes of definition are
  not signals.

**The one thing worth revisiting** is `largest buy / curve SOL` — low buy
concentration, meaning many participants rather than one — which is the only
feature satisfying your condition inside the random sample, and which has now
surfaced in three analyses running the same direction. It needs roughly 30
tokens per quartile with a genuine ≥10% rise to be testable. At the current rate
that is not a matter of days.

**Two changes would make this answerable**, neither of which is waiting longer:

1. **Keep tracking tokens after they stop trading** — or record a final
   observation at each mark regardless — so +2h and +3h exist at all. Right now
   the outcome horizon is decided by the death rule, not by the window.
2. **Sample tokens that later graduate, before they graduate.** The graduate
   cohort has real rises to study and unusable features; the random cohort has
   real features and almost no rises. Nothing bridges the two.
