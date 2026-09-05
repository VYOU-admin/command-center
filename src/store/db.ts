/**
 * Postgres connection and schema. Tables are created on startup if missing, so
 * a fresh Railway database needs no manual migration step.
 */

import pg from 'pg';
import { log } from '../logger.js';

const { Pool } = pg;
export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;

// node-postgres returns bigint/numeric as strings to avoid precision loss. Our
// counters are far below 2^53, so parse them as numbers for clean JSON output.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10)); // int8
pg.types.setTypeParser(1700, (v) => Number.parseFloat(v)); // numeric

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Railway's internal network does not present a publicly-verifiable cert.
    // External connections (the proxy host) do need TLS.
    ssl: /\.proxy\.rlwy\.net|\.railway\.app|sslmode=require/.test(databaseUrl)
      ? { rejectUnauthorized: false }
      : undefined,
  });

  // An idle-client error is emitted outside any query; unhandled, it takes down
  // the process. Log it and let the pool replace the client.
  pool.on('error', (err) => {
    log.error('postgres idle client error', { error: err.message });
  });

  return pool;
}

const SCHEMA = `
create table if not exists monitors (
  id                    text primary key,
  name                  text        not null,
  source                text        not null,
  enabled               boolean     not null default true,
  schedule_ms           bigint      not null,
  config                jsonb       not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- registry: how the last run went
  last_run_at           timestamptz,
  last_status           text,
  last_error            text,
  last_success_at       timestamptz,
  last_record_count     integer,
  last_new_record_count integer,
  last_duration_ms      integer,

  -- registry: rollups
  consecutive_failures  integer     not null default 0,
  total_runs            bigint      not null default 0,
  total_failures        bigint      not null default 0,
  total_records         bigint      not null default 0,

  -- alert de-duplication, so Discord gets edges not a repeating siren
  failure_alert_sent    boolean     not null default false,
  stale_alert_at        timestamptz
);

create table if not exists monitor_runs (
  id                bigserial primary key,
  monitor_id        text        not null references monitors(id) on delete cascade,
  started_at        timestamptz not null,
  finished_at       timestamptz not null,
  duration_ms       integer     not null,
  status            text        not null check (status in ('success', 'failure')),
  record_count      integer     not null default 0,
  new_record_count  integer     not null default 0,
  error             text
);

create index if not exists monitor_runs_monitor_started_idx
  on monitor_runs (monitor_id, started_at desc);

create table if not exists records (
  id            bigserial primary key,
  monitor_id    text        not null references monitors(id) on delete cascade,
  external_id   text        not null,
  title         text        not null,
  url           text,
  published_at  timestamptz,
  summary       text,
  payload       jsonb       not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now()
);

-- The dedupe guarantee: one row per (monitor, source-provided id). Reruns of a
-- feed that still lists the same articles cannot create duplicates.
create unique index if not exists records_monitor_external_idx
  on records (monitor_id, external_id);

create index if not exists records_monitor_published_idx
  on records (monitor_id, published_at desc nulls last);

create index if not exists records_first_seen_idx
  on records (first_seen_at desc);

/*
 * Token intake. See docs/SOLANA-TOKEN-INTAKE.md for the procedure these serve.
 *
 * EVERY ADDRESS COLUMN HERE IS CASE-SENSITIVE. Solana mints, pools and wallets
 * are base58. Nothing may lower() them on the way in or on the way out; that
 * mistake recurred four separate times before, each time writing rows that were
 * then permanently invisible.
 */
create table if not exists tokens (
  mint          text primary key,
  chain         text        not null,
  ticker        text        not null,
  name          text,
  decimals      integer     not null,
  charted_pair  text,
  created_at    timestamptz not null default now()
);

/*
 * EVERY event for a wallet in a token, across the token's whole life.
 *
 * This replaces token_purchases, which held only buys and only inside a window.
 * Two things forced the change. Cost basis needs a wallet's full history, not
 * the slice that happened to fall in a window -- a wallet that bought before the
 * window has a basis the window cannot see. And PnL needs sells and transfers,
 * which a purchases table has nowhere to put.
 *
 * NOT WINDOW-SCOPED, and there is deliberately no window_tag column. Cohort
 * membership lives in wallet_tags and nowhere else. Which window a transaction
 * falls in is derivable from block_time against token_windows, and that
 * derivation was checked against all 11,992 migrated rows before the column was
 * dropped: it reproduced every stored window_tag exactly, with no row outside a
 * window and no row inside two.
 *
 * CHAIN IS PART OF THE IDENTITY. Solana signatures and EVM transaction hashes
 * share a column, and an address means different things on each chain -- see the
 * case note below.
 *
 * usd_amount and price_usd are NULLABLE ON PURPOSE. A row whose USD value cannot
 * be derived stores null, never 0: a reader cannot tell a measured zero from an
 * absent measurement, and a $0 trade is a plausible-looking lie.
 *
 * ADDRESS CASE IS THE CHAIN'S BUSINESS, NEVER OURS. Solana addresses are base58
 * and case-sensitive -- lowercasing one produces an address that matches nothing,
 * with no error. EVM addresses are hex and conventionally lowercased, and the
 * same string in mixed case is the same account. So this table stores exactly
 * what the chain returned and never normalises across chains. Any comparison
 * must be consistent within a chain, and no shared helper may apply one chain's
 * rule to the other. That defect has recurred four times on this project.
 */
create table if not exists wallet_transactions (
  id            bigserial   primary key,
  chain         text        not null,
  token         text        not null,
  wallet        text        not null,
  side          text        not null,
  counterparty  text,
  tx_hash       text        not null,
  pool          text,
  block_time    timestamptz not null,
  block_number  bigint      not null,
  token_amount  numeric     not null,
  usd_amount    numeric,
  price_usd     numeric,
  created_at    timestamptz not null default now(),
  constraint wallet_transactions_side_ck
    check (side in ('buy','sell','transfer_in','transfer_out'))
);

/*
 * COUNTERPARTY IS IN THE KEY, AND NULLS COMPARE EQUAL. Both differ from the
 * obvious form, and each fixes a way the obvious form loses real rows.
 *
 * Without counterparty, one transaction moving tokens from a wallet to two
 * different recipients produces two transfer_out rows that collide on
 * (chain, tx_hash, wallet, token, side, pool) -- pool being null for both -- so
 * one is silently discarded by the on-conflict. Splits and airdrops do exactly
 * this.
 *
 * Without NULLS NOT DISTINCT, the opposite happens: Postgres treats two nulls as
 * distinct, so a null pool makes every transfer row unique and the constraint
 * stops deduplicating anything at all. A re-run would then double every transfer
 * instead of being idempotent.
 */
create unique index if not exists wallet_transactions_event_idx
  on wallet_transactions (chain, tx_hash, wallet, token, side, pool, counterparty)
  nulls not distinct;

create index if not exists wallet_transactions_token_wallet_idx
  on wallet_transactions (token, wallet);

create index if not exists wallet_transactions_token_time_idx
  on wallet_transactions (token, block_time);

/*
 * Tags live in their OWN table so that a re-run of a window, which deletes and
 * reinserts that window's purchase rows, cannot destroy an operator's manual
 * edits. source distinguishes what a run asserted from what a human decided.
 */
create table if not exists wallet_tags (
  id          bigserial primary key,
  wallet      text        not null,
  mint        text        not null references tokens(mint),
  tag         text        not null,
  source      text        not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index if not exists wallet_tags_wallet_mint_tag_idx
  on wallet_tags (wallet, mint, tag);

/*
 * The windows as COMMISSIONED, not as observed.
 *
 * The first and last purchase inside a window are not the window: a run over
 * 12:00-14:00 whose earliest buy landed at 12:09 still covered 12:00-14:00, and
 * deriving the bounds from token_purchases would quietly redefine the period to
 * whatever happened to trade. Every run records what it was asked to look at.
 *
 * window_end is INCLUSIVE, matching how the operator specifies it.
 *
 * A re-run of a token and window deletes and reinserts that window's purchase
 * rows. It must NOT drop the row here -- the window definition outlives any
 * particular ingestion of it.
 */
create table if not exists token_windows (
  id            bigserial primary key,
  mint          text        not null references tokens(mint),
  tag           text        not null,
  window_start  timestamptz not null,
  window_end    timestamptz not null,
  label         text,
  created_at    timestamptz not null default now()
);

create unique index if not exists token_windows_mint_tag_idx
  on token_windows (mint, tag);

create index if not exists token_windows_mint_start_idx
  on token_windows (mint, window_start);

create index if not exists wallet_tags_mint_idx
  on wallet_tags (mint);
`;

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(SCHEMA);
  log.info('database schema ready');
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
