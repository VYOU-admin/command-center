/**
 * THE ONE IMPLEMENTATION of the four scored entry rules — P11, P14a, P14b, P15.
 *
 * `bot/rule.ts` holds the ORIGINAL launchpad/fee/gap rule and is untouched; §6AC.2
 * measured that rule rejecting every launch these four select, and re-pointing it under
 * a plumbing-test authorisation is exactly what this project forbids. These are the
 * rules the collector scores, and they live here so that **the collector and the
 * executor share one implementation.**
 *
 * ===========================================================================
 * WHY THIS FILE EXISTS — A DEFECT CAUGHT BEFORE IT TRADED
 * ===========================================================================
 *
 * `oneshot.ts` v1 selected its candidate by querying `bot_p13` for a row whose entry
 * block had not yet passed. **That condition is unsatisfiable.** The collector only
 * processes launches whose EXIT block has matured (`to = head - (EXIT + 3000)`), so
 * every stored row has `init_block + 1150 <= head - 4000` — its entry is always at
 * least 4,000 blocks in the past. The executor would have waited its full 90 minutes
 * and reported "nothing traded", every time, forever.
 *
 * The fix is not a looser query. A live executor must evaluate a launch **as it
 * happens**, which means the rule logic cannot live inside the collector CLI. Copying
 * it into the executor would have created the second implementation that `rule.ts`'s
 * own header records drifting five times on this project. So it is extracted here and
 * imported by both.
 */
import type { PoolClient } from 'pg';

export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
export const TOKEN_CREATED =
  '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';
/** Currencies that count as the pricing side of a pair. */
export const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
export const SUPPLY = 1e27;
export const ENTRY_BLOCKS = 1_150;    /* +115 s */
export const EXIT_BLOCKS = 2_150;     /* +215 s */

/** THE RULES. Frozen; see docs/NAMED-RULE-P11/P14/P15. */
export const GATE1_SHARE = 0.40;
export const GATE2_SOLD = 0.25;
export const P11_ETH = 3.6931;
export const P15_FLOOR_ETH = 2.0;
export const P15_CEIL_ETH = 4.0;
export const P15_MAX_SELLS = 2;
export const ROLL = [
  { key: 'a' as const, hours: 72, minN: 20 },
  { key: 'b' as const, hours: 12, minN: 10 },
];
export const BLOCKS_PER_SEC = 9.93;   /* MEASURED §6V.2 over four spans */

export interface RuleRpc { call(method: string, params: unknown[]): Promise<unknown> }
interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }

export const addrTopic = (t: string): string => `0x${t.slice(26)}`.toLowerCase();
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;

/** Everything the four rules read, all from blocks 0..ENTRY_BLOCKS. NOTHING later. */
export interface EntryState {
  creatorShare: number;
  sold90: number;
  nSells: number;
  ethInTotal: number;
  poolEth: number;
}

/**
 * ONE sweep over the swap log yields every field the four rules need.
 *
 * `toBlock` is a parameter rather than always `initBlock + ENTRY_BLOCKS` so a live
 * caller can evaluate a launch at the block it has actually reached. A caller passing
 * a lower bound gets a partial state and must say so — it is not this function's place
 * to pretend a launch is older than it is.
 */
export async function readEntryState(
  rpc: RuleRpc, poolId: string, initBlock: number, toBlock?: number,
): Promise<EntryState> {
  const hi = toBlock ?? initBlock + ENTRY_BLOCKS;
  const sw = (await rpc.call('eth_getLogs', [{
    address: POOL_MANAGER, topics: [
      '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', poolId],
    fromBlock: `0x${initBlock.toString(16)}`, toBlock: `0x${hi.toString(16)}`,
  }])) as Log[];
  let creatorShare = 0; let sold90 = 0; let nSells = 0;
  let ethInTotal = 0; let poolEth = 0;
  for (const x of sw) {
    const z = x.data.slice(2);
    const a0 = sgn(BigInt(`0x${z.slice(0, 64)}`));
    const a1 = sgn(BigInt(`0x${z.slice(64, 128)}`));
    const off = Number(BigInt(x.blockNumber)) - initBlock;
    poolEth += Number(-a0) / 1e18;
    if (a1 > 0n) {
      /* The creator's seed buy is in the creation transaction, hence offset 0. */
      if (off === 0) creatorShare += Number(a1) / SUPPLY;
      ethInTotal += Number(-a0) / 1e18;
    } else if (a1 < 0n) {
      nSells += 1;
      if (off <= 900) sold90 += Number(-a1) / SUPPLY;
    }
  }
  return { creatorShare, sold90, nSells, ethInTotal, poolEth };
}

export type RollingCuts = Record<'a' | 'b', number | null>;

