/**
 * `npm run poolstrade-returns` — 4C: THE MEASUREMENT, RE-RUN ON THE POOLS.TRADE
 * POPULATION AND ON A CONTROL.
 *
 * Same method as §6C's filter table: our own simulated buy, our own simulated sell with
 * a **REACHABLE** bound, at **$1**, no-exit scored **−100%**, **deduplicated by token**,
 * over the last 7 days.
 *
 * ===========================================================================
 * THE GROUPS ARE DEFINED ENTIRELY BY CREATION-TIME FACTS
 * ===========================================================================
 *
 * **NOTHING HERE FILTERS ON AN EXIT-TIME PROPERTY.** §6C produced one circular table by
 * filtering on `sell_executes` while measuring at the exit — it reported 769 survivors,
 * 0.00% unsellable and +40.27%, which is survivorship wearing a filter's label. The
 * operator's instruction is explicit: do not produce a second.
 *
 * So group membership is decided before a single simulation runs, from two facts
 * knowable at the creation block:
 *
 *   **POOLS_TRADE**  the pool's `Initialize` shares a transaction hash with a
 *                    `TokenCreated` from the Pools.trade factory. §6D.5 established this
 *                    is the ONLY correct form — matching on "the token came from
 *                    Pools.trade" instead admits 433 secondary pools a day whose
 *                    liquidity-withdrawal rate is 37.3%, indistinguishable from the
 *                    chain at large.
 *   **CONTROL**      every other v4 pool initialized in the same window.
 *
 * ===========================================================================
 * WHAT IS REPORTED, AND WHY THE LIQUIDITY COLUMN IS SEPARATE
 * ===========================================================================
 *
 * §6D proved liquidity is not withdrawn from canonical Pools.trade pools. **That is not
 * the same as being able to sell** — a pool can hold every unit of its liquidity and
 * still pay nothing, and §6A.3 is the record of confusing those two. So the liquidity
 * reading at the horizon is reported as its own column beside the return, never folded
 * into it.
 *
 * **THE BUY'S UNREACHABLE BOUND IS DELIBERATE AND IS ITS ONE LEGITIMATE USE.** It
 * reports the QUANTITY we would hold, which is what that revert payload gets right. The
 * sell uses a reachable bound and runs the full path through the settle.
 */
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { simulateSellAt } from '../bot/sellability.js';
import { poolIdOf, readPoolLiquidity } from '../bot/pool-state.js';
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

const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];

const BLOCKS_PER_DAY = 864_000;
const ENTRY_DELAY_BLOCKS = 150;   /* 15 s — LAUNCHBOT.md's own rule */
const EXIT_DELAY_BLOCKS = 900;    /* 90 s */
const CU_CEILING = 1_400_000;
const PER_GROUP = 260;

/** $1, at the ETH/USD this chain's own market series measures (~$1,779). */
const SIZE_WEI = 562_000_000_000_000n;
/**
 * ROUND-TRIP GAS AS A SHARE OF A $1 POSITION.
 *
 * **I FIRST WROTE 0.193 HERE AND THAT WAS WRONG BY A FACTOR OF 100.** §6C measured the
 * ten-leg round trip at ~1.93% of a **$10** position, so the absolute cost is about
 * **$0.193**. Gas does not scale with position size — it is a fixed number of wei — so
 * at a $1 position the SAME absolute cost is **19.3% of the position**, not 0.193%. I
 * divided where I should have multiplied.
 *
 * **THE CONSEQUENCE IS DECISION-RELEVANT AND NOT A ROUNDING NOTE: AT $1, GAS ALONE IS
 * 19.3% AND NO STRATEGY ON THIS CHAIN CAN BE NET-POSITIVE AT THAT SIZE.** That does not
 * invalidate the $1 test — §6B.1 states plainly that the $1 size is *instrumentation,
 * not a profit attempt*, chosen so that being wrong costs nothing. It does mean the
 * GROSS figures are the ones that say whether the strategy works, and the net-at-$1
 * figures only confirm that the test itself will lose money, by design.
 *
 * Both are reported, and the gross/net gap is stated rather than folded away.
 */
const GAS_PCT_AT_1USD = 19.3;
/** The same absolute gas against the $10 size §6C measured it at. */
const GAS_PCT_AT_10USD = 1.93;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }

const addrTopic = (t: string): string => `0x${t.slice(26)}`.toLowerCase();
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

