/**
 * `npm run p13-collect` — PART 13: SCORE THE COMMITTED RULE ON DATA THAT DID NOT EXIST.
 *
 * The rule is `docs/NAMED-RULE-P10.md` section P11, committed at `dc26b02`, plus the
 * hard liquidity floor added to §7 after Part 12. **Nothing here may adjust it.**
 *
 * ```
 * GATE 1     creator_share >= 40%                 (read from the launch block)
 * GATE 2     cumulative supply sold by +90 s < 25%
 * UNTOUCHED  n_sells == 0  AND  eth_in_total <= 3.6931 ETH   (absolute, NOT a percentile)
 * FLOOR      pool_eth > 0                         (§6W.3: empty pools are -100%, 94% unsellable)
 * ENTRY +115 s     EXIT +215 s     unconditional
 * ```
 *
 * ===========================================================================
 * THE DISCIPLINES
 * ===========================================================================
 *
 * - **START_BLOCK is pinned at the end of the Part 12 window.** Every launch this file
 *   sees is one that did not exist when the rule was written. Not derived from head.
 * - **EVERY canonical launch is stored, not only the qualifying ones**, so the
 *   gate-by-gate funnel is a measurement rather than a guess. Gate evaluation costs one
 *   `eth_getLogs` per launch; the expensive entry/exit pricing runs ONLY for launches
 *   that pass every condition. §7 records a run that priced a subset and estimated a
 *   superset.
 * - **A launch is only processed once its exit block exists.** `to = head - (EXIT +
 *   margin)`, and the resume point is the highest stored `init_block`, so an immature
 *   launch is picked up on a later cycle instead of being stored unpriced and skipped
 *   forever.
 * - **Every row is committed as it is produced.** This runs unattended overnight; a
 *   crash must cost one launch, not a night.
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
const CU_CEILING = 120_000;              /* per invocation; the loop runs many times */
/** PINNED: the `to` block of the Part 12 run. Everything after this is genuinely new. */
const START_BLOCK = 67_493_776;
/** THE RULE. Frozen. See docs/NAMED-RULE-P10.md section P11 and §7. */
const GATE1_SHARE = 0.40;
const GATE2_SOLD = 0.25;
const UNTOUCHED_ETH = 3.6931;
const GATE2_AT_BLOCKS = 900;
const ENTRY_BLOCKS = 1_150;
const EXIT_BLOCKS = 2_150;
const SIZE_WEI = 562_000_000_000_000n;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
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

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    const to = head - (EXIT_BLOCKS + 3_000);
    const hi = (await c.query<{ m: string | null }>(
      `select max(init_block)::text m from bot_p13 where chain=$1`, [CHAIN])).rows[0]?.m;
    const from = hi === null || hi === undefined ? START_BLOCK : Number(hi) + 1;
    if (to <= from) {
      log.info('P13 cycle: no matured blocks yet', { from, to, head });
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
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
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

      let entryOk = false; let exitOk = false; let exitOut: bigint | null = null;
      if (qualified) {
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
        priced += 1;
      }
      /* A position that cannot be closed is -100%, never 0%. */
      const ret = !qualified || !entryOk ? null
        : (exitOk && exitOut !== null ? Number(exitOut - SIZE_WEI) / Number(SIZE_WEI) : -1);

      await c.query(
        `insert into bot_p13 (chain, pool_id, init_block, token, creator_share, sold_90,
           gate1, gate2, n_sells, eth_in_total, pool_eth, untouched, liq_ok, qualified,
           entry_ok, exit_ok, ret)
         values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9,$10::numeric,$11::numeric,
                 $12,$13,$14,$15,$16,$17::numeric)
         on conflict do nothing`,
        [CHAIN, pid, ib, token, share.toString(), sold90.toString(), gate1, gate2,
          nSells, ethIn.toString(), poolEth.toString(), untouched, liqOk, qualified,
          entryOk, exitOk, ret === null ? null : ret.toString()]);
    }

    log.info('P13 cycle done', {
      window: `${from}..${to}`, canonical_seen: seen,
      gate1_passed: g1, gate2_passed: g2, untouched: un,
      QUALIFIED: qual, priced: priced, cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => {
  log.error('p13-collect failed', errorFields(e)); process.exit(1);
});
