# mos-p1-test — MOS-P1 cost and correctness probe

Written 2026-09-03 as a handover. **Assume no memory of the session that built
this.** Everything needed to finish the job is here.

**Status: built, deployed, seeded. Credit baseline captured (47,213 at
03:47Z). Awaiting four completed cycles and the "after" dashboard reading.** One cycle has
run and it failed for a benign reason (below). The numbers this probe exists to
produce do not yet exist.

## What this is

A **cost and correctness probe, not a production monitor.** It watches 10
wallets out of 74 tagged `MOS-P1`, on a 15-minute cycle, and emits nothing to
Discord. Its whole output is a request count and a flag rate, so the question
"what would 74 wallets cost" can be answered from measurement instead of
arithmetic.

**Do not scale it to 74 and do not add alerting** until the four-cycle numbers
below have been reported and reviewed. That was an explicit instruction.

## Files

| path | what |
|---|---|
| `src/adapters/mos-p1-test.ts` | the adapter, three stages |
| `src/adapters/mos-p1-test/schema.ts` | four tables |
| `monitors/mos-p1-test.yaml` | 15m, `channel: system` (failure/recovery only) |
| `data/mos_p1_wallets.csv` | 74 rows, the source of truth for the seed |

Commit `ea2a289`.

## The three stages

**Stage 1 — balances.** One batched HTTP request carrying **20 sub-calls**: 10
wallets × two token programs. `getTokenAccountsByOwner` takes a single
`programId`, so covering both needs two sub-calls per wallet.

> **MOS is TOKEN-2022** (`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`), not the
> legacy SPL Token program. Measured: filtering the legacy program returns **0
> accounts** for this mint. Querying only legacy would report every wallet as
> holding nothing.

Request count and sub-call count are recorded **separately** (`stage1_requests`,
`stage1_subcalls`) because an HTTP request and a billable sub-call are not the
same unit and neither price has been verified with the provider.

**Stage 2 — diff. Zero RPC, database only** (`stage2_requests` is always 0). A
wallet is flagged if a mint appears that was not in its previous snapshot, or if
an existing mint's balance moved more than `move_pct` (5) in either direction.

- **A new mint always flags**, regardless of size — there is no prior balance to
  take a percentage against.
- **A failed read and an absent prior snapshot are each their own state and are
  excluded from the diff**, never substituted with 0. Substituting would
  manufacture a −100% move out of missing data.
- **The first cycle writes snapshots and flags nothing.**

**Stage 3 — activity, flagged wallets only.** `activity_minutes` (30) of history
per flagged wallet, decoded from `pre`/`postTokenBalances` net deltas for that
owner at **any call depth** — the same method as the MOS backfill, not an
instruction-layout decode. `usd` is written **null, not 0**, for mints with no
price series; 0 would read as a worthless trade.

Abort is checked at every stage boundary and every flagged-wallet iteration.

## Table schemas

```sql
mos_p1_balance_snapshots
  id bigserial pk, cycle_at timestamptz, wallet text, mint text, amount numeric,
  decimals int, program text, read_at timestamptz, status text
  -- indexes: (wallet, mint, cycle_at desc), (cycle_at desc)

mos_p1_activity
  id bigserial pk, cycle_at timestamptz, wallet text, mint text, side text,
  amount numeric, usd numeric, tx_sig text, block_time timestamptz
  -- unique (wallet, mint, tx_sig)

mos_p1_test_batch
  wallet text pk, added_at timestamptz, source text
  -- the 10 wallets actually read, out of the 74 tagged. A table, not a config
  -- list, so scaling to 74 is a data change rather than a deploy.

mos_p1_test_stats
  cycle_at timestamptz pk, finished_at, completed boolean default false,
  wallets_total, wallets_read, wallets_flagged, wallets_skipped, mints_new,
  stage1_requests, stage1_subcalls, stage2_requests, stage3_requests,
  total_requests, duration_ms int, failures jsonb, error text
```

