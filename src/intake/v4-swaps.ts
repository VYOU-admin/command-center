/**
 * v4 `Swap` logs from the PoolManager, for a bounded block range.
 *
 * WHY A SECOND SWEEP EXISTS. `v4_swaps_all` was built for the PONS window and stops at
 * block 42,695,454. The fee-tier finding was measured entirely inside it, so testing
 * whether it still holds needs swaps from a RECENT range -- and the returns cannot be
 * computed from `Initialize` alone.
 *
 * IT REUSES `TOPICS.swapV4` AND `decodeSwap`, AND THE FIRST DRAFT OF THIS FILE DID
 * NEITHER. It defined its own topic constant, transcribed from this document's
 * truncated "0x40e9cecb..." and INVENTED after the tenth character. That topic matches
 * zero logs across any span and reads as a clean sweep -- the defect step 3 says has
 * already shipped here once. It also wrote a second amount decoder beside the one in
 * `decode.ts`, which is the two-implementations trap the document records five times.
 * Both are now imports.
 *
 * IT IS DELIBERATELY BOUNDED AND UNFILTERED, and that is a cost decision made against
 * step 5's warning that "an unfiltered PoolManager sweep returns every v4 swap on the
 * chain -- 33.2M rows and 14 GB for one month". That warning is about a MONTH. Over a
 * window of ~1M blocks it is ~1/26th of it. Filtering by pool id instead needs the
 * 500-id chunking rule, and with thousands of launch pools that multiplies the REQUEST
 * count -- the metered quantity -- by the chunk count. Unfiltered is cheaper in
 * requests and dearer in rows.
 *
 * It writes into `v4_swaps_all`, so every downstream definition is unchanged.
 */
import type { PoolClient } from '../store/db.js';
import type { RpcClient, LogEntry } from '../adapters/token-updates/rpc.js';
import { TOPICS, decodeSwap } from '../adapters/token-updates/decode.js';

export const V4_SWEEP_SCHEMA = `
create table if not exists v4_recent_sweep_progress (
  chain      text    not null,
  from_block bigint  not null,
  to_block   bigint  not null,
  logs       integer not null,
  swept_at   timestamptz not null default now(),
  primary key (chain, from_block)
);
`;

export interface SwapSweepResult {
  requests: number; logs: number; stored: number; ranges: number; cuSpent: number;
}

/**
 * Sweep `Swap`, committing per range. The span only ever narrows (step 5's ratchet);
 * a rate limit is handled inside `RpcClient`, which backs off in time and HOLDS the
 * span, because narrowing on a 429 produces more requests.
 */
export async function sweepV4Swaps(
  client: PoolClient, rpc: RpcClient, chain: string, poolManager: string,
  from: number, to: number, startSpan: number, minSpan: number,
  onRange?: (r: { to: number; logs: number; span: number }) => void,
): Promise<SwapSweepResult> {
  const before = rpc.cuSpent;
  let requests = 0; let logs = 0; let stored = 0; let ranges = 0;
  let span = Math.max(1, Math.min(startSpan, to - from + 1));
  let cursor = from;

  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to);
    let batch: LogEntry[];
    try {
      requests += 1;
      batch = (await rpc.raw('eth_getLogs', [{
        address: poolManager, topics: [TOPICS.swapV4],
        fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as LogEntry[];
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes('compute-unit ceiling')) throw err;
      if (!/exceeds limit|response size exceeded|too many results|query returned more/i.test(m)) {
        throw err;
      }
      if (span <= minSpan) {
        throw new Error(`eth_getLogs refused ${cursor}..${end} at the minimum span: ${m}`);
      }
      span = Math.max(minSpan, Math.floor(span / 2));
      continue;
    }
    if (!Array.isArray(batch)) throw new Error('eth_getLogs did not return a list');
    logs += batch.length;

    /*
     * `decodeSwap` owns the amount decoding -- int128 sign-extended into a 32-byte
     * word. Reading those unsigned would turn every negative amount into a number
     * near 2^256, which is plausible-looking and therefore worse than a crash.
     * `sender` is topics[2] and is taken here because decodeSwap does not return it.
     */
    const rows = batch.map((l) => {
      const s = decodeSwap(l, 'v4');
      const sender = l.topics[2];
      if (!sender) throw new Error(`a v4 Swap log at ${s.block} has no topics[2] sender`);
      return { ...s, sender: `0x${sender.slice(26)}`.toLowerCase() };
    });

    /* De-duplicate within the batch: two rows with one key in a VALUES statement
     * RAISE, and `on conflict` does not save you (section 7). */
    const seen = new Set<string>();
    const uniq = rows.filter((r) => {
      const k = `${r.block}:${r.logIndex}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    for (let i = 0; i < uniq.length; i += 500) {
      const chunk = uniq.slice(i, i + 500);
      const vals: unknown[] = [];
      const tuples = chunk.map((r, j) => {
        const b = j * 8;
        vals.push(chain, r.block, r.logIndex, r.pool, r.txHash, r.sender,
          r.amount0.toString(), r.amount1.toString());
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},`
          + `$${b + 7},$${b + 8})`;
      }).join(',');
      const res = await client.query(
        `insert into v4_swaps_all
           (chain, block_number, log_index, pool_id, tx_hash, sender, amount0, amount1)
         values ${tuples} on conflict (chain, block_number, log_index) do nothing`, vals,
      );
      stored += res.rowCount ?? 0;
    }
    await client.query(
      `insert into v4_recent_sweep_progress (chain, from_block, to_block, logs)
       values ($1,$2,$3,$4)
       on conflict (chain, from_block) do update
         set to_block=excluded.to_block, logs=excluded.logs, swept_at=now()`,
      [chain, cursor, end, batch.length],
    );
    ranges += 1;
    onRange?.({ to: end, logs: batch.length, span });
    cursor = end + 1;
  }
  return { requests, logs, stored, ranges, cuSpent: rpc.cuSpent - before };
}
