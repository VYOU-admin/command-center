/**
 * `npm run uncapped-rules` — 4F-1 and 4F-2.
 *
 * ===========================================================================
 * TWO SPENDS, BOTH STATED, BECAUSE THE BRIEF SAYS ZERO NEW RPC UNLESS I SAY WHY
 * ===========================================================================
 *
 * **1. THE STORED PATHS STOP AT 30 MINUTES AND AN UNCAPPED RULE CANNOT BE TESTED ON
 * THEM.** `bot_exit_path`'s grid ends at 18,000 blocks. §6G measured the single best
 * outcome at **+2,672% at 30 m, +1,151% at 1 h, +407% at 2 h, and −0.0% by 6 h** — so
 * the peaks an uncapped trailing stop exists to ride sit **between 30 minutes and two
 * hours**, entirely outside the stored path. Running "uncapped" to the end of a
 * 30-minute path is a 30-minute cap wearing a different name, and the brief is explicit
 * that truncating and calling it a result is not acceptable.
 *
 * So four points are added — 40 m, 60 m, 90 m, 120 m — at **~4 points x 200 pools x 5
 * calls = 104,000 CU ≈ $0.05.** Past two hours nothing needs measuring: §6G's 6 h and
 * 24 h columns have a best outcome of −0.0% and −0.1% across all 200 positions, so
 * **not one position is positive at 6 h.** The extension stops where the evidence says
 * the opportunity already has.
 *
 * **2. CREATOR SHARE WAS NEVER STORED.** §6F.6 measured it on a different sample. One
 * sparse `eth_getLogs` per pool over its own creation block, **200 x 60 CU = 12,000 CU
 * ≈ $0.005.** There is no free route: the quantity is not in any table we hold.
 *
 * Everything else — every rule, every split — is evaluated over stored rows at zero cost.
 *
 * ===========================================================================
 * 4F-2's REFUTATION CONDITION, STATED BEFORE THE MEASUREMENT
 * ===========================================================================
 *
 * **The creator-share split is REFUTED if the low-share and high-share buckets have
 * overlapping outcome distributions** — specifically if the low-share bucket's SUM is
 * not materially better than the high-share bucket's, or if its median is still at or
 * below the round-trip fee. A split that merely identifies a worse subset, leaving the
 * remainder still negative, **is not a strategy and will not be reported as one.**
 */
import { AbiCoder } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { poolIdOf } from '../bot/pool-state.js';
import { buildSwap } from '../bot/calldata.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { id } from 'ethers';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const CU_CEILING = 400_000;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const ENTRY = 1;
const NEW_POINTS = [24_000, 36_000, 54_000, 72_000];   /* 40m, 60m, 90m, 120m */
const SIZE_WEI = 562_000_000_000_000n;
const GAS_USD = 0.193;
const SUPPLY = 10n ** 27n;   /* the fixed 1e9 * 1e18, confirmed on 6 of 6 records */

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? '  n/a' : `${(100 * x).toFixed(1)}%`;

interface Point { off: number; ret: number | null }

/**
 * A WALKER THAT HANDLES PARTIAL EXITS, because a ladder is not a single exit.
 *
 * `ladder` sells a fraction the first time the value reaches each level; whatever
 * remains is governed by `trail` and, if set, `sl`. **A point where the sell does not
 * execute ends the WHOLE remaining position at −100%** — a rule that said "sell here"
 * and could not is a total loss on the part it still held.
 *
 * `cap` is optional. **Absent, the rule runs to the end of the path**, which is what
 * "uncapped" means and is only meaningful because the path was extended to two hours.
 */
