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

/**
 * The highest-liquidity pair for a token, used ONLY when no swap poolId was
 * obtained. One request per token -- there is no batch form of the tokens
 * endpoint -- so this is called for the fallback set alone, never for every
 * candidate.
 *
 * A request that throws yields null, and the caller counts it as unresolved
 * rather than as "no pair": an outage must not be recorded as an absence.
 */
export async function topPairByToken(
  chainSlug: string, token: string, signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<PairInfo | null> {
  try {
    const res = await fetchImpl(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { pairs?: unknown };
    const pairs = (Array.isArray(body.pairs) ? body.pairs : []) as Record<string, unknown>[];
    if (!pairs.length) return null;
    const best = pairs
      .map((p) => ({ p, liq: Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0) }))
      .sort((a, b) => b.liq - a.liq)[0]!.p;
    const addr = String(best.pairAddress ?? '').toLowerCase();
    if (!addr) return null;
    const base = best.baseToken as { symbol?: string } | undefined;
    return { poolId: addr, symbol: base?.symbol ? String(base.symbol) : null,
             url: String(best.url ?? '') };
  } catch {
    return null;
  }
}
