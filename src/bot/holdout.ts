/**
 * THE ONE IMPLEMENTATION OF THE HOLDOUT SPLIT.
 *
 * The 50/50 split by the first hex character of `md5(pool_id)` was fixed in
 * `launch-search.ts` before any hypothesis was formed, and every later test has to use
 * THE SAME split or it is not a holdout at all — a second implementation that happened
 * to bucket one pool differently would quietly leak search pools into the test half,
 * and nothing would report it.
 *
 * `0`-`7` is SEARCH. `8`-`f` is HOLDOUT. It is deterministic, reproducible from the
 * pool id alone, independent of block, time and every feature under test, and it does
 * not move when new pools arrive.
 *
 * WHAT THIS SPLIT DOES AND DOES NOT BUY, stated here because it is easy to overclaim.
 * It proves an effect is not an artefact of which pools were looked at. It proves
 * NOTHING about whether the effect still exists in a later era — for that the test has
 * to be a window nobody has seen, which is a different control entirely. Both are used
 * in `ROBINHOOD.md` and they are not interchangeable.
 */

export type Half = 'search' | 'holdout' | 'all';

export function isHalf(v: string): v is Half {
  return v === 'search' || v === 'holdout' || v === 'all';
}

/**
 * The SQL predicate for a half, applied to a column holding the pool id.
 * `col` is a SQL identifier supplied by the caller, never user input.
 */
export function halfPredicate(half: Half, col = 'pool_id'): string {
  if (half === 'search') return `substr(md5(${col}),1,1) < '8'`;
  if (half === 'holdout') return `substr(md5(${col}),1,1) >= '8'`;
  return 'true';
}