/**
 * 25th percentile of `eth_in_total` over GATED launches strictly earlier than
 * `initBlock`, within each trailing window. Null below `minN` — the rule then DOES NOT
 * FIRE, which is reported rather than replaced by a constant (§7: an error path must
 * not emit a plausible default).
 *
 * Drawn from BOTH priced histories: `bot_p13` alone starts at block 67,512,037, so a
 * 72-hour window at the current head would silently be a one-day window.
 */
export async function rollingCuts(
  c: PoolClient, chain: string, initBlock: number,
): Promise<RollingCuts> {
  const out: Record<string, number | null> = {};
  for (const r of ROLL) {
    const span = Math.round(r.hours * 3600 * BLOCKS_PER_SEC);
    const q = await c.query<{ n: string; p: string | null }>(
      `with h as (
         select init_block, eth_in_total from bot_p13
          where chain = $1 and gate1 and gate2
         union all
         select init_block, eth_in_total from bot_ungated_price
          where chain = $1 and creator_share >= $4::numeric and sold_90 < $5::numeric
       )
       select count(*)::text n,
              percentile_cont(0.25) within group (order by eth_in_total)::text p
         from h where init_block < $2 and init_block >= $3`,
      [chain, initBlock, initBlock - span, GATE1_SHARE.toString(), GATE2_SOLD.toString()]);
    const row = q.rows[0];
    const n = row === undefined ? 0 : Number(row.n);
    out[r.key] = n >= r.minN && row?.p != null ? Number(row.p) : null;
  }
  return out as RollingCuts;
}

export interface RuleVerdict {
  gate1: boolean; gate2: boolean; liqOk: boolean;
  p11: boolean; p14a: boolean; p14b: boolean; p15: boolean;
  /** True when ANY of the four fires. The executor's entry condition. */
  any: boolean;
  /** Which fired, for a log line and a stored row. */
  which: string;
}

/** THE DECISION. Pure, so it can be unit-driven and cannot reach a network. */
export function scoreRules(s: EntryState, cuts: RollingCuts): RuleVerdict {
  const gate1 = s.creatorShare >= GATE1_SHARE;
  const gate2 = s.sold90 < GATE2_SOLD;
  const liqOk = s.poolEth > 0;
  const zeroSells = s.nSells === 0;
  const p11 = gate1 && gate2 && liqOk && zeroSells && s.ethInTotal <= P11_ETH;
  const p14a = gate1 && gate2 && liqOk && zeroSells
    && cuts.a !== null && s.ethInTotal <= cuts.a;
  const p14b = gate1 && gate2 && liqOk && zeroSells
    && cuts.b !== null && s.ethInTotal <= cuts.b;
  const p15 = gate1 && gate2 && s.nSells <= P15_MAX_SELLS
    && s.poolEth >= P15_FLOOR_ETH && s.poolEth <= P15_CEIL_ETH;
  const which = [p11 && 'P11', p14a && 'P14a', p14b && 'P14b', p15 && 'P15']
    .filter(Boolean).join(',');
  return { gate1, gate2, liqOk, p11, p14a, p14b, p15,
    any: p11 || p14a || p14b || p15, which };
}

export interface CanonicalLaunch {
  poolId: string; initBlock: number; token: string;
  pool: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string };
  zeroIsPricing: boolean;
}

/**
 * Canonical Pools.trade launches in a block range: an `Initialize` whose transaction
 * ALSO emitted `TokenCreated`. §6D established that matching on "the token came from
 * Pools.trade" instead admits ~433 secondary pools a day at a 37.3% withdrawal rate.
 */
export async function findCanonicalLaunches(
  rpc: RuleRpc, from: number, to: number,
  decode: (data: string) => [bigint, bigint, string, bigint, bigint],
): Promise<CanonicalLaunch[]> {
  const created = (await rpc.call('eth_getLogs', [{
    address: PT_FACTORY, topics: [TOKEN_CREATED],
    fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
  }])) as Log[];
  if (created.length === 0) return [];
  const txs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
  const inits = (await rpc.call('eth_getLogs', [{
    address: POOL_MANAGER, topics: [
      '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438'],
    fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
  }])) as Log[];
  const out: CanonicalLaunch[] = [];
  for (const l of inits) {
    if (!txs.has(l.transactionHash.toLowerCase())) continue;
    const c0 = addrTopic(l.topics[2] ?? '');
    const c1 = addrTopic(l.topics[3] ?? '');
    /* Exactly one side must be a pricing asset. */
    if (PRICING.includes(c0) === PRICING.includes(c1)) continue;
    const d = decode(l.data);
    const zeroIsPricing = PRICING.includes(c0);
    out.push({
      poolId: (l.topics[1] ?? '').toLowerCase(),
      initBlock: Number(BigInt(l.blockNumber)),
      token: zeroIsPricing ? c1 : c0,
      pool: { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() },
      zeroIsPricing,
    });
  }
  return out.sort((a, b) => a.initBlock - b.initBlock);
}
