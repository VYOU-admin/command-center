/**
 * `npm run sweep-probe -- <config.yaml> --from N --to M [--legacy] [--ceiling C]`
 *
 * Why did a 1,757,870-block sweep consume 1,000 requests when a 100,000-block
 * probe of the same streams took 3?
 *
 * This runs the span-sizing loop over a real range and prints span, block
 * range, log count, density and the next span for EVERY request, so the
 * behaviour is measured rather than reasoned about. `--legacy` restores the
 * density denominator as it was before the fix, so both can be run over the
 * same blocks and compared directly.
 *
 * The loop below mirrors `adaptiveSweep` deliberately: it is the only way to
 * run the two denominators side by side, since production carries one of them.
 * Every other term -- the halving on a size refusal, the hold-and-wait on a
 * rate refusal, the 1.25x cap recovery, the floor -- is identical.
 *
 * READ ONLY. Fetches logs, stores nothing.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { TOPICS } from '../adapters/token-updates/decode.js';

const SIZE_REFUSAL =
  /response size exceeded|exceeds limit|query returned more than|too large|limit of \d+/i;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: sweep-probe <config.yaml> --from N --to M');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const ceiling = num('--ceiling', 2000);
  const legacy = args.includes('--legacy');
  const samples = num('--samples', 0);
  const sampleSpan = num('--sample-span', 20000);
  const tokenIdx = args.indexOf('--token');
  const tokenOverride = tokenIdx >= 0 ? args[tokenIdx + 1] : undefined;
  if (!from || !to || to <= from) throw new Error('--from and --to are required');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  const token = tokenOverride ?? cfg.token;
  const filter = { address: token, topics: [TOPICS.transfer] };

  /*
   * SAMPLING MODE. A sweep from the start of a range measures the density of
   * its beginning, not of the range. To find where the dense regions are, take
   * evenly spaced fixed-span probes across the whole span instead. Cost is
   * exactly `samples` requests, so the ceiling is known before it starts.
   */
  if (samples > 0) {
    const step = Math.floor((to - from + 1) / samples);
    const points: unknown[] = [];
    let probeLogs = 0;
    let probeBlocks = 0;
    let refusals = 0;
    log.info('density sampling', {
      token, blocks: `${from}..${to}`, span: to - from + 1,
      samples, sample_span: sampleSpan, ceiling,
      cost_if_no_refusals: `${samples * 60} CU`,
    });
    for (let i = 0; i < samples; i += 1) {
      const start = from + i * step;
      let width = Math.min(sampleSpan, to - start + 1);
      for (;;) {
        try {
          const logs = await rpc.getLogs(filter, start, start + width - 1,
            width, cfg.minLogSpanBlocks);
          probeLogs += logs.length;
          probeBlocks += width;
          points.push({
            sample: i + 1, from: start, to: start + width - 1, span: width,
            logs: logs.length,
            logs_per_block: Number((logs.length / width).toFixed(4)),
            pct_through_window: `${Math.round((100 * i) / samples)}%`,
          });
          break;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          if (SIZE_REFUSAL.test(m) && width > cfg.minLogSpanBlocks) {
            refusals += 1;
            width = Math.max(cfg.minLogSpanBlocks, Math.floor(width / 2));
            continue;
          }
          throw err;
        }
      }
    }
    const densities = points.map((p) => (p as { logs_per_block: number }).logs_per_block);
    const sorted = [...densities].sort((a, b) => a - b);
    const lo = sorted[0] ?? 0;
    const hi = sorted[sorted.length - 1] ?? 0;
    log.info('every sample', { points });
    log.info('density summary', {
      token, samples: points.length, size_refusals: refusals,
      total_logs: probeLogs, total_blocks: probeBlocks,
      mean_logs_per_block: Number((probeLogs / probeBlocks).toFixed(4)),
      min: lo, median: sorted[Math.floor(sorted.length / 2)], max: hi,
      // A zero minimum is a real answer -- a region with no transfers at all --
      // and must be said rather than divided by.
      spread: lo > 0 ? `${(hi / lo).toFixed(1)}x` : 'MINIMUM IS ZERO: a sampled region held no logs',
      cu_spent: rpc.cuSpent,
    });
    await app.pool.end();
    process.exit(0);
  }
  const ceilingSpan = cfg.maxLogSpanBlocks;
  let cursor = from;
  let span = Math.min(cfg.maxLogSpanBlocks, to - from + 1);
  let cap = cfg.maxLogSpanBlocks;
  let requests = 0;
  let sizeRefusals = 0;
  let totalLogs = 0;
  let blocks = 0;
  let smallest = Number.MAX_SAFE_INTEGER;
  let largest = 0;
  const trace: unknown[] = [];

  log.info('probe', {
    mode: legacy ? 'LEGACY density denominator' : 'fixed density denominator',
    blocks: `${from}..${to}`, span: to - from + 1, ceiling,
    target_logs_per_request: cfg.targetLogsPerRequest,
    min_span: cfg.minLogSpanBlocks, max_span: cfg.maxLogSpanBlocks,
  });

  try {
    while (cursor <= to) {
      const end = Math.min(cursor + span - 1, to);
      let logs;
      try {
        logs = await rpc.getLogs(filter, cursor, end, end - cursor + 1, cfg.minLogSpanBlocks);
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        if (SIZE_REFUSAL.test(m)) {
          sizeRefusals += 1;
          const narrowed = Math.max(cfg.minLogSpanBlocks, Math.floor(span / 2));
          trace.push({ req: requests, from: cursor, to: end, span: end - cursor + 1,
            refusal: 'size', next_span: narrowed });
          span = narrowed; cap = narrowed;
          continue;
        }
        throw err;
      }
      requests += 1;
      const blocksRead = end - cursor + 1;
      totalLogs += logs.length;
      blocks += blocksRead;
      smallest = Math.min(smallest, blocksRead);
      largest = Math.max(largest, blocksRead);

      // THE ONE DIFFERENCE. Legacy divided by `end - cursor + 2` AFTER the
      // cursor had already been advanced to end + 1, which is always 1.
      const legacyCursor = end + 1;
      const density = legacy
        ? logs.length / (end - legacyCursor + 2)
        : logs.length / blocksRead;
      const wanted = density > 0
        ? Math.floor(cfg.targetLogsPerRequest / density) : ceilingSpan;
      cap = Math.min(ceilingSpan, Math.max(cap, Math.floor(cap * 1.25) + 1));
      const nextSpan = Math.max(cfg.minLogSpanBlocks, Math.min(wanted, cap));

      trace.push({ req: requests, from: cursor, to: end, span: blocksRead,
        logs: logs.length, logs_per_block: Number(density.toFixed(4)),
        wanted_span: wanted, cap, next_span: nextSpan, refusal: null });

      cursor = end + 1;
      span = nextSpan;
    }
  } catch (err) {
    log.info('stopped', { why: err instanceof Error ? err.message : String(err) });
  }

  log.info('every request', { trace });
  log.info('summary', {
    mode: legacy ? 'LEGACY' : 'fixed',
    requests, size_refusals: sizeRefusals, rate_refusals: 0,
    logs: totalLogs, blocks_covered: blocks,
    blocks_remaining: Math.max(0, to - cursor + 1),
    smallest_span: smallest === Number.MAX_SAFE_INTEGER ? 0 : smallest,
    largest_span: largest,
    mean_logs_per_block: blocks ? Number((totalLogs / blocks).toFixed(4)) : 0,
    cu_spent: rpc.cuSpent,
    blocks_per_request: requests ? Math.round(blocks / requests) : 0,
    projected_requests_for_1757870_blocks: blocks
      ? Math.round(1757870 / (blocks / requests)) : null,
  });
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('sweep-probe failed', errorFields(err)); process.exit(1); });
