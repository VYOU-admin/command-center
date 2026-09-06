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
import { renderTokensPage, type ChainGroup, type TokenGroup, type TokenPrice,
  type WalletRow, type WindowRow } from './tokens-page.js';

export interface WebServerOptions {
  pool: Pool;
  monitors: MonitorConfig[];
  /** Read only to report alert routing; the web sink never sends alerts. */
  discord: DiscordSink;
  port: number;
  /** Reported by /health so a deploy can be identified in logs. */
  bootedAt: Date;
}

/**
 * The check constraint already rejects anything else at write time, so a value
 * outside this set means the database disagrees with the code. Throw rather
 * than widen the type and let an unknown side render as something plausible.
 */
const SIDES = ['buy', 'sell', 'transfer_in', 'transfer_out'] as const;
type Side = (typeof SIDES)[number];
function asSide(v: unknown): Side {
  const s = String(v);
  if ((SIDES as readonly string[]).includes(s)) return s as Side;
  throw new Error(`unknown transaction side in storage: ${JSON.stringify(v)}`);
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

    /*
     * One wallet's transactions, fetched when its row is expanded.
     *
     * The page used to carry every transaction inline, which reached 69.3 MB.
     * It now carries per-wallet aggregates and asks for the detail only when a
     * reader opens a row, so the payload scales with wallets rather than trades.
     */
    if (path === '/api/token-txs') {
      const mint = (url.searchParams.get('mint') ?? '').trim();
      const wallet = (url.searchParams.get('wallet') ?? '').trim();
      if (!mint || !wallet) { sendJson(res, 400, { error: 'mint and wallet are required' }); return; }
      // NOTHING HERE CHANGES CASE. Both are matched exactly as stored.
      const r = await pool.query(
        `select tx_hash, pool, block_time, block_number, token_amount, usd_amount,
                price_usd, side, counterparty,
                (select tw.tag from token_windows tw
                  where tw.mint = w.token and w.block_time >= tw.window_start
                    and w.block_time <= tw.window_end
                  order by tw.window_start limit 1) as window_tag
           from wallet_transactions w
          where w.token = $1 and w.wallet = $2
          order by w.block_time, w.tx_hash`,
        [mint, wallet]);
      /*
       * The score breakdown rides along with the transactions rather than
       * having its own endpoint: both are wanted at the same moment, by the
       * same click, for the same wallet.
       */
      const sc = await pool.query(
        `select score, weight_used, metrics from wallet_scores
          where token = $1 and wallet = $2`,
        [mint, wallet]);
      const scoreRow = sc.rows[0] as Record<string, unknown> | undefined;

      sendJson(res, 200, {
        mint, wallet, count: r.rowCount,
        score: scoreRow
          ? {
              score: scoreRow.score === null ? null : Number(scoreRow.score),
              weightUsed: Number(scoreRow.weight_used),
              metrics: scoreRow.metrics,
            }
          : null,
        txs: (r.rows as Record<string, unknown>[]).map((x) => ({
          signature: String(x.tx_hash),
          pool: x.pool === null ? null : String(x.pool),
          blockTime: (x.block_time as Date).toISOString(),
          blockNumber: x.block_number === null ? null : String(x.block_number),
          tokenAmount: Number(x.token_amount),
          usdAmount: x.usd_amount === null ? null : Number(x.usd_amount),
          priceUsd: x.price_usd === null ? null : Number(x.price_usd),
          windowTag: x.window_tag === null ? null : String(x.window_tag),
          side: asSide(x.side),
          counterparty: x.counterparty === null ? null : String(x.counterparty),
        })),
      });
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
      // Aggregates, not rows: the table shows per-wallet totals, and a wallet's
      // individual transactions are fetched on demand when its row expands.
      const [toks, aggs, legend, tags, wins, prices, scores] = await Promise.all([
        pool.query(`select mint, chain, ticker, name, decimals, charted_pair
                      from tokens order by chain, ticker`),
        /*
         * WALLET AGGREGATES, NOT RAW ROWS.
         *
         * Sending every transaction produced a 69.3 MB page at 191,728 rows.
         * These are the figures the table renders; a wallet's transactions come
         * from /api/token-txs when its row is expanded.
         *
         * usd and tokPriced deliberately sum only rows that HAVE a usd amount:
         * an unpriced row must leave both sides of the average-cost division,
         * or real dollars get divided by tokens those dollars did not buy.
         */
        pool.query(`select token as mint, wallet,
                           count(*)::int                                              as n,
                           sum(token_amount)                                          as tok,
                           coalesce(sum(usd_amount), 0)                               as usd,
                           count(*) filter (where usd_amount is not null)::int        as priced,
                           count(*) filter (where usd_amount is null)::int            as unpriced,
                           coalesce(sum(token_amount) filter (where usd_amount is not null), 0) as tok_priced,
                           min(block_time)                                            as first_at,
                           max(block_time)                                            as last_at
                      from wallet_transactions
                     group by token, wallet
                     order by token, wallet`),
        /*
         * Legend counts, per commissioned window, computed here rather than in
         * the browser now that the browser no longer has the rows. Membership is
         * by block_time inside the window's own bounds.
         */
        pool.query(`select w.token as mint, tw.tag,
                           count(distinct w.wallet)::int as wallets,
                           count(*)::int                 as buys
                      from wallet_transactions w
                      join token_windows tw
                        on tw.mint = w.token
                       and w.block_time >= tw.window_start
                       and w.block_time <= tw.window_end
                     group by 1,2`),
        pool.query(`select mint, wallet, tag, source from wallet_tags
                     order by mint, wallet, tag`),
        // The windows as COMMISSIONED. Not derived from the transactions: the
        // first and last trade inside a window are not the window.
        pool.query(`select mint, tag, window_start, window_end, label
                      from token_windows order by mint, window_start`),
        /*
         * The latest price per token, read once for the whole render, so the
         * header and every Change cell derive from one value.
         */
        pool.query(`select distinct on (mint) mint, price_usd, pool, source, observed_at
                      from token_prices order by mint, observed_at desc`),
        /*
         * SCORE AND WEIGHT ONLY. The per-metric breakdown is deliberately NOT
         * sent here: sixteen numbers per wallet across 13,095 wallets is several
         * megabytes, which is the same mistake that once produced a 69.3 MB
         * page. It arrives with the transactions when a row is expanded.
         *
         * weight_used travels with the score because they are not separable: a
         * wallet scored on part of the weight is not comparable to one scored on
         * all of it, and a score shown without it invites exactly that comparison.
         */
        pool.query(`select token as mint, wallet, score, weight_used, flags
                      from wallet_scores`),
      ]);

      const byToken = new Map<string, Map<string, WalletRow>>();
      const blankAgg = () => ({ n: 0, tok: 0, usd: 0, priced: 0, unpriced: 0,
                                tokPriced: 0, first: null, last: null,
                                score: null, wu: 0, fl: [] });
      const ensure = (mint: string, wallet: string): WalletRow => {
        let m = byToken.get(mint);
        if (!m) { m = new Map(); byToken.set(mint, m); }
        let w = m.get(wallet);
        if (!w) { w = { wallet, tags: [], a: blankAgg() }; m.set(wallet, w); }
        return w;
      };
      for (const r of tags.rows as Record<string, unknown>[]) {
        ensure(String(r.mint), String(r.wallet)).tags.push(
          { tag: String(r.tag), source: String(r.source) });
      }
      for (const r of aggs.rows as Record<string, unknown>[]) {
        const w = ensure(String(r.mint), String(r.wallet));
        w.a = {
          // Carried through rather than reset: the score rows are read after
          // this loop, and a fresh literal here would drop them silently.
          score: w.a.score,
          wu: w.a.wu,
          fl: w.a.fl,
          n: Number(r.n),
          tok: Number(r.tok),
          usd: Number(r.usd),
          priced: Number(r.priced),
          unpriced: Number(r.unpriced),
          tokPriced: Number(r.tok_priced),
          first: r.first_at === null ? null : (r.first_at as Date).toISOString(),
          last: r.last_at === null ? null : (r.last_at as Date).toISOString(),
        };
      }

      for (const r of scores.rows as Record<string, unknown>[]) {
        const w = ensure(String(r.mint), String(r.wallet));
        // Null is a real answer -- every metric was null for this wallet. It is
        // not a score of zero, and the page renders it as "unscored".
        w.a.score = r.score === null ? null : Number(r.score);
        w.a.wu = Number(r.weight_used);
        // Score-quality flags. Small enough to travel with the page -- an empty
        // array for most wallets, one or two short strings for the rest.
        w.a.fl = Array.isArray(r.flags) ? (r.flags as string[]) : [];
      }

      const legendByMint = new Map<string, { tag: string; wallets: number; buys: number }[]>();
      for (const r of legend.rows as Record<string, unknown>[]) {
        const m = String(r.mint);
        const list = legendByMint.get(m) ?? [];
        list.push({ tag: String(r.tag), wallets: Number(r.wallets), buys: Number(r.buys) });
        legendByMint.set(m, list);
      }

      const winsByMint = new Map<string, WindowRow[]>();
      for (const r of wins.rows as Record<string, unknown>[]) {
        const m = String(r.mint);
        const list = winsByMint.get(m) ?? [];
        list.push({
          tag: String(r.tag),
          start: (r.window_start as Date).toISOString(),
          end: (r.window_end as Date).toISOString(),
          label: r.label === null ? null : String(r.label),
        });
        winsByMint.set(m, list);
      }

      const priceByMint = new Map<string, TokenPrice>();
      for (const r of prices.rows as Record<string, unknown>[]) {
        priceByMint.set(String(r.mint), {
          priceUsd: Number(r.price_usd),
          pool: String(r.pool),
          source: String(r.source),
          observedAt: (r.observed_at as Date).toISOString(),
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
          price: priceByMint.get(mint) ?? null,
          windows: winsByMint.get(mint) ?? [],
          legend: legendByMint.get(mint) ?? [],
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

    sendJson(res, 404, { error: 'not found',
      routes: ['/', '/tokens', '/health', '/api/monitors', '/api/token-txs'] });
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