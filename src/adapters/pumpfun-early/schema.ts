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
  -- When this token last actually traded. Distinguishes "quiet" from "gone".
  last_trade_at       timestamptz,
  -- Outcome of the 10-minute decision: 'activity', 'control', 'graduated',
  -- or null if the token was dropped to outcome-marks-only.
  keep_reason         text,
  decided_at          timestamptz,
  curve_sol_at_decision numeric,
  -- Set once this token's snapshots have been collapsed by retention, so a
  -- maintenance pass never re-examines a token it has already finished with.
  snapshots_pruned    boolean   not null default false,

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
  dex_price_usd        numeric,

  -- Which price regime this row belongs to: 'curve' before graduation, 'dex'
  -- after. Once a token graduates its bonding curve completes and all trading
  -- moves to the AMM, so price_sol and price_usd freeze at their
  -- graduation-instant values and stay there forever. Without this column an
  -- analysis reading price_usd across a graduation sees a flat line where the
  -- token may in fact have doubled.
  price_source         text,

  -- The one column a return analysis should read. Carries the DEX price once
  -- graduated and the curve price before, so it never needs to know the token's
  -- state.
  --
  -- Deliberately NULL when the regime is 'dex' but DexScreener has not reported
  -- yet, rather than falling back to the frozen curve price. A gap that is
  -- visible is safer than a stale number that looks live.
  price_usd_effective  numeric,

  -- False when no trade arrived between this snapshot and the one before it.
  -- The curve price is carried forward while a token is idle, so a return
  -- computed across such rows is exactly 0% — not because the price held, but
  -- because nothing traded. A frozen last print must never read as a flat
  -- return, and this is what tells the two apart.
  has_market           boolean,

  -- 'early' (first 10 minutes, every launch), 'extended' (kept past the
  -- decision mark), or 'outcome' (dropped, but still owed its forced marks).
  phase                text,
  -- A forced mark written regardless of trading state. Retention never prunes
  -- these: they are the outcome variable, and the death rule must not decide
  -- the outcome horizon.
  is_outcome_mark      boolean     not null default false
);

create index if not exists early_snap_mint_idx
  on early_snapshots (monitor_id, mint, seconds_since_launch);
create index if not exists early_snap_time_idx
  on early_snapshots (monitor_id, snapshot_at desc);

-- Columns added after the tables were live. ADD COLUMN IF NOT EXISTS is
-- idempotent, so this re-runs harmlessly on every boot alongside the creates.
alter table early_snapshots add column if not exists price_source        text;
alter table early_snapshots add column if not exists price_usd_effective numeric;
alter table early_snapshots add column if not exists has_market          boolean;
alter table early_tokens    add column if not exists last_trade_at       timestamptz;
alter table early_snapshots add column if not exists phase               text;
alter table early_snapshots add column if not exists is_outcome_mark     boolean not null default false;
alter table early_tokens    add column if not exists keep_reason         text;
alter table early_tokens    add column if not exists decided_at          timestamptz;
alter table early_tokens    add column if not exists curve_sol_at_decision numeric;
alter table early_tokens    add column if not exists snapshots_pruned    boolean not null default false;
-- Set once the dense early grid has been thinned for a token that turned out
-- uninteresting. Separate from snapshots_pruned: that flag tracks the
-- carried-forward collapse, this one the second tier.
alter table early_tokens    add column if not exists dense_pruned        boolean not null default false;

-- Finds the next batch due for dense thinning in one index scan.
create index if not exists early_tokens_dense_prune_idx
  on early_tokens (monitor_id, launched_at)
  where not dense_pruned;

-- Finds the next batch of tokens due for collapsing in one index scan, rather
-- than sequentially scanning every token ever launched.
create index if not exists early_tokens_prune_idx
  on early_tokens (monitor_id, launched_at)
  where not snapshots_pruned;

create index if not exists early_snap_outcome_idx
  on early_snapshots (monitor_id, is_outcome_mark, seconds_since_launch)
  where is_outcome_mark;
create index if not exists early_snap_phase_idx
  on early_snapshots (monitor_id, phase, seconds_since_launch);

create index if not exists early_snap_market_idx
  on early_snapshots (monitor_id, has_market, seconds_since_launch);

-- BACKFILL. Each statement only touches rows the new column has not reached, so
-- once it has run there is nothing left to match and re-running costs a scan.

-- price_source follows the graduation regime, exactly as post_graduation
-- recorded it at the time the row was written.
update early_snapshots
   set price_source = case when post_graduation then 'dex' else 'curve' end
 where price_source is null;

-- The effective price follows the regime, and stays null where the regime says
-- 'dex' but no DEX price had arrived yet.
update early_snapshots
   set price_usd_effective = case
         when price_source = 'dex' then dex_price_usd
         else price_usd
       end
 where price_usd_effective is null
   and (price_source = 'curve' or dex_price_usd is not null);

-- has_market is reconstructed by comparing each row's cumulative trade count
-- with the previous snapshot for the same token. The first snapshot of a token
-- has no predecessor, so it counts as having a market if it saw any trade at all.
update early_snapshots s
   set has_market = c.computed
  from (
    select id,
           case
             when prev_trades is null then trades > 0
             else trades > prev_trades
           end as computed
      from (
        select id, trades,
               lag(trades) over (partition by monitor_id, mint
                                 order by seconds_since_launch) as prev_trades
          from early_snapshots
      ) w
  ) c
 where s.id = c.id and s.has_market is null;

-- last_trade_at is reconstructed as the timestamp of the most recent snapshot
-- at which the trade count actually advanced.
update early_tokens t
   set last_trade_at = m.last_at
  from (
    select monitor_id, mint, max(snapshot_at) as last_at
      from early_snapshots
     where has_market
     group by monitor_id, mint
  ) m
 where t.monitor_id = m.monitor_id and t.mint = m.mint and t.last_trade_at is null;
`;
