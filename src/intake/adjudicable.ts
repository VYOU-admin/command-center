/**
 * WHEN A SWAP AND A TRANSFER ARE EVIDENCE ABOUT A SIGN CONVENTION.
 *
 * ONE DEFINITION, IMPORTED BY BOTH CALLERS. `build-cohort.ts` has carried this
 * guard as `spt.n = 1` against its `_alltok` temp table since INDEX;
 * `verifyConventions` never had it, and CASHCAT is where that cost an answer:
 * it raised `v4/in-window 779/790` on eleven transactions that were not
 * convention disagreements at all.
 *
 * A router can buy the token on one pool and sell it on another inside ONE
 * transaction. Only the NET leaves the PoolManager, so pairing EACH swap
 * against that single net transfer forces one of them to disagree. Decoded on
 * CASHCAT, with hashes in section 8:
 * 0x414077b6ec56a58e91c751d8319280986069cdf70350ec4639e35e6e5d6316cf buys
 * ~42.58 on one CASHCAT/ETH pool and sells ~41.19 on another, and 1.387 leaves
 * the PoolManager.
 *
 * This is the FOURTH time two implementations of one rule produced a wrong
 * answer on this project, so the remedy is to remove the second implementation
 * rather than to correct it. docs/ROBINHOOD.md steps 6 and 7.
 *
 * IT COUNTS `token_swap_logs`, NOT `v4_swaps_all`. `v4_swaps_all` sees every v4
 * swap on the chain but only for 15,115,267..42,695,454, and it holds ZERO rows
 * inside CASHCAT-P1 -- a guard routed through it would have fixed nothing here.
 *
 * KNOWN LIMITATION, recorded rather than discovered later: `token_swap_logs`
 * holds only the token's IN-SCOPE pools, so a hop on a REJECTED pool is
 * invisible to this count. `build-cohort.ts` layers `v4_swaps_all` on top for
 * that case where its coverage reaches; below block 15,115,267 nothing does.
 */
import type { PoolClient } from '../store/db.js';

/**
 * Swaps of this token per transaction, over EVERY swap stored for it.
 *
 * The same text `build-cohort.ts` fills `_alltok` with, so the two cannot drift.
 */
export const SWAPS_PER_TX_SQL = `
  select tx_hash, count(*)::int as n
    from token_swap_logs
   where chain = $1 and token = $2
   group by tx_hash`;

/**
 * A transaction is adjudicable only when it holds EXACTLY ONE swap of the token.
 *
 * `undefined` means the transaction is not in the count at all, which cannot
 * happen for a transaction drawn from `token_swap_logs` and is therefore a
 * defect rather than a pass -- so it is NOT adjudicable.
 */
export function isAdjudicable(swapsInTx: number | undefined): boolean {
  return swapsInTx === 1;
}

/**
 * The count for a specific set of transactions.
 *
 * THE COUNT MUST COME FROM THE WHOLE TABLE, NEVER FROM THE SAMPLE. The
 * conventions phase draws up to 800 swaps per venue per region, so a
 * two-swap transaction may contribute only one of them to the sample; counting
 * within the sample would call it single-swap and admit exactly the pair this
 * guard exists to reject.
 */
export async function loadSwapsPerTx(
  client: PoolClient,
  chain: string,
  token: string,
  txHashes: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (txHashes.length === 0) return out;
  const res = await client.query<{ tx_hash: string; n: number }>(
    `select tx_hash, count(*)::int as n
       from token_swap_logs
      where chain = $1 and token = $2 and tx_hash = any($3::text[])
      group by tx_hash`,
    [chain, token, txHashes],
  );
  for (const r of res.rows) out.set(r.tx_hash, r.n);
  return out;
}
