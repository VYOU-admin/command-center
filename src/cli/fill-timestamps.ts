/**
 * `npm run fill-timestamps -- <config.yaml> [--ceiling C]`
 *
 * Fills `block_times` for the blocks this token's rows will actually need.
 * Reports the count and the cost BEFORE the first request, then fetches.
 *
 * WHY IT IS NEEDED AT ALL. On Alchemy this is usually free: `blockTimestamp`
 * arrives with the logs during a sweep. Swaps COPIED from `v4_swaps_all` carry
 * no timestamp, so copying trades the sweep's cost for this one -- still far
 * cheaper, but not nothing, and it must be paid before prices derive.
 *
 * The work set comes from the rows that will be written, never from every block
 * in the swap table -- that distinction was a 9.6x overshoot on PONS. It uses
 * `fetchTimestamps`, the same single derivation the intake phase uses.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { fetchTimestamps, planTimestamps } from '../intake/write.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: fill-timestamps <config.yaml> [--ceiling C]');
  const i = args.indexOf('--ceiling');
  const ceiling = i >= 0 ? Number.parseInt(args[i + 1] ?? '', 10) : 20000;

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  /*
   * TWO DIFFERENT WORK SETS, AND SAYING WHICH ONE MATTERS.
   *
   * `planTimestamps` derives the blocks the ROWS will need, which is right for
   * the intake and is what kept PONS from a 9.6x overshoot. Price derivation
   * needs something else: `loadSlice` refuses any swap in an in-scope pool
   * whose block has no timestamp, cohort or no cohort. On a token with no
   * cohort yet the row-derived set is legitimately EMPTY -- which reads exactly
   * like "nothing to do" while price derivation cannot run at all.
   */
  const forPrices = args.includes('--for-prices');

  const c = await app.pool.connect();
  try {
    if (forPrices) {
      const missing = await c.query<{ block_number: string }>(
        `select distinct s.block_number::text from token_swap_logs s
           join pool_meta m on m.chain = s.chain and m.token = s.token
                           and m.venue = s.venue and m.pool = s.pool
          where s.chain = $1 and s.token = $2
            and not exists (select 1 from block_times b
                             where b.chain = s.chain and b.block_number = s.block_number)
          order by 1`,
        [cfg.chain, cfg.token],
      );
      const blocks = missing.rows.map((r) => Number(r.block_number));
      log.info('BEFORE THE FIRST REQUEST', {
        work_set: 'blocks of in-scope swaps with no stored timestamp -- what price '
          + 'derivation needs, NOT the row-derived set',
        blocks_missing: blocks.length,
        estimated_cu: blocks.length * 20,
        estimated_dollars: ((blocks.length * 20 * 0.45) / 1e6).toFixed(4),
        ceiling,
      });
      let fetched = 0;
      for (const b of blocks) {
        const ts = await rpc.getBlockTimestamp(b);
        await c.query(
          `insert into block_times (chain, block_number, block_time)
           values ($1,$2,to_timestamp($3)) on conflict do nothing`,
          [cfg.chain, b, ts],
        );
        fetched += 1;
      }
      const left = await c.query<{ n: string }>(
        `select count(*)::text n from (
           select distinct s.block_number from token_swap_logs s
             join pool_meta m on m.chain=s.chain and m.token=s.token
                             and m.venue=s.venue and m.pool=s.pool
            where s.chain=$1 and s.token=$2
              and not exists (select 1 from block_times b
                               where b.chain=s.chain and b.block_number=s.block_number)) x`,
        [cfg.chain, cfg.token],
      );
      log.info('filled', {
        fetched, still_missing: Number(left.rows[0]!.n),
        cu_spent: rpc.cuSpent, dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
      });
      await app.pool.end();
      process.exit(0);
    }

    const plan = await planTimestamps(c, cfg);
    log.info('BEFORE THE FIRST REQUEST', {
      ...plan, ceiling, work_set: 'row-derived',
      note: 'the work set is the blocks the rows will need, not every block in the swap table',
    });
    const res = await fetchTimestamps(c, rpc, cfg, ceiling);
    log.info('filled', {
      ...res, cu_spent: rpc.cuSpent,
      dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
    });
    if (res.remaining > 0) {
      log.warn('blocks still missing', {
        remaining: res.remaining,
        stopped_at_ceiling: res.stoppedAtCeiling,
      });
    }
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('fill-timestamps failed', errorFields(err)); process.exit(1); });
