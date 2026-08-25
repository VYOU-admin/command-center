# AUDIT — what actually exists in this repo

Written for someone who did not write this code. Every claim below was read out
of the source at commit `9c691f4`, and the row counts and funnel numbers were
queried from the live production database while writing.

**Jargon used throughout, defined once:**

- **Monitor** — one configured job. A YAML file in `monitors/` plus an adapter
  in `src/adapters/`. There are five.
- **Adapter** — the code that knows how to talk to one kind of source.
- **Mint** — a Solana token's unique address. Its identity.
- **Append-only** — rows are inserted and never changed afterwards. The history
  is the pile of rows.
- **Upsert** — insert a row, or update it if one with the same key already
  exists. The opposite of append-only.
- **Bonding curve** — a pump.fun token's built-in market. A formula holds SOL
  and tokens and sets the price. When enough SOL accumulates the token
  "graduates" to a normal exchange.

---

## 1. Monitors

Five monitors are configured and all five are enabled.

| Monitor | Schedule | What it does | Data source | Tables it writes | Config |
| --- | --- | --- | --- | --- | --- |
| `coindesk` | 1h | Stores CoinDesk news articles, deduplicated | CoinDesk RSS feed | `records` (shared) | `monitors/coindesk.yaml` |
| `solana-tokens` | 1h | Scores newly-listed Solana tokens for risk and alerts on the best | DexScreener + RugCheck | `solana_tokens`, `solana_token_observations`, `solana_top_membership` | `monitors/solana-tokens.yaml` |
| `pumpfun-launches` | 30s | Records every pump.fun token launch and per-trade price movement | Two websockets: PumpPortal + Solana RPC | `pump_launches`, `pump_curve_samples` | `monitors/pumpfun-launches.yaml` |
| `pumpfun-outcomes` | 10m | Decides which launches died, computes velocity features, updates deployer stats, deletes old rows | Its own database tables | `pump_launches`, `pump_velocity_summary`, `pump_deployer_stats`, deletes from `pump_curve_samples` | `monitors/pumpfun-outcomes.yaml` |
| `oil-prices` | 15m | Scrapes home heating oil prices from CT dealers | 9 websites (2 disabled-by-choice groups, see below) | `oil_observations`, `oil_price_history`, `oil_source_state`, `oil_alert_state` | `monitors/oil-prices.yaml` |

Every monitor also writes to two shared bookkeeping tables — `monitors` (its
current status) and `monitor_runs` (one row per run) — regardless of what else
it does.

**A note on `pumpfun-launches`' 30s schedule.** It is not a poll. Two websockets
stay open continuously and events pile up in memory; the "schedule" is how often
that pile is written to the database. The YAML records that the *effective*
interval is 60 seconds, not 30: the scheduler wakes every 30 seconds and only
runs a monitor once a full interval has elapsed, so a 30-second schedule lands
on every second wake-up.

---

## 2. The `solana-tokens` monitor, in depth

### 2.1 Where the token universe comes from

Before anything is scored, the monitor assembles a list of tokens to look at.
This happens in `fetch()` at `src/adapters/solana-tokens.ts:812`.

The list is the union of two things:

1. **Discovery** (`discover()`, line 258). Three DexScreener endpoints are
   fetched every run:
   - `/token-profiles/latest/v1`
   - `/token-boosts/latest/v1`
   - `/token-boosts/top/v1`

   Anything on those lists with `chainId == "solana"` is added.

2. **Graduates from the pump.fun monitor** (`discoverGraduates()`, line ~225).
   Tokens that graduated from a bonding curve within the last
   `graduate_lookback_hours` (currently **168 hours / 7 days**) are pulled from
   `pump_launches`. If those tables do not exist the code catches the error, logs
   a warning, and carries on with feeds only (line 246).

3. **Everything tracked before.** `loadTracked()` (line 293) reads every mint
   already in `solana_tokens`, most-recently-seen first, up to the cap. Once a
   token enters the universe it stays until it is pushed out by the cap.

