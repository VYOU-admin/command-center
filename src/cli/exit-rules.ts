/**
 * `npm run exit-rules` — 4D-2: PRICE-TRIGGERED EXITS, AGAINST THE BEST FIXED HORIZON.
 *
 * §6G ruled out every FIXED entry/exit pair: all thirty cells have a negative mean and
 * a negative sum. It explicitly did not rule out a **path-dependent** exit, because a
 * fixed horizon forces a position to be held through the collapse while a take-profit
 * or trailing stop does not. This measures those.
 *
 * ===========================================================================
 * THE PATH IS OUR OWN REALISABLE PROCEEDS, NOT THE POOL PRICE
 * ===========================================================================
 *
 * The obvious cheap path is `slot0`'s `sqrtPriceX96` — one call per sample point instead
 * of five. **It is not used, and the reason is a sign convention I would otherwise have
 * had to get right by reasoning.** For a Pools.trade pool `currency0` is native ETH and
 * `currency1` is the token, so v4's `price = token1/token0` is *tokens per ETH*, which
 * moves **inversely** to the value of a token position. §6F.4's price-path table is
 * quoted in that convention and a trigger built on it would fire on exactly the wrong
 * side. (§6F.4's conclusion — that the path is flat — survives either sign, because a
 * flat line is flat inverted. A TRIGGER does not survive it.)
 *
 * So each sample point is a **full simulated sell with a REACHABLE bound**: the same
 * measurement §6E.1 established, five calls instead of one. It removes the sign risk
 * entirely, it is the quantity the rules should act on, and it is something a live bot
 * can genuinely observe — `checkSellable` already does exactly this call.
 *
 * ===========================================================================
 * ONE PAID PASS, THEN UNLIMITED FREE RULE EVALUATION
 * ===========================================================================
 *
 * The path is stored per (pool, offset). Every rule below is then evaluated in SQL-free
 * JavaScript over stored rows, so adding or re-tuning a rule costs **nothing**. That is
 * deliberate: §6G's re-run cost ~800,000 CU to add two columns, and the lesson was to
 * separate the paid measurement from the reporting.
 *
 * **THE TRIGGER GRANULARITY IS THE GRID, AND THAT IS A STATED LIMIT.** A rule fires at
 * the first sampled point where its condition holds, not at the first block. The grid is
 * dense early (1 s, 3 s, 5 s, 10 s, 15 s) where §6G shows the action is, and coarse
 * later. A real tick-by-tick walk would fire slightly earlier and so would be slightly
 * kinder to the trailing stops; this is therefore a **conservative** approximation for
 * every rule that exits on a fall, and an **optimistic** one for take-profits, which
 * would in reality trigger between two points at a price no worse than the later one.
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
const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
const TOKEN_CREATED = '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const CU_CEILING = 1_200_000;

const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const BLOCKS_PER_DAY = 864_000;
/** §6G: entry offset is flat within noise, so the earliest reachable one is used. */
const ENTRY = 1;
/** Dense where §6G shows the action, coarse after. Blocks at 10/second. */
/**
 * **THE FIRST GRID UNDER-TESTED THE STOP LOSSES AND THE OUTPUT SAID SO.**
 * `TP +50% SL -20%` and `TP +50% SL -30%` returned IDENTICAL sums (-22.51) with a p25
 * of -82.4%. A -20% stop that exits at -82% has not been tested; it has been sampled
 * too coarsely. Between 150 s and 300 s the old grid had a 150-second hole, and §6G
 * shows the collapse happening across exactly that span (median -0.4% at 90 s, -11.3%
 * at 5 m, -60.9% at 15 m). A position falling from -10% to -82% inside one hole gets
 * filled at -82%.
 *
 * **That biases the measurement against the one rule class that could plausibly flip
 * the sign**, which is the class the whole 4D-2 question turns on. The points below
 * roughly double the resolution from 20 s to 12 m. Only the new points are paid for —
 * the stored path makes that cheap, which is what the store is for.
 */
