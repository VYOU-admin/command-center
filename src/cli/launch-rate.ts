/**
 * `npm run launch-rate` — 3A.iv, THE DISCREPANCY THE BRIEF SAYS TO RESOLVE FIRST.
 *
 * One source says launches arrive "a few dozen a week" on the launchpads. Our bot saw
 * 200–480 qualifying launches a day. **Both cannot describe the same population**, and
 * everything downstream in Part 3 depends on which is right.
 *
 * `launchpad-survey` already settled half of it: the NOXA factory at 0xD9eC2db5…FCcB
 * launched 60,142 tokens across 26 days and **its last launch was block 6,880,646,
 * 2026-07-11 — sixty-nine days before this ran.** It is not a slow launchpad. It is a
 * dead one, and a claim about "a few dozen a week" on it describes nothing current.
 *
 * This measures the live population three ways, and the first two cost NOTHING because
 * the data is already stored:
 *
 *   1. **Every v4 pool initialization per day**, from `v4_pool_init` joined to
 *      `block_times`. This is the raw population our bot watches.
 *   2. **The subset whose counter side is a recognised pricing asset** — the first gate
 *      our rule applies, and the only one computable without reading swaps.
 *   3. **The launchpad our bot's own trades actually came from**, swept directly, to
 *      establish whether IT is still producing launches.
 *
 * **WHY 1 AND 2 ARE BOTH REPORTED.** Reporting only the raw count would overstate what
 * the bot acts on; reporting only the qualifying count would hide how much of the
 * chain's launch traffic is not even addressable. The brief asks which population each
 * claim describes, and that needs both numbers.
 *
 * **THE COVERAGE LIMIT IS STATED WITH THE RESULT, per the v4_swaps_all trap this
 * project has already been caught by twice.** `v4_pool_init` stops at 64,216,286 and
 * `block_times` is not complete over every block, so a day with no row here is a day
 * with no COVERAGE and not a day with no launches. Both are counted and reported.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

/** From ROBINHOOD.md section 4, step 4. Read there, not invented here. */
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', /* WETH */
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168', /* USDG */
  '0x0000000000000000000000000000000000000000', /* native ETH */
];

/** The launchpad 61 of our 130 rows actually came from, and the one ROBINHOOD.md
 * section 8 identifies as this chain's dominant one. NOT NOXA. */
const LIVE_LAUNCHPAD = '0x58daec3116aae6d93017baaea7749052e8a04fa7';

async function sweepCount(
  rpc: ReadOnlyRpc, address: string, from: number, to: number,
): Promise<{ logs: number; first: number | null; last: number | null; days: Map<string, number> }> {
  let cursor = from; let span = 2_000_000; let total = 0;
  let first: number | null = null; let last: number | null = null;
  const days = new Map<string, number>();
  while (cursor <= to) {
    const end = Math.min(cursor + span - 1, to);
    try {
      const got = (await rpc.call('eth_getLogs', [{
        address, fromBlock: `0x${cursor.toString(16)}`, toBlock: `0x${end.toString(16)}`,
      }])) as Array<{ blockNumber: string; blockTimestamp?: string }>;
      total += got.length;
      for (const g of got) {
        const b = Number(BigInt(g.blockNumber));
        if (first === null || b < first) first = b;
        if (last === null || b > last) last = b;
        if (g.blockTimestamp !== undefined) {
          const d = new Date(Number(BigInt(g.blockTimestamp)) * 1000).toISOString().slice(0, 10);
          days.set(d, (days.get(d) ?? 0) + 1);
        }
      }
      cursor = end + 1;
      if (got.length < 3_000) span = Math.min(span * 2, 4_000_000);
    } catch (err) {
      if (!/exceed|limit|response size/i.test((err as Error).message)) throw err;
      span = Math.max(Math.floor(span / 4), 5_000);
    }
  }
  return { logs: total, first, last, days };
}

