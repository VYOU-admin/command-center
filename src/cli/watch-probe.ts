/**
 * `npm run watch-probe -- <config.yaml> [--samples N] [--span B] [--ceiling C]`
 *
 * READS ONLY. Measures the density of the watcher's wallet-keyed filter over the
 * blocks it will actually read, and reports the cost per run BEFORE anything is
 * swept. docs/ROBINHOOD.md step 17.
 *
 * WHY THIS EXISTS AS ITS OWN STEP. Step 5's rule is "probe the range you will
 * actually sweep", and a density taken from the wrong range has been wrong on this
 * project by 16x (AI), by 27% (INDEX) and by 2.0x (the ETH/USD market sweep, three
 * days ago). A wallet-keyed filter across every token on the chain has no measured
 * density at all, so until this runs the watcher's cost is a guess and is reported
 * as one.
 *
 * It samples near the HEAD, because that is where the watcher runs. Sampling the
 * chain's early life would repeat exactly the mistake above.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { WALLET_CHUNK, chunk, loadWatchlistWallets, probeWatchDensity } from '../intake/watcher.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: watch-probe <config.yaml>');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const samples = num('--samples', 6);
  const span = num('--span', 20000);
  const ceiling = num('--ceiling', 100000);

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  const c = await app.pool.connect();
  try {
    const wallets = await loadWatchlistWallets(c, cfg.chain);
    const chunks = chunk(wallets, WALLET_CHUNK);
    const head = await rpc.blockNumber();
    /*
     * Evenly spaced samples across the last `samples * span * 4` blocks, ending
     * 200 short of head -- the same reorg lag the hourly job uses, so the probe
     * reads the same kind of blocks the watcher will.
     */
    const lag = 200;
    const window = samples * span * 4;
    const start = head - lag - window;
    const ranges = Array.from({ length: samples }, (_, i) => {
      const from = start + i * (window / samples);
      return { from: Math.floor(from), to: Math.floor(from) + span - 1 };
    });

    log.info('BEFORE THE FIRST REQUEST', {
      wallets: wallets.length,
      wallet_chunks: chunks.length,
      chunk_size: WALLET_CHUNK,
      filters_per_slice: chunks.length * 2,
      note: 'two directions per chunk: topics[1] sent, topics[2] received',
      head, sampling: `${samples} x ${span} blocks, ending ${lag} short of head`,
      estimated_probe_cu: chunks.length * 2 * samples * 60,
      ceiling,
      writes: 'NONE',
    });

    const r = await probeWatchDensity(rpc, wallets, ranges);
    log.info('samples', { samples: r.samples });

    /*
     * A ZERO IS REPORTED AS A ZERO. If the watchlist wallets did nothing in the
     * sampled blocks that is a real answer about how quiet they are -- but it also
     * means the density figure below rests on nothing, so it is said plainly
     * rather than presented as a measurement.
     */
    const totalLogs = r.samples.reduce((n, s) => n + s.logs, 0);
    const blocks = r.samples.reduce((n, s) => n + (s.to - s.from + 1), 0);
    const perSlice = (slice: number): { requests: number; cu: number } => {
      // getLogs holds one request per chunk per direction while the span fits.
      const spansNeeded = Math.max(1, Math.ceil(slice / cfg.maxLogSpanBlocks));
      const requests = chunks.length * 2 * spansNeeded;
      return { requests, cu: requests * 60 };
    };

    log.info(totalLogs === 0 ? 'DENSITY IS ZERO IN THE SAMPLED BLOCKS' : 'density measured', {
      blocks_sampled: blocks,
      transfer_logs: totalLogs,
      logs_per_block: (totalLogs / blocks).toFixed(6),
      logs_per_slice_40k: Math.round((totalLogs / blocks) * 40000),
      natural_span_at_6000_logs: totalLogs === 0 ? 'unbounded -- the 100,000 cap binds'
        : Math.round(6000 / (totalLogs / blocks)),
      caveat: totalLogs === 0
        ? 'the per-run figures below assume one request per chunk per direction, '
          + 'which a zero-density sample cannot confirm'
        : null,
    });

    for (const slice of [20000, 40000, 80000]) {
      const p = perSlice(slice);
      log.info('projected cost per run', {
        slice_blocks: slice, requests: p.requests, cu: p.cu,
        dollars: ((p.cu * 0.45) / 1e6).toFixed(5),
        runs_per_day_at_30min: 48,
        dollars_per_day: (((p.cu * 48) * 0.45) / 1e6).toFixed(4),
        dollars_per_month: (((p.cu * 48 * 30) * 0.45) / 1e6).toFixed(3),
        note: 'transfer filters only; pool classification and decimals are one-off '
          + 'per novel pool and token, and the Swap filters are added by the watcher',
      });
    }

    log.info('probe cost', {
      cu_spent: rpc.cuSpent, dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(5),
      calls: rpc.callCounts(),
    });
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('watch-probe failed', errorFields(err)); process.exit(1); });
