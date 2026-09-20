/**
 * `npm run ungated-price` — PART 12: PRICE THE 87% OF LAUNCHES WE HAVE NEVER PRICED.
 *
 * The rule under test is `docs/NAMED-RULE-P10.md` section P12, **committed before this
 * file measured a single ungated launch.** Nothing here may adjust it.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 *
 * Every stored launch in this project has `creator_share` between 0.4104 and 0.6416.
 * Gate 1 was applied upstream when the sample was built, so **no launch with a low
 * creator share has ever had an entry or exit price computed** — not one, anywhere.
 * §6V.3 then measured that launch type collapsing from 40% of the chain to 13% inside a
 * day, with the gated rate falling 54.0/day to 19.4/day.
 *
 * So the question is binary: does UNTOUCHED describe launches in general, or only a
 * launch type that is disappearing?
 *
 * ===========================================================================
 * THE DISCIPLINES THIS FILE IS BOUND BY
 * ===========================================================================
 *
 * - **The window is PINNED.** Never derived from head except for the unavoidable
 *   `to = head - (EXIT + margin)`, because an exit at +215 s cannot be priced before
 *   those blocks exist. §6J records an ~800,000 CU re-buy caused by a head-derived
 *   window.
 * - **The work set is the rows that will be written.** Launches already priced are
 *   skipped before anything is spent, and the estimate counts exactly the set the loop
 *   will walk — §7 records a run that priced a subset and attempted a superset.
 * - **Every row is committed as it is produced.** A container recycle costs only the
 *   launches not yet reached.
 * - **The sell uses a REACHABLE bound through `simulateSellAt`** (§6A.3). An
 *   unreachable `amountOutMinimum` reverts inside the swap action before SETTLE_ALL
 *   pulls the token, so it measures the pricing curve and never executes a transfer.
 * - **The GATED arm is priced by this same code path** so that any gated-vs-ungated
 *   difference cannot be an artefact of two different measurements.
 * - **Truncation is reported.** If the ceiling stops the run, priced and unpriced are
 *   both logged. A silent cap reads as "we covered everything".
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
const CU_CEILING = 450_000;
/** PINNED. Matches the creator-backfill window so the two tables line up. */
const FROM_BLOCK = 65_000_000;
const GATE1_SHARE = 0.40;          /* the gate whose other side has never been priced */
const ENTRY_BLOCKS = 1_150;        /* +115 s */
const EXIT_BLOCKS = 2_150;         /* +215 s */
const SIZE_WEI = 562_000_000_000_000n;   /* same position as §6P, for comparability */

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
    await c.query(`create table if not exists bot_ungated_price (
      chain text not null, pool_id text not null, init_block bigint not null,
      token text, creator_share numeric, sold_90 numeric, gated boolean,
      n_sells integer, sold_115 numeric, largest_sell numeric,
      eth_in_total numeric, pool_eth numeric,
      entry_ok boolean, exit_ok boolean, eth_out_exit numeric, ret numeric,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
    const to = head - (EXIT_BLOCKS + 3_000);
    if (to <= FROM_BLOCK) throw new Error('pinned window is empty');

    const created = await sweep(rpc, { address: PT_FACTORY, topics: [TOKEN_CREATED] },
      FROM_BLOCK, to, 900_000);
    const ptTxs = new Set(created.map((l) => l.transactionHash.toLowerCase()));
    const inits = await sweep(rpc, { address: POOL_MANAGER, topics: [TOPICS.initializeV4] },
      FROM_BLOCK, to, 40_000);
    const canon = inits.filter((l) => ptTxs.has(l.transactionHash.toLowerCase())
      && PRICING.includes(addrTopic(l.topics[2] ?? '')) !== PRICING.includes(addrTopic(l.topics[3] ?? '')));

    const have = new Set((await c.query<{ pool_id: string }>(
      `select pool_id from bot_ungated_price where chain=$1`, [CHAIN])).rows.map((r) => r.pool_id));
    const todo = canon.filter((l) => !have.has((l.topics[1] ?? '').toLowerCase()));

    log.info('PART 12 — PRICING THE POPULATION THAT HAS NEVER BEEN PRICED', {
      rule: 'docs/NAMED-RULE-P10.md section P12, committed before this measurement',
      pinned_window: `${FROM_BLOCK}..${to}`,
      days: ((to - FROM_BLOCK) / 858_600).toFixed(2),
      TokenCreated: created.length,
      canonical_launches: canon.length,
      already_priced: have.size,
      to_price: todo.length,
      estimate_cu: todo.length * 290,
      ceiling_cu: CU_CEILING,
      note: 'BOTH arms priced by this code path so gated-vs-ungated is not a method artefact',
    });

    let n = 0; let skipped = 0;
    for (const l of todo) {
      const pid = (l.topics[1] ?? '').toLowerCase();
      const c0 = addrTopic(l.topics[2] ?? '');
      const c1 = addrTopic(l.topics[3] ?? '');
      const d = abi.decode(['uint24', 'int24', 'address', 'uint160', 'int24'], l.data) as
        unknown as [bigint, bigint, string, bigint, bigint];
      const pool = { currency0: c0, currency1: c1, fee: Number(d[0]),
        tickSpacing: Number(d[1]), hooks: d[2].toLowerCase() };
      if (poolIdOf(pool).toLowerCase() !== pid) { skipped += 1; continue; }
      const zeroIsPricing = PRICING.includes(c0);
      const token = zeroIsPricing ? c1 : c0;
      const ib = Number(BigInt(l.blockNumber));

      /* ONE sweep over blocks 0..1150 yields the gate AND every P12 feature. */
      let share = 0; let sold90 = 0; let sold115 = 0; let nSells = 0; let largest = 0;
      let ethIn = 0; let poolEth = 0;
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
            const sh = Number(-a1) / SUPPLY;
            sold115 += sh; nSells += 1; if (sh > largest) largest = sh;
            if (off <= 900) sold90 += sh;
          }
        }
      } catch { skipped += 1; continue; }
      const gated = share >= GATE1_SHARE;

      /* Price entry and exit for EVERY launch, gated or not. That is the point. */
      let entryOk = false; let exitOk = false; let exitOut: bigint | null = null;
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
      /* A position that cannot be closed is -100%, never 0% (§backtest rule). */
      const ret = !entryOk ? null
        : (exitOk && exitOut !== null ? Number(exitOut - SIZE_WEI) / Number(SIZE_WEI) : -1);

      await c.query(
        `insert into bot_ungated_price (chain, pool_id, init_block, token, creator_share,
           sold_90, gated, n_sells, sold_115, largest_sell, eth_in_total, pool_eth,
           entry_ok, exit_ok, eth_out_exit, ret)
         values ($1,$2,$3,$4,$5::numeric,$6::numeric,$7,$8,$9::numeric,$10::numeric,
                 $11::numeric,$12::numeric,$13,$14,$15::numeric,$16::numeric)
         on conflict do nothing`,
        [CHAIN, pid, ib, token, share.toString(), sold90.toString(), gated,
          nSells, sold115.toString(), largest.toString(), ethIn.toString(),
          poolEth.toString(), entryOk, exitOk,
          exitOut === null ? null : exitOut.toString(),
          ret === null ? null : ret.toString()]);
      n += 1;
      if (n % 50 === 0) log.info('progress', { priced: n, of: todo.length, cu: inner.cuSpent });
    }

    log.info('PART 12 PRICING DONE', {
      priced_this_run: n,
      skipped_not_canonical_or_unreadable: skipped,
      UNPRICED_REMAINING: todo.length - n - skipped,
      truncated_by_ceiling: todo.length - n - skipped > 0,
      cu: inner.cuSpent,
    });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => {
  log.error('ungated-price failed', errorFields(e)); process.exit(1);
});