async function main(): Promise<void> {
  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60_000, 1_000_000));

  try {
    const head = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));

    /* ---- 1 + 2. THE STORED POPULATION, FREE ------------------------------ */
    const rows = (await c.query<{ d: string; all_pools: string; priced: string }>(
      `select to_char(bt.block_time, 'YYYY-MM-DD') as d,
              count(*)::text as all_pools,
              count(*) filter (
                where lower(i.currency0) = any($2) or lower(i.currency1) = any($2)
              )::text as priced
         from v4_pool_init i
         join block_times bt
           on bt.chain = i.chain and bt.block_number = i.block_number
        where i.chain = $1
        group by 1 order by 1`, [CHAIN, PRICING])).rows;

    const cover = (await c.query<{ total: string; dated: string; lo: string; hi: string }>(
      `select count(*)::text as total,
              count(bt.block_number)::text as dated,
              min(i.block_number)::text as lo, max(i.block_number)::text as hi
         from v4_pool_init i
         left join block_times bt
           on bt.chain = i.chain and bt.block_number = i.block_number
        where i.chain = $1`, [CHAIN])).rows[0];

    const allCounts = rows.map((r) => Number(r.all_pools)).sort((a, b) => a - b);
    const priCounts = rows.map((r) => Number(r.priced)).sort((a, b) => a - b);
    const med = (xs: number[]): number | null =>
      xs.length === 0 ? null : xs[Math.floor(xs.length / 2)]!;

    log.info('3A.iv  v4 POOL INITIALIZATIONS PER DAY — THE POPULATION OUR BOT WATCHES', {
      /* COVERAGE FIRST, because a day absent here is a day with no data and not a
       * day with no launches. That distinction has cost this project twice. */
      coverage: {
        v4_pool_init_rows: cover?.total,
        rows_with_a_stored_block_time: cover?.dated,
        undated_rows_EXCLUDED_from_every_figure_below:
          Number(cover?.total ?? 0) - Number(cover?.dated ?? 0),
        block_range_of_the_table: `${cover?.lo} .. ${cover?.hi}`,
        chain_head_now: head,
        blocks_past_the_table_NOT_COVERED: head - Number(cover?.hi ?? 0),
      },
      days_with_coverage: rows.length,
      ALL_pools_per_day_median: med(allCounts),
      ALL_pools_per_day_max: allCounts[allCounts.length - 1] ?? null,
      pools_against_a_PRICING_ASSET_per_day_median: med(priCounts),
      pools_against_a_PRICING_ASSET_per_day_max: priCounts[priCounts.length - 1] ?? null,
      last_10_days: rows.slice(-10).map((r) => `${r.d} all=${r.all_pools} priced=${r.priced}`),
    });

    /*
     * ---- 3. IS THE LIVE LAUNCHPAD STILL LAUNCHING? ------------------------
     *
     * **BOUNDED TO A RECENT WINDOW ON PURPOSE.** The first version of this swept the
     * launchpad from block 0, and that is a genuinely different job: it is a BUSY
     * contract, so every request hits the result cap, the span floors at 5,000 blocks,
     * and covering 66 million blocks becomes ~13,000 requests. It was still crawling
     * when the session timed out.
     *
     * The question does not need it. "Is this launchpad alive and at what rate" is
     * answered by a recent window; "when did it start" is not decision-relevant and the
     * NOXA survey already shows what a DEAD launchpad looks like. So this reads the
     * last `WINDOW_BLOCKS` and says so, rather than quoting a lifetime figure it did
     * not measure.
     */
    const WINDOW_BLOCKS = 900_000;   /* ~25 hours at the measured 10 blocks/s */
    const padFrom = Math.max(0, head - WINDOW_BLOCKS);
    const pad = await sweepCount(rpc, LIVE_LAUNCHPAD, padFrom, head);
    const padDays = [...pad.days.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
    const padCounts = padDays.map((d) => d[1]).sort((a, b) => a - b);

    log.info('3A.i  THE LAUNCHPAD OUR OWN TRADES CAME FROM — IS IT ALIVE?', {
      launchpad: LIVE_LAUNCHPAD,
      note: '61 of our 130 bot_trades rows carry this as the Initialize target; '
        + 'ROBINHOOD.md section 8 already identified it as this chain\'s dominant '
        + 'launchpad. It is NOT the NOXA factory the brief named.',
      WINDOW_MEASURED: `${padFrom} .. ${head} (${WINDOW_BLOCKS} blocks, ~25 h)`,
      caveat: 'a RECENT WINDOW, not the launchpad\'s lifetime — see the comment',
      logs_in_window: pad.logs,
      first_log_block_in_window: pad.first ?? 'NONE — zero logs in 25 hours',
      last_log_block: pad.last ?? 'NONE',
      blocks_since_its_last_log: pad.last === null ? 'n/a' : head - pad.last,
      active_days_in_window: padDays.length,
      logs_per_day_median: padCounts.length === 0 ? null
        : padCounts[Math.floor(padCounts.length / 2)],
      last_5_days: padDays.slice(-5).map((d) => `${d[0]} ${String(d[1])}`),
    });

    /* ---- WHAT OUR BOT ITSELF OBSERVED, from its own stored rows ----------- */
    const mine = (await c.query<{ d: string; n: string }>(
      `select to_char(created_at, 'YYYY-MM-DD') as d, count(*)::text as n
         from bot_trades where chain = $1 group by 1 order by 1`, [CHAIN])).rows;
    log.info('WHAT THE BOT ITSELF RECORDED, per day', {
      note: 'bot_trades holds rows it ACTED on, not everything it saw, so this is a '
        + 'floor on the qualifying rate rather than the rate itself',
      rows: mine.map((r) => `${r.d} ${r.n}`),
    });
  } finally {
    c.release(); await app.pool.end();
  }
}

void main().catch((e: unknown) => { log.error('launch-rate failed', errorFields(e)); process.exit(1); });
