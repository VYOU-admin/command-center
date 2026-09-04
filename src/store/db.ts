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
 * One row per BUY LEG, not per transaction.
 *
 * The unique key includes pool and wallet because a single transaction can
 * legitimately contain more than one swap leg -- an aggregator routing across
 * two pools produces two buys for the same wallet under one signature, and
 * keying on signature alone would silently discard one of them.
 *
 * usd_amount and price_usd are NULLABLE ON PURPOSE. A purchase whose USD value
 * cannot be derived stores null, never 0: a reader cannot tell a measured zero
 * from an absent measurement, and a $0 purchase is a plausible-looking lie.
 */
create table if not exists token_purchases (
  id            bigserial primary key,
  mint          text        not null references tokens(mint),
  wallet        text        not null,
  signature     text        not null,
  pool          text        not null,
  block_time    timestamptz not null,
  slot          bigint      not null,
  token_amount  numeric     not null,
  usd_amount    numeric,
  price_usd     numeric,
  window_tag    text        not null,
  created_at    timestamptz not null default now()
);

create unique index if not exists token_purchases_leg_idx
  on token_purchases (signature, wallet, mint, pool);

create index if not exists token_purchases_mint_window_idx
  on token_purchases (mint, window_tag);

create index if not exists token_purchases_mint_wallet_idx
  on token_purchases (mint, wallet);

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
