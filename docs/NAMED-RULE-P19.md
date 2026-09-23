# NAMED RULE P19 — FOLLOW THE FOUR

Committed 2026-09-23, **before the tracker has scored a single buy.** Everything
below is fixed in advance because the four wallets were chosen IN-SAMPLE in §6AI.5,
on the same data that measured them. This tracker is the out-of-sample test.

## The four, and why these four

Selected on realised P&L with >=40 closed positions and a POSITIVE median return
(§6AH.2, §6AI.5). **Not** on volume, and **not** on our own wallet score.

```
0x0b30d99a8b5b92c302ef0df8c9068338ce46c801   65 closed  win 80%  medRet +8.9%
0x008bac045a4220bf6755564c5ea2e1b271eb670f   41 closed  win 63%  medRet +8.1%
0x91dc0fbd6d30783abea7291b512bfe59d2294a3c   60 closed  win 68%  medRet +4.2%
0xe5239c5bcdb8e9bf55322dae843c72d46f60b66c   84 closed  win 57%  medRet +5.0%
```

**`0x0b30d99a` has not bought since 2026-09-17** — six days silent at the time of
writing. It stays in the list because removing it now would be selecting on
post-selection behaviour, but a wallet contributing nothing is recorded as
contributing nothing.

## TWO ENTRY LAGS, AND THIS IS THE POINT OF THE TRACKER

§6AH.3 measured the signal decaying fast: +4.24% median one minute after their buy,
+2.79% at five, **+0.17% at fifteen**, negative at sixty.

`watchlist-watch` runs **every 30 minutes** (confirmed from `monitors.schedule_ms`),
so **today's detection lag is 0-30 minutes, median ~15.** That is exactly where the
signal has already decayed to nothing.

So both are tracked on every buy:

```
LAG_FAST   300 blocks  (~30 s)   requires direct chain polling that does NOT exist
LAG_SLOW  9000 blocks  (~15 min)  the median lag of today's infrastructure
```

**If FAST is profitable and SLOW is not, the answer is "build the poller".
If neither is, the answer is "stop".** No other outcome needs interpreting.

## What is measured

For each buy by one of the four, at each lag: simulate OUR OWN $100-notional round
trip. Entry is a quote at the entry block; every exit is a **reachable-bound**
`simulateSellAt` (§6A.3), never a mid price. Horizons from entry:

```
+5 min    +15 min    +1 hour    +24 hours
```

A position that cannot be sold is **-100%**, never 0%.

## Predictions, written before any data

- **FAST +5 min: positive median, but well below the in-sample +2.79%.** Anywhere
  from +0.5% to +2% is consistent with the effect being real.
- **SLOW +5 min: indistinguishable from zero.** This is the prediction the tracker
  exists to test.
- **+24 h at either lag: negative median.** §6AG measured the +5m->+24h leg at a
  -3.4% median and a -31.6% mean across 255 tokens.
- **Trackable volume: 20-45 new positions/day** across the four, against the
  measured 35.1/day over the last seven days.
- Per-position median return is small and the distribution is right-tailed, as
  §6AH.2 measured (median -0.1%, profit in the tail). **A positive median is NOT
  expected at every horizon.**

## REFUTATION — any one ends it

1. Median return <= 0 at EVERY horizon, at both lags, with n >= 50 positions.
2. FAST and SLOW are indistinguishable at n >= 50 — then the lag does not matter,
   there is nothing to build, and the §6AH.3 decay curve was an artefact of
   measuring price from other watchlist wallets' trades.
3. Fewer than 5 trackable positions/day sustained over a week — unfollowable
   regardless of edge.
4. More than 30% of entries unpriceable. That is a plumbing failure and must be
   reported as one, NOT as a result.

## Deliberately NOT in this rule

- **No exit rule is copied from the four.** §6AI.2 measured them having no exit
  alpha: the median price five minutes after they sell is 0.00% and rises half the
  time. Fixed horizons are used instead, and the horizon grid is the finding.
- **No position sizing, no live trading.** This writes rows and nothing else.
- **No filter on which of their buys to follow.** Every buy is tracked. Filtering
  would be a second in-sample selection layered on the first.
