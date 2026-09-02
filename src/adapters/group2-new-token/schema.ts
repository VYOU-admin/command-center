/**
 * Tables owned by the Group 2 high-PnL new-token alert.
 *
 * BOTH ARE PERMANENT. There is no retention here, deliberately: the whole point
 * of group2_token_alerts is to remember, for as long as the token exists, the
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
    create table if not exists group2_token_alerts (
      token              text        not null,
      chain              text        not null,
      last_alerted_count int         not null,
      last_alerted_at    timestamptz not null,
      first_alerted_at   timestamptz not null,
      primary key (token, chain)
    )`);

  await client.query(`
    create table if not exists group2_new_token_cursor (
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
    create table if not exists group2_cycle_stats (
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
}
