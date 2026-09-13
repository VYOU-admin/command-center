/**
 * Backlog runner: `npm run catch-up -- <monitor-id> [--max-cycles N]`
 *
 * Runs one cursor-driven monitor repeatedly until its cursor stops advancing,
 * a cycle fails, or the cycle limit is reached. Each cycle is a real run and is
 * recorded in the registry, so the backlog is not a special path through the
 * code -- it is the hourly job, executed back to back.
 *
 * IT STOPS ON THE FIRST FAILURE. Continuing past a failed cycle would leave a
 * gap behind a cursor that later advances past it.
 *
 * THE CYCLE LIMIT IS REQUIRED, NOT ADVISORY. A hard ceiling inside the job is
 * the only thing that protects against a scope error in the first request; an
 * account-level cap protects only the wallet.
 */

import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { Scheduler } from '../scheduler.js';
import { getMonitorState } from '../store/registry.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const monitorId = args.find((a) => !a.startsWith('--'));
  const limitFlag = args.indexOf('--max-cycles');
  const maxCycles = limitFlag >= 0 ? Number.parseInt(args[limitFlag + 1] ?? '', 10) : 40;

  if (!monitorId) throw new Error('usage: catch-up <monitor-id> [--max-cycles N]');
  if (!Number.isInteger(maxCycles) || maxCycles < 1) {
    throw new Error(`--max-cycles must be a positive integer, got: ${String(maxCycles)}`);
  }

  const app = await bootstrap();
  const config = app.monitors.find((m) => m.id === monitorId);
  if (!config) throw new Error(`unknown monitor id: ${monitorId}`);

  const chain = String(config.options['chain'] ?? '');
  const token = String(config.options['token'] ?? '');
  if (!chain || !token) {
    throw new Error(`monitor "${monitorId}" has no chain/token options; it has no cursor`);
  }

  const readCursor = async (): Promise<number | null> => {
    const res = await app.pool.query<{ cursor_block: number }>(
      `select cursor_block from token_ingest_cursor
        where chain = $1 and token = $2 and kind = 'swap'`,
      [chain, token],
    );
    return res.rowCount === 0 ? null : Number(res.rows[0]!.cursor_block);
  };

  const scheduler = new Scheduler({
    pool: app.pool,
    adapters: app.adapters,
    monitors: app.monitors,
    alerter: app.alerter,
    discord: app.discord,
    tickMs: app.env.tickMs,
    platform: app.env.platform,
    configVars: app.env.configVars,
    publicUrl: app.env.publicUrl,
  });

  const startCursor = await readCursor();
  let cycles = 0;
  let rowsStored = 0;
  let failed: string | null = null;
  let before = startCursor;

  log.info('catch-up starting', {
    monitor_id: monitorId,
    cursor_before: startCursor,
    max_cycles: maxCycles,
  });

  while (cycles < maxCycles) {
    cycles += 1;
    await scheduler.runMonitor(config);
    const state = await getMonitorState(app.pool, config.id);

    if (state?.lastStatus !== 'success') {
      failed = state?.lastError ?? 'run did not report success';
      log.error('catch-up stopping on a failed cycle', { cycle: cycles, error: failed });
      break;
    }
    rowsStored += state.lastNewRecordCount ?? 0;
    const after = await readCursor();
    log.info('catch-up cycle', {
      cycle: cycles,
      cursor_before: before,
      cursor_after: after,
      blocks_covered: before !== null && after !== null ? after - before : null,
      rows_seen: state.lastRecordCount ?? 0,
      rows_stored: state.lastNewRecordCount ?? 0,
      duration_ms: state.lastDurationMs ?? null,
    });

    if (after !== null && before !== null && after <= before) {
      log.info('catch-up complete: the cursor did not advance, so it is at the head', {
        cursor: after,
        cycles,
      });
      break;
    }
    before = after;
  }

  const endCursor = await readCursor();
  log.info('catch-up finished', {
    monitor_id: monitorId,
    cycles_run: cycles,
    hit_cycle_limit: cycles >= maxCycles && failed === null,
    cursor_before: startCursor,
    cursor_after: endCursor,
    blocks_covered:
      startCursor !== null && endCursor !== null ? endCursor - startCursor : null,
    rows_stored: rowsStored,
    failed,
  });

  await app.pool.end();
  process.exit(failed === null ? 0 : 1);
}

main().catch((err) => {
  log.error('catch-up failed', errorFields(err));
  process.exit(1);
});
