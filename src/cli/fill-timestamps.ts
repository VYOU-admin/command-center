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
 *
 * `--public` fetches from the free endpoint in batches of 100 instead, which is
 * what the document's "test the free alternatives first" rule has always asked
 * for and what no code here implemented: the PONS rebuild's 717,340 blocks are
 * $6.46 on Alchemy and nothing on the public RPC. It costs wall-clock instead --
 * about 16.7 blocks per second. See src/intake/blocktimes.ts for the
 * measurements, and note it cross-checks against Alchemy before it trusts it.
 */
import { bootstrap } from '../bootstrap.js';
import type { PoolClient } from '../store/db.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { fetchTimestamps, planTimestamps } from '../intake/write.js';
import {
  PUBLIC_BATCH, PUBLIC_PACE_MS, fillFromPublicRpc, verifyAgainstAlchemy,
} from '../intake/blocktimes.js';

/** Measured; documented in src/intake/blocktimes.ts. */
const PUBLIC_URL = 'https://rpc.mainnet.chain.robinhood.com';

/**
 * Store a verified batch. `on conflict do nothing` because `block_times` is
 * shared across tokens and a concurrent sweep may have stored the same block.
 */
async function storeBatch(
  c: PoolClient,
  chain: string,
  batch: { block: number; timestamp: number }[],
): Promise<void> {
  if (!batch.length) return;
  const values = batch.map((_, i) => `($1,$${i * 2 + 2},to_timestamp($${i * 2 + 3}))`).join(',');
  const params: unknown[] = [chain];
  for (const b of batch) params.push(b.block, b.timestamp);
  await c.query(
    `insert into block_times (chain, block_number, block_time)
     values ${values} on conflict do nothing`,
    params,
  );
}

/**
 * The free route, with the cross-check that makes it trustworthy.
 *
 * It samples 100 of the blocks it is about to fetch and compares them against
 * Alchemy (2,000 CU, $0.0009) BEFORE the long run. Any mismatch aborts: the
 * same endpoint returns a well-formed and entirely wrong `0x0` for log
 * timestamps, so "it answered" is not evidence that it answered correctly.
 */
