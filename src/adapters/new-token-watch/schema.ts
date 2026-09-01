/**
 * Tables owned by the new-token watch.
 *
 * TWO RETENTION REGIMES, DELIBERATELY DIFFERENT:
 *
 *   new_token_hits        rolling 24 hours. Observations, and they age out.
 *   new_token_cycle_stats rolling 24 hours. One row per run, for cache-hit
 *                         reporting and nothing else.
 *   token_pool_first      PERMANENT. A pool's creation block never changes, so
 *                         re-deriving it is pure waste. It grows only by the
 *                         number of distinct tokens ever seen, and deleting
 *                         from it would silently re-cost every lookup.
 *
 * Age is COMPUTED AT READ TIME from created_at, never stored. A stored age is
 * wrong the moment it is written.
 */
import type { PoolClient } from '../../store/db.js';

export async function migrate(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists token_pool_first (
      token            text primary key,
      chain            text not null,
      pool_id          text,
      created_block    bigint,
      created_at       timestamptz,
      -- true when the token was seen but its pool predates our sweep coverage,
      -- so it is known-old rather than unknown. Caching the negative is what
      -- stops the same 40-odd tokens being re-looked-up every hour.
      older_than_sweep boolean not null default false,
      first_seen_at    timestamptz not null default now()
    )`);
  await client.query(`
    create table if not exists new_token_hits (
      hour_bucket        timestamptz not null,
      chain              text not null,
      token              text not null,
      wallet             text not null,
      n_transfers        int not null default 1,
      pool_created_block bigint,
      pool_created_at    timestamptz,
      cohorts            int,
      total_realized_usd numeric,
      cross_token        boolean,
      first_seen_at      timestamptz not null default now(),
      primary key (hour_bucket, chain, token, wallet)
    )`);
  await client.query(
    `create index if not exists new_token_hits_bucket_idx on new_token_hits (hour_bucket desc)`);
  await client.query(
    `create index if not exists new_token_hits_token_idx on new_token_hits (token, hour_bucket desc)`);
  await client.query(`
    create table if not exists new_token_cycle_stats (
      ran_at             timestamptz primary key,
      head_block         bigint,
      block_seconds      numeric,
      requests           int,
      transfers_seen     int,
      venue_transfers    int,
      distinct_tokens    int,
      cache_hits         int,
      cache_misses       int,
      cache_negative     int,
      tokens_alerted     int,
      wallets_alerted    int,
      rows_written       int,
      swept_from         bigint,
      swept_to           bigint,
      duration_ms        int
    )`);
  // Added after the table existed, so create-if-not-exists would not add them.
  for (const col of ['group_index int', 'group_count int', 'wallets_in_group int']) {
    await client.query(
      `alter table new_token_cycle_stats add column if not exists ${col}`);
  }
  await client.query(`
    create table if not exists new_token_cursor (
      chain            text primary key,
      last_swept_block bigint not null
    )`);
}
