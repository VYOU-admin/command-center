/**
 * `npm run launch-economics -- --from N --to N --label X [--gas-sample N] [--commit]`
 *
 * What one trade of the fee-tier rule actually costs, per window.
 *
 * SLIPPAGE IS MEASURED FROM REALISED IMPACT, NOT ASSUMED, AND NOT READ FROM RESERVES.
 * Reserves are stored nowhere and a v4 pool has no contract of its own -- its state
 * lives in the PoolManager singleton, so reading it needs either a periphery contract
 * whose address on this chain is unknown or a raw storage slot whose layout would have
 * to be assumed. This document's standing rule is that an assumed figure is worse than
 * none, so neither is done.
 *
 * What IS available is better than a model: every swap already stored is a trade of
 * known size that moved the price by a known amount. For consecutive swaps in a pool,
 * `|ln(p_next / p_prev)| / usd_size(next)` is the pool's realised impact per dollar at
 * that moment, measured from the chain. Quoting a $10, $50 or $100 trade is then a
 * LINEAR extrapolation from it, and the observed size distribution is reported beside
 * it so the distance of that extrapolation is visible rather than hidden.
 *
 * BOTH LEGS. A round trip pays impact on the way in and again on the way out, into
 * whatever depth exists 30 seconds later, which is measured separately at the exit.
 *
 * USD comes from the counter side: USDG is 6 decimals and resolves to 1, WETH and
 * native ETH are 18 and resolve through `native_usd_prices` at the nearest preceding
 * bucket within one bucket width. A row whose counter cannot be valued is excluded and
 * counted, never defaulted.
 *
 * GAS IS SAMPLED FROM REAL RECEIPTS, never assumed -- `--gas-sample N` at 15 CU each,
 * priced before spending and bounded by a ceiling.
 *
 * Time converts at the measured 0.1 s block time; `block_times` covers 7.86% of the
 * corpus range and is not relied on for the hourly profile.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';

const PRICING = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0x0000000000000000000000000000000000000000',
];
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const USD_PER_MCU = 0.45;
const RECEIPT_CU = 15;
/** 0.1 s per block, measured over 935,564 blocks and 94,548 s (section 3). */
const BPS = 10;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f); return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const str = (f: string, d: string): string => {
    const i = args.indexOf(f); return i >= 0 ? String(args[i + 1] ?? d) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const label = str('--label', `${from}`);
  const gasSample = num('--gas-sample', 0);
  const commit = args.includes('--commit');
  if (!from || !to) throw new Error('usage: --from N --to N --label X');

  const app = await bootstrap();
  const c = await app.pool.connect();
  const show = async (l: string, sql: string, p?: unknown[]): Promise<void> => {
    const r = await c.query(sql, p ?? []);
    log.info(`[${label}] ${l}`, {
      rows: r.rowCount === 0 ? 'RETURNED NO ROWS -- stated, not omitted' : r.rows,
    });
  };
  try {
    await c.query('set statement_timeout = 0');
    /* Launches need 36,000 blocks of observation, so the launch window ends there. */
    const lauTo = to - 36000;

    await c.query(`create temp table lau as
      select i.pool_id, i.block_number ib, f.fb, i.fee,
             case when i.currency0 = any($1) then 1 else 0 end tside,
             case when i.currency0 = any($1) then i.currency0 else i.currency1 end counter
        from v4_pool_init i
        join (select pool_id, min(block_number) fb from v4_swaps_all
               where block_number between ${from} and ${to} group by 1) f on f.pool_id=i.pool_id
       where i.block_number between ${from} and ${lauTo}
         and ((i.currency0 = any($1)) <> (i.currency1 = any($1)))`, [PRICING]);
    await c.query('alter table lau add primary key (pool_id); analyze lau');
    /* THE RULE, unchanged from the holdout run. */
    await c.query(`create temp table rule as
      select * from lau where fee in (500,10000) and (fb - ib) between 11 and 600`);
    await c.query('alter table rule add primary key (pool_id); analyze rule');

    /* Swaps with a price AND a USD size for the counter side. */
    await c.query(`create temp table sw as
      select s.pool_id, (s.block_number - r.fb)::bigint off, s.block_number bn, s.log_index,
             s.tx_hash,
             case when r.tside=0 then abs(s.amount1)/abs(s.amount0)
                                 else abs(s.amount0)/abs(s.amount1) end price,
             /*
              * THE COUNTER SIDE, AND THE FIRST VERSION HAD IT INVERTED. tside is the
              * TOKEN side index -- currency0 being a pricing asset means the token is
              * side 1 -- so the counter is amount1 when tside=0 and amount0 when
              * tside=1, which is the opposite of the price expression above it. Taking
              * the token side as the counter valued trades at a median of $201 BILLION,
              * drove impact-per-dollar to zero, and reported round-trip slippage as
              * 0.00000 at every size. A cost of exactly nothing is a plausible value on
              * an error path, which section 5 calls the worst defect shape here.
              */
             case when r.tside=0 then abs(s.amount1) else abs(s.amount0) end cnt_raw,
             r.counter, r.fee,
             row_number() over (partition by s.pool_id order by s.block_number, s.log_index) rn
        from v4_swaps_all s join rule r on r.pool_id = s.pool_id
       where s.block_number between r.fb and r.fb + 3600
         and s.amount0 <> 0 and s.amount1 <> 0`);
    await c.query('create index on sw(pool_id, rn); create index on sw(pool_id, off); analyze sw');

    /*
     * USD PER SWAP. USDG resolves to 1 without consulting any series. WETH and native
     * ETH resolve through the nearest PRECEDING native bucket within one bucket width
     * -- the watcher's rule, because these pools sit on no fixed grid. A swap whose
     * counter cannot be valued gets NULL and is counted, never defaulted.
     */
    await c.query(`create temp table swu as
      select s.*, case when s.counter = '${USDG}' then s.cnt_raw / 1e6
                       else s.cnt_raw / 1e18 * n.eth_usd end as usd
        from sw s
        left join lateral (
          select eth_usd from native_usd_prices np
           where np.block_number <= s.bn and np.block_number > s.bn - 10000
           order by np.block_number desc limit 1) n on s.counter <> '${USDG}'`);
    await c.query('create index on swu(pool_id, rn); analyze swu');

    await show('W1. window, rule pools, and how many swaps could be valued', `
      select '${from}..${to}' as swept, '${from}..${lauTo}' as launch_window,
             (select count(*) from lau)::int launches,
             (select count(*) from rule)::int rule_pools,
             (select count(*) from swu)::int rule_swaps,
             (select count(*) from swu where usd is null)::int swaps_with_NO_USD,
             (select count(*) from swu where usd is not null)::int swaps_valued`);

    await show('W2. observed trade SIZE distribution, so the extrapolation distance is visible', `
      select count(*)::int n,
             round(percentile_cont(0.10) within group (order by usd)::numeric,2)::text p10_usd,
             round(percentile_cont(0.25) within group (order by usd)::numeric,2)::text p25_usd,
             round(percentile_cont(0.50) within group (order by usd)::numeric,2)::text MEDIAN_usd,
             round(percentile_cont(0.75) within group (order by usd)::numeric,2)::text p75_usd,
             round(percentile_cont(0.90) within group (order by usd)::numeric,2)::text p90_usd,
             count(*) filter (where usd < 10)::int under_10,
             count(*) filter (where usd between 10 and 100)::int between_10_and_100
        from swu where usd > 0`);

    /*
     * REALISED IMPACT PER DOLLAR, from consecutive swaps. The price move from the
     * previous swap to this one was caused by THIS swap, of known size.
     */
    await c.query(`create temp table imp as
      select a.pool_id, a.off, a.usd,
             abs(ln(a.price / b.price)) / nullif(a.usd,0) as impact_per_usd
        from swu a join swu b on b.pool_id=a.pool_id and b.rn = a.rn - 1
       where a.usd > 0 and a.price > 0 and b.price > 0`);
    await c.query('create index on imp(pool_id, off); analyze imp');

    await show('W3. REALISED IMPACT PER DOLLAR around the ENTRY moment (off 150..450)', `
      select count(*)::int ticks, count(distinct pool_id)::int pools,
             round(percentile_cont(0.25) within group (order by impact_per_usd)::numeric,8)::text p25,
             round(percentile_cont(0.50) within group (order by impact_per_usd)::numeric,8)::text MEDIAN,
             round(percentile_cont(0.75) within group (order by impact_per_usd)::numeric,8)::text p75,
             round(percentile_cont(0.90) within group (order by impact_per_usd)::numeric,8)::text p90
        from imp where off between 150 and 450`);

    /* Per pool: median impact/usd at entry and at exit, then cost of each leg. */
    await c.query(`create temp table legs as
      select r.pool_id,
        (select percentile_cont(0.5) within group (order by impact_per_usd)
           from imp i where i.pool_id=r.pool_id and i.off between 150 and 450) ipu_in,
        (select percentile_cont(0.5) within group (order by impact_per_usd)
           from imp i where i.pool_id=r.pool_id and i.off between 450 and 900) ipu_out
      from rule r`);
    await c.query('alter table legs add primary key (pool_id); analyze legs');

    for (const size of [10, 50, 100]) {
      await show(`W4. ROUND-TRIP SLIPPAGE for a $${size} position -- BOTH legs, per pool`, `
        select count(*)::int pools_measurable,
               (select count(*) from rule)::int rule_pools,
               (select count(*) from legs where ipu_in is null or ipu_out is null)::int
                 pools_NOT_measurable,
               round(percentile_cont(0.25) within group (order by (ipu_in+ipu_out)*${size})::numeric,5)::text p25,
               round(percentile_cont(0.50) within group (order by (ipu_in+ipu_out)*${size})::numeric,5)::text MEDIAN,
               round(percentile_cont(0.75) within group (order by (ipu_in+ipu_out)*${size})::numeric,5)::text p75,
               round(percentile_cont(0.90) within group (order by (ipu_in+ipu_out)*${size})::numeric,5)::text p90
          from legs where ipu_in is not null and ipu_out is not null`);
    }

    /* EXECUTABLE return, no-fill counted as zero -- the definition used throughout. */
    await c.query(`create temp table ret as
      with e as (select distinct on (pool_id) pool_id, price pin from swu
                  where off>150 order by pool_id, off, log_index),
           x as (select distinct on (pool_id) pool_id, price pout from swu
                  where off>450 order by pool_id, off, log_index)
      select r.pool_id, r.fee,
             case when e.pin>0 and x.pout>0 then x.pout/e.pin-1 else 0 end rr,
             (e.pin is null or x.pout is null) as no_fill
        from rule r left join e using(pool_id) left join x using(pool_id)`);
    await c.query('alter table ret add primary key (pool_id); analyze ret');

    await show('W5. EXECUTABLE gross return and the NO-FILL rate', `
      select count(*)::int rule_pools,
             round(percentile_cont(0.25) within group (order by rr)::numeric,5)::text p25,
             round(percentile_cont(0.50) within group (order by rr)::numeric,5)::text MEDIAN,
             round(percentile_cont(0.75) within group (order by rr)::numeric,5)::text p75,
             round(100.0*count(*) filter (where rr>0)/count(*),2)::text pct_positive,
             round(100.0*count(*) filter (where no_fill)/count(*),2)::text pct_NO_FILL
        from ret`);

    for (const size of [10, 50, 100]) {
      await show(`W6. NET of LP fee + BOTH slippage legs, $${size} -- gas still excluded`, `
        select count(*)::int n_costable,
               (select count(*) from rule)::int rule_pools,
               (select count(*) from legs where ipu_in is null or ipu_out is null)::int
                 pools_NOT_COSTABLE_excluded_here,
               round(percentile_cont(0.25) within group (order by
                 rr - 2*(fee/1000000.0) - (l.ipu_in+l.ipu_out)*${size})::numeric,5)::text p25,
               round(percentile_cont(0.50) within group (order by
                 rr - 2*(fee/1000000.0) - (l.ipu_in+l.ipu_out)*${size})::numeric,5)::text MEDIAN,
               round(percentile_cont(0.75) within group (order by
                 rr - 2*(fee/1000000.0) - (l.ipu_in+l.ipu_out)*${size})::numeric,5)::text p75,
               round(100.0*count(*) filter (where
                 rr - 2*(fee/1000000.0) - (l.ipu_in+l.ipu_out)*${size} > 0)/count(*),2)::text pct_positive
          from ret r join legs l using(pool_id)
         where l.ipu_in is not null and l.ipu_out is not null`);
    }

    await show('W7. FIRING RATE: pools created, rule-qualifying, per day at 0.1s blocks', `
      select (select count(*) from v4_pool_init
               where block_number between ${from} and ${lauTo})::int pools_created,
             (select count(*) from lau)::int launches_priceable_counter,
             (select count(*) from rule)::int rule_qualifying,
             round((${lauTo} - ${from} + 1) / 864000.0, 3)::text window_days,
             round((select count(*) from v4_pool_init
                     where block_number between ${from} and ${lauTo}) / ((${lauTo}-${from}+1)/864000.0), 1)::text
               pools_created_per_day,
             round((select count(*) from rule) / ((${lauTo}-${from}+1)/864000.0), 1)::text
               RULE_TRADES_PER_DAY`);

    await show('W8. HOURLY PROFILE of rule launches, hour derived from the measured block time', `
      with anchor as (select block_number b, extract(epoch from block_time) t
                        from block_times order by abs(block_number - ${from}) limit 1)
      select floor(mod((a.t + (r.ib - a.b)/${BPS}.0)/3600.0, 24))::int utc_hour,
             count(*)::int rule_launches
        from rule r cross join anchor a group by 1 order by 1`);

    if (gasSample > 0) {
      const estCu = gasSample * RECEIPT_CU;
      log.info(`[${label}] GAS SAMPLE priced BEFORE the first request`, {
        receipts: gasSample, cu: estCu, usd: ((estCu * USD_PER_MCU) / 1e6).toFixed(5),
        commit,
      });
      if (commit) {
        const key = process.env['ALCHEMY_API_KEY'];
        if (!key) throw new Error('ALCHEMY_API_KEY is not set');
        const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000, Math.ceil(estCu * 1.5));
        const txs = await c.query<{ tx_hash: string; bn: string }>(
          `select distinct on (pool_id) tx_hash, bn::text from swu
            where off between 150 and 450 order by pool_id, off limit ${gasSample}`);
        const costs: number[] = [];
        let failed = 0;
        for (const t of txs.rows) {
          try {
            const r = (await rpc.raw('eth_getTransactionReceipt', [t.tx_hash])) as
              { gasUsed?: string; effectiveGasPrice?: string } | null;
            if (!r?.gasUsed || !r.effectiveGasPrice) { failed += 1; continue; }
            const wei = BigInt(r.gasUsed) * BigInt(r.effectiveGasPrice);
            costs.push(Number(wei) / 1e18);
          } catch (err) {
            if (err instanceof Error && err.message.includes('compute-unit ceiling')) throw err;
            failed += 1;
          }
        }
        costs.sort((a, b) => a - b);
        const eth = await c.query<{ e: string }>(
          `select eth_usd::text e from native_usd_prices where block_number <= ${to}
            order by block_number desc limit 1`);
        const ethUsd = Number(eth.rows[0]?.e ?? 0);
        const q = (f: number): number => costs[Math.floor((costs.length - 1) * f)] ?? 0;
        log.info(`[${label}] GAS, measured from real receipts`, {
          requested: gasSample, returned: costs.length, failed,
          eth_usd_used: ethUsd,
          median_gas_eth: q(0.5).toExponential(4),
          median_gas_usd: (q(0.5) * ethUsd).toFixed(5),
          p25_usd: (q(0.25) * ethUsd).toFixed(5),
          p75_usd: (q(0.75) * ethUsd).toFixed(5),
          round_trip_usd: (2 * q(0.5) * ethUsd).toFixed(5),
          cu_spent: rpc.cuSpent,
          note: 'one swap receipt is ONE leg; a round trip pays it twice',
        });
      }
    }
    log.info(`DONE-ECON-${label}`);
  } finally { c.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((e) => { log.error('launch-economics failed', errorFields(e)); process.exit(1); });