Newly discovered tokens are added first so the cap can never block new arrivals
(line 823). The combined list is capped at `max_tracked` = **1,200**.

**How large is it in practice?** From production right now:

- **1,134** tokens tracked in `solana_tokens`
- **950** of them returned data from DexScreener on the most recent run

So the universe is roughly a thousand tokens and is close to its 1,200 ceiling.

⚠️ The important thing to understand about this list: it is **accumulated, not
comprehensive**. DexScreener has no endpoint that lists a chain's new tokens, so
the only inputs are its "latest profiles / boosts" feeds — which list tokens
whose developers *paid* for placement — plus pump.fun graduates. This is not a
view of the whole chain.

### 2.2 Every filter, in order

A token must clear all of these before it can be scored. Numbers are the current
YAML values; defaults in code are shown where they differ in nothing but form.

| # | Filter | Threshold now | Where the number is read | Where it is applied |
| --- | --- | --- | --- | --- |
| 1 | Must be in the universe | cap 1,200 | `solana-tokens.ts:166` (`max_tracked`) | `solana-tokens.ts:823-827` |
| 2 | DexScreener must return a trading pair | — | — | `solana-tokens.ts:833-835` |
| 3 | **Minimum age** | **6 hours** | `solana-tokens.ts:145` (`min_age_hours`) | `solana-tokens.ts:841-842` |
| 4 | **Maximum age** | **168 hours (7 days)** | `solana-tokens.ts:146` (`max_age_hours`) | `solana-tokens.ts:841-842` |
| 5 | Liquidity floor | ≥ $15,000 | `solana-tokens.ts:155` | `solana-tokens.ts:427` |
| 6 | 24-hour volume floor | ≥ $25,000 | `solana-tokens.ts:156` | `solana-tokens.ts:428` |
| 7 | Transactions in last hour | ≥ 100 | `solana-tokens.ts:159` | `solana-tokens.ts:429` |
| 8 | Market cap must be known and positive | > 0 | — (hardcoded) | `solana-tokens.ts:431` |
| 9 | Volume ÷ market cap | ≥ 0.30 | `solana-tokens.ts:157` | `solana-tokens.ts:432` |
| 10 | Liquidity ÷ market cap | ≥ 0.10 | `solana-tokens.ts:158` | `solana-tokens.ts:433` |
| 11 | Enrichment budget | top **25** per run, by liquidity | `solana-tokens.ts:172` | `solana-tokens.ts:848-849` |
| 12 | Signal coverage ("completeness") | ≥ 0.50 | `solana-tokens.ts:165` | `solana-tokens.ts:573` |

**On the age filters specifically** (asked for explicitly): the window is
6 hours to 168 hours, and it gates **eligibility to be scored only**. It does not
stop the monitor from *observing* a token. A token older than 7 days keeps being
polled and keeps getting rows written — the code comment at line 837 says this is
deliberate, because answering "did it still have liquidity at day 7" requires
day-7 rows to exist.

Also note: the age is computed from DexScreener's `pairCreatedAt` (line 382),
which is when the *trading pair* was created, not when the token was minted.
For most tokens these are close, but they are not the same thing.

**Filters 5–10 are all-or-nothing** (`passesFloors`, line 423): any single
failure disqualifies. Missing liquidity or volume is treated as zero, so missing
data fails the floor.

**The funnel in practice.** From the most recent production run:

| Stage | Count |
| --- | --- |
| Tokens observed | 950 |
| In the 6h–168h age window | 611 |
| Also passed all five floors | 48 |
| Enriched (capped at 25) | 25 |
| Actually scored | 25 |

⚠️ Note the gap at the enrichment step: **48 tokens qualified but only 25 were
scored.** The other 23 were dropped purely because of the per-run budget, chosen
by liquidity (highest first, line 848).

### 2.3 The scoring function

