/**
 * `npm run launchpad-backfill` — fill `bot_filter_measure.launchpad`.
 *
 * The column existed and nothing wrote it: `filter-measure` assigned the launchpad to
 * its in-memory array AFTER the insert, so every stored row carries NULL and the two
 * launchpad filters in `filter-join` came back **"RETURNED NO ROWS — the filter matched
 * nothing"**. That is the right thing for the query to say and the wrong state for the
 * data to be in, and it is worth fixing because *which launchpad to fish on* is the
 * operator's actual question.
 *
 * The launchpad is the `Initialize` transaction's target, exactly as `LAUNCHBOT.md`
 * defines it and as `ROBINHOOD.md` section 8 measured it. One
 * `eth_getTransactionByHash` per pool at 15 CU.
 *
 * **A TRANSACTION THAT CANNOT BE READ LEAVES THE ROW NULL** rather than guessing, and
 * the count of those is reported — an unreadable launchpad is not "no launchpad", and
 * `0x8366a39cc670…` (the PoolManager itself, meaning direct creation) is a real and
 * different answer from "we could not tell".
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const CU_CEILING = 100_000;

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);
  try {
    const todo = (await c.query<{ pool_id: string; tx_hash: string }>(
      `select distinct m.pool_id, i.tx_hash
         from bot_filter_measure m
         join v4_pool_init i on i.chain = $1 and i.pool_id = m.pool_id
        where m.launchpad is null and i.tx_hash is not null`, [CHAIN])).rows;

    log.info('BEFORE THE FIRST PAID CALL', {
      pools_needing_a_launchpad: todo.length,
      estimate_cu: todo.length * 15,
      ceiling_cu: CU_CEILING,
    });

    let filled = 0; let unreadable = 0;
    for (const t of todo) {
      let pad: string | null = null;
      try {
        const tx = (await rpc.call('eth_getTransactionByHash', [t.tx_hash])) as
          { to?: string | null } | null;
        pad = tx?.to ? tx.to.toLowerCase() : null;
      } catch { pad = null; }
      if (pad === null) { unreadable += 1; continue; }
      const r = await c.query(
        `update bot_filter_measure set launchpad = $3
          where chain = $1 and pool_id = $2 and launchpad is null`,
        [CHAIN, t.pool_id, pad]);
      filled += r.rowCount ?? 0;
    }

    /* VERIFIED BY RE-QUERYING, not by the updates not throwing. */
    const after = (await c.query<{ launchpad: string | null; n: string }>(
      `select launchpad, count(*)::text n from bot_filter_measure
        where chain = $1 group by 1 order by 2 desc`, [CHAIN])).rows;

    log.info('LAUNCHPAD BACKFILL — VERIFIED ON A RE-QUERY', {
      rows_updated: filled,
      transactions_UNREADABLE_left_null: unreadable,
      distribution: after.map((a) => `${a.launchpad ?? 'NULL (unreadable)'} ${a.n}`),
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('launchpad-backfill failed', errorFields(e)); process.exit(1); });
