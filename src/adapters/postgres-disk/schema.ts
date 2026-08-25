/**
 * Volume usage history, and the alert state that stops it repeating itself.
 *
 * The samples table exists so growth is MEASURED rather than assumed. A single
 * reading tells you how full the disk is; it cannot tell you how long you have,
 * and "how long do I have" is the only question that matters when a volume is
 * filling. Two readings hours apart answer it.
 *
 * Postgres cannot see the size of the volume it sits on — pg_database_size
 * reports the database, not the filesystem — so the ceiling is configuration.
 * If the volume is resized, the YAML must be updated to match or the projection
 * silently describes the wrong disk.
 */
export const SCHEMA = `
create table if not exists disk_usage_samples (
  monitor_id   text        not null,
  sampled_at   timestamptz not null default now(),
  db_bytes     bigint      not null,
  wal_bytes    bigint      not null,
  total_bytes  bigint      not null,
  volume_bytes bigint      not null,
  used_pct     numeric     not null,

  primary key (monitor_id, sampled_at)
);

create index if not exists disk_usage_time_idx
  on disk_usage_samples (monitor_id, sampled_at desc);

-- One row per monitor. Holds the highest threshold already announced, so
-- crossing 70% alerts once rather than every fifteen minutes, and 85% still
-- alerts even though 70% already did.
create table if not exists disk_alert_state (
  monitor_id     text primary key,
  last_level     text not null default 'ok',
  last_alert_at  timestamptz,
  last_used_pct  numeric
);
`;
