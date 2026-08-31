# Take-profit backtest — graduates

Read-only backtest over the 131 `sample_reason = 'graduate'` tokens in
`pumpfun-early-window` that have a usable `dex_price_usd` series (≥2 points).

Entry = each token's **first DEX observation**. Every rule walks the series
forward and exits at whichever comes first: take-profit, stop, or time limit.

---

## Method, and four things that constrain it

**Costs.** 0.5% slippage on entry, 0.5% on exit, 1% round-trip fee, applied
multiplicatively: `net = (exit × 0.995) / (entry × 1.005) × 0.99 − 1`. Roughly
2% per round trip.

**Fills.** A take-profit or stop fills at **the trigger level**, not at the
observed price. A limit order at +25% fills at +25% even if the price gapped to
+60% between observations. Timeouts fill at the observed price. This is the
conservative choice and it matters a lot here, because:

⚠️ **The price series is 5-minute bars.** The DEX price refreshes on a 300-second
cadence — median, p25 and p75 of the gap between price *changes* are all exactly
300s. Median 9 distinct prices per token. Two consequences:

- Triggers can only be detected at 5-minute boundaries, so any spike that hit a
  target and reverted inside a bar is invisible. **% hitting TP is understated.**
- A 5-minute time limit permits exactly **one** price check after entry.

⚠️ **The 60-minute limit is never actually reached.** Zero of 131 series span 60
minutes (median 55, max 60). Every "60m" trade exits at the end of available
data, around 55 minutes. Read that row as *hold to end of observation*.

⚠️ **Stops are assumed to fill at the stop price.** In a market this thin they
would slip further. Every stop-loss row is therefore optimistic.

Series reach: 5m → 130/131 tokens, 15m → 125, 30m → 119, 60m → 0.

---

## Baseline to beat — buy and hold

| Hold | n | Net median | Net mean | **Net total** | Gross total |
|---|---:|---:|---:|---:|---:|
| **5m** | 131 | −2.0% | **+13.5%** | **+1765%** | +2066% |
| 15m | 131 | −28.1% | −0.8% | −108% | +155% |
| 30m | 131 | −40.1% | −7.1% | −926% | −679% |
| 60m | 131 | −86.1% | −18.6% | **−2435%** | −2219% |

"Net total" is the sum of per-trade net returns at equal size — equivalently,
mean × 131. Holding longer is monotonically worse.

---

## Top of the grid, ranked by net total return

| Rule | n | %TP | %stop | %out | Net median | Net mean | **Net total** |
|---|---:|---:|---:|---:|---:|---:|---:|
| TP+100% / stop −20% / 60m | 131 | 15 | 61 | 24 | −21.6% | +5.8% | **+754%** |
| TP+100% / stop −20% / 30m | 131 | 14 | 58 | 28 | −21.6% | +4.2% | +545% |
| TP+100% / stop −20% / 5m ⚠️ | 131 | 4 | 18 | 78 | −2.0% | +3.2% | +414% |
| TP+100% / stop −20% / 15m | 131 | 8 | 52 | 40 | −21.6% | +2.2% | +286% |
| TP+50% / stop −20% / 60m | 131 | 21 | 56 | 22 | −21.6% | +2.0% | +264% |
| TP+50% / stop −20% / 5m | 131 | 8 | 18 | 74 | −2.0% | +0.4% | +55% |
| TP+50% / stop −20% / 30m | 131 | 19 | 54 | 27 | −21.6% | +0.2% | +32% |

⚠️ TP+100%/5m records only **5 take-profit hits** — its edge rests on fewer than
10 trades.

**Only 7 of 72 combinations produce a positive net total.** All seven use a
−20% stop; every rule with no stop, and every rule with a −50% stop, loses
money. The worst is TP+5% / no stop / 60m at **−4455%**.

**Every rule loses at the median.** The best rule's median trade is −21.6%. The
totals come from the mean, not the middle — which is the whole story, and the
next section is where it gets decided.

### Best rule at each time limit vs its own baseline

| Limit | Best rule | Net total | Baseline | Edge | TP hits |
|---|---|---:|---:|---:|---:|
| 5m | TP+100% / stop −20% | +414% | **+1765%** | **−1351%** | 5 ⚠️ |
| 15m | TP+100% / stop −20% | +286% | −108% | +394% | 11 |
| 30m | TP+100% / stop −20% | +545% | −926% | +1471% | 18 |
| 60m | TP+100% / stop −20% | +754% | −2435% | +3189% | 19 |

