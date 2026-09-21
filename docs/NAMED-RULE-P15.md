# NAMED RULE P15 — THE LIQUIDITY BAND

Committed 2026-09-21, **before scoring a single fresh launch.** P11 and the P14
variants stay on the record and keep being scored alongside this.

## The question this answers, and the answer is NO

"Is a looser rule with real volume a faster path to a proven strategy than waiting
on the strict one?" **Measured, in-sample, on 402 gated launches over 3.99 days:**

```
rule                          n     mean       sd   trd/day   n for t=2    DAYS
L0  gates only              402     1.8%    36.5%      69.0        1712    24.8
L1  + pool_eth >= 2.0       387     2.3%    36.9%      66.4        1071    16.1
L2  + n_sells <= 2          180     2.8%    32.6%      30.9         525    17.0
L3  + n_sells <= 5          258     1.7%    36.2%      44.3        1850    41.8
P11 UNTOUCHED (strict)       40    15.3%    22.6%       6.9           9     1.3
```

**Volume does not buy proof.** `n` for a given t scales with **(sd/mean)²**, and
the loose rules keep the same 36% standard deviation while their mean collapses
from 15.3% to under 3%. L0 needs **1,712 trades and 24.8 days**; the strict rule
needs 9. Loosening the rule made the sample slower to accumulate, not faster,
because it destroyed the effect faster than it added trades.

## 15B — THE 1 ETH FLOOR CANNOT BE TESTED ON THIS POPULATION, AND DOES NOT NEED TO BE

§6Z found every `pool_eth` band below 1 ETH had a win rate of 2% or less. Checked
across the full gated history, that finding **does not transfer**:

```
pool_eth deciles of GATED launches:
  0.01  2.84  3.53  3.66  3.70  3.79  3.92  4.04  4.17  4.41  6.14

gated with pool_eth < 1.0 :  13 of 402 (3.2%)
gated with pool_eth < 2.0 :  15 of 402 (3.7%)
band 0.5-1.0              :  RETURNED NO ROWS
```

**Gate 1 already removes the low-liquidity launches.** The §6Z dead zone was
measured over *all* launches, where the dust pools live; within the gated
population there is almost nothing below 2 ETH left to filter. This is why
`pool_eth >= 0.5` and `pool_eth >= 1.0` score **identically** (n=389 both) — the
band between them is empty.

**The §7 floor defect is therefore narrower than §6Z implied.** It matters only if
gate 1 is ever relaxed. It is not a source of edge within the gated population, and
§6Z.4's framing overstated its reach by generalising an all-population measurement
to the gated one.

## WHAT IS ACTUALLY THERE: AN UPPER BOUND

```
band     n     median     mean    win    deep       t
2-3     34     +10.3%    +9.3%    76%   17.6%   +1.14
3-4    223      +8.7%    +4.8%    80%    9.9%   +2.18
4-5    110      +1.0%    -3.2%    52%   12.7%   -0.81
5+      20      -8.5%    -8.3%    25%    5.0%   -1.38
```

**More ETH in the pool by +115 s is worse, not better.** This is the *same*
mechanism §6U.6 measured and not a new fitted quantity: ETH in the pool is buying
that has already happened, so a high value means the launch has been discovered and
we would be buying late in the demand curve. UNTOUCHED expressed it as "very little
buying"; this expresses it as "not yet a lot", which is the same axis relaxed.

## THE RULE

```
GATE 1     creator_share >= 40%
GATE 2     cumulative supply sold by +90 s < 25%
FLOOR      pool_eth >= 2.0 ETH      (safety only — 3.7% of gated; NOT a discriminator)
BAND       pool_eth <= 4.0 ETH      (the discriminator)
SELLS      n_sells <= 2  at +115 s  (relaxed from == 0)
ENTRY +115 s   EXIT +215 s   unconditional
```

In-sample: **n=133, median +9.0%, mean +7.9%, sd 29.4%, 22.8 trades/day, 55 trades
for t=2, 2.4 days.** Every figure in this section is in-sample and chosen on the
data it describes.

## PREDICTIONS, before any fresh launch is scored

- It fires on **15-35 launches/day**, an order of magnitude more than P11's current
  0/day, so a real sample accumulates within days rather than weeks.
- Its fresh mean is **positive but well below the in-sample +7.9%** — in-sample
  selection inflates it. Anything from +1% to +5% is consistent with the rule
  working.
- Its median exceeds the gated arm's (+5.6%) by at least 2 points.
- `pool_eth > 4` continues to underperform `2 < pool_eth <= 4`.

## REFUTATION — any one kills it

1. Fresh median at or below the gated arm's median at n >= 30.
2. Fresh mean <= 0 at n >= 50.
3. The `pool_eth > 4` arm matches or beats the in-band arm at n >= 50 — the
   discriminator is then not discriminating.
4. It fires on fewer than 5 launches/day, making it as unaccumulable as P11.

## THE WEAKNESS, STATED NOW

**The day-by-day split is converging.** Win rate, 2-4 ETH versus 4+:

```
day 0   2-4: 121 / 88% / +5.8%      4+:  51 / 41% / -12.7%
day 1   2-4:  76 / 79% / +6.7%      4+:  48 / 54% /  -0.8%
day 2   2-4:  13 / 69% / +2.6%      4+:  13 / 31% /  -3.1%
day 3   2-4:  47 / 62% / +3.1%      4+:  18 / 61% / +11.5%
```

The gap runs 47, 25, 38, then **1 point** — and on day 3 the out-of-band arm has
the *better* mean. On the most recent day of record this rule does not separate at
all. It is committed anyway, because the alternative is a rule that cannot
accumulate a sample, and because a converging split is exactly what a fresh test
exists to resolve. **If it is dead, it should die on fresh data in about three
days rather than on a judgement call now.**
