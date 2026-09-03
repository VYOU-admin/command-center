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
