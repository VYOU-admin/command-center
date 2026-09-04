# Secrets and settings inventory

Written 2026-09-04 during teardown, before any code or data was removed.

**No value appears in this file.** Every entry is a variable NAME, the file that
reads it, and what it is for. Presence and character length were checked against
the deployed service; the values themselves were never printed or stored.

---

## 1. Environment variables the repository reads

`src/env.ts` is the only module that reads `process.env` in the running service —
it states that rule in its own header comment, and a grep confirms it holds
except for `LOG_LEVEL`. The offline `scripts/*.mjs` loaders read `DATABASE_URL`
directly, but those are not part of the deployed service.

| variable | read by | purpose | on the service |
|---|---|---|---|
| `DATABASE_URL` | `src/env.ts:46`, and every `scripts/*.mjs` | Postgres connection string. Required — `loadEnv()` throws if absent. | present (93 chars) |
| `DATABASE_PUBLIC_URL` | `scripts/cyberleek_load_pnl.mjs:60` | Fallback DSN for one offline loader, tried before `DATABASE_URL`. Not used by the service. | not set |
| `PORT` | `src/env.ts:54` | HTTP port for the dashboard. Defaults to 3000; must parse as 1–65535. | present (4 chars) |
| `DISCORD_WEBHOOK_URL` | `src/env.ts:60` | Fallback webhook used when a monitor names a channel that does not resolve. Explicitly NOT a channel called "url". | present (121 chars) |
| `DISCORD_WEBHOOK_<NAME>` | `src/env.ts:67-75` | Dynamic. Every variable matching this prefix becomes a channel named `<NAME>` lowercased. Must start with `https://` or boot fails. | 5 set, listed below |
| `MOS_PRICE_CHECK` | `src/env.ts:93`, via `WEBHOOK_ALIASES` | Webhook for the `mos-price-alert` channel. Aliased because the name does not follow the `DISCORD_WEBHOOK_` prefix. Never shadows a real channel. | present (121 chars) |
| `RAILWAY_PUBLIC_DOMAIN` | `src/env.ts:102` | Injected by Railway. Used to build the public dashboard URL that alerts link back to. | present (45 chars) |
| `PUBLIC_URL` | `src/env.ts:104` | Manual override for the public URL, tried before `RAILWAY_PUBLIC_DOMAIN`. | not set |
| `MONITORS_DIR` | `src/env.ts:112` | Directory holding monitor YAML. Defaults to `monitors`. | not set |
| `LOG_LEVEL` | `src/logger.ts:10` | Log verbosity. Defaults to `info`. The one `process.env` read outside `env.ts`. | not set |
| `HELIUS_API_KEY` | `src/env.ts` allowlist | Helius RPC key. Allowed for `${...}` interpolation in monitor YAML. | present (36 chars) |
| `HELIUS_RPC_URL` | `src/env.ts` allowlist | Full Helius RPC URL. If unset, `env.ts` derives it from `HELIUS_API_KEY`. | not set — derived |
| `ALCHEMY_API_KEY` | `src/env.ts` allowlist | Allowlisted for YAML interpolation but **referenced by no monitor YAML and not set**. Dead entry. | not set |

### The interpolation allowlist

`CONFIG_VAR_ALLOWLIST = ['HELIUS_API_KEY', 'HELIUS_RPC_URL', 'ALCHEMY_API_KEY']`
(`src/env.ts:43`). Only these three may be referenced as `${NAME}` from monitor
YAML, so a typo in a config cannot reach an unrelated variable. Three YAML files
use it today:

    monitors/nft-mints.yaml:44            rpc_url: ${HELIUS_RPC_URL}
    monitors/mos-p1-test.yaml:29          rpc_url: ".../?api-key=${HELIUS_API_KEY}"
    monitors/solana-balance-scan.yaml:44  rpc_url: ".../?api-key=${HELIUS_API_KEY}"

---

## 2. Discord channel to environment variable mapping

Channel names are lowercased from the variable suffix.

| channel | environment variable | used by |
|---|---|---|
| `crypto` | `DISCORD_WEBHOOK_CRYPTO` | coindesk, pumpfun-launches, pumpfun-outcomes |
| `crypto_early` | `DISCORD_WEBHOOK_CRYPTO_EARLY` | pumpfun-early-alert |
| `newtoken` | `DISCORD_WEBHOOK_NEWTOKEN` | group1/group2-new-token, mos-p1-test, solana-balance-scan, new-token-watch |
| `oil` | `DISCORD_WEBHOOK_OIL` | **oil-prices — retained after teardown** |
| `system` | `DISCORD_WEBHOOK_SYSTEM` | **retained** — failure/recovery alerts for every monitor, plus nft-mints, postgres-disk, pumpfun-early-window, token-balance-scan |
| `mos-price-alert` | `MOS_PRICE_CHECK` (alias) | mos-price |
| *(fallback)* | `DISCORD_WEBHOOK_URL` | Any monitor whose named channel fails to resolve |

