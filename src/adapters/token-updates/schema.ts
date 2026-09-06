/**
 * Tables this adapter owns, plus `create table if not exists` for the tables
 * the PONS intake left behind so a fresh database can run the job without a
 * manual step. The shapes below are the shapes already in production, read from
 * `information_schema` rather than recalled -- an `if not exists` that disagrees
 * with the live table is a no-op that hides the disagreement.
 */
export const SCHEMA = `
/*
 * The cursor. One row per (chain, token, kind).
 *
 * cursor_block is the highest block PROVEN complete: it advances only in the
 * same transaction that commits the rows for that range. A run that dies
 * halfway leaves it where it was, so the next run re-reads the range. Re-reading
 * is safe because wallet_transactions has a unique key over the event, and
 * skipping is impossible because the cursor never moves past uncommitted data.
 *
 * Deliberately NOT a timestamp and NOT a "last N hours" window: either would
 * skip blocks whenever a run is late or missed.
 */
create table if not exists token_ingest_cursor (
  chain         text        not null,
  token         text        not null,
  kind          text        not null,
  cursor_block  bigint      not null,
  head_block    bigint,
  last_run_at   timestamptz,
  last_status   text,
  last_error    text,
  rows_written  bigint      not null default 0,
  runs          bigint      not null default 0,
  primary key (chain, token, kind)
);

/*
 * In-scope pools for a token. Written by the enumeration step each run.
 * pons_side is the currency index (0 or 1) the tracked token sits on; the name
 * is historical and is kept because the live table uses it.
 */
create table if not exists pool_meta (
  chain        text    not null,
  token        text    not null,
  venue        text    not null,
  pool         text    not null,
  pons_side    integer not null,
  counter      text    not null,
  counter_dec  integer not null,
  counter_sym  text,
  primary key (venue, pool)
);
-- Added after the PONS intake, which predates multi-token support.
alter table pool_meta add column if not exists chain text;
alter table pool_meta add column if not exists token text;
create index if not exists pool_meta_chain_token_idx on pool_meta (chain, token);

/* Token price in USD per block bucket, median of that bucket's USDG-quoted ticks. */
create table if not exists pons_usd_prices (
  chain        text    not null,
  bucket_block bigint  not null,
  pons_usd     numeric not null,
  ticks        integer not null,
  primary key (chain, bucket_block)
);

/*
 * A bridge asset's own USD price per bucket -- the SECOND HOP.
 *
 * Derived from the bridge's pools against a recognised pricing asset, never
 * from pools where the bridge is itself the pricing side of some third token.
 * Keyed by bridge so several can coexist.
 */
create table if not exists bridge_usd_prices (
  chain        text    not null,
  bridge       text    not null,
  bucket_block bigint  not null,
  usd          numeric not null,
  ticks        integer not null,
  primary key (chain, bridge, bucket_block)
);

/* Native (ETH) price in USD per block bucket, derived from the token itself. */
create table if not exists native_usd_prices (
  chain        text    not null,
  block_number bigint  not null,
  eth_usd      numeric not null,
  usd_ticks    integer not null,
  eth_ticks    integer not null,
  primary key (chain, block_number)
);
`;
