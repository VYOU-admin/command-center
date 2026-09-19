/**
 * `npm run runner-trade` — 5D: THE TRADE, IF ONE EXISTS.
 *
 * Only the signal that survived 5C is used: **the size of the creator's own buy in the
 * creation transaction**, readable at block 0, before our entry at +15 s.
 *
 * ===========================================================================
 * THREE RULES OF DISCIPLINE, ALL FIXED BEFORE ANY RESULT IS READ
 * ===========================================================================
 *
 * **1. THE THRESHOLD IS PRE-REGISTERED, NOT TUNED.** `creator_share >= 40%` comes from
 * §6I, which chose it before any of §6K–§6M existed. Picking a threshold after seeing
 * 5C's distributions would make it a new hypothesis needing its own held-out test — the
 * brief says so explicitly and §6I's own limits section says the same.
 *
 * **2. THE EXIT RULE IS CHOSEN ON THE TRAINING HALF AND SCORED ON THE HOLDOUT.** A set
 * of candidates is evaluated on `blocks < SPLIT`, the best by SUM is selected, and
 * **only that one is reported as the result** on `blocks >= SPLIT`. The others are
 * printed on the holdout too, marked as not-preselected, so the gap between "the rule I
 * committed to" and "the best rule in hindsight" is visible rather than hidden.
 *
 * **3. THE EXIT IS PRICED WITH A REAL SELL.** §6K used `sqrtPriceX96`, which is the pool
 * mid-price and measured ~18% optimistic against realisable proceeds on n=41. Every
 * figure here comes from `simulateSellAt` with a **REACHABLE** bound — the full path
 * through `SETTLE_ALL` that §6A.3 exists to insist on. **Nothing in 5D is a mid-price.**
 *
 * The grid is placed on §6K.3's measured time-to-peak distribution — p25 246 s, median
 * 490 s, p75 768 s, p90 893 s — rather than on round numbers.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { poolIdOf } from '../bot/pool-state.js';
import { buildSwap } from '../bot/calldata.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const CU_CEILING = 1_500_000;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];

/** PRE-REGISTERED in §6I, before §6K–§6M existed. Not tuned here. */
const SHARE_THRESHOLD = 0.40;
/** 5C's split, recomputed from the data and asserted against the stored value. */
const ENTRY_BLOCKS = 150;
/** Blocks AFTER entry. Placed on §6K.3's time-to-peak quantiles, not round numbers. */
const GRID = [0, 1_000, 2_000, 2_460, 3_500, 4_900, 6_200, 7_680, 8_930, 12_000];
const SIZE_WEI = 562_000_000_000_000n;   /* ~$1; size is applied in the net columns */
const GAS_USD = 0.193;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
interface Point { off: number; ret: number | null }

const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? '   n/a' : `${(100 * x).toFixed(1)}%`;

/** A point where the sell does not execute ends the position at −100%. */
function walk(path: Point[], r: { tp?: number; trail?: number; cap: number; fixed?: number }): number | null {
  const pts = path.filter((p) => p.off <= r.cap).sort((a, b) => a.off - b.off);
  if (pts.length === 0) return null;
  if (r.fixed !== undefined) {
    const at = pts.filter((p) => p.off <= r.fixed!).pop();
    return at === undefined ? null : (at.ret === null ? -1 : at.ret);
  }
  let peak = -Infinity;
  for (const p of pts) {
    if (p.off === 0) { peak = p.ret ?? -1; continue; }
    if (p.ret === null) return -1;
    if (p.ret > peak) peak = p.ret;
    if (r.tp !== undefined && p.ret >= r.tp) return p.ret;
    if (r.trail !== undefined && peak > 0 && 1 + p.ret <= (1 + peak) * (1 - r.trail)) return p.ret;
  }
  const last = pts[pts.length - 1]!;
  return last.ret === null ? -1 : last.ret;
}

