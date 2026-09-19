/**
 * `npm run entry-timing` — 4D-0: HOW EARLY CAN WE ACTUALLY GET IN?
 *
 * **NOTHING ABOUT +15 s IS LOAD-BEARING.** It is a leftover from a corpus study whose
 * launchpad attribution was wrong (§6D.1), whose sell oracle never executed a transfer
 * (§6A.3), and whose exit horizon was chosen on a survivorship metric (§6C). The
 * operator has discarded it. Entry timing is a free variable and this measures it.
 *
 * Four things, all on **canonical Pools.trade launches** (Initialize sharing a
 * transaction with a Pools.trade `TokenCreated`):
 *
 *   1. **OUR REAL DETECTION LAG**, measured rather than estimated — how many blocks
 *      behind head an `Initialize` log is by the time an `eth_getLogs` poll returns it.
 *   2. **THE PRICE PATH** from the pool's own `slot0` at +0, +1, +2, +5, +10, +30, +60,
 *      +300 blocks.
 *   3. **RETURN BY ENTRY OFFSET**, exit held constant, buy and sell both simulated.
 *   4. **WHO THE COUNTERPARTY IS** — how much of the float the launch-block buyers took
 *      and whether they are selling into us.
 *
 * **THE EXIT IS HELD CONSTANT ON PURPOSE.** Crossing entry with exit is 4D-1; mixing
 * them here would make an entry effect and an exit effect impossible to tell apart.
 *
 * **NO FILTERING ON ANY EXIT-TIME PROPERTY.** Every launch that can be bought at an
 * offset is scored at that offset, and one that cannot be sold is −100%, never dropped.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { poolIdOf, readPoolSlot0 } from '../bot/pool-state.js';
import { buildSwap } from '../bot/calldata.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const PT_FACTORY = '0x000000e200088d55c39a11f609e5f667729ad49b';
const TOKEN_CREATED = '0x4ef8284ecf42d4cd19686572ffd87f630858c82398911e776cb831de35eddbf4';
const abi = AbiCoder.defaultAbiCoder();
const V4_TOO_LITTLE = id('V4TooLittleReceived(uint256,uint256)').slice(0, 10);
const UNREACHABLE = 1n << 127n;
const CU_CEILING = 900_000;

const ENTRY_OFFSETS = [0, 1, 2, 5, 10, 30, 60, 150, 300];
const PRICE_OFFSETS = [0, 1, 2, 5, 10, 30, 60, 300];
/** Exit held CONSTANT while entry varies. 900 blocks past the pool's creation. */
const FIXED_EXIT_FROM_INIT = 900;
const SAMPLE = 120;
const SIZE_WEI = 562_000_000_000_000n;   /* ~$1 */

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? 'n/a' : `${(100 * x).toFixed(2)}%`;

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
    await c.query(`create table if not exists bot_entry_timing (
      chain text not null, pool_id text not null, token text not null,
      init_block bigint not null, entry_offset integer not null,
      tokens_out numeric, eth_out numeric, sell_executes boolean,
      sqrt_price numeric, measured_at timestamptz not null default now(),
      primary key (chain, pool_id, entry_offset)
    )`);

    /* =================================================================
     * 1. OUR REAL DETECTION LAG — MEASURED, NOT ESTIMATED
     * =================================================================
     * A tight poll of the same filter the bot uses. For every Initialize log the poll
     * returns for the first time, the lag is `head at that moment - the log's block`.
     * That folds in block propagation, RPC latency and the poll interval, which is
     * exactly what the bot experiences. An estimate would fold in none of them.
     */
    const seen = new Set<string>();
    const lags: number[] = [];
    const POLLS = 40;
    let lastHead = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    for (let i = 0; i < POLLS; i += 1) {
      const t0 = Date.now();
      const h = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
      const logs = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.initializeV4],
        fromBlock: `0x${Math.max(0, lastHead - 20).toString(16)}`,
        toBlock: `0x${h.toString(16)}`,
      }])) as Log[];
      const rtt = Date.now() - t0;
      for (const l of logs) {
        const k = `${l.transactionHash}:${l.topics[1] ?? ''}`;
        if (seen.has(k)) continue;
        seen.add(k);
        if (i === 0) continue;   /* the first poll's backlog is not a detection */
        lags.push(h - Number(BigInt(l.blockNumber)));
      }
      lastHead = h;
      if (i === 0) log.info('detection probe: first poll round-trip', { rtt_ms: rtt });
    }
    log.info('4D-0.1  OUR REAL DETECTION LAG — MEASURED', {
      polls: POLLS,
      new_initializations_seen: lags.length,
      lag_blocks_min: lags.length === 0 ? 'NO LOGS SEEN' : Math.min(...lags),
      lag_blocks_median: median(lags),
      lag_blocks_p75: quant(lags, 0.75),
      lag_blocks_max: lags.length === 0 ? 'n/a' : Math.max(...lags),
      note: 'blocks behind head when an eth_getLogs poll first returns the log. '
        + 'At ~10 blocks/s, 10 blocks is one second. This includes propagation, RPC '
        + 'latency and the poll loop — an estimate would include none of them.',
    });

    /* ---- the population ------------------------------------------------- */
    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    const to = head - (FIXED_EXIT_FROM_INIT + 5_000);
    const from = to - 900_000;
    const created = (await rpc.call('eth_getLogs', [{
      address: PT_FACTORY, topics: [TOKEN_CREATED],
      fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`,
    }])) as Log[];
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));

    const inits: Log[] = [];
    let cur = from;
    while (cur <= to) {
      const end = Math.min(cur + 40_000 - 1, to);
      const got = (await rpc.call('eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.initializeV4],
        fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Log[];
      inits.push(...got.filter((l) => ptTxs.has(l.transactionHash.toLowerCase())));
      cur = end + 1;
    }
    const step = Math.max(1, Math.floor(inits.length / SAMPLE));
    const pick = inits.filter((_, i) => i % step === 0).slice(0, SAMPLE);

    log.info('THE POPULATION', {
      window: `${from}..${to}`,
      TokenCreated: created.length,
      canonical_pools: inits.length,
      sampled: pick.length,
      entry_offsets: ENTRY_OFFSETS,
      exit_held_constant_at: `init + ${FIXED_EXIT_FROM_INIT} blocks`,
      estimate_cu: pick.length * (PRICE_OFFSETS.length + ENTRY_OFFSETS.length * 6) * 26,
      ceiling_cu: CU_CEILING,
    });

    /* =================================================================
     * 2 + 3 + 4
     * ================================================================= */
    const priceBy = new Map<number, number[]>();   /* offset -> price ratio vs +0 */
    const retBy = new Map<number, number[]>();     /* offset -> return */
    const deadBy = new Map<number, number>();
    const nBy = new Map<number, number>();
    const launchBuyerShare: number[] = [];
    const launchBuyerCount: number[] = [];

    for (const l of pick) {
      const pid = (l.topics[1] ?? '').toLowerCase();
      const c0 = `0x${(l.topics[2] ?? '').slice(26)}`.toLowerCase();
      const c1 = `0x${(l.topics[3] ?? '').slice(26)}`.toLowerCase();
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) continue;
      const zeroIsPricing = c0 === '0x0000000000000000000000000000000000000000';
      const token = zeroIsPricing ? c1 : c0;
      const initBlock = Number(BigInt(l.blockNumber));
      const exitBlock = initBlock + FIXED_EXIT_FROM_INIT;

      /* ---- 2. THE PRICE PATH, from slot0 -------------------------------- */
      let base: bigint | null = null;
      for (const o of PRICE_OFFSETS) {
        const s0 = await readPoolSlot0(rpc, pid, `0x${(initBlock + o).toString(16)}`);
        if (s0 === null) continue;
        if (o === 0) { base = s0.sqrtPriceX96; continue; }
        if (base === null || base === 0n) continue;
        /* price ∝ sqrtPrice², and the RATIO is what matters, so the X96 scaling
         * cancels. Done in floating point deliberately: this is a shape, not money. */
        const r = (Number(s0.sqrtPriceX96) / Number(base)) ** 2;
        if (!Number.isFinite(r)) continue;
        if (!priceBy.has(o)) priceBy.set(o, []);
        priceBy.get(o)!.push(zeroIsPricing ? r : 1 / r);
      }

      /* ---- 4. WHO BOUGHT IN THE LAUNCH BLOCK ---------------------------- */
      try {
        const sw = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
          fromBlock: `0x${initBlock.toString(16)}`,
          toBlock: `0x${initBlock.toString(16)}`,
        }])) as Log[];
        const senders = new Set(sw.map((x) => `0x${(x.topics[2] ?? '').slice(26)}`.toLowerCase()));
        launchBuyerCount.push(senders.size);
        /* Token taken out of the pool in the launch block, as a share of 1e9 supply. */
        let taken = 0n;
        for (const x of sw) {
          const dd = x.data.slice(2);
          const a0 = BigInt(`0x${dd.slice(0, 64)}`);
          const a1 = BigInt(`0x${dd.slice(64, 128)}`);
          const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;
          const tokenAmt = zeroIsPricing ? sgn(a1) : sgn(a0);
          if (tokenAmt > 0n) taken += tokenAmt;
        }
        launchBuyerShare.push(Number(taken) / 1e27);
      } catch { /* a pool with no launch-block swap contributes nothing */ }

      /* ---- 3. RETURN BY ENTRY OFFSET, EXIT CONSTANT --------------------- */
      for (const o of ENTRY_OFFSETS) {
        const entry = initBlock + o;
        if (entry >= exitBlock) continue;
        const buy = buildSwap({ pool, zeroForOne: zeroIsPricing, amountIn: SIZE_WEI,
          amountOutMinimum: UNREACHABLE,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600) });
        let tokensOut: bigint | null = null;
        try {
          await rpc.call('eth_call', [{ from: owner, to: buy.to, data: buy.data,
            value: `0x${buy.value.toString(16)}` }, `0x${entry.toString(16)}`,
          { [owner]: { balance: `0x${(10n ** 20n).toString(16)}` } }]);
        } catch (err) {
          const e = err as Error & { data?: unknown };
          const dd = typeof e.data === 'string' ? e.data : '';
          if (dd.startsWith(V4_TOO_LITTLE)) {
            const dec = abi.decode(['uint256', 'uint256'], `0x${dd.slice(10)}`) as unknown as bigint[];
            if ((dec[1] as bigint) > 0n) tokensOut = dec[1] as bigint;
          }
        }
        if (tokensOut === null) continue;

        let executes: boolean | null = null; let ethOut: bigint | null = null;
        try {
          const sim = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
            zeroForOneBuy: zeroIsPricing, block: `0x${exitBlock.toString(16)}` });
          executes = sim.executes; ethOut = sim.ethOut;
        } catch { executes = null; }
        if (executes === null) continue;
        const ret = executes && ethOut !== null
          ? Number(ethOut - SIZE_WEI) / Number(SIZE_WEI) : -1;
        if (!retBy.has(o)) { retBy.set(o, []); deadBy.set(o, 0); nBy.set(o, 0); }
        retBy.get(o)!.push(ret);
        nBy.set(o, (nBy.get(o) ?? 0) + 1);
        if (!executes) deadBy.set(o, (deadBy.get(o) ?? 0) + 1);

        await c.query(
          `insert into bot_entry_timing (chain, pool_id, token, init_block, entry_offset,
             tokens_out, eth_out, sell_executes)
           values ('robinhood',$1,$2,$3,$4,$5::numeric,$6::numeric,$7)
           on conflict (chain, pool_id, entry_offset) do nothing`,
          [pid, token, initBlock, o, tokensOut.toString(),
            ethOut === null ? null : ethOut.toString(), executes]);
      }
    }

    log.info('4D-0.2  THE PRICE PATH FROM THE LAUNCH BLOCK', {
      note: 'median price relative to the pool at +0 blocks, from slot0. A PRICE, not a '
        + 'quote — it excludes our size and the fee.',
      path: PRICE_OFFSETS.filter((o) => o !== 0).map((o) => {
        const xs = priceBy.get(o) ?? [];
        return `+${o} blk (${(o / 10).toFixed(1)}s)  n=${xs.length}  `
          + `median ${median(xs) === null ? 'n/a' : `${((median(xs)! - 1) * 100).toFixed(2)}%`}  `
          + `p25 ${quant(xs, 0.25) === null ? 'n/a' : `${((quant(xs, 0.25)! - 1) * 100).toFixed(2)}%`}  `
          + `p75 ${quant(xs, 0.75) === null ? 'n/a' : `${((quant(xs, 0.75)! - 1) * 100).toFixed(2)}%`}`;
      }),
    });

    log.info('4D-0.3  RETURN BY ENTRY OFFSET, EXIT HELD CONSTANT', {
      exit: `init + ${FIXED_EXIT_FROM_INIT} blocks (${FIXED_EXIT_FROM_INIT / 10}s)`,
      size_usd: 1,
      rows: ENTRY_OFFSETS.map((o) => {
        const xs = retBy.get(o) ?? [];
        const dead = deadBy.get(o) ?? 0;
        return `entry +${String(o).padStart(3)} blk (${(o / 10).toFixed(1)}s)  `
          + `n=${String(xs.length).padStart(3)}  dead=${dead}  `
          + `p25 ${pc(quant(xs, 0.25)).padStart(9)}  median ${pc(median(xs)).padStart(9)}  `
          + `p75 ${pc(quant(xs, 0.75)).padStart(9)}  `
          + `p90 ${pc(quant(xs, 0.90)).padStart(9)}`;
      }),
    });

    log.info('4D-0.4  THE COUNTERPARTY — WHO BUYS IN THE LAUNCH BLOCK', {
      pools_with_a_launch_block_swap: launchBuyerShare.length,
      distinct_buyers_in_the_launch_block_median: median(launchBuyerCount),
      distinct_buyers_max: launchBuyerCount.length === 0 ? 'n/a' : Math.max(...launchBuyerCount),
      share_of_the_1e9_supply_taken_in_the_launch_block_median:
        median(launchBuyerShare) === null ? 'n/a' : pc(median(launchBuyerShare)),
      share_p25: quant(launchBuyerShare, 0.25) === null ? 'n/a' : pc(quant(launchBuyerShare, 0.25)),
      share_p75: quant(launchBuyerShare, 0.75) === null ? 'n/a' : pc(quant(launchBuyerShare, 0.75)),
      share_max: launchBuyerShare.length === 0 ? 'n/a' : pc(Math.max(...launchBuyerShare)),
    });
    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('entry-timing failed', errorFields(e)); process.exit(1); });
