# THE NAMED RULE — committed BEFORE it is scored on fresh data

**Committed 2026-09-19, Part 7 stage 1 → stage 2.**

This file exists so the rule below is timestamped in git **before** any out-of-sample
measurement is taken. §6N is the standard: picking a rule after seeing the holdout is
how every false positive in `LAUNCHBOT.md` was born, and the exploratory table that
suggested this one was computed over the WHOLE stored sample — so the stored sample can
no longer serve as a holdout for it.

## The rule

```
POPULATION   canonical Pools.trade launch
             (Initialize sharing a transaction with a TokenCreated from
              0x000000e200088d55c39a11f609e5f667729ad49b)

GATE 1       creator_share >= 40%        [pre-registered in §6I]
             = the creator's own launch-block buy, as a share of the 1e9 supply

GATE 2       cumulative supply SOLD by +90 s  <  25%
             read from the pool's own Swap logs at +90 s; strictly knowable to a live
             bot at that moment, and containing no information about the future

ENTRY        +115 s from the pool's initialization block
EXIT         +215 s  — a 100-second hold, unconditional
```

## Why these numbers and not others

- **Entry at +115 s, not +15 s.** §6O measured the first large sell landing at a median
  of 92 seconds. Entering after it means the one event that destroys the position has
  already happened, and §7 stage 1 measured it happening **twice in 379 launches
  (0.3%)** — once it is done it does not repeat.
- **Exit at +215 s.** The deep-loss rate is a monotonic function of holding time
  (0.0% at 15 s, 16.4% at 115 s, 25.9% at 215 s, 53.6% at 505 s, 80.5% at 20 min).
  Holding longer is strictly worse on this population, so the hold is short.
- **Gate 2 at 25% by 90 s.** §6O measured the deep losers' biggest single sell at 42.5%
  of supply against 6.2% for the rest; 25% sits between them and was not tuned.

## What would refute it

A held-out SUM at or below zero on a window the rule has never seen. Reported whatever
it says.

## What this rule is NOT

It is not §6I's rule, §6N's rule, or any exit rule from §6G–§6H. Those were entered at
+1 or +15 s and all failed. **The only thing carried over is GATE 1.**

---

# VARIANT v2 — committed 2026-09-19, UNTESTED on fresh data

Part 8B found a partial take-profit that improves the training figures. It is recorded
here **before** any out-of-sample test, so that if it is ever scored the commit predates
the scoring — the same discipline the base rule was held to.

```
IDENTICAL to the base rule, plus:
  sell 50% of the position the first time it is up +20% at or before the deadline
  the remainder ALWAYS sells at the deadline, +215 s, never extended
```

Training figures (n=317, exploratory): SUM 7.47 → **8.31**, win 69% → **71%**,
p10 −82.5% → −80.0%. Fires on **34.1%** of trades.

**This is a small improvement on a base whose own SUM §8A shows to be unstable, so it
should not be adopted before the base rule itself is established.** It is written down
only so that it is testable later without being a post-hoc choice.

**The measurement understates it.** Only four sample points sit inside the 100-second
window (115, 150, 190, 215 s); a live bot polling per block would fire the threshold more
often and earlier. The figure above is therefore a floor, not an estimate.

---

# PART 9 FILTER — committed 2026-09-19, BEFORE any out-of-sample score

Selected on the 317 training pools. The fresh §7 window (n=54) has **not** been touched
with these and is the holdout.

```
PRIMARY   "D"   ETH bought in the 90–115 s bucket  <=  0.20 ETH
SECONDARY "A"   zero SELLS in the 90–115 s bucket
```

Both are read at +115 s, immediately before entry, and applied **on top of** the base
rule (`creator_share >= 40%`, `sold-by-90s < 25%`, entry 115 s, exit 215 s).

## Why D is primary

- **A single condition**, so less to overfit than the conjunctions that scored similarly.
- **Best SUM on training (11.23 against a 7.47 baseline)** and **by far the best p10
  (−8.6% against −82.5%)** — the tail is what this whole pass is about.
- **Keeps 61% of trades**, more than any filter with a comparable SUM.
- The 0.20 threshold is the midpoint of the two measured medians (§6R.3: 0.280 for deep
  losers, 0.134 for the rest), not a swept value.

`A` is carried as a secondary because it needs **no threshold at all** — it is the least
overfittable thing in the candidate set.

## Training figures, and what I expect out of sample

| | kept | deep caught | winners kept | p10 | mean | SUM | win% |
|---|---|---|---|---|---|---|---|
| baseline | 100% | — | — | −82.5% | +2.4% | 7.47 | 69% |
| **D** | 61% | 67% | 64% | −8.6% | +5.8% | 11.23 | 73% |
| A | 51% | 62% | 57% | −33.9% | +10.0%* | 9.68 | 77% |

*\*A's +10.0% is its median; its mean is +6.0%.*

**WHAT I EXPECT ON THE HOLDOUT.** The deep-loss rate to fall from ~12% to roughly 5–8%,
the mean to be positive but **lower than training** — regression is the normal outcome
and these figures were selected on the data that produced them — and about half to
two-thirds of trades kept.

**WHAT WOULD REFUTE IT.** A held-out deep-loss rate at or above the unfiltered 12%, or a
SUM below the unfiltered baseline on the same trades.

**THE HOLDOUT IS THIN AND THAT IS STATED IN ADVANCE.** n=54 fresh trades, of which a
filter keeping ~60% leaves **~32**. That cannot establish anything; it can only fail to
contradict. The real test is still the accumulation §6Q.1 is waiting on.
