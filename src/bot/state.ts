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

-- THE KILL SWITCH IS KEYED (chain, mode) AS OF 2026-09-16, AND MIGRATED IN PLACE.
--
-- It was keyed on CHAIN alone, which made every halt chain-wide -- right for a manual
-- emergency stop and WRONG for an automatic one. A dry run holds nothing, so its
-- inability to clear a hypothetical position said nothing about live exposure, and yet
-- it stopped live trading. That was demonstrated twice in one afternoon.
--
-- mode = '*' (ALL_MODES) means CHAIN-WIDE, which is what a manual halt writes.
-- mode = a real mode means that mode only, which is what an automatic halt writes.
--
-- EXISTING ROWS BACKFILL TO THE SENTINEL because they WERE chain-wide by construction --
-- there was no other kind. The one extant row is already cleared, so the backfill changes
-- no behaviour; it only labels history with the scope it actually had.
alter table bot_control add column if not exists mode text;
update bot_control set mode = '*' where mode is null;

-- THE PRIMARY KEY IS REPLACED ONCE AND THE GUARD IS THE COLUMN COUNT.
-- This schema runs on EVERY boot, so 'drop then add' unguarded would fail the second
-- time and take the whole statement -- and every boot -- with it. Testing conkey's
-- length means the branch is false once the key is already (chain, mode), so it is
-- genuinely idempotent rather than merely surviving.
do $do$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'bot_control_pkey' and array_length(conkey, 1) = 1
  ) then
    alter table bot_control drop constraint bot_control_pkey;
    -- Postgres sets NOT NULL on a primary-key column, so mode needs no separate alter.
    alter table bot_control add primary key (chain, mode);
  end if;
end
$do$;

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

