/**
 * Which pool the watchlist wallets actually swapped in.
 *
 * WHY THIS EXISTS. The Initialize sweep picks the EARLIEST pool created for a
 * token, which is not the pool anyone trades. Measured: 6 of 15 links pointed at
 * pools holding $0-$27 while the real market held $4,215-$40,003.
 *
 * THIS PHASE IS THE CYCLE'S COST. Measured over ten cycles, wall-clock tracks
 * (requests - 1) x min_interval_ms to within a second, so the cycle is PACING-
 * BOUND, not latency-bound: every request sits behind a deliberate sleep. In the
 * most recent completed cycle receipts were 12 of 20 requests -- 60% of the
 * clock. Concurrency alone cannot fix that, because a single global spacing
 * makes throughput 1/interval whatever the concurrency is. So this module owns
 * BOTH knobs: how many batches may be in flight, and how far apart their starts
 * are, and they are separate config values.
 *
 * ITS OWN LIMITER AND ITS OWN FETCH, not PublicRpc. PublicRpc.pace() keeps one
 * shared clock and is not safe to drive from several workers at once -- two
 * callers can read the same `last`, both wait, and both fire together. It is
 * also shared with new-token-watch, and this needed different retry rules.
 *
 * ATTRIBUTION IS DELIBERATELY CONSERVATIVE. A Swap log names its pool by id and
 * says nothing about which token moved, so a receipt carrying several swaps
 * cannot be attributed to this token from the log alone. Those are counted as
 * ambiguous and skipped rather than guessed at.
 *
 * A TRUNCATED TOKEN IS VISIBLY TRUNCATED. Past the per-token cap this stops
 * fetching for that token and records what it saw against what it fetched. The
 * pool choice for a truncated token is then a SAMPLE, not a census, and the
 * record says so rather than presenting it as complete.
 */
export interface PoolChoice {
  poolId: string;
  transfers: number;
  distinctPools: number;
  /** True when the cap stopped this token short of its full transfer set. */
  truncated: boolean;
}
export interface Truncation { token: string; transfersSeen: number; receiptsFetched: number }

export interface SwapPoolResult {
  chosen: Map<string, PoolChoice>;
  ambiguousReceipts: number;
  missingReceipts: number;
  truncations: Truncation[];
  requests: number;
  rateLimited: number;
}

export interface SwapPoolOpts {
  url: string;
  poolManager: string;
  swapTopic: string;
  batchSize: number;
  /** Receipt batches allowed in flight at once. */
  concurrency: number;
  /** Minimum gap between the START of one batch and the next, across all workers. */
  intervalMs: number;
  /** Most transfers to fetch receipts for, per token. */
  capPerToken: number;
  signal: AbortSignal;
}

export async function resolveSwapPools(
  work: Map<string, string[]>, o: SwapPoolOpts,
): Promise<SwapPoolResult> {
  const PM = o.poolManager.toLowerCase();
  const SWAP = o.swapTopic.toLowerCase();

  // ---- apply the per-token cap BEFORE any request is issued ---------------
  const truncations: Truncation[] = [];
  const capped = new Map<string, string[]>();
  for (const [token, hashes] of work) {
    const uniq = [...new Set(hashes.map((h) => h.toLowerCase()))];
    if (uniq.length > o.capPerToken) {
      const keep = uniq.slice(0, o.capPerToken);
      capped.set(token, keep);
      truncations.push({ token, transfersSeen: uniq.length, receiptsFetched: keep.length });
    } else {
      capped.set(token, uniq);
    }
  }

  const all = [...new Set([...capped.values()].flat())];
  const chunks: string[][] = [];
  for (let i = 0; i < all.length; i += o.batchSize) chunks.push(all.slice(i, i + o.batchSize));

  const poolOfTx = new Map<string, string | null>();
  let missingReceipts = 0, requests = 0, rateLimited = 0;

  // A single shared "next allowed start" stamp, advanced atomically before any
  // await, so N workers cannot collapse onto the same instant.
  let nextStart = 0;
  const slot = async (): Promise<void> => {
    const now = Date.now();
    const start = Math.max(now, nextStart);
    nextStart = start + o.intervalMs;
    if (start > now) await new Promise((r) => setTimeout(r, start - now));
  };

  const runChunk = async (chunk: string[]): Promise<void> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (o.signal.aborted) throw new Error('run aborted');
      await slot();
      requests++;
      try {
        const res = await fetch(o.url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(chunk.map((h, j) => ({
            jsonrpc: '2.0', id: j, method: 'eth_getTransactionReceipt', params: [h] }))),
          signal: o.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          rateLimited++;
          await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * (attempt + 1) ** 2)));
          continue;
        }
        const body = await res.json();
        const arr = (Array.isArray(body) ? body : [body]) as Record<string, unknown>[];
        const seen = new Set<number>();
        for (const entry of arr) {
          const id = Number(entry.id);
          if (!Number.isFinite(id) || chunk[id] === undefined) continue;
          seen.add(id);
          const receipt = entry.result as { logs?: Record<string, unknown>[] } | null;
          if (!receipt?.logs) { missingReceipts++; continue; }
          const pools = receipt.logs
            .filter((g) => String(g.address ?? '').toLowerCase() === PM
              && String((g.topics as string[] | undefined)?.[0] ?? '').toLowerCase() === SWAP)
            .map((g) => String((g.topics as string[])[1] ?? '').toLowerCase())
            .filter(Boolean);
          const unique = [...new Set(pools)];
          poolOfTx.set(chunk[id]!, unique.length === 1 ? unique[0]! : null);
        }
        for (let j = 0; j < chunk.length; j++) if (!seen.has(j)) missingReceipts++;
        return;
      } catch (e) {
        if (o.signal.aborted) throw e;
        await new Promise((r) => setTimeout(r, Math.min(45_000, 3000 * (attempt + 1) ** 2)));
      }
    }
    // EXHAUSTED, NOT EMPTY. These transactions are unresolved, never "no pool".
    missingReceipts += chunk.length;
  };

  // Bounded pool: `concurrency` workers pulling from one queue.
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= chunks.length) return;
      await runChunk(chunks[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, worker));

  const truncSet = new Set(truncations.map((t) => t.token));
  const chosen = new Map<string, PoolChoice>();
  let ambiguousReceipts = 0;
  for (const [token, hashes] of capped) {
    const tally = new Map<string, number>();
    for (const h of hashes) {
      const p = poolOfTx.get(h);
      if (p === undefined) continue;
      if (p === null) { ambiguousReceipts++; continue; }
      tally.set(p, (tally.get(p) ?? 0) + 1);
    }
    if (!tally.size) continue;
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    chosen.set(token, { poolId: ranked[0]![0], transfers: ranked[0]![1],
      distinctPools: tally.size, truncated: truncSet.has(token) });
  }
  return { chosen, ambiguousReceipts, missingReceipts, truncations, requests, rateLimited };
}
