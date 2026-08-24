# command-center

A monitoring spine. Sources are collected on a schedule, normalized, stored in
Postgres, and read back by two sinks: a web dashboard and Discord alerts.

The point of the layering is that adding the tenth source should cost the same
as adding the second.

```
  INGEST                        STORE                 OUTPUT
  ------                        -----                 ------
  adapters/rss.ts        ─┐                        ┌─ web dashboard  (/)
  adapters/solana-*.ts   ─┼──►  Postgres  ─────────┤
  adapters/pumpfun-*.ts  ─┘     records            └─ Discord alerts (failures)
        ▲       ▲               monitors (registry)
        │       │               monitor_runs
   monitors/    └── websockets held open by the adapter;
     *.yaml         the schedule drains their buffer
```

## Layers

**Ingest.** One file per source in `src/adapters/`, each default-exporting a
`SourceAdapter`. The directory is scanned at boot, so there is no registration
list to keep in sync. Required: `validate(options)` and `fetch(ctx)`. Optional:
`migrate(client)`, `persist(ctx, client, rows)`, `renderPanel(ctx)`, and
`shutdown()` for sources that own their storage, their view, or a connection
that outlives a run.

**Store.** Postgres, connection string from `DATABASE_URL`, never hardcoded.
Tables are created on startup if missing. The spine owns three:

| table          | holds                                                        |
| -------------- | ------------------------------------------------------------ |
| `monitors`     | the registry: last run, last success, status, counts, streaks |
| `monitor_runs` | one row per run, for history                                  |
| `records`      | document-shaped records, deduped per monitor                  |

`records` dedupes on a unique `(monitor_id, external_id)` index plus `ON CONFLICT
DO NOTHING` — one row per item, never overwritten. That is right for articles and
wrong for time series, so sources that need something else declare their own
tables instead (see below).

Adapter-owned tables now outnumber the spine's: `solana_*` (3), `pump_*` (4).

**Output.** The dashboard at `/` and Discord alerts both read the same tables.
Neither is in the ingest path, so a Discord outage cannot stop data collection.
The dashboard renders the spine's monitor status cards, then one panel per
monitor supplied by its adapter.

### Why adapters own their storage

v1 assumed every source was document-shaped and could share one table. The
Solana monitor disproved it: it needs **append-only** rows, where the same token
writes a new row every poll — the exact inverse of `records`' "never overwrite"
rule. Rather than branch inside the scheduler, storage shape became the
adapter's business.

What stayed common is what genuinely is common: scheduling, the run registry,
health, and failure/recovery alerting. RSS declares no `migrate`/`persist` and
still gets the shared document store for free.

### Why a websocket did not need a second kind of monitor

The pump.fun monitor is not a poll. Its source is two persistent websockets,
which fit none of `fetch()`'s assumptions: no beginning, no end, aborted by the
run guard at five minutes, and permanently "stale" to a health model whose only
question is when a *run* last succeeded.

The alternative was to teach the spine about stream lifecycles — `start`/`stop`,
a connection supervisor, a second health signal threaded through `health.ts`,
`alerts.ts`, and the registry — which forks every layer into polled and
streaming variants.

Instead the adapter holds the sockets and buffers what arrives, and its
scheduled `fetch()` drains the buffer. Everything above ingest keeps working
unchanged: a drain that finds the socket dead or silent throws, and
`consecutive_failures` does the rest. The only spine change was one optional
`shutdown()` hook, plus a final drain before it, so a Railway SIGTERM commits
buffered events instead of dropping them.

Batching turned out to be the right shape anyway. At ~50 launches/minute, one
insert per event is a write per second forever; one transaction per drain is
strictly better for Postgres.

## Monitors

One YAML file per monitor in `monitors/`. Adding a source is one adapter file
plus one of these — nothing else changes.

```yaml
id: coindesk
name: CoinDesk
source: rss # which adapter
enabled: true
schedule: 1h # 30s / 15m / 1h / 2d
options: # passed to the adapter, validated by it at boot
  url: https://www.coindesk.com/arc/outboundfeeds/rss/?outputType=xml
  timeout_ms: 20000
alerts:
  discord_on_consecutive_failures: 3
dashboard:
  window_hours: 24
```

