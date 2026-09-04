# SPINE — system inventory

Every figure below came from a live query against the production database on a
fresh connection at the timestamp shown, or from reading the repository at commit
`74e0580`. Nothing is carried over from `PROJECT_STATE.md`, which does not exist
in this tree, or from any other document.

- **Database read at:** 2026-09-04T00:11:02Z, 00:11:43Z, 00:12:35Z (three sweeps)
- **Repo state:** branch `main`, commit `74e0580`
- **Database size:** 10 GB (`pg_database_size`), 56 base tables in `public`

Where the repository and the database disagree, both are stated and neither is
presented as the truth.

---

## 1. MONITORS

Sixteen monitor YAML files, sixteen adapter types, and sixteen rows in the
`monitors` table. Every adapter type has a YAML and every YAML source has an
adapter — no orphans in either direction. The `enabled` flag agrees between YAML
and database for all sixteen.

`last success` is `max(started_at) where status='success'` from `monitor_runs`.
Note the status vocabulary is `success`/`failure` — there is no `ok` status;
49,373 successes and 2,124 failures across 51,495 recorded runs.

### Enabled (13)

| monitor | schedule | chain | reads | writes | alerts to | last success (UTC) | last duration | failures / runs |
|---|---|---|---|---|---|---|---|---|
| `coindesk` | 1h | — | CoinDesk RSS | `records` | `crypto` | 2026-09-03T23:33:18Z | 126 ms | 0 / 291 |
| `group1-new-token` | 20m | robinhood | Robinhood RPC, `wallet_pnl`, `wallet_groups` | `group1_token_alerts`, `group1_token_pool`, `group1_cycle_stats`, `group1_new_token_cursor`, `token_pool_first` | `newtoken` | 2026-09-04T00:06:28Z | 187,410 ms | 12 / 79 |
| `group2-new-token` | 5m | robinhood | Robinhood RPC, `wallet_pnl`, `wallet_groups` | `group2_token_alerts`, `group2_token_pool`, `group2_cycle_stats`, `group2_new_token_cursor`, `token_pool_first` | `newtoken` | 2026-09-04T00:05:53Z | 39,128 ms | 7 / 369 |
| `mos-p1-test` | 15m | solana | Helius, `wallet_tags`, `mos_p1_test_batch` | `mos_p1_balance_snapshots`, `mos_p1_activity`, `mos_p1_mint_alerts`, `mos_p1_test_stats` | `newtoken` | 2026-09-04T00:03:18Z | 45,761 ms | 1 / 79 |
| `mos-price` | 5m | solana | DexScreener pair | `mos_price_readings`, `mos_price_high`, `mos_price_heartbeat`, `mos_price_stats` | `mos-price-alert` | 2026-09-04T00:10:14Z | 39 ms | 0 / 302 |
| `new-token-watch` | 15m | robinhood | Robinhood RPC, `wallet_pnl`, `wallet_clusters` | `new_token_hits`, `new_token_cycle_stats`, `new_token_cursor`, `token_pool_first` | `newtoken` (**suppressed**) | 2026-09-03T23:50:18Z | 196,146 ms | 53 / 195 |
| `nft-mints` | 5m | robinhood + solana | Robinhood RPC, Helius | `nft_mints`, `nft_mint_cursor`, `nft_mint_filter_stats`, `nft_mint_daily` | `system` | 2026-09-04T00:05:33Z | 77,107 ms | 27 / 885 |
| `oil-prices` | 15m | — | 9 vendor sites (7 more disabled) | `oil_observations`, `oil_price_history`, `oil_rank_state`, `oil_source_state`, `oil_alert_state` | `oil` | 2026-09-04T00:08:54Z | 57,918 ms | 1 / 886 |
| `postgres-disk` | 15m | — | `pg_database_size` | `disk_usage_samples`, `disk_alert_state` | `system` | 2026-09-04T00:04:04Z | 188 ms | 0 / 871 |
| `pumpfun-early-alert` | 30s | solana | `early_tokens`, `early_snapshots` | `early_alerts` | `crypto_early` | 2026-09-04T00:11:24Z | 50 ms | 0 / 22,454 |
| `pumpfun-early-window` | 30s | solana | pumpportal WS, Solana WS | `early_tokens`, `early_snapshots`, `early_token_wallets` | `system` | 2026-09-04T00:11:09Z | 1,465 ms | 1,429 / 23,283 |
| `solana-balance-scan` | 1h | solana | Helius, `wallet_pnl`, `mos_wallet_groups` | `solana_balance_scans`, `solana_scan_stats`, `wallet_pnl_tokens` | `newtoken` | 2026-09-03T23:59:03Z | 626 ms | 1 / 28 |
| `token-balance-scan` | 10m | robinhood | Robinhood RPC, `wallet_pnl_tokens` | `token_balance_scans`, `balance_scan_cursor` | `system` | 2026-09-04T00:01:05Z | 231,786 ms | 0 / 226 |

