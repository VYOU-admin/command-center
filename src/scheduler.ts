/**
 * The scheduler: wakes up periodically, runs whatever is due, and writes the
 * outcome to the registry.
 *
 * "Due" is computed from `last_run_at` in Postgres rather than from an in-memory
 * timer, so a redeploy does not re-run everything, and a monitor keeps its place
 * in the schedule across restarts. On a fresh database `last_run_at` is null,
 * which makes every monitor due immediately — the first run happens at boot
 * instead of an hour later.
 */

import type { AdapterContext, AnyAdapter, NormalizedRecord } from './adapters/types.js';
import type { Alerter } from './alerts.js';
import type { MonitorConfig } from './config.js';
import { errorFields, errorMessage, log } from './logger.js';
import type { Alert, DiscordSink } from './sinks/discord.js';
import { withTransaction, type Pool } from './store/db.js';
import { insertRecords } from './store/records.js';
import { getMonitorStates, recordRun, type MonitorState } from './store/registry.js';

/** Hard ceiling on a single run, whatever the adapter's own timeout says. */
const MAX_RUN_MS = 5 * 60_000;

export interface SchedulerOptions {
  pool: Pool;
  adapters: Map<string, AnyAdapter>;
  monitors: MonitorConfig[];
  alerter: Alerter;
  discord: DiscordSink;
  tickMs: number;
}

export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Set<string>();
  /**
   * When a run was last *attempted* in this process. "Due" normally comes from
   * last_run_at in Postgres, but if recording an outcome fails, that column
   * never advances and the monitor would look due on every single tick —
   * hammering the upstream source. This is the belt to that braces.
   */
  private readonly lastAttempt = new Map<string, number>();
  private stopping = false;

  constructor(private readonly opts: SchedulerOptions) {}

  start(): void {
    log.info('scheduler started', {
      tick_ms: this.opts.tickMs,
      monitors: this.opts.monitors.filter((m) => m.enabled).map((m) => m.id),
    });
    // Run one tick immediately so a fresh deploy produces data right away.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    // Give in-flight runs a moment to finish writing their result.
    const deadline = Date.now() + 15_000;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    log.info('scheduler stopped', { abandoned_runs: this.inFlight.size });
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const now = new Date();

    try {
      const enabled = this.opts.monitors.filter((m) => m.enabled);
      const states = await getMonitorStates(
        this.opts.pool,
        enabled.map((m) => m.id),
      );
      const byId = new Map(states.map((s) => [s.id, s]));

      const due = enabled.filter((config) => {
        if (this.inFlight.has(config.id)) return false;
        const attempted = this.lastAttempt.get(config.id);
        if (attempted !== undefined && now.getTime() - attempted < config.scheduleMs) {
          return false;
        }
        return isDue(byId.get(config.id), config, now);
      });

      // Monitors are independent; one slow feed must not delay the others.
      await Promise.all(due.map((config) => this.runMonitor(config)));

      await this.opts.alerter.checkForSilentFailures(this.opts.monitors, new Date());
    } catch (err) {
      // A tick failing (usually Postgres being unreachable) must not kill the
      // interval — the next tick retries, and staleness covers a long outage.
      log.error('scheduler tick failed', errorFields(err));
    }
  }

  /** Run one monitor to completion and record the outcome. Never throws. */
  async runMonitor(config: MonitorConfig): Promise<void> {
    if (this.inFlight.has(config.id)) {
      log.warn('skipping run, previous run still in flight', { monitor_id: config.id });
      return;
    }
    this.inFlight.add(config.id);
    this.lastAttempt.set(config.id, Date.now());

    const runLog = log.child({ monitor_id: config.id, source: config.source });
    const startedAt = new Date();
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), Math.min(config.scheduleMs, MAX_RUN_MS));

    let recordCount = 0;
    let newRecordCount = 0;
    let error: string | null = null;

    // Adapters raise content alerts (a token entering the top N) while writing,
    // but network I/O must not happen inside the persist transaction. They are
    // collected here and flushed once the write is durable.
    const pendingAlerts: Alert[] = [];

    try {
      const adapter = this.opts.adapters.get(config.source);
      if (!adapter) throw new Error(`no adapter registered for source "${config.source}"`);

      runLog.info('run started');

      const ctx: AdapterContext = {
        monitorId: config.id,
        monitorName: config.name,
        options: config.options,
        log: runLog,
        signal: controller.signal,
        db: this.opts.pool,
        queueAlert: (alert) => pendingAlerts.push(alert),
      };

      const records = await adapter.fetch(ctx);
      recordCount = records.length;

      // Storage shape belongs to the adapter; document-shaped sources that
      // declare no persist() fall back to the shared record store.
      newRecordCount = await withTransaction(this.opts.pool, (client) =>
        adapter.persist
          ? adapter.persist(ctx, client, records)
          : insertRecords(client, config.id, records as NormalizedRecord[]),
      );

      // Content alerts belong to the monitor's topic channel; failures do not,
      // and are routed to the system channel by the Alerter instead.
      for (const alert of pendingAlerts) {
        await this.opts.discord.send(alert, config.alerts.channel);
      }

      runLog.info('run succeeded', {
        record_count: recordCount,
        new_record_count: newRecordCount,
        alerts_sent: pendingAlerts.length,
        alert_channel: config.alerts.channel,
        duration_ms: Date.now() - startedAt.getTime(),
      });
    } catch (err) {
      error = errorMessage(err);
      runLog.error('run failed', errorFields(err));
    } finally {
      clearTimeout(guard);
      this.inFlight.delete(config.id);
    }

    // Recording the outcome is separate from performing it: a failed run still
    // has to land in the registry, or the failure would be invisible.
    let state: MonitorState;
    try {
      state = await withTransaction(this.opts.pool, (client) =>
        recordRun(client, {
          monitorId: config.id,
          startedAt,
          finishedAt: new Date(),
          status: error === null ? 'success' : 'failure',
          recordCount,
          newRecordCount,
          error,
        }),
      );
    } catch (err) {
      log.error('could not record run outcome', {
        monitor_id: config.id,
        ...errorFields(err),
      });
      return;
    }

    try {
      await this.opts.alerter.onRunFinished(config, state);
    } catch (err) {
      log.error('alerting failed after run', { monitor_id: config.id, ...errorFields(err) });
    }
  }
}

export function isDue(
  state: MonitorState | undefined,
  config: MonitorConfig,
  now: Date,
): boolean {
  if (!state?.lastRunAt) return true;
  return now.getTime() - state.lastRunAt.getTime() >= config.scheduleMs;
}
