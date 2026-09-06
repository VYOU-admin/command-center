/**
 * Phase 5: the adaptive full-life sweeper, and phase 6: sign-convention
 * verification.
 *
 * THREE REFUSAL TYPES, THREE OPPOSITE RESPONSES. Conflating them was the most
 * expensive mistake of the PONS intake, made twice:
 *
 *   result cap   "exceeds limit of N" / "Log response size exceeded"
 *                -> NARROW the span, possibly a long way. A floor that cannot
 *                   satisfy the endpoint is a livelock: one sweep re-requested
 *                   the same range every 30 seconds for five and a half minutes.
 *   rate limit   HTTP 429
 *                -> back off in TIME and HOLD the span. Narrowing on a rate
 *                   limit produces MORE requests, which is backwards.
 *   cap vs throttle
 *                -> both return 429 and need opposite responses. A probe call
 *                   settles it: if the endpoint answers, it was throughput and
 *                   the sweep continues; if it refuses too, the account is cut
 *                   off and every further call is wasted.
 *
 * SPAN SIZING IS DENSITY-TARGETED WITH A RECOVERING CAP. Re-widening to the
 * maximum after every success made the first PONS sweep thrash; a ratchet that
 * only ever narrowed starved its sparse middle at 47,000 blocks per minute.
 * The span aims at a target number of logs per request, and a cap that drops on
 * a size refusal and recovers gradually keeps both failures away.
 */

import type { IntakeConfig } from './plan.js';
import { TOPICS, decodeSwap, decodeTransfer, normalizeAddress } from '../adapters/token-updates/decode.js';
import type { LogEntry, LogFilter } from '../adapters/token-updates/rpc.js';
import { RpcError, hexBlock, type RpcClient } from '../adapters/token-updates/rpc.js';
import type { PoolRow } from '../adapters/token-updates/pools.js';
import { abs } from '../adapters/token-updates/units.js';
import type { PoolClient } from '../store/db.js';

const SIZE_REFUSAL =
  /response size exceeded|exceeds limit|query returned more than|too large|limit of \d+/i;

export interface SweepStats {
  requests: number;
  logs: number;
  sizeRefusals: number;
  rateRefusals: number;
  smallestSpan: number;
  largestSpan: number;
  blocksCovered: number;
}

export class CapReached extends Error {
  constructor(spent: number) {
    super(
      `the endpoint refused a probe call as well as the sweep, after ${spent} CU. ` +
        'That is an account-level cap, not a throughput throttle: every further ' +
        'call would be wasted, so the sweep stops here.',
    );
    this.name = 'CapReached';
  }
}

/**
 * Sweep [from, to] for one filter, handing each batch to `onBatch` as it
 * arrives so progress is committed rather than accumulated in memory. A
 * full-life sweep of a busy token is millions of logs.
 */