-- AND ITS OWN ALTERS, AFTER THE CREATE RATHER THAN BEFORE IT.
--
-- These were first written ABOVE the create, which would have FAILED ON A FRESH DATABASE:
-- an alter on a table that does not exist yet is an error, not a no-op, and the whole
-- schema statement would have aborted. The existing container already has the table, so
-- it would have worked here and broken only on a rebuild -- the shape ROBINHOOD.md
-- records for token_swap_logs, which every reader assumed existed because the first
-- intake made it by hand. (It also broke the build immediately, because the backticks
-- this comment originally used to quote those names terminated the template literal
-- BOT_SCHEMA is written in. Two defects, one of which announced itself.)
--
-- THE RECEIPT WAIT, SO THE INCLUSION HALF BECOMES MEASURABLE ON THE FIRST LIVE EXIT.
-- receipt-timing measured the RECEIPT AVAILABILITY half exactly -- 60 of 60 served on
-- the first ask, max 36 ms -- and CANNOT measure inclusion, because nothing here can
-- send: the gap between our broadcast and a block taking it has never been observed.
-- These two columns are how the first real exit measures it, rather than the timeout
-- staying a margin for ever. NULL on every simulated attempt, which is every attempt
-- recorded so far.
alter table bot_exit_attempts add column if not exists receipt_wait_ms integer;
alter table bot_exit_attempts add column if not exists receipt_polls  integer;
`;

/** Statuses a boot reconciliation must resolve. Anything else is terminal. */
export const NON_TERMINAL = ['intent', 'entry_sent', 'holding', 'exit_sent'];

/**
 * STATUSES IN WHICH THE WALLET MAY STILL BE HOLDING THE TOKEN, AND THEREFORE STILL HAS
 * CAPITAL DEPLOYED. THIS IS WIDER THAN `NON_TERMINAL` AND THE DIFFERENCE MATTERS.
 *
 * `NON_TERMINAL` answers "what must boot reconciliation resolve". `HELD` answers a
 * different question — "what is our money still in" — and a position the exit ladder
 * FAILED to sell is the clearest possible yes to the second while sitting outside the
 * first. That is the worst kind of deployed capital, not the least: it is money in a
 * token nothing has been able to sell.
 *
 * `exit_exhausted` IS IN THIS SET BECAUSE SEVEN SUCH ROWS EXIST. It was replaced by
 * `needs_exit` on 2026-09-16 precisely because it is in no sweep's set, but the rows
 * written before that fix were never migrated, so they sit in a status nothing looks at.
 * Leaving it out of the capital cap would let $70 of stuck positions read as $0 deployed.
 *
 * MAX_CONCURRENT STILL USES THE NARROWER `NON_TERMINAL`, deliberately and pending an
 * operator decision — widening a rail that has been exercised is a change to what that
 * rail means. LAUNCHBOT.md section 7 carries it as open.
 */
export const HELD = [...NON_TERMINAL, 'needs_exit', 'exit_exhausted'];

/**
 * THE SENTINEL MODE MEANING "EVERY MODE ON THIS CHAIN".
 *
 * It cannot collide with a real mode: `resolveMode` only ever produces `'live'` or a
 * `'dry-run'`-prefixed label, and `'*'` is neither. Exported so no caller writes the
 * literal, which is how a sentinel quietly becomes two sentinels.
 */
export const ALL_MODES = '*';

export interface HaltState {
  halted: boolean;
  reason: string;
  /** Which row stopped it: 'chain' for a manual chain-wide halt, 'mode', or '' when clear. */
  scope: 'chain' | 'mode' | '';
}

/**
 * THE KILL SWITCH IS A ROW, RE-READ ON A FRESH CONNECTION BEFORE EVERY TRADE.
 *
 * A flag in memory dies with the container and cannot be set from outside it. A row can
 * be set by anyone with a database connection while the bot is mid-flight, which is the
 * entire point: stopping it must not require a deploy.
 *
 * ---------------------------------------------------------------------------
 * TWO SCOPES, DECIDED 2026-09-16 BY THE OPERATOR
 * ---------------------------------------------------------------------------
 *
 * **A MANUAL HALT IS CHAIN-WIDE. AN AUTOMATIC HALT IS SCOPED TO THE MODE THAT RAISED IT.**
 *
 * The scopes are not a refinement of one idea, they answer different questions:
 *
 *   - A human reaching for the switch wants EVERYTHING to stop and cannot be required to
 *     know which modes are running. A mode-scoped emergency stop is not an emergency stop.
 *   - An automatic halt is a statement about the run that raised it. A dry run holds
 *     nothing and risks nothing, so its inability to close a hypothetical position says
 *     nothing about live exposure — and it used to stop live trading anyway. That was
 *     demonstrated twice in one afternoon: a dry-run boot halted the chain, and the
 *     cleanup for it halted the chain again.
 *
 * **A CHAIN-WIDE HALT WINS AND IS REPORTED AS SUCH.** Both rows are read; the chain-wide
 * one is checked first, so a manual stop is never masked by a mode's own state, and the
 * scope is returned so a log line says which row stopped the bot rather than only that
 * something did.
 *
 * A read that FAILS halts. An unreachable database is not permission to keep trading.
 */
export async function isHalted(
  c: PoolClient, chain: string, mode: string,
): Promise<HaltState> {
  try {
    const r = await c.query<{ mode: string; halted: boolean; reason: string | null }>(
      `select mode, halted, reason from bot_control
        where chain = $1 and mode in ($2, $3)`, [chain, ALL_MODES, mode]);
    /* CHAIN-WIDE FIRST: a manual stop must not be masked by a mode's own row. */
    const wide = r.rows.find((x) => x.mode === ALL_MODES && x.halted);
    if (wide !== undefined) {
      return { halted: true, scope: 'chain',
        reason: `[CHAIN-WIDE] ${wide.reason ?? 'halted'}` };
    }
    const own = r.rows.find((x) => x.mode === mode && x.halted);
    if (own !== undefined) {
      return { halted: true, scope: 'mode',
        reason: `[mode ${mode}] ${own.reason ?? 'halted'}` };
    }
    return { halted: false, reason: '', scope: '' };
  } catch (err) {
    return { halted: true, scope: 'chain',
      reason: `kill-switch read failed: ${(err as Error).message}` };
  }
}

/**
 * AN AUTOMATIC HALT. Scoped to the mode that raised it, always.
 *
 * **THERE IS NO WAY TO RAISE A CHAIN-WIDE HALT FROM THE BOT, AND THAT IS THE POINT.**
 * `mode` is a required parameter rather than an optional one defaulting to the sentinel,
 * because a default is exactly how every automatic halt became chain-wide in the first
 * place. A manual chain-wide stop is set by an operator through `halt-control`, which is
 * not the bot.
 */
export async function halt(
  c: PoolClient, chain: string, mode: string, reason: string,
): Promise<void> {
  if (mode === ALL_MODES) {
    throw new Error('halt() is the AUTOMATIC path and is always mode-scoped. It will not '
      + `write the ${ALL_MODES} sentinel: a chain-wide stop is a human's decision, set `
      + 'through halt-control, and the bot must not be able to stop every mode because '
      + 'one of its own runs could not close a position.');
  }
  await c.query(
    `insert into bot_control (chain, mode, halted, reason) values ($1, $2, true, $3)
     on conflict (chain, mode) do update
       set halted = true, reason = $3, updated_at = now()`,
    [chain, mode, reason]);
}
