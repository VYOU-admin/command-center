/**
 * `npm run realised-backtest` — THE RULE'S RETURN COMPUTED FROM REAL SELLS ONLY.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: EVERY PUBLISHED RETURN FIGURE IS MARK-TO-MARKET
 * ---------------------------------------------------------------------------
 *
 * `launch-backtest` prices a launch from ANY swap -- `abs(counter)/abs(token)` with no
 * direction filter -- and marks a pool at an offset with the LAST swap at or before it.
 * Two consequences, and both inflate the result:
 *
 *   1. A HONEYPOT'S PRICE SERIES IS MADE ENTIRELY OF TRAPPED BUYERS. Buys lift the
 *      price and no sell ever prints, so the mark rises monotonically and the backtest
 *      scores it as a gain. CME (trade 614) is that pool: 75 swaps after our own entry
 *      and not one of them a sell any ordinary holder could have made.
 *   2. A LAUNCH WITH NO TRADE BETWEEN ENTRY AND EXIT CARRIES ITS ENTRY MARK FORWARD, so
 *      `p_out = p_in` and the return is EXACTLY ZERO. A position that cannot be sold is
 *      not flat. It is -100%.
 *
 * This binary recomputes the same windows with one change of definition: **the exit
 * price may only come from a swap that is a SELL, and a launch with no such swap is
 * scored -1.0 rather than 0.**
 *
 * ---------------------------------------------------------------------------
 * THE SIGN CONVENTION, VALIDATED ON INDIVIDUAL RECORDS
 * ---------------------------------------------------------------------------
 *
 * `v4_swaps_all` stores `amount0`/`amount1` and nothing that names a direction. The
 * convention is **the swapper's perspective: positive is received, negative is paid**,
 * so the token amount POSITIVE is a BUY and NEGATIVE is a SELL.
 *
 * IT WAS NOT TAKEN FROM `v4_swap_tx.side`, WHICH WOULD HAVE BEEN CIRCULAR -- that column
 * was populated by `route-probe` selecting rows on the very sign in question. It was
 * validated instead against `tx.value` on single-swap transactions in native-ETH pools,
 * where the ETH actually sent is independent of the amounts:
 *
 *     ETH sent, token amount POSITIVE    142      consistent
 *     ETH sent, token amount NEGATIVE      2      BOTH inspected, see below
 *
 * THE TWO COUNTER-EXAMPLES ARE NOT EXCEPTIONS. `0x47e256a8…` sent 0.001 ETH and RECEIVED
 * 0.0249 ETH; `0x57b92bd5…` sent 0.00002 and received 0.00356. Both are sells that carry
 * a dust value, so `tx.value > 0` was the weak proxy rather than the amounts being wrong.
 * Read on the amounts themselves the counter and token signs are opposite in 100% of
 * rows, which is the invariant this relies on.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY GENEROUS TO THE STRATEGY
 * ---------------------------------------------------------------------------
 *
 * Every judgement call here favours the rule, so that a bad result cannot be blamed on
 * the measurement:
 *
 *   - The exit is the FIRST sell at or after the exit mark, reported both bounded to
 *     +300 s and UNBOUNDED to the end of coverage. The unbounded column lets a trader
 *     wait arbitrarily long for a buyer, which no real horizon would allow.
 *   - "Ever sold" is tested over the pool's ENTIRE swept history, not just the window.
 *   - Pools whose observation is truncated by the end of coverage are reported
 *     separately rather than scored -100% for want of data.
 *
 * ---------------------------------------------------------------------------
 * THE LIMIT OF WHAT THIS CAN SAY, STATED PLAINLY
 * ---------------------------------------------------------------------------
 *
 * A v4 `Swap` event's `sender` is the ROUTER, not the person selling, so this cannot
 * name the selling ADDRESS and therefore cannot distinguish "many holders sold" from
 * "one whitelisted address sold repeatedly". What it CAN say is decisive in one
 * direction: a reverted transaction emits no logs, so **every sell in the log is proof
 * that some non-pool holder's token transfer succeeded**, and a pool with ZERO sells in
 * its entire history is one where that never happened to anybody.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';

const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH, 18
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG, 6
  '0x0000000000000000000000000000000000000000', // native ETH, 18
];

/** 0.1 s per block, measured over 935,564 blocks (section 3). */
const BPS = 10;