### Disabled (3)

| monitor | schedule | last success (UTC) | state |
|---|---|---|---|
| `pumpfun-launches` | 30s | 2026-08-25T11:45:01Z | **361 consecutive failures**, `failure_alert_sent = true`. Last error: "no pump.fun launch events for 21611s (threshold 300s); the stream is connected but silent". 590 failures / 1,327 runs. |
| `pumpfun-outcomes` | 10m | 2026-08-26T00:17:09Z | Clean stop, no error. Depends on `pumpfun-launches`. 1 failure / 152 runs. |
| `solana-tokens` | 1h | 2026-08-25T23:25:38Z | Clean stop. Discovery source is `pumpfun-launches`, which is dead. 2 failures / 70 runs. |

### Runtime pressure against the 300 s guard

`MAX_RUN_MS` is 5 minutes (`src/scheduler.ts`), applied as
`Math.min(config.scheduleMs, MAX_RUN_MS)` and enforced only by an AbortSignal the
adapter must honour. Three monitors are running close to it:

    token-balance-scan   231,786 ms   (77% of the ceiling)
    new-token-watch      196,146 ms   (65%)
    group1-new-token     187,410 ms   (62%)

An aborted run reaches neither `persist()` nor the stats row unless the adapter
writes one at cycle start, which only `mos-p1-test` and the group monitors do.

---

## 2. TABLES

All 56 base tables in `public`, with exact `count(*)` and `pg_total_relation_size`
at 2026-09-04T00:11Z. "Read"/"Written" are determined by grepping `src/` for SQL
referencing the table — they describe the TypeScript spine only. Several tables
are populated by the offline Python pipeline, which is not in this repository;
those show as read-but-never-written and are annotated.