Scoring happens in `score()` at `src/adapters/solana-tokens.ts:516`. It only
runs on tokens that were enriched (line 517).

Six components. Each produces a value between 0 and 1, which is multiplied by
its weight.

| Component | Weight | Raw metric | How it maps to 0–1 | Line |
| --- | --- | --- | --- | --- |
| `mintRenounced` | 25 | Can the creator mint more tokens? | 1 if renounced, 0 if not | 521-526 |
| `freezeRenounced` | 10 | Can the creator freeze wallets? | 1 if renounced, 0 if not | 527-532 |
| `lpLocked` | 25 | % of liquidity pool locked | `pct / 100`, clamped to 0–1 | 533-538 |
| `holderDistribution` | 15 | Top-10 holders' share, and insider share | `(1 − top10%/100) × (1 − insider%/100)` | 539-545 |
| `liquidityDepth` | 10 | Liquidity ÷ market cap | `ratio ÷ 0.40`, clamped to 0–1 — so 40% or more scores full marks | 546-554 |
| `dispersion` | 15 | Number of holders | `log₁₀(holders) ÷ log₁₀(2000)`, clamped — so 2,000 holders scores full marks | 555-563 |

Weights total 100, but they do **not** have to. The score is a weighted average,
not a sum.

**The renormalisation step (lines 566–580).** This is the part that is easy to
misread. RugCheck's holder data is unreliable — it returns holder counts for one
request and zeroes for the same token minutes later. Rather than score a missing
value as zero (which would confuse "badly distributed" with "we could not see"),
the code:

1. Splits components into measurable and not-measurable.
2. Records `completeness` = measurable weight ÷ total weight (line 570).
3. If completeness is below **0.50**, stores no score at all — just the
   breakdown (lines 573–578).
4. Otherwise averages **only over the measurable components** and scales to
   0–100 (line 580).

So a score of 80 with completeness 0.70 means "80 out of the 70% of signals we
could actually see". **A score is only meaningful read next to its
completeness**, and both are stored on every row.

**The mint-authority penalty (line 584).** If the mint authority is *positively
known to be live*, the whole score is multiplied by **0.25**. Missing data is not
penalised — only a confirmed-live authority.

Final score is rounded to a whole number 0–100 (line 586).

### 2.4 What triggers a Discord alert vs. what only shows on the dashboard

**Alerts go to the `crypto` Discord channel.** Failure and recovery alerts for
the monitor itself go to `system` instead — that split is deliberate and applies
to every monitor.

The only content alert this monitor produces is **"token entered the top N"**,
built in `handleTopEntryAlerts()` at line 672.

The exact rule:

1. Take this run's observations that have a score (line 679).
2. Sort by score, highest first (line 680).
3. Keep the top `top_n` = **20** (line 681).
4. For each of those, alert **only if** it was not in the top 20 on the previous
   run (line 701), **and** the cooldown has elapsed (line 704), **and** this is
   not the very first scored run (line 705).

Answering the three specific questions:

- **Is there a score cutoff?** **No.** There is no minimum score. The only test
  is rank. A token scoring 30 will alert if it happens to be in the top 20 of
  whatever was scored that run.
- **Is there a rank cutoff?** **Yes — top 20**, from `alerts.top_n`.
- **Is there a dedupe / cooldown rule?** **Yes, two.**
  - *Edge-triggering:* a token already in the top 20 does not re-alert, however
    much its rank moves (line 701). Alerts fire on entry, not on ranking.
  - *Re-entry cooldown:* a token that drops out and comes back does not alert
    again until **24 hours** have passed since it exited
    (`re_entry_cooldown_hours`, line 176; enforced line 704). This stops a token
    oscillating on the boundary from spamming the channel.
  - *Seeding:* on the very first run with scores, membership is recorded
    silently and nothing alerts (lines 693, 705). Without this a fresh deploy
    would fire 20 alerts at once.

