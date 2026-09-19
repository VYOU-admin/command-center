/**
 * `npm run loser-tag` — 9A and 9B: WHAT DOES A LOSER LOOK LIKE AT THE MOMENT WE BUY?
 *
 * **The arithmetic that makes this the only question:** at entry 115 s / hold 100 s the
 * mean is +2.4% with a 12% deep-loss rate. Those 12% cost ~9.8 points of mean. Removing
 * them takes the mean to ~+12%. Every timing and partial-sell result in §8 moved the
 * answer by fractions of a point.
 *
 * ===========================================================================
 * TWO DISCIPLINES THAT DECIDE WHETHER THIS IS WORTH ANYTHING
 * ===========================================================================
 *
 * **1. IT IS A WITHIN-POPULATION QUESTION.** The comparison is deep losers against the
 * rest **among launches that already fire the §7 rule**. Comparing against launches the
 * rule rejects would rediscover the rule.
 *
 * **2. NOTHING AFTER +115 s MAY BE READ, AND THE STORED TABLES CONTAIN TRAPS.**
 * `bot_sell_profile` holds `sold_120`, `sold_180`, `sold_300` — all AFTER our entry —
 * and `bot_loss_anatomy` holds `biggest_share`/`biggest_s` measured over twenty minutes.
 * **Using any of them would be look-ahead**, so every feature here is recomputed from
 * blocks 0..1150 and the post-entry columns are not touched.
 *
 * ===========================================================================
 * 9B — THE OVERHANG, RECONSTRUCTED RATHER THAN INFERRED
 * ===========================================================================
 *
 * §6O found the loss is one large sell of a median 42.5% of supply. **If that supply is
 * sitting in a wallet at +115 s, it is visible before we buy.** Balances are rebuilt by
 * netting every ERC-20 `Transfer` of the token over blocks 0..1150 — one sparse
 * `eth_getLogs` per pool. That gives the largest non-pool holder exactly, with no
 * identity guessing of the kind §6O.1 records burning us.
 *
 * Total: 2 sweeps per pool, **379 x 2 x 60 CU = 45,480 CU ≈ $0.02.**
 */
