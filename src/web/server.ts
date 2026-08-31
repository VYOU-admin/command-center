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
import { renderCatePnlPage, type CatePnlRow, type ClusterRow } from './cate-pnl.js';

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

    // Tag editing is the one thing the dashboard writes. Everything else stays
    // read-only, so the surface that can change data is a single named path.
    if (req.method === 'POST' && (path === '/api/wallet-tag' || path === '/api/tag-rename')) {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 1_000_000) {
          sendJson(res, 413, { error: 'body too large' });
          return;
        }
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw || '{}') as Record<string, unknown>;
      } catch {
        sendJson(res, 400, { error: 'invalid json' });
        return;
      }
      try {
        if (path === '/api/wallet-tag') {
          const wallets = Array.isArray(body.wallets) ? body.wallets.map(String) : [];
          const tagRaw = body.tag;
          const tag = tagRaw === null || tagRaw === '' ? null : String(tagRaw).trim().slice(0, 64);
          if (wallets.length === 0) {
            sendJson(res, 400, { error: 'no wallets given' });
            return;
          }
          // Marked 'manual' so a later regroup, which only rewrites its own
          // rows, can never silently undo a hand edit.
          const r = await pool.query(
            `update wallet_pnl
                set tag = $1::text,
                    tag_source = case when $1::text is null then null else 'manual' end
              where wallet = any($2::text[]) returning wallet`,
            [tag, wallets],
          );
          sendJson(res, 200, { ok: true, updated: r.rowCount ?? 0, tag });
          return;
        }
        const from = String(body.from ?? '').trim();
        const to = body.to === null || body.to === '' ? null : String(body.to).trim().slice(0, 64);
        if (!from) {
          sendJson(res, 400, { error: 'missing from' });
          return;
        }
        const r = await pool.query(
          `update wallet_pnl
              set tag = $1::text,
                  tag_source = case when $1::text is null then null else 'manual' end
            where tag = $2::text returning wallet`,
          [to, from],
        );
        sendJson(res, 200, { ok: true, updated: r.rowCount ?? 0, tag: to });
        return;
      } catch (err) {
        log.error('tag write failed', errorFields(err as Error));
        sendJson(res, 500, { error: 'write failed' });
        return;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    if (path === '/cate') {
      // A finished analysis rather than a monitor: one small static table, read
      // whole and handed to the browser to sort and paginate.
      const r = await pool.query(
        // LEFT join: the union tab must keep its exact row set. A wallet with
        // no cluster keeps its row with nulls rather than disappearing.
        `select p.token, p.chain, p.quote_asset, p.wallet, p.tag, p.tag_source,
                p.first_buy_time_utc, p.first_buy_mcap_usd, p.last_sell_time_utc,
                p.n_buys, p.n_sells, p.sol_in, p.sol_out, p.realized_pnl_sol,
                p.realized_pnl_usd, p.tokens_still_held, p.hold_min, p.sold_out,
                p.rate_basis, p.pre_window_entry,
                c.cluster_id, c.cluster_signal, c.cluster_confidence, c.cluster_count
           from wallet_pnl p
           -- AGGREGATED, not a plain join. wallet_clusters is keyed
           -- (chain, wallet, signal, cluster_id) so a wallet can hold several
           -- clusters; joining rows directly would multiply a wallet into
           -- several union rows and silently inflate the table.
           left join lateral (
             select count(*)::int                              as cluster_count,
                    min(x.cluster_id)                          as cluster_id,
                    string_agg(distinct x.signal, '+' order by x.signal) as cluster_signal,
                    min(case x.confidence when 'high' then '1high'
                                          when 'medium' then '2medium'
                                          else '3low' end)     as cluster_confidence
               from wallet_clusters x
              where x.chain = p.chain and x.wallet = p.wallet
           ) c on true
          order by p.token, p.realized_pnl_sol desc`,
      );
      const rows: CatePnlRow[] = r.rows.map((x: Record<string, unknown>) => ({
        token: String(x.token ?? 'CATE'),
        chain: String(x.chain ?? 'solana'),
        quote_asset: String(x.quote_asset ?? 'SOL'),
        cluster_id: x.cluster_id == null ? null : String(x.cluster_id),
        cluster_signal: x.cluster_signal == null ? null : String(x.cluster_signal),
        cluster_confidence: x.cluster_confidence == null ? null
          : String(x.cluster_confidence).replace(/^\d/, ''),
        cluster_count: Number(x.cluster_count ?? 0),
        rate_basis: x.rate_basis == null ? null : String(x.rate_basis),
        pre_window_entry: x.pre_window_entry === true,
        wallet: String(x.wallet),
        tag: x.tag === null ? null : String(x.tag),
        tag_source: x.tag_source === null ? null : String(x.tag_source),
        first_buy_time_utc: String(x.first_buy_time_utc ?? ''),
        first_buy_mcap_usd: Number(x.first_buy_mcap_usd ?? 0),
        last_sell_time_utc: x.last_sell_time_utc === null ? null : String(x.last_sell_time_utc),
        n_buys: Number(x.n_buys ?? 0),
        n_sells: Number(x.n_sells ?? 0),
        sol_in: Number(x.sol_in ?? 0),
        sol_out: Number(x.sol_out ?? 0),
        realized_pnl_sol: Number(x.realized_pnl_sol ?? 0),
        realized_pnl_usd: Number(x.realized_pnl_usd ?? 0),
        tokens_still_held: Number(x.tokens_still_held ?? 0),
        hold_min: x.hold_min === null ? null : Number(x.hold_min),
        sold_out: Boolean(x.sold_out),
      }));
      // Every cluster row, including wallets with no PnL — that is the point
      // of the separate table and the Groups tab depends on it.
      const cr = await pool.query(
        `select c.chain, c.wallet, c.cluster_id, c.signal, c.evidence, c.confidence,
                c.cluster_size,
                exists (select 1 from wallet_pnl p
                         where p.chain = c.chain and p.wallet = c.wallet) as has_pnl
           from wallet_clusters c
          order by c.cluster_id, c.wallet`,
      );
      const clusters: ClusterRow[] = cr.rows.map((x: Record<string, unknown>) => ({
        chain: String(x.chain), wallet: String(x.wallet),
        cluster_id: String(x.cluster_id), signal: String(x.signal),
        evidence: String(x.evidence), confidence: String(x.confidence),
        cluster_size: Number(x.cluster_size ?? 0), has_pnl: x.has_pnl === true,
      }));
      sendHtml(res, 200, renderCatePnlPage(rows, clusters, new Date()));
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

    sendJson(res, 404, { error: 'not found', routes: ['/', '/cate', '/health', '/api/monitors', '/api/records'] });
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
