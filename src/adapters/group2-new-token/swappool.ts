/**
 * Which pool the watchlist wallets actually swapped in.
 *
 * WHY THIS EXISTS. The Initialize sweep picks the EARLIEST pool created for a
 * token, which is not the pool anyone trades. Measured on the 07:42 cycle: 6 of
 * 15 links pointed at pools holding $0-$27 while the token's real market held
 * $4,215-$40,003 and up to $370K of daily volume. All 35 Barry swaps carried one
 * poolId -- the top-liquidity pair -- and the monitor had it available in the
 * receipt and never looked.
 *
 * THIS COSTS REQUESTS AND IS NOT FREE. The monitor otherwise reads no receipts
 * at all: an inbound Transfer from the PoolManager is the whole attribution.
 * Receipts are fetched ONLY for tokens that already passed the re-alert rule,
 * which is what keeps it cheap -- measured 2 candidates and 20 transactions on
 * the 08:13 cycle, so one batched request.
 *
 * ATTRIBUTION IS DELIBERATELY CONSERVATIVE. A Swap log names its pool by id and
 * says nothing about which token moved, so a receipt carrying several swaps
 * cannot be attributed to this token from the log alone. Those are counted as
 * ambiguous and skipped rather than guessed at; other transfers of the same
 * token still decide it. Measured: 65 of 65 receipts last session carried
 * exactly one PoolManager Swap, so this is the rare case.
 */
import type { PublicRpc } from '../new-token-watch/rpc.js';

export interface PoolChoice {
  poolId: string;
  transfers: number;
  distinctPools: number;
}

export interface SwapPoolResult {
  /** token -> the poolId carrying the most of that token's transfers. */
  chosen: Map<string, PoolChoice>;
  ambiguousReceipts: number;
  missingReceipts: number;
  requests: number;
}

/**
 * @param work token -> the transaction hashes of its qualifying transfers
 */
export async function resolveSwapPools(
  rpc: PublicRpc, poolManager: string, swapTopic: string,
  work: Map<string, string[]>, batchSize: number,
): Promise<SwapPoolResult> {
  const before = rpc.requests;
  const PM = poolManager.toLowerCase();
  const SWAP = swapTopic.toLowerCase();

  // One receipt serves every token that has a transfer in that transaction.
  const all = [...new Set([...work.values()].flat())];
  const poolOfTx = new Map<string, string | null>();   // null = ambiguous
  let missingReceipts = 0;

  for (let i = 0; i < all.length; i += batchSize) {
    const chunk = all.slice(i, i + batchSize);
    const res = await rpc.batch(chunk.map((h, j) => ({
      jsonrpc: '2.0', id: j, method: 'eth_getTransactionReceipt', params: [h],
    })));
    if (res === null) { missingReceipts += chunk.length; continue; }
    const seen = new Set<number>();
    for (const entry of res as Record<string, unknown>[]) {
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
      poolOfTx.set(chunk[id]!.toLowerCase(), unique.length === 1 ? unique[0]! : null);
    }
    for (let j = 0; j < chunk.length; j++) if (!seen.has(j)) missingReceipts++;
  }

  const chosen = new Map<string, PoolChoice>();
  let ambiguousReceipts = 0;
  for (const [token, hashes] of work) {
    const tally = new Map<string, number>();
    for (const h of hashes) {
      const p = poolOfTx.get(h.toLowerCase());
      if (p === undefined) continue;                 // no receipt
      if (p === null) { ambiguousReceipts++; continue; }
      tally.set(p, (tally.get(p) ?? 0) + 1);
    }
    if (!tally.size) continue;
    // MOST TRANSFERS WINS; ties break on the poolId so the choice is stable
    // across cycles rather than depending on map insertion order.
    const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    chosen.set(token, { poolId: ranked[0]![0], transfers: ranked[0]![1], distinctPools: tally.size });
  }
  return { chosen, ambiguousReceipts, missingReceipts, requests: rpc.requests - before };
}