export async function adaptiveSweep(
  rpc: RpcClient,
  cfg: IntakeConfig,
  filter: LogFilter,
  from: number,
  to: number,
  onBatch: (logs: LogEntry[], rangeFrom: number, rangeTo: number) => Promise<void>,
  /*
   * The STARTING span, chosen by the caller from the filter's density. A sparse
   * filter takes 40,000,000 blocks and a dense one does not; one constant for
   * both is how pool enumeration ended up making 230x the calls it needed.
   */
  startSpan: number = cfg.maxLogSpanBlocks,
): Promise<SweepStats> {
  const stats: SweepStats = {
    requests: 0,
    logs: 0,
    sizeRefusals: 0,
    rateRefusals: 0,
    smallestSpan: Number.MAX_SAFE_INTEGER,
    largestSpan: 0,
    blocksCovered: 0,
  };

  let cursor = from;
  const ceiling = Math.max(startSpan, cfg.maxLogSpanBlocks);
  let span = Math.min(startSpan, to - from + 1);
  let cap = startSpan;

  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to);
    let logs: LogEntry[];
    try {
      logs = await rpc.getLogs(filter, cursor, end, end - cursor + 1, cfg.minLogSpanBlocks);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);

      if (SIZE_REFUSAL.test(message)) {
        stats.sizeRefusals += 1;
        if (span <= cfg.minLogSpanBlocks) {
          throw new Error(
            `the endpoint refused ${cursor}..${end} at the minimum span of ` +
              `${cfg.minLogSpanBlocks} blocks: ${message}. Retrying the same range ` +
              'would be a livelock, so the sweep stops.',
          );
        }
        span = Math.max(cfg.minLogSpanBlocks, Math.floor(span / 2));
        cap = span; // the cap drops with the span, then recovers on success
        continue;
      }

      if (/still rate limited/.test(message) || err instanceof RpcError) {
        stats.rateRefusals += 1;
        /*
         * A rate refusal does NOT narrow the span. Before waiting, find out
         * whether this is throughput or the account being cut off -- the two
         * look identical and need opposite responses.
         */
        const kind = await rpc.diagnoseRefusal();
        if (kind === 'cap') throw new CapReached(rpc.cuSpent);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      throw err;
    }

    stats.requests += 1;
    stats.logs += logs.length;
    stats.smallestSpan = Math.min(stats.smallestSpan, end - cursor + 1);
    stats.largestSpan = Math.max(stats.largestSpan, end - cursor + 1);
    stats.blocksCovered += end - cursor + 1;

    await onBatch(logs, cursor, end);
    cursor = end + 1;

    /*
     * Aim the next span at the target log count, then let the cap recover a
     * little. Recovery is what lets the sweep re-widen through a sparse region
     * after a dense one forced it small.
     */
    const density = logs.length / (end - cursor + 2);
    const wanted =
      density > 0 ? Math.floor(cfg.targetLogsPerRequest / density) : ceiling;
    cap = Math.min(ceiling, Math.max(cap, Math.floor(cap * 1.25) + 1));
    span = Math.max(cfg.minLogSpanBlocks, Math.min(wanted, cap));
  }

  if (stats.smallestSpan === Number.MAX_SAFE_INTEGER) stats.smallestSpan = 0;
  return stats;
}

/* -------------------------------------------------------------- persistence */

export async function recordSweepRange(
  client: PoolClient,
  cfg: IntakeConfig,
  kind: string,
  from: number,
  to: number,
  logs: number,
): Promise<void> {
  await client.query(
    `insert into token_sweep_progress (chain, token, kind, from_block, to_block, logs, swept_at)
     values ($1, $2, $3, $4, $5, $6, now())`,
    [cfg.chain, cfg.token, kind, from, to, logs],
  );
}

export interface CoverageCheck {
  expectedBlocks: number;
  coveredBlocks: number;
  gaps: { after: number; before: number }[];
  overlaps: number;
}

/**
 * Gap-check a completed sweep on a fresh read of the progress table.
 *
 * `sum(to - from + 1)` must equal the span exactly, AND a window function over
 * the ranges must find no gaps. The sum alone is not enough: an overlap and a
 * gap of the same size cancel out in a total.
 */
export async function checkCoverage(
  client: PoolClient,
  cfg: IntakeConfig,
  kind: string,
  from: number,
  to: number,
): Promise<CoverageCheck> {
  const covered = await client.query<{ n: string }>(
    `select coalesce(sum(to_block - from_block + 1), 0)::text n
       from token_sweep_progress
      where chain = $1 and token = $2 and kind = $3
        and from_block >= $4 and to_block <= $5`,
    [cfg.chain, cfg.token, kind, from, to],
  );
  const gaps = await client.query<{ after: number; before: number }>(
    `select prev_end as after, from_block as before from (
       select from_block,
              lag(to_block) over (order by from_block) as prev_end
         from token_sweep_progress
        where chain = $1 and token = $2 and kind = $3
          and from_block >= $4 and to_block <= $5
     ) s
     where prev_end is not null and from_block > prev_end + 1`,
    [cfg.chain, cfg.token, kind, from, to],
  );
  const overlaps = await client.query<{ n: number }>(
    `select count(*)::int n from (
       select from_block, lag(to_block) over (order by from_block) as prev_end
         from token_sweep_progress
        where chain = $1 and token = $2 and kind = $3
          and from_block >= $4 and to_block <= $5
     ) s
     where prev_end is not null and from_block <= prev_end`,
    [cfg.chain, cfg.token, kind, from, to],
  );
  return {
    expectedBlocks: to - from + 1,
    coveredBlocks: Number(covered.rows[0]?.n ?? 0),
    gaps: gaps.rows,
    overlaps: overlaps.rows[0]?.n ?? 0,
  };
}

