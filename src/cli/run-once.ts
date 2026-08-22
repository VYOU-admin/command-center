/**
 * One-shot runner: `npm run run-once [monitor-id ...]`
 *
 * Runs the given monitors (or all enabled ones) immediately, ignoring the
 * schedule, then exits. Useful for verifying a new adapter or a deployment
 * without waiting for the next tick. Writes to the same tables as the service,
 * so a run here counts as a real run in the registry.
 */

import { bootstrap } from '../bootstrap.js';
import { assessMonitor } from '../health.js';
import { errorFields, log } from '../logger.js';
import { Scheduler } from '../scheduler.js';
import { getMonitorState } from '../store/registry.js';

async function main(): Promise<void> {
  const app = await bootstrap();
  const requested = process.argv.slice(2);

  const targets = requested.length
    ? app.monitors.filter((m) => requested.includes(m.id))
    : app.monitors.filter((m) => m.enabled);

  const unknown = requested.filter((id) => !app.monitors.some((m) => m.id === id));
  if (unknown.length) {
    throw new Error(`unknown monitor id(s): ${unknown.join(', ')}`);
  }
  if (targets.length === 0) {
    throw new Error('no monitors to run');
  }

  const scheduler = new Scheduler({
    pool: app.pool,
    adapters: app.adapters,
    monitors: app.monitors,
    alerter: app.alerter,
    tickMs: app.env.tickMs,
  });

  let failures = 0;
  for (const config of targets) {
    await scheduler.runMonitor(config);
    const state = await getMonitorState(app.pool, config.id);
    const health = assessMonitor(config, state ?? undefined);
    log.info('run-once result', {
      monitor_id: config.id,
      status: health.status,
      last_run_status: health.lastStatus,
      records_seen: health.lastRecordCount,
      new_records: health.lastNewRecordCount,
      duration_ms: health.lastDurationMs,
      error: health.lastError,
    });
    if (health.lastStatus !== 'success') failures += 1;
  }

  await app.pool.end();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  log.error('run-once failed', errorFields(err));
  process.exit(1);
});
