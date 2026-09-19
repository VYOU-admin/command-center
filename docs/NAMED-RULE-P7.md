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
