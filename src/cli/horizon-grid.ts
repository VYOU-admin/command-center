/**
 * `npm run horizon-grid` — 4D-1: THE FULL ENTRY x EXIT GRID, WITH DISTRIBUTIONS.
 *
 * §6F settled that entry timing barely matters — every offset's median is the 0.50%
 * round-trip fee, and p90 is flat at ~+33%. **So the open question is entirely the
 * exit**, and a single horizon cannot answer it. This crosses three entry offsets
 * against ten holding periods and reports the whole distribution of each cell, not the
 * median.
 *
 * ```
 * entry offsets  +1 blk (the earliest reachable — §6F.3), +10 blk, +150 blk (15 s)
 * holding        15 s, 30 s, 90 s, 5 m, 15 m, 30 m, 1 h, 2 h, 6 h, 24 h
 * ```
 *
 * Three entry offsets rather than nine, because §6F.5 measured them within 0.32
 * percentage points of each other; three is enough to show whether that flatness
 * survives a longer hold, and nine would triple the bill to re-measure a known result.
 *
 * ===========================================================================
 * WHAT THIS IS BUILT TO CATCH
 * ===========================================================================
 *
 * **SELLABILITY DECAY.** §6E measured **0 of 256 unsellable at +90 s**. §6F.1 then found
 * **4 of 12 pools from the last few hours paying ZERO now.** Both are measurements, so
 * the lock that holds at 90 seconds does not obviously hold at 24 hours, and the grid is
 * where that becomes visible instead of assumed. `% unsellable` and `% liquidity
 * withdrawn` are reported **per cell**, as their own columns, never folded into a return.
 *
 * **NO FILTERING ON ANY EXIT-TIME PROPERTY.** Every pool that can be bought at an entry
 * offset appears in every cell for that offset, and a pool that cannot be sold at a
 * horizon is **−100%** in that cell rather than dropped from it. That is the circularity
 * §6C caught once, and the dead column sits beside every median so it cannot recur.
 *
 * **A CONTROL AT THE SAME CELLS**, so an effect can be attributed to Pools.trade rather
 * than to the passage of time.
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
const MODIFY_LIQUIDITY =
  '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const CU_CEILING = 1_800_000;

const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];

const BLOCKS_PER_DAY = 864_000;
const ENTRIES = [1, 10, 150];
/** Holding periods, in blocks, at the measured 10 blocks/second. */
const HOLDS: Array<[string, number]> = [
  ['15s', 150], ['30s', 300], ['90s', 900], ['5m', 3_000], ['15m', 9_000],
  ['30m', 18_000], ['1h', 36_000], ['2h', 72_000], ['6h', 216_000], ['24h', 864_000],
];
const PER_GROUP = 100;
const SIZE_WEI = 562_000_000_000_000n;   /* ~$1 */

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const addrTopic = (t: string): string => `0x${t.slice(26)}`.toLowerCase();
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;