| table | rows | size | purpose | read by | written by |
|---|---|---|---|---|---|
| `balance_scan_cursor` | 1 | 64 kB | Cursor for the Robinhood balance sweep | token-balance-scan | token-balance-scan |
| `disk_alert_state` | 1 | 64 kB | Last disk alert level and time | postgres-disk | postgres-disk |
| `disk_usage_samples` | 871 | 248 kB | Disk usage time series | postgres-disk | postgres-disk |
| `early_alerts` | 8,300 | 4,136 kB | Pump.fun early alerts raised | pumpfun-early-alert/window | pumpfun-early-alert |
| `early_snapshots` | 7,606,446 | **6,176 MB** | Curve snapshots per tracked token | early-window-panel, both pumpfun-early monitors | pumpfun-early-window |
| `early_token_wallets` | 7,103,055 | **2,855 MB** | Wallets seen per early token | **nothing** | pumpfun-early-window |
| `early_tokens` | 370,195 | 329 MB | Tracked pump.fun launches | early-window-panel, both pumpfun-early monitors | pumpfun-early-window |
| `group1_cycle_stats` | 79 | 376 kB | Per-cycle diagnostics | **nothing** | group1-new-token |
| `group1_new_token_cursor` | 1 | 64 kB | Last swept block | group1-new-token | group1-new-token |
| `group1_token_alerts` | 1,957 | 480 kB | High-water mark per token | group1-new-token | group1-new-token |
| `group1_token_pool` | 1,957 | 592 kB | Which pool was linked | **nothing** | group1-new-token |
| `group2_cycle_stats` | 367 | 488 kB | Per-cycle diagnostics | **nothing** | group2-new-token |
| `group2_new_token_cursor` | 1 | 64 kB | Last swept block | group2-new-token | group2-new-token |
| `group2_token_alerts` | 1,678 | 400 kB | High-water mark per token | group2-new-token | group2-new-token |
| `group2_token_pool` | 1,654 | 520 kB | Which pool was linked | **nothing** | group2-new-token |
| `monitor_runs` | 51,495 | 11 MB | Run history | registry | registry |
| `monitors` | 16 | 320 kB | Monitor registry and resolved config | records, registry | registry |
| `mos_p1_activity` | 2,425 | 1,472 kB | Transactions for flagged MOS-P1 wallets | **nothing** | mos-p1-test |
| `mos_p1_balance_snapshots` | 1,175,893 | **454 MB** | Every token balance for the 74 MOS-P1 wallets, per cycle | mos-p1-test | mos-p1-test |
| `mos_p1_mint_alerts` | 503 | 144 kB | High-water mark per mint | mos-p1-test | mos-p1-test |
| `mos_p1_test_batch` | 74 | 64 kB | Which tagged wallets are read | mos-p1-test | **nothing** (seeded by hand) |
| `mos_p1_test_stats` | 80 | 72 kB | Per-cycle diagnostics | **nothing** | mos-p1-test |
| `mos_price_heartbeat` | 1 | 32 kB | Last hourly heartbeat sent | mos-price | mos-price |
| `mos_price_high` | 1 | 32 kB | All-time-high price | mos-price | mos-price |
| `mos_price_readings` | 303 | 120 kB | MOS price series | mos-price | mos-price |
| `mos_price_stats` | 303 | 80 kB | Per-cycle diagnostics | **nothing** | mos-price |
| `mos_wallet_groups` | 694 | 240 kB | MOS group 1/2/3 membership | server, solana-balance-scan | **nothing** (offline pipeline) |
| `new_token_cursor` | 1 | 64 kB | Last swept block | new-token-watch | new-token-watch |
| `new_token_cycle_stats` | 77 | 64 kB | Per-cycle diagnostics | **nothing** | new-token-watch |
| `new_token_hits` | 29,341 | 14 MB | Detected buys of new tokens | **nothing** | new-token-watch |
| `nft_mint_cursor` | 2 | 64 kB | Per-chain cursor | nft-mints | nft-mints |
| `nft_mint_daily` | **0** | 32 kB | Daily aggregates | **nothing** | nft-mints |
| `nft_mint_filter_stats` | 57 | 64 kB | Collection filter diagnostics | nft-mints | nft-mints |
| `nft_mints` | 634,366 | 270 MB | NFT mint events | nft-mints | nft-mints |
| `oil_alert_state` | 1 | 64 kB | Last oil alert/digest | oil-prices | oil-prices |
| `oil_observations` | 59,108 | 63 MB | Raw vendor price reads | oil-panel, oil-prices | oil-prices |
| `oil_price_history` | 6,584 | 968 kB | Normalised price history | oil-panel | oil-prices |
| `oil_rank_state` | 21 | 64 kB | Vendor ranking state | oil-prices | oil-prices |
| `oil_source_state` | 10 | 64 kB | Per-source health | oil-panel, oil-prices | oil-prices |
| `pump_curve_samples` | 213,404 | 83 MB | Bonding-curve samples | pumpfun-outcomes, pumpfun-panel | pumpfun-launches, pumpfun-outcomes |
| `pump_deployer_stats` | 6,478 | 3,776 kB | Per-deployer aggregates | pumpfun-panel | pumpfun-outcomes |
| `pump_launches` | 19,422 | 21 MB | Pump.fun launches | pumpfun-outcomes, pumpfun-panel, solana-tokens | pumpfun-launches, pumpfun-outcomes |
| `pump_velocity_summary` | 6,001 | 5,000 kB | Velocity cohort summary | pumpfun-outcomes | pumpfun-outcomes |
| `records` | 217 | 288 kB | Generic feed records (RSS) | records, registry | records |
| `solana_balance_scans` | 25,620 | 8,400 kB | MOS balances per wallet per hour | server, solana-balance-scan | solana-balance-scan |
| `solana_scan_stats` | 30 | 32 kB | Per-scan diagnostics | **nothing** | solana-balance-scan |
| `solana_token_observations` | 34,292 | 12 MB | Solana token metric history | solana-panel | solana-tokens |
| `solana_tokens` | 1,593 | 944 kB | Scored Solana tokens | solana-panel, solana-tokens | solana-tokens |
| `solana_top_membership` | 109 | 80 kB | Top-N membership over time | solana-tokens | solana-tokens |
| `token_balance_scans` | 91,145 | 27 MB | Robinhood balances per wallet | server, token-balance-scan | token-balance-scan |
| `token_pool_first` | 24,377 | 7,256 kB | First-seen pool per token | all three new-token monitors | all three new-token monitors |
| `wallet_clusters` | 7,811 | 4,056 kB | Wallet cluster assignments (1,466 clusters) | cate-pnl, new-token-watch, server, watchlist | **nothing** (offline pipeline) |
| `wallet_groups` | 9,448 | 2,864 kB | Robinhood group 1/2/3 membership | cate-pnl, server, watchlist | **nothing** (offline pipeline) |
| `wallet_pnl` | 11,811 | 11 MB | Per-wallet PnL per token | cate-pnl, nft-mints, server, solana-balance-scan, watchlist | server (tag column only); PnL rows from the offline pipeline |
| `wallet_pnl_tokens` | 7 | 32 kB | Per-token metadata and price | server, token-balance-scan | solana-balance-scan |
| `wallet_tags` | 75 | 32 kB | Manual wallet tags | mos-p1-test, server | server |

