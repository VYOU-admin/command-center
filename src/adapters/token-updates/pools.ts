/**
 * Pool enumeration, re-derived every run.
 *
 * WHY EVERY RUN. Pools are created continuously. Between two enumerations 12
 * hours apart PONS gained 83 new v4 pools, 8 of them in scope. A fixed pool
 * list goes stale within a day, and a missed pool is a filter matching nothing:
 * the run succeeds and simply omits those trades.
 *
 * WHY THE EVENTS AND NOT A LISTING. DexScreener caps its answer at 30 pairs and
 * knew 14 of 792 v4 pools for PONS. The creation events are the only complete
 * source. v4 pools have no contract at all -- the PoolManager singleton holds
 * every pool's reserves -- so nothing can be discovered by probing addresses.
 *
 * SCOPE IS APPLIED ONCE, TO BOTH VENUES. Applying it to v3 only is a defect
 * this project has shipped: the v4 set still contained PONS/NVDA and
 * PONS/STONKBROKER, pricing a memecoin against a tokenised equity through an
 * oracle nobody verified.
 */

import type { UpdateConfig } from './config.js';
import {
  SELECTORS,
  TOPICS,
  addressTopic,
  decodeInitializeV4,
  decodePoolCreatedV3,
  decodeString,
  decodeUint8,
  normalizeAddress,
  type NewPool,
} from './decode.js';
import type { RpcClient } from './rpc.js';
import type { PoolClient } from '../../store/db.js';

export interface PoolRow {
  venue: 'v3' | 'v4';
  /** v3: pool address. v4: pool id. Lowercased. */
  pool: string;
  /** Which currency index the tracked token sits on. */
  tokenSide: 0 | 1;
  counter: string;
  counterDec: number;
  counterSym: string | null;
}

export interface PoolScan {
  /** Every in-scope pool for this token, keyed `venue:pool`. */
  all: Map<string, PoolRow>;
  added: PoolRow[];
  /** Pools created in range whose counter side is not a pricing asset. */
  rejected: { venue: 'v3' | 'v4'; pool: string; counter: string }[];
  seen: { v3: number; v4: number };
}

export const poolKey = (venue: string, pool: string): string => `${venue}:${pool}`;

/**
 * Every in-scope pool already known for this token.
 *
 * NOTE: `pool_meta` has neither a chain nor a token column -- it was created
 * during the PONS intake, when there was one chain and one token. Every row in
 * it therefore belongs to this token by construction. A second EVM token on
 * this chain needs a token column before it can share the table; until then
 * this load would hand it another token's pools.
 */
export async function loadPools(client: PoolClient): Promise<Map<string, PoolRow>> {
  const res = await client.query<{
    venue: string;
    pool: string;
    pons_side: number;
    counter: string;
    counter_dec: number;
    counter_sym: string | null;
  }>(
    `select venue, pool, pons_side, counter, counter_dec, counter_sym from pool_meta`,
  );
  const out = new Map<string, PoolRow>();
  for (const r of res.rows) {
    const venue = r.venue === 'v4' ? 'v4' : 'v3';
    out.set(poolKey(venue, r.pool.toLowerCase()), {
      venue,
      pool: r.pool.toLowerCase(),
      tokenSide: r.pons_side === 1 ? 1 : 0,
      counter: r.counter.toLowerCase(),
      counterDec: r.counter_dec,
      counterSym: r.counter_sym,
    });
  }
  return out;
}

/**
 * Enumerate pools created in [from, to] and merge the in-scope ones in.
 *
 * A failure here FAILS THE RUN. Continuing with a stale pool list would read
 * swaps from a set known to be incomplete and report success.
 */
export async function scanForPools(
  rpc: RpcClient,
  cfg: UpdateConfig,
  existing: Map<string, PoolRow>,
  from: number,
  to: number,
): Promise<PoolScan> {
  const token = normalizeAddress(cfg.token);
  const tokenAsTopic = addressTopic(token);
  const pricing = new Set(cfg.pricingAssets.map((a) => a.toLowerCase()));

  const span = cfg.logSpanBlocks;
  const min = cfg.minLogSpanBlocks;

  const found: NewPool[] = [];
  // v4: the token can be either currency, and the position is indexed, so it
  // takes one query per position. Filtering by position is exact; sweeping the
  // PoolManager unfiltered returns every pool created on the chain.
  for (const topics of [
    [TOPICS.initializeV4, null, tokenAsTopic],
    [TOPICS.initializeV4, null, null, tokenAsTopic],
  ]) {
    const logs = await rpc.getLogs(
      { address: cfg.v4PoolManager, topics },
      from,
      to,
      span,
      min,
    );
    found.push(...logs.map(decodeInitializeV4));
  }
  // v3: same shape against the factory.
  for (const topics of [
    [TOPICS.poolCreatedV3, tokenAsTopic],
    [TOPICS.poolCreatedV3, null, tokenAsTopic],
  ]) {
    const logs = await rpc.getLogs({ address: cfg.v3Factory, topics }, from, to, span, min);
    found.push(...logs.map(decodePoolCreatedV3));
  }

  const all = new Map(existing);
  const added: PoolRow[] = [];
  const rejected: PoolScan['rejected'] = [];
  const seen = { v3: 0, v4: 0 };
  const decimalsCache = new Map<string, { dec: number; sym: string | null }>();
  for (const row of existing.values()) {
    decimalsCache.set(row.counter, { dec: row.counterDec, sym: row.counterSym });
  }

  for (const p of found) {
    seen[p.venue] += 1;
    const key = poolKey(p.venue, p.pool);
    if (all.has(key)) continue;

    const isToken0 = p.currency0 === token;
    const isToken1 = p.currency1 === token;
    if (!isToken0 && !isToken1) {
      // The filter asked for the token in one of these positions, so this is a
      // decoding disagreement, not a pool we can ignore.
      throw new Error(
        `pool ${p.pool} matched the token filter but neither currency is the token ` +
          `(${p.currency0}, ${p.currency1}); the event layout is not what was assumed`,
      );
    }
    const tokenSide: 0 | 1 = isToken0 ? 0 : 1;
    const counter = isToken0 ? p.currency1 : p.currency0;

    if (!pricing.has(counter)) {
      rejected.push({ venue: p.venue, pool: p.pool, counter });
      continue;
    }

    let meta = decimalsCache.get(counter);
    if (!meta) {
      // Read per contract. USDG has 6 decimals where everything around it has
      // 18; assuming 18 inflates every USDG figure by a factor of 10^12.
      const dec = decodeUint8(await rpc.ethCall(counter, SELECTORS.decimals));
      const sym = decodeString(await rpc.ethCall(counter, SELECTORS.symbol));
      meta = { dec, sym };
      decimalsCache.set(counter, meta);
    }

    const row: PoolRow = {
      venue: p.venue,
      pool: p.pool,
      tokenSide,
      counter,
      counterDec: meta.dec,
      counterSym: meta.sym,
    };
    all.set(key, row);
    added.push(row);
  }

  return { all, added, rejected, seen };
}

export async function persistPools(client: PoolClient, added: PoolRow[]): Promise<number> {
  let stored = 0;
  for (const p of added) {
    const res = await client.query(
      `insert into pool_meta (venue, pool, pons_side, counter, counter_dec, counter_sym)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (venue, pool) do nothing`,
      [p.venue, p.pool, p.tokenSide, p.counter, p.counterDec, p.counterSym],
    );
    stored += res.rowCount ?? 0;
  }
  return stored;
}
