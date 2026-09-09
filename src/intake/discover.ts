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
  classifyCode,
  addressFromTopic,
  decodeString,
  readDecimals,
  normalizeAddress,
} from '../adapters/token-updates/decode.js';
import { RpcError, type LogEntry, type RpcClient } from '../adapters/token-updates/rpc.js';
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
  const decimals = await readDecimals((to, data) => rpc.ethCall(to, data), cfg.token);
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
  /** Null when the probe did not run. Null is 'not looked', never 'none found'. */
  v3FromFlowProbe: number | null;
  /** Transfers streamed through the probe. Never held in memory at once. */
  transfersScanned: number;
  flowProbeRan: boolean;
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
export type LogStream = (
  filter: object,
  from: number,
  to: number,
  onBatch: (logs: LogEntry[]) => void,
  startSpan?: number,
) => Promise<void>;

export async function discoverPools(
  rpc: RpcClient,
  cfg: IntakeConfig,
  firstBlock: number,
  head: number,
  /*
   * STREAMS, never returns an array. The flow probe reads every transfer the
   * token has ever emitted -- 5.76M log objects for PONS -- and collecting them
   * into one array to look at two address fields would exhaust memory long
   * before it produced a pool list. Only the two address SETS are kept.
   */
  sweepStream: LogStream,
  /** Block the contract probe runs at. Never `latest`. */
  probeBlock: number,
): Promise<DiscoveryReport> {
  const token = normalizeAddress(cfg.token);
  const tokenTopic = addressTopic(token);
  const found = new Map<string, PoolCandidate>();
  const key = (v: string, p: string): string => `${v}:${p}`;

  /*
   * v4 -- Initialize, filtered by the token in each currency position.
   * SPARSE filter: one token's pool creations. Starts at sparseLogSpanBlocks.
   */
  let v4FromInitialize = 0;
  for (const topics of [
    [TOPICS.initializeV4, null, tokenTopic],
    [TOPICS.initializeV4, null, null, tokenTopic],
  ]) {
    await sweepStream(
      { address: cfg.v4PoolManager, topics }, firstBlock, head,
      (logs) => {
        for (const log of logs) {
          const p = decodeInitializeV4(log);
          if (found.has(key('v4', p.pool))) continue;
          found.set(key('v4', p.pool), { ...p, via: 'initialize' });
          v4FromInitialize += 1;
        }
      },
      cfg.sparseLogSpanBlocks,
    );
  }

  /* v3 -- the factory's PoolCreated. Also sparse. */
  let v3FromFactory = 0;
  for (const topics of [
    [TOPICS.poolCreatedV3, tokenTopic],
    [TOPICS.poolCreatedV3, null, tokenTopic],
  ]) {
    await sweepStream(
      { address: cfg.v3Factory, topics }, firstBlock, head,
      (logs) => {
        for (const log of logs) {
          const p = decodePoolCreatedV3(log);
          if (found.has(key('v3', p.pool))) continue;
          found.set(key('v3', p.pool), { ...p, via: 'pool-created' });
          v3FromFactory += 1;
        }
      },
      cfg.sparseLogSpanBlocks,
    );
  }

  /*
   * v3 -- flow probe, for pools from any other factory.
   *
   * OFF BY DEFAULT. It sweeps every transfer the token ever emitted and then
   * spends one `eth_getCode` per address that both sent and received, so its
   * cost scales with the token's ADDRESS count, not its pool count. Measured on
   * AI: 14,034 two-way addresses in the window alone, ~389,000 CU, to find
   * roughly 13 v3 pools out of 4,856. Enumeration above already found every v4
   * pool and every v3 pool from the configured factory.
   *
   * Turn it on for a token where v3 carries a material share of swaps. See
   * docs/ROBINHOOD.md step 3 for how to decide that before spending.
   */
  if (!cfg.flowProbe) {
    return {
      candidates: [...found.values()],
      v4FromInitialize,
      v3FromFactory,
      // NOT zero. Zero would say the probe ran and found nothing.
      v3FromFlowProbe: null,
      flowProbeRan: false,
      transfersScanned: 0,
      flowAddressesTested: 0,
      flowNotContracts: 0,
      flowReverted: 0,
      emptyVenues: v4FromInitialize === 0 ? ['v4'] : [],
    };
  }

  /*
   * Take every address that BOTH received and sent the token: a pool does both,
   * but so does a router, so flow alone does not identify one. Each candidate is
   * then tested on-chain.
   *
   * STREAMS, never buffers. This reads every transfer the token has emitted --
   * 5.76M log objects for PONS -- and collecting them into one array to look at
   * two address fields would exhaust memory long before it produced a pool list.
   * Only the two address SETS survive each batch.
   */
  const received = new Set<string>();
  const sent = new Set<string>();
  let transfersSeen = 0;
  await sweepStream(
    { address: cfg.token, topics: [TOPICS.transfer] }, firstBlock, head,
    (logs) => {
      transfersSeen += logs.length;
      for (const log of logs) {
        received.add(addressFromTopic(log.topics[1]!));
        sent.add(addressFromTopic(log.topics[2]!));
      }
    },
  );
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
    /*
     * A POOL IS A DEPLOYED CONTRACT. Neither an EOA nor an EIP-7702 delegated
     * account can be one, so both are rejected here -- a delegated account
     * would otherwise be probed with token0()/token1() and cost two calls to
     * reach the same answer.
     *
     * Probed at a FIXED BLOCK, never `latest`: a pool that self-destructed
     * afterwards would read as never having been one.
     */
    const codeAt = await rpc.getCode(address, probeBlock);
    if (classifyCode(codeAt) !== 'contract') {
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
    flowProbeRan: true,
    transfersScanned: transfersSeen,
    flowAddressesTested: twoWay.length,
    flowNotContracts,
    flowReverted,
    emptyVenues,
  };
}

