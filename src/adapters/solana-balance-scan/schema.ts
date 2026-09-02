/**
 * Append-only Solana token balance readings.
 *
 * ITS OWN TABLE, NOT A CHAIN COLUMN ON token_balance_scans. Three reasons, and
 * the third is the one that matters: that table's `block` is an EVM block
 * number and Solana needs a slot; its scope is defined by seeded 'window_close'
 * rows that MOS has none of; and every consumer of it today assumes EVM
 * semantics. Putting two meanings in one column is exactly the mistake
 * wallet_pnl_tokens.price_block already represents.
 *
 * FOUR STATES, STORED DISTINCTLY. A failed read is never a zero:
 *   status='ok',         balance_raw = the amount   -- read, may legitimately be 0
 *   status='no_account', balance_raw = null         -- no token account exists
 *   status=<error text>, balance_raw = null         -- the read failed
 *   (never attempted)                               -- no row at all
 *
 * no_account has no EVM equivalent. On Solana an absent token account is a real
 * answer -- never held, or held and closed -- and collapsing it into 0 would
 * claim a measurement of nothing where there was nothing to measure.
 */
import type { PoolClient } from '../../store/db.js';

export async function migrate(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists solana_balance_scans (
      id           bigserial primary key,
      token        text        not null,
      chain        text        not null,
      mint         text        not null,
      wallet       text        not null,
      slot         bigint      not null,
      read_at      timestamptz not null,
      scanned_at   timestamptz not null default now(),
      balance_raw  numeric,
      status       text        not null,
      accounts     int
    )`);
  await client.query(`create index if not exists sbs_token_wallet_idx
      on solana_balance_scans (token, wallet, slot desc)`);
  await client.query(`create index if not exists sbs_token_scanned_idx
      on solana_balance_scans (token, scanned_at desc)`);

  await client.query(`
    create table if not exists solana_scan_stats (
      ran_at        timestamptz primary key,
      token         text,
      slot          bigint,
      accounts_seen int,
      wallets       int,
      ok_nonzero    int,
      ok_zero       int,
      no_account    int,
      failed        int,
      price_usd     numeric,
      total_supply  numeric,
      duration_ms   int,
      requests      int,
      error         text
    )`);

  /*
   * Solana has no block number. price_block is an EVM block and is left alone;
   * these two carry the Solana read point instead. price_slot is the
   * chain-native cursor, price_read_at is what a card can actually render and
   * is chain-agnostic. Added with alter-table because wallet_pnl_tokens already
   * exists and create-if-not-exists would not add them.
   */
  for (const col of ['price_slot bigint', 'price_read_at timestamptz']) {
    await client.query(`alter table wallet_pnl_tokens add column if not exists ${col}`);
  }
}
