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

### Level features leak; time features don't

Level-based features cannot answer the question they look like they answer.
"Trades to reach 85 SOL" does not predict graduation, because reaching 85 SOL
*is* graduating — the first pass at this data showed graduated tokens with
`peak_sol` of exactly 85.01 at p50, p75, p90 and max, which is the threshold
restating itself. Anything computed from it measures the outcome definition.

`pump_velocity_summary.snapshots` is the counterpart that does not leak: curve
state at a *fixed age* — SOL, cumulative trades, price, and market cap at 30s,
60s and 120s. A fixed-time cut cannot encode the outcome, and it is also the
only shape that answers return-from-entry, which needs a price at a time rather
than a time at a price.

Snapshots past where observation stopped come back flagged `censored` with null
values, and `observed_to_seconds` records how far each token was actually
watched. Both exist so that not-looked-at never reads as flatlined.

Price and market cap are SOL-denominated. A return measured against SOL isolates
the token's own move from whatever SOL did in the same minutes; going to USD
later needs only a rate at the timestamp, while the reverse loses precision.
Deriving them needs the token side of the curve, so the decoder reads
`virtual_token_reserves` and `token_total_supply` as well as the SOL reserves —
samples written before that landed have null price and cannot be backfilled.

[marino]: https://arxiv.org/abs/2602.14860

### Sampling, and why there is a control group

At ~48.7 launches/minute measured and a hard cap of 100 concurrent RPC
subscriptions, everything cannot be instrumented. Every launch gets a free t=0
row; a subset gets a bonding-curve subscription:

- **initial mcap above the 30 SOL default** — the strongest t=0 predictor in the
  survival literature (Cox HR 4.51)
- **an advertised Telegram** — an 8.94x graduation lift ([GRW study][grw])
- **a random 15% of everything else** — the control group

The control group is not optional. Instrumenting only tokens that pass a filter
produces a dataset that can describe those tokens and nothing else, which makes
the filter unfalsifiable: you could never measure what it threw away. Membership
is a hash of the mint rather than a coin flip, so it stays reproducible.

The observation window is 3 minutes rather than longer specifically to fund that
control group — the snapshots are taken at 30/60/120s, so a longer window bought
tail nobody reads at the cost of slots that answer whether the filter works.

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

## The oil price monitor

Scrapes small business heating-oil sites every 15 minutes and stores every
quoted price, append-only. Every scrape writes a row for every source and every
gallon band whether or not anything moved — the unchanged rows are the history.
A table that only recorded changes could tell you a price was $4.58 on two dates
but not whether it held steady in between or simply was not checked.

| table               | holds                                                    |
| ------------------- | -------------------------------------------------------- |
| `oil_observations`  | append-only, one row per source per gallon band per scrape |
| `oil_price_history` | vendor-published history, backfilled once, keyed by date  |
| `oil_source_state`  | per-source failure streaks and backfill status            |
| `oil_alert_state`   | change-alert and daily-digest bookkeeping                 |

### Sources fail independently

Each site is scraped inside its own try/catch, so one changing its HTML cannot
stop the others storing. The run only fails when *every* source fails.

That creates a gap the spine cannot see. The registry counts failures per
**monitor**, so a single permanently broken scraper would sit inside runs that
report success and never raise anything — the exact silent failure the rest of
this project is built against. `oil_source_state` therefore mirrors the spine's
failure-streak logic one level down, per source, and alerts to the **system**
channel after three consecutive failures. Price alerts go to `oil`; a broken
parser is an operational problem, not a price update.

### A wrong price is worse than a missing one

Parsers throw rather than return something plausible. A null or a zero would
flow into the comparison table, the change alert, and the history, and nothing
downstream could tell it from a real number. So:

- every field that must exist is asserted, and its absence is an error
- prices are range-checked against $0.50–$25/gal, which catches a layout change
  making a regex match some other number on the page
- `price_per_gallon` is `not null check (> 0)` at the database level too
- a source that breaks stores **nothing** and says so

The distinction that matters is between *broken* and *legitimately empty*. A
missing price **table** means the layout changed and the parser is now guessing,
so it throws. A price table present but holding no rows is a dealer who
currently lists no prices, which really happens — so it yields no rows rather
than taking down the scrape. Every dealer on a page being empty throws again,
because that is not ten coincidences.

Vendor data is not always sane, either. McKinley's own historical table contains
`9/31/24`, a date that does not exist, and a `7/30/90` that a two-digit year
pivots into 1990 — decades before the table begins. Both are reported and
skipped rather than coerced: there is no defensible way to guess whether 9/31
meant the 30th or the 1st, and inventing one would fabricate a published price.

### Scraping considerately

These are small businesses on shared hosting. The monitor identifies itself with
a real user agent including a link back to this repo, spaces requests three
seconds apart *across the whole run* rather than per source, retries twice, and
gives up on a hang rather than holding a socket open. A full scrape is three
requests, so all sources together are touched roughly 288 times a day.

Two sites needed more than a fetch. **McKinley** is a 1990s frameset whose
homepage contains no prices at all, only `<frame>` tags — the price and the
historical table are separate child documents whose filenames contain spaces.
**CashHeatingOil** is zip-driven, and the zip's URL slug is resolved by posting
the site's own lookup form and following the redirect rather than guessing that
`06716` maps to `wolcott_ct`. A guess would break silently the day a slug differs
from the town name.

`LISTING ID` there is a **page**-level value, one per zip search, not per dealer.
Each listing carries a hidden `dealerid` instead, and that is what gets stored:
without it, the dealer list reordering is indistinguishable from a price change
and would fire a false alert.

### Alerts

One alert per scrape, across all sources, not one per site — the question is
"did anything move anywhere". Nothing moving is silent.

