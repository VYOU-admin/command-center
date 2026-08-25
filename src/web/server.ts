/**
 * The web sink: a dashboard for humans and JSON for machines, both reading the
 * same tables the scheduler writes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AnyAdapter, PanelContext } from '../adapters/types.js';
import type { MonitorConfig } from '../config.js';
import { assessAll, overallStatus } from '../health.js';
import { DEFAULT_ALERT_CHANNEL } from '../config.js';
import { errorFields, log } from '../logger.js';
import type { DiscordSink } from '../sinks/discord.js';
import type { Pool } from '../store/db.js';
import { getRecentRecords } from '../store/records.js';
import { getMonitorStates, getRecentRuns } from '../store/registry.js';
import { escapeHtml, renderDashboard, renderRecordListPanel } from './views.js';

export interface WebServerOptions {
  pool: Pool;
  monitors: MonitorConfig[];
  adapters: Map<string, AnyAdapter>;
  /** Read only to report alert routing; the web sink never sends alerts. */
  discord: DiscordSink;
  port: number;
  /** Reported by /health so a deploy can be identified in logs. */
  bootedAt: Date;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(html),
  });
  res.end(html);
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function createWebServer(opts: WebServerOptions): Server {
  const { pool, monitors, bootedAt } = opts;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (path === '/health') {
      const states = await getMonitorStates(pool, monitors.map((m) => m.id));
      const health = assessAll(monitors, states);
      const overall = overallStatus(health);

      // Always 200 by default: Railway's healthcheck points here, and a broken
      // *monitor* must not read as a broken *deployment* and trigger a rollback.
      // Uptime checkers that do want a hard signal can ask for ?strict=1.
      const strict = url.searchParams.get('strict') === '1';
      // Routing is reported here because a misrouted alert is a silent failure:
      // it fires, it just lands somewhere nobody reads. Only the channel name
      // and which variable supplied it — never the webhook URL.
      const channels = new Set([DEFAULT_ALERT_CHANNEL, ...monitors.map((m) => m.alerts.channel)]);

      sendJson(res, strict && overall === 'degraded' ? 503 : 200, {
        status: overall,
        booted_at: bootedAt.toISOString(),
        alert_routing: {
          failure_and_recovery: DEFAULT_ALERT_CHANNEL,
          channels: [...channels].map((c) => {
            const r = opts.discord.resolve(c);
            return {
              channel: c,
              resolved_via: r.via,
              env_var: r.envVar,
              monitors: monitors.filter((m) => m.alerts.channel === c).map((m) => m.id),
            };
          }),
        },
        uptime_seconds: Math.round(process.uptime()),
        checked_at: new Date().toISOString(),
        monitors: health.map((m) => ({
          id: m.id,
          name: m.name,
          status: m.status,
          last_successful_run: m.lastSuccessAt,
          seconds_since_last_success: m.secondsSinceLastSuccess,
          last_run: m.lastRunAt,
          last_run_status: m.lastStatus,
          last_error: m.lastError,
          consecutive_failures: m.consecutiveFailures,
          next_run_due: m.nextRunAt,
          stale_after_seconds: m.staleAfterSeconds,
        })),
      });
      return;
    }

    if (path === '/api/monitors') {
      const states = await getMonitorStates(pool, monitors.map((m) => m.id));
      const health = assessAll(monitors, states);
      const withRuns = await Promise.all(
        health.map(async (m) => ({
          ...m,
          recent_runs: (await getRecentRuns(pool, m.id, 10)).map((r) => ({
            started_at: r.startedAt.toISOString(),
            status: r.status,
            duration_ms: r.durationMs,
            record_count: r.recordCount,
            new_record_count: r.newRecordCount,
            error: r.error,
          })),
        })),
      );
      sendJson(res, 200, { status: overallStatus(health), monitors: withRuns });
      return;
    }

    if (path === '/api/records') {
      const hours = clampInt(url.searchParams.get('hours'), defaultWindow(monitors), 1, 24 * 30);
      const limit = clampInt(url.searchParams.get('limit'), 200, 1, 1000);
      const monitorId = url.searchParams.get('monitor');
      if (monitorId && !monitors.some((m) => m.id === monitorId)) {
        sendJson(res, 404, { error: `unknown monitor "${monitorId}"` });
        return;
      }
      const records = await getRecentRecords(pool, {
        hours,
        limit,
        ...(monitorId ? { monitorId } : {}),
      });
      sendJson(res, 200, {
        window_hours: hours,
        count: records.length,
        records: records.map((r) => ({
          monitor_id: r.monitorId,
          external_id: r.externalId,
          title: r.title,
          url: r.url,
          published_at: r.publishedAt?.toISOString() ?? null,
          summary: r.summary,
          first_seen_at: r.firstSeenAt.toISOString(),
        })),
      });
      return;
    }

    if (path === '/') {
      const states = await getMonitorStates(pool, monitors.map((m) => m.id));
      const health = assessAll(monitors, states);

      // Each monitor renders its own panel. One panel failing must not blank the
      // whole dashboard — the status cards above it are the thing you most need
      // to see when something is broken.
      const panels = await Promise.all(
        monitors.map(async (monitor) => {
          const panelCtx: PanelContext = {
            db: pool,
            monitorId: monitor.id,
            monitorName: monitor.name,
            options: monitor.options,
            windowHours: monitor.dashboard.windowHours,
          };
          try {
            const adapter = opts.adapters.get(monitor.source);
            if (adapter?.renderPanel) return await adapter.renderPanel(panelCtx);
            const records = await getRecentRecords(pool, {
              hours: monitor.dashboard.windowHours,
              monitorId: monitor.id,
              limit: 200,
            });
            return renderRecordListPanel({
              monitorName: monitor.name,
              records,
              windowHours: monitor.dashboard.windowHours,
            });
          } catch (err) {
            log.error('panel render failed', { monitor_id: monitor.id, ...errorFields(err) });
            return (
              `<h2 class="section">${escapeHtml(monitor.name)}</h2>` +
              `<p class="error">This panel failed to render: ${escapeHtml((err as Error).message)}</p>`
            );
          }
        }),
      );

      sendHtml(
        res,
        200,
        renderDashboard({
          monitors: health,
          panels,
          overall: overallStatus(health),
          generatedAt: new Date(),
        }),
      );
      return;
    }

    sendJson(res, 404, { error: 'not found', routes: ['/', '/health', '/api/monitors', '/api/records'] });
  };

  return createServer((req, res) => {
    const started = Date.now();
    handler(req, res).catch((err) => {
      // Usually Postgres being unreachable. Surface it rather than hanging.
      log.error('request failed', { path: req.url, ...errorFields(err) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
    res.on('finish', () => {
      log.debug('request', {
        method: req.method,
        path: req.url,
        status: res.statusCode,
        duration_ms: Date.now() - started,
      });
    });
  });
}

/** The dashboard window is per-monitor config; use the widest one asked for. */
function defaultWindow(monitors: MonitorConfig[]): number {
  return monitors.reduce((max, m) => Math.max(max, m.dashboard.windowHours), 1);
}
