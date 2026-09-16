/**
 * Bot state. THE ONLY DURABLE RECORD -- a container replacement destroys /app and
 * everything in memory, which ROBINHOOD.md records happening twice on this project.
 *
 * A POSITION IS ONLY REAL IF POSTGRES SAYS SO, AND THE CHAIN ADJUDICATES.
 */
import type { PoolClient } from '../store/db.js';

export const BOT_SCHEMA = `
create table if not exists bot_trades (
  id              bigserial primary key,
  chain           text        not null,
  mode            text        not null,
  pool_id         text        not null,
  token           text        not null,
  counter         text        not null,
  launchpad       text,
  fee             integer,
  tick_spacing    integer,
  hooks           text,
  status          text        not null,
  init_block      bigint,
  first_swap_block bigint,
  entry_block     bigint,
  exit_block      bigint,
  age_blocks_at_entry bigint,
  age_seconds_at_entry numeric,
  swaps_before_entry  integer,
  senders_before_entry integer,
  position_wei    numeric,
  position_usd    numeric,
  quoted_out      numeric,
  min_out         numeric,
  executed_out    numeric,
  entry_price     numeric,
  exit_price      numeric,
  realised_slippage_entry numeric,
  realised_slippage_exit  numeric,
  gas_usd         numeric,
  gross_return    numeric,
  net_pnl_usd     numeric,
  fill_status     text,
  fill_wait_blocks bigint,
  px_30s numeric, px_60s numeric, px_120s numeric, px_300s numeric,
  entry_tx        text,
  exit_tx         text,
  entry_calldata  text,
  exit_calldata   text,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists bot_trades_status_idx on bot_trades (chain, status);
create index if not exists bot_trades_mode_idx   on bot_trades (chain, mode, created_at desc);
create unique index if not exists bot_trades_pool_uniq on bot_trades (chain, mode, pool_id);

create table if not exists bot_control (
  chain    text primary key,
  halted   boolean not null default false,
  reason   text,
  updated_at timestamptz not null default now()
);

-- EVERY NEW COLUMN NEEDS ITS OWN ALTER. A 'create table if not exists' is a NO-OP on an
-- existing table, so a column added to the literal above reaches a fresh database and
-- never reaches this one. That is rule one of ROBINHOOD.md section 7, and it has
-- already cost this project a run where every insert threw on a missing 'side'.
alter table bot_trades add column if not exists exit_sim_status text;
alter table bot_trades add column if not exists exit_sim_note   text;
alter table bot_trades add column if not exists exit_sim_from   text;
alter table bot_trades add column if not exists px_entry        numeric;
alter table bot_trades add column if not exists exit_attempts     integer;
alter table bot_trades add column if not exists exit_filled_on    integer;
alter table bot_trades add column if not exists exit_bound_bps    integer;
alter table bot_trades add column if not exists exit_requote_out  numeric;
alter table bot_trades add column if not exists exit_due_block    bigint;
alter table bot_trades add column if not exists quote_basis       text;

-- EVERY EXIT ATTEMPT, RECORDED BEFORE THE NEXT ONE BEGINS.
-- bot/exit.ts persists each rung as it is tried, so a container replaced mid-ladder
-- inherits the trail rather than nothing. ROBINHOOD.md records containers being
-- replaced mid-job twice.
create table if not exists bot_exit_attempts (
  chain        text    not null,
  trade_id     bigint  not null,
  attempt      integer not null,
  bound_bps    integer not null,
  expected_out numeric,
  min_out      numeric,
  ok           boolean not null,
  detail       text,
  sell_from    text,
  recorded_at  timestamptz not null default now(),
  primary key (chain, trade_id, attempt)
);
`;

/** Statuses a boot reconciliation must resolve. Anything else is terminal. */
export const NON_TERMINAL = ['intent', 'entry_sent', 'holding', 'exit_sent'];

/**
 * THE KILL SWITCH IS A ROW, RE-READ ON A FRESH CONNECTION BEFORE EVERY TRADE.
 *
 * A flag in memory dies with the container and cannot be set from outside it. A row can
 * be set by anyone with a database connection while the bot is mid-flight, which is the
 * entire point: stopping it must not require a deploy.
 *
 * A read that FAILS halts. An unreachable database is not permission to keep trading.
 */
export async function isHalted(c: PoolClient, chain: string): Promise<{ halted: boolean; reason: string }> {
  try {
    const r = await c.query<{ halted: boolean; reason: string | null }>(
      'select halted, reason from bot_control where chain = $1', [chain]);
    if (r.rowCount === 0) return { halted: false, reason: '' };
    return { halted: r.rows[0]!.halted, reason: r.rows[0]!.reason ?? '' };
  } catch (err) {
    return { halted: true, reason: `kill-switch read failed: ${(err as Error).message}` };
  }
}

export async function halt(c: PoolClient, chain: string, reason: string): Promise<void> {
  await c.query(
    `insert into bot_control (chain, halted, reason) values ($1, true, $2)
     on conflict (chain) do update set halted = true, reason = $2, updated_at = now()`,
    [chain, reason]);
}
