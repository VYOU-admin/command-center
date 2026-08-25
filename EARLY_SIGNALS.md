# Early launch features vs. outcomes — case-control

Read-only analysis of pump.fun launches instrumented from t=0. Queried from
production 2026-08-25. Data spans **2026-08-24 21:10 → 2026-08-25 04:34**
(7 hours 24 minutes).

---

## Before the results: three requested items do not exist

**1. Unique buyer count at 5 min — not computable, at all.**
The curve data comes from `accountSubscribe` on the bonding-curve account, which
returns *account state* (SOL reserves, token reserves, complete flag). It does
not carry the identity of who traded. No buyer wallet is stored anywhere in
`pump_curve_samples`. The only wallet in the dataset is the deployer, captured
from the create event. Recovering buyers would need transaction-level data — a
different source, not a different query.

**2. W2 (≥2× the 5-minute mcap at any later point) — zero computable cases.**
Observation stops when the subscription slot is recycled. Of 4,216 cohort
tokens, **16 have any sample past 300 s**, and **0 have a market cap value past
300 s** (the `mcap_sol` column was added part-way through collection, covering
82,900 of 136,558 samples). Median observation depth is **68 seconds**.

There is no "later point" in this dataset. W2 is reported as uncomputable rather
than substituted with a proxy, because any proxy would answer a different
question under W2's name.

**3. The 300-second feature marks — effectively empty.**
Only 16 tokens reach 300 s. All features below are reported at 30 s, 60 s and
120 s only.

---

## Cohort

| Group | n | Graduated | Rate |
| --- | ---: | ---: | ---: |
| `control` (15% random sample) | 1,191 | 16 | 1.34% |
| `mcap_above_default` (initial mcap > 32 SOL) | 3,025 | 52 | 1.72% |
| **Cohort total** | **4,216** | **68** | **1.61%** |

Both arms are instrumented from t=0 — the decision is made from the create event
itself, before any trading is observed. Zero tokens are pending; every one has
resolved to graduated or dead.

### Exclusions

| Excluded | n | Why |
| --- | ---: | --- |
| Not instrumented | 9,568 | No curve subscription, so no early features exist |
| `telegram`-instrumented | 162 | Instrumentation lags launch — see below |
| **Instrumented only after crossing 32 SOL** | **0** | **No such mechanism exists** |

⚠️ **The exclusion you asked for removes nothing, because the thing it targets
does not happen.** No code path instruments a token because it *crossed* 32 SOL
later. `mcap_above_default` is evaluated once, against the create event's
`marketCapSol` — the token was *already* above 32 SOL at birth. There is no
mid-life re-evaluation. So no case is selected on having risen.

The related risk is real but different, and it is why `telegram` is dropped:
that arm is instrumented only after a metadata HTTP fetch returns, so its
subscription starts late. First-sample timing by arm:

| Arm | Median first sample | p90 |
| --- | ---: | ---: |
| `control` | 0.21 s | 1.81 s |
| `mcap_above_default` | 0.21 s | 0.95 s |
| `telegram` | 0.87 s | **30.33 s** |

A p90 of 30 seconds means the 30-second feature would be missing or truncated
for a tenth of that arm. It contributed 0 graduates in any case.

**Cases = 68 graduates. Controls = 4,148 non-graduates.** That is ≥ 30, so W1
features are ranked.

---

## The validity problem, stated before any AUC

**Graduation is not a distant outcome. It is a three-minute event.**

Time from launch to graduation, for the 68 cohort graduates:

| Stat | Value |
| --- | ---: |
| Min | 4.4 s |
| p25 | 99 s |
| **Median** | **176 s** |
| p75 | 664 s |
| Max | 9,849 s |

| Already graduated by… | Cases |
| --- | ---: |
| 30 s | 3 of 68 |
| 60 s | 8 of 68 |
| 120 s | 22 of 68 |
| 300 s | 41 of 68 |

And the separation at 60 s is not subtle:

