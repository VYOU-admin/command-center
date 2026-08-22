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
`SourceAdapter`: `validate(options)` and `fetch(ctx) -> NormalizedRecord[]`.
Adapters know nothing about Postgres, the dashboard, or Discord. The directory
is scanned at boot, so there is no registration list to keep in sync.

**Store.** Postgres, connection string from `DATABASE_URL`, never hardcoded.
Tables are created on startup if missing. Three of them:

| table          | holds                                                        |
| -------------- | ------------------------------------------------------------ |
| `monitors`     | the registry: last run, last success, status, counts, streaks |
| `monitor_runs` | one row per run, for history                                  |
| `records`      | normalized records, deduped per monitor                       |

Dedupe is a unique index on `(monitor_id, external_id)` plus `ON CONFLICT DO
NOTHING`. Adapters just return everything the source gave them; reruns cannot
create duplicates. The "new records" number on the dashboard is how many rows
actually landed.

**Output.** The dashboard at `/` and Discord alerts both read the same tables.
Neither is in the ingest path, so a Discord outage cannot stop data collection.

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

There is no step 3. Storage, dedupe, scheduling, the registry, the dashboard,
health, and alerting all pick it up automatically.
