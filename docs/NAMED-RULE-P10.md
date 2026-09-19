# NAMED RULE — PART 10

Committed BEFORE being scored on any out-of-time data, per the standing rule.
Written 2026-09-19. Nothing below was chosen after seeing an out-of-time result.

## Provenance, stated honestly

The feature FAMILIES below were chosen by looking at a univariate Spearman screen
computed on the full n=371 gated sample — which includes the 54-launch §7 holdout.
**That is in-sample selection and it is a real leak.** It is disclosed rather than
hidden. The mitigations, and their limits:

- The screen carried an empirical multiple-comparison null (2000 shuffles of the
  outcome across the same 40 features): max |rho| under the null was 0.167 at p95.
  Only six features cleared it, and they fall into two economically coherent
  groups rather than being isolated winners.
- The signs were not chosen; all six are negative.
- The scoring protocol below is out-of-TIME, which is the thing that killed the
  Part 9 filter. A leak in family selection cannot manufacture temporal stability.

## The composites — fixed, unfitted, no free parameters

Percentile-rank each feature within the training window only (never using test
rows), then average. Higher composite = more of the thing.

```
S_sell  = mean pctrank of ( sold_115 , largest_sell , n_sells )
S_size  = mean pctrank of ( eth_in_total , pool_eth )
SCORE   = - ( S_sell + S_size ) / 2            higher SCORE = predicted better
```

Only features present for all 371 rows are used, so nothing is imputed.
`creator_share` is excluded despite clearing the bar: it is already the gate.

## CONTROL — carried through every comparison

```
SCORE_CTL = - ( pctrank(name_len) + pctrank(symbol_len) + pctrank(buyers_5s) ) / 3
```
Built from three features that scored |rho| <= 0.013 in the screen. If SCORE_CTL
beats flat sizing, the estimator is manufacturing structure and the whole table
is void.

## Validation protocol — rolling origin, fixed in advance

Sort all 371 by `init_block`. Initial training window = the first 30% (111
launches). Then 10 sequential test folds over the remaining 260. For each fold:
fit percentile ranks and any model coefficients on **everything strictly earlier**,
predict the fold, never look forward. Out-of-time predictions are produced for 260
launches containing roughly 30 deep losers — six times the event count the Part 9
holdout could offer.

## The sizing map — this is the deliverable, not a filter

Within each fold, rank by SCORE against the training-window distribution and assign:

```
quintile 1 (worst SCORE)  $5
quintile 2                $10
quintile 3                $15
quintile 4                $20
quintile 5 (best SCORE)   $25
```

Mean position $15. The flat comparator trades **every** launch at $15, so both
arms deploy the same expected capital on the same trades. Nothing is discarded —
this pass does not filter.

**Gas is charged at an absolute $0.193 per round trip on every trade in both
arms**, because that is what it is. A $5 position pays 3.86% in gas and this is
expected to hurt the size-weighted arm, not help it.

## What is predicted, in advance

- Out-of-fold Spearman between SCORE and realised return: positive, roughly +0.10
  to +0.20. Lower than the in-sample 0.19 because the in-sample figure is inflated.
- Size-weighted dollar P&L exceeds flat dollar P&L on the same 260 trades.
- The improvement comes from the MEAN, not from the deep-loss rate: the deep-loss
  rate in the bottom quintile should be only mildly elevated, because the six
  features correlate 0.08-0.13 with deep loss and 0.17-0.19 with the return.
- SCORE_CTL shows no improvement over flat.

## REFUTATION — stated before the result is seen

Any one of these kills it:

1. Size-weighted dollar P&L is at or below flat dollar P&L over the 260 out-of-time
   trades.
2. Out-of-fold Spearman(SCORE, return) <= 0.
3. SCORE_CTL also beats flat, by any margin. Then the machinery invents structure
   and neither result may be believed.

## NOT part of this rule

Creator launch history (family C) is excluded. It is a genuine in-sample finding
-- first-ever launches n=111 mean -0.8%, repeat launches n=206 mean +4.1% -- but
the 1016-launch creator-history table ends at block 66,439,983 and the holdout
era begins at 66,530,927, so every holdout launch would read `prior=0`. Scoring
it without a backfill would be a filter matching nothing. It is named here so
that if it is ever tested, it is on record as having been specified first.
