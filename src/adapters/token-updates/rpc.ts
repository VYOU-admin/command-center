/**
 * JSON-RPC client with a compute-unit meter.
 *
 * THREE KINDS OF REFUSAL, THREE OPPOSITE RESPONSES. Conflating them is the
 * single most expensive mistake made during the PONS intake, twice:
 *
 *   result cap   "exceeds limit of N" / "Log response size exceeded"
 *                -> narrow the span. May have to go arbitrarily small.
 *   rate limit   HTTP 429 / "Too Many Requests"
 *                -> back off in TIME and HOLD the span. Narrowing a span on a
 *                   rate limit produces MORE requests, which is backwards.
 *   anything else
 *                -> throw. It is not a size problem and not a pacing problem.
 *
 * THE METER IS A HARD CEILING, NOT A BUDGET ALARM. An account-level cap protects
 * the wallet; only an in-job ceiling protects against a job whose scope was
 * wrong from the first request. It stops mid-run and reports where it stopped.
 *
 * NOTHING HERE RETURNS A DEFAULT ON FAILURE. A call that cannot be answered
 * raises. An empty array is only ever a real empty answer from the endpoint.
 */

/**
 * Alchemy's published per-method compute unit costs. The eth_getLogs figure was
 * additionally confirmed against this account's own dashboard: 4,920 CU across
 * 82 calls is 60.0 CU per call. These are the provider's numbers, not ours.
 */
const CU: Record<string, number> = {
  eth_blockNumber: 10,
  eth_getLogs: 60,
  eth_getBlockByNumber: 20,
  eth_call: 26,
  eth_getCode: 26,
};
const DEFAULT_CU = 60;

const SIZE_REFUSAL =
  /response size exceeded|exceeds limit|query returned more than|too large|limit of \d+/i;
const RATE_REFUSAL = /too many requests|rate limit|capacity|exceeded .*compute units per/i;

export class ComputeUnitCeiling extends Error {
  constructor(spent: number, ceiling: number, method: string) {
    super(
      `compute-unit ceiling reached: ${spent} of ${ceiling} CU spent, refusing to call ` +
        `${method}. The run stops here rather than continuing past its budget.`,
    );
    this.name = 'ComputeUnitCeiling';
  }
}

export interface LogEntry {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockTimestamp?: string;
  transactionHash: string;
  logIndex: string;
}

interface RpcResponse {
  result?: unknown;
  error?: { message?: string };
}

export interface LogFilter {
  address?: string | string[];
  topics?: (string | string[] | null)[];
}

export const hexBlock = (n: number): string => '0x' + n.toString(16);

export class RpcClient {
  private spent = 0;
  private readonly counts = new Map<string, number>();
  /** Rate refusals seen since the last call that succeeded. */
  private rateRefusals = 0;

  constructor(
    private readonly url: string,
    private readonly timeoutMs: number,
    private readonly ceiling: number,
  ) {}

  get cuSpent(): number {
    return this.spent;
  }