**Dashboard-only.** Everything else. The dashboard panel
(`src/web/solana-panel.ts`) shows the current top 20 by score with each figure
rendered as *first-seen → now*, plus its completeness. Tokens that were scored
but did not enter the top 20, tokens that failed the floors, and tokens outside
the age window all appear in the database and never produce an alert.

---

## 3. Storage

Fourteen tables. Live row counts are from production at the time of writing.

### 3.1 Shared tables (used by every monitor)

| Table | Rows | Columns | Written by | Update behaviour |
| --- | --- | --- | --- | --- |
| `monitors` | 5 | 21 | `src/store/registry.ts` after every run | **Upserted.** One row per monitor, continually overwritten with latest status, streaks and totals. |
| `monitor_runs` | 701 | 9 | `src/store/registry.ts` after every run | **Append-only.** One row per run forever. |
| `records` | 51 | 9 | `src/store/records.ts`, only for `coindesk` | **Append-only with dedupe.** A unique index on (monitor, external id) plus `ON CONFLICT DO NOTHING` — one row per article, never overwritten. |

### 3.2 `solana-tokens` tables

| Table | Rows | Columns | Written by | Update behaviour |
| --- | --- | --- | --- | --- |
| `solana_tokens` | 1,134 | 10 | `solana-tokens.ts:886` | **Upserted.** One row per token — identity and `last_seen_at`. Names/URLs fill in if previously missing; `launch_at` is never overwritten once set. |
| `solana_token_observations` | 16,029 | 28 | `solana-tokens.ts:903` | **Append-only.** One row per token per run. Never updated. |
| `solana_top_membership` | 87 | 6 | `solana-tokens.ts:709` and `:725` | **Upserted.** Tracks whether each token is currently in the top 20, and when it entered / exited / last alerted. |

`solana_token_observations` columns: `id`, `monitor_id`, `mint`, `checked_at`,
`age_hours`, `liquidity_usd`, `volume_24h`, `volume_1h`, `mcap`, `fdv`,
`price_usd`, `txns_1h`, `txns_24h`, `buys_1h`, `sells_1h`, `in_age_window`,
`passed_floors`, `enriched`, `holders`, `top10_pct`, `insider_pct`,
`lp_locked_pct`, `mint_authority_renounced`, `freeze_authority_renounced`,
`usd_per_holder`, `score`, `completeness`, `score_breakdown`.

### 3.3 `pumpfun-*` tables

| Table | Rows | Columns | Written by | Update behaviour |
| --- | --- | --- | --- | --- |
| `pump_launches` | 13,985 | 31 | `pumpfun-launches.ts:78` and `:211`; updated by `:175` and `pumpfun-outcomes.ts:40`, `:207` | **Upserted.** One row per token: t=0 features, then outcome filled in later. |
| `pump_curve_samples` | 136,558 | 11 | `pumpfun-launches.ts:138` | **Append-only, then pruned.** One row per trade. `pumpfun-outcomes.ts:195` deletes old rows per the retention policy. |
| `pump_velocity_summary` | 4,013 | 9 | `pumpfun-outcomes.ts:128` | **Upserted.** One row per token, written once a token resolves; backfilled if it lacks snapshots. |
| `pump_deployer_stats` | 4,952 | 9 | `pumpfun-outcomes.ts:222` | **Upserted.** Rebuilt from scratch each pass. |

### 3.4 `oil-prices` tables

| Table | Rows | Columns | Written by | Update behaviour |
| --- | --- | --- | --- | --- |
| `oil_observations` | 3,072 | 21 | `oil-prices.ts:124` | **Append-only, then pruned.** One row per source per gallon band per scrape. `oil-prices.ts:290` deletes redundant rows older than 48h. |
| `oil_price_history` | 6,584 | 5 | `oil-prices.ts:167` | **Insert-if-absent.** McKinley's own published daily prices back to 2008, keyed by date. Never pruned. |
| `oil_source_state` | 10 | 8 | `oil-prices.ts:309`, `:321`, `:355`, `:372` | **Upserted.** One row per source: failure streak, last error, backfill status. |
| `oil_alert_state` | 1 | 4 | `oil-prices.ts:468` | **Upserted.** Single row tracking last alert and last digest date. |

