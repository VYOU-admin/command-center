/**
 * Tables owned by the oil price monitor.
 *
 * Append-only by design: every scrape writes a row for every source and every
 * gallon band whether or not anything moved. The unchanged rows are the price
 * history — a table that only recorded changes could tell you a price was $4.58
 * on two dates but not whether it held steady in between or was never checked.
 */

export const SCHEMA = `
-- One row per source, per gallon band, per scrape. Never updated.
create table if not exists oil_observations (
  id              bigserial primary key,
  monitor_id      text        not null,
  source          text        not null,
  observed_at     timestamptz not null default now(),

  -- Location, for the zip-driven source. Null for single-location vendors.
  zip             text,
  city            text,
  state           text,

  -- Dealer listing identity, for sources that list several vendors. Position is
  -- 1-based as displayed. Both are stored because listing order is not stable:
  -- without the id, a reordering of dealers is indistinguishable from a price
  -- change and would fire a false alert.
  -- listing_id is PAGE level on cashheatingoil (one per zip search), not per
  -- dealer. dealer_id comes from a hidden field inside each listing block and
  -- is the real per-vendor identity — it is what makes a price change
  -- distinguishable from the dealer list simply reordering.
  listing_id      text,
  dealer_id       text,
  listing_position integer,

  product         text        not null default 'fuel_oil',
  payment_type    text,
  gallon_min      integer,
  gallon_max      integer,

  -- Never null. A source that cannot be parsed records no row at all rather
  -- than a row with a null or zero price: a silently wrong price is worse than
  -- a missing one, and a zero would quietly poison every average and alert.
  price_per_gallon numeric    not null check (price_per_gallon > 0),

  gallon_minimum  integer,
  surcharge_note  text,
  price_date      date,
  delivery_date   date,
  price_updated_on date
);

create index if not exists oil_obs_time_idx
  on oil_observations (monitor_id, observed_at desc);
create index if not exists oil_obs_source_time_idx
  on oil_observations (monitor_id, source, observed_at desc);
-- Supports "the previous value for this exact quote", which is what change
-- detection diffs against.
create index if not exists oil_obs_key_idx
  on oil_observations (monitor_id, source, zip, dealer_id, payment_type,
                       gallon_min, product, observed_at desc);

-- Vendor-published historical prices, backfilled once. Keyed by date rather
-- than append-only: re-reading the same table must not duplicate 2008.
create table if not exists oil_price_history (
  monitor_id       text    not null,
  source           text    not null,
  price_date       date    not null,
  price_per_gallon numeric not null check (price_per_gallon > 0),
  first_seen_at    timestamptz not null default now(),
  primary key (monitor_id, source, price_date)
);

-- Per-source health. The spine tracks failure streaks per MONITOR, but this
-- monitor scrapes several sites in one run and one failing must not stop the
-- others. Without per-source tracking a permanently broken scraper would sit
-- inside successful runs and never be noticed — the exact silent failure the
-- rest of this project is built to avoid.
create table if not exists oil_source_state (
  monitor_id           text not null,
  source               text not null,
  consecutive_failures integer     not null default 0,
  last_ok_at           timestamptz,
  last_attempt_at      timestamptz,
  last_error           text,
  failure_alert_sent   boolean     not null default false,
  backfilled_at        timestamptz,
  primary key (monitor_id, source)
);

-- Change detection and digest bookkeeping, so alerts fire on edges and the
-- daily digest fires once per local day rather than once per run.
create table if not exists oil_alert_state (
  monitor_id        text primary key,
  last_alert_at     timestamptz,
  last_digest_on    date,
  last_change_count integer
);
`;
