/**
 * `npm run post-dump` — PART 7 STAGE 1: THE DUMP AS AN ANCHOR, AND WHAT FOLLOWS IT.
 *
 * Every pass so far entered at +15 s, which is **before** the one event that kills the
 * trade. §6O established that event: a single large sell, median 42.5% of supply, first
 * one landing at a median of 92 seconds. **Once it has happened it cannot happen again.**
 *
 * ===========================================================================
 * WHAT THIS BUYS, AND WHY IT IS ONE SWEEP PER POOL
 * ===========================================================================
 *
 * Everything else in Part 7 stage 1 is a free re-cut of stored tables. The one thing not
 * stored is **cumulative supply sold by a given second**, and that is precisely the
 * quantity an executable rule needs: at +90 s a bot can see what has ALREADY sold, and
 * cannot see what is coming. `bot_loss_anatomy` stores the biggest sell's size and time,
 * which is hindsight; this stores the running total, which is not.
 *
 * One sparse `eth_getLogs` per pool over 20 minutes: **379 x 60 CU = 22,740 CU ≈ $0.01.**
 *
 * **SELLS ARE COUNTED FROM THE SWAP'S TOKEN SIDE, NOT FROM AN IDENTITY.** §6O.1 records
 * what identity-guessing cost: attributing by `tx.from` inverted a whole finding, because
 * these traders route through a relayer. Token into the pool is token into the pool.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const CU_CEILING = 200_000;
const SUPPLY = 1e27;
const WINDOW = 12_150;
/** Seconds from init at which a live bot could read the cumulative figure. */
const MARKS = [30, 60, 90, 120, 180, 300];
/** A "large" sell. §6O: deep losers' biggest is 42.5% of supply, the rest 6.2%. */
const LARGE = 0.20;