### Written but never read — 12 tables

`early_token_wallets` (7,103,055 rows / 2,855 MB), `new_token_hits` (29,341 /
14 MB), `mos_p1_activity` (2,425), `group1_cycle_stats`, `group1_token_pool`,
`group2_cycle_stats`, `group2_token_pool`, `mos_p1_test_stats`,
`mos_price_stats`, `new_token_cycle_stats`, `solana_scan_stats`,
`nft_mint_daily`.

Most are diagnostic tables read by hand during investigations rather than by
code, which is a legitimate purpose. The two that matter by size are
`early_token_wallets` at 2,855 MB and `new_token_hits` at 14 MB.
**`nft_mint_daily` has 0 rows despite `nft-mints` having run 885 times** — the
aggregation that fills it either never runs or always produces nothing.

### Read but never written by this repo — 4 tables

`mos_wallet_groups`, `wallet_clusters`, `wallet_groups`, `mos_p1_test_batch`.
The first three are produced by the offline Python pipeline; `mos_p1_test_batch`
was seeded by hand. None of these is a defect, but nothing in the deployed
service can refresh them.

### Note on the grep

`changes.ts` mentions `wallet_pnl` only in a comment explaining why it no longer
reads it; it is not a reader. `solana-balance-scan.ts:107` genuinely does read
`wallet_pnl`, for the wallet list.

---

## 3. ALERTS

Channels resolve from `DISCORD_WEBHOOK_<NAME>` environment variables, lowercased
(`src/env.ts`), plus one alias entry mapping `MOS_PRICE_CHECK` →
`mos-price-alert`. `DISCORD_WEBHOOK_URL` is a fallback, not a channel. Webhook
values are not reproduced here.