**Four read states, kept apart**, exactly as `solana_balance_scans` does:

| state | `amount` | `status` |
|---|---|---|
| read, non-zero | the figure | `ok` |
| read, genuinely zero | `0` | `ok` |
| owner holds no such account | `null` | `no_account` |
| read failed | `null` | the error text |
| never attempted | *no row* | — |

`mos_p1_test_stats` is **inserted at cycle START** with `completed = false` and
updated on completion, so a cycle killed by the abort guard still leaves
evidence. This exists because the monitors that lacked it had their *worst* runs
leave no record at all.

## The `lower()` defect, found and fixed

`src/web/server.ts:139`, in the `POST /api/token-tag` write path, read:

```ts
const wallet = String(body.wallet ?? '').trim().toLowerCase();
```

**Solana addresses are case-sensitive base58.** The read path selects wallets
raw, so a Solana tag written through the dashboard UI was stored under an address
that could never match on read — written successfully, then permanently
invisible. All 74 CSV addresses contain uppercase, so every one would have been
corrupted.

- **Bypassed for the seed:** rows were inserted with direct SQL, no `lower()`
  anywhere.
- **Also fixed:** the `.toLowerCase()` was removed so write and read are
  symmetric. EVM wallets arrive already lowercase from `wallet_pnl`, so nothing
  changes for them.

This is the third instance of the same hazard in this codebase — the others were
the `mos_wallet_groups` and `wallet_tags` **read** queries. Anywhere a base58
address passes through SQL, check for `lower()`.

## Seed — done and verified

74 rows into `wallet_tags` (`token='MOS'`, `chain='solana'`, `tag='MOS-P1'`), 10
into `mos_p1_test_batch`.

```
rows with tag='MOS-P1'  : 74   (expected 74) MATCH
mos_p1_test_batch       : 10   (expected 10)
test_batch also tagged  : 10 of 10
all-lowercase rows      : 0 of 74
```

Byte-compared against the CSV from a fresh connection, all 44 bytes, identical,
uppercase preserved:

```
rank  1  FtKw6WPGjAPveaw5GpoodSoPdqUBa1nCXV3TsSwwx8TG
rank 38  6L9iXPXZwUsCq3kyqRULrPY3hEJNTHd62M2gCuydFnoX
rank 74  9Zqe4vHW9mpjMD6CeC8VHGwACvp4NmBghtL5eW5VhG74
```

All 74 exist in `wallet_pnl` for MOS.

**Note on the CSV:** the tag is `MOS-P1` on all 74 rows, but rank 1
(`FtKw…x8TG`) has `n_sells: 14`, which makes it Group 2, not Group 1. "P1" does
not appear to mean the Group 1 classification. This was flagged and not resolved.

## Cycle 1 failed, and that was correct

```
03:39:32.329Z  failure  0.0s  Error: no test_batch wallets found for tag MOS-P1
```

**A 39-second race, not a defect.** The monitor's boot tick fired at 03:39:32;
the seed committed at 03:40:11. The adapter **refused to run against an empty
cohort** rather than reading nothing and reporting a clean zero-flag cycle. It
made **zero RPC calls**, so it does not contaminate any credit measurement. Its
stats row exists with `completed=false`, which is what the start-of-cycle write
is for.

## Per-cycle counts so far

**None. Zero cycles have completed.**

```
cycles recorded : 1  (completed=false, the failed one)
snapshots       : 0 rows
activity        : 0 rows
snapshot states : none yet
```

At 03:45:49Z the next cycle was due at roughly **03:54:32Z**.

## WHAT STILL NEEDS REPORTING — the actual deliverable

After **four completed cycles** (`select * from mos_p1_test_stats where completed = true`):

1. **Per-cycle counts**, from `mos_p1_test_stats`: wallets read, flagged,
   skipped; mints newly seen; `stage1_requests` **and** `stage1_subcalls`;
   `stage2_requests`; `stage3_requests`; `total_requests`; `duration_ms`; and
   any per-wallet failures from the `failures` jsonb.

