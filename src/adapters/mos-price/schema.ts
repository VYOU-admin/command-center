/**
 * MOS price readings, the all-time high, and heartbeat state.
 *
 * THREE TABLES, ONE CONCERN EACH. The high-water mark and the heartbeat clock
 * are different questions -- "what is the best price ever seen" and "when did we
 * last say something" -- and folding them together would mean a heartbeat write
 * touching the row that gates ATH alerts.
 *
 * A FAILED READ IS RECORDED, NOT DROPPED, AND NEVER PRICED. price_usd is null
 * whenever status <> 'ok', so a failure is visible in the series without being
 * comparable: nothing computes a delta from it, and nothing can raise the high
 * on it.
 */
import type { PoolClient } from '../../store/db.js';

export async function migrate(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists mos_price_readings (
      id           bigserial primary key,
      token        text        not null,
      chain        text        not null,
      pair         text        not null,
      price_usd    numeric,
      market_cap   numeric,
      read_at      timestamptz not null default now(),
      status       text        not null
    )`);
  await client.query(`create index if not exists mpr_token_read_idx
      on mos_price_readings (token, read_at desc)`);

  /* The all-time high. Raised ONLY from a reading that was verified ok. */
  await client.query(`
    create table if not exists mos_price_high (
      token      text not null,
      chain      text not null,
      high_usd   numeric     not null,
      high_at    timestamptz not null,
      market_cap numeric,
      updated_at timestamptz not null default now(),
      primary key (token, chain)
    )`);

  /* When the hourly heartbeat last went out. Separate so a heartbeat write can
     never touch the row that gates ATH alerts. */
  await client.query(`
    create table if not exists mos_price_heartbeat (
      token        text not null,
      chain        text not null,
      last_sent_at timestamptz not null,
      primary key (token, chain)
    )`);

  await client.query(`
    create table if not exists mos_price_stats (
      ran_at        timestamptz primary key,
      token         text,
      status        text,
      price_usd     numeric,
      market_cap    numeric,
      heartbeat     boolean,
      ath           boolean,
      high_usd      numeric,
      duration_ms   int,
      error         text
    )`);
}
