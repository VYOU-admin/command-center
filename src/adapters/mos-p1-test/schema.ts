/**
 * Tables for the MOS-P1 cohort monitor.
 *
 * Began as a 10-wallet cost probe with no Discord. It now runs the full 74-wallet
 * cohort and alerts to the new-token channel, so the tables below are read by
 * something other than a report.
 *
 * FOUR READ STATES, KEPT APART, exactly as solana_balance_scans does:
 *   status='ok'         amount = the figure   -- may legitimately be 0
 *   status='no_account' amount = null         -- the owner holds no such account
 *   status=<error text> amount = null         -- the read failed
 *   (never attempted)                         -- no row at all
 * An error is never written as 0. That distinction is the point of the probe.
 */
import type { PoolClient } from '../../store/db.js';

export async function migrate(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists mos_p1_balance_snapshots (
      id        bigserial primary key,
      cycle_at  timestamptz not null,
      wallet    text        not null,
      mint      text,
      amount    numeric,
      decimals  int,
      program   text,
      read_at   timestamptz not null,
      status    text        not null
    )`);
  await client.query(`create index if not exists mp1_snap_idx
      on mos_p1_balance_snapshots (wallet, mint, cycle_at desc)`);
  await client.query(`create index if not exists mp1_snap_cycle_idx
      on mos_p1_balance_snapshots (cycle_at desc)`);

  /* Which of the tagged wallets are actually read. Kept as a table rather than a
     config list so changing the cohort is a data change, not a deploy. */
  await client.query(`
    create table if not exists mos_p1_test_batch (
      wallet     text primary key,
      added_at   timestamptz not null default now(),
      source     text
    )`);

  await client.query(`
    create table if not exists mos_p1_activity (
      id         bigserial primary key,
      cycle_at   timestamptz not null,
      wallet     text        not null,
      mint       text        not null,
      side       text        not null,
      amount     numeric,
      usd        numeric,
      tx_sig     text        not null,
      block_time timestamptz,
      unique (wallet, mint, tx_sig)
    )`);

  /*
   * Written at cycle START and updated on completion, so a cycle killed by the
   * abort guard still leaves a row saying it began and how far it got. The
   * monitors that lacked this were the ones whose worst runs left no evidence.
   */
  await client.query(`
    create table if not exists mos_p1_test_stats (
      cycle_at         timestamptz primary key,
      finished_at      timestamptz,
      completed        boolean not null default false,
      wallets_total    int,
      wallets_read     int,
      wallets_flagged  int,
      wallets_skipped  int,
      mints_new        int,
      stage1_requests  int,
      stage1_subcalls  int,
      stage2_requests  int,
      stage3_requests  int,
      total_requests   int,
      duration_ms      int,
      failures         jsonb,
      error            text
    )`);

  /*
   * create table if not exists IS A NO-OP ON AN EXISTING TABLE. Five columns
   * added to group2_cycle_stats this way were silently absent after deploy,
   * because the table already existed and the new definition was ignored. Every
   * column added after the first release has to come through alter table.
   */
  for (const col of [
    'mints_held           int',
    'mints_candidate      int',
    'mints_below_floor    int',
    'mints_denylisted     int',
    'mints_alerted        int',
    'mints_suppressed     int',
    'symbols_unresolved   int',
    'dexscreener_requests int',
    'dexscreener_failed   int',
    'duplicate_symbols    int',
    'alert_parts          int',
    'bootstrap            boolean',
    'batch_requests       int',
    'batch_failures       int',
    'message_text         text',
  ]) await client.query(`alter table mos_p1_test_stats add column if not exists ${col}`);

  /*
   * The high-water mark per mint, and the whole reason a cohort of 74 wallets
   * does not emit 5,902 lines on its first cycle.
   *
   * A mint alerts only when the number of cohort wallets holding it exceeds
   * every count previously alerted -- the same rule as group2_token_alerts. The
   * first cycle SEEDS this table at the current counts and sends nothing, so
   * the marks describe "what the cohort already held" rather than zero.
   *
   * ONLY WHAT WAS ACTUALLY SENT RAISES THE MARK, except during that seed. A
   * line dropped for any reason must keep its old high, or the mint is silently
   * retired from alerting without ever having been reported.
   */
  await client.query(`
    create table if not exists mos_p1_mint_alerts (
      mint               text primary key,
      last_alerted_count int         not null,
      last_alerted_at    timestamptz,
      first_alerted_at   timestamptz not null default now(),
      symbol             text,
      seeded             boolean     not null default false
    )`);
}
