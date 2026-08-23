# command-center

A monitoring spine. Sources are pulled on a schedule, normalized into one shape,
stored in Postgres, and read back by two sinks: a web dashboard and Discord
alerts.

The point of the layering is that adding the tenth source should cost the same
as adding the second.

```
  INGEST                    STORE                 OUTPUT
  ------                    -----                 ------
  adapters/rss.ts   ─┐                         ┌─ web dashboard  (/)
  adapters/...      ─┼──►  Postgres  ──────────┤
  adapters/...      ─┘     records             └─ Discord alerts (failures)
        ▲                  monitors (registry)
        │                  monitor_runs
   monitors/*.yaml
```

## Layers

**Ingest.** One file per source in `src/adapters/`, each default-exporting a
`SourceAdapter`. The directory is scanned at boot, so there is no registration
list to keep in sync. Required: `validate(options)` and `fetch(ctx)`. Optional:
`migrate(client)`, `persist(ctx, client, rows)`, and `renderPanel(ctx)` for
sources that own their storage and their view.

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

- **Discovery is not exhaustive.** DexScreener has no endpoint that enumerates a
  chain's pairs by age (search returns mature pairs — in testing, 1 of 75 was in
  a 6h–7d window). The universe is instead *accumulated* from the "latest
  profiles/boosts" feeds, so coverage grows over days and is biased toward
  tokens that appear in them.
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
shape add `migrate` / `persist` / `renderPanel` to the same file.