The change alert body is **only what moved**: company, old → new, direction, and
the delta. Company names link to the vendor. Everything else — the full ranked
list, every gallon band, every check — rides along as a CSV attachment covering
a rolling 24 hours, cheapest first within each timestamp. Discord webhooks cap a
request at 8MB, so an oversize attachment is truncated on a line boundary with
the truncation written into the file itself; a clipped CSV can never be mistaken
for a complete one.

The daily digest at 07:00 `America/New_York` is different on purpose. It is
meant to be read cold, so it carries the full ranked list rather than a diff,
and it fires whether or not anything moved.

On listing sites the dealer name is hidden, so a company is identified by a
distinctive phrase from its own blurb — matched on the phrase rather than the
whole paragraph, so the dealer editing the rest of it does not silently drop the
tag. `FJBOil` is currently tagged this way across all seven zips, under three
different dealer ids.

### Retention

Prices move about once a day but are sampled every 15 minutes, so roughly 95 of
every 96 rows per quote restate the one before it.

Rows inside the last 48 hours are kept whole — that is what the attached CSV
reads, and what you want when investigating something that just happened. Past
that horizon each quote keeps, per day: the first row of every distinct price
run, the row holding the daily high, the row holding the daily low, and the
day's last row.

Nothing is lost by dropping the rest. A price with a start and an end is a step
function, so the surviving change points reconstruct the series *exactly* rather
than approximating it, and the daily extremes are kept as rows in their own
right. Measured reduction on a synthetic day: 47 rows to 3, with both distinct
prices preserved.

`oil_price_history` — McKinley's own daily series back to 2008 — is never
touched by this and cannot be; it is keyed by date, already one row per day, and
irreplaceable.

### Which vendors are scraped, and which are not

Ten sources are live: the CashHeatingOil listing site across seven zips, plus
nine dealers who publish a price on their own site.

Their markup shares nothing — Elementor, Gantry, hand-rolled templates, a 1990s
frameset — but the rendered *text* is near-identical: an anchor heading followed
by gallon quantities and prices. So extraction is anchored on text and described
in YAML, and a new vendor with that shape is added without touching code. Text
also survives the change these sites actually make, which is a theme update.

Six are in the config but disabled, each with its reason recorded. They stay
listed rather than deleted so the roster remains a complete record of what was
investigated, and the `blocked` kind throws if one is ever enabled so none can
be switched on by accident:

| source | why not |
| ------ | ------- |
| Forbes Fuel Oil | BotStopper proof-of-work challenge on every path |
| Hurricane Energy | price comes from a third-party `api.dropletfuel.com` widget |
| Tony's Oil | price rendered client-side; served HTML says "Loading…" |
| Deliver Me Fuel | price is behind a customer login |
| Federal Oil | no company website; only directories and aggregators |
| IT Energy | no such Connecticut dealer could be identified |

Armstrong is enabled but for **propane only**: their heating oil price renders
as `$-.--- Please Call`, so there is no number to read, and inventing one from
their propane table would be worse than recording nothing.

Nothing here defeats a bot protection. Forbes is the only source that has one,
and it is off.

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

## Alert routing

Alerts are split by **kind**, not by monitor.

Failure, recovery, and staleness alerts go to the `system` channel from every
monitor, unconditionally. Routing an outage to the monitor's own topic channel
would scatter operational failures across topic feeds, and the crypto channel is
the wrong place to learn that the crypto monitor stopped running.

Content alerts — a token entering the top N, say — go to whatever channel that
monitor's YAML names:

```yaml
alerts:
  discord_on_consecutive_failures: 3
  channel: crypto # -> DISCORD_WEBHOOK_CRYPTO
```

`channel` defaults to `system`. It is a name, not a mapping: any environment
variable called `DISCORD_WEBHOOK_<NAME>` becomes channel `<name>`, so adding a
channel is setting a variable and naming it in YAML. There is no list in code to
update, which is the same promise the adapter registry makes for sources.

When a named channel has no webhook of its own, delivery falls back to
`DISCORD_WEBHOOK_URL` rather than going silent — a forgotten variable should
misroute an alert, not swallow it.

That fallback is the reason routing is reported in three places: the boot log,
`/health` under `alert_routing`, and a warning on every send that uses it. A
misrouted alert is a **silent failure of the worst kind** — it is delivered
successfully, returns 204, and logs as delivered. It just arrives somewhere
nobody is reading. Nothing on the sending side can tell, so the mapping has to
be inspectable rather than discoverable only by watching channels.

`npm run alert-test` posts one message to each channel saying which variable
delivered it, which is the only way to actually prove routing end to end. It
does not touch Postgres, so it still works when the database is down — which is
when alerting matters most.

## Endpoints

| route            | purpose                                                       |
| ---------------- | ------------------------------------------------------------- |
| `/`              | dashboard — monitor status plus the last 24h, newest first     |
| `/health`        | per-monitor last successful run, status, error, next run due   |
| `/api/monitors`  | registry as JSON, including the last 10 runs per monitor       |
| `/api/records`   | records as JSON; `?hours=`, `?limit=`, `?monitor=`             |

## Environment

Nothing sensitive is committed; it all comes from the environment.

| variable                   | required | notes                                          |
| -------------------------- | -------- | ---------------------------------------------- |
| `DATABASE_URL`             | yes      | refuses to boot without it                     |
| `DISCORD_WEBHOOK_SYSTEM`   | no       | failure/recovery alerts from every monitor     |
| `DISCORD_WEBHOOK_<NAME>`   | no       | any channel a monitor's `alerts.channel` names |
| `DISCORD_WEBHOOK_URL`      | no       | fallback for a channel with no webhook of its own |
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