| channel | monitors sending |
|---|---|
| `newtoken` | group1-new-token, group2-new-token, mos-p1-test, solana-balance-scan, new-token-watch (suppressed) |
| `system` | nft-mints, postgres-disk, pumpfun-early-window, token-balance-scan, plus every monitor's failure/recovery alerts |
| `crypto` | coindesk, pumpfun-launches (disabled), pumpfun-outcomes (disabled) |
| `crypto_early` | pumpfun-early-alert |
| `oil` | oil-prices |
| `mos-price-alert` | mos-price |

### Content alert types

| alert | trigger | dedupe / high-water rule | last fired (UTC) |
|---|---|---|---|
| Group 1 new-token buys | A Group 1 wallet buys a token whose pool is younger than `max_pool_age_minutes` (60) | Distinct buyer count strictly above `group1_token_alerts.last_alerted_count`; only lines actually sent raise the mark | 2026-09-04T00:09:36Z |
| Group 2 new-token buys | Same, for wallets with `realized_pnl_usd ≥ 1000` | `group2_token_alerts`, same rule | 2026-09-04T00:12:08Z |
| MOS-P1 cohort activity | A mint held by ≥ 2 cohort wallets, not denylisted, whose holder count exceeds its all-time high | `mos_p1_mint_alerts.last_alerted_count`; first cycle seeds silently | 2026-09-03T23:48:13Z |
| MOS Group 1 balance changes | Any Group 1 wallet whose MOS balance differs between two consecutive `status='ok'` scans | None — every changed wallet is listed each hour. `no_account` transitions are excluded, not reported as sales | not separately recorded; last scan 2026-09-03T23:59:03Z |
| MOS price heartbeat | Hourly, on the 5-minute price monitor | `mos_price_heartbeat.last_sent_at` | 2026-09-04T00:05:09Z |
| MOS all-time high | Price above `mos_price_high.high_usd` | The stored high itself | 2026-09-03T13:55:20Z (0.002825 USD, mcap 2,670,719) |
| Oil price change / daily digest | Vendor price change; digest at 07:00 America/New_York | `oil_alert_state` | 2026-09-03T23:21:46Z |
| Disk usage | Above `warn_pct` 70 / `critical_pct` 85 | `disk_alert_state.last_level` | 2026-08-28T05:26:09Z (level still `critical`) |
| Pump.fun early alert | Curve/buy-share thresholds | `early_alerts` | 2026-09-04T00:10:49Z |
| New-token-watch hits | Cohort buys of new tokens | **`send_alerts: false`** — rendered, never sent | never |

Failure and recovery alerts are raised by the spine after
`discordOnConsecutiveFailures: 3` and always go to `system`.

---

## 4. WALLET COHORTS

### `wallet_tags` — 75 rows total

| tag | chain | wallets |
|---|---|---|
| `MOS-P1` | solana | 74 |
| `overlap-test` | robinhood | 1 |

`MOS-P1` is consumed by `mos-p1-test`, intersected with `mos_p1_test_batch`
(74 rows — the full cohort as of 2026-09-03). `overlap-test` is a single
leftover row consumed by nothing.

### `mos_wallet_groups` — 694 rows, all MOS / solana

Derived 2026-09-02T20:01:12Z from "MOS pool swaps + mint transfers, window
2026-08-31T16:00Z..now".

| group | wallets |
|---|---|
| 1 | 267 |
| 2 | 406 |
| 3 | 21 |

Consumed by `solana-balance-scan` (group 1 only, for the balance-change alert)
and by the dashboard. **`wallet_pnl` holds 854 MOS wallets against 694 grouped,
so 160 MOS wallets have no group assignment.**

### `wallet_groups` — 9,448 rows, all Robinhood

Last derived 2026-09-02T03:13:14Z.

| token | g1 | g2 | g3 |
|---|---|---|---|
| AI | 320 | 814 | 17 |
| BONER | 201 | 492 | 28 |
| ODYSSEUS | 266 | 406 | 40 |
| PONS | 242 | 792 | 70 |
| QUANT | 451 | 837 | 89 |
| ROBINCAT | 1,511 | 2,535 | 337 |