| Group | Median curve SOL at 60 s |
| --- | ---: |
| Graduates (n=68) | **43.6** |
| Non-graduates (n=4,148) | **0.40** |

Graduation happens at roughly 85 SOL. A graduate is already **halfway there at
one minute**. So these features are not forecasting a future state — they are
measuring a process already visibly underway, and for 8 of 68 cases the
60-second feature is recorded *after the outcome had already occurred*.

Every headline number below is therefore reported twice: once on the full
cohort, and once in a **strict** variant that drops any case which had already
graduated by the measurement mark. The strict numbers are the honest ones.

---

## W1 — graduated. Cases n = 68, controls n = 4,148

### Feature distributions and separation (full cohort)

Ranked by separation from AUC 0.5. An AUC below 0.5 means the feature predicts
in the *inverse* direction; the equivalent strength is `1 − AUC`.

| Rank | Feature | AUC | Case median | Control median | Case p75 |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | Trade count @120 s | **0.923** | 142.5 | 8.0 | 229 |
| 2 | SOL in curve @60 s | **0.912** | 43.58 | 0.40 | 62.14 |
| 3 | Trade count @60 s | **0.912** | 101.5 | 8.0 | 128 |
| 4 | SOL in curve @120 s | 0.905 | 47.75 | 0.04 | 85.01 |
| 5 | SOL in curve @30 s | 0.891 | 31.87 | 0.42 | 47.47 |
| 6 | Reached 25 SOL (0/1) | 0.873 | 1 | 0 | 1 |
| 7 | Trade count @30 s | 0.867 | 52 | 7 | 70 |
| 8 | Largest buy ÷ curve SOL | 0.138 → **0.862** inverse | 0.355 | 1.000 | 0.871 |
| 9 | SOL per trade @120 s | 0.843 | 0.26 | 0.0028 | 0.54 |
| 10 | SOL per trade @60 s | 0.843 | 0.40 | 0.03 | 0.58 |
| 11 | SOL per trade @30 s | 0.821 | 0.58 | 0.06 | 0.83 |
| 12 | Reached 50 SOL (0/1) | 0.815 | 1 | 0 | 1 |
| 13 | Largest single buy (SOL) | 0.809 | 16.15 | 6.97 | 23.84 |
| 14 | Reached 10 SOL (0/1) | 0.754 | 1 | 0 | 1 |
| 15 | Deployer prior launches | 0.373 → **0.627** inverse | 0.5 | 5.0 | 9.0 |
| 16 | Initial mcap (SOL) | 0.570 | 33.92 | 33.83 | 38.06 |
| 17 | Deployer prior graduations | 0.543 | 0 | 0 | 0 |
| 18 | Has website | 0.526 | 0 | 0 | 1 |
| 19 | Has telegram | 0.492 | 0 | 0 | 0 |
| 20 | Has twitter | 0.476 | 1 | 1 | 1 |

**Largest buy ÷ curve SOL** required correcting mid-analysis. My first pass
divided by the *last observed* SOL, which collapses toward zero for a token that
pumped then dumped — producing a control median of 692, an impossible "share".
Using curve SOL at 120 s as the denominator and capping at 1.0 gives the number
above. **2,245 of 4,216 tokens (6 of them cases) have a denominator below
0.1 SOL and no defined share** — those are tokens whose curve is essentially
empty. So that row is computed on n=62 cases and n=1,909 controls, not the full
cohort.

Read plainly: for a typical *control*, the single largest buy **is the entire
curve** (share 1.000) — one buy, then nothing. For a typical graduate it is 35%
— many participants contributed. That is a concentration signal, and it is one
of the few here that is not simply "how much SOL is in the curve".

### Conditional features — time and trades to reach a level

These are defined only for tokens that actually reached the level, so both n's
shrink and the comparison changes meaning.