All seven are set on the deployed service, each 121 characters.

After teardown only `oil` and `system` are referenced by remaining code.

**The four orphaned variables — `DISCORD_WEBHOOK_CRYPTO`,
`DISCORD_WEBHOOK_CRYPTO_EARLY`, `DISCORD_WEBHOOK_NEWTOKEN` and
`MOS_PRICE_CHECK` — are deliberately left set on the Railway service.** They are
kept so the Discord webhooks behind them do not have to be recreated if any of
those channels is ever wanted again; a webhook cannot be recovered once deleted,
only replaced with a new URL. Nothing reads them after teardown, so they are
inert. Do not treat them as leftovers to tidy up.

---

## 3. Railway

| item | value |
|---|---|
| Workspace | `vyou-admin's Projects` |
| Project | `command-center` |
| Project ID | `e69040d2-6790-4506-bce4-8d2f267d0548` |
| Environment | `production` |
| Environment ID | `f31e63a8-dba1-475a-8ad3-04e9fecd0042` |
| Service | `command-center` |
| Public URL | `https://command-center-production-eab2.up.railway.app` |
| Database | `Postgres`, volume `postgres-volume` |

Deploys are made with `railway up --service command-center --ci` from a local
checkout, not from the GitHub remote.

Note: the Railway CLI warns that Config-as-Code (`railway.json` / `railway.toml`)
is deprecated in favour of `.railway/railway.ts`, with existing files working
until 2026-12-01.

---

## 4. Account identifiers, for finding these accounts again

No keys, only identifiers.

| service | how to find the account | auth |
|---|---|---|
| GitHub | `git@github.com:VYOU-admin/command-center.git` | SSH key |
| Railway | Project ID `e69040d2-6790-4506-bce4-8d2f267d0548` under workspace `vyou-admin's Projects` | Railway CLI login (persists between sessions; the binary does not) |
| Helius | `dashboard.helius.dev`, section "Usage & credits". **There is no account identifier other than the API key itself**, and no usage API — `/v0/usage`, `/v0/credits` and `/v0/health` all return `Method not found`, and RPC responses carry no credit headers. Credit figures can only be read from the dashboard by a human. | `HELIUS_API_KEY` |
| Discord | Six webhooks into one server. A webhook URL embeds its own channel ID and token; the server is not otherwise identified in this repo. | webhook URLs |
| Robinhood chain RPC | `https://rpc.mainnet.chain.robinhood.com`, chain ID 4663 | none — public |
| DexScreener | `api.dexscreener.com` | none — public |
| CoinDesk RSS | `coindesk.com/arc/outboundfeeds/rss/` | none — public |
| Heating-oil vendors | 9 enabled vendor sites, listed in `monitors/oil-prices.yaml` | none — public pages |
| Alchemy | Allowlisted in code but no key set and no monitor uses it. **No account is known to exist.** | — |

---

## 5. Secrets persisted in the database

### Confirmed: the resolved Helius key IS stored in plaintext

The claim is true. The registry persists the *interpolated* config, not the YAML
source, so `${HELIUS_API_KEY}` is expanded before the row is written.

    monitors with a RESOLVED key in config: 3
      mos-p1-test          options.rpc_url
      nft-mints            options.solana.rpc_url
      solana-balance-scan  options.rpc_url
    monitors still holding the ${...} placeholder: 0

Anything with read access to `monitors` can read the key, and it appears in any
dump of that table. **Phase 3 drops nothing here — `monitors` is on the keep
list — so the key survives teardown unless those three rows are deleted.** Phase
2 deletes exactly those three monitors, which removes all three rows carrying it.
Rotating the key afterwards is still the safe move, since it has been in the
table and in every backup taken while it was.

### Confirmed clean: Discord webhooks and the database URL are NOT persisted

    monitors.config rows containing a webhook URL:   0
    monitors.config rows containing a postgres DSN:  0

Only channel *names* are stored in config: `crypto`, `crypto_early`,
`mos-price-alert`, `newtoken`, `oil`, `system`. Webhook URLs are resolved from
the environment at boot into an in-memory map and never written down.

### Whole-schema sweep

Every text, varchar, json and jsonb column in `public` was scanned — **219
columns across 55 tables** — for three patterns:

| pattern | result |
|---|---|
| Helius `api-key=` | `monitors.config` — 3 rows (the ones above) |
| Discord webhook URL | **RETURNED NO ROWS in any column** |
| `postgres://` DSN | **RETURNED NO ROWS in any column** |

No scan errored; all 219 columns were checked.