Consumed by `group1-new-token`, `group2-new-token` and the dashboard. **CATE,
CYBERLEEK and NTF have `wallet_pnl` rows but no `wallet_groups` rows.**

### `wallet_clusters` — 7,811 rows in 1,466 clusters

Created 2026-09-01T14:15:12Z. Consumed by `new-token-watch` and the dashboard.

---

## 5. TOKENS

`wallet_pnl_tokens` holds 7 rows; `wallet_pnl` holds 10 distinct tokens. Three
tokens have PnL rows but no metadata row.

| token | chain | venue | wallets in `wallet_pnl` | with buy quantities | metadata row | completeness |
|---|---|---|---|---|---|---|
| PONS | robinhood | Uniswap v3 | 1,046 | 1,046 | yes | Complete. 5,663 in-window swaps, decode check 476/476. |
| AI | robinhood | Uniswap v4 | 1,163 | 1,163 | yes | Complete. Decode check 318/324. |
| QUANT | robinhood | Uniswap v4 | 1,357 | 1,357 | yes | Complete. Decode check 613/649. |
| BONER | robinhood | Uniswap v4 | 718 | 718 | yes | Complete. Decode check 222/233. |
| ODYSSEUS | robinhood | Uniswap v4 | 681 | 681 | yes | Complete. Decode check 206/234. |
| ROBINCAT | robinhood | Uniswap v4 | 4,657 | 4,657 | yes | **Partial by policy** — `threshold_binding: true`, 5,325 of 7,554 admitted against a $2M mcap ceiling. Decode check 1,238/1,885. |
| MOS | solana | Meteora DYN2 (via DBC) | 854 | 684 | yes | Backfill complete; no window/boundary metadata recorded (all window fields null). 170 wallets have no buy quantity. |
| CATE | solana | — | 556 | **0** | **no** | Partial. No buy quantities, no metadata row. |
| CYBERLEEK | solana | — | 268 | **0** | **no** | Partial. Same. |
| NTF | robinhood | — | 511 | **0** | **no** | Partial. Same. Never verified. |

Balance scanning covers 6 Robinhood tokens plus MOS:

    token_balance_scans   AI 9,930 rows / 320 wallets    last 2026-09-04T00:01:05Z
                       BONER 6,394 / 201                 last 2026-09-04T00:01:05Z
                    ODYSSEUS 8,701 / 266                 last 2026-09-03T22:48:49Z
                        PONS 7,260 / 242                 last 2026-09-03T22:48:49Z
                       QUANT 13,530 / 451                last 2026-09-03T23:12:31Z
                    ROBINCAT 45,330 / 1,511              last 2026-09-03T23:47:10Z
    solana_balance_scans  MOS 25,620 / 854               last 2026-09-03T23:59:04Z
                              (latest scan: 685 ok, 169 no_account)

`token_balance_scans` splits into `scan` 88,554 and `window_close` 2,991 rows.
The cursor currently sits at BONER, sweep 30.

---

## 6. WEB SURFACES

Served by `src/web/server.ts` on `PORT` (default 3000).

| route | method | reads |
|---|---|---|
| `/` | GET | `monitors`, `records`, plus the oil, pumpfun, early-window and solana panels |
| `/cate` | GET | `wallet_pnl`, `wallet_pnl_tokens`, `wallet_groups`, `mos_wallet_groups`, `wallet_clusters`, `wallet_tags`, `token_balance_scans`, `solana_balance_scans` |
| `/health` | GET | `monitors`, plus Discord channel resolution status |
| `/api/monitors` | GET | `monitors` |
| `/api/records` | GET | `records` |
| `/api/wallet-tag` | POST | writes `wallet_tags` |
| `/api/tag-rename` | POST | writes `wallet_tags` |
| `/api/token-tag` | POST | writes `wallet_pnl` |

A 404 lists `['/', '/cate', '/health', '/api/monitors', '/api/records']`.

