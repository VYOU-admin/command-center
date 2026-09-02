/**
 * Tables owned by the Group 1 new-token alert.
 *
 * BOTH ARE PERMANENT. There is no retention here, deliberately: the whole point
 * of group1_token_alerts is to remember, for as long as the token exists, the
 * highest wallet count ever alerted for it. A rolling window would let a token
 * re-alert at a count it had already reached once the old row aged out, which is
 * exactly the repeat noise this monitor exists to avoid -- 307 of 1,273 tokens
 * (24.1%) recurred across hourly buckets under the old monitor's 24h retention.
 *
 * ITS OWN CURSOR, NOT new_token_cursor. The old monitor's cursor is keyed on
 * chain alone with no monitor_id, so writing to it would advance the disabled
 * new-token-watch's position and change its behaviour the moment it is
 * re-enabled. token_pool_first IS shared: it is a monitor-agnostic token -> pool
 * cache whose upsert is idempotent (least() on the block, coalesce on pool_id),
 * so a second writer only ever makes it warmer and more accurate.
 */
import type { PoolClient } from '../../store/db.js';

export async function migrate(client: PoolClient): Promise<void> {
  /*
   * The high-water mark per token.
   *
   * last_alerted_count is the count that was ACTUALLY SENT, never the count that
   * was merely observed. A token whose line was omitted for want of a
   * DexScreener pair must not record a high, or it would be permanently
   * suppressed at that count without ever having been announced.
   */
  await client.query(`
    create table if not exists group1_token_alerts (
      token              text        not null,
      chain              text        not null,
      last_alerted_count int         not null,
      last_alerted_at    timestamptz not null,
      first_alerted_at   timestamptz not null,
      primary key (token, chain)
    )`);

  /*
   * The pool this monitor links for a token, and where the choice came from.
   *
   * ITS OWN TABLE, NOT token_pool_first. That table is shared with
   * new-token-watch, which reads pool_id to build ITS links, and its write uses
   * coalesce(existing, new) so a cached pool is never replaced. Both of those
   * stay exactly as they are: changing either would alter what the disabled
   * monitor emits when re-enabled, which is a silent change to shared state.
   *
   * NO COALESCE HERE, deliberately -- that freeze is the second half of the bug.
   * A later, better-evidenced pool replaces an earlier one on every write, so a
   * token whose real market moves is re-linked rather than stuck.
   *
   * source is 'swap' (the pool the wallets actually traded, from the Swap log)
   * or 'fallback' (DexScreener's highest-liquidity pair). n_transfers is how
   * many of that token's qualifying transfers carried the chosen poolId, and is
   * null for a fallback.
   */
  await client.query(`
    create table if not exists group1_token_pool (
      token       text        not null,
      chain       text        not null,
      pool_id     text        not null,
      source      text        not null,
      n_transfers int,
      updated_at  timestamptz not null default now(),
      primary key (token, chain)
    )`);

  await client.query(`
    create table if not exists group1_new_token_cursor (
      chain            text primary key,
      last_swept_block bigint not null
    )`);

  /*
   * One row per cycle. Not required by the alert, but every number the funnel
   * reports -- detected, eligible, bought, alerted, suppressed, omitted -- is
   * otherwise only in the logs, which roll. message_text is stored so the
   * message that was sent can be quoted back exactly rather than re-rendered
   * from data that has since moved.
   */
  await client.query(`
    create table if not exists group1_cycle_stats (
      ran_at              timestamptz primary key,
      head_block          bigint,
      block_seconds       numeric,
      requests            int,
      watchlist_size      int,
      transfers_seen      int,
      venue_transfers     int,
      tokens_detected     int,
      tokens_eligible_age int,
      tokens_with_buyer   int,
      tokens_alerted      int,
      tokens_suppressed   int,
      omitted_no_pool_id  int,
      omitted_no_pair     int,
      duplicate_symbols   int,
      swept_from          bigint,
      swept_to            bigint,
      duration_ms         int,
      message_text        text
    )`);

  /*
   * ADDED AFTER THE TABLE EXISTED, so create-if-not-exists would not add them.
   * This is not hypothetical: the first deploy of the link fix shipped these
   * inside the create statement, the table already existed, the columns were
   * silently absent, and the next insert would have failed the whole run.
   */
  for (const col of ['linked_from_swap int', 'linked_from_fallback int',
                     'multi_poolid_tokens int', 'ambiguous_receipts int',
                     'extra_rpc_requests int', 'admitted_by_grace int',
                     'receipt_rate_limited int', 'truncated_tokens int',
                     'truncations jsonb', 'phase_sweep_req int',
                     'phase_transfer_req int', 'phase_receipt_req int',
                     'aborted boolean', 'abort_reason text']) {
    await client.query(`alter table group1_cycle_stats add column if not exists ${col}`);
  }
}
