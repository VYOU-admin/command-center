/**
 * Block timestamps from the PUBLIC RPC, in batches, for free.
 *
 * WHY THIS EXISTS. `blockTimestamp` arrives with the logs during an Alchemy
 * sweep, so this step is usually free. Swaps COPIED from `v4_swaps_all` carry
 * no timestamp, and `loadSlice` refuses to build a row -- or derive a price --
 * for an in-scope swap whose block has none. On the PONS rebuild that left
 * 717,340 blocks to fill. One `eth_getBlockByNumber` per block on Alchemy is
 * 20 CU, so the metered answer is 14,346,800 CU = $6.46 for a single token.
 *
 * docs/ROBINHOOD.md: "Test the free alternatives before committing to a metered
 * one, and report what each can and cannot do." That rule was recorded after a
 * ~13,000-call block-timestamp fetch was queued without trying either
 * alternative. It was still not implemented, so the rebuild queued 717,340.
 *
 * WHAT THE PUBLIC RPC CAN AND CANNOT DO, MEASURED 2026-09-11:
 *
 *   eth_getBlockByNumber timestamps are EXACT. 100 of 100 matched Alchemy
 *   bit-for-bit across three samples at blocks 20M/45M/55M, with 0 returned as
 *   `0x0`. This is NOT the case for `blockTimestamp` on LOGS, which the same
 *   endpoint returns as `0x0` every time -- that is why the document says to
 *   sweep logs on Alchemy, and why this file is narrowly about blocks.
 *
 *   The batch cap is exactly 100. A 200-item batch is refused with HTTP 429
 *   even after 15 seconds of idling, so the refusal is about size, not rate.
 *
 *   The refill is about one batch per 6 seconds. Measured over six requests
 *   per setting: 15,000 ms 6/6, 10,000 ms 6/6, 6,000 ms 6/6, 3,000 ms 4/6.
 *   Concurrency does not help -- two lanes at once produced 24 refusals.
 *
 * That is 100 blocks / 6 s = 16.7 blocks per second: free, and about 12 hours
 * for the PONS backlog. The trade is wall-clock against $6.46.
 *
 * A 429 IS NEVER A MISSING TIMESTAMP. It is retried with backoff and then
 * raised. Mapping a refusal to a default would write a plausible, wrong time --
 * the failure mode this project has paid for more than once.
 *
 * NEITHER IS A TIMEOUT, AND THAT DISTINCTION COST SEVEN HOURS. The first run
 * died after 430,000 of 717,340 blocks on a single per-item error:
 *
 *   block 51230150: Post "http://10.31.73.205:8547/rpc": context deadline exceeded
 *
 * That is the public RPC's own upstream timing out on one item in a batch of
 * 100. The code raised, because it treated every per-item error that was not
 * rate-limiting as permanent. Refusing to substitute a default was right; the
 * category was wrong. There are three kinds of answer and they need three
 * different responses:
 *
 *   THROTTLED or TRANSIENT -- 429, 502/503/504, a timeout, a reset connection,
 *     an upstream deadline. Wait and try the batch again. These say nothing
 *     about the data.
 *   A LIE -- a `0x0` timestamp, a block number that is not the one asked for,
 *     a short batch. Raise immediately and never retry: waiting does not make
 *     a wrong answer right, and this is exactly what the endpoint does to log
 *     timestamps.
 *   AN ANSWER -- store it.
 *
 * A job that dies at 60% and is not watched is indistinguishable from one still
 * running, so this one also re-execs from the database on a non-zero exit: the
 * work set is recomputed from what is missing, so a restart resumes.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import { log } from '../logger.js';

/** Measured cap. A 200-item batch is refused outright. */
export const PUBLIC_BATCH = 100;
/** Measured clean interval. 3,000 ms produced refusals; 6,000 ms did not. */
export const PUBLIC_PACE_MS = 6000;

export interface BlockTime { block: number; timestamp: number }

/**
 * Is this the endpoint struggling, or the endpoint lying? Only the first is
 * worth retrying, and treating the second as retryable would hide a wrong
 * answer behind eight attempts.
 */
export function isTransient(message: string): boolean {
  return /rate|too many|limit|timeout|timed out|deadline|temporar|unavailable|try again|reset|EOF|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|502|503|504/i
    .test(message);
}

interface RpcItem {
  id: number;
  result?: { number?: string; timestamp?: string } | null;
  error?: { code?: number; message?: string };
}

/**
 * One batch, verified item by item.
 *
 * Returns null when the endpoint refused the whole batch, which the caller
 * retries. Anything that came back but is unusable -- a missing result, a
 * per-item error, a `0x0` timestamp, a block number that is not the one asked
 * for -- throws, because that is the endpoint lying rather than throttling and
 * no amount of waiting fixes it.
 */
