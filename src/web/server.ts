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
import {
  renderCatePnlPage, type CatePnlRow, type ClusterRow, type TokenMetaRow,
  type GroupRow, type ScanRow, type TagRow,
} from './cate-pnl.js';

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

    // Per-token wallet tag. Separate from /api/wallet-tag, which is token-blind
    // by design and is left alone so the other tabs keep working.
    if (req.method === 'POST' && path === '/api/token-tag') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 100_000) { sendJson(res, 413, { error: 'body too large' }); return; }
      }
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || '{}') as Record<string, unknown>; }
      catch { sendJson(res, 400, { error: 'invalid json' }); return; }
      const token = String(body.token ?? '').trim();
      const chain = String(body.chain ?? '').trim();
      const wallet = String(body.wallet ?? '').trim().toLowerCase();
      const tag = String(body.tag ?? '').trim().slice(0, 128);
      if (!token || !chain || !wallet) {
        sendJson(res, 400, { error: 'token, chain and wallet are required' }); return;
      }
      try {
        if (tag === '') {
          // Empty means no tag, represented by the absence of a row.
          const d = await pool.query(
            `delete from wallet_tags where token=$1 and chain=$2 and wallet=$3`,
            [token, chain, wallet]);
          sendJson(res, 200, { ok: true, tag: '', deleted: d.rowCount ?? 0 });
          return;
        }
        await pool.query(
          `insert into wallet_tags (token, chain, wallet, tag, updated_at)
           values ($1,$2,$3,$4, now())
           on conflict (token, chain, wallet) do update
             set tag = excluded.tag, updated_at = now()`,
          [token, chain, wallet, tag]);
        sendJson(res, 200, { ok: true, tag });
      } catch (err) {
        log.error('token tag write failed', errorFields(err as Error));
        sendJson(res, 500, { error: 'write failed' });
      }
      return;
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
                -- null for tokens loaded before the balance spec existed; the
                -- page shows an em dash rather than inventing a zero.
                p.tokens_bought, p.tokens_sold, p.implied_balance,
                p.onchain_balance, p.balance_delta, p.balance_match,
                p.unrealized_pnl_usd, p.still_holding, p.has_off_pool_activity,
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
        // NULL and 0 are different facts here. A wallet with no balance read is
        // not a wallet holding nothing, so nulls are preserved rather than
        // coerced — the same confusion that made 490 rate-limited reads look
        // like real zero balances during the PONS run.
        tokens_bought: x.tokens_bought == null ? null : Number(x.tokens_bought),
        tokens_sold: x.tokens_sold == null ? null : Number(x.tokens_sold),
        implied_balance: x.implied_balance == null ? null : Number(x.implied_balance),
        onchain_balance: x.onchain_balance == null ? null : Number(x.onchain_balance),
        balance_delta: x.balance_delta == null ? null : Number(x.balance_delta),
        balance_match: x.balance_match == null ? null : x.balance_match === true,
        unrealized_pnl_usd: x.unrealized_pnl_usd == null ? null : Number(x.unrealized_pnl_usd),
        still_holding: x.still_holding == null ? null : x.still_holding === true,
        has_off_pool_activity: x.has_off_pool_activity == null ? null
          : x.has_off_pool_activity === true,
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
      // One record per (token, chain): the window the cohort was cut from, the
      // supplied threshold and whether it actually bound anything. Guarded on
      // to_regclass so an environment without the table serves the page instead
      // of 500-ing.
      const tmq = await pool.query(
        `select case when to_regclass('public.wallet_pnl_tokens') is null then null
                     else 1 end as present`,
      );
      let tokenMeta: TokenMetaRow[] = [];
      if (tmq.rows[0]?.present === 1) {
        const tm = await pool.query(
          `select token, chain, quote_asset, dex, dex_version, pool_address,
                  total_supply, window_hours, window_start_utc, window_end_utc,
                  first_swap_block, boundary_block, swaps_in_window, unique_txs,
                  fully_covered, mcap_threshold_usd, threshold_binding,
                  threshold_note, fee_rate_buy, fee_rate_sell, cohort_size,
                  price_usd, price_block, balance_block, decode_check,
                  price_slot, price_read_at, token_decimals
             from wallet_pnl_tokens`,
        );
        tokenMeta = tm.rows.map((x: Record<string, unknown>) => ({
          token: String(x.token), chain: String(x.chain),
          quote_asset: String(x.quote_asset ?? ''),
          dex: x.dex == null ? null : String(x.dex),
          dex_version: x.dex_version == null ? null : String(x.dex_version),
          pool_address: x.pool_address == null ? null : String(x.pool_address),
          window_hours: x.window_hours == null ? null : Number(x.window_hours),
          window_start_utc: x.window_start_utc == null ? null : String(x.window_start_utc),
          window_end_utc: x.window_end_utc == null ? null : String(x.window_end_utc),
          first_swap_block: x.first_swap_block == null ? null : Number(x.first_swap_block),
          boundary_block: x.boundary_block == null ? null : Number(x.boundary_block),
          swaps_in_window: x.swaps_in_window == null ? null : Number(x.swaps_in_window),
          unique_txs: x.unique_txs == null ? null : Number(x.unique_txs),
          fully_covered: x.fully_covered == null ? null : x.fully_covered === true,
          total_supply: x.total_supply == null ? null : Number(x.total_supply),
          mcap_threshold_usd: x.mcap_threshold_usd == null ? null : Number(x.mcap_threshold_usd),
          threshold_binding: x.threshold_binding == null ? null : x.threshold_binding === true,
          threshold_note: x.threshold_note == null ? null : String(x.threshold_note),
          fee_rate_buy: x.fee_rate_buy == null ? null : Number(x.fee_rate_buy),
          fee_rate_sell: x.fee_rate_sell == null ? null : Number(x.fee_rate_sell),
          cohort_size: x.cohort_size == null ? null : Number(x.cohort_size),
          price_usd: x.price_usd == null ? null : Number(x.price_usd),
          price_block: x.price_block == null ? null : Number(x.price_block),
          price_slot: x.price_slot == null ? null : Number(x.price_slot),
          // ISO, not String(Date): the default stringification is a JS date
          // string that no formatter here understands, and it rendered as
          // "Wed Sep 02 2026 21:01:46 GM +0000 (Coordinated Universal Time)".
          price_read_at: x.price_read_at == null ? null
            : new Date(String(x.price_read_at)).toISOString(),
          token_decimals: x.token_decimals == null ? null : Number(x.token_decimals),
          balance_block: x.balance_block == null ? null : Number(x.balance_block),
          decode_check: x.decode_check == null ? null : String(x.decode_check),
        }));
      }
      // ODYSSEUS group membership and the latest balance scan per wallet. Both
      // tables are guarded on to_regclass so an environment without them serves
      // the page instead of 500-ing.
      let groups: GroupRow[] = [];
      let scans: ScanRow[] = [];
      const haveG = await pool.query(
        `select to_regclass('public.wallet_groups') g, to_regclass('public.token_balance_scans') s`);
      if (haveG.rows[0]?.g) {
        const gr = await pool.query(
          `select token, lower(wallet) wallet, group_no from wallet_groups`);
        groups = gr.rows.map((x: Record<string, unknown>) => ({
          token: String(x.token), wallet: String(x.wallet), groupNo: Number(x.group_no),
        }));
      }
      // MOS keeps its groups in its OWN table. wallet_groups is owned by
      // run_token.py and rewritten wholesale per token, so a Solana backfill
      // must not write there. Unioned at read time instead, guarded so an
      // environment without the table still serves the page.
      const haveM = await pool.query(`select to_regclass('public.mos_wallet_groups') m`);
      if (haveM.rows[0]?.m) {
        const mr = await pool.query(
          // NOT lower(): Solana addresses are case-sensitive base58, and
          // lowercasing one destroys it. wallet_pnl stores them as-is, so
          // lowercasing here made every MOS group lookup miss and the page
          // rendered 0 rows in all three groups. EVM hex above is stored
          // lowercase already, so its lower() is a no-op and stays.
          `select token, wallet, group_no from mos_wallet_groups`);
        for (const x of mr.rows as Record<string, unknown>[])
          groups.push({ token: String(x.token), wallet: String(x.wallet),
            groupNo: Number(x.group_no) });
      }
      if (haveG.rows[0]?.s) {
        // distinct on wallet, newest scan first: the series is append-only, so
        // the latest row is the current reading and older rows stay untouched.
        // block, read_at and sweep_no travel WITH the balance. Under the rolling
        // cursor a sweep carries several head blocks spread over roughly an
        // hour, so a reading is only interpretable next to the moment it was
        // taken -- one wallet's read time can never stand in for another's.
        // sweep_no is null for the 798 rows written before sweeps existed.
        const sr = await pool.query(
          `select distinct on (token, wallet) token, lower(wallet) wallet,
                  balance_raw::text balance_raw, status, block, read_at, sweep_no
             from token_balance_scans
            where scan_kind = 'scan'
            order by token, wallet, scanned_at desc`);
        scans = sr.rows.map((x: Record<string, unknown>) => ({
          token: String(x.token),
          wallet: String(x.wallet),
          balanceRaw: x.balance_raw == null ? null : String(x.balance_raw),
          status: String(x.status),
          block: Number(x.block),
          readAt: x.read_at ? new Date(String(x.read_at)).toISOString() : null,
          sweepNo: x.sweep_no == null ? null : Number(x.sweep_no),
        }));
      }
      // Solana balances live in their own table: `slot`, not `block`, and a
      // no_account state the EVM scanner has no equivalent for. Latest row per
      // wallet, same distinct-on shape. Wallets are NOT lowercased -- base58.
      const haveS = await pool.query(`select to_regclass('public.solana_balance_scans') s`);
      if (haveS.rows[0]?.s) {
        const ss = await pool.query(
          `select distinct on (token, wallet) token, wallet,
                  balance_raw::text balance_raw, status, slot, read_at
             from solana_balance_scans
            order by token, wallet, scanned_at desc`);
        for (const x of ss.rows as Record<string, unknown>[])
          scans.push({
            token: String(x.token), wallet: String(x.wallet),
            balanceRaw: x.balance_raw == null ? null : String(x.balance_raw),
            status: String(x.status), block: Number(x.slot),
            readAt: x.read_at ? new Date(String(x.read_at)).toISOString() : null,
            sweepNo: null,
          });
      }
      let tags: TagRow[] = [];
      const haveT = await pool.query(`select to_regclass('public.wallet_tags') t`);
      if (haveT.rows[0]?.t) {
        const tr = await pool.query(
          // Same base58 hazard: tags are written from the page with the wallet
          // exactly as the row carries it, so selecting it back raw matches both
          // chains. EVM wallets are already lowercase, so nothing changes there.
          `select token, chain, wallet, tag from wallet_tags`);
        tags = tr.rows.map((x: Record<string, unknown>) => ({
          token: String(x.token), chain: String(x.chain),
          wallet: String(x.wallet), tag: String(x.tag),
        }));
      }
      sendHtml(res, 200,
        renderCatePnlPage(rows, clusters, new Date(), tokenMeta, groups, scans, tags));
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
