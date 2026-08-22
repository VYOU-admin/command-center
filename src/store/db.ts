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