### 3.5 The direct question

> **For a token that has fired an alert, do we store anything about that token
> AFTER the alert fired?**

## **Yes.**

An alert changes nothing about whether a token is tracked. Alerting writes only
to `solana_top_membership`; the token stays in `solana_tokens`, stays in the
polled universe via `loadTracked()`, and gets a fresh row in
`solana_token_observations` on every subsequent run — with full metrics, and
with a score whenever it is still among the 25 enriched that run.

Verified against production. Tokens that have alerted, and how many observations
were written *after* the alert:

| Token (truncated) | Alerted at | Observations since |
| --- | --- | --- |
| `CXXpHyiwAz…` | 2026-08-23 02:13 | 46 |
| `DDVUsN8sDF…` | 2026-08-23 05:14 | 43 |
| `4978aTN9W3…` | 2026-08-23 07:15 | 40 |
| `3kvZYBrBPE…` | 2026-08-23 10:17 | 37 |
| `GVqEasmDyp…` | 2026-08-23 10:17 | 37 |

81 tokens have alerted; all continue to be observed hourly.

**Two caveats on that "yes":**

1. Observation continues only while the token stays inside the 1,200-token
   universe cap. `loadTracked()` orders by `last_seen_at`, and tokens still
   returning data keep refreshing that, so in practice they stay.
2. A row is written only when **DexScreener still returns a trading pair**
   (line 833). On the last run, 950 of 1,134 tracked tokens returned a pair —
   the other 184 got no row at all. See Oddity 4.

---

## 4. Config — every threshold in YAML

