# Exit rules under realistic fills

Sensitivity re-run of the top rules from `EXIT_RULES.md`. Same 131 graduates,
same entry (first DEX observation), same costs (0.5% slippage each way + 1%
round-trip fee).

**The headline: the positive results in `EXIT_RULES.md` were an artifact of the
stop-fill assumption. They do not survive.**

---

## 1. Stop fill model

Three ways to fill a stop, from optimistic to realistic:

- **A — at the stop level.** What `EXIT_RULES.md` assumed: a −20% stop fills at
  exactly −20%.
- **B — at the breach price.** Fill at the observed price that broke the stop.
- **C — at the next observation.** Fill one bar later, modelling a poll-and-act
  delay. This is the literal reading of "next observed price after the breach".

Take-profit still fills at the trigger level in this table, so only the stop
assumption changes.

| Rule | Limit | % stop | **A: at level** | **B: breach px** | **C: next obs** | C − A |
|---|---|---:|---:|---:|---:|---:|
| TP+100%/−20% | 15m | 52% | **+286%** | −2924% | **−2924%** | −3210% |
| TP+100%/−20% | 30m | 58% | **+545%** | −2874% | **−2871%** | −3416% |
| TP+100%/−20% | 60m | 61% | **+754%** | −2847% | **−2907%** | −3661% |
| TP+50%/−20% | 15m | 49% | −87% | −3162% | −3162% | −3076% |
| TP+50%/−20% | 30m | 54% | +32% | −3252% | −3249% | −3281% |
| TP+50%/−20% | 60m | 56% | +264% | −3187% | −3247% | −3511% |

**Every rule goes from strongly positive to roughly −3,000%.** B and C are almost
identical, so the delay is irrelevant — what matters is that you fill at a real
observed price rather than at the level you nominated.

### Why: realised slippage is enormous

How far past −20% the fill actually lands:

| Rule | Limit | Stops | Median slip | p25 | Worst |
|---|---|---:|---:|---:|---:|
| TP+100%/−20% | 15m | 68 | **−52.5pp** | −73.4pp | −80.0pp |
| TP+100%/−20% | 30m | 76 | **−50.5pp** | −73.4pp | −80.0pp |
| TP+100%/−20% | 60m | 80 | **−51.2pp** | −74.3pp | −80.0pp |
| TP+50%/−20% | 15m | 64 | −53.8pp | −73.5pp | −80.0pp |
| TP+50%/−20% | 30m | 71 | −51.8pp | −74.3pp | −80.0pp |
| TP+50%/−20% | 60m | 74 | −53.8pp | −74.7pp | −80.0pp |

A "−20% stop" fills at about **−72%** at the median, and at −80% in the worst
cases. With 5-minute bars there is no price between −20% and −72% to fill at —
the token simply is not there any more when you next look.

---

## 2. Stop slippage sweep

Fill at the stop level minus N percentage points. Net total return:

| Rule | Limit | 0pp | 5pp | 10pp | 20pp | 30pp | **Goes negative at** |
|---|---|---:|---:|---:|---:|---:|---|
| TP+100%/−20% | 15m | +286% | −48% | −381% | −1047% | −1714% | **~4.3pp** |
| TP+100%/−20% | 30m | +545% | +173% | −200% | −945% | −1689% | **~7.3pp** |
| TP+100%/−20% | 60m | +754% | +362% | −30% | −814% | −1598% | **~9.6pp** |
| TP+50%/−20% | 15m | −87% | −400% | −714% | −1341% | −1969% | already negative |
| TP+50%/−20% | 30m | +32% | −316% | −664% | −1360% | −2056% | ~0.5pp |
| TP+50%/−20% | 60m | +264% | −99% | −462% | −1187% | −1912% | ~3.6pp |

**The best rule tolerates 9.6 percentage points of stop slippage. Section 1
measures the actual figure at 51 percentage points.**

The sweep does not even reach the realised value. Extending it to 30pp still
understates reality by more than 20pp.

---

## 3. Take-profit fill model

The same gapping that destroys stops *helps* take-profits — when a token crosses
+100%, the next observed price is often far above +100%.

| Rule | Limit | %TP | A: at level | B: breach px | C: next obs | C − A |
|---|---|---:|---:|---:|---:|---:|
| TP+100%/−20% | 15m | 8% | +286% | +3486% | +3379% | +3093% |
| TP+100%/−20% | 30m | 14% | +545% | +4206% | +4098% | +3553% |
| TP+100%/−20% | 60m | 15% | +754% | +4425% | +4318% | +3564% |
| TP+50%/−20% | 15m | 15% | −87% | +3720% | +3756% | +3843% |
| TP+50%/−20% | 30m | 19% | +32% | +4300% | +4336% | +4304% |
| TP+50%/−20% | 60m | 21% | +264% | +4553% | +4563% | +4299% |

⚠️ **This table is not a result — it is the mirror of the error in section 1.**
Applying realistic fills to the stop while keeping optimistic fills on the
take-profit gives −3,000%. Applying realism to the take-profit while keeping the
stop optimistic gives +4,400%. Neither is meaningful. **The fill assumption has
to be symmetric**, which is section 3b.

### 3b. Both sides realistic

Stop and take-profit both fill at the next observation — the only internally
consistent model, and the honest one: you can trade only at prices you actually
see.

| Rule | Limit | **Net total** | Net median | vs optimistic |
|---|---|---:|---:|---:|
| TP+100%/−20% | 15m | +169% | −24.3% | −117% |
| TP+100%/−20% | 30m | +682% | −30.2% | +137% |
| TP+100%/−20% | 60m | +657% | −34.7% | −97% |
| TP+50%/−20% | 15m | +680% | −10.0% | +767% |
| **TP+50%/−20%** | **30m** | **+1055%** | −26.8% | +1023% |
| TP+50%/−20% | 60m | +1052% | −30.2% | +788% |

