/**
 * `npm run sweep-transfers -- <config.yaml> --from N --to M [--ceiling C]`
 *
 * Sweeps one token's `Transfer` logs into `token_transfer_logs`, plus the
 * `block_times` each log carries, recording each committed range in
 * `token_sweep_progress`.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE INTAKE. The intake reaches its sweep only
 * after the pool and scope phases, both of which STOP for review and both of
 * which cost real money on a token with 4,856 pools. A transfer sweep needs
 * neither: the filter is the token's own Transfer topic, with no pool set and no
 * counter assets involved. Everything it shares with the intake -- span sizing,
 * the three refusal responses, the range record, the row insert -- is the same
 * code, so there is one implementation of each.
 *
 * Progress is committed per range, so a run that dies leaves a truthful partial
 * record and the gap check afterwards is meaningful. See docs/ROBINHOOD.md
 * step 5.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { adaptiveSweep, checkCoverage, recordSweepRange } from '../intake/sweep.js';
import { TOPICS, decodeTransfer } from '../adapters/token-updates/decode.js';
import { withTransaction } from '../store/db.js';
import { SCHEMA as TOKEN_UPDATE_SCHEMA } from '../adapters/token-updates/schema.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: sweep-transfers <config.yaml> --from N --to M');
  const num = (f: string, d: number): number => {
    const i = args.indexOf(f);
    return i >= 0 ? Number.parseInt(args[i + 1] ?? String(d), 10) : d;
  };
  const from = num('--from', 0);
  const to = num('--to', 0);
  const ceiling = num('--ceiling', 25000);
  if (!from || !to || to <= from) throw new Error('--from and --to are required');

  const cfg = await loadIntakeConfig(configPath);
  const app = await bootstrap();
  const key = app.env.configVars.get(cfg.rpcKeyVar);
  if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
  const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
    cfg.requestTimeoutMs, ceiling);

  await withTransaction(app.pool, async (c) => { await c.query(TOKEN_UPDATE_SCHEMA); });

  log.info('transfer sweep starting', {
    token: cfg.token, ticker: cfg.ticker, chain: cfg.chain,
    blocks: `${from}..${to}`, span: to - from + 1, ceiling,
    start_span: cfg.maxLogSpanBlocks, min_span: cfg.minLogSpanBlocks,
    target_logs_per_request: cfg.targetLogsPerRequest,
  });

  let stored = 0;
  let stamps = 0;
  let failure: string | null = null;
  let stats;
  try {
    stats = await adaptiveSweep(
      rpc, cfg, { address: cfg.token, topics: [TOPICS.transfer] }, from, to,
      async (logs, rangeFrom, rangeTo) => {
        // Committed per range, so a death leaves a truthful partial record.
        await withTransaction(app.pool, async (c) => {
          for (const l of logs) {
            const d = decodeTransfer(l);
            const r = await c.query(
              `insert into token_transfer_logs
                 (chain, token, block_number, log_index, tx_hash, from_addr, to_addr, amount)
               values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
              [cfg.chain, cfg.token, d.block, d.logIndex, d.txHash, d.from, d.to,
                d.amount.toString()],
            );
            stored += r.rowCount ?? 0;
            const b = await c.query(
              `insert into block_times (chain, block_number, block_time)
               values ($1,$2,to_timestamp($3)) on conflict do nothing`,
              [cfg.chain, d.block, d.timestamp],
            );
            stamps += b.rowCount ?? 0;
          }
          await recordSweepRange(c, cfg, 'transfer', rangeFrom, rangeTo, logs.length);
        });
      },
    );
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }

  const coverage = await withTransaction(app.pool, async (c) =>
    checkCoverage(c, cfg, 'transfer', from, to));

  log.info('transfer sweep finished', {
    failed: failure,
    requests: stats?.requests ?? 0,
    logs_returned: stats?.logs ?? 0,
    rows_stored: stored,
    block_times_stored: stamps,
    size_refusals: stats?.sizeRefusals ?? 0,
    rate_refusals: stats?.rateRefusals ?? 0,
    smallest_span: stats?.smallestSpan ?? 0,
    largest_span: stats?.largestSpan ?? 0,
    blocks_covered: stats?.blocksCovered ?? 0,
    cu_spent: rpc.cuSpent,
    dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(4),
    ceiling,
  });
  log.info('coverage check', { ...coverage });
  await app.pool.end();
  process.exit(failure ? 1 : 0);
}

main().catch((err) => { log.error('sweep-transfers failed', errorFields(err)); process.exit(1); });