/* -------------------------------------------------------------------- scope */

export interface CounterAsset {
  /** False when the read bound skipped it; symbol and decimals are then unknown. */
  symbolRead?: boolean;
  address: string;
  symbol: string | null;
  decimals: number | null;
  classification: 'usd' | 'native' | 'no-usd-reference';
  pools: number;
}

export interface ScopeReport {
  inScope: PoolRow[];
  rejected: {
    venue: string; pool: string; counter: string; symbol: string | null;
    /** False when the counter was outside the read bound; symbol is then unknown. */
    symbolRead: boolean;
  }[];
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
/** Native value's "address" on v4. It is not a contract and never will be. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

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

  /*
   * WHICH COUNTERS ARE WORTH READING. docs/ROBINHOOD.md step 4: "Bound this:
   * read the pricing assets and the busiest counters, not the tail." The rule
   * was in the document and not in the code, which is a defect in the code.
   *
   * Always read the configured pricing and bridge assets -- their metadata
   * decides real pools and their decimals are load-bearing. Then read the
   * busiest remaining counters up to the cap, purely so the rejection report
   * NAMES what it rejected instead of listing addresses. The tail is rejected
   * on address alone and says so; it is never recorded as though its symbol had
   * been read and found wanting.
   */
  const bridge = new Set(cfg.bridgeAssets.map((a) => a.toLowerCase()));
  const alwaysRead = new Set([...pricing, ...bridge].filter((a) => counterPools.has(a)));
  const busiest = [...counterPools.entries()]
    .filter(([a]) => !alwaysRead.has(a))
    .sort((x, y) => y[1] - x[1])
    .slice(0, cfg.scopeMaxCounterReads)
    .map(([a]) => a);
  const toRead = new Set([...alwaysRead, ...busiest]);

