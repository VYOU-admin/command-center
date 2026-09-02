/**
 * Append-only balance readings.
 *
 * ONE ROW PER (token, wallet, read). Nothing is ever updated: a balance is an
 * observation at a block, and overwriting it would destroy the series this
 * table exists to build. There is deliberately no unique constraint that would
 * invite an upsert.
 *
 * A FAILED READ IS RECORDED, NOT DROPPED AND NOT ZEROED. `balance_raw` is null
 * whenever `status <> 'ok'`, so a wallet that could not be read is
 * distinguishable from one that genuinely holds nothing -- the distinction that
 * 490 rate-limited reads once destroyed by coercing errors to 0.
 *
 * `scan_kind = 'window_close'` marks the seeded baseline; every later pass is
 * 'scan'. The window_close rows also DEFINE THE SCOPE: the scanner reads
 * exactly the wallets that have one, because Group 1 membership depends on
 * transfer logs that are not in the database.
 */
import type { PoolClient } from '../../store/db.js';

export async function migrate(client: PoolClient): Promise<void> {
  await client.query(`
    create table if not exists token_balance_scans (
      id          bigserial primary key,
      token       text        not null,
      chain       text        not null,
      wallet      text        not null,
      block       bigint      not null,
      read_at     timestamptz not null,
      scanned_at  timestamptz not null default now(),
      balance_raw numeric,
      status      text        not null,
      scan_kind   text        not null
    )`);
  await client.query(`create index if not exists tbs_token_wallet_idx
      on token_balance_scans (token, wallet, block desc)`);
  await client.query(`create index if not exists tbs_token_scanned_idx
      on token_balance_scans (token, scanned_at desc)`);
  await client.query(`create index if not exists tbs_kind_idx
      on token_balance_scans (token, scan_kind)`);
}