| File | Key | Value |
| --- | --- | --- |
| `coindesk.yaml` | `options.timeout_ms` | 20000 |
| `coindesk.yaml` | `alerts.discord_on_consecutive_failures` | 3 |
| `coindesk.yaml` | `dashboard.window_hours` | 24 |
| `solana-tokens.yaml` | `options.min_age_hours` | 6 |
| `solana-tokens.yaml` | `options.max_age_hours` | 168 |
| `solana-tokens.yaml` | `options.floors.liquidity_usd` | 15000 |
| `solana-tokens.yaml` | `options.floors.volume_24h_usd` | 25000 |
| `solana-tokens.yaml` | `options.floors.volume_to_mcap` | 0.3 |
| `solana-tokens.yaml` | `options.floors.liquidity_to_mcap` | 0.1 |
| `solana-tokens.yaml` | `options.floors.txns_1h` | 100 |
| `solana-tokens.yaml` | `options.weights.mint_renounced` | 25 |
| `solana-tokens.yaml` | `options.weights.freeze_renounced` | 10 |
| `solana-tokens.yaml` | `options.weights.lp_locked` | 25 |
| `solana-tokens.yaml` | `options.weights.holder_distribution` | 15 |
| `solana-tokens.yaml` | `options.weights.liquidity_depth` | 10 |
| `solana-tokens.yaml` | `options.weights.dispersion` | 15 |
| `solana-tokens.yaml` | `options.scoring.mint_not_renounced_multiplier` | 0.25 |
| `solana-tokens.yaml` | `options.scoring.liquidity_depth_target` | 0.4 |
| `solana-tokens.yaml` | `options.scoring.dispersion_holder_target` | 2000 |
| `solana-tokens.yaml` | `options.scoring.min_completeness` | 0.5 |
| `solana-tokens.yaml` | `options.discovery.graduate_lookback_hours` | 168 |
| `solana-tokens.yaml` | `options.limits.max_tracked` | 1200 |
| `solana-tokens.yaml` | `options.limits.max_enrich_per_run` | 25 |
| `solana-tokens.yaml` | `options.limits.request_delay_ms` | 250 |
| `solana-tokens.yaml` | `options.limits.timeout_ms` | 20000 |
| `solana-tokens.yaml` | `options.alerts.top_n` | 20 |
| `solana-tokens.yaml` | `options.alerts.re_entry_cooldown_hours` | 24 |
| `solana-tokens.yaml` | `alerts.discord_on_consecutive_failures` | 3 |
| `solana-tokens.yaml` | `dashboard.window_hours` | 24 |
| `pumpfun-launches.yaml` | `options.sampling.dense_window_minutes` | 3 |
| `pumpfun-launches.yaml` | `options.sampling.instrument_mcap_sol_above` | 32 |
| `pumpfun-launches.yaml` | `options.sampling.instrument_if_telegram` | true |
| `pumpfun-launches.yaml` | `options.sampling.control_sample_rate` | 0.15 |
| `pumpfun-launches.yaml` | `options.rate_cohort_hours` | 24 |
| `pumpfun-launches.yaml` | `options.limits.max_curve_subscriptions` | 95 |
| `pumpfun-launches.yaml` | `options.limits.metadata_timeout_ms` | 5000 |
| `pumpfun-launches.yaml` | `options.limits.metadata_concurrency` | 6 |
| `pumpfun-launches.yaml` | `options.limits.max_buffered_events` | 20000 |
| `pumpfun-launches.yaml` | `options.limits.silence_fail_after_seconds` | 300 |
| `pumpfun-launches.yaml` | `alerts.discord_on_consecutive_failures` | 3 |
| `pumpfun-launches.yaml` | `dashboard.window_hours` | 24 |
| `pumpfun-outcomes.yaml` | `options.death_after_idle_minutes` | 60 |
| `pumpfun-outcomes.yaml` | `options.unobserved_death_after_hours` | 24 |
| `pumpfun-outcomes.yaml` | `options.velocity_thresholds_sol` | [10, 25, 50] |
| `pumpfun-outcomes.yaml` | `options.snapshot_seconds` | [30, 60, 120] |
| `pumpfun-outcomes.yaml` | `options.retention.graduate_sample_days` | 180 |
| `pumpfun-outcomes.yaml` | `options.retention.raw_sample_days` | 30 |
| `pumpfun-outcomes.yaml` | `options.retention.dead_sample_days` | 7 |
| `pumpfun-outcomes.yaml` | `options.retention.max_rows_per_pass` | 50000 |
| `pumpfun-outcomes.yaml` | `options.dashboard_min_launches` | 3 |
| `pumpfun-outcomes.yaml` | `alerts.discord_on_consecutive_failures` | 3 |
| `pumpfun-outcomes.yaml` | `dashboard.window_hours` | 24 |
| `oil-prices.yaml` | `options.compare_gallons` | 150 |
| `oil-prices.yaml` | `options.retention.full_resolution_hours` | 48 |
| `oil-prices.yaml` | `options.retention.max_rows_per_pass` | 20000 |
| `oil-prices.yaml` | `options.limits.timeout_ms` | 25000 |
| `oil-prices.yaml` | `options.limits.request_delay_ms` | 4000 |
| `oil-prices.yaml` | `options.limits.max_retries` | 2 |
| `oil-prices.yaml` | `options.alerts.digest_hour` | 7 |
| `oil-prices.yaml` | `options.alerts.source_failure_alert_after` | 3 |
| `oil-prices.yaml` | `options.alerts.csv_window_hours` | 24 |
| `oil-prices.yaml` | `alerts.discord_on_consecutive_failures` | 3 |
| `oil-prices.yaml` | `dashboard.window_hours` | 24 |
| `oil-prices.yaml` | per-source `extract[].window` | 16, 22, 20, 26, 4, 8, 3, 2, 28 |
| `oil-prices.yaml` | per-source `extract[].default_gallon_min` | 100 (PriceRite, Dime, OMNI) |