  const meta = new Map<string, { symbol: string | null; decimals: number | null }>();
  for (const counter of toRead) {
    /*
     * A FAILED READ IS FATAL ONLY FOR A COUNTER WE INTEND TO VALUE.
     *
     * Step 4: "A counter whose decimals() cannot be read cannot be valued.
     * Raise." That applies to the pricing and bridge assets, whose decimals are
     * load-bearing -- treating an unreadable decimals as 18 is the factor-of-
     * 10^12 error. It does NOT apply to the busiest-counter reads, which exist
     * only so the rejection report can name what it rejected: those pools are
     * out of scope whatever their decimals say, so killing the phase over one
     * of them fails a run for a value nothing consumes.
     */
    /*
     * NATIVE ETH HAS NO CONTRACT TO READ. The zero address is a real counter on
     * v4 -- pools quote against native value directly -- and calling symbol()
     * or decimals() on it returns no data, which `readDecimals` correctly
     * refuses to call zero. Its decimals are a property of the chain, not of a
     * contract, and step 4 lists them: native ETH, 18. This is the one counter
     * whose metadata is declared rather than read, and it is declared because
     * there is nothing to read it from.
     */
    if (counter === ZERO_ADDRESS) {
      meta.set(counter, { symbol: 'ETH', decimals: 18 });
      continue;
    }

    const mustRead = alwaysRead.has(counter);
    let symbol: string | null = null;
    let decimals: number | null = null;
    try {
      symbol = decodeString(await rpc.ethCall(counter, SELECTORS.symbol));
    } catch (err) {
      if (mustRead && !(err instanceof RpcError)) throw err;
      if (!(err instanceof RpcError) && !mustRead) symbol = null;
    }
    try {
      decimals = await readDecimals((to, data) => rpc.ethCall(to, data), counter);
    } catch (err) {
      if (mustRead) throw err;
      decimals = null;
    }
    meta.set(counter, { symbol, decimals });
  }

  const inScope: PoolRow[] = [];
  const rejected: ScopeReport['rejected'] = [];
  for (const c of candidates) {
    const isToken0 = c.currency0 === token;
    const counter = isToken0 ? c.currency1 : c.currency0;
    const m = meta.get(counter) ?? { symbol: null, decimals: null };
    /*
     * IN SCOPE MEANS A PRICING ASSET **OR A BRIDGE ASSET**. Step 4 has always
     * said so; the code tested only the pricing set, so every bridge-quoted pool
     * was rejected and produced no rows at all -- not null-priced rows, none.
     *
     * On AI that silently discarded 59.1% of its swaps: its charted market is
     * AI/NVDA, NVDA was declared as a bridge and its USD series derived and
     * stored, and the pools that series exists to price had already been
     * rejected. A bridge asset with no pool in scope is a series nothing reads.
     */
    if (!pricing.has(counter) && !bridge.has(counter)) {
      rejected.push({
        venue: c.venue, pool: c.pool, counter,
        // Null symbol here means NOT READ, not "unnamed". The report says which.
        symbol: m.symbol, symbolRead: toRead.has(counter),
      });
      continue;
    }
    if (m.decimals === null) {
      // A counter whose decimals cannot be read cannot be valued -- and a bridge
      // is valued like any other counter, one level deeper. Treating an
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

  /*
   * The counter census covers EVERY counter, including the tail the read bound
   * skipped. Those carry a null symbol and decimals meaning "not read" -- the
   * `symbolRead` flag on each rejection is what distinguishes that from a
   * contract that was asked and did not answer.
   */
  const counters: CounterAsset[] = [...counterPools.entries()].map(([address, pools]) => {
    const m = meta.get(address) ?? { symbol: null, decimals: null };
    const classification: CounterAsset['classification'] =
      address === usdAsset ? 'usd' : nativeAssets.has(address) ? 'native' : 'no-usd-reference';
    return {
      address, symbol: m.symbol, decimals: m.decimals, classification, pools,
      symbolRead: toRead.has(address),
    };
  });

  const noUsdRoute = !inScope.some((p) => p.counter === usdAsset);
  const noNativeRoute = !inScope.some((p) => nativeAssets.has(p.counter));

  return { inScope, rejected, counters, noUsdRoute, noNativeRoute };
}