/** The published rule, section 1: fee in {500,10000} and a gap of 11-600 blocks. */
const RULE_FEES = [500, 10000];
const GAP_MIN = 11;
const GAP_MAX = 600;

const ENTRY_OFF = 15 * BPS;

/**
 * BOTH horizons are measured. +30 s reproduces the published section 1 table
 * ("exit at the first trade after +45 s", which is 30 s after the +15 s entry);
 * +90 s is what `config.EXIT_DELAY_BLOCKS` actually ships today.
 */
const HOLDS = [30 * BPS, 90 * BPS];

/** How long past the exit mark the bounded column will wait for a sell. */
const SELL_WINDOW = 300 * BPS;

const WINDOWS: Array<{ name: string; from: number; to: number }> = [
  { name: 'HOLDOUT-ERA', from: 15115267, to: 42695454 },
  { name: 'MIDPOINT', from: 52200000, to: 53200000 },
  { name: 'CALM', from: 60700000, to: 61700000 },
  { name: 'SELLOFF', from: 63216393, to: 64216393 },
];

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

    /* The end of coverage. Everything censored is measured against this, not assumed. */
    const cov = await c.query(
      'select min(block_number)::bigint lo, max(block_number)::bigint hi from v4_swaps_all');
    const COV_HI = Number(cov.rows[0].hi);
    log.info('COVERAGE of v4_swaps_all', { lo: cov.rows[0].lo, hi: cov.rows[0].hi });

    /*
     * Pools with exactly one pricing side, and which currency carries the token.
     * A pool pairing two pricing assets is the ETH/USD market, not a launch.
     */
    step('pool keys');
    await c.query(`create temp table pk as
      select i.pool_id, i.block_number as init_block, i.fee::int as fee,
             (i.currency0 = any($1)) as c0_is_counter
        from v4_pool_init i
       where ((i.currency0 = any($1)) <> (i.currency1 = any($1)))`, [PRICING]);
    await c.query('alter table pk add primary key (pool_id); analyze pk');

    /*
     * ONE PASS over 48M swaps producing, per pool, everything both questions need.
     * `tok` and `ctr` are resolved here once so no later query repeats the CASE.
     */
    step('per-pool swap aggregates over the WHOLE corpus (one pass)');
    await c.query(`create temp table ps as
      select s.pool_id,
             min(s.block_number)                                      as first_swap,
             count(*)                                                 as n_swaps,
             count(*) filter (where t.tok < 0)                        as n_sells,
             count(*) filter (where t.tok > 0)                        as n_buys,
             min(s.block_number) filter (where t.tok < 0)             as first_sell,
             max(s.block_number) filter (where t.tok < 0)             as last_sell,
             max(s.block_number)                                      as last_swap
        from v4_swaps_all s
        join pk on pk.pool_id = s.pool_id
        cross join lateral (select case when pk.c0_is_counter then s.amount1 else s.amount0 end as tok) t
       where s.amount0 <> 0 and s.amount1 <> 0
       group by 1`);
    await c.query('alter table ps add primary key (pool_id); analyze ps');

    await show('0. corpus-wide sanity: pools, and how many ever saw a sell', `
      select count(*)::int pools_with_swaps,
             count(*) filter (where n_sells = 0)::int pools_with_ZERO_SELLS_EVER,
             count(*) filter (where n_sells > 0)::int pools_with_at_least_one_sell,
             round(100.0*count(*) filter (where n_sells=0)/nullif(count(*),0),2)::text pct_zero_sells
        from ps`);

    for (const w of WINDOWS) {
      step(`window ${w.name}`);

      /* The rule-qualifying launch set for this window. */
      await c.query('drop table if exists lau');
      await c.query(`create temp table lau as
        select p.pool_id, p.init_block, p.fee, p.c0_is_counter,
               s.first_swap, s.n_swaps, s.n_sells, s.n_buys, s.first_sell, s.last_sell, s.last_swap,
               (s.first_swap - p.init_block) as gap
          from pk p join ps s on s.pool_id = p.pool_id
         where p.init_block between ${w.from} and ${w.to}
           and s.first_swap between ${w.from} and ${w.to}
           and p.fee = any($1)
           and (s.first_swap - p.init_block) between ${GAP_MIN} and ${GAP_MAX}`,
      [RULE_FEES]);
      await c.query('alter table lau add primary key (pool_id); analyze lau');

      await show(`${w.name} 1. rule-qualifying launch set`, `
        select count(*)::int rule_launches,
               count(*) filter (where n_sells = 0)::int NEVER_A_SELL_EVER,
               count(*) filter (where n_sells > 0)::int had_at_least_one_sell,
               round(100.0*count(*) filter (where n_sells=0)/nullif(count(*),0),2)::text
                 as PCT_NEVER_SELLABLE,
               round(100.0*count(*) filter (where n_swaps=1)/nullif(count(*),0),2)::text
                 as pct_traded_exactly_once
          from lau`);

      /*
       * QUESTION 3: the two failure modes are different risks and must not be summed.
       * "Died" had sells and stopped. "Never sellable" never had one at all.
       */
      await show(`${w.name} 2. THE TWO FAILURE MODES, SEPARATED`, `
        select
          count(*) filter (where n_sells = 0 and n_buys > 1)::int
            as NEVER_SELLABLE_but_repeatedly_bought,
          count(*) filter (where n_sells = 0 and n_buys <= 1)::int
            as no_sell_and_barely_traded,
          count(*) filter (where n_sells > 0)::int as had_sells,
          round(100.0*count(*) filter (where n_sells=0 and n_buys>1)/nullif(count(*),0),2)::text
            as PCT_HONEYPOT_SHAPED,
          round(percentile_cont(0.5) within group (order by n_buys)
                filter (where n_sells=0 and n_buys>1)::numeric,1)::text
            as median_buys_into_a_pool_nobody_ever_sold,
          max(n_buys) filter (where n_sells=0)::int as most_buys_with_zero_sells
        from lau`);

      /* Swaps in the observation span, priced and directed. */
      await c.query('drop table if exists sw');
      const MAXOFF = ENTRY_OFF + Math.max(...HOLDS) + SELL_WINDOW;
      await c.query(`create temp table sw as
        select s.pool_id, (s.block_number - l.first_swap)::bigint off, s.log_index,
               s.block_number,
               case when l.c0_is_counter then abs(s.amount0)/abs(s.amount1)
                                         else abs(s.amount1)/abs(s.amount0) end as price,
               (case when l.c0_is_counter then s.amount1 else s.amount0 end) < 0 as is_sell
          from v4_swaps_all s join lau l on l.pool_id = s.pool_id
         where s.block_number between l.first_swap and l.first_swap + ${MAXOFF}
           and s.amount0 <> 0 and s.amount1 <> 0`);
      await c.query('create index on sw(pool_id, off, log_index); analyze sw');

      for (const hold of HOLDS) {
        const exitOff = ENTRY_OFF + hold;

        await c.query('drop table if exists tr');
        await c.query(`create temp table tr as
          with entry as (
            select distinct on (pool_id) pool_id, price p_in, off e_off
              from sw where off >= ${ENTRY_OFF} and not is_sell and price > 0
             order by pool_id, off asc, log_index asc),
          exit_bounded as (
            select distinct on (pool_id) pool_id, price p_out_b, off x_off_b
              from sw where off >= ${exitOff} and off <= ${exitOff + SELL_WINDOW}
                       and is_sell and price > 0
             order by pool_id, off asc, log_index asc)
          select l.pool_id, l.first_swap, l.n_sells, l.n_buys, l.last_sell,
                 e.p_in, e.e_off, x.p_out_b, x.x_off_b,
                 -- UNBOUNDED: the first sell anywhere after the exit mark, to the end of coverage
                 (select case when l.c0_is_counter then abs(s2.amount0)/abs(s2.amount1)
                                              else abs(s2.amount1)/abs(s2.amount0) end
                    from v4_swaps_all s2
                   where s2.pool_id = l.pool_id
                     and s2.block_number >= l.first_swap + ${exitOff}
                     and s2.amount0 <> 0 and s2.amount1 <> 0
                     and (case when l.c0_is_counter then s2.amount1 else s2.amount0 end) < 0
                   order by s2.block_number asc, s2.log_index asc limit 1) as p_out_u,
                 (l.first_swap + ${exitOff} + ${SELL_WINDOW} > ${COV_HI}) as censored
            from lau l
            left join entry e on e.pool_id = l.pool_id
            left join exit_bounded x on x.pool_id = l.pool_id`);
        /* The unbounded lookup needs the price expressed the same way. */
        await c.query(`update tr set p_out_u = null where p_out_u is not null and p_out_u <= 0`);
        await c.query('analyze tr');

        await show(`${w.name} 3. CORRECTED RETURN, entry +${ENTRY_OFF / BPS}s hold +${hold / BPS}s`, `
          with r as (
            select pool_id, censored,
                   p_in is null as no_entry_fill,
                   n_sells = 0 as never_sellable,
                   case when p_in is null then null
                        when p_out_b is not null then p_out_b / p_in - 1
                        else -1.0 end as ret_bounded,
                   case when p_in is null then null
                        when p_out_u is not null then p_out_u / p_in - 1
                        else -1.0 end as ret_unbounded
              from tr)
          select
            (select count(*) from lau)::int                                as rule_launches,
            count(*) filter (where no_entry_fill)::int                     as NO_BUY_TO_ENTER_ON,
            count(*) filter (where censored)::int                          as truncated_by_coverage,
            count(*) filter (where not no_entry_fill)::int                 as scored,
            count(*) filter (where not no_entry_fill and ret_bounded = -1.0)::int
                                                                          as SCORED_MINUS_100,
            count(*) filter (where not no_entry_fill and never_sellable)::int
                                                                          as of_which_NEVER_SELLABLE,
            count(*) filter (where not no_entry_fill and ret_bounded > -1.0)::int
                                                                          as actually_exited,
            round(percentile_cont(0.25) within group (order by ret_bounded)::numeric,5)::text as p25,
            round(percentile_cont(0.50) within group (order by ret_bounded)::numeric,5)::text as MEDIAN,
            round(percentile_cont(0.75) within group (order by ret_bounded)::numeric,5)::text as p75,
            round(100.0*count(*) filter (where ret_bounded>0)/nullif(count(*) filter (where not no_entry_fill),0),2)::text as PCT_POSITIVE,
            round(percentile_cont(0.50) within group (order by ret_unbounded)::numeric,5)::text as median_UNBOUNDED_wait,
            round(percentile_cont(0.50) within group (order by ret_bounded)
                  filter (where ret_bounded > -1.0)::numeric,5)::text      as median_GIVEN_AN_EXIT,
            round(100.0*count(*) filter (where ret_bounded>0)/nullif(count(*) filter (where ret_bounded>-1.0),0),2)::text as pct_positive_GIVEN_AN_EXIT
          from r`);
      }
    }

    step('done');
  } catch (err) {
    log.error('realised-backtest failed', errorFields(err));
    process.exitCode = 1;
  } finally {
    c.release();
    await app.pool.end();
  }
}

void main();
