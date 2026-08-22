/**
 * One place decides whether a monitor is healthy. The /health endpoint, the
 * dashboard, and the stale-monitor watchdog all read from this, so they can
 * never disagree about whether something is broken.
 */

import type { MonitorConfig } from './config.js';
import type { MonitorState } from './store/registry.js';

export type HealthStatus =
  /** Ran recently and succeeded. */
  | 'ok'
  /** Configured but has never run — normal for the first minute after a deploy. */
  | 'pending'
  /** Last run failed, but not enough times in a row to alert yet. */
  | 'degraded'
  /** Consecutive failures reached the monitor's alert threshold. */
  | 'failing'
  /** No successful run in far longer than its schedule. The silent-failure case. */
  | 'stale'
  /** Turned off in config. Not a problem. */
  | 'disabled';

/** Statuses that mean "a human should look at this". */
const UNHEALTHY: ReadonlySet<HealthStatus> = new Set<HealthStatus>(['failing', 'stale']);

/**
 * How long past its schedule a monitor may go without a success before we call
 * it stale: two full intervals plus slack for a slow run or a deploy restart.
 */
export function staleAfterMs(scheduleMs: number): number {
  return scheduleMs * 2 + 5 * 60_000;
}

export interface MonitorHealth {
  id: string;
  name: string;
  source: string;
  status: HealthStatus;
  enabled: boolean;
  schedule: string;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastStatus: 'success' | 'failure' | null;
  lastError: string | null;
  lastRecordCount: number | null;
  lastNewRecordCount: number | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
  totalRecords: number;
  /** Seconds since the last successful run; null if it has never succeeded. */
  secondsSinceLastSuccess: number | null;
  /** When the scheduler will next consider this monitor due. */
  nextRunAt: string | null;
  staleAfterSeconds: number;
}

export function assessMonitor(
  config: MonitorConfig,
  state: MonitorState | undefined,
  now: Date = new Date(),
): MonitorHealth {
  const secondsSinceLastSuccess = state?.lastSuccessAt
    ? Math.max(0, Math.round((now.getTime() - state.lastSuccessAt.getTime()) / 1000))
    : null;

  const status = ((): HealthStatus => {
    if (!config.enabled) return 'disabled';
    if (!state || state.totalRuns === 0) return 'pending';
    if (state.consecutiveFailures >= config.alerts.discordOnConsecutiveFailures) return 'failing';

    // Staleness means "no success in far too long". With no success ever, the
    // clock runs from when the monitor was registered — otherwise a brand-new
    // monitor that fails once would immediately read as having gone silent,
    // which is both wrong and the opposite of what is happening: it is running
    // and erroring, and the consecutive-failure path is the one that should
    // speak for it.
    const reference = state.lastSuccessAt ?? state.createdAt;
    if (now.getTime() - reference.getTime() > staleAfterMs(config.scheduleMs)) {
      return 'stale';
    }

    if (state.lastStatus === 'failure') return 'degraded';
    return 'ok';
  })();

  const nextRunAt =
    config.enabled && state?.lastRunAt
      ? new Date(state.lastRunAt.getTime() + config.scheduleMs).toISOString()
      : null;

  return {
    id: config.id,
    name: config.name,
    source: config.source,
    status,
    enabled: config.enabled,
    schedule: config.schedule,
    lastRunAt: state?.lastRunAt?.toISOString() ?? null,
    lastSuccessAt: state?.lastSuccessAt?.toISOString() ?? null,
    lastStatus: state?.lastStatus ?? null,
    lastError: state?.lastError ?? null,
    lastRecordCount: state?.lastRecordCount ?? null,
    lastNewRecordCount: state?.lastNewRecordCount ?? null,
    lastDurationMs: state?.lastDurationMs ?? null,
    consecutiveFailures: state?.consecutiveFailures ?? 0,
    totalRuns: state?.totalRuns ?? 0,
    totalFailures: state?.totalFailures ?? 0,
    totalRecords: state?.totalRecords ?? 0,
    secondsSinceLastSuccess,
    nextRunAt,
    staleAfterSeconds: Math.round(staleAfterMs(config.scheduleMs) / 1000),
  };
}

export function assessAll(
  configs: MonitorConfig[],
  states: MonitorState[],
  now: Date = new Date(),
): MonitorHealth[] {
  const byId = new Map(states.map((s) => [s.id, s]));
  return configs.map((config) => assessMonitor(config, byId.get(config.id), now));
}

export function isUnhealthy(status: HealthStatus): boolean {
  return UNHEALTHY.has(status);
}

export function overallStatus(monitors: MonitorHealth[]): 'ok' | 'degraded' {
  return monitors.some((m) => isUnhealthy(m.status)) ? 'degraded' : 'ok';
}
