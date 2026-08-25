/**
 * Tables owned by the pump.fun monitors.
 *
 * The shape follows from one fact: graduation is a ~0.2% event. That makes this
 * an extreme class-imbalance dataset, and it drives every retention decision —
 * the 99.8% that die are what costs storage, and the 0.2% that graduate are what
 * you actually train on. So the negatives get pruned aggressively and the
 * positives are kept at full fidelity, which costs almost nothing.
 *
 * `pump_launches` holds t=0 features and the eventual outcome, so the join that
 * matters ("what did the winners look like at second zero") is a single table
 * scan. `pump_curve_samples` is append-only per-trade detail for the sampled
 * subset.
 */

export const SCHEMA = `
create table if not exists pump_launches (
  monitor_id        text        not null,
  mint              text        not null,
  deployer          text,
  name              text,
  symbol            text,
  uri               text,
  bonding_curve     text,
  pool              text,
  signature         text,

  -- t=0 features, straight off the launch event
  launched_at       timestamptz not null default now(),
  initial_buy_sol   numeric,
  initial_vsol      numeric,
  initial_mcap_sol  numeric,

  -- t=0 features from the token metadata document
  socials_fetched   boolean     not null default false,
  has_twitter       boolean,
  has_telegram      boolean,
  has_website       boolean,
  -- pump.fun writes a self-referential coin URL into "website" for most tokens,
  -- so counting it naively makes ~every launch look like it has a real site.
  website_is_self   boolean,

  -- sampling
  instrumented      boolean     not null default false,
  instrument_reason text,
  -- False for rows created by a graduation of a token that launched before this
  -- monitor was watching. Their outcome is real but their t=0 features are not,
  -- so feature analysis must exclude them rather than read nulls as zeroes.
  observed_from_launch boolean  not null default true,

  -- rolled up from curve samples, so the common query needs no join
  outcome           text        not null default 'pending',
  graduated_at      timestamptz,
  died_at           timestamptz,
  first_sol         numeric,
  peak_sol          numeric,
  last_sol          numeric,
  last_moved_at     timestamptz,
  trade_count       integer     not null default 0,
  sample_count      integer     not null default 0,
  samples_pruned    boolean     not null default false,

  primary key (monitor_id, mint)
);

create index if not exists pump_launches_time_idx
  on pump_launches (monitor_id, launched_at desc);
create index if not exists pump_launches_outcome_idx
  on pump_launches (monitor_id, outcome, launched_at desc);
create index if not exists pump_launches_deployer_idx
  on pump_launches (monitor_id, deployer);
create index if not exists pump_launches_curve_idx
  on pump_launches (monitor_id, bonding_curve);
-- Supports the graduate feed that monitor #2 draws its universe from.
create index if not exists pump_launches_graduated_idx
  on pump_launches (monitor_id, graduated_at desc)
  where outcome = 'graduated';

-- Append-only. One row per bonding-curve account update, which on pump.fun is
-- one row per trade. trade_seq is the per-token counter that makes the paper's
-- metric computable: SOL reached per trade, not merely SOL per second.
create table if not exists pump_curve_samples (
  id           bigserial primary key,
  monitor_id   text        not null,
  mint         text        not null,
  observed_at  timestamptz not null default now(),
  trade_seq    integer     not null,
  age_seconds  numeric,
  real_sol     numeric,
  virtual_sol  numeric,
  -- Price and market cap are SOL-denominated, not USD, and deliberately so:
  -- a return measured against SOL isolates the token's own move from whatever
  -- SOL did over the same minutes. Converting to USD later needs only a SOL
  -- price at the timestamp; recovering the SOL-denominated move from a USD
  -- figure needs the same rate and loses precision doing it.
  price_sol    numeric,
  mcap_sol     numeric,
  complete     boolean     not null default false
);

create index if not exists pump_samples_mint_idx
  on pump_curve_samples (monitor_id, mint, trade_seq);
create index if not exists pump_samples_time_idx
  on pump_curve_samples (monitor_id, observed_at desc);

-- Per-token velocity summary, written when raw samples are collapsed. This is
-- what survives retention, so the features stay queryable after the detail goes.
--
-- The thresholds column is [{sol, trades, seconds}, ...]: how many trades and how many
-- seconds it took to reach each SOL level. Both are kept because they are not
-- the same variable. The published result that motivates this monitor is about
-- trades — reaching a level in FEWER trades predicts graduation — while elapsed
-- time is the intuitive reading of "velocity". Storing both means the dataset
-- can settle which one actually carries the signal instead of assuming.
--
-- It is jsonb rather than fixed columns so the levels stay tunable from YAML
-- without a migration.
create table if not exists pump_velocity_summary (
  monitor_id    text not null,
  mint          text not null,
  thresholds    jsonb,
  -- Fixed-time state: [{t, sol, trades, price_sol, mcap_sol, censored}, ...]
  --
  -- This exists because level-based features leak the outcome. "Trades to reach
  -- 85 SOL" cannot predict graduation, because reaching 85 SOL IS graduating —
  -- comparing groups on it measures the definition, not a signal. A snapshot at
  -- a fixed age does not leak, and it is also the only shape that supports
  -- "what would entering at t have returned", since that question needs a price
  -- at a time rather than a time at a price.
  --
  -- The censored flag marks a snapshot whose timestamp is past where observation
  -- stopped. Those must read as unknown, never as zero.
  snapshots     jsonb,
  -- How far into the token's life observation actually reached. Every snapshot
  -- and threshold has to be read against this or absence looks like failure.
  observed_to_seconds numeric,
  peak_sol      numeric,
  total_trades  integer,
  sol_per_trade numeric,
  computed_at   timestamptz not null default now(),
  primary key (monitor_id, mint)
);

-- The one signal here that needs no low latency, so it is the most reliable.
create table if not exists pump_deployer_stats (
  monitor_id      text        not null,
  deployer        text        not null,
  tokens_launched integer     not null default 0,
  graduations     integer     not null default 0,
  deaths          integer     not null default 0,
  graduation_rate numeric,
  first_launch_at timestamptz,
  last_launch_at  timestamptz,
  updated_at      timestamptz not null default now(),
  primary key (monitor_id, deployer)
);

create index if not exists pump_deployer_rate_idx
  on pump_deployer_stats (monitor_id, graduation_rate desc nulls last, graduations desc);

-- Columns added after the tables were already live. ADD COLUMN IF NOT EXISTS is
-- idempotent, so this is safe to re-run on every boot alongside the creates.
--
-- Rows written before this deploy have null price_sol/mcap_sol and cannot be
-- backfilled: the raw account state carried the token reserves that price is
-- derived from, and only the SOL side was decoded and kept.
alter table pump_curve_samples    add column if not exists price_sol numeric;
alter table pump_curve_samples    add column if not exists mcap_sol  numeric;
alter table pump_velocity_summary add column if not exists snapshots jsonb;
alter table pump_velocity_summary add column if not exists observed_to_seconds numeric;
`;