const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const med = (xs: number[]): number | null => quant(xs, 0.5);
const pc = (x: number | null): string => x === null ? '   n/a' : `${(100 * x).toFixed(1)}%`;

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
    await c.query(`create table if not exists bot_horizon_grid (
      chain text not null, grp text not null, pool_id text not null,
      entry_offset integer not null, hold_blocks integer not null,
      eth_in numeric not null, eth_out numeric, sell_executes boolean,
      liq_withdrawn_by_then boolean,
      measured_at timestamptz not null default now(),
      primary key (chain, grp, pool_id, entry_offset, hold_blocks)
    )`);

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    /*
     * EVERY POOL MUST HAVE LIVED PAST THE LONGEST HORIZON, or the 24 h cell would be
     * simulated at a block that does not exist. So the window ENDS 24 h + slack back.
     */
    /*
     * **THE WINDOW IS PINNABLE, AND IT HAD TO BECOME SO.** Deriving `to` from `head`
     * means every run samples a DIFFERENT population, so the resume logic cannot match
     * and a second invocation re-buys the whole grid. That happened once here: a re-run
     * meant only to reprint the table with two extra columns spent another ~800,000 CU
     * and doubled every cell's n.
     *
     * `GRID_TO_BLOCK` pins it. The default still tracks head, because a first run has
     * nothing to pin to, but any re-report should pass the same value.
     */
    const to = process.env['GRID_TO_BLOCK'] !== undefined
      ? Number(process.env['GRID_TO_BLOCK'])
      : head - (BLOCKS_PER_DAY + 10_000);
    const from = to - 3 * BLOCKS_PER_DAY;

    const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
      from, to, 2_000_000);
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
    const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      from, to, 40_000);
    const launches = inits.filter((l) =>
      PRICING.includes(addrTopic(l.topics[2] ?? '')) !== PRICING.includes(addrTopic(l.topics[3] ?? '')));
    const ptAll = launches.filter((l) => ptTxs.has(l.transactionHash.toLowerCase()));
    const ctrlAll = launches.filter((l) => !ptTxs.has(l.transactionHash.toLowerCase()));

    const pick = (xs: Log[]): Log[] => {
      const o = [...xs].sort((a, b) =>
        Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)));
      const st = Math.max(1, Math.floor(o.length / PER_GROUP));
      return o.filter((_, i) => i % st === 0).slice(0, PER_GROUP);
    };
    const groups: Array<[string, Log[]]> = [
      ['POOLS_TRADE', pick(ptAll)], ['CONTROL', pick(ctrlAll)],
    ];

    log.info('4D-1  BEFORE THE FIRST PAID CALL', {
      window: `${from}..${to}`,
      window_pinned: process.env['GRID_TO_BLOCK'] !== undefined,
      note: 'the window ends 24 h + slack before head so every pool has lived past the '
        + 'longest horizon; a 24 h cell must not be simulated at a future block',
      TokenCreated: created.length,
      canonical_pools_trade: ptAll.length,
      control: ctrlAll.length,
      sampled: groups.map(([g, ls]) => `${g} ${ls.length}`),
      entries: ENTRIES, holds: HOLDS.map(([n]) => n),
      cells_per_group: ENTRIES.length * HOLDS.length,
      estimate_cu: groups.reduce((n, [, ls]) => n + ls.length, 0)
        * (ENTRIES.length + ENTRIES.length * HOLDS.length * 5 + 1) * 26,
      ceiling_cu: CU_CEILING,
    });

    const doneAlready = new Set((await c.query<{ k: string }>(
      `select grp||'|'||pool_id||'|'||entry_offset||'|'||hold_blocks as k
         from bot_horizon_grid where chain = $1`, [CHAIN])).rows.map((r) => r.k));

    for (const [grp, ls] of groups) {
      let n = 0;
      for (const l of ls) {
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
        const initBlock = Number(BigInt(l.blockNumber));

        /*
         * LIQUIDITY WITHDRAWALS ONCE PER POOL, THEN BUCKETED BY HORIZON. One sparse
         * getLogs beats thirty liquidity reads, and it answers the exact question --
         * `ModifyLiquidity` with a negative `liquidityDelta` -- rather than the
         * active-liquidity proxy §6D.5 showed is the wrong quantity.
         */
        let withdrawBlocks: number[] = [];
        try {
          const evs = (await rpc.call('eth_getLogs', [{
            address: POOL_MANAGER, topics: [MODIFY_LIQUIDITY, pid],
            fromBlock: `0x${initBlock.toString(16)}`,
            toBlock: `0x${(initBlock + BLOCKS_PER_DAY).toString(16)}`,
          }])) as Log[];
          withdrawBlocks = evs
            .filter((e) => sgn(BigInt(`0x${e.data.slice(2).slice(128, 192)}`)) < 0n)
            .map((e) => Number(BigInt(e.blockNumber)));
        } catch { withdrawBlocks = []; }

        for (const e of ENTRIES) {
          const entry = initBlock + e;
          const buy = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: SIZE_WEI,
            amountOutMinimum: UNREACHABLE,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
          let tokensOut: bigint | null = null;
          try {
            await rpc.call('eth_call', [{ from: owner, to: buy.to, data: buy.data,
              value: `0x${buy.value.toString(16)}` }, `0x${entry.toString(16)}`,
            { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } }]);
          } catch (err) {
            const err2 = err as Error & { data?: unknown };
            const dd = typeof err2.data === 'string' ? err2.data : '';
            if (dd.startsWith(V4_TOO_LITTLE)) {
              const dec = abi.decode(['uint256', 'uint256'], `0x${dd.slice(10)}`) as unknown as bigint[];
              if ((dec[1] as bigint) > 0n) tokensOut = dec[1] as bigint;
            }
          }
          if (tokensOut === null) continue;

          for (const [, hb] of HOLDS) {
            if (doneAlready.has(`${grp}|${pid}|${e}|${hb}`)) continue;
            const exit = entry + hb;
            let executes: boolean | null = null; let ethOut: bigint | null = null;
            try {
              const sim = await simulateSellAt(rpc, { pool, token, owner,
                amount: tokensOut, zeroForOneBuy: zeroIsPricing,
                block: `0x${exit.toString(16)}` });
              executes = sim.executes; ethOut = sim.ethOut;
            } catch { executes = null; }
            if (executes === null) continue;
            const pulled = withdrawBlocks.some((b) => b <= exit);
            await c.query(
              `insert into bot_horizon_grid (chain, grp, pool_id, entry_offset,
                 hold_blocks, eth_in, eth_out, sell_executes, liq_withdrawn_by_then)
               values ($1,$2,$3,$4,$5,$6::numeric,$7::numeric,$8,$9)
               on conflict do nothing`,
              [CHAIN, grp, pid, e, hb, SIZE_WEI.toString(),
                ethOut === null ? null : ethOut.toString(), executes, pulled]);
          }
        }
        n += 1;
        if (n % 20 === 0) log.info('progress', { grp, pools: n, of: ls.length });
      }
    }

    /* ---- REPORT, read back from the table -------------------------------- */
    const rows = (await c.query<{
      grp: string; entry_offset: number; hold_blocks: number; eth_in: string;
      eth_out: string | null; sell_executes: boolean | null; liq_withdrawn_by_then: boolean | null;
    }>(`select grp, entry_offset, hold_blocks, eth_in::text, eth_out::text,
               sell_executes, liq_withdrawn_by_then
          from bot_horizon_grid where chain = $1`, [CHAIN])).rows;

    for (const grp of ['POOLS_TRADE', 'CONTROL']) {
      const out: string[] = [];
      /*
       * **THE MEAN AND THE SUM ARE REPORTED BESIDE THE MEDIAN, AND FOR THIS QUESTION
       * THEY MATTER MORE.** This document's standing rule is medians not means, and
       * that rule is about not letting one outlier speak for a population. A TAIL
       * STRATEGY is the one case where the outlier IS the thesis: you accept most
       * positions going to zero because the winners pay for them, and such a strategy
       * is judged on the SUM over the sample, not on its median. Both are printed so
       * neither can be quoted alone.
       */
      out.push('entry  hold     n   dead%  pulled%    p10     p25   median     p75     p90'
        + '     mean      SUM   win%     best');
      for (const e of ENTRIES) {
        for (const [name, hb] of HOLDS) {
          const cell = rows.filter((r) => r.grp === grp && r.entry_offset === e
            && r.hold_blocks === hb);
          if (cell.length === 0) {
            out.push(`+${String(e).padStart(3)}  ${name.padEnd(5)}  RETURNED NO ROWS`);
            continue;
          }
          const rets = cell.map((r) => r.sell_executes === true && r.eth_out !== null
            ? Number(BigInt(r.eth_out) - BigInt(r.eth_in)) / Number(BigInt(r.eth_in))
            : -1);
          const dead = cell.filter((r) => r.sell_executes === false).length;
          const pulled = cell.filter((r) => r.liq_withdrawn_by_then === true).length;
          const sum = rets.reduce((x, y) => x + y, 0);
          const mean = sum / rets.length;
          const wins = rets.filter((x) => x > 0).length;
          out.push(`+${String(e).padStart(3)}  ${name.padEnd(5)} ${String(cell.length).padStart(4)} `
            + `${(100 * dead / cell.length).toFixed(0).padStart(5)}% `
            + `${(100 * pulled / cell.length).toFixed(0).padStart(7)}% `
            + `${pc(quant(rets, 0.10)).padStart(7)} ${pc(quant(rets, 0.25)).padStart(7)} `
            + `${pc(med(rets)).padStart(7)} ${pc(quant(rets, 0.75)).padStart(7)} `
            + `${pc(quant(rets, 0.90)).padStart(7)} `
            + `${pc(mean).padStart(8)} ${sum.toFixed(2).padStart(8)} `
            + `${(100 * wins / rets.length).toFixed(0).padStart(4)}% `
            + `${pc(Math.max(...rets)).padStart(8)}`);
        }
      }
      log.info(`*** 4D-1  ${grp} — THE GRID ***`, {
        size_usd: 1,
        note: 'no-exit = -100% IN the cell, never dropped. dead% and pulled% are their '
          + 'own columns and are never folded into a return.',
        grid: out,
      });
    }
    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('horizon-grid failed', errorFields(e)); process.exit(1); });
