/**
 * Collection filters, and the rejection accounting that goes with them.
 *
 * WHY REJECTIONS ARE COUNTED. Measured before building: 674,759 ERC-721 mints
 * per day on chain 4663, of which 61.5% were a single farm collection and ~8.6%
 * were DEX liquidity-position NFTs, which are not collectibles at all. Filtering
 * is therefore not optional — unfiltered, this table adds ~6.1 GB/month.
 *
 * But a filter is exactly the thing that fails silently. A gate on
 * early_snapshots once matched almost nothing while reporting success, and the
 * volume filled. The inverse failure — a rule that matches everything and
 * empties the table — is just as invisible. Both are caught by counting what
 * each rule rejected, per day and per chain, which is why every drop goes
 * through `reject()` rather than a bare `continue`.
 */

/** Rule names are stable identifiers; they are written to the stats table. */
export type FilterRule =
  | 'lp_position'
  | 'collection_daily_cap'
  | 'min_distinct_minters'
  | 'missing_minter'
  | 'compressed_disabled';

export interface FilterConfig {
  excludeLpPositions: boolean;
  maxMintsPerCollectionPerDay: number;
  minDistinctMintersPerDay: number;
  includeCompressed: boolean;
}

export interface CandidateMint {
  chain: string;
  collectionAddress: string;
  collectionName: string | null;
  tokenId: string;
  mintAddress: string;
  minterWallet: string;
  blockTime: Date;
  mintPrice: number | null;
  priceCurrency: string | null;
  txHash: string;
  compressed: boolean;
}

/**
 * Composite keys are built in exactly one place.
 *
 * They were briefly assembled inline in two files with different separators,
 * which made every lookup miss silently — the per-collection daily cap read a
 * prior count of zero and let a farm through unbounded. A shared builder makes
 * that class of bug impossible rather than merely unlikely.
 */
export const SEP = '\u0001';

export function dayKey(chain: string, collection: string, day: string): string {
  return `${chain}${SEP}${collection}${SEP}${day}`;
}

/**
 * LP position NFTs are minted by adding liquidity, not by collecting anything.
 * Matched by name rather than by a hardcoded address list so a new DEX on a new
 * chain is covered without a code change — the names are highly conventional
 * ("Uniswap v4 Positions NFT", "up Position NFT", "... LP").
 */
const LP_NAME = /(position|positions)\s*(nft|nft-v\d+)?$|^uniswap\s+v\d+\s+positions|liquidity/i;

export function looksLikeLpPosition(name: string | null): boolean {
  if (!name) return false;
  return LP_NAME.test(name.trim());
}

export class RejectionLog {
  private counts = new Map<string, number>();

  reject(chain: string, rule: FilterRule, n = 1): void {
    const k = `${chain}${SEP}${rule}`;
    this.counts.set(k, (this.counts.get(k) ?? 0) + n);
  }

  /** [chain, rule, count] triples for persistence. */
  entries(): Array<[string, string, number]> {
    return [...this.counts.entries()].map(([k, v]) => {
      const [chain = '', rule = ''] = k.split(SEP);
      return [chain, rule, v] as [string, string, number];
    });
  }

  total(): number {
    let t = 0;
    for (const v of this.counts.values()) t += v;
    return t;
  }

  summary(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [chain, rule, n] of this.entries()) out[`${chain}.${rule}`] = n;
    return out;
  }
}

/**
 * Apply the filters to one run's candidates.
 *
 * The two volume rules are evaluated per (collection, day) over the batch plus
 * whatever is already stored for that day, so a farm cannot slip through by
 * arriving in small batches. `existingToday` supplies the stored side.
 */
export function applyFilters(
  candidates: CandidateMint[],
  cfg: FilterConfig,
  existingToday: Map<string, { mints: number; minters: Set<string> }>,
  log: RejectionLog,
): CandidateMint[] {
  const kept: CandidateMint[] = [];

  // group by collection-day so the caps see the whole picture, not one row
  const groups = new Map<string, CandidateMint[]>();
  for (const c of candidates) {
    if (!c.minterWallet) {
      log.reject(c.chain, 'missing_minter');
      continue;
    }
    if (c.compressed && !cfg.includeCompressed) {
      log.reject(c.chain, 'compressed_disabled');
      continue;
    }
    if (cfg.excludeLpPositions && looksLikeLpPosition(c.collectionName)) {
      log.reject(c.chain, 'lp_position');
      continue;
    }
    const day = c.blockTime.toISOString().slice(0, 10);
    const k = dayKey(c.chain, c.collectionAddress, day);
    const arr = groups.get(k);
    if (arr) arr.push(c);
    else groups.set(k, [c]);
  }

  for (const [k, rows] of groups) {
    const first = rows[0];
    if (!first) continue;
    const prior = existingToday.get(k) ?? { mints: 0, minters: new Set<string>() };
    const minters = new Set(prior.minters);
    for (const r of rows) minters.add(r.minterWallet);

    // A collection nobody but its own deployer mints is a farm, not a drop.
    // Only applied once the day has enough volume to judge, so a genuine
    // collection's first few mints are not thrown away.
    const totalForDay = prior.mints + rows.length;
    if (totalForDay >= cfg.minDistinctMintersPerDay &&
        minters.size < cfg.minDistinctMintersPerDay) {
      log.reject(first.chain, 'min_distinct_minters', rows.length);
      continue;
    }

    let budget = Math.max(0, cfg.maxMintsPerCollectionPerDay - prior.mints);
    if (budget <= 0) {
      log.reject(first.chain, 'collection_daily_cap', rows.length);
      continue;
    }
    if (rows.length > budget) {
      log.reject(first.chain, 'collection_daily_cap', rows.length - budget);
      kept.push(...rows.slice(0, budget));
    } else {
      kept.push(...rows);
    }
  }
  return kept;
}