const GRID = [0, 10, 30, 50, 100, 150, 200, 300, 400, 600, 750, 900, 1_200, 1_500,
  2_000, 2_500, 3_000, 3_750, 4_500, 5_250, 6_000, 7_500, 9_000, 12_000, 18_000];
const CAP_BLOCKS = 9_000;   /* the 15-minute hard cap the brief asks for */
const PER_GROUP = 200;
const SIZE_WEI = 562_000_000_000_000n;   /* ~$1 */

/** MEASURED absolute round-trip gas, §6E.2. A FIXED cost, not a percentage. */
const GAS_USD = 0.193;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const addrTopic = (t: string): string => `0x${t.slice(26)}`.toLowerCase();
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? '  n/a' : `${(100 * x).toFixed(1)}%`;

async function sweep(
  rpc: ReadOnlyRpc, f: Record<string, unknown>, from: number, to: number, span0: number,
): Promise<Log[]> {
  const out: Log[] = []; let cur = from; let span = span0;
  while (cur <= to) {
    const end = Math.min(cur + span - 1, to);
    try {
      const got = (await rpc.call('eth_getLogs', [{
        ...f, fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Log[];
      out.push(...got); cur = end + 1;
      if (got.length < 3_000) span = Math.min(Math.floor(span * 1.5), span0 * 8);
    } catch (err) {
      if (!/exceed|limit|response size/i.test((err as Error).message)) throw err;
      span = Math.max(Math.floor(span / 4), 2_000);
    }
  }
  return out;
}

/* ======================================================================
 * THE RULES. Each walks a path and returns the return it would realise.
 * ====================================================================== */
interface Point { off: number; ret: number | null }   /* null = could not be sold */

/**
 * **A POSITION THAT CANNOT BE SOLD AT ITS EXIT POINT IS −100%.** Not skipped, and not
 * carried to the next point — a rule that said "sell here" and could not is a total
 * loss, which is the whole finding §6A rests on.
 */
function walk(
  path: Point[], rule: { tp?: number; sl?: number; trail?: number; cap: number; fixed?: number },
): number | null {
  const pts = path.filter((p) => p.off <= rule.cap).sort((a, b) => a.off - b.off);
  if (pts.length === 0) return null;
  if (rule.fixed !== undefined) {
    const at = pts.filter((p) => p.off <= rule.fixed!).pop();
    if (at === undefined) return null;
    return at.ret === null ? -1 : at.ret;
  }
  let peak = -Infinity;
  for (const p of pts) {
    if (p.off === 0) { peak = p.ret ?? -1; continue; }
    /* An unsellable point ends the position at -100%: we tried to leave and could not. */
    if (p.ret === null) return -1;
    if (p.ret > peak) peak = p.ret;
    if (rule.tp !== undefined && p.ret >= rule.tp) return p.ret;
    if (rule.sl !== undefined && p.ret <= -rule.sl) return p.ret;
    if (rule.trail !== undefined && peak > 0) {
      /* Give-back measured on the VALUE, not on the return: a peak of +100% falling
       * 20% of its value is +60%, which is what a trailing stop actually does. */
      const peakVal = 1 + peak;
      if (1 + p.ret <= peakVal * (1 - rule.trail)) return p.ret;
    }
  }
  const last = pts[pts.length - 1]!;
  return last.ret === null ? -1 : last.ret;
}

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
    await c.query(`create table if not exists bot_exit_path (
      chain text not null, pool_id text not null, entry_offset integer not null,
      grid_offset integer not null, eth_in numeric not null, eth_out numeric,
      sell_executes boolean, measured_at timestamptz not null default now(),
      primary key (chain, pool_id, entry_offset, grid_offset)
    )`);

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    /* PINNED by default to §6G's window so the two are the same population. */
    const to = Number(process.env['PATH_TO_BLOCK'] ?? String(head - (BLOCKS_PER_DAY + 10_000)));
    const from = to - 3 * BLOCKS_PER_DAY;

    const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
      from, to, 2_000_000);
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
    const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      from, to, 40_000);
    const ptAll = inits.filter((l) =>
      ptTxs.has(l.transactionHash.toLowerCase())
      && PRICING.includes(addrTopic(l.topics[2] ?? '')) !== PRICING.includes(addrTopic(l.topics[3] ?? '')));
    const ordered = [...ptAll].sort((a, b) =>
      Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)));
    const st = Math.max(1, Math.floor(ordered.length / PER_GROUP));
    const pick = ordered.filter((_, i) => i % st === 0).slice(0, PER_GROUP);

    const have = new Set((await c.query<{ k: string }>(
      `select pool_id||'|'||grid_offset as k from bot_exit_path
        where chain = $1 and entry_offset = $2`, [CHAIN, ENTRY])).rows.map((r) => r.k));

    log.info('4D-2  BEFORE THE FIRST PAID CALL', {
      window: `${from}..${to}`,
      window_pinned: process.env['PATH_TO_BLOCK'] !== undefined,
      canonical_pools_trade: ptAll.length,
      sampled: pick.length,
      entry_offset: ENTRY,
      grid_points: GRID.length,
      grid_seconds: GRID.map((g) => g / 10),
      hard_cap: `${CAP_BLOCKS} blocks = ${CAP_BLOCKS / 10}s`,
      path_is: 'our own simulated sell with a REACHABLE bound at each point — NOT the '
        + 'pool price, which is quoted tokens-per-ETH and would invert every trigger',
      already_stored: have.size,
      estimate_cu: pick.length * (1 + GRID.length * 5) * 26,
      ceiling_cu: CU_CEILING,
    });

    let n = 0;
    for (const l of pick) {
      const pid = (l.topics[1] ?? '').toLowerCase();
      const c0 = addrTopic(l.topics[2] ?? '');
      const c1 = addrTopic(l.topics[3] ?? '');
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) continue;
      const zeroIsPricing = PRICING.includes(c0);
      const token = zeroIsPricing ? c1 : c0;
      const entry = Number(BigInt(l.blockNumber)) + ENTRY;

      if (GRID.every((g) => have.has(`${pid}|${g}`))) { n += 1; continue; }

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
          `insert into bot_exit_path (chain, pool_id, entry_offset, grid_offset,
             eth_in, eth_out, sell_executes)
           values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7)
           on conflict do nothing`,
          [CHAIN, pid, ENTRY, g, SIZE_WEI.toString(),
            ethOut === null ? null : ethOut.toString(), executes]);
      }
      n += 1;
      if (n % 20 === 0) log.info('progress', { pools: n, of: pick.length });
    }

    /* ---- FREE RULE EVALUATION OVER THE STORED PATHS ---------------------- */
    const rows = (await c.query<{
      pool_id: string; grid_offset: number; eth_in: string; eth_out: string | null;
      sell_executes: boolean | null;
    }>(`select pool_id, grid_offset, eth_in::text, eth_out::text, sell_executes
          from bot_exit_path where chain = $1 and entry_offset = $2`,
    [CHAIN, ENTRY])).rows;

    const paths = new Map<string, Point[]>();
    for (const r of rows) {
      if (!paths.has(r.pool_id)) paths.set(r.pool_id, []);
      paths.get(r.pool_id)!.push({
        off: r.grid_offset,
        ret: r.sell_executes === true && r.eth_out !== null
          ? Number(BigInt(r.eth_out) - BigInt(r.eth_in)) / Number(BigInt(r.eth_in))
          : r.sell_executes === false ? null : null,
      });
    }
    /* A path missing its own points cannot be walked; counted, not silently dropped. */
    const complete = [...paths.entries()].filter(([, p]) => p.length >= GRID.length);
    const partial = paths.size - complete.length;

    const RULES: Array<[string, Parameters<typeof walk>[1]]> = [
      ['BASELINE fixed 30s (best of §6G)', { fixed: 300, cap: 300 }],
      ['BASELINE fixed 15m cap', { cap: CAP_BLOCKS }],
      ['TP +25%            cap 15m', { tp: 0.25, cap: CAP_BLOCKS }],
      ['TP +50%            cap 15m', { tp: 0.50, cap: CAP_BLOCKS }],
      ['TP +100%           cap 15m', { tp: 1.00, cap: CAP_BLOCKS }],
      ['TP +200%           cap 15m', { tp: 2.00, cap: CAP_BLOCKS }],
      ['TP +25%  SL -20%   cap 15m', { tp: 0.25, sl: 0.20, cap: CAP_BLOCKS }],
      ['TP +50%  SL -20%   cap 15m', { tp: 0.50, sl: 0.20, cap: CAP_BLOCKS }],
      ['TP +50%  SL -30%   cap 15m', { tp: 0.50, sl: 0.30, cap: CAP_BLOCKS }],
      ['TP +50%  SL -50%   cap 15m', { tp: 0.50, sl: 0.50, cap: CAP_BLOCKS }],
      ['TP +100% SL -20%   cap 15m', { tp: 1.00, sl: 0.20, cap: CAP_BLOCKS }],
      ['TP +100% SL -30%   cap 15m', { tp: 1.00, sl: 0.30, cap: CAP_BLOCKS }],
      ['TP +200% SL -30%   cap 15m', { tp: 2.00, sl: 0.30, cap: CAP_BLOCKS }],
      ['TRAIL 10%          cap 15m', { trail: 0.10, cap: CAP_BLOCKS }],
      ['TRAIL 20%          cap 15m', { trail: 0.20, cap: CAP_BLOCKS }],
      ['TRAIL 30%          cap 15m', { trail: 0.30, cap: CAP_BLOCKS }],
      ['TRAIL 20% SL -30%  cap 15m', { trail: 0.20, sl: 0.30, cap: CAP_BLOCKS }],
      ['TRAIL 20%          cap 5m', { trail: 0.20, cap: 3_000 }],
      ['TP +50%  SL -20%   cap 5m', { tp: 0.50, sl: 0.20, cap: 3_000 }],
      ['TRAIL 10%          cap 90s', { trail: 0.10, cap: 900 }],
    ];

    const out: string[] = [];
    out.push('rule                              n     p10     p25  median     p75     p90'
      + '    mean     SUM  win%   SUM@$10  SUM@$100');
    for (const [name, rule] of RULES) {
      const rs = complete.map(([, p]) => walk(p, rule)).filter((x): x is number => x !== null);
      if (rs.length === 0) { out.push(`${name.padEnd(32)} RETURNED NO ROWS`); continue; }
      const sum = rs.reduce((a, b) => a + b, 0);
      const mean = sum / rs.length;
      const wins = rs.filter((x) => x > 0).length;
      /* Gas is ABSOLUTE (§6E.2). At $10 it is 1.93% of each position, at $100 0.193%. */
      const sum10 = sum - rs.length * (GAS_USD / 10);
      const sum100 = sum - rs.length * (GAS_USD / 100);
      out.push(`${name.padEnd(32)} ${String(rs.length).padStart(4)} `
        + `${pc(quant(rs, 0.10)).padStart(7)} ${pc(quant(rs, 0.25)).padStart(7)} `
        + `${pc(quant(rs, 0.50)).padStart(7)} ${pc(quant(rs, 0.75)).padStart(7)} `
        + `${pc(quant(rs, 0.90)).padStart(7)} ${pc(mean).padStart(7)} `
        + `${sum.toFixed(2).padStart(7)} ${(100 * wins / rs.length).toFixed(0).padStart(4)}% `
        + `${sum10.toFixed(2).padStart(9)} ${sum100.toFixed(2).padStart(9)}`);
    }

    log.info('*** 4D-2  PRICE-TRIGGERED EXITS vs THE BEST FIXED HORIZON ***', {
      positions_with_a_complete_path: complete.length,
      paths_incomplete_EXCLUDED: partial,
      entry_offset: ENTRY,
      note: 'the 0.50% round trip is already inside every figure — both legs go through '
        + 'the pool. SUM@$10 and SUM@$100 additionally subtract the MEASURED absolute '
        + `gas of $${GAS_USD} per round trip at those position sizes.`,
      judged_on: 'the SUM. A tail strategy is not judged on its median.',
      table: out,
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('exit-rules failed', errorFields(e)); process.exit(1); });
