/**
 * Service entrypoint: one process running the web sink and the scheduler.
 */

import { bootstrap } from './bootstrap.js';
import { assessAll } from './health.js';
import { errorFields, log } from './logger.js';
import { Scheduler } from './scheduler.js';
import { getMonitorStates } from './store/registry.js';
import { createWebServer } from './web/server.js';

async function main(): Promise<void> {
  const bootedAt = new Date();
  const app = await bootstrap();

  const server = createWebServer({
    pool: app.pool,
    monitors: app.monitors,
    discord: app.discord,
    port: app.env.port,
    bootedAt,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Bind on all interfaces: Railway routes to the container's PORT.
    server.listen(app.env.port, '0.0.0.0', resolve);
  });
  log.info('web server listening', { port: app.env.port, public_url: app.env.publicUrl });

  // If the previous deploy left something broken, say so at boot rather than
  // waiting for the next scheduled run to rediscover it.
  const states = await getMonitorStates(app.pool, app.monitors.map((m) => m.id));
  await app.alerter.reportBootState(assessAll(app.monitors, states));

  const scheduler = new Scheduler({
    pool: app.pool,
    adapters: app.adapters,
    monitors: app.monitors,
    alerter: app.alerter,
    discord: app.discord,
    tickMs: app.env.tickMs,
    platform: app.env.platform,
  });
  scheduler.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down', { signal });

    // Railway sends SIGTERM on redeploy; finish in-flight work, then exit so a
    // deploy does not leave a half-written run behind.
    void (async () => {
      const timer = setTimeout(() => {
        log.warn('shutdown timed out, exiting anyway');
        process.exit(1);
      }, 25_000);
      timer.unref();

      await scheduler.stop();

      // Adapters holding a persistent connection need two things on the way
      // out, in this order. First a final run, which for a streaming source
      // drains and commits whatever it buffered since the last scheduled drain
      // — without it a Railway redeploy silently loses those events. Only then
      // is it safe to close the socket.
      const streaming = app.monitors.filter(
        (m) => m.enabled && app.adapters.get(m.source)?.shutdown,
      );

      for (const monitor of streaming) {
        try {
          await scheduler.runMonitor(monitor);
        } catch (err) {
          log.error('final drain failed', { monitor_id: monitor.id, ...errorFields(err) });
        }
      }

      for (const [type, adapter] of app.adapters) {
        if (!adapter.shutdown) continue;
        try {
          await adapter.shutdown();
          log.info('adapter shut down', { source: type });
        } catch (err) {
          log.error('adapter shutdown failed', { source: type, ...errorFields(err) });
        }
      }

      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.pool.end().catch(() => {});
      clearTimeout(timer);
      log.info('shutdown complete');
      process.exit(0);
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // An unhandled rejection would otherwise kill the process with no explanation,
  // which is the worst kind of silent failure.
  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', errorFields(reason));
  });
}

main().catch((err) => {
  log.error('fatal: could not start', errorFields(err));
  process.exit(1);
});
