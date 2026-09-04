# Project state

What exists now. Written 2026-09-04 immediately after the teardown, from live
queries against production and from reading the tree at commit `e0b15d8`.

Nothing here is carried forward from the previous version of this document. If
you are looking for something that used to be here, it is gone — see
"What was removed" at the bottom.

---

## What this is

A monitoring spine on Node 22, Postgres and Railway. A monitor is a YAML file in
`monitors/` paired with an adapter in `src/adapters/`. The scheduler runs them on
their own schedules, the Discord sink alerts, and a small dashboard shows their
state.

Two monitors run: heating-oil prices, and Postgres volume usage.

## Monitors

| id | source | schedule | channel | what it does |
|---|---|---|---|---|
| `oil-prices` | `oil-prices` | 15m | `oil` | Scrapes 9 Connecticut heating-oil vendor sites, records prices, alerts on change, and sends a daily digest at 07:00 America/New_York |
| `postgres-disk` | `postgres-disk` | 15m | `system` | Reads the Railway volume's real size and usage, records a sample, projects days-until-full, alerts at 70% and 85% |

Both `enabled = true`. Last successful runs at the time of writing:

    oil-prices      2026-09-04T03:52:59Z   57,813 ms   records=1
    postgres-disk   2026-09-04T04:03:26Z      250 ms   records=1

`monitor_runs` contains exactly these two monitor ids and nothing else.

## Tables — 10 in `public`

| table | rows | owner |
|---|---|---|
| `monitors` | 2 | spine |
| `monitor_runs` | 1,788 | spine |
| `records` | 0 | spine — generic document store, unused by either monitor |
| `oil_observations` | 59,059 | oil-prices |
| `oil_price_history` | 6,584 | oil-prices |
| `oil_rank_state` | 21 | oil-prices |
| `oil_source_state` | 10 | oil-prices |
| `oil_alert_state` | 1 | oil-prices |
| `disk_usage_samples` | 888 | postgres-disk |
| `disk_alert_state` | 1 | postgres-disk |

`pg_database_size` is **27 MB**.

`records` is created by the spine's own `migrate()` in `src/store/db.ts`
alongside `monitors` and `monitor_runs`. It was dropped during teardown and
recreated empty at the next boot, which is why it is here at 0 rows. Neither
monitor uses it — both define `persist()` — but the generic `insertRecords`
path remains for any future adapter that does not.

**886 of the 888 `disk_usage_samples` rows carry a `volume_bytes` of 5 GB**, the
stale constant the monitor used to divide by, and `used_pct` values computed
against it. They are kept deliberately as a record of what the monitor believed
at the time. The growth query ignores them: it only reads rows where
`volume_used_bytes is not null`.

## Alerts

Two channels are referenced by code. Both resolve to their own webhook, not the
fallback — confirmed from `/health`, which reports `resolved_via: "channel"` for
each.

| channel | env var | carries |
|---|---|---|
| `oil` | `DISCORD_WEBHOOK_OIL` | oil price changes and the daily digest |
| `system` | `DISCORD_WEBHOOK_SYSTEM` | every monitor's failure and recovery alerts, plus postgres-disk content alerts |

`DEFAULT_ALERT_CHANNEL` is `system`. `DISCORD_WEBHOOK_URL` remains as the
fallback used when a named channel does not resolve; falling back is logged as a
warning and shown in `/health`, because a misrouted alert is delivered
successfully and therefore looks fine from the sending side.

Four further webhook variables — `DISCORD_WEBHOOK_CRYPTO`,
`DISCORD_WEBHOOK_CRYPTO_EARLY`, `DISCORD_WEBHOOK_NEWTOKEN` and
`MOS_PRICE_CHECK` — are **still set on the Railway service and referenced by no
code**. They are kept on purpose: a Discord webhook cannot be recovered once
deleted, only replaced with a new URL. Do not treat them as leftovers.

### Trigger rules

- **Oil price change** — a vendor's price differs from its last recorded value.
  `oil_alert_state` holds the last alert time and change count.
- **Oil daily digest** — fires on the first run at or after `digest_hour` (7) in
  `alerts.timezone` (`America/New_York`) on a local calendar date later than
  `last_digest_on`. Confirmed live in the stored config and in
  `src/adapters/oil-prices.ts`.
- **Disk usage** — alerts only when the level RISES: crossing 70% says it once
  rather than every fifteen minutes, and reaching 85% still says it again.
  Falling back below clears the state so a later crossing is announced afresh.
- **Failure / recovery** — raised by the spine after 3 consecutive failures, to
  `system`, regardless of a monitor's own channel.