2. **Helius credits across the four cycles.** ⚠️ **THIS CANNOT BE READ
   PROGRAMMATICALLY AND MUST COME FROM THE USER.**

   Helius exposes no usage API — `/v0/usage`, `/v0/credits` and `/v0/health` all
   return `Method not found`, and there are **no credit or quota headers on any
   RPC response**. Both were verified directly.

   **Do NOT estimate from `CREDITS_PER_SIGNATURES_CALL = 10` or `credits = 100`
   in `scripts/helius_recon.py`.** Those are constants written into our own code;
   the provider never confirmed them, and presenting arithmetic against them as a
   cost figure was explicitly ruled out.

   The user must read **dashboard.helius.dev → Usage & credits** before and after,
   and the difference is the answer.

   > **BASELINE SUPPLIED BY THE USER: 47,213 credits at 2026-09-03T03:47Z.**
   >
   > This is a clean baseline. Cycle 1 (03:39:32Z) failed before making any RPC
   > call and spent 0 credits, and the first *successful* cycle was not due until
   > ~03:54:32Z, so nothing from this probe is inside the reading.
   >
   > **Still needed: the "after" reading**, taken once four cycles have
   > completed (~04:39-04:40Z). Credits consumed = after - 47,213.
   >
   > Caveat to state when reporting: the Helius account is shared with other
   > work. Anything else that touched Helius inside the window is included in
   > the difference. Nothing else was deliberately run against it during this
   > period, but that is an assumption, not a measurement.

3. **Extrapolated daily cost at 74 wallets on a 15m cycle.** 96 cycles/day.
   Stage 1 scales with wallet count (74 wallets = 148 sub-calls, still 1 batched
   request). Stage 3 scales with the *flag rate*, which is why (4) matters.
   Derive from the measured credits, not from constants.

4. **What fraction of cycles flagged zero wallets.** Directly:
   `select count(*) filter (where wallets_flagged = 0)::float / count(*)
    from mos_p1_test_stats where completed = true`.

## Useful queries

```sql
-- per-cycle table
select cycle_at, completed, wallets_read, wallets_flagged, wallets_skipped,
       mints_new, stage1_requests, stage1_subcalls, stage2_requests,
       stage3_requests, total_requests, duration_ms, failures
  from mos_p1_test_stats order by cycle_at;

-- read-state distribution
select status, count(*) from mos_p1_balance_snapshots group by 1;

-- did anything actually trade
select wallet, mint, side, amount, block_time from mos_p1_activity
 order by block_time desc;

-- the cohort the adapter reads
select b.wallet from mos_p1_test_batch b
  join wallet_tags t on t.wallet = b.wallet
 where t.tag = 'MOS-P1' and t.chain = 'solana';
```

## Operational notes for the next session

- The Railway CLI symlink in the scratchpad breaks between sessions and must be
  reinstalled; the login usually persists.
- `DATABASE_URL` is `postgres.railway.internal` and is **not reachable from the
  laptop**. Queries run via
  `railway ssh --service command-center` with a script written to `/app`.
- The adapter reads wallets **as-is**. Never add `lower()`.
- Nothing else reads these four tables. Dropping them affects nothing.


---

# Scale-up to 74 wallets with Discord alerting (2026-09-03)

## What changed

