# NAMED RULE P14 — THE ROLLING ETH THRESHOLD

Committed 2026-09-21, **before scoring a single launch under it.** The static P11
result stays on the record as what it was; this does not replace or amend it.

## Why P11's threshold went inert

P11 fixed `eth_in_total <= 3.6931 ETH`, the 25th percentile of one window. §6Z.6
measured the population moving under it: median `eth_in` fell 3.648 -> 2.930 and
the cut went from passing 51% of gated launches to **100%**. A cut that passes
everything selects nothing.

## FINDING, BEFORE THE RULE IS BUILT: A 3-DAY ROLLING CUT IS ALSO INERT

The brief specified a trailing **3-day** window. Measured on 395 gated launches
over 3.96 days, that window does **not** fix the problem:

```
window   MIN_N   covered   thr min   thr max   pass mean   pass sd
6h           8       93%     2.653     4.478       26.0%     13.4%
12h         10       96%     2.804     4.119       23.6%     10.6%
24h         12       97%     2.981     4.006       27.3%     17.8%
48h         16       96%     3.109     3.904       31.0%     23.0%
72h         20       95%     3.622     3.805       27.3%     19.9%
```

**The 72-hour threshold moves between 3.622 and 3.805 — a range of 0.18 ETH, with
the static 3.6931 sitting inside it.** Its realised pass rate tracks the static
cut bucket for bucket, reaching **62%** in the most recent bucket exactly as the
static cut does.

The mechanism: `eth_in_total` has a structural lower mode near 3.5-3.7 ETH — the
creator's seed buy (§6W.2). A 25th percentile taken over three days sits on that
mode and is pinned there, while the population's **median** swings with the upper
tail. The percentile is anchored to a constant of the launch format, so a slow
window reproduces a constant.

**The test used is a mechanism test, not a return test.** A percentile cut has one
job: select a fixed fraction. If it tracks, the realised pass rate stays near 25%.
Pass-rate standard deviation across 6-hour buckets is the measure, and returns were
not consulted in choosing it. **This is still in-sample hyperparameter selection and
is labelled as such.**

## THE BINDING CONSTRAINT IS NOT THE ETH CUT

Of the 16 gated launches since the v2 restart, **zero have `n_sells == 0`**, so
**zero qualify under the static cut, the 72h rolling cut, or the 12h rolling cut
alike**. The share of gated launches with no sells by +115 s has fallen from 41%
early in the history to **0%** in the most recent buckets, with median `n_sells`
rising to 4.

**Changing the ETH threshold cannot restore `n`.** It is recorded here so that a
later reader does not attribute a recovery, or a continued drought, to this change.

## THE RULE — all three scored in parallel, no variant privileged

```
GATE 1     creator_share >= 40%
GATE 2     cumulative supply sold by +90 s < 25%
ZERO-SELLS n_sells == 0                               (unchanged, and binding)
FLOOR      pool_eth > 0                               (unchanged; §7 defect open)
ENTRY +115 s   EXIT +215 s                            (unchanged)

ETH CUT, scored THREE ways on every launch:
  P11   eth_in_total <= 3.6931                        (static, on the record)
  P14a  eth_in_total <= pct25(trailing 72h)           (as specified in the brief)
  P14b  eth_in_total <= pct25(trailing 12h)           (the window that tracks)
```

The percentile is computed over **GATED launches only** — the population the rule
selects within — and over launches **strictly earlier** than the one being
evaluated. A launch never contributes to the percentile that gates it.

**MIN_N: 20 gated launches for the 72h window, 10 for the 12h window.** If the
trailing window holds fewer, **the rule DOES NOT FIRE for that launch** and the
row records `null`, not a fallback. There is no silent constant: §7 records that
an error path emitting a plausible default is worse than a refusal. Coverage is
95% and 96% respectively on stored history, and the uncovered rows are the first
launches in the record, where no prior population exists.

The computed thresholds are logged every cycle.

## IN-SAMPLE BACKTEST — a sanity check on the mechanism, NOT evidence

395 gated launches, all priced. **Labelled in-sample; the rule was constructed
after seeing this data.**

```
                          n    median     mean      SUM    deep    win       t
STATIC 3.6931 (P11)      39    +14.1%   +14.9%    +5.82    2.6%    92%   +4.09
ROLLING 72h (P14a)       31    +17.3%   +18.5%    +5.74    0.0%    94%   +5.82
ALL GATED (the arm)     395     +5.4%    +1.4%    +5.60   10.9%    66%   +0.77

overlap 29    static only 10    rolling only 2
  static ONLY (72h rejects)   n=10  median  +6.5%  mean  +3.1%  deep 10.0%
  rolling ONLY (static rejects) n=2  median +11.6%  mean +11.6%  deep  0.0%
```

The two rules are 29/31 the same selection. **The backtest cannot distinguish
them** and is not offered as a reason to prefer either.

## PREDICTIONS, written before any launch is scored

- **P14b's realised pass rate among gated launches stays within 15-35%.** This is
  the rule's own definition working; if it drifts outside, the 12h window is also
  too slow and the whole rolling approach fails.
- **P14a's pass rate drifts outside that band**, tracking the static cut.
- **`n` does not recover from the ETH change.** Qualifier count stays driven by
  zero-sells, and all three variants fire at nearly the same rate.
- Where the variants disagree, **too few launches will separate them to matter**
  at any n reachable in days.

## REFUTATION

1. P14b pass rate outside 15-35% over any 50-gated-launch stretch -> the rolling
   mechanism does not track and P14 dies with P11.
2. P14a and P14b select the same launches on fresh data -> the window distinction
   is noise and the simpler P11 should stand.
3. Any variant's median at or below the gated-not-untouched arm at n >= 10.
4. A threshold computed from fewer than MIN_N ever being used -> an
   implementation defect, not a result.

## THE FAILURE MODE THIS RULE STILL HAS, STATED NOW

A percentile cut **always** passes 25% of the population by construction. It can
never go inert in the P11 sense, but it can go **meaningless**: if the quantity it
ranks stops relating to the outcome, the rule keeps selecting exactly 25% of
launches and those launches stop being better. The pass rate will look healthy
while the edge is gone. **The pass rate is therefore NOT evidence the rule works**
— only the return comparison against the gated arm is, and that needs n >= 10.
