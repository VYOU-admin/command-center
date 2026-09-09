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

  const c = await app.pool.connect();
  try {
    const plan = await planTimestamps(c, cfg);
    log.info('BEFORE THE FIRST REQUEST', {
      ...plan, ceiling,
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
