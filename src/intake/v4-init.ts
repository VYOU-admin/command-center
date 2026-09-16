/**
 * Every v4 pool's `Initialize` event: its two currencies and its creation block.
 *
 * WHY THIS TABLE HAS TO EXIST. `v4_swaps_all` stores `amount0` and `amount1` and
 * NOTHING that says which of them is the token and which is the counter. Without
 * that, a launch's price cannot be computed at all: getting the sides backwards
 * inverts the return. A measurement pass on 2026-09-15 tried to infer the side from
 * the v4 sign convention -- "the predominantly positive side is the token" -- and it
 * FAILED VALIDATION against `pool_meta` at 227 agree / 264 disagree / 63 ties, which
 * is 46% on the resolved subset and worse than chance in either polarity. Decoding
 * the disagreements settled why: sign predominance measures NET TRADE DIRECTION over
 * the sampled window, not currency identity, and on a mature pool that is ~50/50.
 *
 * `Initialize` answers it directly, from the chain, with no inference:
 *
 *   topic0    0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438
 *   topics[1] pool id     topics[2] currency0     topics[3] currency1
 *   data      5 words: fee, tickSpacing, hooks, sqrtPriceX96, tick
 *
 * IT IS A SPARSE FILTER AND MUST BE SIZED AS ONE. Step 5: "Span sizing belongs to
 * the filter, not to the endpoint. A sparse filter returned 4,615 logs across
 * 40,000,000 blocks in a single call; a dense filter is refused above 100,000.
 * Carrying one constant across both cost ~1,864 calls where 8 sufficed."
 *
 * The span here is DERIVED from the density this filter will actually have rather
 * than carried in as a constant -- see `deriveSpan` -- because this document records
 * a density taken from the wrong population being wrong by 16x, 27%, 2.0x and 142x.
 *
 * IT COMMITS PER RANGE. Step 5 requires progress committed per range so a run that
 * dies leaves a truthful partial record; the runner's whole-phase transaction is the
 * open defect in section 9 that breaks that, so this CLI does not use it.
 */
import type { PoolClient } from '../store/db.js';
import type { RpcClient } from '../adapters/token-updates/rpc.js';

export const V4_INIT_SCHEMA = `
create table if not exists v4_pool_init (
  chain          text   not null,
  pool_id        text   not null,
  currency0      text   not null,
  currency1      text   not null,
  fee            bigint,
  tick_spacing   bigint,
  hooks          text,
  sqrt_price_x96 numeric,
  init_tick      bigint,
  block_number   bigint not null,
  log_index      bigint not null,
  tx_hash        text,
  primary key (chain, pool_id)
);
create index if not exists v4_pool_init_block_idx on v4_pool_init (chain, block_number);
create table if not exists v4_init_sweep_progress (
  chain      text   not null,
  from_block bigint not null,
  to_block   bigint not null,
  logs       integer not null,
  swept_at   timestamptz not null default now(),
  primary key (chain, from_block)
);
`;

export const INITIALIZE_TOPIC =
  '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438';

/** Provider's published table, confirmed against the dashboard for this method. */
export const GETLOGS_CU = 60;

export interface InitRow {
  poolId: string; currency0: string; currency1: string;
  fee: number; tickSpacing: number; hooks: string;
  sqrtPriceX96: string; initTick: number;
  blockNumber: number; logIndex: number; txHash: string;
}

/** A 32-byte TOPIC ('0x' + 64 hex) holding a left-padded address. */
const addrFromTopic = (t: string): string => `0x${t.slice(26)}`;

/**
 * A 32-byte DATA WORD (64 hex, NO '0x') holding a left-padded address.
 *
 * SEPARATE FROM `addrFromTopic` BECAUSE THE OFFSETS DIFFER BY THE '0x', and using the
 * topic helper on a data word drops the address's HIGH BYTE. That shipped: `hooks` was
 * stored 40 characters instead of 42 for all 306,560 rows, so a comparison against the
 * real zero address matched nothing and reported every pool as hooked. The currencies
 * were unaffected -- they come from topics. Correcting the stored values needs a
 * re-sweep; the extraction is fixed here so it cannot recur.
 */
const addrFromWord = (w: string): string => `0x${w.slice(24)}`;

/** Two's-complement int24 out of a 32-byte word. */
function int24(word: string): number {
  const v = Number(BigInt(`0x${word}`) & 0xffffffn);
  return v >= 0x800000 ? v - 0x1000000 : v;
}

/**
 * Decode one `Initialize` log.
 *
 * RAISES rather than returning a default on anything unexpected. A malformed log
 * that decoded to a plausible zero would put a pool in this table with the wrong
 * currencies, and every price derived from it would be silently inverted or scaled
 * -- the failure shape section 5 names as the worst on this project.
 */
