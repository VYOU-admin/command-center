/**
 * Phases 1-4: token identity, window bounds, pool enumeration, and scope.
 *
 * These are the phases where a wrong answer is cheapest to fix and most
 * expensive to carry forward, which is why three of the runner's five STOPs
 * are here.
 */

import type { IntakeConfig, IntakeWindow } from './plan.js';
import {
  SELECTORS,
  TOPICS,
  addressTopic,
  decodeInitializeV4,
  decodePoolCreatedV3,
  decodeString,
  decodeTransfer,
  decodeUint8,
  normalizeAddress,
} from '../adapters/token-updates/decode.js';
import { RpcError, hexBlock, type RpcClient } from '../adapters/token-updates/rpc.js';
import type { PoolRow } from '../adapters/token-updates/pools.js';
import { formatUnits } from '../adapters/token-updates/units.js';

/* ---------------------------------------------------------------- identity */

export interface TokenIdentity {
  address: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: string;
}

/**
 * Read identity from the contract. Never supplied by configuration: a decimals
 * value that is asserted rather than read is how a figure ends up wrong by a
 * factor of 10^12.
 */
export async function readIdentity(
  rpc: RpcClient,
  cfg: IntakeConfig,
): Promise<TokenIdentity> {
  const decimals = decodeUint8(await rpc.ethCall(cfg.token, SELECTORS.decimals));
  const name = decodeString(await rpc.ethCall(cfg.token, SELECTORS.name));
  const symbol = decodeString(await rpc.ethCall(cfg.token, SELECTORS.symbol));
  const supplyRaw = await rpc.ethCall(cfg.token, SELECTORS.totalSupply);
  if (!supplyRaw || supplyRaw === '0x') {
    throw new Error('totalSupply() returned no data; the value is unknown, not zero');
  }
  return {
    address: cfg.token,
    name,
    symbol,
    decimals,
    totalSupply: formatUnits(BigInt(supplyRaw), decimals),
  };
}

/* ----------------------------------------------------------------- windows */

/**
 * Block number for an instant, by bisecting block timestamps.
 *
 * Returns the FIRST block at or after the instant. There is no timestamp index
 * on this chain and no explorer API that answers (Blockscout is behind a
 * Cloudflare interstitial), so bisection is the only route. ~26 calls per bound.
 */
export async function blockForInstant(
  rpc: RpcClient,
  instant: Date,
  lowHint: number,
  highHint: number,
): Promise<number> {
  const target = Math.floor(instant.getTime() / 1000);
  let lo = lowHint;
  let hi = highHint;

  const loTs = await rpc.getBlockTimestamp(lo);
  const hiTs = await rpc.getBlockTimestamp(hi);
  if (target <= loTs) return lo;
  if (target > hiTs) {
    throw new Error(
      `instant ${instant.toISOString()} is after the chain head (block ${hi} is ` +
        `${new Date(hiTs * 1000).toISOString()}). A window cannot end in the future.`,
    );
  }

  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await rpc.getBlockTimestamp(mid);
    if (ts < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export async function resolveWindows(
  rpc: RpcClient,
  cfg: IntakeConfig,
  firstBlock: number,
  head: number,
): Promise<IntakeWindow[]> {
  const out: IntakeWindow[] = [];
  for (const w of cfg.windows) {
    const startBlock = await blockForInstant(rpc, new Date(w.start), firstBlock, head);
    const endBlock = await blockForInstant(rpc, new Date(w.end), firstBlock, head);
    if (endBlock <= startBlock) {
      throw new Error(
        `window "${w.label}" resolved to an empty block range ${startBlock}..${endBlock}`,
      );
    }
    out.push({ ...w, startBlock, endBlock });
  }
  // Overlapping windows would tag one wallet twice with different labels, which
  // is legitimate, but silently overlapping ones are usually a config mistake.
  const sorted = [...out].sort((a, b) => a.startBlock! - b.startBlock!);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.startBlock! < sorted[i - 1]!.endBlock!) {
      throw new Error(
        `windows "${sorted[i - 1]!.label}" and "${sorted[i]!.label}" overlap in blocks. ` +
          'If that is intended, say so explicitly rather than by omission.',
      );
    }
  }
  return out;
}

/* --------------------------------------------------------- pool discovery */

export interface PoolCandidate {
  venue: 'v3' | 'v4';
  pool: string;
  currency0: string;
  currency1: string;
  /** How the pool was found, so a thin source can be spotted. */
  via: 'initialize' | 'pool-created' | 'flow-probe';
}

export interface DiscoveryReport {
  candidates: PoolCandidate[];
  v4FromInitialize: number;
  v3FromFactory: number;
  v3FromFlowProbe: number;
  flowAddressesTested: number;
  flowNotContracts: number;
  flowReverted: number;
  /** Set when a venue produced nothing at all. */
  emptyVenues: string[];
}

