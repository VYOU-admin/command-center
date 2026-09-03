/**
 * Tables for the MOS-P1 cost and correctness probe.
 *
 * A TEST HARNESS, NOT A PRODUCTION MONITOR. Own tables, no Discord, nothing
 * else reads them.
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

  /* The 10 wallets this probe actually reads, out of the 74 tagged. Kept as a
     table rather than a config list so scaling to 74 is a data change. */
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
}
