/**
 * `npm run p13-collect` — PART 13: SCORE THE COMMITTED RULE ON DATA THAT DID NOT EXIST.
 *
 * The rule is `docs/NAMED-RULE-P10.md` section P11, committed at `dc26b02`, plus the
 * liquidity floor from §7. **Nothing here may adjust it.**
 *
 * ```
 * GATE 1     creator_share >= 40%                 (read from the launch block)
 * GATE 2     cumulative supply sold by +90 s < 25%
 * UNTOUCHED  n_sells == 0  AND  eth_in_total <= 3.6931 ETH   (absolute, NOT a percentile)
 * FLOOR      pool_eth > 0
 * ENTRY +115 s     EXIT +215 s     unconditional
 * ```
 *
 * ===========================================================================
 * V2 — WHY EVERY LAUNCH IS PRICED, NOT ONLY THE QUALIFYING ONES
 * ===========================================================================
 *
 * V1 priced only launches that passed all four conditions, to save compute. §6Y.4
 * records what that cost: **refutation conditions 1 and 2 both compare UNTOUCHED
 * against the rest of the sample, and the rest of the sample was never priced**, so
 * they were uncomputable no matter how long collection ran. A collector that cannot
 * score its own rule is not a saving.
 *
 * So this prices **every canonical launch**. Three things become answerable:
 *
 * 1. Conditions 1 and 2, against the correct comparison arm. §6U.5 and `loser-tag.ts`
 *    fix that arm as the **gated** population — UNTOUCHED against gated-not-untouched.
 *    Comparing against launches the gates reject would rediscover the gates.
 * 2. **The liquidity-floor threshold (§6Y.3, an open §7 defect).** `pool_eth > 0`
 *    rejected 0 of 178 while 24 UNTOUCHED launches sat at a median 0.0018 ETH. The
 *    floor must become an absolute minimum, and setting it needs the returns of those
 *    dust pools — which requires pricing launches the rule rejects.
 * 3. The §6W inversion (UNTOUCHED outside the gate) re-checked out of time.
 *
 * Cost: ~290 CU per launch against ~250 canonical launches/day = ~72,500 CU/day, about
 * $0.036/day. The v1 saving was not worth the blindness.
 *
 * ===========================================================================
 * THE DISCIPLINES
 * ===========================================================================
 *
 * - **START_BLOCK is pinned**; never derived from head. Every launch postdates the rule.
 * - **The pool struct is STORED**, so a row can be re-priced later without re-deriving
 *   it. V1 stored only the token, which is why the 174 unpriced rows need an Initialize
 *   re-fetch once.
 * - **`price_attempted` separates "priced and failed" from "never tried".** A null
 *   return means nothing on its own; §7's rule that an error path must never emit a
 *   plausible default applies to absence as much as to value.
 * - **Two work sets per cycle: the backlog first, then new launches.** The backlog is
 *   finite and shrinks; new launches are unbounded. Doing the backlog first means an
 *   interrupted night still closes the known gap.
 * - **A launch is processed only once its exit block exists** (`to = head - EXIT - 3000`).
 * - **Every row is committed as it is produced.**
 * - **The sell uses a REACHABLE bound through `simulateSellAt`** (§6A.3).
 * - This process NEVER trades. It only reads and prices.
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
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const SUPPLY = 1e27;
const CU_CEILING = 150_000;
/** PINNED: the `to` block of the Part 12 run. Everything after this is genuinely new. */
const START_BLOCK = 67_493_776;
/** THE RULE. Frozen. */
const GATE1_SHARE = 0.40;
const GATE2_SOLD = 0.25;
const UNTOUCHED_ETH = 3.6931;
const GATE2_AT_BLOCKS = 900;
const ENTRY_BLOCKS = 1_150;
const EXIT_BLOCKS = 2_150;
const SIZE_WEI = 562_000_000_000_000n;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
interface Pool { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;
const addrTopic = (t: string): string => `0x${t.slice(26)}`.toLowerCase();

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

/** Entry + exit at a REACHABLE bound. Returns null ONLY when the buy itself could
 *  not be priced; an unsellable exit is -1 (a total loss), never 0. */
async function priceRoundTrip(
  rpc: ReadOnlyRpc, owner: string, pool: Pool, token: string, ib: number, zeroIsPricing: boolean,
): Promise<{ entryOk: boolean; exitOk: boolean; exitOut: bigint | null; ret: number | null }> {
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
  if (tokensOut === null) return { entryOk: false, exitOk: false, exitOut: null, ret: null };
  let exitOk = false; let exitOut: bigint | null = null;
  try {
    const s = await simulateSellAt(rpc, { pool, token, owner, amount: tokensOut,
      zeroForOneBuy: zeroIsPricing, block: `0x${(ib + EXIT_BLOCKS).toString(16)}` });
    exitOk = s.executes === true; exitOut = s.ethOut;
  } catch { exitOk = false; }
  const ret = exitOk && exitOut !== null
    ? Number(exitOut - SIZE_WEI) / Number(SIZE_WEI) : -1;
  return { entryOk: true, exitOk, exitOut, ret };
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
    await c.query(`create table if not exists bot_p13 (
      chain text not null, pool_id text not null, init_block bigint not null,
      token text, creator_share numeric, sold_90 numeric,
      gate1 boolean, gate2 boolean, n_sells integer, eth_in_total numeric,
      pool_eth numeric, untouched boolean, liq_ok boolean, qualified boolean,
      entry_ok boolean, exit_ok boolean, ret numeric,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);
    /* v2 columns. The pool struct is stored so a row can be re-priced without
       re-deriving it; `price_attempted` separates "tried and failed" from "never tried". */
    for (const col of ['currency0 text', 'currency1 text', 'fee integer',
      'tick_spacing integer', 'hooks text', 'zero_is_pricing boolean',
      'price_attempted boolean not null default false']) {
      await c.query(`alter table bot_p13 add column if not exists ${col}`);
    }
    /* Rows v1 actually priced were exactly the qualifying ones. */
    const marked = await c.query(
      `update bot_p13 set price_attempted = true
        where chain=$1 and qualified and not price_attempted`, [CHAIN]);
    if ((marked.rowCount ?? 0) > 0) {
      log.info('v1 rows marked as already priced', { rows: marked.rowCount });
    }

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    const to = head - (EXIT_BLOCKS + 3_000);

    /* ---------- WORK SET 1: the backlog, finite and shrinking ---------- */
    const backlog = (await c.query<{ pool_id: string; init_block: string; token: string;
      currency0: string | null }>(
      `select pool_id, init_block::text, token, currency0 from bot_p13
        where chain=$1 and not price_attempted and init_block <= $2
        order by init_block`, [CHAIN, to])).rows;

    let bDone = 0; let bFail = 0;
    for (const r of backlog) {
      const ib = Number(r.init_block);
      let pool: Pool | null = null; let zeroIsPricing = false; let token = r.token;
      try {
        const il = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.initializeV4, r.pool_id],
          fromBlock: `0x${ib.toString(16)}`, toBlock: `0x${ib.toString(16)}`,
        }])) as Log[];
        if (il.length === 0) { bFail += 1; continue; }
        const l = il[0]!;
        const c0 = addrTopic(l.topics[2] ?? '');
        const c1 = addrTopic(l.topics[3] ?? '');
        const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
          unknown as [bigint, bigint, string, bigint, bigint];
        pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
          tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
        zeroIsPricing = PRICING.includes(c0);
        token = zeroIsPricing ? c1 : c0;
      } catch (err) {
        bFail += 1;
        log.warn('backlog: Initialize re-fetch failed, row left unpriced', {
          pool_id: r.pool_id, ...errorFields(err) });
        continue;
      }
      const p = await priceRoundTrip(rpc, owner, pool, token, ib, zeroIsPricing);
      await c.query(
        `update bot_p13 set currency0=$3, currency1=$4, fee=$5, tick_spacing=$6, hooks=$7,
            zero_is_pricing=$8, entry_ok=$9, exit_ok=$10, ret=$11::numeric,
            price_attempted=true, measured_at=now()
          where chain=$1 and pool_id=$2`,
        [CHAIN, r.pool_id, pool.currency0, pool.currency1, pool.fee, pool.tickSpacing,
          pool.hooks, zeroIsPricing, p.entryOk, p.exitOk,
          p.ret === null ? null : p.ret.toString()]);
      bDone += 1;
    }
    if (backlog.length > 0) {
      log.info('backlog pass done', { attempted: backlog.length, priced: bDone,
        could_not_reprice: bFail, remaining: backlog.length - bDone - bFail });
    }

    /* ---------- WORK SET 2: new launches ---------- */
    const hi = (await c.query<{ m: string | null }>(
      `select max(init_block)::text m from bot_p13 where chain=$1`, [CHAIN])).rows[0]?.m;
    const from = hi === null || hi === undefined ? START_BLOCK : Number(hi) + 1;
    if (to <= from) {
      log.info('P13 cycle: no matured new blocks', { from, to, head, backlog_priced: bDone });
      return;
    }

    const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
      from, to, 400_000);
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
    const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      from, to, 40_000);
    const canon = inits.filter((l) => ptTxs.has(l.transactionHash.toLowerCase())
      && PRICING.includes(addrTopic(l.topics[2] ?? '')) !== PRICING.includes(addrTopic(l.topics[3] ?? '')))
      .sort((a, b) => Number(BigInt(a.blockNumber)) - Number(BigInt(b.blockNumber)));

    let seen = 0; let g1 = 0; let g2 = 0; let un = 0; let qual = 0; let priced = 0;
    for (const l of canon) {
      const pid = (l.topics[1] ?? '').toLowerCase();
      const c0 = addrTopic(l.topics[2] ?? '');
      const c1 = addrTopic(l.topics[3] ?? '');
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool: Pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) continue;
      const zeroIsPricing = PRICING.includes(c0);
      const token = zeroIsPricing ? c1 : c0;
      const ib = Number(BigInt(l.blockNumber));
      seen += 1;

      let share = 0; let sold90 = 0; let nSells = 0; let ethIn = 0; let poolEth = 0;
      try {
        const sw = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, pid],
          fromBlock: `0x${ib.toString(16)}`,
          toBlock: `0x${(ib + ENTRY_BLOCKS).toString(16)}`,
        }])) as Log[];
        for (const x of sw) {
          const z = x.data.slice(2);
          const a0 = sgn(BigInt(`0x${z.slice(0, 64)}`));
          const a1 = sgn(BigInt(`0x${z.slice(64, 128)}`));
          const off = Number(BigInt(x.blockNumber)) - ib;
          poolEth += Number(-a0) / 1e18;
          if (a1 > 0n) {
            if (off === 0) share += Number(a1) / SUPPLY;
            ethIn += Number(-a0) / 1e18;
          } else if (a1 < 0n) {
            nSells += 1;
            if (off <= GATE2_AT_BLOCKS) sold90 += Number(-a1) / SUPPLY;
          }
        }
      } catch (err) {
        log.warn('P13: swap sweep failed, launch skipped and NOT stored', {
          pool_id: pid, init_block: ib, ...errorFields(err) });
        continue;
      }

      const gate1 = share >= GATE1_SHARE;
      const gate2 = sold90 < GATE2_SOLD;
      const untouched = nSells === 0 && ethIn <= UNTOUCHED_ETH;
      const liqOk = poolEth > 0;
      const qualified = gate1 && gate2 && untouched && liqOk;
      if (gate1) g1 += 1;
      if (gate2) g2 += 1;
      if (untouched) un += 1;
      if (qualified) qual += 1;

      /* V2: price EVERY launch, so the comparison arm exists (§6Y.4). */
      const p = await priceRoundTrip(rpc, owner, pool, token, ib, zeroIsPricing);
      priced += 1;

      await c.query(
        `insert into bot_p13 (chain, pool_id, init_block, token, creator_share, sold_90,
           gate1, gate2, n_sells, eth_in_total, pool_eth, untouched, liq_ok, qualified,
           entry_ok, exit_ok, ret, currency0, currency1, fee, tick_spacing, hooks,
           zero_is_pricing, price_attempted)
         values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9,$10::numeric,$11::numeric,
                 $12,$13,$14,$15,$16,$17::numeric,$18,$19,$20,$21,$22,$23,true)
         on conflict do nothing`,
        [CHAIN, pid, ib, token, share.toString(), sold90.toString(), gate1, gate2,
          nSells, ethIn.toString(), poolEth.toString(), untouched, liqOk, qualified,
          p.entryOk, p.exitOk, p.ret === null ? null : p.ret.toString(),
          pool.currency0, pool.currency1, pool.fee, pool.tickSpacing, pool.hooks,
          zeroIsPricing]);
    }

    log.info('P13 cycle done', {
      window: `${from}..${to}`, canonical_seen: seen,
      gate1_passed: g1, gate2_passed: g2, untouched: un,
      QUALIFIED: qual, priced_new: priced, priced_backlog: bDone,
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => {
  log.error('p13-collect failed', errorFields(e)); process.exit(1);
});
