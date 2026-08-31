# Graduate price paths

Read-only analysis of the 132 `sample_reason = 'graduate'` tokens in
`pumpfun-early-window`, priced on `dex_price_usd`.

Queried from production **2026-08-25**. 131 of 132 have a usable DEX series
(≥2 points); median 57 points per token.

---

## Two measurement problems, and how the analysis works around them

Both were found while setting this up. They change what can be asked.

### The clock is anchored on the first DEX observation, not on graduation

`early_tokens.graduated_at − launched_at` is **not trustworthy**. Of 137
graduated tokens, **80 have an elapsed time of exactly 0 seconds**. Cross-
checking the same mints against `pump_launches`, which times them independently,
those tokens come back **negative** — −13s, −22s, −42s — meaning the migration
event was received before or alongside the create event.

| Source | p25 | Median | p75 | Max |
|---|---:|---:|---:|---:|
| `early_window` | 0s | **0s** | 215s | 3819s |
| `pump_launches` (same mints) | **−37s** | **−9s** | 215s | 3819s |

The two agree exactly whenever the value is positive, so this is an event-
ordering artifact on the feed, not a clock problem. Every path below is
therefore measured **from each token's first DEX price observation**, which is
unambiguous. That is the moment the token became observable on the AMM, and it
is a few minutes after the graduation instant, not the instant itself.

Observation span after that anchor: **median 55 min**, p25 53, p75 57, **max
60 min**.

### The 5-minute features do not exist for these tokens

A graduate is adopted *at* graduation, so it has no recorded history before that
moment. The tracker emits every past snapshot mark at once using the state at
adoption — so a graduate's "15s", "60s" and "300s" rows all carry the **same
adoption-time values**, labelled with earlier ages.

Confirmed across the whole cohort: **all 132 have exactly 1 distinct price
across every pre-300s snapshot.** Question 5 cannot be answered from this
monitor's own data, and is addressed with a different source below.

---

## 1. Return from the first DEX observation

| Mark | n | % positive | Median | p25 | p75 | p90 | Max |
|---|---:|---:|---:|---:|---:|---:|---:|
| +15m | **126** | 44% | **−28.7%** | −93.2% | +11.3% | +71.8% | **+2441.3%** |
| +30m | **120** | 41% | **−42.5%** | −95.4% | +16.0% | +63.8% | +433.8% |
| +1h | **41** | 37% | **−95.1%** | −98.2% | +15.3% | +45.1% | +325.3% |
| +2h | **0** | — | — | — | — | — | — |
| +3h | **0** | — | — | — | — | — | — |
| +6h | **0** | — | — | — | — | — | — |

⚠️ **+2h, +3h and +6h have zero eligible tokens.** No graduate has been observed
for more than 60 minutes past its first DEX price, because tracking runs six
hours from *launch* and these tokens are adopted well into that window. Those
three marks are not reachable by this monitor's current design, not merely
un-collected yet.

⚠️ **The +1h row is a different population, not a continuation.** Median span is
55 minutes, so only the longest-observed 41 tokens qualify — the ones that
graduated earliest in the collection window. The jump from −42.5% at +30m to
−95.1% at +1h is partly that selection, not purely decay.

The distribution is dominated by its tail at every mark: p25 around −95% while
p90 runs +45% to +72%, and one token returned **+2441%**.

---

## 2. Peak after graduation

Peak of the DEX series, measured from the first observation. **n = 131.**

| | Median | p25 | p75 | p90 | Max |
|---|---:|---:|---:|---:|---:|
| Peak return | **+13.1%** | 0.0% | +48.8% | **+139.9%** | **+2441.3%** |
| Time to peak | **5.2 min** | 0.0 min | 35.0 min | — | 56.0 min |

- Positive peak: **78 of 131**
- **Peaked at the very first observation — never rose at all: 53 of 131 (40%)**
- Peaked at the last observation (censored, may still be rising): 7 of 131

Half the cohort peaks within about five minutes of becoming tradeable. The 40%
that peak at entry never trade above it at any point observed.

---

## 3. Worst drawdown before the peak

How far the price fell below entry *before* reaching its peak. **n = 131.**

| Median | p25 | p75 | Worst |
|---:|---:|---:|---:|
| **0.0%** | 0.0% | 0.0% | **−53.6%** |

- **Never traded below entry before peaking: 114 of 131 (87%)**
- Sat through a drawdown worse than 50%: **2 of 131**

This is the one comfortable number here. For the large majority the peak — such
as it is — arrives before any meaningful drawdown, so holding to the peak
required sitting through nothing. That is mostly because the peak comes so early
(median 5.2 min); there is little time for a drawdown to develop first.

---

## 4. Best fixed exit

Buy at the first DEX price, sell after a fixed hold.