async function runPublic(
  c: PoolClient, chain: string, blocks: number[], alchemyUrl: string,
): Promise<void> {
  if (!blocks.length) { log.info('nothing to fill', { blocks_missing: 0 }); return; }
  const step = Math.max(1, Math.floor(blocks.length / 100));
  const sample = blocks.filter((_, i) => i % step === 0).slice(0, 100);
  const check = await verifyAgainstAlchemy(PUBLIC_URL, alchemyUrl, sample);
  if (check.mismatched > 0) {
    throw new Error(
      `the public RPC disagreed with Alchemy on ${check.mismatched} of ${check.compared} `
        + `blocks: ${check.examples.join('; ')}. Refusing to fill from it.`,
    );
  }
  log.info('cross-check passed, starting the free fill', {
    compared: check.compared, mismatched: 0, blocks: blocks.length,
    estimated_hours: ((blocks.length / PUBLIC_BATCH) * (PUBLIC_PACE_MS / 1000) / 3600).toFixed(2),
  });
  const started = Date.now();
  const res = await fillFromPublicRpc(
    PUBLIC_URL, blocks,
    (batch) => storeBatch(c, chain, batch),
    (p) => {
      const secs = (Date.now() - started) / 1000;
      const rate = p.fetched / Math.max(secs, 1);
      log.info('filling', {
        fetched: p.fetched, total: p.total, batches: p.batches,
        blocks_per_sec: rate.toFixed(1),
        eta_hours: ((p.total - p.fetched) / Math.max(rate, 0.01) / 3600).toFixed(2),
      });
    },
  );
  log.info('public fill complete', { ...res, cost_dollars: 0 });
}

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
  const alchemyUrl = cfg.rpcUrlTemplate.replace('{key}', key);
  const rpc = new RpcClient(alchemyUrl, cfg.requestTimeoutMs, ceiling);

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
  const usePublic = args.includes('--public');

  const c = await app.pool.connect();
  try {
    if (forPrices) {
      /*
       * NOT `select ...::text ... order by 1`. ORDER BY binds to the first OUTPUT
       * column, which was the ::text rendering, so the sort was lexicographic and
       * put '10003150' before '5363150' -- the trap section 7 of
       * docs/ROBINHOOD.md records. `select distinct` forbids ordering by an
       * expression outside the select list, so the cast is dropped instead of
       * aliased: node-pg returns an int8 as a string regardless.
       */
      const missing = await c.query<{ block_number: string }>(
        `select distinct s.block_number from token_swap_logs s
           join pool_meta m on m.chain = s.chain and m.token = s.token
                           and m.venue = s.venue and m.pool = s.pool
          where s.chain = $1 and s.token = $2
            and not exists (select 1 from block_times b
                             where b.chain = s.chain and b.block_number = s.block_number)
          order by s.block_number`,
        [cfg.chain, cfg.token],
      );
      const blocks = missing.rows.map((r) => Number(r.block_number));
      log.info('BEFORE THE FIRST REQUEST', {
        work_set: 'blocks of in-scope swaps with no stored timestamp -- what price '
          + 'derivation needs, NOT the row-derived set',
        blocks_missing: blocks.length,
        route: usePublic ? 'public RPC, free' : 'alchemy, metered',
        alchemy_cu: blocks.length * 20,
        alchemy_dollars: ((blocks.length * 20 * 0.45) / 1e6).toFixed(4),
        public_rpc_hours: ((blocks.length / PUBLIC_BATCH) * (PUBLIC_PACE_MS / 1000) / 3600)
          .toFixed(2),
        ceiling: usePublic ? 'n/a -- the public route spends nothing' : ceiling,
      });
      let fetched = 0;
      if (usePublic) {
        await runPublic(c, cfg.chain, blocks, alchemyUrl);
        fetched = blocks.length;
      } else {
        for (const b of blocks) {
          const ts = await rpc.getBlockTimestamp(b);
          await c.query(
            `insert into block_times (chain, block_number, block_time)
             values ($1,$2,to_timestamp($3)) on conflict do nothing`,
            [cfg.chain, b, ts],
          );
          fetched += 1;
        }
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
      /*
       * RELEASE THE CLIENT BEFORE ENDING THE POOL. This branch returned early
       * without releasing `c`, so `pool.end()` waited for a checked-out client
       * that would never come back: the job printed its result, reported
       * still_missing 0, and then hung forever -- blocking the next job chained
       * behind it for twenty minutes with no error and nothing in its log.
       *
       * A process that has printed its answer has not necessarily exited.
       */
      c.release();
      await app.pool.end();
      process.exit(0);
    }

    const plan = await planTimestamps(c, cfg);
    log.info('BEFORE THE FIRST REQUEST', {
      ...plan, ceiling, work_set: 'row-derived',
      route: usePublic ? 'public RPC, free' : 'alchemy, metered',
      public_rpc_hours: ((plan.toFetch / PUBLIC_BATCH) * (PUBLIC_PACE_MS / 1000) / 3600)
        .toFixed(2),
      note: 'the work set is the blocks the rows will need, not every block in the swap table',
    });
    if (usePublic) {
      /*
       * `_needed_blocks` was materialised by planTimestamps just above, so this
       * reads the identical rows the plan counted rather than re-running the
       * derivation.
       *
       * ORDERED BY THE BIGINT, NOT BY ITS ::text RENDERING. This said `order by 1`,
       * which binds to the first OUTPUT column -- `block_number::text` -- and sorts
       * lexicographically, putting '10003150' before '5363150'. Section 7 of
       * docs/ROBINHOOD.md records that exact trap. The cast is aliased and the sort
       * is qualified, so neither can resolve to the text column.
       */
      const missing = await c.query<{ blk: string }>(
        `select n.block_number::text as blk from _needed_blocks n
           left join block_times b on b.chain = $1 and b.block_number = n.block_number
          where b.block_number is null order by n.block_number`,
        [cfg.chain, cfg.token],
      );
      const blocks = missing.rows.map((r) => Number(r.blk));
      if (blocks.length !== plan.toFetch) {
        throw new Error(
          `the plan said ${plan.toFetch} blocks and the fetch found ${blocks.length}. `
            + 'Refusing to run against an unreported figure.',
        );
      }
      await runPublic(c, cfg.chain, blocks, alchemyUrl);
      c.release();
      await app.pool.end();
      process.exit(0);
    }
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