import { AbiCoder } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const abi = AbiCoder.defaultAbiCoder();
const CU_CEILING = 300_000;
const SUPPLY = 1e27;
const ENTRY_BLOCKS = 1_150;   /* +115 s. NOTHING past this. */

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_entry_state (
      chain text not null, pool_id text not null, init_block bigint not null,
      sold_30 numeric, sold_60 numeric, sold_90 numeric, sold_115 numeric,
      n_sells integer, largest_sell numeric, secs_since_last_sell integer,
      buys_0_30 integer, buys_30_60 integer, buys_60_90 integer, buys_90_115 integer,
      sells_0_30 integer, sells_30_60 integer, sells_60_90 integer, sells_90_115 integer,
      eth_in_total numeric, eth_in_90_115 numeric, pool_eth numeric,
      price_mult_115 numeric, price_peak_mult numeric, faded_from_peak numeric,
      distinct_buyers integer, top_buyer_share numeric,
      top_holder_share numeric, top_holder_is_creator boolean,
      holders_over_5pct integer, creator_holds numeric,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    const pools = (await c.query<{ pool_id: string; init_block: string; token: string;
      creator: string | null }>(
      `select a.pool_id, a.init_block::text, l.token, f.creator
         from bot_loss_anatomy a
         join bot_runner_label l on l.chain=a.chain and l.pool_id=a.pool_id
         join bot_runner_features f on f.chain=a.chain and f.pool_id=a.pool_id
         left join bot_entry_state e on e.chain=a.chain and e.pool_id=a.pool_id
        where a.chain=$1 and e.pool_id is null order by a.init_block`, [CHAIN])).rows;

    log.info('9A/9B  BEFORE THE FIRST PAID CALL', {
      pools_to_do: pools.length,
      cutoff: `blocks 0..${ENTRY_BLOCKS} ONLY (+115 s)`,
      trap_avoided: 'bot_sell_profile.sold_120/180/300 and bot_loss_anatomy.biggest_* '
        + 'are all POST-ENTRY and are not read. Every feature is recomputed.',
      estimate_cu: pools.length * 2 * 60,
      ceiling_cu: CU_CEILING,
    });

    let n = 0;
    for (const p of pools) {
      const ib = Number(p.init_block);
      const hi = ib + ENTRY_BLOCKS;
      let sw: Log[]; let xf: Log[];
      try {
        sw = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, p.pool_id],
          fromBlock: `0x${ib.toString(16)}`, toBlock: `0x${hi.toString(16)}`,
        }])) as Log[];
        xf = (await rpc.call('eth_getLogs', [{
          address: p.token, topics: [TOPICS.transfer],
          fromBlock: `0x${ib.toString(16)}`, toBlock: `0x${hi.toString(16)}`,
        }])) as Log[];
      } catch { continue; }

      /* ---- from SWAPS: flow, price, depth ---- */
      let sold = 0; let nSells = 0; let largest = 0; let lastSell = -1;
      let ethIn = 0; let ethIn90 = 0; let poolEth = 0;
      const bucket = { b: [0, 0, 0, 0], s: [0, 0, 0, 0] };
      const buyerVol = new Map<string, number>();
      let p0: number | null = null; let pNow: number | null = null; let pPeak: number | null = null;
      for (const x of sw) {
        const d = x.data.slice(2);
        const a0 = sgn(BigInt(`0x${d.slice(0, 64)}`));
        const a1 = sgn(BigInt(`0x${d.slice(64, 128)}`));
        const sq = Number(BigInt(`0x${d.slice(128, 192)}`));
        const t = (Number(BigInt(x.blockNumber)) - ib) / 10;
        const bi = t < 30 ? 0 : t < 60 ? 1 : t < 90 ? 2 : 3;
        /* currency0 = native ETH on this population (§6J.1, 25 records). */
        poolEth += Number(-a0) / 1e18;
        if (a1 > 0n) {                       /* a BUY: token out of the pool */
          bucket.b[bi] = (bucket.b[bi] ?? 0) + 1;
          const e = Number(-a0) / 1e18;
          ethIn += e; if (t >= 90) ethIn90 += e;
          buyerVol.set(x.transactionHash, (buyerVol.get(x.transactionHash) ?? 0) + e);
        } else if (a1 < 0n) {                /* a SELL */
          bucket.s[bi] = (bucket.s[bi] ?? 0) + 1;
          const sh = Number(-a1) / SUPPLY;
          sold += sh; nSells += 1; if (sh > largest) largest = sh;
          if (t > lastSell) lastSell = t;
        }
        if (sq > 0) {
          if (p0 === null) p0 = sq;
          pNow = sq;
          /* value moves INVERSELY to sqrtPrice here; a LOWER sqrt = higher value. */
          if (pPeak === null || sq < pPeak) pPeak = sq;
        }
      }
      const cum = (t: number): number => {
        let a = 0;
        for (const x of sw) {
          const d = x.data.slice(2);
          const a1 = sgn(BigInt(`0x${d.slice(64, 128)}`));
          if (a1 >= 0n) continue;
          if ((Number(BigInt(x.blockNumber)) - ib) / 10 <= t) a += Number(-a1) / SUPPLY;
        }
        return a;
      };
      const mult = (a: number | null, b: number | null): number | null =>
        a === null || b === null || b <= 0 ? null : (a / b) ** 2;

      /* ---- from TRANSFERS: who still holds what ---- */
      const bal = new Map<string, number>();
      for (const x of xf) {
        const from = `0x${(x.topics[1] ?? '').slice(26)}`.toLowerCase();
        const to = `0x${(x.topics[2] ?? '').slice(26)}`.toLowerCase();
        const v = Number(BigInt(x.data)) / SUPPLY;
        bal.set(from, (bal.get(from) ?? 0) - v);
        bal.set(to, (bal.get(to) ?? 0) + v);
      }
      bal.delete(POOL_MANAGER);
      bal.delete('0x0000000000000000000000000000000000000000');
      const holders = [...bal.entries()].filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);
      const top = holders[0];
      const buyVols = [...buyerVol.values()].sort((a, b) => b - a);
      const totalBuy = buyVols.reduce((a, b) => a + b, 0);

      await c.query(
        `insert into bot_entry_state (chain, pool_id, init_block, sold_30, sold_60,
           sold_90, sold_115, n_sells, largest_sell, secs_since_last_sell,
           buys_0_30, buys_30_60, buys_60_90, buys_90_115,
           sells_0_30, sells_30_60, sells_60_90, sells_90_115,
           eth_in_total, eth_in_90_115, pool_eth, price_mult_115, price_peak_mult,
           faded_from_peak, distinct_buyers, top_buyer_share, top_holder_share,
           top_holder_is_creator, holders_over_5pct, creator_holds)
         values ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8,$9::numeric,
                 $10,$11,$12,$13,$14,$15,$16,$17,$18,$19::numeric,$20::numeric,
                 $21::numeric,$22::numeric,$23::numeric,$24::numeric,$25,$26::numeric,
                 $27::numeric,$28,$29,$30::numeric)
         on conflict do nothing`,
        [CHAIN, p.pool_id, ib, cum(30).toString(), cum(60).toString(),
          cum(90).toString(), sold.toString(), nSells, largest.toString(),
          lastSell < 0 ? null : Math.round(115 - lastSell),
          bucket.b[0], bucket.b[1], bucket.b[2], bucket.b[3],
          bucket.s[0], bucket.s[1], bucket.s[2], bucket.s[3],
          ethIn.toString(), ethIn90.toString(), poolEth.toString(),
          (mult(p0, pNow) ?? 1).toString(), (mult(p0, pPeak) ?? 1).toString(),
          /* how far it has FADED from its own peak by entry: 1 = at the peak */
          (pPeak !== null && pNow !== null && pNow > 0
            ? ((pPeak / pNow) ** 2) : 1).toString(),
          buyVols.length, (totalBuy > 0 ? (buyVols[0] ?? 0) / totalBuy : 0).toString(),
          top === undefined ? null : top[1].toString(),
          top === undefined ? null : (top[0] === p.creator),
          holders.filter(([, v]) => v > 0.05).length,
          p.creator === null ? null : Math.max(0, bal.get(p.creator) ?? 0).toString()]);
      n += 1;
      if (n % 40 === 0) log.info('progress', { pools: n, of: pools.length });
    }
    log.info('ENTRY-STATE EXTRACTION DONE', { done: n, cu: inner.cuSpent,
      next: 'npm run loser-separate — evaluation is FREE' });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('loser-tag failed', errorFields(e)); process.exit(1); });
