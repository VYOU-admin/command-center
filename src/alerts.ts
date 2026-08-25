/**
 * Alerting policy — the answer to "a monitor that stops working must surface
 * somewhere".
 *
 * Two distinct failure shapes are covered, because they look different in the
 * data:
 *
 *  1. The monitor runs and throws. Counted by consecutive_failures; alerts at
 *     the threshold in the monitor's config (3 for CoinDesk).
 *  2. The monitor stops running at all — a wedged scheduler, a crash loop, a
 *     config that quietly stopped matching. Consecutive failures stays at 0
 *     forever, so nothing above would ever fire. The staleness watchdog exists
 *     to catch exactly this case.
 *
 * Alerts fire on edges, not on every tick, so a long outage is one message plus
 * one recovery message rather than a siren.
 *
 * Everything raised here goes to the system channel regardless of which monitor
 * broke. Routing an outage to the monitor's own topic channel would scatter
 * operational failures across topic feeds, and the crypto channel is the wrong
 * place to learn that the crypto monitor stopped running.
 */

import { DEFAULT_ALERT_CHANNEL, type MonitorConfig } from './config.js';
import type { Env } from './env.js';
import { assessMonitor, staleAfterMs, type MonitorHealth } from './health.js';
import { log } from './logger.js';
import type { DiscordSink } from './sinks/discord.js';
import type { Pool } from './store/db.js';
import {
  getMonitorStates,
  setFailureAlertSent,
  setStaleAlertAt,
  type MonitorState,
} from './store/registry.js';

/** Don't re-nag about the same stale monitor more than once every 6 hours. */
const STALE_REALERT_MS = 6 * 60 * 60 * 1000;

function describeAge(seconds: number | null): string {
  if (seconds === null) return 'never';
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${(seconds / 3600).toFixed(1)}h ago`;
  return `${(seconds / 86_400).toFixed(1)}d ago`;
}

export class Alerter {
  constructor(
    private readonly pool: Pool,
    private readonly discord: DiscordSink,
    private readonly env: Env,
  ) {}

  private dashboardField(): { name: string; value: string; inline: boolean }[] {
    return this.env.publicUrl
      ? [{ name: 'Dashboard', value: this.env.publicUrl, inline: false }]
      : [];
  }

  /**
   * Called after every run. Fires on two edges: crossing the failure threshold,
   * and recovering after having alerted.
   */
  async onRunFinished(config: MonitorConfig, state: MonitorState): Promise<void> {
    const health = assessMonitor(config, state);
    const threshold = config.alerts.discordOnConsecutiveFailures;

    if (state.lastStatus === 'failure' && state.consecutiveFailures >= threshold) {
      if (state.failureAlertSent) return; // already announced; stay quiet
      await this.discord.send({
        level: 'critical',
        title: `${config.name} has failed ${state.consecutiveFailures} runs in a row`,
        description:
          `Monitor \`${config.id}\` (source: \`${config.source}\`) has failed its last ` +
          `${state.consecutiveFailures} consecutive runs. Ingest for this source has stopped.`,
        fields: [
          { name: 'Last error', value: `\`\`\`${state.lastError ?? 'unknown'}\`\`\``, inline: false },
          { name: 'Last success', value: describeAge(health.secondsSinceLastSuccess), inline: true },
          { name: 'Schedule', value: config.schedule, inline: true },
          ...this.dashboardField(),
        ],
      }, DEFAULT_ALERT_CHANNEL);
      await setFailureAlertSent(this.pool, config.id, true);
      log.warn('failure threshold crossed, alert sent', {
        monitor_id: config.id,
        consecutive_failures: state.consecutiveFailures,
      });
      return;
    }

    if (state.lastStatus === 'success' && state.failureAlertSent) {
      await this.discord.send({
        level: 'recovery',
        title: `${config.name} is working again`,
        description: `Monitor \`${config.id}\` completed a successful run after a failing streak.`,
        fields: [
          { name: 'Records seen', value: String(state.lastRecordCount ?? 0), inline: true },
          { name: 'New records', value: String(state.lastNewRecordCount ?? 0), inline: true },
          ...this.dashboardField(),
        ],
      }, DEFAULT_ALERT_CHANNEL);
      await setFailureAlertSent(this.pool, config.id, false);
      log.info('monitor recovered, alert sent', { monitor_id: config.id });
    }
  }

  /**
   * Called on every scheduler tick. Catches monitors that have gone quiet
   * without ever recording a failure.
   */
  async checkForSilentFailures(configs: MonitorConfig[], now = new Date()): Promise<void> {
    const states = await getMonitorStates(this.pool, configs.map((c) => c.id));
    const byId = new Map(states.map((s) => [s.id, s]));

    for (const config of configs) {
      if (!config.enabled) continue;
      const state = byId.get(config.id);
      const health = assessMonitor(config, state, now);

      if (health.status !== 'stale') continue;
      // Already covered by the consecutive-failure alert; don't double-report.
      if (state?.failureAlertSent) continue;

      const lastAlert = state?.staleAlertAt;
      if (lastAlert && now.getTime() - lastAlert.getTime() < STALE_REALERT_MS) continue;

      await this.discord.send({
        level: 'critical',
        title: `${config.name} has gone silent`,
        description:
          `Monitor \`${config.id}\` has not had a successful run in longer than its ` +
          `expected window, and it is not reporting errors either. Something is stopping ` +
          `it from running at all — check the service logs.`,
        fields: [
          { name: 'Last success', value: describeAge(health.secondsSinceLastSuccess), inline: true },
          { name: 'Last run', value: describeAge(secondsSince(state?.lastRunAt, now)), inline: true },
          { name: 'Schedule', value: config.schedule, inline: true },
          {
            name: 'Stale after',
            value: `${Math.round(staleAfterMs(config.scheduleMs) / 60_000)}m without a success`,
            inline: true,
          },
          ...this.dashboardField(),
        ],
      }, DEFAULT_ALERT_CHANNEL);
      await setStaleAlertAt(this.pool, config.id, now);
      log.warn('stale monitor alert sent', {
        monitor_id: config.id,
        seconds_since_last_success: health.secondsSinceLastSuccess,
      });
    }
  }

  /** Announce at boot when a monitor's health is already bad, e.g. after a crash loop. */
  async reportBootState(monitors: MonitorHealth[]): Promise<void> {
    const broken = monitors.filter((m) => m.status === 'failing' || m.status === 'stale');
    if (broken.length === 0) return;
    log.warn('monitors are unhealthy at boot', {
      monitors: broken.map((m) => ({ id: m.id, status: m.status })),
    });
  }
}

function secondsSince(date: Date | null | undefined, now: Date): number | null {
  return date ? Math.max(0, Math.round((now.getTime() - date.getTime()) / 1000)) : null;
}