At 5 minutes, **no rule beats buy-and-hold**. At every longer horizon, the rules
beat it by a wide margin — because the baseline decays so badly, not because the
rules do well.

---

## The decisive check: where does the money come from?

| Strategy | Net total | Winners | Best single trade | Top trade as share | **Excluding best trade** | Excluding top 3 |
|---|---:|---:|---:|---:|---:|---:|
| **Buy & hold 5m** | +1765% | **30/131** | **+2193%** | **124%** | **−429%** | **−933%** |
| Buy & hold 15m | −108% | 53/131 | +2391% | — | −2499% | −3662% |
| **TP+100% / −20% / 60m** | +754% | **48/131** | **+96%** | **13%** | **+658%** | **+466%** |
| TP+100% / −20% / 30m | +545% | 51/131 | +96% | 18% | +449% | +257% |
| TP+50% / −20% / 60m | +264% | 54/131 | +47% | 18% | +217% | +123% |

**Buy-and-hold at 5 minutes is one token.**

Its single best trade returns **+2193%** — more than the entire strategy's
+1765%, because everything else nets out negative. Remove that one token and the
"winning" baseline becomes **−429%**. Remove the top three and it is **−933%**.
Only 30 of 131 trades are profitable at all.

The take-profit rule is a genuinely different shape. TP+100% caps each winner at
about +96% net by construction, so no trade can dominate: the best contributes
13% of the total, and removing it still leaves **+658%**. Removing the top three
leaves **+466%**. It also wins on 48 of 131 trades rather than 30.

### Ranking after removing each strategy's single best trade

| Rule | Net total | **Ex-best** | TP hits |
|---|---:|---:|---:|
| TP+100% / stop −20% / 60m | +754% | **+658%** | 19 |
| TP+100% / stop −20% / 30m | +545% | +449% | 18 |
| TP+100% / stop −20% / 5m ⚠️ | +414% | +318% | 5 |
| TP+50% / stop −20% / 60m | +264% | +217% | 28 |
| TP+100% / stop −20% / 15m | +286% | +190% | 11 |
| TP+50% / stop −20% / 5m | +55% | +8% | 10 |
| Buy & hold 5m | +1765% | **−429%** | — |
| Buy & hold 15m | −108% | −2499% | — |

The headline ranking and the ex-best ranking disagree completely, and only one
of them describes something you could repeat.

---

## What this supports

- **The 5-minute buy-and-hold baseline is not a real edge.** It is one token
  returning +2193%. Its total is 124% of itself; without that token it loses
  money. Any strategy compared against it is being compared against a lottery
  ticket that already paid.
- **TP+100% with a −20% stop is the most robust thing in the grid**, at every
  time limit past 5 minutes. Not because it earns more — it earns less than the
  raw 5m baseline — but because its return survives deleting its best trades.
- **A stop is doing more work than the take-profit.** All seven profitable
  combinations use −20%. It fires on 52–61% of trades at the longer limits,
  which is what stops the median from dragging the total down.
- **Wide targets beat tight ones, monotonically.** +100% > +50% > +25% > +15% >
  +10% > +5% at every limit and every stop. Tight targets clip the few winners
  that pay for everything else while doing nothing about the losers.
- **Every rule still loses at the median.** The best has a median trade of
  −21.6%. These are ways of surviving a losing distribution, not of winning one.

## What it does not support

- **Any 5-minute-limit conclusion.** One price observation after entry, and the
  best 5m rule has 5 TP hits.
- **The 60-minute row as a 60-minute hold.** No series reaches it; those trades
  exit at ~55 minutes when the data ends.
- **The precision of any %TP figure.** With 5-minute bars, targets hit and
  reverted inside a bar are invisible, so real hit rates are higher and real
  fills worse than modelled.
- **That any of this generalises.** 131 tokens from a single 8-hour collection
  window, all graduating in the same market conditions. The result that survives
  scrutiny — cap your winners, cut at −20%, do not hold — is a statement about
  these 131 tokens.
- **Stop-loss realism.** Every stop is filled at its exact level. In a market
  where the median token falls 42% in half an hour, that will not happen.