function walk(path: Point[], r: {
  tp?: number; sl?: number; trail?: number; cap?: number; fixed?: number;
  ladder?: Array<[number, number]>;   /* [level, fraction] */
}): number | null {
  const pts = path.filter((p) => r.cap === undefined || p.off <= r.cap)
    .sort((a, b) => a.off - b.off);
  if (pts.length === 0) return null;
  if (r.fixed !== undefined) {
    const at = pts.filter((p) => p.off <= r.fixed!).pop();
    return at === undefined ? null : (at.ret === null ? -1 : at.ret);
  }
  let remaining = 1;
  let proceeds = 0;          /* in units of the original stake */
  let peak = -Infinity;
  const done = new Set<number>();
  for (const p of pts) {
    if (p.off === 0) { peak = p.ret ?? -1; continue; }
    if (p.ret === null) return proceeds + remaining * 0 - 1;   /* the rest is lost */
    if (p.ret > peak) peak = p.ret;
    if (r.ladder !== undefined) {
      for (let i = 0; i < r.ladder.length; i += 1) {
        const [lvl, frac] = r.ladder[i]!;
        if (done.has(i) || p.ret < lvl) continue;
        const take = Math.min(frac, remaining);
        proceeds += take * (1 + p.ret);
        remaining -= take;
        done.add(i);
      }
      if (remaining <= 1e-9) return proceeds - 1;
    }
    if (r.tp !== undefined && p.ret >= r.tp) return proceeds + remaining * (1 + p.ret) - 1;
    if (r.sl !== undefined && p.ret <= -r.sl) return proceeds + remaining * (1 + p.ret) - 1;
    if (r.trail !== undefined && peak > 0 && 1 + p.ret <= (1 + peak) * (1 - r.trail)) {
      return proceeds + remaining * (1 + p.ret) - 1;
    }
  }
  const last = pts[pts.length - 1]!;
  return proceeds + remaining * (last.ret === null ? 0 : 1 + last.ret) - 1;
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
    await c.query(`create table if not exists bot_pool_facts (
      chain text not null, pool_id text not null,
      init_block bigint, creator_share numeric, creator_eth numeric,
      launch_buyers integer, measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    const pools = (await c.query<{ pool_id: string }>(
      `select distinct pool_id from bot_exit_path where chain=$1 and entry_offset=$2`,
      [CHAIN, ENTRY])).rows.map((r) => r.pool_id);
    log.info('4F  BEFORE THE FIRST PAID CALL', {
      pools_with_a_stored_path: pools.length,
      stored_path_reaches: '18,000 blocks = 30 minutes',
      extending_by: NEW_POINTS.map((p) => `${p / 600} min`),
      why_extending: 'an uncapped rule cannot be tested on a 30-minute path; §6G puts '
        + 'the best outcomes at 30 m (+2672%), 1 h (+1151%) and 2 h (+407%), and at '
        + '-0.0% by 6 h, so the peaks sit outside the stored path and the opportunity '
        + 'is over before 6 h',
      estimate_cu_path: pools.length * NEW_POINTS.length * 5 * 26,
      estimate_cu_creator: pools.length * 60,
      ceiling_cu: CU_CEILING,
    });

    /* ---- the pool key, recovered from the chain once per pool ------------- */
    const haveFacts = new Set((await c.query<{ pool_id: string }>(
      `select pool_id from bot_pool_facts where chain=$1`, [CHAIN])).rows.map((r) => r.pool_id));
    const havePts = new Set((await c.query<{ k: string }>(
      `select pool_id||'|'||grid_offset as k from bot_exit_path
        where chain=$1 and entry_offset=$2`, [CHAIN, ENTRY])).rows.map((r) => r.k));

    let done = 0;
    for (const pid of pools) {
      const need = NEW_POINTS.filter((p) => !havePts.has(`${pid}|${p}`));
      if (need.length === 0 && haveFacts.has(pid)) { done += 1; continue; }

      const initLogs = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.initializeV4, pid],
        fromBlock: '0x0', toBlock: 'latest',
      }])) as Log[];
      if (initLogs.length === 0) continue;
      const il = initLogs[0]!;
      const c0 = `0x${(il.topics[2] ?? '').slice(26)}`.toLowerCase();
      const c1 = `0x${(il.topics[3] ?? '').slice(26)}`.toLowerCase();
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], il.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) continue;
      const zeroIsPricing = PRICING.includes(c0);
      const token = zeroIsPricing ? c1 : c0;
      const initBlock = Number(BigInt(il.blockNumber));

      /* ---- 4F-2: creator share, from the launch block's own Swap log ------ */
      if (!haveFacts.has(pid)) {
        try {
          const sw = (await rpc.call('eth_getLogs', [{
            address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
            fromBlock: `0x${initBlock.toString(16)}`, toBlock: `0x${initBlock.toString(16)}`,
          }])) as Log[];
          let taken = 0n; let ethIn = 0n;
          const senders = new Set<string>();
          for (const x of sw) {
            const dd = x.data.slice(2);
            const a0 = sgn(BigInt(`0x${dd.slice(0, 64)}`));
            const a1 = sgn(BigInt(`0x${dd.slice(64, 128)}`));
            const tokenAmt = zeroIsPricing ? a1 : a0;
            const ethAmt = zeroIsPricing ? a0 : a1;
            if (tokenAmt > 0n) { taken += tokenAmt; ethIn += -ethAmt; }
            senders.add(`0x${(x.topics[2] ?? '').slice(26)}`.toLowerCase());
          }
          await c.query(
            `insert into bot_pool_facts (chain, pool_id, init_block, creator_share,
               creator_eth, launch_buyers)
             values ($1,$2,$3,$4::numeric,$5::numeric,$6)
             on conflict (chain, pool_id) do nothing`,
            [CHAIN, pid, initBlock, (Number(taken) / Number(SUPPLY)).toString(),
              (Number(ethIn) / 1e18).toString(), senders.size]);
        } catch { /* a pool whose launch block cannot be read is left absent, not zero */ }
      }

      /* ---- 4F-1: extend the path ------------------------------------------ */
      if (need.length > 0) {
        const entry = initBlock + ENTRY;
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
        if (tokensOut !== null) {
          for (const g of need) {
            let executes: boolean | null = null; let ethOut: bigint | null = null;
            try {
              const sim = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
                zeroForOneBuy: zeroIsPricing, block: `0x${(entry + g).toString(16)}` });
              executes = sim.executes; ethOut = sim.ethOut;
            } catch { executes = null; }
            await c.query(
              `insert into bot_exit_path (chain, pool_id, entry_offset, grid_offset,
                 eth_in, eth_out, sell_executes)
               values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7) on conflict do nothing`,
              [CHAIN, pid, ENTRY, g, SIZE_WEI.toString(),
                ethOut === null ? null : ethOut.toString(), executes]);
          }
        }
      }
      done += 1;
      if (done % 25 === 0) log.info('progress', { pools: done, of: pools.length });
    }

    /* ================= FREE EVALUATION OVER STORED ROWS ================== */
    const rows = (await c.query<{
      pool_id: string; grid_offset: number; eth_in: string; eth_out: string | null;
      sell_executes: boolean | null;
    }>(`select pool_id, grid_offset, eth_in::text, eth_out::text, sell_executes
          from bot_exit_path where chain=$1 and entry_offset=$2`, [CHAIN, ENTRY])).rows;
    const paths = new Map<string, Point[]>();
    for (const r of rows) {
      if (!paths.has(r.pool_id)) paths.set(r.pool_id, []);
      paths.get(r.pool_id)!.push({
        off: r.grid_offset,
        ret: r.sell_executes === true && r.eth_out !== null
          ? Number(BigInt(r.eth_out) - BigInt(r.eth_in)) / Number(BigInt(r.eth_in)) : null,
      });
    }
    const maxOff = Math.max(...NEW_POINTS);
    const full = [...paths.entries()].filter(([, p]) => p.some((q) => q.off === maxOff));
    log.info('PATH COVERAGE', {
      pools_with_a_path: paths.size,
      pools_reaching_120_minutes: full.length,
      pools_TRUNCATED_at_30_min_EXCLUDED_from_uncapped_rules: paths.size - full.length,
      note: 'an uncapped rule is evaluated ONLY on paths that reach 120 minutes; a '
        + 'truncated path would silently become a 30-minute cap',
    });

    const RULES: Array<[string, Parameters<typeof walk>[1]]> = [
      ['BASELINE fixed 30s', { fixed: 300 }],
      ['BASELINE TP+200% cap15m (best of §6H)', { tp: 2.0, cap: 9_000 }],
      ['TRAIL 20% UNCAPPED', { trail: 0.20 }],
      ['TRAIL 30% UNCAPPED', { trail: 0.30 }],
      ['TRAIL 50% UNCAPPED', { trail: 0.50 }],
      ['TRAIL 20% + floor SL -30% UNCAPPED', { trail: 0.20, sl: 0.30 }],
      ['TRAIL 30% + floor SL -30% UNCAPPED', { trail: 0.30, sl: 0.30 }],
      ['TRAIL 30% + floor SL -50% UNCAPPED', { trail: 0.30, sl: 0.50 }],
      ['TRAIL 50% + floor SL -50% UNCAPPED', { trail: 0.50, sl: 0.50 }],
      ['half at +100%, trail 30% uncapped', { ladder: [[1.0, 0.5]], trail: 0.30 }],
      ['half at +100%, trail 50% uncapped', { ladder: [[1.0, 0.5]], trail: 0.50 }],
      ['ladder 25@+50/25@+100/25@+200, trail 50% uncapped',
        { ladder: [[0.5, 0.25], [1.0, 0.25], [2.0, 0.25]], trail: 0.50 }],
      ['ladder 25@+50/25@+100/25@+200, trail 30% uncapped',
        { ladder: [[0.5, 0.25], [1.0, 0.25], [2.0, 0.25]], trail: 0.30 }],
      ['HOLD to 120 min, no rule', {}],
    ];

    const report = (label: string, set: Array<[string, Point[]]>): void => {
      const out: string[] = [];
      out.push('rule                                            n     p25  median     p75'
        + '     p90    mean     SUM  win%  SUM-best  SUM@$10  SUM@$100');
      for (const [name, rule] of RULES) {
        const rs = set.map(([, p]) => walk(p, rule)).filter((x): x is number => x !== null);
        if (rs.length === 0) { out.push(`${name.padEnd(46)} RETURNED NO ROWS`); continue; }
        const sum = rs.reduce((a, b) => a + b, 0);
        const best = Math.max(...rs);
        const wins = rs.filter((x) => x > 0).length;
        out.push(`${name.padEnd(46)} ${String(rs.length).padStart(4)} `
          + `${pc(quant(rs, 0.25)).padStart(7)} ${pc(quant(rs, 0.50)).padStart(7)} `
          + `${pc(quant(rs, 0.75)).padStart(7)} ${pc(quant(rs, 0.90)).padStart(7)} `
          + `${pc(sum / rs.length).padStart(7)} ${sum.toFixed(2).padStart(7)} `
          + `${(100 * wins / rs.length).toFixed(0).padStart(4)}% `
          + `${(sum - best).toFixed(2).padStart(9)} `
          + `${(sum - rs.length * GAS_USD / 10).toFixed(2).padStart(8)} `
          + `${(sum - rs.length * GAS_USD / 100).toFixed(2).padStart(9)}`);
      }
      log.info(`*** 4F-1  ${label} ***`, {
        judged_on: 'the SUM. SUM-best is the same sum with the single best position '
          + 'REMOVED — if one trade carries the result, the gap says so.',
        gas: `absolute $${GAS_USD} per round trip; the 0.50% fee is already inside`,
        table: out,
      });
    };
    report('UNCAPPED RULES, paths reaching 120 minutes', full);

    /* ---- 4F-2: the creator-share split ---------------------------------- */
    const facts = new Map((await c.query<{ pool_id: string; creator_share: string | null }>(
      `select pool_id, creator_share::text from bot_pool_facts where chain=$1`, [CHAIN]))
      .rows.map((r) => [r.pool_id, r.creator_share === null ? null : Number(r.creator_share)]));
    const withShare = full.filter(([pid]) => facts.get(pid) != null);
    const shares = withShare.map(([pid]) => facts.get(pid)!);
    log.info('4F-2  CREATOR SHARE, AS MEASURED ON THIS SAMPLE', {
      pools_with_a_path_to_120m: full.length,
      pools_with_a_readable_creator_share: withShare.length,
      share_p25: pc(quant(shares, 0.25)), share_median: pc(quant(shares, 0.50)),
      share_p75: pc(quant(shares, 0.75)),
      share_min: shares.length === 0 ? 'n/a' : pc(Math.min(...shares)),
      share_max: shares.length === 0 ? 'n/a' : pc(Math.max(...shares)),
      REFUTATION_STATED_FIRST: 'the split is refuted if the low-share bucket is not '
        + 'materially better than the high-share one, or if its median is still at or '
        + 'below the round-trip fee. A split that only finds a worse subset, leaving '
        + 'the remainder negative, is NOT a strategy.',
    });

    const BEST: Array<[string, Parameters<typeof walk>[1]]> = [
      ['fixed 30s', { fixed: 300 }],
      ['TRAIL 30% + SL -30% UNCAPPED', { trail: 0.30, sl: 0.30 }],
    ];
    for (const [rname, rule] of BEST) {
      const out: string[] = [];
      out.push('bucket                    n    dead%     p10     p25  median     p75'
        + '     p90    mean     SUM  win%');
      const buckets: Array<[string, (s: number) => boolean]> = [
        ['share < 5%', (s) => s < 0.05],
        ['5% <= share < 10%', (s) => s >= 0.05 && s < 0.10],
        ['10% <= share < 20%', (s) => s >= 0.10 && s < 0.20],
        ['20% <= share < 40%', (s) => s >= 0.20 && s < 0.40],
        ['share >= 40%', (s) => s >= 0.40],
        ['--- thresholds ---', () => false],
        ['share < 10% (sweep)', (s) => s < 0.10],
        ['share < 20% (sweep)', (s) => s < 0.20],
        ['share < 40% (sweep)', (s) => s < 0.40],
      ];
      for (const [bname, pred] of buckets) {
        if (bname.startsWith('---')) { out.push(bname); continue; }
        const set = withShare.filter(([pid]) => pred(facts.get(pid)!));
        const rs = set.map(([, p]) => walk(p, rule)).filter((x): x is number => x !== null);
        if (rs.length === 0) { out.push(`${bname.padEnd(24)} RETURNED NO ROWS`); continue; }
        const sum = rs.reduce((a, b) => a + b, 0);
        const dead = rs.filter((x) => x <= -0.999).length;
        out.push(`${bname.padEnd(24)} ${String(rs.length).padStart(4)} `
          + `${(100 * dead / rs.length).toFixed(0).padStart(6)}% `
          + `${pc(quant(rs, 0.10)).padStart(7)} ${pc(quant(rs, 0.25)).padStart(7)} `
          + `${pc(quant(rs, 0.50)).padStart(7)} ${pc(quant(rs, 0.75)).padStart(7)} `
          + `${pc(quant(rs, 0.90)).padStart(7)} ${pc(sum / rs.length).padStart(7)} `
          + `${sum.toFixed(2).padStart(7)} `
          + `${(100 * rs.filter((x) => x > 0).length / rs.length).toFixed(0).padStart(4)}%`);
      }
      log.info(`*** 4F-2  CREATOR-SHARE SPLIT under ${rname} ***`, {
        launches_per_day_total: 424,
        note: 'multiply a bucket share by 424 for launches/day it fires on',
        table: out,
      });
    }
    /* =================================================================
     * THE HOLDOUT. The high-creator-share bucket came back POSITIVE under a
     * 30-second hold, which is the first positive expectancy in five passes and
     * the exact opposite of the pre-registered hypothesis. **A result that
     * surprising is reported only after it reproduces on data it was not found
     * on.**
     *
     * The split is a parity bit of the pool id — fixed by the data, not chosen
     * after looking, and reproducible by anyone. Both halves are printed whatever
     * they say.
     * ================================================================= */
    const half = (pid: string): number => Number(BigInt(pid) & 1n);
    const netAt = (sum: number, n: number, usd: number): number =>
      sum - n * (GAS_USD / usd);

    const holdout: string[] = [];
    holdout.push('bucket / half                 n    dead%  median    mean      SUM'
      + '   win%   net@$1  net@$10 net@$100');
    const cases: Array<[string, (s: number) => boolean]> = [
      ['share >= 40%', (s) => s >= 0.40],
      ['share <  40%', (s) => s < 0.40],
    ];
    for (const [bname, pred] of cases) {
      for (const h of [-1, 0, 1]) {
        const set = withShare.filter(([pid]) => pred(facts.get(pid)!)
          && (h === -1 || half(pid) === h));
        const rs = set.map(([, p]) => walk(p, { fixed: 300 }))
          .filter((x): x is number => x !== null);
        if (rs.length === 0) {
          holdout.push(`${`${bname} ${h === -1 ? 'ALL' : `half ${h}`}`.padEnd(28)} `
            + 'RETURNED NO ROWS'); continue;
        }
        const sum = rs.reduce((a2, b2) => a2 + b2, 0);
        const dead = rs.filter((x) => x <= -0.999).length;
        holdout.push(`${`${bname} ${h === -1 ? 'ALL' : `half ${h}`}`.padEnd(28)} `
          + `${String(rs.length).padStart(4)} ${(100 * dead / rs.length).toFixed(0).padStart(6)}% `
          + `${pc(quant(rs, 0.5)).padStart(7)} ${pc(sum / rs.length).padStart(7)} `
          + `${sum.toFixed(2).padStart(8)} `
          + `${(100 * rs.filter((x) => x > 0).length / rs.length).toFixed(0).padStart(5)}% `
          + `${netAt(sum, rs.length, 1).toFixed(2).padStart(8)} `
          + `${netAt(sum, rs.length, 10).toFixed(2).padStart(8)} `
          + `${netAt(sum, rs.length, 100).toFixed(2).padStart(8)}`);
      }
    }
    log.info('*** 4F-2  HOLDOUT — DOES THE HIGH-SHARE BUCKET REPRODUCE? ***', {
      rule: 'fixed 30-second hold, entry +1 block',
      split: 'parity of the pool id — fixed by the data, not chosen after looking',
      gas: `absolute $${GAS_USD} per round trip; net columns subtract n x that at each size`,
      what_would_refute_it: 'the two halves disagreeing in sign, or either half being '
        + 'negative. A result found on one half and absent from the other is a sample, '
        + 'not a finding.',
      table: holdout,
    });

    /* WHY might a LARGE creator share be good? A mechanism, checked not assumed. */
    const dumpBlocks: number[] = [];
    for (const [pid, p] of withShare) {
      if ((facts.get(pid) ?? 0) < 0.40) continue;
      const sorted = [...p].sort((a2, b2) => a2.off - b2.off);
      for (let i = 1; i < sorted.length; i += 1) {
        const a2 = sorted[i - 1]!.ret; const b2 = sorted[i]!.ret;
        if (a2 === null || b2 === null) continue;
        if (a2 - b2 > 0.5) { dumpBlocks.push(sorted[i]!.off); break; }
      }
    }
    log.info('THE MECHANISM — WHEN DOES THE VALUE COLLAPSE ON HIGH-SHARE LAUNCHES?', {
      high_share_pools_with_a_collapse: dumpBlocks.length,
      collapse_first_seen_at_p10_seconds: quant(dumpBlocks, 0.10) === null ? 'n/a'
        : quant(dumpBlocks, 0.10)! / 10,
      p25_seconds: quant(dumpBlocks, 0.25) === null ? 'n/a' : quant(dumpBlocks, 0.25)! / 10,
      median_seconds: quant(dumpBlocks, 0.50) === null ? 'n/a' : quant(dumpBlocks, 0.50)! / 10,
      p75_seconds: quant(dumpBlocks, 0.75) === null ? 'n/a' : quant(dumpBlocks, 0.75)! / 10,
      note: 'if the median collapse lands AFTER 30 s, a 30-second hold is exiting '
        + 'before the dump, which would be the mechanism rather than a coincidence',
    });

    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('uncapped-rules failed', errorFields(e)); process.exit(1); });