/**
 * Enumerate every pool the token has ever had, on both venues.
 *
 * v4 pools have NO CONTRACT -- the PoolManager singleton holds every pool's
 * reserves -- so they can only be found through `Initialize`, never by probing
 * an address. v3 pools are contracts and are found two ways, because neither is
 * complete on its own: the factory's `PoolCreated` is authoritative when the
 * factory address is known, and a flow probe catches pools from any other
 * factory or deployer.
 *
 * A DexScreener listing is never used here. It caps at 30 pairs and knew 30 of
 * 91 v3 pools and 14 of 792 v4 pools for PONS.
 */
export async function discoverPools(
  rpc: RpcClient,
  cfg: IntakeConfig,
  firstBlock: number,
  head: number,
  sweepSpan: (filter: object, from: number, to: number) => Promise<
    { address: string; topics: string[]; data: string; blockNumber: string;
      transactionHash: string; logIndex: string; blockTimestamp?: string }[]
  >,
): Promise<DiscoveryReport> {
  const token = normalizeAddress(cfg.token);
  const tokenTopic = addressTopic(token);
  const found = new Map<string, PoolCandidate>();
  const key = (v: string, p: string): string => `${v}:${p}`;

  /* v4 -- Initialize, filtered by the token in each currency position. */
  let v4FromInitialize = 0;
  for (const topics of [
    [TOPICS.initializeV4, null, tokenTopic],
    [TOPICS.initializeV4, null, null, tokenTopic],
  ]) {
    const logs = await sweepSpan(
      { address: cfg.v4PoolManager, topics },
      firstBlock,
      head,
    );
    for (const log of logs) {
      const p = decodeInitializeV4(log);
      if (found.has(key('v4', p.pool))) continue;
      found.set(key('v4', p.pool), { ...p, via: 'initialize' });
      v4FromInitialize += 1;
    }
  }

  /* v3 -- the factory's PoolCreated. */
  let v3FromFactory = 0;
  for (const topics of [
    [TOPICS.poolCreatedV3, tokenTopic],
    [TOPICS.poolCreatedV3, null, tokenTopic],
  ]) {
    const logs = await sweepSpan({ address: cfg.v3Factory, topics }, firstBlock, head);
    for (const log of logs) {
      const p = decodePoolCreatedV3(log);
      if (found.has(key('v3', p.pool))) continue;
      found.set(key('v3', p.pool), { ...p, via: 'pool-created' });
      v3FromFactory += 1;
    }
  }

  /*
   * v3 -- flow probe, for pools from any other factory.
   *
   * Take every address that BOTH received and sent the token: a pool does both,
   * but so does a router, so flow alone does not identify one. Each candidate is
   * then tested on-chain.
   */
  const transferLogs = await sweepSpan(
    { address: cfg.token, topics: [TOPICS.transfer] },
    firstBlock,
    head,
  );
  const received = new Set<string>();
  const sent = new Set<string>();
  for (const log of transferLogs) {
    const t = decodeTransfer(log);
    received.add(t.to);
    sent.add(t.from);
  }
  const twoWay = [...received].filter(
    (a) => sent.has(a) && a !== token && !found.has(key('v3', a)),
  );

  let v3FromFlowProbe = 0;
  let flowNotContracts = 0;
  let flowReverted = 0;
  for (const address of twoWay) {
    // A pool is a contract. eth_getCode has no legitimate error, so anything
    // other than a result is a failed read and must throw rather than be
    // recorded as "no contract here".
    const codeAt = await rpc.getCode(address, 'latest');
    if (codeAt === '0x') {
      flowNotContracts += 1;
      continue;
    }
    let token0: string | null = null;
    let token1: string | null = null;
    try {
      token0 = await rpc.ethCall(address, SELECTORS.token0);
      token1 = await rpc.ethCall(address, SELECTORS.token1);
    } catch (err) {
      /*
       * A REVERT IS THE ANSWER, NOT A FAILURE. It means the contract has no
       * such function, so it is not a pool. Retrying reverts is how a
       * classifier once spent five rounds re-asking 1,664 settled questions.
       */
      if (err instanceof RpcError) {
        flowReverted += 1;
        continue;
      }
      throw err;
    }
    if (!token0 || !token1 || token0 === '0x' || token1 === '0x') {
      flowReverted += 1;
      continue;
    }
    const c0 = '0x' + token0.slice(-40).toLowerCase();
    const c1 = '0x' + token1.slice(-40).toLowerCase();
    if (c0 !== token && c1 !== token) continue;
    found.set(key('v3', address), {
      venue: 'v3',
      pool: address,
      currency0: c0,
      currency1: c1,
      via: 'flow-probe',
    });
    v3FromFlowProbe += 1;
  }

  const candidates = [...found.values()];
  const emptyVenues: string[] = [];
  if (!candidates.some((c) => c.venue === 'v3')) emptyVenues.push('v3');
  if (!candidates.some((c) => c.venue === 'v4')) emptyVenues.push('v4');
  /*
   * A V3-ONLY TOKEN IS SUPPORTED, and so is a v4-only one. Only BOTH being
   * empty is a defect -- a token with no pools on either venue has never
   * traded, which is far more likely to be a wrong address or a wrong topic
   * hash than a real finding.
   */
  if (emptyVenues.length === 2) {
    throw new Error(
      `no pools found on either venue for ${cfg.token} across blocks ` +
        `${firstBlock}..${head}. A filter matching nothing is a suspected defect, ` +
        'not a clean sweep: check the token address and the Initialize/PoolCreated topics.',
    );
  }

  return {
    candidates,
    v4FromInitialize,
    v3FromFactory,
    v3FromFlowProbe,
    flowAddressesTested: twoWay.length,
    flowNotContracts,
    flowReverted,
    emptyVenues,
  };
}

