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

  /*
   * Which sweep a reading belongs to.
   *
   * NULLABLE AND NOT BACKFILLED. The 798 rows written before the scanner became
   * cursor-based were each produced by a pass that read a whole token at one
   * block, so there is no sweep they can honestly be assigned to. Null means
   * "read before sweeps existed", which is a different fact from "sweep 1" and
   * is worth keeping distinguishable.
   */
  await client.query(
    `alter table token_balance_scans add column if not exists sweep_no bigint`);

  /*
   * Where the rolling sweep stopped.
   *
   * The scanner no longer reads a whole token per pass. It consumes a fixed
   * budget of wallets from one ordering -- (token, wallet) ascending across
   * every seeded token -- and resumes from this row on the next pass. Position
   * is a KEY, not an offset: `(token, wallet) > (last_token, last_wallet)`
   * stays correct when wallets are added or removed between passes, which an
   * integer offset would not.
   *
   * `last_token`/`last_wallet` null means "start of the ordering", the state a
   * fresh cursor is in.
   *
   * sweep_no and sweep_started_at are not optional: without them nothing
   * downstream can tell which readings belong to the same pass over the
   * cohort, and every consumer would be left inferring a sweep boundary from
   * timestamps.
   */
  await client.query(`
    create table if not exists balance_scan_cursor (
      monitor_id       text        not null,
      chain            text        not null,
      last_token       text,
      last_wallet      text,
      sweep_no         bigint      not null default 1,
      sweep_started_at timestamptz not null default now(),
      updated_at       timestamptz not null default now(),
      primary key (monitor_id, chain)
    )`);

  /*
   * Per-token wallet tags.
   *
   * DELIBERATELY NOT wallet_pnl.tag. That column is bound to /api/wallet-tag,
   * which updates `where wallet = any(...)` with no token filter, so a tag set
   * on one token's tab would land on that wallet's rows in every token -- and
   * 558 wallets appear in more than one cohort. Keying on (token, chain, wallet)
   * here keeps tags per token and leaves the existing endpoint untouched.
   *
   * It also survives a re-run structurally: no loader writes a table it does not
   * know about, whereas wallet_pnl.tag survives only while every loader keeps
   * its `tag_source is distinct from 'manual'` guard intact.
   *
   * An empty tag deletes the row rather than storing a blank, so absence is the
   * representation of "no tag".
   *
   * Created here because migrate() is the boot-time hook that runs before the
   * web server serves a request; it is not otherwise related to balance scans.
   */
  await client.query(`
    create table if not exists wallet_tags (
      token      text not null,
      chain      text not null,
      wallet     text not null,
      tag        text not null,
      updated_at timestamptz not null default now(),
      primary key (token, chain, wallet)
    )`);
}
