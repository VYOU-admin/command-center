/**
 * Volume usage history, and the alert state that stops it repeating itself.
 *
 * The samples table exists so growth is MEASURED rather than assumed. A single
 * reading tells you how full the disk is; it cannot tell you how long you have,
 * and "how long do I have" is the only question that matters when a volume is
 * filling. Two readings hours apart answer it.
 *
 * BOTH THE CEILING AND THE USAGE COME FROM THE HOSTING PROVIDER. pg_database_size
 * reports the database, which is not the same thing as the volume: a 27 MB
 * database has sat on a volume reporting 14.4 GB used, because WAL, indexes
 * reclaimed lazily and the filesystem's own overhead are all outside it. Asking
 * Postgres how full its disk is gives the wrong answer by construction.
 *
 * volume_bytes and volume_used_bytes are therefore what the provider reports.
 * db_bytes and wal_bytes are kept alongside them as context -- useful for
 * "what is growing", useless as a measure of "how full".
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

-- Added after first release. create table if not exists is a NO-OP on an
-- existing table, so a column added by editing the statement above would
-- silently never appear.
alter table disk_usage_samples add column if not exists volume_used_bytes bigint;
alter table disk_usage_samples add column if not exists measured_from     text;

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