Positive again — the take-profit gains offset the stop losses. But see below.

---

## The finding that decides it

Every positive number in section 3b is **the same single token**.

| Rule (both sides realistic) | Net total | Winners | Best trade | **Ex-best** | Ex-top-3 |
|---|---:|---:|---:|---:|---:|
| TP+100%/−20% / 15m | +169% | 54/131 | **+2193%** | **−2025%** | −2913% |
| TP+100%/−20% / 30m | +682% | 51/131 | **+2193%** | **−1511%** | −2399% |
| TP+100%/−20% / 60m | +657% | 48/131 | **+2193%** | **−1536%** | −2425% |
| TP+50%/−20% / 15m | +680% | 58/131 | **+2193%** | **−1513%** | −2401% |
| TP+50%/−20% / 30m | +1055% | 56/131 | **+2193%** | **−1139%** | −2027% |
| TP+50%/−20% / 60m | +1052% | 54/131 | **+2193%** | **−1142%** | −2030% |
| buy & hold 30m | −926% | 52/131 | +2321% | −3247% | −3987% |
| buy & hold 60m | −2435% | 45/131 | +2321% | −4756% | −5396% |

The best trade is **+2193% in every row** — one token, the same one that carried
buy-and-hold in `EXIT_RULES.md`. Remove it and **every rule loses between
−1,139% and −2,025%**. Remove the top three and every rule is below −2,000%.

Note what the take-profit did *not* do here: under the "at level" model a TP+100%
capped each winner near +96%, which is why that model looked robust. Under
realistic fills the cap does not bind — the token gapped straight past +100% to
+2193% between two observations, so the take-profit sold at whatever was on the
screen five minutes later. **The apparent robustness of the take-profit was
itself an artifact of the same optimistic fill assumption.**

---

## 4. Split by graduation time

131 of 131 have a graduation timestamp. Split at the median:

- **First half:** n=65, graduating 06:54 → 09:40 UTC
- **Second half:** n=66, graduating 09:44 → 11:44 UTC

TP+100% / stop −20%, under both fill models:

| Half | Limit | n | %TP | %stop | Optimistic total | **Realistic total** | Realistic median |
|---|---|---:|---:|---:|---:|---:|---:|
| first | 15m | 65 | 6% ⚠️ | 51% | +112% | **+1087%** | −25.0% |
| first | 30m | 65 | 14% ⚠️ | 55% | +267% | **+1451%** | −26.8% |
| first | 60m | 65 | 14% ⚠️ | 57% | +378% | **+1484%** | −30.0% |
| second | 15m | 66 | 11% ⚠️ | 53% | +174% | **−918%** | −23.7% |
| second | 30m | 66 | 14% ⚠️ | 61% | +278% | **−769%** | −34.6% |
| second | 60m | 66 | 15% | 65% | +376% | **−827%** | −36.0% |

⚠️ Fewer than 10 take-profit hits in that half.

**The optimistic model shows the two halves as near-identical (+378% vs +376% at
60m). The realistic model shows +1,484% against −827%.** The optimistic fill
assumption was concealing complete instability across time.

And the split is explained entirely by which half contains the one token:

| | Net total | Best trade | **Ex-best** |
|---|---:|---:|---:|
| first half, TP+100%/−20%/30m | +1451% | **+2193%** | **−742%** |
| first half, TP+50%/−20%/30m | +1639% | +2193% | −554% |
| second half, TP+100%/−20%/30m | −769% | +598% | −1367% |
| second half, TP+50%/−20%/30m | −585% | +598% | −1183% |

The first half is profitable because the +2193% token graduated at 08:02. Remove
it and the first half loses −742%, which is the same order as the second half's
−769%. **The two halves are not different; one of them contains the lottery
ticket.**

---

## Conclusions

1. **The results in `EXIT_RULES.md` do not survive realistic fills.** The
   positive net totals depended on stops filling at the stop level. Filling at
   an observed price instead moves every rule from about +500% to about −3,000%.

2. **Realised stop slippage is around 51 percentage points at the median** —
   a −20% stop fills near −72%. The rules break at 4–10 percentage points, so
   they fail by roughly a factor of five. With 5-minute price resolution there
   is no price in between to fill at.

3. **Fill assumptions must be applied to both sides at once.** Realistic stops
   with optimistic take-profits gives −3,000%; the reverse gives +4,400%. The
   gap between those two numbers is entirely assumption, not data.

4. **Under the symmetric realistic model, nothing is profitable without one
   token.** Every rule shows the same +2193% best trade and every one loses
   −1,100% to −2,000% once it is removed. That includes the rule that looked
   most robust in `EXIT_RULES.md`, whose apparent robustness came from a
   take-profit cap that does not bind under realistic fills.

5. **The time split confirms it.** First half +1,484%, second half −827%, on a
   model that showed them as identical before. Removing the single token from
   the first half leaves −742%, statistically the same as the second half.

**What would actually be needed to test these rules:** per-trade price data
rather than 5-minute snapshots. Every problem above traces to the same source —
between two observations a token can move 50 percentage points, so neither a
stop nor a take-profit can be modelled at all. The `pumpfun-early-window`
monitor already decodes every individual trade for curve-phase tokens; the
equivalent for post-graduation AMM trades would make this answerable. Until
then, no exit rule can be evaluated on this data, in either direction.