interface Log { topics: string[]; data: string; blockNumber: string; transactionHash: string }
const sgn = (v: bigint): bigint => v >= (1n << 255n) ? v - (1n << 256n) : v;
const quant = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const pc = (x: number | null): string => x === null ? '   n/a' : `${(100 * x).toFixed(1)}%`;

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const inner = new RpcClient(RPC_URL.replace('{key}', key), 60_000, CU_CEILING);
  const rpc = new ReadOnlyRpc(inner);

  try {
    await c.query(`create table if not exists bot_sell_profile (
      chain text not null, pool_id text not null, init_block bigint not null,
      sold_30 numeric, sold_60 numeric, sold_90 numeric, sold_120 numeric,
      sold_180 numeric, sold_300 numeric, sold_total numeric,
      large_sells integer, first_large_s integer, last_large_s integer,
      biggest_s integer, biggest_share numeric,
      second_large_after_biggest boolean,
      measured_at timestamptz not null default now(),
      primary key (chain, pool_id)
    )`);

    const pools = (await c.query<{ pool_id: string; init_block: string }>(
      `select a.pool_id, a.init_block::text
         from bot_loss_anatomy a
         left join bot_sell_profile p on p.chain=a.chain and p.pool_id=a.pool_id
        where a.chain=$1 and p.pool_id is null order by a.init_block`, [CHAIN])).rows;

    log.info('PART 7 STAGE 1 — BEFORE THE FIRST PAID CALL', {
      pools_to_sweep: pools.length,
      estimate_cu: pools.length * 60,
      ceiling_cu: CU_CEILING,
      marks_seconds: MARKS,
      large_sell_threshold: `${100 * LARGE}% of supply`,
      why: 'cumulative supply sold BY a given second is the only quantity an executable '
        + 'rule can use — bot_loss_anatomy stores the biggest sell, which is hindsight',
    });

    let n = 0;
    for (const p of pools) {
      const ib = Number(p.init_block);
      let sw: Log[];
      try {
        sw = (await rpc.call('eth_getLogs', [{
          address: POOL_MANAGER, topics: [TOPICS.swapV4, p.pool_id],
          fromBlock: `0x${ib.toString(16)}`, toBlock: `0x${(ib + WINDOW).toString(16)}`,
        }])) as Log[];
      } catch { continue; }
      const sells = sw.map((x) => {
        const a1 = sgn(BigInt(`0x${x.data.slice(2).slice(64, 128)}`));
        return a1 < 0n
          ? { s: (Number(BigInt(x.blockNumber)) - ib) / 10, share: Number(-a1) / SUPPLY }
          : null;
      }).filter((x): x is { s: number; share: number } => x !== null)
        .sort((a, b) => a.s - b.s);

      const cum = (t: number): number => sells.filter((x) => x.s <= t)
        .reduce((a, x) => a + x.share, 0);
      const large = sells.filter((x) => x.share >= LARGE);
      const biggest = sells.reduce<{ s: number; share: number } | null>(
        (best, x) => best === null || x.share > best.share ? x : best, null);
      const secondAfter = biggest !== null
        && large.some((x) => x.s > biggest.s && x !== biggest);

      await c.query(
        `insert into bot_sell_profile (chain, pool_id, init_block, sold_30, sold_60,
           sold_90, sold_120, sold_180, sold_300, sold_total, large_sells,
           first_large_s, last_large_s, biggest_s, biggest_share, second_large_after_biggest)
         values ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7::numeric,$8::numeric,
                 $9::numeric,$10::numeric,$11,$12,$13,$14,$15::numeric,$16)
         on conflict do nothing`,
        [CHAIN, p.pool_id, ib, ...MARKS.map((m) => cum(m).toString()),
          cum(1e9).toString(), large.length,
          large.length ? Math.round(large[0]!.s) : null,
          large.length ? Math.round(large[large.length - 1]!.s) : null,
          biggest === null ? null : Math.round(biggest.s),
          biggest === null ? null : biggest.share.toString(), secondAfter]);
      n += 1;
      if (n % 60 === 0) log.info('progress', { pools: n, of: pools.length });
    }

    /* ================= FREE CUTS OVER STORED DATA ================= */
    const rows = (await c.query<Record<string, string | number | boolean | null>>(
      `select p.*, a.outcome::float8 as outcome, l.peak_mult::float8 as peak_mult,
              l.time_to_peak_s
         from bot_sell_profile p
         join bot_loss_anatomy a on a.chain=p.chain and a.pool_id=p.pool_id
         join bot_runner_label l on l.chain=p.chain and l.pool_id=p.pool_id
        where p.chain=$1`, [CHAIN])).rows;

    /* --- 1. RECONCILE THE TWO DEEP-LOSS FIGURES --- */
    const grid = (await c.query<{ grid_offset: number; n: string; deep: string }>(
      `select grid_offset, count(*)::text n,
              count(*) filter (where sell_executes = false
                or (eth_out - eth_in)/eth_in <= -0.70)::text deep
         from bot_trade_path where chain=$1 group by 1 order by 1`, [CHAIN])).rows;
    log.info('RECONCILIATION — the two deep-loss numbers are two HORIZONS', {
      note: '§6N quoted ~25% (p25 of an exit rule, i.e. the rule exits early); §6O quoted '
        + '80.5% (outcome held to the LAST grid point, 20 min). Same population.',
      by_horizon: grid.map((g) => `+${g.grid_offset} blk (${((150 + g.grid_offset) / 10).toFixed(0)}s)`
        + `  n=${g.n}  deep=${g.deep} (${(100 * Number(g.deep) / Number(g.n)).toFixed(1)}%)`),
    });

    /* --- 2. IS THE DUMPING OVER? --- */
    const ls = rows.map((r) => Number(r['large_sells'] ?? 0));
    const secondAfter = rows.filter((r) => r['second_large_after_biggest'] === true).length;
    log.info('IS THE DUMPING OVER ONCE THE BIGGEST SELL LANDS?', {
      n: rows.length,
      large_sells_per_launch: {
        p25: quant(ls, 0.25), median: quant(ls, 0.5), p75: quant(ls, 0.75),
        max: ls.length ? Math.max(...ls) : 0,
        zero_large_sells: ls.filter((x) => x === 0).length,
      },
      ANOTHER_large_sell_AFTER_the_biggest: `${secondAfter} of ${rows.length} `
        + `(${pc(secondAfter / rows.length)})`,
      first_large_sell_seconds: {
        p25: quant(rows.map((r) => Number(r['first_large_s'])).filter(Number.isFinite), 0.25),
        median: quant(rows.map((r) => Number(r['first_large_s'])).filter(Number.isFinite), 0.5),
        p75: quant(rows.map((r) => Number(r['first_large_s'])).filter(Number.isFinite), 0.75),
      },
    });

    /* --- 3. THE EXECUTABLE CONDITIONAL: what has ALREADY sold by T? --- */
    const out: string[] = [];
    out.push('mark   bucket                      n   deep%   med outcome   med peak   med t-peak');
    for (const m of MARKS) {
      const col = `sold_${m}`;
      for (const [bname, pred] of [
        ['already sold >= 25%', (v: number) => v >= 0.25],
        ['already sold  < 25%', (v: number) => v < 0.25],
      ] as Array<[string, (v: number) => boolean]>) {
        const g = rows.filter((r) => r[col] !== null && pred(Number(r[col])));
        if (g.length === 0) { out.push(`${String(m).padStart(4)}s  ${bname.padEnd(22)} RETURNED NO ROWS`); continue; }
        const o = g.map((r) => Number(r['outcome'])).filter(Number.isFinite);
        const pk = g.map((r) => Number(r['peak_mult'])).filter(Number.isFinite);
        const tp = g.map((r) => Number(r['time_to_peak_s'])).filter(Number.isFinite);
        out.push(`${String(m).padStart(4)}s  ${bname.padEnd(22)} ${String(g.length).padStart(4)} `
          + `${pc(o.filter((x) => x <= -0.70).length / o.length).padStart(7)} `
          + `${pc(quant(o, 0.5)).padStart(13)} `
          + `${pc((quant(pk, 0.5) ?? 1) - 1).padStart(10)} `
          + `${String(quant(tp, 0.5) ?? 'n/a').padStart(12)}`);
      }
    }
    log.info('THE EXECUTABLE CONDITIONAL — split on what has ALREADY sold by T', {
      note: 'this is knowable to a live bot at time T. "peak" is the §6K mid-price peak '
        + 'from a +15 s entry and is context, NOT a realisable return.',
      table: out,
    });
    log.info('CU SPENT', { cu: inner.cuSpent, ceiling: CU_CEILING });
  } finally { c.release(); await app.pool.end(); }
}

void main().catch((e: unknown) => { log.error('post-dump failed', errorFields(e)); process.exit(1); });