async function fetchBatch(url: string, blocks: number[]): Promise<BlockTime[] | null> {
  const body = blocks.map((b, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber',
    params: ['0x' + b.toString(16), false],
  }));
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // A dropped socket is the transport, not the data. Retry it.
    const m = err instanceof Error ? err.message : String(err);
    if (isTransient(m) || /fetch failed|network/i.test(m)) return null;
    throw err;
  }
  if (res.status === 429 || res.status >= 500) return null;
  const text = await res.text();
  if (!res.ok) throw new Error(`public RPC HTTP ${res.status}: ${text.slice(0, 200)}`);

  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new Error(`public RPC returned non-JSON: ${text.slice(0, 200)}`);
  }
  const items = (Array.isArray(parsed) ? parsed : [parsed]) as RpcItem[];
  // A single error object in place of the array is a whole-batch refusal.
  if (!Array.isArray(parsed)) {
    const m = items[0]?.error?.message ?? '';
    if (isTransient(m)) return null;
    throw new Error(`public RPC refused the batch: ${text.slice(0, 200)}`);
  }
  if (items.length !== blocks.length) {
    throw new Error(
      `asked for ${blocks.length} blocks and got ${items.length} responses. A short `
        + 'batch would silently leave blocks unfilled.',
    );
  }

  const out: BlockTime[] = [];
  for (const item of items) {
    const want = blocks[item.id];
    if (want === undefined) throw new Error(`public RPC returned unknown id ${item.id}`);
    if (item.error) {
      const m = item.error.message ?? '';
      // Transient on ONE item retries the WHOLE batch. Partial storage would
      // leave a hole that the next run's "what is missing" query would find
      // anyway, but retrying is cheaper than another pass over 717,340 blocks.
      if (isTransient(m)) return null;
      throw new Error(`block ${want}: ${m}`);
    }
    if (!item.result || !item.result.timestamp) {
      throw new Error(`block ${want} came back with no timestamp; refusing to default it`);
    }
    if (item.result.timestamp === '0x0') {
      throw new Error(
        `block ${want} came back with timestamp 0x0. The public RPC does this for LOG `
          + 'timestamps; if it now does it for blocks this path is unusable.',
      );
    }
    const got = item.result.number ? Number(BigInt(item.result.number)) : want;
    if (got !== want) throw new Error(`asked for block ${want} and got ${got}`);
    out.push({ block: want, timestamp: Number(BigInt(item.result.timestamp)) });
  }
  return out;
}

/**
 * Fetch one batch, waiting out refusals. Raises rather than returning a short
 * answer, so a caller can never mistake throttling for an empty range.
 */
export async function fetchBatchWithRetry(
  url: string, blocks: number[], maxAttempts = 12,
  onRetry?: (attempt: number, waitMs: number) => void,
): Promise<BlockTime[]> {
  let wait = PUBLIC_PACE_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const got = await fetchBatch(url, blocks);
    if (got) return got;
    if (onRetry) onRetry(attempt, wait);
    await sleep(wait);
    wait = Math.min(wait * 2, 120_000);
  }
  throw new Error(
    `the public RPC refused ${blocks.length} blocks from ${blocks[0]} on all `
      + `${maxAttempts} attempts. Stopping rather than leaving them unfilled.`,
  );
}

export interface FillProgress {
  fetched: number; total: number; batches: number; refusals: number;
}

/**
 * Fill a list of blocks, calling `store` with each verified batch.
 *
 * `store` is given whole batches so the caller can insert them in one
 * statement; it is awaited, so a database failure stops the fetch.
 */
export async function fillFromPublicRpc(
  url: string,
  blocks: number[],
  store: (batch: BlockTime[]) => Promise<void>,
  onProgress?: (p: FillProgress) => void,
  paceMs: number = PUBLIC_PACE_MS,
): Promise<FillProgress> {
  const p: FillProgress = { fetched: 0, total: blocks.length, batches: 0, refusals: 0 };
  for (let i = 0; i < blocks.length; i += PUBLIC_BATCH) {
    const slice = blocks.slice(i, i + PUBLIC_BATCH);
    const before = Date.now();
    const got = await fetchBatchWithRetry(url, slice, 12, (attempt, waitMs) => {
      p.refusals += 1;
      if (attempt >= 3) {
        log.warn('public RPC retrying a batch', {
          from_block: slice[0], attempt, wait_ms: waitMs, refusals_total: p.refusals,
        });
      }
    });
    await store(got);
    p.fetched += got.length;
    p.batches += 1;
    if (onProgress && p.batches % 25 === 0) onProgress({ ...p });
    const elapsed = Date.now() - before;
    if (i + PUBLIC_BATCH < blocks.length && elapsed < paceMs) {
      await sleep(paceMs - elapsed);
    }
  }
  return p;
}

/**
 * Cross-check the free endpoint against the metered one before trusting it with
 * a long job. Costs `sample * 20` CU and is the whole reason this path can be
 * used at all: the same endpoint is known to return a well-formed, entirely
 * wrong `0x0` for log timestamps.
 */
export async function verifyAgainstAlchemy(
  publicUrl: string, alchemyUrl: string, blocks: number[],
): Promise<{ compared: number; mismatched: number; examples: string[] }> {
  const pub = await fetchBatchWithRetry(publicUrl, blocks);
  const body = blocks.map((b, i) => ({
    jsonrpc: '2.0', id: i, method: 'eth_getBlockByNumber',
    params: ['0x' + b.toString(16), false],
  }));
  const res = await fetch(alchemyUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`alchemy cross-check HTTP ${res.status}`);
  const items = (await res.json()) as RpcItem[];
  const truth = new Map<number, number>();
  for (const it of items) {
    if (!it.result?.timestamp || !it.result.number) continue;
    truth.set(Number(BigInt(it.result.number)), Number(BigInt(it.result.timestamp)));
  }
  let compared = 0; let mismatched = 0; const examples: string[] = [];
  for (const b of pub) {
    const t = truth.get(b.block);
    if (t === undefined) continue;
    compared += 1;
    if (t !== b.timestamp) {
      mismatched += 1;
      if (examples.length < 5) examples.push(`block ${b.block}: public ${b.timestamp} vs alchemy ${t}`);
    }
  }
  if (compared === 0) {
    throw new Error('the cross-check compared 0 blocks, which is not a pass');
  }
  log.info('public RPC cross-checked against Alchemy', { compared, mismatched });
  return { compared, mismatched, examples };
}
