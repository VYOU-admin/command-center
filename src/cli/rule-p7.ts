/**
 * `npm run rule-p7` — PART 7 STAGE 2: SCORE THE NAMED RULE ON A WINDOW IT HAS NEVER SEEN.
 *
 * The rule is defined in `docs/NAMED-RULE-P7.md`, **committed to git before this file
 * measured a single fresh block.** Nothing here may adjust it.
 *
 * ```
 * GATE 1  creator_share >= 40%                  (pre-registered §6I)
 * GATE 2  cumulative supply sold by +90 s < 25%  (knowable live at +90 s)
 * ENTRY   +115 s      EXIT  +215 s   (a 100-second hold, unconditional)
 * ```
 *
 * ===========================================================================
 * WHY A FRESH WINDOW AND NOT THE STORED HOLDOUT
 * ===========================================================================
 *
 * The exploratory table that produced this rule was computed over **all 379 stored
 * pools**, both halves of the previous time split. A holdout you have already looked at
 * is not a holdout. So this measures blocks **after** the stored sample ends — launches
 * that did not exist when the rule was written.
 *
 * **BOTH GATES ARE EVALUATED ON INFORMATION AVAILABLE BEFORE THE ENTRY BLOCK.** Gate 1
 * reads the launch block; gate 2 reads the first 900 blocks. The entry is at block 1,150.
 * Nothing from after +115 s touches the decision, and the exit is unconditional — there
 * is no exit-time property in the selection, which is the circularity §6C caught.
 *
 * The exit is priced with `simulateSellAt` at a **REACHABLE** bound: a real sell through
 * `SETTLE_ALL`, never a mid-price (§6A.3).
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
const CU_CEILING = 500_000;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const SUPPLY = 1e27;
/** THE RULE. Frozen; see docs/NAMED-RULE-P7.md. */
const GATE1_SHARE = 0.40;
const GATE2_SOLD = 0.25;
const GATE2_AT_BLOCKS = 900;     /* +90 s */
const ENTRY_BLOCKS = 1_150;      /* +115 s */
const EXIT_BLOCKS = 2_150;       /* +215 s */
/** The stored sample ends here (§6J's pinned END_BLOCK). Fresh data starts after. */
const FRESH_FROM = 66_528_000;
const SIZE_WEI = 562_000_000_000_000n;
const GAS_USD = 0.193;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;
const addrTopic = (t: string): string => `0x${t.slice(26)}`.toLowerCase();
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? 'n/a' : `${(100 * x).toFixed(2)}%`;

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
    await c.query(`create table if not exists bot_rule_p7 (
      chain text not null, pool_id text not null, init_block bigint not null,
      creator_share numeric, sold_by_90 numeric, passed boolean,
      eth_in numeric, eth_out_entry numeric, eth_out_exit numeric,
      entry_ok boolean, exit_ok boolean, ret numeric,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    const to = head - (EXIT_BLOCKS + 3_000);
    const from = FRESH_FROM;
    if (to <= from) throw new Error('no fresh blocks yet beyond the stored sample');

    const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
      from, to, 900_000);
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
    const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      from, to, 40_000);
    const canon = inits.filter((l) => ptTxs.has(l.transactionHash.toLowerCase())
      && PRICING.includes(addrTopic(l.topics[2] ?? '')) !== PRICING.includes(addrTopic(l.topics[3] ?? '')));

    log.info('PART 7 STAGE 2 — FRESH WINDOW, NEVER SEEN BY THE RULE', {
      rule: 'docs/NAMED-RULE-P7.md, committed before this measurement',
      stored_sample_ended_at: FRESH_FROM,
      fresh_window: `${from}..${to}`,
      days: ((to - from) / 864_000).toFixed(2),
      TokenCreated: created.length,
      canonical_launches: canon.length,
      estimate_cu: canon.length * (60 + 26 + 2 * 5 * 26),
      ceiling_cu: CU_CEILING,
    });

    const have = new Set((await c.query<{ pool_id: string }>(
      `select pool_id from bot_rule_p7 where chain=$1`, [CHAIN])).rows.map((r) => r.pool_id));

    let n = 0;
    for (const l of canon) {
      const pid = (l.topics[1] ?? '').toLowerCase();
      if (have.has(pid)) { n += 1; continue; }
      const c0 = addrTopic(l.topics[2] ?? '');
      const c1 = addrTopic(l.topics[3] ?? '');
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) continue;
      const zeroIsPricing = PRICING.includes(c0);
      const token = zeroIsPricing ? c1 : c0;
      const ib = Number(BigInt(l.blockNumber));

      /* Both gates, from the first 900 blocks ONLY. */
      let share = 0; let sold90 = 0;
      try {
        const sw = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
          fromBlock: `0x${ib.toString(16)}`,
          toBlock: `0x${(ib + GATE2_AT_BLOCKS).toString(16)}`,
        }])) as Log[];
        for (const x of sw) {
          const z = x.data.slice(2);
          const a1 = sgn(BigInt(`0x${z.slice(64, 128)}`));
          const off = Number(BigInt(x.blockNumber)) - ib;
          if (a1 > 0n && off === 0) share += Number(a1) / SUPPLY;
          if (a1 < 0n) sold90 += Number(-a1) / SUPPLY;
        }
      } catch { continue; }
      const passed = share >= GATE1_SHARE && sold90 < GATE2_SOLD;

      let entryOut: bigint | null = null; let exitOut: bigint | null = null;
      let entryOk = false; let exitOk = false;
      if (passed) {
        const buy = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: SIZE_WEI,
          amountOutMinimum: UNREACHABLE,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
        let tokensOut: bigint | null = null;
        try {
          await rpc.call('eth_call', [{ from: owner, to: buy.to, data: buy.data,
            value: `0x${buy.value.toString(16)}` }, `0x${(ib + ENTRY_BLOCKS).toString(16)}`,
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
          entryOk = true;
          try {
            const s = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
              zeroForOneBuy: zeroIsPricing, block: `0x${(ib + EXIT_BLOCKS).toString(16)}` });
            exitOk = s.executes === true; exitOut = s.ethOut;
          } catch { exitOk = false; }
        }
      }
      const ret = !passed || !entryOk ? null
        : (exitOk && exitOut !== null
          ? Number(exitOut - SIZE_WEI) / Number(SIZE_WEI) : -1);

      await c.query(
        `insert into bot_rule_p7 (chain, pool_id, init_block, creator_share, sold_by_90,
           passed, eth_in, eth_out_entry, eth_out_exit, entry_ok, exit_ok, ret)
         values ($1,$2,$3,$4::numeric,$5::numeric,$6,$7::numeric,$8,$9::numeric,$10,$11,$12::numeric)
         on conflict do nothing`,
        [CHAIN, pid, ib, share.toString(), sold90.toString(), passed,
          SIZE_WEI.toString(), entryOut === null ? null : entryOut.toString(),
          exitOut === null ? null : exitOut.toString(), entryOk, exitOk,
          ret === null ? null : ret.toString()]);
      n += 1;
      if (n % 40 === 0) log.info('progress', { pools: n, of: canon.length });
    }

    /* ---- THE RESULT ---- */
    const rows = (await c.query<{ passed: boolean; ret: string | null; entry_ok: boolean;
      exit_ok: boolean; sold_by_90: string; creator_share: string }>(
      `select passed, ret::text, entry_ok, exit_ok, sold_by_90::text, creator_share::text
         from bot_rule_p7 where chain=$1`, [CHAIN])).rows;
    const fired = rows.filter((r) => r.passed);
    const rs = fired.filter((r) => r.ret !== null).map((r) => Number(r.ret));
    const sum = rs.reduce((a, b) => a + b, 0);
    const mean = rs.length ? sum / rs.length : 0;
    let run = 0; let peak = 0; let dd = 0;
    for (const x of rs) { run += x; if (run > peak) peak = run; if (peak - run > dd) dd = peak - run; }
    const sd = rs.length > 1
      ? Math.sqrt(rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (rs.length - 1)) : 0;
    const se = rs.length ? sd / Math.sqrt(rs.length) : 0;

    log.info('*** PART 7 — THE NAMED RULE ON FRESH DATA ***', {
      rule: 'gate1 share>=40%, gate2 sold-by-90s<25%, entry +115 s, exit +215 s',
      canonical_launches_in_fresh_window: rows.length,
      rule_FIRED_on: `${fired.length} (${pc(fired.length / Math.max(rows.length, 1))})`,
      entry_could_not_execute: fired.filter((r) => !r.entry_ok).length,
      scored: rs.length,
      unsellable_at_exit: fired.filter((r) => r.entry_ok && !r.exit_ok).length,
      p10: pc(quant(rs, 0.10)), p25: pc(quant(rs, 0.25)), median: pc(quant(rs, 0.5)),
      p75: pc(quant(rs, 0.75)), p90: pc(quant(rs, 0.90)),
      MEAN: pc(mean), SUM: sum.toFixed(2),
      win_rate: pc(rs.filter((x) => x > 0).length / Math.max(rs.length, 1)),
      max_drawdown_stake_units: dd.toFixed(2),
      t_stat: se > 0 ? (mean / se).toFixed(3) : 'n/a',
      net_at_10usd: (sum - rs.length * GAS_USD / 10).toFixed(2),
      net_at_100usd: (sum - rs.length * GAS_USD / 100).toFixed(2),
      mean_net_at_10usd: pc(mean - GAS_USD / 10),
      mean_net_at_100usd: pc(mean - GAS_USD / 100),
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('rule-p7 failed', errorFields(e)); process.exit(1); });