Panel modules: `oil-panel.ts`, `pumpfun-panel.ts`, `early-window-panel.ts`,
`solana-panel.ts`, `cate-pnl.ts`, `views.ts`.

---

## 7. EXTERNAL DEPENDENCIES

| service | used by | measured ceiling |
|---|---|---|
| Robinhood chain RPC `rpc.mainnet.chain.robinhood.com` (chain 4663) | group1/group2-new-token, new-token-watch, nft-mints, token-balance-scan | 1,000 topic selectors max per `eth_getLogs`. 500 addresses over 2,000 blocks times out; 200 addresses over 10,000 blocks is reliable. Pacing at 4,000 ms gave 0/20 refusals, 2,500 ms gave 6/20, 800 ms gave 15/20. `eth_getLogs` latency is flat in block range — ~0.3 s median at 1k, 5k and 20k blocks, 0 errors in 15 attempts. |
| Helius `mainnet.helius-rpc.com` | mos-p1-test, solana-balance-scan, nft-mints | **Batch ceiling between 28 and 32 sub-calls**: 20/24/28 return HTTP 200; 32/40/100/148 return HTTP 429 in ~20 ms, and 40 stayed refused across three attempts with 12 s backoff. A refusal poisons the next few seconds. 8 chunks of 20 spaced 5 s measured 8/8 clean in 40.7 s. **No usage API and no credit headers** — `/v0/usage`, `/v0/credits`, `/v0/health` all return `Method not found`; the dashboard is the only source of credit figures. |
| DexScreener API | group1/group2-new-token, mos-p1-test, mos-price | Batch pairs endpoint caps at 30 addresses. The tokens endpoint has no batch form — one request per mint. Documented 300 req/min. Returns HTTP 403 to `curl` (bot protection), so links cannot be verified programmatically. Pair addresses are returned lowercased in `url` but mixed-case in `pairAddress`. |
| pumpportal.fun WebSocket | pumpfun-early-window, pumpfun-launches | Silent-stream detection at 300 s; reconnect at 120 s. |
| `api.mainnet-beta.solana.com` WebSocket | pumpfun-early-window, pumpfun-launches | Same watchdog. |
| CoinDesk RSS | coindesk | 20 s timeout. |
| 9 heating-oil vendor sites | oil-prices | 4,000 ms delay between requests, 25 s timeout, 2 retries. 7 further sources are disabled with recorded reasons (WAF blocks, proof-of-work challenges, client-side rendering, login walls). |
| CoinGecko | offline backfill only | Not called by any deployed monitor. |

---

## 8. SCHEDULED JOBS OUTSIDE THE MONITOR FRAMEWORK

**None found.** There is no cron, no external scheduler, and no job runner in the
repository. Every recurring task runs inside the monitor framework. The only
timers outside adapter code are:

- `src/scheduler.ts` — `setInterval` at `tickMs` 5,000 ms, and a per-run
  `setTimeout` abort guard at `min(scheduleMs, 300,000)`.
- `src/ws-watchdog.ts` — `setInterval` health check for WebSocket adapters.
- `src/index.ts` — a shutdown `setTimeout`.

Retention is configured per monitor and executed inside those monitors'
own runs: `nft-mints` (30-day full detail, 365-day aggregate purge),
`pumpfun-early-window` (3-day full resolution, 24-hour dense purge),
`pumpfun-outcomes` (30/7/180-day tiers), `oil-prices` (24-hour full resolution),
`postgres-disk` (30-day sample retention), `new-token-watch`
(`retention_hours: 24`). Because `pumpfun-launches`, `pumpfun-outcomes` and
`solana-tokens` are disabled, **their retention is not running either.**

---

## 9. KNOWN DEFECTS

### Confirmed and unresolved