## Web surfaces

Three routes, all read-only. Any non-GET returns 405.

| route | serves |
|---|---|
| `/` | Monitor status cards — which monitors exist, whether they are enabled, when each last succeeded, last duration — plus the oil panel |
| `/health` | JSON: overall status, per-monitor state, alert-channel resolution, boot time |
| `/api/monitors` | JSON: the monitors and their recent runs |

The dashboard writes nothing. The tag-editing endpoints went with the wallet
analysis they served.

## External dependencies

| service | used by | notes |
|---|---|---|
| 9 heating-oil vendor sites | oil-prices | 4,000 ms between requests, 25 s timeout, 2 retries. 7 further sources are disabled in the YAML with recorded reasons: WAF blocks, proof-of-work challenges, client-side rendering, login walls. |
| Railway GraphQL API | postgres-disk | `https://backboard.railway.com/graphql/v2`, project-volumes query. Returns `sizeMB` and `currentSizeMB` for `postgres-volume`. |

## Environment

`src/env.ts` is the only module that reads `process.env`, except `LOG_LEVEL` in
`src/logger.ts`.

| variable | purpose |
|---|---|
| `DATABASE_URL` | Postgres connection. Required; boot fails without it. |
| `PORT` | Dashboard port, default 3000. |
| `DISCORD_WEBHOOK_<NAME>` | Each becomes a channel named `<name>` lowercased. |
| `DISCORD_WEBHOOK_URL` | Fallback when a named channel does not resolve. |
| `RAILWAY_API_TOKEN` | Injected by Railway. Read by postgres-disk via `AdapterContext.platform`. |
| `RAILWAY_PROJECT_ID` | Injected by Railway. Identifies the project for the volumes query. |
| `RAILWAY_ENVIRONMENT_ID` | Injected by Railway. Carried on `platform`, currently unused. |
| `RAILWAY_PUBLIC_DOMAIN` | Injected by Railway. Builds the public URL alerts link back to. |
| `PUBLIC_URL` | Manual override for that URL. Not set. |
| `MONITORS_DIR` | Where monitor YAML lives. Defaults to `monitors`. Not set. |
| `LOG_LEVEL` | `debug`\|`info`\|`warn`\|`error`. Defaults to `info`. Not set. |

**Platform credentials reach adapters through `AdapterContext.platform`, never
through monitor YAML.** The registry persists interpolated config into
`monitors.config`, so a secret named in YAML ends up in the database in
plaintext — which is exactly what happened to a third-party API key before the
teardown. Verified after the change: a search of `monitors.config` for the token
value returns no rows, and a sweep of all 39 text and json columns in `public`
returns no rows either.

`CONFIG_VAR_ALLOWLIST` in `src/env.ts` still exists as the mechanism for
YAML-interpolated values, but **no remaining monitor uses it**, and given the
plaintext-persistence problem, nothing secret should be added to it.

## Operational notes

- Deploys run `railway up --service command-center --ci` from a local checkout,
  **not** from the GitHub remote. Pushing to GitHub does not deploy, and
  deploying does not push. Both need doing.
- Railway project `command-center`, service `command-center`, database
  `Postgres` on volume `postgres-volume` (50 GB provisioned, 14.12 GB used).
- The Railway CLI binary is not persistent between sessions and must be
  reinstalled; its login usually survives.
- `npm run build` runs `tsc` then `scripts/check-pages.mjs`, which renders every
  page and parse-checks the client-side script blocks. Client JS is built inside
  server-side template literals, so an escape can be consumed at build time and
  produce a page that compiles and is dead on arrival.
- **Clear `dist/` before trusting a build.** During teardown `check-pages`
  reported a deleted page as passing, because a stale compiled copy was still
  sitting in `dist/`.

## What was removed

Fourteen monitors, 47 tables, ~17.8 million rows, the offline Python wallet
pipeline and 166 MB of intermediates. The database went from 10 GB to 27 MB.

- The complete inventory of the old system is `archive/docs/SPINE.md`.
- Cohort-defining tables were exported to CSV in `archive/data/`.
- Environment and account details are in `archive/SECRETS-INVENTORY.md`.
- Everything as it stood before teardown is at the git tag `pre-teardown`,
  pushed to `git@github.com:VYOU-admin/command-center.git`.

`CLAUDE.md` instructs that nothing under `archive/` is read unless asked for by
filename: it describes a system that no longer exists and will mislead you about
what currently does.

`FAILURE_MODES.md` at the repo root is NOT archived. It is the standing
failure-mode list and still applies.
