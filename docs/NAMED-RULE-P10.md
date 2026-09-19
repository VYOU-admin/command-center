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

---

# P10-v2 — THE REFINEMENT, COMMITTED BEFORE FRESH DATA EXISTS

Written 2026-09-19, after scoring P10-v1 out-of-time but **before collecting any
launch after block 67,305,971**, which is where the entire existing sample ends.

## What v1 showed, and why v2 differs

P10-v1's ladder gained $+83.49 over flat on 260 out-of-time trades (permutation
p = 0.0028, 9 of 10 folds positive). Decomposing that gain one lever at a time:

```
full ladder 5/10/15/20/25         $ +83.49
ONLY top quintile up ($25)        $ +65.42
ONLY bottom quintile down ($5)    $ -20.63     <- sizing the worst DOWN loses money
```

The relationship is not monotone. The bottom quintile's mean was +5.9%, better
than q2 (-6.2%) and q3 (+2.0%). **The composite finds a good top. It does not
find a bad bottom.** That is consistent with everything Part 9 established: the
deep loser is not identifiable at entry. What is identifiable is a subset that
is unusually clean — q5 had **0 deep losses in 39** against an 11.6% base rate
(exact binomial p = 0.0082).

## The v2 rule

```
SCORE   = - ( S_sell + S_size ) / 2                        unchanged from v1
SIZES   quintile 1..4  ->  $15          (flat, unchanged)
        quintile 5     ->  $25          (concentrate on the top only)
```

Quintile cutoffs are taken from the training window, never from the test rows.
No other change. Every launch is still traded; nothing is filtered.

## Predictions, written before the data exists

- Out-of-fold Spearman(SCORE, return) on fresh launches: positive, **+0.10 to
  +0.25**. Lower than 0.248 is expected and does not refute.
- Top-quintile mean return exceeds the whole-sample mean.
- Top-quintile deep-loss rate below the whole-sample rate, but **not zero** —
  0 of 39 will not repeat, and a repeat would be evidence of a defect, not of
  a stronger edge.
- v2 dollar P&L exceeds flat on the fresh sample.

## REFUTATION — any one kills it

1. Spearman(SCORE, return) <= 0 on the fresh sample.
2. v2 dollar P&L at or below flat on the fresh sample.
3. Top-quintile mean return at or below the whole-sample mean.
4. A permutation null on the fresh sample puts the observed delta inside its
   own p90 band.

## The test set

Every gated launch with `init_block > 67,305,971` — strictly after the last
launch in the existing 371. None of it has been looked at in any form. Roughly
two days of chain history at the measured ~48 gated launches/day, so n ≈ 90-100
with ~11 expected deep losers. Estimated cost ~41,000 CU ≈ $0.02.
