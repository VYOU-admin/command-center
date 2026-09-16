/**
 * `npm run launch-backtest` — what happens to a v4 launch's price in its first minutes.
 *
 * READ-ONLY. It writes nothing and spends no compute units.
 *
 * IT IS ONLY POSSIBLE BECAUSE `v4_pool_init` EXISTS. `v4_swaps_all` stores amount0
 * and amount1 and nothing that names them, and the sign-based proxy for "which side
 * is the token" failed validation at 46% -- worse than chance. The Initialize sweep
 * resolved it from the chain, and its currencies agree with `pool_meta` on 699 of 699
 * pools where both are known.
 *
 * PRICE IS |counter| / |token| IN RAW UNITS, and that is deliberate:
 *
 *  - DECIMALS CANCEL IN A RATIO OF PRICES. The grid reports return, p(t2)/p(t1)-1, so
 *    the 10^(dec_token - dec_counter) scale factor divides out exactly. No token's
 *    decimals are read or assumed anywhere in this file. They would be needed for a
 *    price LEVEL or a USD figure, and neither is computed here.
 *  - ABSOLUTE VALUES MAKE IT CONVENTION-INDEPENDENT. Step 10 makes the same point for
 *    the ETH/USD market: taking magnitudes means the v3 pool perspective and the v4
 *    swapper perspective give the same number, so this does not depend on resolving
 *    the sign convention at all.
 *
 * TIME COMES FROM THE MEASURED BLOCK TIME, NOT FROM `block_times`, which covers only
 * 7.86% of this range (2,166,746 of 27,580,188 blocks) and 11.5% of the blocks that
 * actually carry a v4 swap. 0.1 s per block = 10 blocks per second, measured over
 * 935,564 blocks and 94,548 seconds (section 3).
 *
 * THE DENOMINATOR IS EVERY LAUNCH. 13.6% of launches trade exactly once and 49.5% are
 * dead within five minutes, so every cell is reported twice -- over all launches and
 * over those that actually had a trade to exit into -- and the gap between them is the
 * survivorship cost.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';

const CORPUS_FROM = 15115267;
const CORPUS_TO = 42695454;
/** Recognised pricing assets, lowercased. Step 4. */
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH, 18
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG, 6
  '0x0000000000000000000000000000000000000000', // native ETH, 18
];
/** 0.1 s per block, measured. */
const BPS = 10;
const ENTRIES = [5, 15, 30, 60].map((s) => s * BPS);
const EXITS = [15, 30, 60, 120, 300].map((s) => s * BPS);