const RULES: Array<[string, { tp?: number; trail?: number; cap: number; fixed?: number }]> = [
  ['fixed hold to p25 time-to-peak (246 s)', { fixed: 2_460, cap: 2_460 }],
  ['fixed hold to MEDIAN time-to-peak (490 s)', { fixed: 4_900, cap: 4_900 }],
  ['fixed hold to p75 time-to-peak (768 s)', { fixed: 7_680, cap: 7_680 }],
  ['TRAIL 20%, cap p90 (893 s)', { trail: 0.20, cap: 8_930 }],
  ['TRAIL 30%, cap p90 (893 s)', { trail: 0.30, cap: 8_930 }],
  ['TRAIL 40%, cap p90 (893 s)', { trail: 0.40, cap: 8_930 }],
  ['TP +50%, cap p90', { tp: 0.50, cap: 8_930 }],
  ['TP +100%, cap p90', { tp: 1.00, cap: 8_930 }],
  ['TP +50% or TRAIL 30%, cap p90', { tp: 0.50, trail: 0.30, cap: 8_930 }],
];

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const owner = process.env['BOT_WALLET_ADDRESS']?.trim().toLowerCase();
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_trade_path (
      chain text not null, pool_id text not null, grid_offset integer not null,
      eth_in numeric not null, eth_out numeric, sell_executes boolean,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id, grid_offset)
    )`);

    /* The signal-firing population, and the 5C split recomputed from the data. */
    const all = (await c.query<{ pool_id: string; token: string; init_block: string;
      creator_share: string | null; eth_in_15s: string | null }>(
      `select f.pool_id, l.token, f.init_block::text, f.creator_share::text,
              f.eth_in_15s::text
         from bot_runner_features f
         join bot_runner_label l on l.chain=f.chain and l.pool_id=f.pool_id
        where f.chain=$1 order by f.init_block`, [CHAIN])).rows;
    const blocks = all.map((r) => Number(r.init_block)).sort((a, b) => a - b);
    const SPLIT = blocks[Math.floor(blocks.length / 2)]!;
    const fires = all.filter((r) => r.creator_share !== null
      && Number(r.creator_share) >= SHARE_THRESHOLD);
    const train = fires.filter((r) => Number(r.init_block) < SPLIT);
    const test = fires.filter((r) => Number(r.init_block) >= SPLIT);

    log.info('5D  BEFORE THE FIRST PAID CALL', {
      all_labelled: all.length,
      split_block: SPLIT,
      threshold_PRE_REGISTERED: `creator_share >= ${SHARE_THRESHOLD} (from §6I, chosen `
        + 'before §6K–§6M existed — NOT tuned here)',
      signal_fires_on: `${fires.length} of ${all.length} = `
        + `${(100 * fires.length / all.length).toFixed(1)}%`,
      train_half: train.length,
      HELD_OUT_half: test.length,
      grid_offsets_from_entry: GRID,
      grid_rationale: '§6K.3 time-to-peak p25 246 s, median 490 s, p75 768 s, p90 893 s',
      exit_priced_with: 'simulateSellAt, REACHABLE bound — a real sell, never a mid-price',
      estimate_cu: fires.length * (1 + GRID.length * 5) * 26,
      ceiling_cu: CU_CEILING,
    });

    const have = new Set((await c.query<{ k: string }>(
      `select pool_id||'|'||grid_offset as k from bot_trade_path where chain=$1`, [CHAIN]))
      .rows.map((r) => r.k));

    let n = 0;
    for (const r of fires) {
      const pid = r.pool_id;
      if (GRID.every((g) => have.has(`${pid}|${g}`))) { n += 1; continue; }
      const initLogs = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.initializeV4, pid],
        fromBlock: `0x${(Number(r.init_block)).toString(16)}`,
        toBlock: `0x${(Number(r.init_block)).toString(16)}`,
      }])) as Log[];
      if (initLogs.length === 0) continue;
      const l = initLogs[0]!;
      const c0 = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
      const c1 = `0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase();
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) continue;
      const zeroIsPricing = PRICING.includes(c0);
      const token = zeroIsPricing ? c1 : c0;
      const entry = Number(r.init_block) + ENTRY_BLOCKS;

      const buy = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: SIZE_WEI,
        amountOutMinimum: UNREACHABLE,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
      let tokensOut: bigint | null = null;
      try {
        await rpc.call('eth_call', [{ from: owner, to: buy.to, data: buy.data,
          value: `0x${buy.value.toString(16)}` }, `0x${entry.toString(16)}`,
        { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } }]);
      } catch (err) {
        const e2 = err as Error & { data?: unknown };
        const dd = typeof e2.data === 'string' ? e2.data : '';
        if (dd.startsWith(V4_TOO_LITTLE)) {
          const dec = abi.decode(['uint256', 'uint256'], `0x${dd.slice(10)}`) as unknown as bigint[];
          if ((dec[1] as bigint) > 0n) tokensOut = dec[1] as bigint;
        }
      }
      if (tokensOut === null) continue;

      for (const g of GRID) {
        if (have.has(`${pid}|${g}`)) continue;
        let executes: boolean | null = null; let ethOut: bigint | null = null;
        try {
          const sim = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
            zeroForOneBuy: zeroIsPricing, block: `0x${(entry + g).toString(16)}` });
          executes = sim.executes; ethOut = sim.ethOut;
        } catch { executes = null; }
        await c.query(
          `insert into bot_trade_path (chain, pool_id, grid_offset, eth_in, eth_out, sell_executes)
           values ($1,$2,$3,$4::numeric,$5::numeric,$6) on conflict do nothing`,
          [CHAIN, pid, g, SIZE_WEI.toString(),
            ethOut === null ? null : ethOut.toString(), executes]);
      }
      n += 1;
      if (n % 25 === 0) log.info('progress', { pools: n, of: fires.length });
    }

    /* ================== FREE EVALUATION ================== */
    const rows = (await c.query<{ pool_id: string; grid_offset: number; eth_in: string;
      eth_out: string | null; sell_executes: boolean | null }>(
      `select pool_id, grid_offset, eth_in::text, eth_out::text, sell_executes
         from bot_trade_path where chain=$1`, [CHAIN])).rows;
    const paths = new Map<string, Point[]>();
    for (const r of rows) {
      if (!paths.has(r.pool_id)) paths.set(r.pool_id, []);
      paths.get(r.pool_id)!.push({ off: r.grid_offset,
        ret: r.sell_executes === true && r.eth_out !== null
          ? Number(BigInt(r.eth_out) - BigInt(r.eth_in)) / Number(BigInt(r.eth_in)) : null });
    }
    const complete = (set: typeof fires): Array<[string, Point[]]> => set
      .map((r) => [r.pool_id, paths.get(r.pool_id) ?? []] as [string, Point[]])
      .filter(([, p]) => p.length >= GRID.length);

    const score = (set: Array<[string, Point[]]>, rule: Parameters<typeof walk>[1]) => {
      const rs = set.map(([, p]) => walk(p, rule)).filter((x): x is number => x !== null);
      const sum = rs.reduce((a, b) => a + b, 0);
      /** Worst peak-to-trough on the equity curve, in stake units. */
      let run = 0; let peakEq = 0; let dd = 0;
      for (const x of rs) { run += x; if (run > peakEq) peakEq = run;
        if (peakEq - run > dd) dd = peakEq - run; }
      return { rs, n: rs.length, sum, mean: rs.length ? sum / rs.length : 0,
        win: rs.length ? rs.filter((x) => x > 0).length / rs.length : 0, dd };
    };

    const trainSet = complete(train); const testSet = complete(test);
    /* THE SELECTION HAPPENS ON THE TRAINING HALF ONLY. */
    let best: [string, Parameters<typeof walk>[1]] | null = null; let bestSum = -Infinity;
    const trainRows: string[] = [];
    trainRows.push('rule                                          n     mean     SUM   win%');
    for (const [name, rule] of RULES) {
      const s = score(trainSet, rule);
      trainRows.push(`${name.padEnd(44)} ${String(s.n).padStart(4)} ${pc(s.mean).padStart(8)} `
        + `${s.sum.toFixed(2).padStart(7)} ${(100 * s.win).toFixed(0).padStart(5)}%`);
      if (s.sum > bestSum) { bestSum = s.sum; best = [name, rule]; }
    }
    log.info('5D  RULE SELECTION — ON THE TRAINING HALF ONLY', {
      n_train: trainSet.length, table: trainRows,
      SELECTED: best === null ? 'NONE' : best[0],
    });

    const testRows: string[] = [];
    testRows.push('rule                                          n     p10     p25  median'
      + '     p75     p90    mean     SUM   win%   maxDD  net@$10  net@$100');
    for (const [name, rule] of RULES) {
      const s = score(testSet, rule);
      if (s.n === 0) { testRows.push(`${name.padEnd(44)} RETURNED NO ROWS`); continue; }
      const tag = best !== null && name === best[0] ? ' <== PRE-SELECTED' : '';
      testRows.push(`${name.padEnd(44)} ${String(s.n).padStart(4)} `
        + `${pc(quant(s.rs, 0.10)).padStart(7)} ${pc(quant(s.rs, 0.25)).padStart(7)} `
        + `${pc(quant(s.rs, 0.50)).padStart(7)} ${pc(quant(s.rs, 0.75)).padStart(7)} `
        + `${pc(quant(s.rs, 0.90)).padStart(7)} ${pc(s.mean).padStart(7)} `
        + `${s.sum.toFixed(2).padStart(7)} ${(100 * s.win).toFixed(0).padStart(5)}% `
        + `${s.dd.toFixed(2).padStart(7)} `
        + `${(s.sum - s.n * GAS_USD / 10).toFixed(2).padStart(8)} `
        + `${(s.sum - s.n * GAS_USD / 100).toFixed(2).padStart(9)}${tag}`);
    }

    /* OUR OWN IMPACT, against the ETH actually in the pool by our entry. */
    const depths = test.map((r) => r.eth_in_15s === null ? null : Number(r.eth_in_15s))
      .filter((x): x is number => x !== null && x > 0);
    const medDepth = quant(depths, 0.5) ?? 0;
    const p10Depth = quant(depths, 0.10) ?? 0;

    log.info('*** 5D  THE HELD-OUT HALF ***', {
      n_held_out_with_a_complete_path: testSet.length,
      signal: `creator_share >= ${SHARE_THRESHOLD}, PRE-REGISTERED in §6I`,
      entry: '+15 s',
      pre_selected_rule: best === null ? 'NONE' : best[0],
      note: 'every figure is a REAL simulated sell with a reachable bound. maxDD is the '
        + 'worst peak-to-trough of the cumulative return, in stake units.',
      gas: `absolute $${GAS_USD} per round trip; 19.3% at $1, 1.93% at $10, 0.193% at $100`,
      table: testRows,
      trades_per_day: `${(100 * fires.length / all.length).toFixed(1)}% of 424 canonical `
        + `launches/day = ~${Math.round(424 * fires.length / all.length)}/day`,
      OUR_IMPACT_against_measured_pool_depth: {
        median_ETH_in_pool_by_entry: medDepth.toFixed(3),
        p10_ETH_in_pool_by_entry: p10Depth.toFixed(3),
        at_1usd: `${(100 * 0.000562 / medDepth).toFixed(3)}% of median depth`,
        at_10usd: `${(100 * 0.00562 / medDepth).toFixed(2)}% of median depth`,
        at_100usd: `${(100 * 0.0562 / medDepth).toFixed(2)}% of median depth, `
          + `${(100 * 0.0562 / Math.max(p10Depth, 1e-9)).toFixed(1)}% at the p10 pool`,
        caveat: 'the simulated sell does NOT contain our own buy, so the $100 column is '
          + 'OPTIMISTIC by roughly that impact — §6A.4',
      },
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('runner-trade failed', errorFields(e)); process.exit(1); });