1. **Disk usage is computed against a constant, not the real volume.** The
   latest sample reads `db_bytes 10,875,098,815`, `wal_bytes 536,870,912`,
   `total_bytes 11,411,969,727`, `volume_bytes 5,368,709,120`,
   `used_pct 212.565`. That `volume_bytes` is exactly the `volume_gb: 5` constant
   in `monitors/postgres-disk.yaml`, not a figure read from the platform. Writes
   are succeeding, so the real volume is larger than 5 GB and the config is
   stale. The monitor has therefore reported `critical` since
   2026-08-28T05:26:09Z and has raised nothing since, because
   `disk_alert_state.last_level` is already `critical`. **The disk alert is
   effectively disabled and its percentage is not a measurement.**

2. **`nft_mint_daily` has 0 rows** after 885 `nft-mints` runs. The aggregation
   either never executes or always produces nothing. A table that is written but
   always empty is indistinguishable from one that is never written.

3. **`pumpfun-launches` is dead and three things depend on it.** 361 consecutive
   failures, last success 2026-08-25T11:45:01Z, stream connected but silent.
   `pumpfun-outcomes` and `solana-tokens` are disabled in consequence, and with
   them their retention passes. `pump_launches` (19,422 rows) and
   `pump_curve_samples` (213,404 rows / 83 MB) are frozen at 2026-08-25.

4. **`new-token-watch` alerts are suppressed and its output is unread.**
   `send_alerts: false`, and `new_token_hits` (29,341 rows / 14 MB) is written by
   nothing else and read by nothing. It has 53 failures in 195 runs — the worst
   failure ratio of any enabled monitor — and runs for 196 s.

5. **`early_token_wallets` is 2,855 MB and nothing reads it.** Combined with
   `early_snapshots` at 6,176 MB, the pumpfun-early tables are roughly 9 GB of a
   10 GB database.

6. **160 MOS wallets have no group assignment** — 854 in `wallet_pnl` against 694
   in `mos_wallet_groups`. Any group-based MOS alert silently excludes them.

7. **Three tokens are half-loaded.** CATE (556 wallets), CYBERLEEK (268) and NTF
   (511) have `wallet_pnl` rows with zero buy quantities, no `wallet_pnl_tokens`
   metadata row, and no `wallet_groups` entries. NTF has never been verified.

8. **The resolved Helius API key is stored in plaintext in the `monitors` table.**
   The YAML uses `${HELIUS_API_KEY}`, but the registry persists the interpolated
   config, so the key is readable by anything with database access and appears in
   any dump of that table. Not reproduced in this document.

### Unverified rather than broken

9. **`mos-p1-test`'s two most recent fixes have not been exercised by a live
   alert.** The `· new <amount>` segment and the `on conflict` provenance clause
   both deployed at 2026-09-03T17:11Z. As of 00:12Z the segment has never
   appeared in a stored `message_text`, because alerts are infrequent — 1 of the
   last 3 cycles emitted one. Verified only by local render and by backfill.

10. **The MOS group-1 balance-change alert has no dedupe.** Every wallet whose
    balance moved is listed every hour. That is by design, but it means a wallet
    trading actively appears in every alert.

11. **`mos_p1_test_batch` and the three offline-pipeline tables cannot be
    refreshed by the deployed service.** `mos_wallet_groups` (2026-09-02),
    `wallet_groups` (2026-09-02), `wallet_clusters` (2026-09-01) are all static
    and will drift as new wallets appear.

12. **`pumpfun-early-window` has 1,429 failures in 23,283 runs (6.1%)** while
    reporting success overall. The failure mode has not been investigated.

### Fixed this session, recorded for provenance

- `mos-p1-test` stage 2 diff compared against a millisecond-truncated timestamp
  and matched nothing, so four cycles reported zero flags while five events
  should have flagged. Fixed in `22186c1`.
- The MOS group-1 balance line printed `wallet_pnl.tokens_bought` beside a live
  balance, producing deltas larger than the stated holding. Fixed in `74e0580`.
- `mos_p1_mint_alerts` rows retained `seeded = true` and a bootstrap
  `first_alerted_at` after a real alert. Fixed in `a7760b3`; one affected row
  backfilled.