| Hold | n | % positive | Median | p25 | p75 | p90 |
|---|---:|---:|---:|---:|---:|---:|
| **+15m** | **126** | **44%** | **−28.7%** | −93.2% | +11.3% | +71.8% |
| +30m | **120** | 41% | −42.5% | −95.4% | +16.0% | +63.8% |
| +1h | **41** | 37% | −95.1% | −98.2% | +15.3% | +45.1% |
| +2h / +3h / +6h | 0 | — | — | — | — | — |

**The least bad hold is +15m** — the shortest one measurable — at a median of
−28.7% with 44% positive. Both median return and hit rate fall monotonically as
the hold lengthens.

⚠️ No hold tested is profitable at the median. The honest reading is that
shorter is better across the range available, and the range does not extend past
one hour. Nothing here identifies a *good* exit, only a least-bad one.

---

## 5. Do early features separate the graduates that went up?

**Not answerable at the required sample size.**

The monitor's own 5-minute features are back-filled at adoption (see above), so
they carry no information about the token's first five minutes.

Substituting `pump_launches`, which instrumented some of these mints genuinely
from t=0, leaves **25 tokens** with both real early curve data and a DEX series
— **below the 30 threshold**. Reported for direction only:

| Feature | AUC | n up | n down | Median up / down |
|---|---:|---:|---:|---|
| curve SOL @60s | 0.449 | 8 | 17 | 20.59 / 25.39 |
| trade count @60s | 0.438 | 8 | 17 | 62.0 / 90.0 |
| curve SOL @120s | 0.589 | 6 | 15 | 40.66 / 31.73 |
| trade count @120s | 0.378 | 6 | 15 | 79.5 / 146.0 |

⚠️ **n = 21–25. No conclusion drawn.** Every AUC sits between 0.38 and 0.59,
which is indistinguishable from chance at this size — but at this size almost
anything would be. Note the direction is if anything *inverse* for trade count:
tokens that went up had **fewer** early trades (79.5 vs 146.0 at 120s).

Only 31 of the 132 graduates were instrumented from t=0 by the other monitor, so
this cannot be enlarged from existing data — it needs the early-window monitor
to sample tokens *before* they graduate.

---

## 6. Time from launch to graduation

Using `pump_launches`' independent timing, restricted to the **56 of 132** with a
trustworthy positive elapsed time.

| Min | p25 | Median | p75 | p90 | Max |
|---:|---:|---:|---:|---:|---:|
| 34s | 161s | **358s (6.0 min)** | 1209s (20.1 min) | 2669s | 3819s (63.7 min) |

### Does faster graduation predict a better post-graduation return?

**The trend points the opposite way — slower graduation did better.**

| Time to graduation | n | Median peak | Median last | % ending up |
|---|---:|---:|---:|---:|
| < 3 min | **17** ⚠️ | 0.0% | −70.8% | **12%** |
| 3–10 min | **15** ⚠️ | 0.0% | −88.3% | 20% |
| 10–30 min | **14** ⚠️ | +96.5% | −43.6% | 36% |
| > 30 min | **9** ⚠️ | +47.2% | −33.1% | **44%** |

**AUC (time-to-graduation → ended above entry) = 0.667** (14 up, 41 down). Above
0.5 means *longer* time to graduation associates with going up.

⚠️ **Every band is below 30 tokens. No conclusion drawn.** What makes it worth
recording rather than discarding is that the ordering is monotonic across all
four bands on three separate measures — % ending up rises 12 → 20 → 36 → 44,
median last return rises −70.8 → −88.3 → −43.6 → −33.1 (one inversion), and
median peak rises from 0.0% to +96.5%. A single AUC on n=55 proves nothing; a
clean monotone trend is a reason to look again once n supports it.

If it holds up, it inverts the intuition the earlier analysis started from: a
token that took 20 minutes to grind to graduation did better afterwards than one
that got there in 90 seconds.

---

## Summary

| Question | Answer |
|---|---|
| 1. Path | −28.7% at +15m, −42.5% at +30m; +2h onward unreachable |
| 2. Peak | median **+13.1%** at **5.2 min**; 40% never rise above entry |
| 3. Drawdown | median **0.0%**; 87% never dip below entry before peaking |
| 4. Best exit | **+15m**, the shortest measurable — none profitable at the median |
| 5. Early features | **not answerable** (back-filled; substitute has n=25) |
| 6. Time to graduation | median **6.0 min**; slower graduation *may* do better (n<30) |

**Two changes would make the unanswerable parts answerable**, and neither is
about waiting longer:

1. **Track graduates for six hours from graduation, not from launch.** The
   window currently runs from launch, so a token graduating at minute 40 is
   observed for 5h20m of curve life and then dropped — which is why no graduate
   has more than 60 minutes of DEX history and +2h onward is empty.
2. **Sample tokens before they graduate.** Real early features exist only for
   the 31 that another monitor happened to instrument. Raising the random sample
   rate, or seeding the early-window sample from tokens showing early curve
   activity, would give genuine 5-minute data for far more of the eventual
   graduates.