/* -------------------------------------------------------------------- scope */

export interface CounterAsset {
  address: string;
  symbol: string | null;
  decimals: number | null;
  classification: 'usd' | 'native' | 'no-usd-reference';
  pools: number;
}

export interface ScopeReport {
  inScope: PoolRow[];
  rejected: { venue: string; pool: string; counter: string; symbol: string | null }[];
  counters: CounterAsset[];
  /** True when the token has no USD-quoted pool at all. */
  noUsdRoute: boolean;
  /** True when the token has no native-quoted pool at all. */
  noNativeRoute: boolean;
}

/**
 * Decide which pools are in scope, reading every counter asset's symbol and
 * decimals from its own contract first.
 *
 * The rule is applied ONCE, TO BOTH VENUES. Applying it to v3 only is a defect
 * this project has shipped: the v4 set still held PONS/NVDA and
 * PONS/STONKBROKER, pricing a memecoin against a tokenised equity through an
 * oracle nobody verified.
 */
export async function scopePools(
  rpc: RpcClient,
  cfg: IntakeConfig,
  candidates: PoolCandidate[],
): Promise<ScopeReport> {
  const token = normalizeAddress(cfg.token);
  const usdAsset = cfg.usdAsset.toLowerCase();
  const nativeAssets = new Set(cfg.nativeAssets.map((a) => a.toLowerCase()));
  const pricing = new Set(cfg.pricingAssets.map((a) => a.toLowerCase()));

  const counterPools = new Map<string, number>();
  for (const c of candidates) {
    const counter = c.currency0 === token ? c.currency1 : c.currency0;
    counterPools.set(counter, (counterPools.get(counter) ?? 0) + 1);
  }

  const meta = new Map<string, { symbol: string | null; decimals: number | null }>();
  for (const counter of counterPools.keys()) {
    // Read symbol BEFORE deciding. Of 48 unidentified counter assets on PONS
    // all 48 resolved, four were tokenised equities, and none was a stablecoin.
    let symbol: string | null = null;
    let decimals: number | null = null;
    try {
      symbol = decodeString(await rpc.ethCall(counter, SELECTORS.symbol));
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
    }
    try {
      decimals = decodeUint8(await rpc.ethCall(counter, SELECTORS.decimals));
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
    }
    meta.set(counter, { symbol, decimals });
  }

  const inScope: PoolRow[] = [];
  const rejected: ScopeReport['rejected'] = [];
  for (const c of candidates) {
    const isToken0 = c.currency0 === token;
    const counter = isToken0 ? c.currency1 : c.currency0;
    const m = meta.get(counter)!;
    if (!pricing.has(counter)) {
      rejected.push({ venue: c.venue, pool: c.pool, counter, symbol: m.symbol });
      continue;
    }
    if (m.decimals === null) {
      // A counter whose decimals cannot be read cannot be valued. Treating an
      // unreadable decimals as 18 is a factor-of-10^12 error waiting to happen.
      throw new Error(
        `counter asset ${counter} (${m.symbol ?? 'unknown symbol'}) did not answer ` +
          'decimals(). It is in the pricing set but cannot be valued; remove it or fix the read.',
      );
    }
    inScope.push({
      venue: c.venue,
      pool: c.pool,
      tokenSide: isToken0 ? 0 : 1,
      counter,
      counterDec: m.decimals,
      counterSym: m.symbol,
    });
  }

  const counters: CounterAsset[] = [...counterPools.entries()].map(([address, pools]) => {
    const m = meta.get(address)!;
    const classification: CounterAsset['classification'] =
      address === usdAsset ? 'usd' : nativeAssets.has(address) ? 'native' : 'no-usd-reference';
    return { address, symbol: m.symbol, decimals: m.decimals, classification, pools };
  });

  const noUsdRoute = !inScope.some((p) => p.counter === usdAsset);
  const noNativeRoute = !inScope.some((p) => nativeAssets.has(p.counter));

  return { inScope, rejected, counters, noUsdRoute, noNativeRoute };
}