  /** Calls made, by method. Reported at the end of every run, including zeros. */
  callCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const m of Object.keys(CU)) out[m] = this.counts.get(m) ?? 0;
    return out;
  }

  private async call(method: string, params: unknown[]): Promise<unknown> {
    const cost = CU[method] ?? DEFAULT_CU;
    if (this.spent + cost > this.ceiling) {
      throw new ComputeUnitCeiling(this.spent, this.ceiling, method);
    }

    // Rate limits are a pacing problem, so they are retried in time with the
    // request unchanged. Everything else is returned to the caller to classify.
    let lastRate = '';
    for (let attempt = 1; attempt <= 5; attempt++) {
      this.spent += cost;
      this.counts.set(method, (this.counts.get(method) ?? 0) + 1);

      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      let body: RpcResponse | null = null;
      try {
        body = (await res.json()) as RpcResponse;
      } catch {
        body = null;
      }

      if (res.status === 429 || (body?.error && RATE_REFUSAL.test(body.error.message ?? ''))) {
        lastRate = body?.error?.message ?? `HTTP ${res.status}`;
        this.rateRefusals += 1;
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
        continue;
      }
      this.rateRefusals = 0;
      if (!body) throw new Error(`${method}: HTTP ${res.status} with a non-JSON body`);
      if (body.error) throw new RpcError(body.error.message ?? 'unknown JSON-RPC error');
      /*
       * `result: null` is a real answer for some methods but never for the ones
       * used here, and `undefined` means the response had no result at all.
       * Either one becoming an empty list is how 490 rate-limited reads once
       * turned into 490 plausible zero balances.
       */
      if (body.result === undefined || body.result === null) {
        throw new Error(`${method}: response carried no result`);
      }
      return body.result;
    }
    throw new Error(`${method}: still rate limited after 5 attempts (${lastRate})`);
  }

  /**
   * Distinguish a spend cap from a throughput throttle. BOTH return 429, and
   * they need opposite responses: a throttle wants slower pacing and the job
   * continues, a cap means the account is cut off and every further call is
   * wasted. The probe is the cheapest call the endpoint offers -- if it is
   * answered the refusals were throughput, if it is refused too the account
   * itself is refusing.
   *
   * Returns 'throttle' or 'cap'. It never guesses: an error other than a rate
   * refusal propagates, because that is a third thing again.
   */
  async diagnoseRefusal(): Promise<'throttle' | 'cap'> {
    const before = this.rateRefusals;
    try {
      await this.call('eth_blockNumber', []);
      return 'throttle';
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (RATE_REFUSAL.test(message) || /still rate limited/.test(message)) return 'cap';
      throw err;
    } finally {
      this.rateRefusals = before;
    }
  }

  /** How many rate refusals have been seen since the last successful call. */
  get consecutiveRateRefusals(): number {
    return this.rateRefusals;
  }

  async blockNumber(): Promise<number> {
    const r = await this.call('eth_blockNumber', []);
    const n = Number.parseInt(String(r), 16);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`eth_blockNumber returned ${String(r)}`);
    return n;
  }

  async ethCall(to: string, data: string, block: string | number = 'latest'): Promise<string> {
    const tag = typeof block === 'number' ? hexBlock(block) : block;
    return String(await this.call('eth_call', [{ to, data }, tag]));
  }

  /**
   * Contract code at a block.
   *
   * MUST BE EVALUATED AT A SPECIFIC BLOCK for the cohort check, not at
   * `latest`. An address that was an ordinary wallet when it bought is a buyer
   * whatever it became afterwards; checking at `latest` cost 581 wallets on
   * PONS -- 4.6% of the cohort -- because they have since adopted EIP-7702
   * delegation and now return 23 bytes of code. It cut both ways: six wallets
   * held a delegation during the window and revoked it later, and `latest`
   * wrongly included those.
   *
   * A failed read THROWS. eth_getCode has no legitimate error, so anything
   * other than a result is a failed read, and recording it as "no contract
   * here" is how a pool or a router becomes a wallet. The public RPC is not
   * archival and errors "metadata is not found" on any historical block.
   */
  async getCode(address: string, block: string | number): Promise<string> {
    const tag = typeof block === 'number' ? hexBlock(block) : block;
    const result = await this.call('eth_getCode', [address, tag]);
    if (typeof result !== 'string' || !result.startsWith('0x')) {
      throw new Error(`eth_getCode(${address}, ${tag}) returned ${String(result)}`);
    }
    return result;
  }

  async getBlockTimestamp(block: number): Promise<number> {
    const r = (await this.call('eth_getBlockByNumber', [hexBlock(block), false])) as {
      timestamp?: string;
    };
    const ts = Number.parseInt(String(r.timestamp), 16);
    if (!Number.isFinite(ts) || ts <= 0) throw new Error(`block ${block} has no usable timestamp`);
    return ts;
  }

  /**
   * eth_getLogs across [from, to], splitting on the result cap.
   *
   * The span narrows on a size refusal and does NOT re-widen inside one call.
   * Re-widening after every success is what made the first PONS sweep thrash;
   * a ratchet that only ever narrows is what starved its sparse middle. Here
   * the caller supplies the starting span per run, so neither happens.
   */
  async getLogs(
    filter: LogFilter,
    from: number,
    to: number,
    startSpan: number,
    minSpan: number,
  ): Promise<LogEntry[]> {
    const out: LogEntry[] = [];
    let cursor = from;
    let span = Math.max(1, Math.min(startSpan, to - from + 1));

    while (cursor <= to) {
      const end = Math.min(cursor + span - 1, to);
      try {
        const logs = (await this.call('eth_getLogs', [
          { ...filter, fromBlock: hexBlock(cursor), toBlock: hexBlock(end) },
        ])) as LogEntry[];
        if (!Array.isArray(logs)) throw new Error('eth_getLogs did not return a list');
        out.push(...logs);
        cursor = end + 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!(err instanceof RpcError) || !SIZE_REFUSAL.test(message)) throw err;
        if (span <= minSpan) {
          /*
           * A floor that cannot satisfy the endpoint is a livelock, not a
           * retry: the PONS sweep once re-requested the same range every 30
           * seconds for five and a half minutes. Throwing surfaces it.
           */
          throw new Error(
            `eth_getLogs refused ${cursor}..${end} at the minimum span of ${minSpan} ` +
              `blocks: ${message}`,
          );
        }
        span = Math.max(minSpan, Math.floor(span / 2));
      }
    }
    return out;
  }
}

/** A JSON-RPC-level error, as opposed to a transport or parse failure. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcError';
  }
}
