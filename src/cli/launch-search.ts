/**
 * `npm run launch-search -- --half search|holdout`
 *
 * Does anything observable AT OR BEFORE BUY TIME predict what a v4 launch does next?
 *
 * READ-ONLY, zero CU.
 *
 * THE HOLDOUT IS THE POINT. The 150,930 launches are split 50/50 by the first hex
 * character of `md5(pool_id)` -- deterministic, reproducible, and fixed before any
 * hypothesis was formed. `0`-`7` is SEARCH, `8`-`f` is HOLDOUT. Exploration happens on
 * the search half only; the surviving hypotheses are tested once on the holdout. The
 * same code runs both halves so the comparison cannot drift.
 *
 * WHAT COUNTS AS OBSERVABLE. A feature may use only the pool's `Initialize` record and
 * the swaps in the first 50 blocks (5 s) after its FIRST swap. Anything later is not
 * available to someone deciding whether to buy.
 *
 * THE DENOMINATOR IS EVERY LAUNCH IN THE HALF, never the survivors. Conditioning on
 * launches that kept trading is what produced the +18.2% median this run exists to
 * get behind.
 *
 * DEGENERATE POOLS ARE EXCLUDED AND COUNTED. 111 of 120,060 pools span more than 10^6
 * in price inside the first 360 s -- step 10's degenerate swap at launch scale. They
 * destroy a mean and move a median by 0.0001, and they are dropped here rather than
 * left to flatter a result.
 *
 * MEDIAN FIRST, MEAN SECOND, everywhere.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';

const FROM = 15115267;
const TO = 42695454;
const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--half');
  const half = i >= 0 ? String(args[i + 1]) : 'search';
  if (half !== 'search' && half !== 'holdout' && half !== 'all') {
    throw new Error(`--half must be "search", "holdout" or "all", got "${half}"`);
  }
  /* '0'-'7' is search, '8'-'f' is holdout. Fixed before any hypothesis was formed. */
  const pred = half === 'search'
    ? `substr(md5(pool_id),1,1) < '8'`
    : half === 'holdout' ? `substr(md5(pool_id),1,1) >= '8'`
      : 'true';
  /*
   * A BLOCK RANGE, for the forward test. `--half all --from N --to N` runs the
   * IDENTICAL code path and definitions over a different era instead of a hash half.
   * It is not a holdout -- the window is seen -- and nothing about the tests changes.
   */
  const fi = args.indexOf('--from'); const ti = args.indexOf('--to');
  const winFrom = fi >= 0 ? Number(args[fi + 1]) : FROM;
  const winTo = ti >= 0 ? Number(args[ti + 1]) : TO;

  const app = await bootstrap();
  const c = await app.pool.connect();
  const t0 = Date.now();
  const step = (m: string): void =>
    log.info(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);
  const H = async (id: string, question: string, sql: string, p?: unknown[]): Promise<void> => {
    const r = await c.query(sql, p ?? []);
    log.info(`HYP ${id}`, {
      question,
      rows: r.rowCount === 0 ? 'RETURNED NO ROWS -- stated, not omitted' : r.rows,
    });
  };
  try {
    await c.query('set statement_timeout = 0');

    step(`building the ${half.toUpperCase()} half`);
    await c.query(`create temp table fsw as
      select pool_id, min(block_number) fb from v4_swaps_all
       where block_number between ${winFrom} and ${winTo} group by 1`);
    await c.query('alter table fsw add primary key (pool_id); analyze fsw');
    await c.query(`create temp table lau as
      select i.pool_id, i.block_number init_block, f.fb first_swap,
             case when i.currency0 = any($1) then 1 else 0 end token_side,
             case when i.currency0 = any($1) then i.currency0 else i.currency1 end counter,
             case when i.currency0 = any($1) then i.currency1 else i.currency0 end token,
             i.fee, i.tick_spacing, i.hooks, i.sqrt_price_x96
        from v4_pool_init i join fsw f on f.pool_id=i.pool_id
       where i.block_number between ${winFrom} and ${winTo}
         and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))
         and ${pred.replace('pool_id', 'i.pool_id')}`, [PRICING]);
    await c.query('alter table lau add primary key (pool_id); analyze lau');

    /* Swaps over the widest horizon any outcome needs. */
    await c.query(`create temp table sw as
      select s.pool_id, (s.block_number - l.first_swap)::bigint off, s.log_index,
             s.sender, s.tx_hash,
             case when l.token_side=0 then abs(s.amount1)/abs(s.amount0)
                                      else abs(s.amount0)/abs(s.amount1) end price,
             case when l.token_side=0 then abs(s.amount0) else abs(s.amount1) end counter_amt
        from v4_swaps_all s join lau l on l.pool_id=s.pool_id
       where s.block_number between l.first_swap and l.first_swap + 36000
         and s.amount0 <> 0 and s.amount1 <> 0`);
    await c.query('create index on sw(pool_id, off, log_index); analyze sw');

    /* DEGENERATE POOLS, excluded and counted. */
    await c.query(`create temp table degen as
      select pool_id from sw where off <= 3600 group by pool_id
       having count(*) > 1 and max(price)/nullif(min(price),0) > 1e6`);
    await c.query('alter table degen add primary key (pool_id); analyze degen');

    step('features observable at or before +5s');
    await c.query(`create temp table feat as
      select l.*,
        (l.first_swap - l.init_block) creation_gap,
        (select count(*) from sw s where s.pool_id=l.pool_id and s.off<=50) n_swaps_5s,
        (select count(distinct s.tx_hash) from sw s where s.pool_id=l.pool_id and s.off<=50) n_tx_5s,
        (select count(distinct s.sender) from sw s where s.pool_id=l.pool_id and s.off<=50) n_send_5s,
        (select sum(s.counter_amt) from sw s where s.pool_id=l.pool_id and s.off<=50) vol_5s,
        (select s.counter_amt from sw s where s.pool_id=l.pool_id
          order by s.off, s.log_index limit 1) first_size,
        (select s.sender from sw s where s.pool_id=l.pool_id
          order by s.off, s.log_index limit 1) first_sender,
        (select s.price from sw s where s.pool_id=l.pool_id
          order by s.off, s.log_index limit 1) p0,
        (select s.price from sw s where s.pool_id=l.pool_id and s.off<=50
          order by s.off desc, s.log_index desc limit 1) p5s,
        -- OUTCOMES
        exists(select 1 from sw s where s.pool_id=l.pool_id and s.off>3000) surv_5m,
        exists(select 1 from sw s where s.pool_id=l.pool_id and s.off>36000-1) surv_1h,
        exists(select 1 from sw s where s.pool_id=l.pool_id and s.off>150 and s.off<=450) exit_avail,
        (select count(*) from sw s where s.pool_id=l.pool_id) n_swaps_total
      from lau l where not exists(select 1 from degen d where d.pool_id=l.pool_id)`);
    await c.query(`alter table feat add primary key (pool_id)`);
    await c.query(`alter table feat add column mom5 double precision`);
    await c.query(`update feat set mom5 = (p5s/nullif(p0,0) - 1)::double precision where p0>0`);
    await c.query('analyze feat');

    /* The best cell from the backtest: entry +15s, exit +30s after entry. */
    await c.query(`create temp table ret as
      with m1 as (select distinct on (pool_id) pool_id, price p_in from sw
                   where off<=150 order by pool_id, off desc, log_index desc),
           m2 as (select distinct on (pool_id) pool_id, price p_out from sw
                   where off<=450 order by pool_id, off desc, log_index desc)
      select m1.pool_id, (m2.p_out/m1.p_in - 1)::double precision r
        from m1 join m2 on m2.pool_id=m1.pool_id where m1.p_in>0 and m2.p_out>0`);
    await c.query('alter table ret add primary key (pool_id); analyze ret');

    await H('0', 'the half, its base rates, and what was excluded', `
      select (select count(*) from lau)::int launches_in_half,
             (select count(*) from degen)::int degenerate_EXCLUDED,
             (select count(*) from feat)::int tested,
             count(*) filter (where surv_5m)::int surv_5m,
             round(100.0*count(*) filter (where surv_5m)/count(*),2)::text base_surv_5m_pct,
             round(100.0*count(*) filter (where surv_1h)/count(*),2)::text base_surv_1h_pct,
             round(100.0*count(*) filter (where exit_avail)/count(*),2)::text base_exit_avail_pct,
             round(percentile_cont(0.5) within group (order by r)::numeric,5)::text base_median_ret
        from feat left join ret using (pool_id)`);

    /* ------------------------------------------------------------------ *
     * Each hypothesis reports SURVIVAL TO 5 MINUTES by bucket, over every
     * launch in the half, plus the median return of the best backtest cell.
     * ------------------------------------------------------------------ */
    /* ntile() cannot appear in GROUP BY, so a decile bucket is precomputed in a
     * subquery and grouped on the resulting column. */
    const byPre = (id: string, question: string, inner: string, extra = ''): Promise<void> =>
      H(id, question, `
        select bucket, count(*)::int n,
               round(100.0*count(*) filter (where surv_5m)/count(*),2)::text surv_5m_pct,
               round(100.0*count(*) filter (where surv_1h)/count(*),2)::text surv_1h_pct,
               round(100.0*count(*) filter (where exit_avail)/count(*),2)::text exit_avail_pct,
               round(percentile_cont(0.5) within group (order by r)::numeric,5)::text median_ret
          from (${inner}) z group by 1 ${extra} order by 2 desc`);

    const byBucket = (id: string, question: string, bucket: string, extra = ''): Promise<void> =>
      H(id, question, `
        select ${bucket} as bucket, count(*)::int n,
               round(100.0*count(*) filter (where surv_5m)/count(*),2)::text surv_5m_pct,
               round(100.0*count(*) filter (where surv_1h)/count(*),2)::text surv_1h_pct,
               round(100.0*count(*) filter (where exit_avail)/count(*),2)::text exit_avail_pct,
               round(percentile_cont(0.5) within group (order by r)::numeric,5)::text median_ret
          from feat left join ret using (pool_id)
         group by 1 ${extra} order by 2 desc`);

    /*
     * TWO CORRELATED SUBQUERIES ARE MATERIALISED FIRST. Written inline, H15 scanned
     * all 306,560 Initialize rows per launch row and sat ACTIVE for 9m12s in
     * pg_stat_activity against ~90s for H1-H14 -- past the 3x wall-clock rule, and a
     * hang rather than slowness. This is the fourth instance of that shape in this
     * repository after the 19-minute router query, the 17-minute conventions query and
     * the 10m34s timestamp work set, and the remedy is the one those established:
     * materialise the input into an indexed temp table and analyse it.
     */
    await c.query(`create temp table tokpool as
      select pool_id,
             row_number() over (
               partition by case when currency0 = any($1) then currency1 else currency0 end
               order by block_number, pool_id) - 1 as prior_pools
        from v4_pool_init`, [PRICING]);
    await c.query('alter table tokpool add primary key (pool_id); analyze tokpool');
    await c.query(`create temp table blkpool as
      select block_number, count(*)::int n from v4_pool_init group by 1`);
    await c.query('alter table blkpool add primary key (block_number); analyze blkpool');

    step('hypotheses');
    await byBucket('1', 'H1 does a HOOK predict survival?',
      `case when hooks='0x0000000000000000000000000000000000000000' then 'no hook' else 'has hook' end`);
    await byBucket('2', 'H2 does WHICH hook predict survival?',
      `case when hooks='0x0000000000000000000000000000000000000000' then 'no hook'
             when hooks='0x3468951d49f27e0a8b2c1e5b9f8c0d7a6e5f4321' then 'hook-A' else left(hooks,14) end`,
      'having count(*) >= 200');
    await byBucket('3', 'H3 does the FEE TIER predict survival?', `fee::text`, 'having count(*) >= 200');
    await byBucket('4', 'H4 does an EXTREME fee (>10%) predict survival?',
      `case when fee=8388608 then 'dynamic' when fee>100000 then 'extreme >10%'
             when fee>=10000 then '1%+' else 'normal' end`);
    await byBucket('5', 'H5 does the COUNTER ASSET predict survival?', `counter`);
    await byBucket('6', 'H6 does CREATION->FIRST SWAP gap predict survival?',
      `case when creation_gap=0 then 'a same block'
             when creation_gap<=10 then 'b <=1s' when creation_gap<=50 then 'c <=5s'
             when creation_gap<=150 then 'd <=15s' when creation_gap<=600 then 'e <=60s'
             when creation_gap<=9000 then 'f <=15min' else 'g >15min' end`);
    await byBucket('7', 'H7 does SWAP COUNT in the first 5s predict survival?',
      `case when n_swaps_5s<=1 then '1' when n_swaps_5s=2 then '2' when n_swaps_5s<=4 then '3-4'
             when n_swaps_5s<=9 then '5-9' when n_swaps_5s<=24 then '10-24' else '25+' end`);
    await byBucket('8', 'H8 does DISTINCT TRANSACTIONS in the first 5s predict survival?',
      `case when n_tx_5s<=1 then '1' when n_tx_5s=2 then '2' when n_tx_5s<=4 then '3-4'
             when n_tx_5s<=9 then '5-9' else '10+' end`);
    await byBucket('9', 'H9 does DISTINCT SENDERS in the first 5s predict survival?',
      `case when n_send_5s<=1 then '1' when n_send_5s=2 then '2' when n_send_5s<=4 then '3-4' else '5+' end`);
    await byBucket('10', 'H10 does PRICE MOMENTUM over the first 5s predict survival?',
      `case when mom5 is null then 'z no move'
             when mom5 <= -0.05 then 'a down >5%' when mom5 < 0 then 'b down'
             when mom5 = 0 then 'c flat' when mom5 < 0.05 then 'd up <5%'
             when mom5 < 0.25 then 'e up 5-25%' else 'f up >25%' end`);
    await byPre('11', 'H11 does the FIRST BUY SIZE predict survival? (within counter, deciles)',
      `select counter || ' d' || ntile(10) over (partition by counter order by first_size) bucket,
              surv_5m, surv_1h, exit_avail, r
         from feat left join ret using (pool_id) where first_size is not null`,
      'having count(*) >= 200');
    await byBucket('12', 'H12 does TICK SPACING predict survival?', `tick_spacing::text`,
      'having count(*) >= 200');
    await byBucket('13', 'H13 is the FIRST SENDER a persisted router?',
      `case when exists(select 1 from token_intake_state t
                         where t.phase='router:'||lower(feat.first_sender)) then 'known router'
             else 'not in the router list' end`);
    await byBucket('14', 'H14 does the FIRST SENDER routing many launches predict survival?',
      `case when first_sender in (select sender from sw group by sender
                                   having count(distinct pool_id) > 5000) then 'top router'
             else 'other sender' end`);
    await byPre('15', 'H15 does the TOKEN ALREADY HAVING POOLS predict survival?',
      `select case when t.prior_pools = 0 then 'a first pool'
                   when t.prior_pools <= 2 then 'b 1-2 prior' else 'c 3+ prior' end bucket,
              f.surv_5m, f.surv_1h, f.exit_avail, r.r
         from feat f join tokpool t using (pool_id) left join ret r using (pool_id)`);
    await byBucket('16', 'H16 does a VANITY token address (ends 1e18) predict survival?',
      `case when right(token,4)='1e18' then 'ends 1e18' else 'other' end`);
    await byPre('17', 'H17 does the INITIAL PRICE (sqrtPriceX96 decile) predict survival?',
      `select 'd' || ntile(10) over (order by sqrt_price_x96) bucket,
              surv_5m, surv_1h, exit_avail, r from feat left join ret using (pool_id)`);
    await byPre('18', 'H18 does 5s VOLUME predict survival? (within counter, deciles)',
      `select counter || ' v' || ntile(10) over (partition by counter order by vol_5s) bucket,
              surv_5m, surv_1h, exit_avail, r
         from feat left join ret using (pool_id) where vol_5s is not null`,
      'having count(*) >= 200');
    await byPre('19', 'H19 does the pool being created in a BUSY block predict survival?',
      `select case when b.n = 1 then 'a alone' when b.n <= 3 then 'b 2-3' else 'c 4+' end bucket,
              f.surv_5m, f.surv_1h, f.exit_avail, r.r
         from feat f join blkpool b on b.block_number=f.init_block
         left join ret r using (pool_id)`);
    await byBucket('20', 'H20 does the FIRST SWAP being in the creation block predict survival?',
      `case when creation_gap=0 then 'same block' else 'later' end`);

    log.info('DONE-MARKER-SEARCH', { half });
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((e) => { log.error('launch-search failed', errorFields(e)); process.exit(1); });