| Feature | AUC | Cases (n, median) | Controls (n, median) |
| --- | ---: | --- | --- |
| Seconds to 10 SOL | 0.472 | 61, 0.28 s | 1,610, 0.37 s |
| Trades to 10 SOL | 0.486 | 61, 1 | 1,610, 1 |
| Seconds to 25 SOL | 0.426 | 57, 3.48 s | 384, 7.19 s |
| Trades to 25 SOL | 0.411 | 57, 6 | 384, 12 |
| Seconds to 50 SOL | 0.535 | 44, 34.0 s | 69, 25.4 s |
| Trades to 50 SOL | 0.525 | 44, 49.5 | 69, 40 |

⚠️ **Among tokens that reached a level, how fast or in how few trades they got
there separates almost nothing** — every AUC sits between 0.41 and 0.54. The
strongest is trades-to-25-SOL at 0.411 (inverse 0.589), which is weak. The
discriminating information is in *whether* a token reached the level at all
(AUC 0.754–0.873), not in the manner of getting there.

This is worth noting because it is the opposite of what the velocity thresholds
were built to capture.

### Strict variant — cases that had already graduated are removed

| Mark | Cases dropped | Cases left | Top features (AUC) |
| --- | ---: | ---: | --- |
| 30 s | 3 | **65** | SOL 0.886 · trades 0.869 · SOL/trade 0.814 · largest buy 0.802 |
| 60 s | 8 | **60** | trades 0.923 · SOL 0.916 · SOL/trade 0.841 · largest buy 0.795 |
| 120 s | 22 | **46** | trades 0.931 · SOL 0.902 · SOL/trade 0.829 · largest buy 0.772 |

The separation survives the correction — it is not purely an artifact of
already-graduated tokens. At 30 seconds, with only 3 cases removed and 65
remaining, SOL in curve still separates at 0.886.

But note what "prediction" means at this horizon: a 30-second lead time on an
event whose median is 176 seconds.

---

## W2 — reached ≥2× its 5-minute mcap at any later point

**Cases: 0. Controls: 0. Not computable.**

Not "no effect found" — the measurement does not exist. 0 of 4,216 tokens have a
market-cap value recorded past 300 seconds, and only 16 have any sample at all
past 300 seconds. Both the baseline (5-minute mcap) and the comparison (any
later point) fall outside the observation window.

No features are ranked on W2.

---

## W3 — graduates in `solana_tokens`: peak mcap vs mcap at graduation

**n = 66** of the 68 cohort graduates entered `solana_tokens` and have
observations. That is ≥ 30, so it is reported — but the measure itself is too
thin to rank features on, for reasons below.

| Measure | Value |
| --- | ---: |
| Observations per token — median | **4** (p25 3, p75 5, max 8) |
| Peak ÷ first mcap — median | **1.00** |
| Peak ÷ first mcap — p75 | 1.00 |
| Peak ÷ first mcap — max | 2.58 |
| Tokens reaching ≥1.5× | **4 of 66** |
| Tokens reaching ≥2.0× | **3 of 66** |

Two caveats that matter more than the numbers:

1. **"Mcap at graduation" is not recorded.** `solana_token_observations` stores
   USD market cap; the pump.fun side stores SOL-denominated market cap, and only
   for instrumented tokens. The ratio above uses the *first* solana observation
   as a proxy for graduation-time mcap. Those are not the same instant — the
   solana monitor polls hourly, so the first observation can be up to an hour
   after graduation.

2. **A "peak" over a median of four hourly observations is not a peak.** With
   p25 = 3 observations, this is measuring the maximum of three or four points
   spanning a few hours.

What the numbers do say: a median ratio of exactly **1.00** means that for most
graduates, the first observation *is* the highest one seen. They are flat or
declining from the moment the solana monitor picks them up. Only 3 of 66
doubled.

**No feature ranking is performed on W3** — not for lack of cases, but because
the outcome variable is a maximum over three-to-five hourly points against a
proxy baseline. Ranking features against it would give numbers that look like
results and are not.

---

## Chronological split — fit on older 70%, report held-out 30%

