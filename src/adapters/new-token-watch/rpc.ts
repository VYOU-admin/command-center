/**
 * Public-RPC log access for the new-token watch.
 *
 * The deployed service has no ALCHEMY_API_KEY, so everything here runs on the
 * free public endpoint. Measured limits on chain 4663, which the caller must
 * respect rather than discover at runtime:
 *   - a topic array is capped at 1,000 selectors; 500 addresses over 2,000
 *     blocks times out; 200 over 10,000 blocks is reliable
 *   - windows split on range/timeout errors, never on rate limiting
 */
import type { Logger } from '../../logger.js';

export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
}

export class PublicRpc {
  private last = 0;
  public requests = 0;
  /**
   * ADDITIVE COUNTERS, read-only for callers. Nothing here changes behaviour;
   * they exist because a caller could not previously tell a window that SPLIT
   * from a request that was RETRIED, and those have very different costs: a
   * split is one extra paced request, a retry is a paced request plus
   * 3000*(n+1)^2 of backoff.
   */
  public splits = 0;
  public retries = 0;

  constructor(
    private readonly url: string,
    private readonly minIntervalMs: number,
    private readonly log: Logger,
    private readonly signal: AbortSignal,
  ) {}

  private async pace(): Promise<void> {
    const wait = this.last + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
  }

  /**
   * One batched JSON-RPC request. ADDITIVE: nothing in the new-token watch calls
   * this, so its behaviour is unchanged. Shares the pacing clock and the request
   * counter with call(), because the endpoint rate-limits per request and a
   * batch is one request.
   *
   * Returns the raw array, entries keyed by the id each caller supplied. A batch
   * whose transport fails returns null rather than an empty array -- an outage
   * must not read as "no results".
   */
  async batch(bodies: unknown[]): Promise<unknown[] | null> {
    if (!bodies.length) return [];
    for (let attempt = 0; attempt < 7; attempt++) {
      if (this.signal.aborted) throw new Error('run aborted');
      await this.pace();
      this.requests++;
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bodies),
          signal: this.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * (attempt + 1) ** 2)));
          continue;
        }
        const body = await res.json();
        return Array.isArray(body) ? body : [body];
      } catch (e) {
        if (this.signal.aborted) throw e;
        await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * (attempt + 1) ** 2)));
      }
    }
    return null;
  }

  async call(method: string, params: unknown[]): Promise<unknown> {
    for (let attempt = 0; attempt < 7; attempt++) {
      if (this.signal.aborted) throw new Error('run aborted');
      await this.pace();
      this.requests++;
      try {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: this.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          this.retries++;
          await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * (attempt + 1) ** 2)));
          continue;
        }
        const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
        if (body.error) {
          const msg = String(body.error.message ?? '');
          // RATE LIMITING IS RETRYABLE; A QUERY THAT IS TOO BIG IS NOT.
          // Retrying an oversized getLogs just times out again: seven attempts
          // with backoff burns about three minutes before the caller ever gets
          // the chance to split the window, which is what aborted the first two
          // live cycles against the spine's 5-minute ceiling. Throw instead, so
          // logs() splits immediately.
          if (/Too Many/i.test(msg)) {
            this.retries++;
            await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * (attempt + 1) ** 2)));
            continue;
          }
          throw new Error(`${method}: ${msg}`);
        }
        return body.result;
      } catch (err) {
        if (this.signal.aborted) throw err;
        if (attempt === 6) throw err;
        this.retries++;
        await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * (attempt + 1) ** 2)));
      }
    }
    throw new Error(`${method}: exhausted retries`);
  }

  async blockNumber(): Promise<number> {
    return Number.parseInt(String(await this.call('eth_blockNumber', [])), 16);
  }

  async blockTimestamp(block: number): Promise<number> {
    const b = (await this.call('eth_getBlockByNumber', [
      '0x' + block.toString(16), false,
    ])) as { timestamp?: string } | null;
    // A missing timestamp is never defaulted: the caller derives block time from
    // it, and a wrong block time silently mis-ages every pool.
    if (!b?.timestamp) throw new Error(`no timestamp for block ${block}`);
    return Number.parseInt(b.timestamp, 16);
  }

  /** getLogs with window splitting on range/timeout errors only. */
  async logs(params: Record<string, unknown>, lo: number, hi: number): Promise<RpcLog[]> {
    try {
      const out = (await this.call('eth_getLogs', [
        { ...params, fromBlock: '0x' + lo.toString(16), toBlock: '0x' + hi.toString(16) },
      ])) as RpcLog[] | null;
      return out ?? [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (hi > lo && /limit|exceed|too large|timed out/i.test(msg)) {
        this.splits++;
        const mid = Math.floor((lo + hi) / 2);
        const a = await this.logs(params, lo, mid);
        const b = await this.logs(params, mid + 1, hi);
        return a.concat(b);
      }
      throw err;
    }
  }

  /** Walk a block range in fixed windows, concatenating results. */
  async logsRange(
    params: Record<string, unknown>, lo: number, hi: number, window: number,
  ): Promise<RpcLog[]> {
    const out: RpcLog[] = [];
    for (let cur = lo; cur <= hi; cur += window) {
      out.push(...(await this.logs(params, cur, Math.min(cur + window - 1, hi))));
    }
    return out;
  }
}

/**
 * Extract an address from an indexed topic.
 *
 * A missing topic throws rather than yielding a plausible-looking zero address:
 * an event with the wrong shape must stop the run, not silently attribute a
 * transfer to 0x000...0.
 */
export const topicAddress = (topic: string | undefined): string => {
  if (!topic) throw new Error('expected an indexed topic, got none');
  return '0x' + topic.slice(-40).toLowerCase();
};
export const padAddress = (addr: string): string => '0x' + '0'.repeat(24) + addr.slice(2).toLowerCase();