Everything is validated at boot — an unknown `source`, a malformed URL, a bad
duration — so a typo fails the deploy instead of becoming a monitor that quietly
never produces anything.

## The Solana monitor

Two free, key-less stages: DexScreener for discovery and metrics, RugCheck for
authority / LP / holder enrichment on candidates that clear every hard floor.
All floors, weights, and limits live in `monitors/solana-tokens.yaml`.

It owns three tables:

| table                       | holds                                              |
| --------------------------- | -------------------------------------------------- |
| `solana_tokens`             | one row per token: first seen, launch date, pair    |
| `solana_token_observations` | **append-only**, one row per token per poll         |
| `solana_top_membership`     | top-N membership, so entry alerts fire on edges     |

Nothing in `solana_token_observations` is ever updated, which is what makes
retrospective questions answerable:

```sql
-- of tokens scoring 80+ at hour 12, how many still had liquidity at day 7
with scored_at_12h as (
  select distinct on (mint) mint, score
    from solana_token_observations
   where monitor_id = 'solana-tokens' and score is not null and age_hours between 11 and 13
   order by mint, abs(age_hours - 12)
),
at_day_7 as (
  select distinct on (mint) mint, liquidity_usd
    from solana_token_observations
   where monitor_id = 'solana-tokens' and age_hours between 160 and 176
   order by mint, abs(age_hours - 168)
)
select count(*) filter (where d.liquidity_usd >= 15000) as still_liquid,
       count(*)                                          as cohort
  from scored_at_12h s left join at_day_7 d using (mint)
 where s.score >= 80;
```

Tracking deliberately continues past the 7-day scoring window — a token dropped
at day 7 could never answer that question.

### Known data limits

These are properties of the free APIs, not of the code, and they are worth
knowing before trusting a number:

- **Discovery is not exhaustive, and was biased.** DexScreener has no endpoint
  that enumerates a chain's pairs by age (search returns mature pairs — in
  testing, 1 of 75 was in a 6h–7d window). The universe is instead *accumulated*
  from the "latest profiles/boosts" feeds — which list tokens whose developers
  *paid* for visibility. Since the pump.fun monitor landed, graduated tokens are
  unioned in from `pump_launches`, which are selected by the market instead. The
  feeds are kept alongside rather than replaced, so tokens that never touched a
  bonding curve stay in scope. Pre-graduation launches are deliberately *not*
  pulled in: at ~70k/day they would swamp the universe, and none of them have
  the pair, liquidity, or age this monitor's floors are written against. If the
  launch monitor is not deployed its tables will not exist, and discovery logs a
  warning and carries on feeds-only.
- **There is no unique-wallet data.** Neither API exposes unique traders, so
  dispersion uses holder count. Holders are rent-funded on-chain accounts that
  cost real SOL to create, making them far harder to fake than transaction
  counts, which volume bots inflate in lockstep with volume.
- **Holder data is unreliable.** RugCheck returns `totalHolders` and `topHolders`
  populated sometimes and zeroed other times *for the same mint minutes apart*.
  Scores are therefore computed over whatever was measurable and normalised, and
  every observation stores a `completeness` figure — the fraction of scoring
  weight that could be measured. **A score is only meaningful read next to its
  completeness**, which is why the dashboard prints both. Raise
  `scoring.min_completeness` to refuse to score tokens missing holder data.

## The pump.fun monitor

Two monitors over one launch stream, existing to build a dataset — not a buy
list. Nothing here is ranked and nothing alerts per launch.

| monitor            | schedule | does                                                |
| ------------------ | -------- | --------------------------------------------------- |
| `pumpfun-launches` | 30s      | drains the sockets, writes launches/trades/outcomes |
| `pumpfun-outcomes` | 10m      | resolves outcomes, deployer stats, retention        |

They are split so each has its own health and staleness alert. If outcome
tracking wedges, that fails loudly rather than hiding behind a stream that is
still happily ingesting.

### Where the data comes from

All of it is free and none of it needs an API key.