| Split | n | Cases | Window |
| --- | ---: | ---: | --- |
| Train (older 70%) | 2,951 | **48** | 21:10 → 02:26 |
| Test (newer 30%) | 1,265 | **20** | 02:26 → 04:34 |

Split boundary: 2026-08-25 02:26:06 by `launched_at`. No token appears in both.

### Single features — train vs. held-out AUC

| Feature | Train AUC | **Held-out AUC** |
| --- | ---: | ---: |
| Trade count @120 s | 0.913 | **0.948** |
| Trade count @60 s | 0.901 | **0.939** |
| SOL in curve @120 s | 0.900 | **0.916** |
| SOL in curve @60 s | 0.881 | **0.988** |
| SOL in curve @30 s | 0.856 | **0.975** |
| Trade count @30 s | 0.850 | **0.910** |
| Reached 25 SOL | 0.850 | **0.929** |
| SOL per trade @120 s | 0.840 | **0.855** |
| SOL per trade @60 s | 0.816 | **0.909** |
| Reached 50 SOL | 0.814 | **0.817** |
| SOL per trade @30 s | 0.793 | **0.890** |

### Combined model — logistic regression, 8 features

Fit on train only, standardised, 4,000 gradient-descent epochs. Features:
`sol_60, tr_60, spt_60, max_buy, initial_mcap, reached_25, tg, tw`.

| | AUC |
| --- | ---: |
| Train (in-sample — **not a result**) | 0.947 |
| **Held-out (n = 20 cases, 1,245 controls)** | **0.983** |

⚠️ **The held-out AUC is higher than the training AUC, on every single feature
as well as the model.** That is not a sign of a good model. With **20 positive
cases** in the test set, the AUC's sampling variance is large — one or two
tokens moving changes it by several points. The consistent direction across all
eleven features also suggests the later window happened to contain
cleaner-separating cases, not that the model generalises unusually well.

Treat 0.98 as "somewhere in the high 0.8s to high 0.9s, measured on 20 events".

---

## What this does and does not support

**Supported:**

- Early curve activity separates graduates from non-graduates strongly and
  consistently — AUC 0.87–0.93 in-sample, holding up on a chronological holdout
  and surviving removal of already-graduated cases.
- **Trade count and curve SOL are the top features at every mark.** They are
  near-interchangeable (both ≈0.91 at 60 s) and largely measure the same thing.
- **Buy concentration is a genuinely distinct signal.** Controls' largest single
  buy is typically 100% of their curve; graduates' is 35%. This is not a
  restatement of "more SOL".
- **Serial launchers do worse.** Deployer prior-launch count runs *inverse*
  (AUC 0.373): case median 0.5 prior launches, control median 5.0.
- **Socials carry no signal here.** Telegram 0.492, Twitter 0.476, website
  0.526 — all indistinguishable from a coin flip.
- **How fast a token reached a SOL level does not separate** among tokens that
  reached it (all AUCs 0.41–0.54). Only *whether* it got there matters.

**Not supported:**

- Anything about W2. The data does not exist.
- Feature ranking on W3. The outcome is a max over 3–5 hourly points against a
  proxy baseline.
- Any precise reading of the held-out AUC. Twenty cases.
- **That these are "predictive" features in a useful sense.** Median time to
  graduation is 176 seconds. A feature measured at 60 seconds leads the outcome
  by under two minutes for half the cases, and *trails* it for 8 of 68.
- **Deployer history as a real feature.** The launch table starts 2026-08-24
  21:10, so "prior launches" means "launches within the past few hours", not a
  career record. Control median of 5 prior launches in a 7-hour window is a spam
  rate, not a track record. Prior *graduations* are near-zero for everyone
  (AUC 0.543) purely because the window is too short to contain any.

**The binding constraint is elapsed time, not method.** Seven hours of
collection gives 68 cases and a deployer history too short to be a history. The
W2 gap is different in kind — it needs the observation window extended past
5 minutes, which is a configuration change, not patience.