async function main(): Promise<void> {
  const app = await bootstrap();
  const c = await app.pool.connect();
  const t0 = Date.now();
  const step = (m: string): void =>
    log.info(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  const show = async (label: string, sql: string, p?: unknown[]): Promise<void> => {
    const r = await c.query(sql, p ?? []);
    log.info(label, { rows: r.rowCount === 0 ? 'RETURNED NO ROWS' : r.rows });
  };
  try {
    await c.query('set statement_timeout = 0');

    step('launch set: Initialize inside coverage, first swap inside coverage');
    await c.query(`create temp table fsw as
      select pool_id, min(block_number) fb from v4_swaps_all
       where block_number between ${CORPUS_FROM} and ${CORPUS_TO} group by 1`);
    await c.query('alter table fsw add primary key (pool_id); analyze fsw');

    /*
     * EXACTLY ONE SIDE MUST BE A PRICING ASSET. A pool pairing two pricing assets --
     * WETH/USDG -- is the ETH/USD market, not a token launch, and is excluded rather
     * than silently assigned a token side.
     */
    await c.query(`create temp table lau as
      select i.pool_id, i.block_number as init_block, f.fb as first_swap,
             case when i.currency0 = any($1) then 1 else 0 end as token_side,
             case when i.currency0 = any($1) then i.currency0 else i.currency1 end as counter,
             case when i.currency0 = any($1) then i.currency1 else i.currency0 end as token
        from v4_pool_init i
        join fsw f on f.pool_id = i.pool_id
       where i.block_number between ${CORPUS_FROM} and ${CORPUS_TO}
         and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))`, [PRICING]);
    await c.query('alter table lau add primary key (pool_id); analyze lau');

    await show('1. LAUNCH SET and what each filter discarded', `
      select (select count(*) from v4_pool_init)::int as initialised_in_range,
             (select count(*) from v4_pool_init i join fsw f on f.pool_id=i.pool_id)::int as also_swapped,
             (select count(*) from fsw)::int as pools_that_swapped,
             (select count(*) from fsw f left join v4_pool_init i on i.pool_id=f.pool_id
               where i.pool_id is null)::int as swapped_but_NO_INITIALIZE_IN_RANGE,
             (select count(*) from v4_pool_init i join fsw f on f.pool_id=i.pool_id
               where (i.currency0 = any($1)) and (i.currency1 = any($1)))::int as both_sides_pricing_EXCLUDED,
             (select count(*) from v4_pool_init i join fsw f on f.pool_id=i.pool_id
               where not((i.currency0 = any($1)) or (i.currency1 = any($1))))::int as NEITHER_side_pricing_EXCLUDED,
             (select count(*) from lau)::int as LAUNCH_SET`, [PRICING]);

    await show('1b. launch set by counter asset', `
      select counter, count(*)::int pools from lau group by 1 order by 2 desc`);

    step('early swaps with a price, bounded by the widest grid cell');
    const MAXOFF = Math.max(...ENTRIES) + Math.max(...EXITS);
    await c.query(`create temp table sw as
      select s.pool_id, (s.block_number - l.first_swap)::bigint off, s.log_index,
             case when l.token_side=0 then abs(s.amount1)/abs(s.amount0)
                                      else abs(s.amount0)/abs(s.amount1) end as price
        from v4_swaps_all s join lau l on l.pool_id = s.pool_id
       where s.block_number between l.first_swap and l.first_swap + ${MAXOFF}
         and s.amount0 <> 0 and s.amount1 <> 0`);
    await c.query('create index on sw(pool_id, off, log_index); analyze sw');
    await show('2. early-window swaps carrying a usable price', `
      select count(*)::bigint rows, count(distinct pool_id)::int pools,
             (select count(*) from lau)::int launch_set,
             (select count(*) from lau l where not exists(select 1 from sw where sw.pool_id=l.pool_id))::int
               as launches_with_NO_PRICEABLE_SWAP`);
    await show('2b. degenerate swaps excluded for a zero side', `
      select count(*)::bigint zero_side_swaps from v4_swaps_all s join lau l on l.pool_id=s.pool_id
       where s.block_number between l.first_swap and l.first_swap + ${MAXOFF}
         and (s.amount0 = 0 or s.amount1 = 0)`);

    step('marks at every offset the grid needs');
    const offsets = new Set<number>();
    for (const e of ENTRIES) { offsets.add(e); for (const x of EXITS) offsets.add(e + x); }
    await c.query(`create temp table mark (
      pool_id text, off_target bigint, price numeric, stale_blocks bigint, has_new boolean)`);
    for (const o of [...offsets].sort((a, b) => a - b)) {
      await c.query(`insert into mark
        select distinct on (s.pool_id) s.pool_id, ${o}::bigint, s.price, ${o} - s.off,
               exists(select 1 from sw n where n.pool_id=s.pool_id and n.off>0 and n.off<=${o})
          from sw s where s.off <= ${o}
         order by s.pool_id, s.off desc, s.log_index desc`);
    }
    await c.query('create index on mark(pool_id, off_target); analyze mark');

    step('the grid');
    for (const e of ENTRIES) {
      for (const x of EXITS) {
        const xo = e + x;
        const r = await c.query(`
          with j as (
            select m1.pool_id, m1.price p_in, m2.price p_out,
                   m1.stale_blocks s_in, m2.stale_blocks s_out,
                   exists(select 1 from sw n where n.pool_id=m1.pool_id
                            and n.off > ${e} and n.off <= ${xo}) as exited,
                   m1.has_new as live_at_entry
              from mark m1 join mark m2 on m2.pool_id=m1.pool_id and m2.off_target=${xo}
             where m1.off_target=${e} and m1.price>0 and m2.price>0),
          r as (select *, (p_out/p_in - 1)::double precision ret from j)
          select
            (select count(*) from lau)::int                                   as launch_set,
            count(*)::int                                                     as with_both_marks,
            count(*) filter (where not exited)::int                           as NO_EXIT_never_traded_again,
            count(*) filter (where not live_at_entry)::int                    as not_live_at_entry,
            round(avg(s_in),1)::text                                          as mean_entry_staleness_blocks,
            round(avg(s_out),1)::text                                         as mean_exit_staleness_blocks,
            -- OVER ALL LAUNCHES WITH MARKS (no-exit launches marked at last trade)
            round(percentile_cont(0.5) within group (order by ret)::numeric,5)::text  as ALL_median,
            round(avg(ret)::numeric,5)::text                                          as ALL_mean,
            round(percentile_cont(0.10) within group (order by ret)::numeric,5)::text as ALL_p10,
            round(percentile_cont(0.25) within group (order by ret)::numeric,5)::text as ALL_p25,
            round(percentile_cont(0.75) within group (order by ret)::numeric,5)::text as ALL_p75,
            round(percentile_cont(0.90) within group (order by ret)::numeric,5)::text as ALL_p90,
            round(percentile_cont(0.99) within group (order by ret)::numeric,5)::text as ALL_p99,
            round(100.0*count(*) filter (where ret>0)/nullif(count(*),0),2)::text     as ALL_pct_positive,
            -- OVER LAUNCHES THAT ACTUALLY HAD A TRADE TO EXIT INTO
            round(percentile_cont(0.5) within group (order by ret) filter (where exited)::numeric,5)::text as EX_median,
            round(avg(ret) filter (where exited)::numeric,5)::text                                         as EX_mean,
            round(percentile_cont(0.10) within group (order by ret) filter (where exited)::numeric,5)::text as EX_p10,
            round(percentile_cont(0.25) within group (order by ret) filter (where exited)::numeric,5)::text as EX_p25,
            round(percentile_cont(0.75) within group (order by ret) filter (where exited)::numeric,5)::text as EX_p75,
            round(percentile_cont(0.90) within group (order by ret) filter (where exited)::numeric,5)::text as EX_p90,
            round(percentile_cont(0.99) within group (order by ret) filter (where exited)::numeric,5)::text as EX_p99,
            round(100.0*count(*) filter (where exited and ret>0)/nullif(count(*) filter (where exited),0),2)::text as EX_pct_positive
          from r`);
        log.info('CELL', { entry_s: e / BPS, exit_s: x / BPS, ...r.rows[0] });
      }
    }

    step('step 3 -- creation to first swap');
    await show('3. Initialize -> first swap, and -> fifth swap (0.1s per block)', `
      with g as (select l.pool_id, (l.first_swap - l.init_block)::bigint gap,
                        (select min(s.off) from sw s where s.pool_id=l.pool_id and s.off>0) o2
                   from lau l),
      f5 as (select s.pool_id, min(s.off) o5 from (
               select pool_id, off, row_number() over (partition by pool_id order by off, log_index) rn
                 from sw) s where s.rn=5 group by 1)
      select count(*)::int launches,
        percentile_disc(0.10) within group (order by gap) p10,
        percentile_disc(0.25) within group (order by gap) p25,
        percentile_disc(0.50) within group (order by gap) MEDIAN_blocks,
        round(percentile_disc(0.50) within group (order by gap)/10.0,1)::text MEDIAN_SECONDS,
        percentile_disc(0.75) within group (order by gap) p75,
        percentile_disc(0.90) within group (order by gap) p90,
        percentile_disc(0.99) within group (order by gap) p99,
        count(*) filter (where gap=0)::int SAME_BLOCK_as_creation,
        count(*) filter (where gap<=10)::int within_1s,
        count(*) filter (where gap<=50)::int within_5s,
        count(*) filter (where gap<=150)::int within_15s,
        count(*) filter (where gap<=600)::int within_60s
      from g`);
    await show('3b. Initialize -> FIFTH swap', `
      with f5 as (select pool_id, off o5 from (
               select pool_id, off, row_number() over (partition by pool_id order by off, log_index) rn
                 from sw) s where rn=5)
      select count(*)::int reached_fifth_within_grid,
        percentile_disc(0.50) within group (order by l.first_swap - l.init_block + f5.o5) MEDIAN_blocks,
        round(percentile_disc(0.50) within group (order by l.first_swap - l.init_block + f5.o5)/10.0,1)::text MEDIAN_SECONDS,
        percentile_disc(0.90) within group (order by l.first_swap - l.init_block + f5.o5) p90
      from f5 join lau l on l.pool_id=f5.pool_id`);

    log.info('DONE-MARKER-BACKTEST');
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((e) => { log.error('launch-backtest failed', errorFields(e)); process.exit(1); });