export function decodeInitialize(log: {
  topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string;
}): InitRow {
  const t = log.topics;
  if (!Array.isArray(t) || t.length !== 4 || t[0]?.toLowerCase() !== INITIALIZE_TOPIC) {
    throw new Error(`not an Initialize log: ${t?.length ?? 0} topics, topic0 ${t?.[0]}`);
  }
  const d = log.data.startsWith('0x') ? log.data.slice(2) : log.data;
  if (d.length !== 5 * 64) {
    throw new Error(`Initialize data is ${d.length} hex chars, expected ${5 * 64}`);
  }
  const w = (i: number): string => d.slice(i * 64, (i + 1) * 64);
  return {
    poolId: t[1]!.toLowerCase(),
    currency0: addrFromTopic(t[2]!).toLowerCase(),
    currency1: addrFromTopic(t[3]!).toLowerCase(),
    fee: Number(BigInt(`0x${w(0)}`)),
    tickSpacing: int24(w(1)),
    hooks: addrFromWord(w(2)).toLowerCase(),
    sqrtPriceX96: BigInt(`0x${w(3)}`).toString(),
    initTick: int24(w(4)),
    blockNumber: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    txHash: log.transactionHash,
  };
}

/**
 * THE SPAN IS DERIVED FROM THE DENSITY THIS FILTER WILL HAVE, not carried in.
 *
 * `v4_swaps_all` already names a floor for the log count: every pool that swapped
 * inside the range must have been initialised, so its distinct pool count is a lower
 * bound on the Initialize logs the sweep will read. Targeting `targetLogs` per
 * request from that floor gives a starting span that is sparse-appropriate without
 * being the 40,000,000 a different filter measured.
 */
export function deriveSpan(
  blocks: number, expectedLogs: number, targetLogs: number,
): number {
  if (expectedLogs <= 0) throw new Error('expectedLogs must be positive to size a span');
  const perBlock = expectedLogs / blocks;
  return Math.max(1, Math.floor(targetLogs / perBlock));
}

export interface SweepResult {
  requests: number; logs: number; stored: number; ranges: number;
  spanFinal: number; cuSpent: number;
}

/**
 * Sweep `Initialize` across [from, to], committing each range as it completes.
 *
 * The span narrows on a SIZE refusal and never re-widens inside a run -- step 5's
 * ratchet. A rate limit is a different refusal and is handled inside `RpcClient`,
 * which backs off in time and holds the span; narrowing on a 429 produces MORE
 * requests, which is backwards.
 */
export async function sweepInitialize(
  client: PoolClient, rpc: RpcClient, chain: string, poolManager: string,
  from: number, to: number, startSpan: number, minSpan: number,
  onRange?: (r: { from: number; to: number; logs: number; span: number }) => void,
): Promise<SweepResult> {
  const before = rpc.cuSpent;
  let requests = 0; let logs = 0; let stored = 0; let ranges = 0;
  let span = Math.max(1, Math.min(startSpan, to - from + 1));
  let cursor = from;

  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to);
    let batch;
    try {
      requests += 1;
      batch = (await rpc.raw('eth_getLogs', [{
        address: poolManager, topics: [INITIALIZE_TOPIC],
        fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Array<Parameters<typeof decodeInitialize>[0]>;
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (m.includes('compute-unit ceiling')) throw err;
      if (!/exceeds limit|response size exceeded|too many results|query returned more/i.test(m)) {
        throw err;
      }
      if (span <= minSpan) {
        throw new Error(
          `eth_getLogs refused ${cursor}..${end} at the minimum span of ${minSpan}: ${m}`,
        );
      }
      span = Math.max(minSpan, Math.floor(span / 2));
      continue;
    }
    if (!Array.isArray(batch)) throw new Error('eth_getLogs did not return a list');
    logs += batch.length;

    const rows = batch.map(decodeInitialize);
    /*
     * BATCHED INSERT, and DE-DUPLICATED WITHIN THE BATCH. Two rows with the same key
     * in one VALUES statement RAISE -- `on conflict do nothing` does not save you,
     * because the conflict is inside the statement rather than against the table.
     * Section 7 records this trap on `block_times`.
     */
    const seen = new Set<string>();
    const uniq = rows.filter((r) => (seen.has(r.poolId) ? false : (seen.add(r.poolId), true)));
    for (let i = 0; i < uniq.length; i += 500) {
      const chunk = uniq.slice(i, i + 500);
      const vals: unknown[] = [];
      const tuples = chunk.map((r, j) => {
        const b = j * 11;
        vals.push(chain, r.poolId, r.currency0, r.currency1, r.fee, r.tickSpacing,
          r.hooks, r.sqrtPriceX96, r.initTick, r.blockNumber, r.logIndex);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},`
          + `$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
      }).join(',');
      const res = await client.query(
        `insert into v4_pool_init
           (chain,pool_id,currency0,currency1,fee,tick_spacing,hooks,sqrt_price_x96,
            init_tick,block_number,log_index)
         values ${tuples} on conflict (chain, pool_id) do nothing`, vals,
      );
      stored += res.rowCount ?? 0;
    }
    await client.query(
      `insert into v4_init_sweep_progress (chain,from_block,to_block,logs)
       values ($1,$2,$3,$4)
       on conflict (chain, from_block) do update
         set to_block = excluded.to_block, logs = excluded.logs, swept_at = now()`,
      [chain, cursor, end, batch.length],
    );
    ranges += 1;
    onRange?.({ from: cursor, to: end, logs: batch.length, span });
    cursor = end + 1;
  }
  return { requests, logs, stored, ranges, spanFinal: span, cuSpent: rpc.cuSpent - before };
}