async function sweep(
  rpc: ReadOnlyRpc, filter: Record<string, unknown>, from: number, to: number, span0: number,
): Promise<Log[]> {
  const out: Log[] = []; let cur = from; let span = span0;
  while (cur <= to) {
    const end = Math.min(cur + span - 1, to);
    try {
      const got = (await rpc.call('eth_getLogs', [{
        ...filter, fromBlock: `0x${cur.toString(16)}`, toBlock: `0x${end.toString(16)}`,
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
  if (!owner) throw new Error('BOT_WALLET_ADDRESS must be set: the sell is OURS');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_pt_returns (
      chain text not null, grp text not null, pool_id text not null,
      token text not null, fee integer, first_swap bigint, entry_block bigint,
      exit_block bigint, eth_in numeric not null, eth_out numeric,
      sell_executes boolean, sell_reason text, liq_at_exit numeric,
      measured_at timestamptz not null default now(),
      primary key (chain, grp, pool_id)
    )`);

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    /* The window ends short of head so every launch has lived past its exit horizon. */
    const to = head - (ENTRY_DELAY_BLOCKS + EXIT_DELAY_BLOCKS + 2_000);
    const from = to - 7 * BLOCKS_PER_DAY;

    /* ---- the Pools.trade creating transactions, from the FACTORY ---------- */
    const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
      from, to, 2_000_000);
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));

    /* ---- every v4 Initialize in the window -------------------------------- */
    const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      from, to, 40_000);

    /* EXACTLY ONE PRICING SIDE — LAUNCHBOT.md's definition of a launch. Applied to
     * BOTH groups so the control is the same kind of thing. */
    const isLaunch = (l: Log): boolean =>
      PRICING.includes(addrTopic(l.topics[2] ?? '')) !== PRICING.includes(addrTopic(l.topics[3] ?? ''));
    const launches = inits.filter(isLaunch);
    const ptAll = launches.filter((l) => ptTxs.has(l.transactionHash.toLowerCase()));
    const ctrlAll = launches.filter((l) => !ptTxs.has(l.transactionHash.toLowerCase()));

    log.info('4C  THE WINDOW AND THE GROUPS — DEFINED BEFORE ANY SIMULATION', {
      window: `${from}..${to}`,
      days: ((to - from) / BLOCKS_PER_DAY).toFixed(1),
      TokenCreated_events: created.length,
      all_v4_initializations: inits.length,
      with_exactly_one_pricing_side: launches.length,
      POOLS_TRADE_canonical_same_tx: ptAll.length,
      CONTROL_everything_else: ctrlAll.length,
      group_rule: 'Initialize.transactionHash appears in a Pools.trade TokenCreated. '
        + 'NOTHING here is an exit-time property.',
      position_size_wei: SIZE_WEI.toString(),
    });

    /* A DETERMINISTIC, EVENLY SPREAD sample by block, not the first n. */
    const pick = (xs: Log[]): Log[] => {
      const o = [...xs].sort((a, b) => Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)));
      const step = Math.max(1, Math.floor(o.length / PER_GROUP));
      return o.filter((_, i) => i % step === 0).slice(0, PER_GROUP);
    };
    const groups: Array<[string, Log[]]> = [['POOLS_TRADE', pick(ptAll)], ['CONTROL', pick(ctrlAll)]];

    const doneAlready = new Set((await c.query<{ grp: string; pool_id: string }>(
      'select grp, pool_id from bot_pt_returns where chain = $1', [CHAIN])).rows
      .map((r) => `${r.grp}|${r.pool_id}`));

    log.info('BEFORE THE FIRST PAID CALL', {
      sampled: groups.map(([g, ls]) => `${g} ${ls.length}`),
      already_measured: doneAlready.size,
      estimate_cu: groups.reduce((n, [, ls]) => n + ls.length, 0) * 45 * 26,
      ceiling_cu: CU_CEILING,
    });

    for (const [grp, ls] of groups) {
      let n = 0;
      for (const l of ls) {
        const pid = (l.topics[1] ?? '').toLowerCase();
        if (doneAlready.has(`${grp}|${pid}`)) continue;
        const c0 = addrTopic(l.topics[2] ?? '');
        const c1 = addrTopic(l.topics[3] ?? '');
        const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
          unknown as [bigint, bigint, string, bigint, bigint];
        const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
          tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
        if (poolIdOf(pool).toLowerCase() !== pid) continue;
        const tokenIsC0 = !PRICING.includes(c0);
        const token = tokenIsC0 ? c0 : c1;
        const initBlock = Number(BigInt(l.blockNumber));

        /* FIRST SWAP, sparse filter, one call. A pool that never traded is EXCLUDED --
         * it was never an opportunity we missed. */
        let firstSwap: number | null = null;
        try {
          const sw = (await rpc.call('eth_getLogs', [{
            address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
            fromBlock: `0x${initBlock.toString(16)}`,
            toBlock: `0x${(initBlock + 2_000).toString(16)}`,
          }])) as Log[];
          if (sw.length > 0) firstSwap = Math.min(...sw.map((x) => Number(BigInt(x.blockNumber))));
        } catch { firstSwap = null; }
        if (firstSwap === null) continue;

        const entry = firstSwap + ENTRY_DELAY_BLOCKS;
        const exit = entry + EXIT_DELAY_BLOCKS;

        /* THE BUY — unreachable bound, for the QUANTITY only. */
        const buy = buildSwap({ pool, zeroForOne: !tokenIsC0, amountIn: SIZE_WEI,
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

        /* THE SELL AT THE HORIZON — reachable bound, full path through the settle. */
        let executes: boolean | null = null; let ethOut: bigint | null = null;
        let reason = 'not run';
        try {
          const sim = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
            zeroForOneBuy: !tokenIsC0, block: `0x${exit.toString(16)}` });
          executes = sim.executes; ethOut = sim.ethOut; reason = sim.executeReason;
        } catch (e) { reason = (e as Error).message.slice(0, 90); }

        const liq = await readPoolLiquidity(rpc, pid, `0x${exit.toString(16)}`);

        await c.query(
          `insert into bot_pt_returns (chain, grp, pool_id, token, fee, first_swap,
             entry_block, exit_block, eth_in, eth_out, sell_executes, sell_reason, liq_at_exit)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::numeric,$10::numeric,$11,$12,$13::numeric)
           on conflict (chain, grp, pool_id) do nothing`,
          [CHAIN, grp, pid, token, pool.fee, firstSwap, entry, exit, SIZE_WEI.toString(),
            ethOut === null ? null : ethOut.toString(), executes, reason.slice(0, 200),
            liq === null ? null : liq.toString()]);
        n += 1;
        if (n % 50 === 0) log.info('progress', { grp, done: n, of: ls.length });
      }
    }

    /* ---- REPORT, READ BACK FROM THE TABLE --------------------------------- */
    const rows = (await c.query<{
      grp: string; token: string; eth_in: string; eth_out: string | null;
      sell_executes: boolean | null; liq_at_exit: string | null; fee: number | null;
    }>(`select grp, token, eth_in::text, eth_out::text, sell_executes,
               liq_at_exit::text, fee from bot_pt_returns where chain = $1`, [CHAIN])).rows;

    for (const grp of ['POOLS_TRADE', 'CONTROL']) {
      const g = rows.filter((r) => r.grp === grp);
      const scored = g.map((r) => ({
        token: r.token,
        ret: r.sell_executes === true && r.eth_out !== null
          ? Number(BigInt(r.eth_out) - BigInt(r.eth_in)) / Number(BigInt(r.eth_in))
          : r.sell_executes === false ? -1 : Number.NaN,
        dead: r.sell_executes === false,
        liqZero: r.liq_at_exit !== null && BigInt(r.liq_at_exit) === 0n,
        liqUnread: r.liq_at_exit === null,
      })).filter((x) => !Number.isNaN(x.ret));

      /* ONE VOTE PER TOKEN — §6C measured one token in sixteen pools. */
      const byTok = new Map<string, number[]>();
      for (const s of scored) {
        if (!byTok.has(s.token)) byTok.set(s.token, []);
        byTok.get(s.token)!.push(s.ret);
      }
      const tokMeds = [...byTok.values()].map((v) => median(v)!);
      const rets = scored.map((s) => s.ret);
      const gas = GAS_PCT_AT_1USD / 100;

      log.info(`*** 4C  ${grp} ***`, {
        pools_measured: g.length,
        scored: scored.length,
        probe_unreadable_EXCLUDED: g.length - scored.length,
        distinct_tokens: byTok.size,
        max_pools_for_one_token: byTok.size === 0 ? 0
          : Math.max(...[...byTok.values()].map((v) => v.length)),
        UNSELLABLE_AT_HORIZON: scored.length === 0 ? 'n/a'
          : `${scored.filter((s) => s.dead).length} (${pc(scored.filter((s) => s.dead).length / scored.length)})`,
        liquidity_ZERO_at_horizon: scored.length === 0 ? 'n/a'
          : `${scored.filter((s) => s.liqZero).length} (${pc(scored.filter((s) => s.liqZero).length / scored.length)})`,
        liquidity_unreadable: scored.filter((s) => s.liqUnread).length,
        per_POOL_p25: pc(quant(rets, 0.25)),
        per_POOL_MEDIAN: pc(median(rets)),
        per_POOL_p75: pc(quant(rets, 0.75)),
        per_POOL_median_NET_at_1usd: median(rets) === null ? 'n/a' : pc(median(rets)! - gas),
        per_POOL_median_NET_at_10usd: median(rets) === null ? 'n/a'
          : pc(median(rets)! - GAS_PCT_AT_10USD / 100),
        per_TOKEN_p25: pc(quant(tokMeds, 0.25)),
        per_TOKEN_MEDIAN: pc(median(tokMeds)),
        per_TOKEN_p75: pc(quant(tokMeds, 0.75)),
        per_TOKEN_median_NET_at_1usd: median(tokMeds) === null ? 'n/a'
          : pc(median(tokMeds)! - gas),
        per_TOKEN_median_NET_at_10usd: median(tokMeds) === null ? 'n/a'
          : pc(median(tokMeds)! - GAS_PCT_AT_10USD / 100),
        GAS_NOTE: `gas is an ABSOLUTE ~$0.193 round trip, so it is ${GAS_PCT_AT_1USD}% `
          + `of a $1 position and ${GAS_PCT_AT_10USD}% of a $10 one`,
        share_beating_gas: scored.length === 0 ? 'n/a'
          : pc(scored.filter((s) => s.ret > gas).length / scored.length),
        fee_tiers: Object.fromEntries([...g.reduce((m, r) =>
          m.set(r.fee ?? -1, (m.get(r.fee ?? -1) ?? 0) + 1), new Map<number, number>())
          .entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)),
      });
    }
    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('poolstrade-returns failed', errorFields(e)); process.exit(1); });
