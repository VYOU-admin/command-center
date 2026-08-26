/**
 * Storage for the early-activity alert.
 *
 * Append-only, one row per token, ever. The primary key is what enforces
 * "alert exactly once": the insert is attempted with ON CONFLICT DO NOTHING and
 * only a row that was actually inserted produces a Discord message, so a
 * restart, an overlapping run, or a re-evaluated snapshot cannot alert twice.
 *
 * Every field carried in the alert is stored alongside it. That is the point of
 * the table: it is the record used later to ask whether these alerts were worth
 * acting on, and an alert whose inputs were not captured cannot be scored.
 */
export const SCHEMA = `
create table if not exists early_alerts (
  monitor_id            text        not null,
  mint                  text        not null,

  alerted_at            timestamptz not null default now(),
  -- Age of the token when the alert fired. The trigger mark is 5 minutes, so
  -- anything materially above 300s is delivery latency and is visible here.
  age_at_alert_seconds  numeric,

  name                  text,
  symbol                text,

  curve_sol             numeric,
  mcap_usd              numeric,
  price_usd             numeric,

  trade_count           integer,
  buy_count             integer,
  sell_count            integer,
  unique_buyers         integer,
  unique_sellers        integer,

  buy_volume_sol        numeric,
  sell_volume_sol       numeric,
  largest_buy_sol       numeric,
  -- Stored rather than derived so the threshold in force at alert time stays
  -- reconstructable after the YAML has been retuned.
  largest_buy_share     numeric,

  has_telegram          boolean,
  has_twitter           boolean,
  has_website           boolean,

  -- The thresholds this alert was judged against, for the same reason.
  min_curve_sol         numeric,
  max_buy_share         numeric,

  -- UNVALIDATED TEST RANGES. These do not gate the alert; they are recorded so
  -- the question "did these ranges mean anything" can be answered later from
  -- stored data rather than re-derived. Null ratio means no buy volume, which
  -- is not the same as a ratio of zero.
  sell_buy_ratio        numeric,
  in_test_curve_range   boolean,
  in_test_sell_buy_range boolean,
  test_curve_min        numeric,
  test_curve_max        numeric,
  test_sell_buy_max     numeric,

  primary key (monitor_id, mint)
);

-- The table predates the test-range columns, so add them idempotently rather
-- than relying on the create above for an existing deployment.
alter table early_alerts add column if not exists sell_buy_ratio         numeric;
alter table early_alerts add column if not exists in_test_curve_range    boolean;
alter table early_alerts add column if not exists in_test_sell_buy_range boolean;
alter table early_alerts add column if not exists test_curve_min         numeric;
alter table early_alerts add column if not exists test_curve_max         numeric;
alter table early_alerts add column if not exists test_sell_buy_max      numeric;

create index if not exists early_alerts_time_idx
  on early_alerts (monitor_id, alerted_at desc);
`;