| feed                            | gives                                    |
| ------------------------------- | ---------------------------------------- |
| PumpPortal `subscribeNewToken`  | every launch: mint, deployer, mcap, curve |
| PumpPortal `subscribeMigration` | every graduation, platform-wide           |
| Solana RPC `accountSubscribe`   | one push per trade on a token's curve     |
| the token's metadata URI        | advertised twitter / telegram / website   |

The third one is the load-bearing trick. **PumpPortal's own trade feed is not
free** — `subscribeTokenTrade` is metered at 0.01 SOL per 10,000 events, which
at ~70k launches/day is not viable. But every trade mutates the token's bonding
curve account, so subscribing to that *account* yields one message per trade at
no cost, carrying both the SOL level and, by counting messages, the trade count.

### Why trade count, not just elapsed time

The result this monitor exists to test is that liquidity velocity is the single
most informative predictor of graduation ([Marino et al.][marino]). That
paper's variable is **SOL per trade** — reaching a given level in *fewer* trades
predicts graduation — not SOL per second. A design that only sampled curve
balances on a timer would measure the time derivative and miss the published
variable entirely.

So `pump_curve_samples` stores a per-token `trade_seq` alongside `real_sol`, and
`pump_velocity_summary` records both *trades-to-N-SOL* and *seconds-to-N-SOL* at
each configured level. Which one carries the signal is then a question the
dataset can answer rather than one the schema has already assumed.

[marino]: https://arxiv.org/abs/2602.14860

### Sampling, and why there is a control group

At ~48.7 launches/minute measured and a hard cap of 100 concurrent RPC
subscriptions, everything cannot be instrumented. Every launch gets a free t=0
row; a subset gets a bonding-curve subscription:

- **initial mcap above the 30 SOL default** — the strongest t=0 predictor in the
  survival literature (Cox HR 4.51)
- **an advertised Telegram** — an 8.94x graduation lift ([GRW study][grw])
- **a random 6% of everything else** — the control group

The control group is not optional. Instrumenting only tokens that pass a filter
produces a dataset that can describe those tokens and nothing else, which makes
the filter unfalsifiable: you could never measure what it threw away. Membership
is a hash of the mint rather than a coin flip, so it stays reproducible.

[grw]: https://arxiv.org/abs/2607.02823

### Retention

~70k launches/day means storing every trade for every token forever is not an
option. The policy leans on the class imbalance rather than fighting it —
graduations are ~0.2% of rows, so keeping them at full fidelity costs nothing,
while tokens that died without trading are both the bulk of the data and the
least informative per byte.

| data                            | kept                                    |
| ------------------------------- | --------------------------------------- |
| launch rows (t=0 features)       | forever — they are the denominator      |
| samples, graduated               | 180 days                                |
| samples, everything else         | 30 days, then collapsed to a summary    |
| samples, died without a trade    | 7 days                                  |
| `pump_velocity_summary`          | forever — it outlives the raw detail    |
| `pump_deployer_stats`            | forever                                 |

Launch rows are never deleted. Without the tokens that failed there is no base
rate, and every number computed from the table would be conditioned on success.
Raw samples are only pruned after their velocity summary exists.

### Known data limits

- **Graduation is rarer than most sources claim.** ~0.2% platform-wide in 2026,
  down from 0.63% in late 2025. At ~140/day, any leaderboard drawn from a few
  days of collection is noise. The dashboard shows counts and an observed rate,
  and deliberately shows no token ranking.
- **The observed rate is over *resolved* launches only.** Dividing graduations
  by every launch ever seen would understate it, because the newest launches
  have not had time to graduate and would all count as failures.
- **`website` is usually a self-link.** pump.fun writes the coin's own page into
  that field for most launches, so counted naively every token looks like it has
  a site. Self-links are stored as `website_is_self` instead.
- **Graduations arrive for tokens that launched before this monitor existed.**
  Those get a stub row flagged `observed_from_launch = false`: the outcome is
  real, the t=0 features are not, and feature analysis must exclude them rather
  than read the nulls as zeroes.