The probe became a monitor. Cohort 10 -> 74, and it now alerts to the
`newtoken` channel (Discord #new-tokens), the same channel group1-new-token and
group2-new-token use.

## The millisecond bug that made the first four cycles meaningless

`new Date(String(pgDate))` renders a Postgres timestamp as
`"Wed Sep 03 2026 04:09:37 GMT+0000 (...)"`, which DROPS MILLISECONDS.
`cycle_at` values carry them (`03:54:32.373Z`), so the reparsed lookup key was
`03:54:32.000Z` and `where cycle_at = $1` matched zero rows. `prior` came back
empty, every wallet took the "no prior snapshot -> do not flag" branch, and four
consecutive cycles reported `flagged 0 / mints_new 0` while the raw snapshots
contained a -99.997% move, a -99.514% move, a +38.309% move, a +10.878% move and
one new mint. Stage 3 never ran once.

This is the same defect as `price_read_at` in `server.ts`, fixed earlier the
same session and reintroduced here. pg already returns a Date; pass it through.

Fixed in `22186c1`. After the fix, the adapter's counts matched an independent
recomputation from the raw snapshots on all five following transitions, and
mismatched on all three preceding ones.

## The provider caps a batch between 28 and 32 sub-calls

74 wallets x 2 token programs = 148 sub-calls, which one request cannot carry.
Measured on this Helius key:

    20 sub-calls -> HTTP 200    24 -> HTTP 200    28 -> HTTP 200
    32 sub-calls -> HTTP 429    40 -> 429    100 -> 429    148 -> 429

40 stayed refused across three attempts with 12s backoff, so this is a size
ceiling and not a rate limit. A 429 also poisons the following few seconds, so
back-to-back chunks need spacing. Eight chunks of 20 spaced 5s went 8/8 with
zero sub-errors in 40.7s, comfortably inside the 300s guard.

`batch_subcalls` fails validation above 28, so a bad config breaks the deploy
rather than every cycle.

## Alerting is deliberately narrower than the flag set

The balance diff still flags percentage moves and stage 3 still pulls their
activity. Alerts are a separate gate: only mints crossing a wallet-count
high-water mark are ever sent, the same rule as `group2_token_alerts`.

Measured across four post-fix cycles at 10 wallets, USDC moves alone accounted
for most of the flag rate. That is cohort plumbing, not signal.

Two filters, both in YAML:

  * `denylist_mints` -- USDC, USDT and wrapped SOL never alert at any count.
    USDC is held by 40 of the 74 wallets.
  * `min_holders: 2` -- of the 5,902 mints the cohort holds with a positive
    balance, 5,413 are held by exactly one wallet, and that tail is airdrop and
    LST dust with totals like 0.02. A floor of 2 leaves roughly 489 candidates;
    only 21 mints are held by 5 or more.

HOLDING MEANS A POSITIVE BALANCE. 82.4% of the cohort's token accounts sit at
exactly 0 -- opened and drained -- and counting those as holders would put a
meaningless number on the line.

## The bootstrap cycle sends nothing

On an empty `mos_p1_mint_alerts` every one of the ~5,900 held mints clears a
zero high-water mark at once. The first cycle therefore writes the current
counts with `seeded = true` and queues no alert. From then on a line means the
count genuinely rose.

To re-bootstrap deliberately, truncate `mos_p1_mint_alerts`; the next cycle
reseeds and stays silent.

## Links are built from the mint, never a pool address

`group2-new-token/dexscreener.ts` lowercases `pairAddress`. That is correct for
EVM and would corrupt every Solana base58 address, so `mos-p1-test/dexscreener.ts`
is a separate resolver that never changes the case of an address. It resolves by
mint through `/latest/dex/tokens/{mint}`, picks the highest-liquidity pair, and
keeps three outcomes apart -- `ok`, `none`, `failed` -- so a DexScreener outage
cannot be recorded as "these mints have no page".

A symbol is only used when the pair's `baseToken.address` IS the mint; otherwise
the mint is the quote side and the symbol names something else.

An unindexed mint STILL GETS A LINE, labelled with a short address, because the
cohort demonstrably holds it. So does a mint past `dexscreener_cap` -- dropping
it would leave its high-water mark unraised and lose the mint silently.

## Partial reads are failures, not balances

A wallet is "read" only when BOTH of its sub-calls came back and neither
errored, counted by response rather than by first success. A response merely
missing from the batch array would otherwise leave a wallet looking read with
half its token accounts. A chunk that fails marks only its own wallets unread.

## New table

    mos_p1_mint_alerts (
      mint text primary key, last_alerted_count int not null,
      last_alerted_at timestamptz, first_alerted_at timestamptz not null,
      symbol text, seeded boolean not null default false )

Fifteen columns were added to `mos_p1_test_stats` via `alter table ... add
column if not exists`, NOT by editing the `create table` -- which is a no-op on
an existing table and silently dropped five columns from `group2_cycle_stats`
once already.

## Cohort seed - done and verified

Dry run predicted 64 inserts against 10 existing and 74 tagged; the insert
returned 64; a fresh connection then reported 74 rows, 74 joining `wallet_tags`
on a case-sensitive match, 0 all-lowercase, and RETURNED NO ROWS for tagged
wallets still missing.

## Message shape

    **MOS-P1 · cohort activity**
    [MOS](https://dexscreener.com/solana/...) · 24 wallets · 60,214,439 · +3
    [GPRR…YvDH](https://dexscreener.com/solana/GPRR...) · 13 wallets · 24.4 · +1
    [BONK](https://dexscreener.com/solana/...) · 12 wallets · 12,172

Sorted by wallet count, then total, then mint. Colliding symbols get trailing
asterisks, display only. The header repeats on every part, unlike group2's
dashboard link, so a split message's second half is still attributable. No
mints crossing means no parts and nothing sent.


## Two fixes after the first live alert (2026-09-03)

The first real alert was ANSEM at 06:56 -- `13 wallets · 12,789 · +1` -- and it
exposed two problems.

### The line described the cohort, not the event

`total` is cohort-wide. For ANSEM one wallet that had held for hours accounted
for 12,150 of the 12,789, and the new 13th holder brought 617. The number that
explained the alert was absent from it.

Lines now carry ` · new <amount>`: the amount held by wallets that started
holding SINCE THE PREVIOUS CYCLE.

    [ANSEM](...) · 13 wallets · 12,789 · +1 · new 617.09

Note the two figures are measured against different baselines and need not
agree. `+1` is growth against the ALL-TIME HIGH-WATER MARK; `new` is measured
against the PREVIOUS CYCLE.

The segment is omitted, never shown as 0, in three cases:

  * any current holder had no prior snapshot -- an unread wallet last cycle, or
    a cohort that just grew. The true figure could be larger, and a smaller one
    would read as the whole story.
  * no holder is new.
  * every holder is new, since `total` already says it.

### Rows claimed a seed time as their first alert

`on conflict do update` set the count, timestamp and symbol but never cleared
`seeded` or set `first_alerted_at`. A mint seeded by the bootstrap and later
genuinely alerted therefore kept `seeded = true` and a `first_alerted_at` from
the seed -- a time at which nothing was sent. ANSEM read as first alerted at
06:41:05, the bootstrap persist, when its actual first alert was 06:56.

The clause now stamps `first_alerted_at = now()` and clears `seeded` only when
the row was still seeded; a row that has genuinely alerted before keeps its
original timestamp.

The gate itself was never affected -- it reads `last_alerted_count`, which was
always correct.

### Backfill

One row was affected. Dry run: 486 rows, 486 seeded, 485 seeded-and-never-
alerted, 1 seeded-and-alerted, reconciling as 485 + 1 = 486. The update touched
1 row and a fresh connection then returned 0 rows still claiming a seed time as
a first alert, with the 485 untouched.

The first-alert time was recovered from `mos_p1_test_stats.message_text`, not
guessed from `last_alerted_at`, which is the LAST alert and would be wrong for
any mint alerted more than once. The script refuses to fix any row it cannot
pin to exactly one cycle.

CAUTION FOR ANY FUTURE BACKFILL: the message carries the PAIR address, not the
mint, so a mint cannot be found in `message_text` by its own address. The symbol
is the only handle, and an unresolved mint has none. There is no per-alert log
table; if that recovery path is needed routinely, add one rather than widening
the symbol match.
