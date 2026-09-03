/**
 * Symbol and canonical URL for a Solana mint.
 *
 * BY MINT, NOT BY PAIR. group2 batches pair addresses because it starts from a
 * pool it watched being created; here the only identifier is the mint, and the
 * tokens endpoint takes exactly that. It has no batch form, so this costs one
 * request per mint -- which is why the caller only ever resolves mints that
 * actually cleared the alert gate, never the ~5,900 the cohort holds.
 *
 * NO addr.toLowerCase() ANYWHERE. Solana addresses are base58 and
 * case-sensitive; group2's helper lowercases pairAddress, which is right for
 * EVM and would corrupt every address here.
 *
 * A FAILED REQUEST IS NOT AN ABSENT PAIR. The three outcomes are kept apart so
 * a DexScreener outage cannot be recorded as "these mints have no page", and so
 * the failure count appears in the cycle stats rather than vanishing.
 */
export type Resolution =
  | { state: 'ok'; symbol: string | null; url: string }
  | { state: 'none' }
  | { state: 'failed'; reason: string };

/** DexScreener's published limit for the tokens endpoint is 300 req/min. */
export const DEFAULT_INTERVAL_MS = 250;

export async function resolveMint(
  mint: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch,
): Promise<Resolution> {
  try {
    const res = await fetchImpl(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`, { signal });
    if (!res.ok) return { state: 'failed', reason: `HTTP ${res.status}` };
    const body = (await res.json()) as { pairs?: unknown };
    const pairs = (Array.isArray(body.pairs) ? body.pairs : []) as Record<string, unknown>[];
    if (!pairs.length) return { state: 'none' };
    // Highest liquidity, matching the fallback rule group2 settled on after the
    // earliest-pool selection linked six tokens to dead pools.
    const best = pairs
      .map((p) => ({ p, liq: Number((p.liquidity as { usd?: number } | undefined)?.usd ?? 0) }))
      .sort((a, b) => b.liq - a.liq)[0]!.p;
    const base = best.baseToken as { symbol?: string; address?: string } | undefined;
    const url = String(best.url ?? '') || `https://dexscreener.com/solana/${mint}`;
    // The symbol is only trustworthy when the pair's base token IS this mint;
    // otherwise the mint is the quote side and base.symbol names something else.
    const symbol = base?.address === mint && base?.symbol ? String(base.symbol) : null;
    return { state: 'ok', symbol, url };
  } catch (e) {
    if (signal.aborted) throw e;
    return { state: 'failed', reason: e instanceof Error ? e.message : String(e) };
  }
}
