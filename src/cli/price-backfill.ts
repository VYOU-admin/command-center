/**
 * `npm run price-backfill -- [--commit]`
 *
 * FILLS px_30s / px_60s / px_120s / px_300s ON bot_trades, WHICH WERE ALL NULL.
 *
 * The bot's exit is a fixed +30s from entry, chosen from the backtest grid. Those four
 * columns are how that choice gets checked against what the bot itself saw, rather than
 * against the corpus it was fitted on. Until they are populated the exit rule is an
 * inherited number, not a measured one.
 *
 * ONE eth_getLogs PER TRADE, 60 CU. The v4 Swap event indexes the pool id as topic1,
 * so a single filtered request returns exactly that pool's swaps over the 300 seconds
 * after entry and nothing else. Reading the PoolManager unfiltered would return every
 * pool's swaps over 3,000 blocks to find one pool's.
 *
 * A WINDOW THAT HAS NOT ELAPSED YET IS LEFT NULL AND COUNTED, never written as a zero
 * or as the last known price. A null here means "not yet observable"; a zero would mean
 * "the price went to zero", and the two must never be confused. Rows skipped for that
 * reason are reported separately from rows where the pool simply had no swap.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { BACKFILL_OFFSETS_S, ENTRY_DELAY_BLOCKS, POOL_MANAGER } from '../bot/config.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { BOT_SCHEMA } from '../bot/state.js';
import { swapAmounts, tokenPrice } from '../bot/price.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const BLOCKS_PER_SECOND = 10;
const GETLOGS_CU = 60;

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query(BOT_SCHEMA);
    const rows = await c.query<{
      id: string; pool_id: string; token: string; counter: string;
      first_swap_block: string; px_entry: string | null;
    }>(
      `select id::text, pool_id, token, counter, first_swap_block::text, px_entry::text
         from bot_trades
        where chain = 'robinhood' and first_swap_block is not null
          and (px_30s is null or px_60s is null or px_120s is null or px_300s is null)
        order by first_swap_block`);

    const head = Number(BigInt(String(await (async (): Promise<unknown> => {
      const key0 = process.env['ALCHEMY_API_KEY'];
      if (!key0) throw new Error('ALCHEMY_API_KEY is not set');
      return new RpcClient(RPC_URL.replace('{key}', key0), 60000, 1000)
        .raw('eth_blockNumber', []);
    })())));

    const maxOffset = Math.max(...BACKFILL_OFFSETS_S) * BLOCKS_PER_SECOND;
    const ready = rows.rows.filter((r) =>
      Number(r.first_swap_block) + ENTRY_DELAY_BLOCKS + maxOffset <= head);
    const tooRecent = rows.rowCount! - ready.length;

    log.info('BACKFILL WORK SET, derived BEFORE the first request', {
      rows_missing_any_price: rows.rowCount,
      head,
      ready_to_fill: ready.length,
      too_recent_window_not_elapsed: tooRecent,
      estimate: { cu: ready.length * GETLOGS_CU,
        usd: ((ready.length * GETLOGS_CU * 0.45) / 1e6).toFixed(5) },
      commit,
      note: 'a row whose +300s window has not elapsed is left NULL and counted, never '
        + 'filled with a stale or zero price',
    });
    if (ready.length === 0) {
      log.info('NOTHING TO FILL', { note: 'reported as a result, not treated as success' });
      c.release(); await app.pool.end(); process.exit(0);
    }
    if (!commit) {
      log.info('DRY RUN -- nothing read, nothing written', { note: 'pass --commit' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set');
    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000,
      Math.ceil(ready.length * GETLOGS_CU * 1.5));

    let filled = 0; let noSwaps = 0; let failed = 0;
    for (const r of ready) {
      const entryBlock = Number(r.first_swap_block) + ENTRY_DELAY_BLOCKS;
      try {
        const logs = (await rpc.raw('eth_getLogs', [{
          address: POOL_MANAGER,
          topics: [TOPICS.swapV4, r.pool_id],
          fromBlock: `0x${entryBlock.toString(16)}`,
          toBlock: `0x${(entryBlock + maxOffset).toString(16)}`,
        }])) as Array<{ blockNumber: string; data: string; logIndex: string }>;
        if (logs.length === 0) { noSwaps += 1; continue; }

        /*
         * TOKEN SIDE BY ADDRESS ORDER, which is what the v4 pool key itself uses, and
         * the price from bot/price.ts so this agrees with what the bot recorded at
         * entry. Computing it here independently is what produced an exit grid of
         * -1.0000 at every horizon.
         */
        const tokenIsZero = r.token.toLowerCase() < r.counter.toLowerCase();
        const ticks = logs.map((l) => {
          const a = swapAmounts(l.data);
          if (!a) return null;
          return { block: Number(BigInt(l.blockNumber)), price: tokenPrice(a, tokenIsZero) };
        }).filter((x): x is { block: number; price: number } => x !== null && x.price > 0);
        if (ticks.length === 0) { noSwaps += 1; continue; }

        const at = (secs: number): number | null => {
          const cut = entryBlock + secs * BLOCKS_PER_SECOND;
          const before = ticks.filter((t) => t.block <= cut);
          /* LAST TRADE AT OR BEFORE THE MARK. No trade yet means no price yet -- null,
           * never the entry price carried forward, which would report a flat return the
           * pool never produced. */
          return before.length ? before[before.length - 1]!.price : null;
        };
        await c.query(
          `update bot_trades set px_30s=$2, px_60s=$3, px_120s=$4, px_300s=$5,
                  updated_at = now() where id = $1`,
          [r.id, at(30), at(60), at(120), at(300)]);
        filled += 1;
      } catch (err) {
        /* A READ THAT FAILS IS COUNTED AND LEFT NULL. It is never a zero price. */
        failed += 1;
        log.warn('backfill read failed', { trade: r.id, pool: r.pool_id,
          error: (err as Error).message.slice(0, 160) });
      }
    }
    log.info('BACKFILL COMPLETE', {
      attempted: ready.length, filled, pool_had_no_swaps: noSwaps, read_failed: failed,
      too_recent_left_null: tooRecent,
      cu_spent: rpc.cuSpent ?? 'unknown',
    });
  } finally { c.release(); }

  /* VERIFIED ON A FRESH CONNECTION, not from this script exiting cleanly. */
  const fresh = await app.pool.connect();
  try {
    const v = await fresh.query(
      `select count(*)::int total,
              count(px_30s)::int p30, count(px_60s)::int p60,
              count(px_120s)::int p120, count(px_300s)::int p300
         from bot_trades where chain = 'robinhood'`);
    log.info('VERIFIED ON A FRESH CONNECTION', { ...v.rows[0] });
  } finally { fresh.release(); }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('price-backfill failed', errorFields(err)); process.exit(1); });