/* ------------------------------------------------- sign-convention checking */

export interface ConventionResult {
  venue: 'v3' | 'v4';
  region: string;
  agreeing: number;
  tested: number;
  convention: 'pool' | 'swapper' | 'undetermined';
}

/**
 * Measure each venue's sign convention against the actual token transfers in
 * the same transaction.
 *
 * THE TWO VENUES USE OPPOSITE CONVENTIONS ON THIS CHAIN. Measured unanimously
 * on PONS across three separate regions: v3 reports from the POOL's
 * perspective (the pool sent the token => the amount is negative) and v4 from
 * the SWAPPER's (the swapper received => positive). Assuming one convention for
 * both would have inverted every v4 buy into a sell across 480,924 rows, with
 * plausible totals throughout and nothing to indicate a problem.
 *
 * This is a CHECK, not a source of direction. Direction is taken from the
 * transfer. The check exists so that a chain or a venue behaving differently
 * from PONS is caught before anything is written, rather than inferred later
 * from figures that look reasonable.
 */
export function verifyConventions(
  swaps: { log: LogEntry; pool: PoolRow; venue: 'v3' | 'v4' }[],
  transfers: LogEntry[],
  cfg: IntakeConfig,
  region: string,
): ConventionResult[] {
  const token = normalizeAddress(cfg.token);
  const poolManager = cfg.v4PoolManager.toLowerCase();

  const byTx = new Map<string, ReturnType<typeof decodeTransfer>[]>();
  for (const log of transfers) {
    const t = decodeTransfer(log);
    const list = byTx.get(t.txHash);
    if (list) list.push(t);
    else byTx.set(t.txHash, [t]);
  }

  const tally: Record<'v3' | 'v4', { pool: number; swapper: number; tested: number }> = {
    v3: { pool: 0, swapper: 0, tested: 0 },
    v4: { pool: 0, swapper: 0, tested: 0 },
  };

  for (const { log, pool, venue } of swaps) {
    const swap = decodeSwap(log, venue);
    const counterparty = venue === 'v3' ? pool.pool : poolManager;
    const moves = byTx.get(swap.txHash) ?? [];

    let outOfPool = 0n;
    let intoPool = 0n;
    for (const t of moves) {
      if (t.from === counterparty && t.to !== counterparty) outOfPool += t.amount;
      else if (t.to === counterparty && t.from !== counterparty) intoPool += t.amount;
    }
    // Only unambiguous transactions are evidence: one direction, one pool.
    if ((outOfPool > 0n) === (intoPool > 0n)) continue;
    if (moves.length === 0) continue;

    const raw = pool.tokenSide === 0 ? swap.amount0 : swap.amount1;
    if (raw === 0n) continue;
    const poolSentToken = outOfPool > 0n;

    tally[venue].tested += 1;
    // POOL perspective: pool sent => negative. SWAPPER: swapper received => positive.
    if (poolSentToken === raw < 0n) tally[venue].pool += 1;
    if (poolSentToken === raw > 0n) tally[venue].swapper += 1;
    void abs;
  }

  return (['v3', 'v4'] as const).map((venue) => {
    const t = tally[venue];
    let convention: ConventionResult['convention'] = 'undetermined';
    let agreeing = 0;
    if (t.tested > 0 && t.pool === t.tested) {
      convention = 'pool';
      agreeing = t.pool;
    } else if (t.tested > 0 && t.swapper === t.tested) {
      convention = 'swapper';
      agreeing = t.swapper;
    } else {
      agreeing = Math.max(t.pool, t.swapper);
    }
    return { venue, region, agreeing, tested: t.tested, convention };
  });
}

/** The swap topic for a venue, so callers do not repeat the mapping. */
export const swapTopicFor = (venue: 'v3' | 'v4'): string =>
  venue === 'v3' ? TOPICS.swapV3 : TOPICS.swapV4;

export const blockTag = hexBlock;
