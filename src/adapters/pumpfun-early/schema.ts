/**
 * Tables owned by the pump.fun early-window monitor.
 *
 * This monitor exists to answer "which early conditions precede a token going
 * up", so its job is depth rather than breadth: a sample of launches, followed
 * minute by minute for six hours.
 *
 * Two constraints are enforced in the schema rather than left to the code:
 *
 * 1. `mcap_sol` and `price_sol` are NOT NULL. The older monitor's `mcap_sol`
 *    ended up ~60% populated because it was added after collection began and
 *    depended on a field that was not always decoded. Here the market cap comes
 *    from reserves carried on every single trade event, so there is no case
 *    where a snapshot can exist without one — and the constraint makes that a
 *    guarantee instead of an intention.
 *
 * 2. `sol_usd` records the conversion rate used for each row. USD values are
 *    derived, and without the rate they cannot be audited or recomputed later.
 */

export const SCHEMA = `
-- One row per tracked token. Identity, launch-time features, final outcome.
create table if not exists early_tokens (
  monitor_id        text        not null,
  mint              text        not null,

  deployer          text,
  name              text,
  symbol            text,
  uri               text,
  bonding_curve     text,
  pool              text,
  signature         text,

  launched_at       timestamptz not null,
  initial_mcap_sol  numeric,
  initial_vsol      numeric,

  -- 'random'   = drawn by the sampling rate at the create event
  -- 'graduate' = picked up at migration, tracked for the rest of its 6 hours
  sample_reason     text        not null,

  socials_fetched   boolean     not null default false,
  has_telegram      boolean,
  has_twitter       boolean,
  has_website       boolean,
  -- pump.fun writes the coin's own page into "website" for most launches, so
  -- counting it naively makes nearly every token look like it has a site.
  website_is_self   boolean,

  graduated         boolean     not null default false,
  graduated_at      timestamptz,
  died              boolean     not null default false,
  died_at           timestamptz,

  tracking_started_at timestamptz not null default now(),
  tracking_ends_at    timestamptz not null,
  tracking_stopped_at timestamptz,
  stop_reason         text,
  snapshot_count      integer   not null default 0,

  primary key (monitor_id, mint)
);

create index if not exists early_tokens_launch_idx
  on early_tokens (monitor_id, launched_at desc);
create index if not exists early_tokens_reason_idx
  on early_tokens (monitor_id, sample_reason, launched_at desc);
create index if not exists early_tokens_graduated_idx
  on early_tokens (monitor_id, graduated_at desc) where graduated;

-- Append-only. One row per token per scheduled mark. Never updated.
create table if not exists early_snapshots (
  id                   bigserial primary key,
  monitor_id           text        not null,
  mint                 text        not null,
  snapshot_at          timestamptz not null default now(),
  seconds_since_launch numeric     not null,

  -- Curve state. "curve_sol" is REAL SOL in the curve; virtual reserves are the
  -- figures the curve actually prices against, so both are kept.
  curve_sol            numeric     not null,
  virtual_sol          numeric     not null,
  token_reserves       numeric,
  virtual_token_reserves numeric,

  -- Never null, by constraint. See the note at the top of this file.
  mcap_sol             numeric     not null check (mcap_sol >= 0),
  price_sol            numeric     not null check (price_sol >= 0),
  mcap_usd             numeric,
  price_usd            numeric,
  -- The SOL/USD rate used for the two columns above, so they stay auditable.
  sol_usd              numeric,

  -- Cumulative since launch, from decoded per-trade events.
  trades               integer     not null default 0,
  buys                 integer     not null default 0,
  sells                integer     not null default 0,
  buy_volume_sol       numeric     not null default 0,
  sell_volume_sol      numeric     not null default 0,
  unique_buyers        integer     not null default 0,
  unique_sellers       integer     not null default 0,
  largest_buy_sol      numeric,

  -- Always null: holder count needs a per-token RPC call or an indexer, which
  -- is not cheap at this cadence. unique_buyers is the dispersion signal here.
  holder_count         integer,

  -- Populated only after graduation, from DexScreener.
  post_graduation      boolean     not null default false,
  dex_liquidity_usd    numeric,
  dex_volume_24h       numeric,
  dex_txns_24h         integer,
  dex_price_usd        numeric
);

create index if not exists early_snap_mint_idx
  on early_snapshots (monitor_id, mint, seconds_since_launch);
create index if not exists early_snap_time_idx
  on early_snapshots (monitor_id, snapshot_at desc);
`;
