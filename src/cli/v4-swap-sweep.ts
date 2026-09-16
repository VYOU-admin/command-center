/**
 * `npm run v4-swap-sweep -- --from N --to N [--commit] [--ceiling N]`
 *
 * Sweeps v4 `Swap` into `v4_swaps_all` for a bounded RECENT window, so the fee-tier
 * finding can be tested outside the era it was found in.
 *
 * DRY RUN BY DEFAULT, AND IT PROBES THE DENSITY OF THE BLOCKS IT IS ABOUT TO READ.
 * This document records a density taken from the wrong range being wrong by 16x, 27%,
 * 2.0x and 142x, and the corpus range is 21 million blocks away from this one. Three
 * probe requests (180 CU) size the sweep; the estimate is quoted from them and from
 * nothing else.
 *
 * The ceiling is set inside the job before the first request.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { TOPICS } from '../adapters/token-updates/decode.js';
import { V4_SWEEP_SCHEMA, sweepV4Swaps } from '../intake/v4-swaps.js';

const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';
const USD_PER_MCU = 0.45;
const GETLOGS_CU = 60;
const TARGET_LOGS = 6000;
const MIN_SPAN = 25;
/** Refuse to spend more than this without the operator saying so again. */
const HARD_USD_STOP = 0.20;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number(args[i + 1] ?? d) : d;
  };
  const commit = args.includes('--commit');
  const from = num('--from', 0);
  const to = num('--to', 0);
  if (!from || !to || to <= from) throw new Error('usage: --from N --to N with to > from');
  const chain = 'robinhood';

  const key = process.env['ALCHEMY_API_KEY'];
  if (!key) throw new Error('ALCHEMY_API_KEY is not set in this process');

  const app = await bootstrap();
  const client = await app.pool.connect();
  try {
    await client.query(V4_SWEEP_SCHEMA);
    const blocks = to - from + 1;

    /* PROBE FIRST: three 2,000-block samples across the range actually to be read. */
    const probe = new RpcClient(RPC_URL.replace('{key}', key), 120000, 1000);
    const samples: Array<{ at: number; logs: number; perBlock: number }> = [];
    for (const frac of [0.02, 0.5, 0.98]) {
      const at = Math.floor(from + blocks * frac);
      const hi = Math.min(at + 1999, to);
      const logs = (await probe.raw('eth_getLogs', [{
        address: POOL_MANAGER, topics: [TOPICS.swapV4],
        fromBlock: `0x${at.toString(16)}`, toBlock: `0x${hi.toString(16)}`,
      }])) as unknown[];
      samples.push({ at, logs: logs.length, perBlock: logs.length / (hi - at + 1) });
    }
    const peak = Math.max(...samples.map((s) => s.perBlock));
    const mean = samples.reduce((a, s) => a + s.perBlock, 0) / samples.length;
    /*
     * SIZE FROM THE DENSEST SAMPLE, NOT THE MEAN. BONER's sweep landed 0.7% above a
     * range sized that way while the mean would have been 30% low; the span only ever
     * narrows, so a mean-sized span pays extra halvings in the dense stretches.
     */
    const span = Math.max(MIN_SPAN, Math.floor(TARGET_LOGS / Math.max(peak, 1e-9)));
    const requests = Math.ceil(blocks / Math.min(span, blocks));
    const estCu = requests * GETLOGS_CU;
    const estUsd = (estCu * USD_PER_MCU) / 1e6;
    const ceiling = num('--ceiling', Math.max(10000, Math.ceil(estCu * 2.5)));

    log.info('V4 SWAP SWEEP WORK SET, derived BEFORE the first request', {
      chain,
      range: `${from}..${to}`,
      blocks,
      probe: {
        cu_spent: probe.cuSpent,
        samples: samples.map((s) => ({ at: s.at, logs_per_2000_blocks: s.logs,
          per_block: s.perBlock.toFixed(4) })),
        peak_per_block: peak.toFixed(4),
        mean_per_block: mean.toFixed(4),
        spread: (peak / Math.max(...[Math.min(...samples.map((s) => s.perBlock)), 1e-9]))
          .toFixed(1) + 'x',
      },
      derived_span_blocks: span,
      note: 'span sized from the DENSEST sample at 6,000 logs per request; the mean '
        + 'would be low wherever the range is dense and the span only ever narrows',
      estimate: { requests, cu: estCu, usd: estUsd.toFixed(5),
        expected_rows: Math.round(mean * blocks) },
      ceiling_set: ceiling,
      hard_usd_stop: HARD_USD_STOP,
      commit,
    });

    if (estUsd > HARD_USD_STOP) {
      log.warn('ESTIMATE EXCEEDS THE HARD STOP -- refusing to spend', {
        estimate_usd: estUsd.toFixed(5), hard_stop: HARD_USD_STOP,
        note: 'narrow the window and re-run, or raise the stop deliberately',
      });
      client.release(); await app.pool.end(); process.exit(2);
    }
    if (!commit) {
      log.info('DRY RUN -- nothing was swept', { note: 'pass --commit to spend' });
      client.release(); await app.pool.end(); process.exit(0);
    }

    const rpc = new RpcClient(RPC_URL.replace('{key}', key), 120000, ceiling);
    const started = Date.now();
    let last = 0;
    const res = await sweepV4Swaps(
      client, rpc, chain, POOL_MANAGER, from, to, span, MIN_SPAN,
      (r) => {
        if (Date.now() - last > 20000) {
          last = Date.now();
          log.info('sweep progress', { at: r.to,
            pct: (((r.to - from) / blocks) * 100).toFixed(1),
            span: r.span, logs: r.logs, cu: rpc.cuSpent });
        }
      },
    );
    log.info('v4 swap sweep complete', {
      ...res, usd: ((res.cuSpent * USD_PER_MCU) / 1e6).toFixed(5),
      estimated_requests: requests, probe_cu: probe.cuSpent,
      wall_clock_s: ((Date.now() - started) / 1000).toFixed(1),
      calls: rpc.callCounts(),
    });

    const cov = await client.query<{ covered: string; gaps: string; ranges: string }>(
      `with r as (select from_block, to_block, lag(to_block) over (order by from_block) prev
                    from v4_recent_sweep_progress where chain=$1)
       select (select coalesce(sum(to_block-from_block+1),0) from v4_recent_sweep_progress
                where chain=$1)::text covered,
              (select count(*) from r where prev is not null and from_block <> prev+1)::text gaps,
              (select count(*) from v4_recent_sweep_progress where chain=$1)::text ranges`,
      [chain],
    );
    log.info('coverage check', { ...cov.rows[0]!, expected_blocks: blocks,
      exact: Number(cov.rows[0]!.covered) === blocks && Number(cov.rows[0]!.gaps) === 0 });
  } finally { client.release(); }
  await app.pool.end();
  process.exit(0);
}
main().catch((e) => { log.error('v4-swap-sweep failed', errorFields(e)); process.exit(1); });