- **The dense window is a sampling decision, not a measurement.** A token is
  watched for its first 5 minutes. Trades after that are not recorded, so
  `trade_count` is a count within the window and not a lifetime total.

## Designing against silent failure

A monitor that stops working breaks in two different shapes, and only one of
them is caught by counting errors:

1. **It runs and throws.** `consecutive_failures` climbs; at the monitor's
   threshold (3 for CoinDesk) a Discord alert fires once, and a recovery message
   fires when it works again.
2. **It stops running at all** — wedged scheduler, crash loop, config that no
   longer matches. Nothing throws, so `consecutive_failures` sits at 0 forever
   and rule 1 never fires. A staleness watchdog runs every tick and alerts when
   a monitor has had no *successful* run in more than twice its schedule plus
   five minutes.

Both surface in three places: the dashboard cards, `/health`, and Discord.
Alerts fire on edges rather than on every tick, so an outage is one message plus
one recovery, not a siren.

`/health` returns 200 even when a monitor is broken, deliberately: Railway's
healthcheck points at it, and a broken *monitor* must not read as a broken
*deployment* and trigger a rollback. External uptime checkers that want a hard
signal can use `/health?strict=1`, which returns 503 when anything is unhealthy.

## Endpoints

| route            | purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `/`              | dashboard — monitor status plus the last 24h, newest first     |
| `/health`        | per-monitor last successful run, status, error, next run due   |
| `/api/monitors`  | registry as JSON, including the last 10 runs per monitor       |
| `/api/records`   | records as JSON; `?hours=`, `?limit=`, `?monitor=`             |

## Environment

Nothing sensitive is committed; it all comes from the environment.

| variable              | required | notes                                         |
| --------------------- | -------- | --------------------------------------------- |
| `DATABASE_URL`        | yes      | refuses to boot without it                    |
| `DISCORD_WEBHOOK_URL` | no       | without it, alerts only reach logs and /health |
| `PORT`                | no       | Railway sets it; 3000 locally                  |
| `LOG_LEVEL`           | no       | `debug` / `info` / `warn` / `error`            |
| `PUBLIC_URL`          | no       | link back from alerts; inferred on Railway     |

## Local development

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL
npm run build && npm start  # service: web + scheduler
npm run run-once            # run every monitor once, print the result, exit
npm run run-once coindesk   # or just one
```

The scheduler decides what is due from `last_run_at` in Postgres rather than an
in-memory timer, so restarts and redeploys do not re-run everything, and a fresh
database runs everything immediately instead of an hour later.

## Deployment

Railway, auto-deploying on push to `main`. `railway.json` pins the build and
start commands and points the healthcheck at `/health`. The service binds the
`PORT` Railway provides. Attach a Postgres database and Railway sets
`DATABASE_URL` itself; set `DISCORD_WEBHOOK_URL` as a service variable.

Do not add `npm ci` to `buildCommand` — Nixpacks already installs dependencies
(including devDependencies, so `tsc` is present). A second `npm ci` tries to
remove `node_modules` while Railway has `node_modules/.cache` mounted as a build
cache, and the build fails with `EBUSY`.

**Pending:** Railway has deprecated `railway.json` in favour of Infrastructure as
Code in `.railway/railway.ts`; existing config files keep working until
2026-12-01. Migrating is deliberately left as its own change — `railway config
migrate` emits a project definition listing only the app service, so applying it
as-is risks orphaning the Postgres service, and the IaC format needs the
`railway` npm package as a dependency.

## Adding a source

1. Write `src/adapters/<name>.ts` default-exporting a `SourceAdapter`.
2. Add `monitors/<monitor>.yaml` with `source: <name>`.

There is no step 3. Scheduling, the registry, health, and failure/recovery
alerting pick it up automatically. Document-shaped sources also get the shared
record store, dedupe, and a default dashboard panel; sources needing a different
shape add `migrate` / `persist` / `renderPanel` to the same file, and sources
holding a connection between runs add `shutdown`.

That held for a websocket source too. Adding pump.fun cost two adapter files,
two YAML files, and exactly one line of new interface — the rest of the spine
did not move.