Oil sources: 9 enabled, 7 disabled. Disabled are Forbes, First Fuel, Hurricane,
Tony's, Deliver Me Fuel, Federal, IT Energy — each with a `disabled_reason` in
the YAML.

Two settings are not in YAML at all and are worth knowing:

| Setting | Value | Where |
| --- | --- | --- |
| Scheduler wake-up interval | 30 seconds | `src/env.ts` (`tickMs`) |
| "Gone silent" threshold | `2 × schedule + 5 minutes` | `src/health.ts:32` |

---

## Questions / Oddities

Things that are unclear, surprising, or look unintentional. Stated as
observations, not fixes.

**1. Top-20 alerts have no minimum score.** The alert rule is purely rank-based
(`solana-tokens.ts:678-681`). If only three tokens are scored on a run, all
three are "in the top 20" and any new one alerts, whatever it scored. Whether a
floor like "score ≥ 70" was intended is not visible in the code or config.

**2. The "top 20" is drawn from a pool of at most 25.** Only tokens enriched
*this run* have a score, and enrichment is capped at 25 (line 849). So the top-20
list is the top 20 of at most 25 candidates — roughly 80% of everything scored
qualifies as "top". The name suggests a much more selective filter than the
mechanism delivers. This may be intentional (the 25 are already the highest-
liquidity qualifiers) but the two numbers being that close looks accidental.

**3. Nearly half of qualifying tokens are never scored.** Last run: 48 tokens
passed every floor, 25 were enriched. The 23 dropped were chosen by liquidity
alone. A token that passes every quality floor but has lower liquidity than 25
others may never be scored on any run, and would never appear on the dashboard
or alert.

**4. "No row" is ambiguous.** Observations are only written when DexScreener
returns a trading pair (line 833). Last run, 184 of 1,134 tracked tokens got no
row. From the data alone you cannot distinguish "the token died and was
delisted" from "DexScreener was flaky for that request". For a dataset whose
stated purpose is answering "did it survive to day 7", that ambiguity sits right
on the question being asked.

**5. Age is measured from pair creation, not token creation.** `pairCreatedAt`
(line 382) is when the *trading pair* was created. A token that traded elsewhere
first, or was re-paired, will read as younger than it is.

**6. `coindesk` is routed to the `crypto` alert channel but can never use it.**
The RSS adapter raises no content alerts at all (`src/adapters/rss.ts:154` notes
it declares no `persist`). The setting is harmless and forward-looking, but it
currently does nothing.

**7. `monitors.config` stores a full copy of each monitor's YAML options**
(`src/store/registry.ts:76`) and nothing appears to read it back. It looks like
an audit trail that was never used.

**8. Two different retention policies exist with different shapes.** pump.fun
prunes by *age and outcome class* (7/30/180 days); oil prunes by *redundancy*
(collapse unchanged rows after 48 hours). Both are deliberate and documented,
but someone reading the codebase cold will not expect "retention" to mean two
different things in two adapters.

**9. `solana_top_membership` has 87 rows but only 20 can be in the top at
once.** The other 67 are historical — tokens that entered and later left. Nothing
ever deletes them. This is harmless at current scale, and is what makes the
24-hour re-entry cooldown work, but the table grows without bound.

**10. The oil monitor's `compare_gallons` (150) and the per-source
`default_gallon_min` (100) interact quietly.** A vendor quoting a single headline
price is recorded with `gallon_min = 100` and no maximum, so it is treated as
covering 150 gallons and appears in the comparison. That is probably right, but
it means a "150 gallon" comparison includes prices the vendor quoted for an
unspecified quantity.

**11. Nothing in the repo defines what a "good" score means.** The scoring
function is well documented mechanically, but there is no record of the score
being validated against outcomes — no check that high-scoring tokens actually
performed better. The `solana_token_observations` table was clearly built to
make that question answerable, and 16,029 rows are waiting, but no code asks it.
