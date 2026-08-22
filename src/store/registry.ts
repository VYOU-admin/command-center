/**
 * The registry: what every monitor is, when it last ran, whether that run
 * worked, and how many records it produced. This table is the single place that
 * answers "is anything quietly broken?".
 */

import type { MonitorConfig } from '../config.js';
import type { Pool, PoolClient } from './db.js';

export interface MonitorState {
  id: string;
  name: string;
  source: string;
  enabled: boolean;
  scheduleMs: number;
  lastRunAt: Date | null;
  lastStatus: 'success' | 'failure' | null;
  lastError: string | null;
  lastSuccessAt: Date | null;
  lastRecordCount: number | null;
  lastNewRecordCount: number | null;
  lastDurationMs: number | null;
  consecutiveFailures: number;
  totalRuns: number;
  totalFailures: number;
  totalRecords: number;
  failureAlertSent: boolean;
  staleAlertAt: Date | null;
}

export interface RunResult {
  monitorId: string;
  startedAt: Date;
  finishedAt: Date;
  status: 'success' | 'failure';
  recordCount: number;
  newRecordCount: number;
  error: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function toState(row: any): MonitorState {
  return {
    id: row.id,
    name: row.name,
    source: row.source,
    enabled: row.enabled,
    scheduleMs: Number(row.schedule_ms),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastSuccessAt: row.last_success_at,
    lastRecordCount: row.last_record_count,
    lastNewRecordCount: row.last_new_record_count,
    lastDurationMs: row.last_duration_ms,
    consecutiveFailures: row.consecutive_failures,
    totalRuns: Number(row.total_runs),
    totalFailures: Number(row.total_failures),
    totalRecords: Number(row.total_records),
    failureAlertSent: row.failure_alert_sent,
    staleAlertAt: row.stale_alert_at,
  };
}

/**
 * Config is the source of truth for a monitor's *definition*; the database is
 * the source of truth for its *history*. Upsert only touches the former.
 */
export async function syncMonitors(pool: Pool, monitors: MonitorConfig[]): Promise<void> {
  for (const monitor of monitors) {
    await pool.query(
      `insert into monitors (id, name, source, enabled, schedule_ms, config)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (id) do update set
         name        = excluded.name,
         source      = excluded.source,
         enabled     = excluded.enabled,
         schedule_ms = excluded.schedule_ms,
         config      = excluded.config,
         updated_at  = now()`,
      [
        monitor.id,
        monitor.name,
        monitor.source,
        monitor.enabled,
        monitor.scheduleMs,
        JSON.stringify({
          schedule: monitor.schedule,
          options: monitor.options,
          alerts: monitor.alerts,
          dashboard: monitor.dashboard,
        }),
      ],
    );
  }
}

/**
 * total_records is a running counter, incremented per run for cheap reads. A
 * counter can drift from reality — a run whose records committed but whose
 * outcome failed to record leaves it permanently short. Re-derive it from the
 * records themselves at boot so the registry heals instead of lying.
 */
export async function reconcileRecordCounts(pool: Pool): Promise<void> {
  await pool.query(
    `update monitors m
        set total_records = coalesce(
              (select count(*) from records r where r.monitor_id = m.id), 0)
      where m.total_records is distinct from coalesce(
              (select count(*) from records r where r.monitor_id = m.id), 0)`,
  );
}

export async function getMonitorStates(pool: Pool, ids?: string[]): Promise<MonitorState[]> {
  const result = ids
    ? await pool.query('select * from monitors where id = any($1) order by id', [ids])
    : await pool.query('select * from monitors order by id');
  return result.rows.map(toState);
}

export async function getMonitorState(pool: Pool, id: string): Promise<MonitorState | null> {
  const result = await pool.query('select * from monitors where id = $1', [id]);
  return result.rows[0] ? toState(result.rows[0]) : null;
}

/**
 * Record a finished run: append to history and roll the registry counters
 * forward, atomically. Returns the monitor's state *after* the update so the
 * caller can decide whether an alert edge was crossed.
 */
export async function recordRun(client: PoolClient, run: RunResult): Promise<MonitorState> {
  await client.query(
    `insert into monitor_runs
       (monitor_id, started_at, finished_at, duration_ms, status, record_count, new_record_count, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      run.monitorId,
      run.startedAt,
      run.finishedAt,
      run.finishedAt.getTime() - run.startedAt.getTime(),
      run.status,
      run.recordCount,
      run.newRecordCount,
      run.error,
    ],
  );

  const succeeded = run.status === 'success';
  const result = await client.query(
    `update monitors set
       last_run_at           = $2,
       last_status           = $3,
       last_error            = $4,
       last_success_at       = case when $5 then $2 else last_success_at end,
       last_record_count     = $6::integer,
       last_new_record_count = $7::integer,
       last_duration_ms      = $8::integer,
       consecutive_failures  = case when $5 then 0 else consecutive_failures + 1 end,
       total_runs            = total_runs + 1,
       total_failures        = total_failures + case when $5 then 0 else 1 end,
       -- $7 also feeds a bigint column; without the cast Postgres cannot deduce
       -- a single type for the parameter and rejects the whole statement.
       total_records         = total_records + $7::integer,
       stale_alert_at        = case when $5 then null else stale_alert_at end,
       updated_at            = now()
     where id = $1
     returning *`,
    [
      run.monitorId,
      run.finishedAt,
      run.status,
      run.error,
      succeeded,
      run.recordCount,
      run.newRecordCount,
      run.finishedAt.getTime() - run.startedAt.getTime(),
    ],
  );

  const row = result.rows[0];
  if (!row) throw new Error(`recordRun: monitor "${run.monitorId}" is not in the registry`);
  return toState(row);
}

export async function setFailureAlertSent(pool: Pool, id: string, sent: boolean): Promise<void> {
  await pool.query('update monitors set failure_alert_sent = $2, updated_at = now() where id = $1', [
    id,
    sent,
  ]);
}

export async function setStaleAlertAt(pool: Pool, id: string, at: Date | null): Promise<void> {
  await pool.query('update monitors set stale_alert_at = $2, updated_at = now() where id = $1', [
    id,
    at,
  ]);
}

export interface RunSummary {
  startedAt: Date;
  status: 'success' | 'failure';
  durationMs: number;
  recordCount: number;
  newRecordCount: number;
  error: string | null;
}

export async function getRecentRuns(
  pool: Pool,
  monitorId: string,
  limit = 10,
): Promise<RunSummary[]> {
  const result = await pool.query(
    `select started_at, status, duration_ms, record_count, new_record_count, error
       from monitor_runs
      where monitor_id = $1
      order by started_at desc
      limit $2`,
    [monitorId, limit],
  );
  return result.rows.map((row: any) => ({
    startedAt: row.started_at,
    status: row.status,
    durationMs: row.duration_ms,
    recordCount: row.record_count,
    newRecordCount: row.new_record_count,
    error: row.error,
  }));
}
