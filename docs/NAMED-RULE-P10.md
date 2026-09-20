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

---

# P11 — THE SCORE, STRIPPED TO WHAT IT ACTUALLY IS

Written 2026-09-19 during Part 11A, still **before** any launch after block
67,305,971 has been collected.

## The composite was never a five-feature model

Out-of-fold membership of the composite's top quintile agrees with this
two-condition rule on **256 of 260 trades (98%)**:

```
UNTOUCHED  =  n_sells == 0                                     (nobody has sold yet)
          AND eth_in_total <= 25th percentile of the training window
                                                               (~3.7 ETH in this era)
```

Everything else in the composite is redundant:

- `sold_115`, `largest_sell` and `n_sells` are **all exactly zero** in the top
  bucket, so within it they carry no information at all.
- `pool_eth` equals `eth_in_total` exactly whenever `n_sells == 0`, because
  `pool_eth` is net ETH flow and there are no outflows. They are the same number.
- Drop-one ablation: removing ANY single feature leaves rho at 0.236-0.264
  against the full 0.248, and dropping `eth_in_total` **improves** the dollar
  result to +$102.58. No feature is load-bearing.

## The plain rule

**Buy the launches where nobody has sold yet and total buying is still small.**

Measured on the full n=371 gated sample:

```
                                 n    median     mean    deep%
untouched (0 sells, low ETH)    62    +14.0%   +14.7%     3.2%
everything else                309     +6.1%    +0.4%    13.3%
```

**Essentially the entire edge of the §6P strategy lives in the 17% of launches
that are untouched at +115 s.** The other 83% have a mean of +0.4% before gas,
which is a loss after it.

## P11 as committed

```
SCORE        unchanged (kept only as the ranking device for the ladder)
LADDER       $5 / $10 / $15 / $20 / $25 by ascending score quintile
UNTOUCHED    the two conditions above, tested as a standalone statement
```

## Predictions on the fresh window, written before it exists

- `UNTOUCHED` launches are **15-20%** of gated launches.
- Their median return exceeds the whole-sample median by **at least 5 points**.
- Their deep-loss rate is **below 8%** but **NOT zero** — 0 of 39 will not repeat.
- The `UNTOUCHED` split reproduces at least as much separation as the full
  five-feature composite, because it is 98% the same rule.

## REFUTATION

1. `UNTOUCHED` median at or below the whole-sample median on fresh data.
2. `UNTOUCHED` deep-loss rate at or above the whole-sample rate.
3. `UNTOUCHED` share of gated launches outside 8-30% — that would mean the
   population shifted and the percentile cut is not measuring the same thing.
4. A fresh-window deep rate of exactly zero again in the top bucket. That is
   listed as a REFUTATION, not a success: it would indicate the outcome
   measurement cannot register a collapse in that subgroup, i.e. a defect.

## THE CUT, PINNED NUMERICALLY BEFORE THE FRESH WINDOW WAS READ

Computed on the old 371-launch training sample only, 2026-09-19, before any fresh
block was fetched:

```
eth_in_total 25th percentile = 3.6931 ETH        <- the UNTOUCHED threshold
```

On the training sample this selects **55 of 371 = 14.8%** of gated launches:

```
                        n    median     mean    deep%
training untouched     55    +13.8%   +14.6%     3.6%
training whole sample 371     +7.8%    +2.8%    11.6%
```

The fresh test uses **3.6931 ETH as an absolute number**, not a percentile
recomputed on the fresh window. Recomputing it there would let the threshold
chase the new data, and the pre-registered share check (8-30%) would then be
unable to detect a population shift — it would be guaranteed to pass by
construction.

---

# P12 — UNTOUCHED ON THE UNGATED POPULATION

Committed 2026-09-19, **before a single ungated launch has ever been priced.** No
entry or exit outcome exists for any launch with `creator_share < 40%` anywhere in
this project, so nothing below can have been chosen by looking.

## Why this is the test that matters

Every finding from §6I to §6U is conditioned on `creator_share >= 40%`. §6V.4
established that the 379 stored launches all sit between 0.4104 and 0.6416 — gate
1 was applied upstream when the sample was built. §6V.3 then measured that launch
type falling from 40% of the chain to 13% in under a day, with the gated rate
dropping 54.0 to 19.4 per day.

So either UNTOUCHED describes something about launches in general, or it
describes something about a launch type that is disappearing. **That is a binary
question and it has never been asked.**

## The rule under test — unchanged, not re-fitted

```
UNTOUCHED  =  n_sells == 0                  (nobody has sold by +115 s)
          AND eth_in_total <= 3.6931 ETH    (the cut pinned in P11, NOT recomputed)
ENTRY  +115 s      EXIT  +215 s     unconditional, as in §6P
```

The 3.6931 threshold is carried over as an **absolute number**. Recomputing a
percentile on the ungated population would let the cut chase the new data and
would make the population-shift check unfalsifiable.

## Predictions, in advance

- **Ungated launches are the majority.** 60-90% of canonical launches in the
  window fail gate 1.
- **UNTOUCHED will be RARER among ungated launches than among gated ones** —
  below 14.8%, plausibly far below. A low creator share means the creator did not
  buy much at block 0, which mechanically lowers `eth_in_total`, but such
  launches are also the ones that get sold into early. Direction is genuinely
  uncertain and this prediction is the weakest one here.
- **If UNTOUCHED is a general mechanism**: ungated + UNTOUCHED shows a median
  above the ungated median by at least 5 points, and a deep-loss rate below the
  ungated rate.
- **If gate 1 is load-bearing**: ungated + UNTOUCHED is indistinguishable from
  ungated + touched, and the strategy's addressable market is shrinking with no
  available substitute.

## REFUTATION of "UNTOUCHED is general"

1. `ungated + UNTOUCHED` median at or below `ungated + touched` median.
2. `ungated + UNTOUCHED` deep-loss rate at or above `ungated + touched`.
3. Fewer than 15 ungated UNTOUCHED launches priced — then the cell is too thin to
   claim anything in either direction, and that must be stated rather than
   papered over.

## Controls carried

- The **gated** arm is re-priced by the same code path in the same window, so any
  difference between gated and ungated cannot be an artefact of a different
  measurement.
- A **dead-pool check**: the fraction of returns that are exactly 0.000 is
  reported per cell. §6U.6 refuted that explanation on gated launches and it must
  be re-checked here, where low activity is the norm.
- Truncation is **reported, never silent**: if the compute ceiling stops the run,
  the number priced and the number left unpriced are both logged.
