/**
 * The web sink: a dashboard for humans and JSON for machines, both reading the
 * same tables the scheduler writes.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { MonitorConfig } from '../config.js';
import { assessAll, overallStatus } from '../health.js';
import { DEFAULT_ALERT_CHANNEL } from '../config.js';
import { errorFields, log } from '../logger.js';
import type { DiscordSink } from '../sinks/discord.js';
import type { Pool } from '../store/db.js';
import { getMonitorStates, getRecentRuns } from '../store/registry.js';
import { escapeHtml, renderDashboard } from './views.js';
import { renderTokensPage, type ChainGroup, type TokenGroup, type WalletRow } from './tokens-page.js';

export interface WebServerOptions {
  pool: Pool;
  monitors: MonitorConfig[];
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

export function createWebServer(opts: WebServerOptions): Server {
  const { pool, monitors, bootedAt } = opts;

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    /*
     * The ONE write this server performs: an operator correcting a wallet's
     * tags. Scoped to wallet_tags, which a token-intake re-run never deletes,
     * so a manual edit survives re-ingestion of the window it came from.
     *
     * NOTHING HERE LOWERCASES AN ADDRESS. Solana mints and wallets are base58.
     */
    if (req.method === 'POST' && path === '/api/token-wallet-tag') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 100_000) { sendJson(res, 413, { error: 'body too large' }); return; }
      }
      let body: { mint?: unknown; wallet?: unknown; tag?: unknown; action?: unknown };
      try { body = JSON.parse(raw) as typeof body; }
      catch { sendJson(res, 400, { error: 'invalid JSON' }); return; }
      const mint = typeof body.mint === 'string' ? body.mint.trim() : '';
      const wallet = typeof body.wallet === 'string' ? body.wallet.trim() : '';
      const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
      const action = body.action === 'remove' ? 'remove' : 'add';
      if (!mint || !wallet || !tag) {
        sendJson(res, 400, { error: 'mint, wallet and tag are all required' });
        return;
      }
      if (tag.length > 64) { sendJson(res, 400, { error: 'tag is too long' }); return; }
      try {
        const known = await pool.query('select 1 from tokens where mint = $1', [mint]);
        if (known.rowCount === 0) { sendJson(res, 404, { error: 'unknown mint' }); return; }
        if (action === 'remove') {
          const r = await pool.query(
            'delete from wallet_tags where wallet = $1 and mint = $2 and tag = $3',
            [wallet, mint, tag]);
          sendJson(res, 200, { ok: true, action, removed: r.rowCount });
        } else {
          await pool.query(
            `insert into wallet_tags (wallet, mint, tag, source)
             values ($1,$2,$3,'manual')
             on conflict (wallet, mint, tag) do update set
               source = 'manual', updated_at = now()`,
            [wallet, mint, tag]);
          sendJson(res, 200, { ok: true, action });
        }
      } catch (err) {
        log.error('token tag write failed', errorFields(err));
        sendJson(res, 500, { error: 'write failed' });
      }
      return;
    }

    // Read-only otherwise.
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


    if (path === '/') {
      // STATUS ONLY. This page answers one question: which monitors exist, are
      // they enabled, when did each last succeed, and how long did it take. The
      // per-monitor panel mechanism is gone -- the one panel that used it
      // rendered a long price table that buried the thing the page is for.
      const states = await getMonitorStates(pool, monitors.map((m) => m.id));
      const health = assessAll(monitors, states);
      sendHtml(
        res,
        200,
        renderDashboard({
          monitors: health,
          overall: overallStatus(health),
          generatedAt: new Date(),
        }),
      );
      return;
    }

    if (path === '/tokens') {
      // Three flat reads, grouped in memory. The dataset is one row per
      // purchase for the tokens tracked so far, which is small enough to hand
      // to the browser whole -- and doing so is what lets the collapsed row's
      // totals be summed from exactly the rows the expanded view renders.
      const [toks, buys, tags] = await Promise.all([
        pool.query(`select mint, chain, ticker, name, decimals, charted_pair
                      from tokens order by chain, ticker`),
        pool.query(`select mint, wallet, signature, pool, block_time, token_amount,
                           usd_amount, price_usd, window_tag
                      from token_purchases order by mint, wallet, block_time`),
        pool.query(`select mint, wallet, tag, source from wallet_tags
                     order by mint, wallet, tag`),
      ]);

      const byToken = new Map<string, Map<string, WalletRow>>();
      const ensure = (mint: string, wallet: string): WalletRow => {
        let m = byToken.get(mint);
        if (!m) { m = new Map(); byToken.set(mint, m); }
        let w = m.get(wallet);
        if (!w) { w = { wallet, tags: [], purchases: [] }; m.set(wallet, w); }
        return w;
      };
      for (const r of tags.rows as Record<string, unknown>[]) {
        ensure(String(r.mint), String(r.wallet)).tags.push(
          { tag: String(r.tag), source: String(r.source) });
      }
      for (const r of buys.rows as Record<string, unknown>[]) {
        ensure(String(r.mint), String(r.wallet)).purchases.push({
          signature: String(r.signature),
          pool: String(r.pool),
          blockTime: (r.block_time as Date).toISOString(),
          tokenAmount: Number(r.token_amount),
          // NULL STAYS NULL. Number(null) is 0, which would render a measured
          // zero where there was no measurement at all.
          usdAmount: r.usd_amount === null ? null : Number(r.usd_amount),
          priceUsd: r.price_usd === null ? null : Number(r.price_usd),
          windowTag: String(r.window_tag),
        });
      }

      const chains = new Map<string, TokenGroup[]>();
      for (const r of toks.rows as Record<string, unknown>[]) {
        const mint = String(r.mint);
        const group: TokenGroup = {
          mint,
          ticker: String(r.ticker),
          name: r.name === null ? null : String(r.name),
          decimals: Number(r.decimals),
          chartedPair: r.charted_pair === null ? null : String(r.charted_pair),
          wallets: [...(byToken.get(mint)?.values() ?? [])],
        };
        const chain = String(r.chain);
        const list = chains.get(chain) ?? [];
        list.push(group);
        chains.set(chain, list);
      }
      const payload: ChainGroup[] = [...chains.entries()].map(([chain, tokens]) => ({ chain, tokens }));

      sendHtml(res, 200, renderTokensPage({ chains: payload, generatedAt: new Date() }));
      return;
    }

    sendJson(res, 404, { error: 'not found', routes: ['/', '/tokens', '/health', '/api/monitors'] });
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