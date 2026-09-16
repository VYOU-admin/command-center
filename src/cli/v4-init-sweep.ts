/**
 * `npm run v4-init-sweep -- [--commit] [--from N] [--to N] [--ceiling N]`
 *
 * Sweeps the v4 `Initialize` event across the `v4_swaps_all` corpus range so that
 * every pool in it has its two currencies and its creation block.
 *
 * WHY: `v4_swaps_all` says amount0 and amount1 and never which is the token. Without
 * that the price of a launch cannot be computed, and the sign-based proxy tried on
 * 2026-09-15 failed validation at 46% -- worse than chance. See `intake/v4-init.ts`.
 *
 * DRY RUN BY DEFAULT. It states the work set, the density it derived the span from
 * and the estimate, and spends only with `--commit` -- step 9's rule that one
 * derivation serves both the estimate and the fetch, so the figure the operator
 * approves is the figure the job acts on.
 *
 * THE CEILING IS SET INSIDE THE JOB BEFORE THE FIRST REQUEST. An account-level cap
 * protects the wallet; only an in-job ceiling protects against a sweep whose scope
 * went wrong from its first call.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import {
  GETLOGS_CU, V4_INIT_SCHEMA, deriveSpan, sweepInitialize,
} from '../intake/v4-init.js';

/** The corpus `v4_swaps_all` covers, confirmed from the table and its progress rows. */
const CORPUS_FROM = 15115267;
const CORPUS_TO = 42695454;
const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const USD_PER_MCU = 0.45;
/** Step 5's target. Sparse here still means thousands of logs per request. */
const TARGET_LOGS = 6000;
/** Below this a size refusal is a livelock rather than something to retry. */
const MIN_SPAN = 25;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const commit = args.includes('--commit');
  const from = num('--from', CORPUS_FROM);
  const to = num('--to', CORPUS_TO);
  const chain = 'robinhood';

  const app = await bootstrap();
  const client = await app.pool.connect();
  try {
    await client.query(V4_INIT_SCHEMA);

    /*
     * THE WORK SET, DERIVED BEFORE THE FIRST REQUEST, and the lower bound on the log
     * count comes from data already stored: every pool that swapped inside the range
     * must have been initialised, so `v4_swaps_all`'s distinct pool count is a floor.
     */
    const floor = await client.query<{ pools: string; lo: string; hi: string }>(
      `select count(distinct pool_id)::text as pools, min(block_number)::text as lo,
              max(block_number)::text as hi
         from v4_swaps_all where block_number between $1 and $2`, [from, to],
    );
    const expectedLogs = Number(floor.rows[0]!.pools);
    if (expectedLogs === 0) {
      throw new Error(
        `v4_swaps_all holds no swaps in ${from}..${to}. A work set of nothing is a `
        + 'suspected defect, not a clean pass.',
      );
    }
    const done = await client.query<{ ranges: string; covered: string }>(
      `select count(*)::text as ranges, coalesce(sum(to_block-from_block+1),0)::text as covered
         from v4_init_sweep_progress where chain=$1`, [chain],
    );
    const already = await client.query<{ n: string }>(
      'select count(*)::text as n from v4_pool_init where chain=$1', [chain],
    );

    const blocks = to - from + 1;
    const span = deriveSpan(blocks, expectedLogs, TARGET_LOGS);
    /*
     * The estimate carries the HALVING OVERHEAD explicitly. The span only ever
     * narrows, so a range denser than the average costs extra requests that the
     * flat block/span arithmetic does not show.
     */
    const baseRequests = Math.ceil(blocks / span);
    const estLo = baseRequests;
    const estHi = Math.ceil(baseRequests * 2.5) + 10;
    const ceiling = num('--ceiling', Math.max(10000, estHi * GETLOGS_CU * 2));

    log.info('V4 INITIALIZE WORK SET, derived BEFORE the first request', {
      chain,
      range: `${from}..${to}`,
      blocks,
      corpus_swaps_range: `${floor.rows[0]!.lo}..${floor.rows[0]!.hi}`,
      expected_logs_FLOOR: expectedLogs,
      note_on_floor: 'distinct pools that SWAPPED in range; pools initialised and never '
        + 'traded are additional, so the true log count is at or above this',
      derived_density_logs_per_block: (expectedLogs / blocks).toFixed(6),
      derived_span_blocks: span,
      span_rationale: `${TARGET_LOGS} logs per request at the derived density -- SPARSE, `
        + 'and derived rather than carried in as the 40,000,000 a different filter measured',
      estimate: {
        requests_low: estLo, requests_high: estHi,
        cu_low: estLo * GETLOGS_CU, cu_high: estHi * GETLOGS_CU,
        usd_low: ((estLo * GETLOGS_CU * USD_PER_MCU) / 1e6).toFixed(5),
        usd_high: ((estHi * GETLOGS_CU * USD_PER_MCU) / 1e6).toFixed(5),
      },
      ceiling_set: ceiling,
      already_stored: { pools: Number(already.rows[0]!.n),
        ranges: Number(done.rows[0]!.ranges), blocks_covered: Number(done.rows[0]!.covered) },
      commit,
    });

    if (!commit) {
      log.info('DRY RUN -- nothing was read and nothing was written', {
        note: 'pass --commit to spend. The work set above is the set the job acts on.',
      });
      client.release(); await app.pool.end(); process.exit(0);
    }

    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set in this process');
    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000, ceiling);

    const started = Date.now();
    let lastLog = 0;
    const res = await sweepInitialize(
      client, rpc, chain, POOL_MANAGER, from, to, span, MIN_SPAN,
      (r) => {
        if (Date.now() - lastLog > 20000) {
          lastLog = Date.now();
          log.info('sweep progress', {
            at: r.to, pct: (((r.to - from) / blocks) * 100).toFixed(1),
            span: r.span, logs_this_range: r.logs, cu: rpc.cuSpent,
          });
        }
      },
    );
    log.info('v4 Initialize sweep complete', {
      ...res,
      usd: ((res.cuSpent * USD_PER_MCU) / 1e6).toFixed(5),
      estimated_requests: `${estLo}..${estHi}`,
      against_estimate: `${res.requests} actual`,
      wall_clock_s: ((Date.now() - started) / 1000).toFixed(1),
      calls: rpc.callCounts(),
    });

    /* Coverage is checked, not assumed: the sum must equal the span and a window
     * function must find zero gaps. The sum alone is not enough -- an overlap and a
     * gap of the same size cancel out in a total (step 5). */
    const cov = await client.query<{ covered: string; ranges: string; gaps: string }>(
      `with r as (select from_block, to_block,
                         lag(to_block) over (order by from_block) prev
                    from v4_init_sweep_progress where chain=$1)
       select (select coalesce(sum(to_block-from_block+1),0) from v4_init_sweep_progress
                where chain=$1)::text as covered,
              (select count(*) from v4_init_sweep_progress where chain=$1)::text as ranges,
              (select count(*) from r where prev is not null and from_block <> prev+1)::text as gaps`,
      [chain],
    );
    log.info('coverage check', {
      ...cov.rows[0]!, expected_blocks: blocks,
      exact: Number(cov.rows[0]!.covered) === blocks && Number(cov.rows[0]!.gaps) === 0,
    });
  } finally {
    client.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('v4-init-sweep failed', errorFields(err));
  process.exit(1);
});
