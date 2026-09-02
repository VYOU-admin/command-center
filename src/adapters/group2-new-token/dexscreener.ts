/**
 * Which candidate tokens actually have a DexScreener pair, and their symbols.
 *
 * A POOL ID IS NOT A GUARANTEE OF A PAIR. Measured on 20 recently cached pools,
 * 14 of 20 resolved and 6 did not -- and the same 6 also returned nothing when
 * looked up by token address, so they are tokens DexScreener has not indexed at
 * all rather than a wrong-pool problem. Roughly 30% of freshly launched tokens
 * have no page at alert time, so "has a pool_id" would emit dead links for
 * about a third of every message.
 *
 * The batch endpoint takes comma-separated pair addresses and returns only the
 * ones it knows, which is exactly the resolvability test: absence from the
 * response IS the negative. It also returns baseToken.symbol, so this replaces
 * the per-token eth_call symbol lookup the old monitor paid for.
 *
 * A FAILED REQUEST IS NOT AN EMPTY ANSWER. If the call throws, the whole batch
 * is reported unresolved rather than silently dropped, and the caller counts it
 * -- an outage must not look like "no token had a pair".
 */
export interface PairInfo { poolId: string; symbol: string | null; url: string }

/** DexScreener's documented cap for the batch pairs endpoint. */
export const BATCH_SIZE = 30;

export async function resolvePairs(
  chainSlug: string, poolIds: string[], signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ found: Map<string, PairInfo>; failedBatches: number }> {
  const found = new Map<string, PairInfo>();
  let failedBatches = 0;
  for (let i = 0; i < poolIds.length; i += BATCH_SIZE) {
    const batch = poolIds.slice(i, i + BATCH_SIZE);
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chainSlug}/${batch.join(',')}`;
    try {
      const res = await fetchImpl(url, { signal });
      if (!res.ok) { failedBatches++; continue; }
      const body = (await res.json()) as { pairs?: unknown };
      const pairs = Array.isArray(body.pairs) ? body.pairs : [];
      for (const p of pairs as Record<string, unknown>[]) {
        const addr = String(p.pairAddress ?? '').toLowerCase();
        if (!addr) continue;
        const base = p.baseToken as { symbol?: string } | undefined;
        found.set(addr, {
          poolId: addr,
          symbol: base?.symbol ? String(base.symbol) : null,
          url: String(p.url ?? ''),
        });
      }
    } catch {
      failedBatches++;
    }
  }
  return { found, failedBatches };
}
