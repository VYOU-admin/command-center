/**
 * The watcher monitor: what the watchlist wallets traded, on any token.
 *
 * docs/ROBINHOOD.md step 17. ITS OWN MONITOR, not part of `wallet-scores`, and the
 * reason is step 13's in reverse: the watchlist rebuild belongs beside scoring
 * because both are free and have no cursor, while this one is cursor-driven and
 * SPENDS. Coupling a metered job to a free one means a ceiling or a rate limit
 * stops the free one too, and a sweep failure would stop scoring.
 *
 * THE ALERT IS AGGREGATED BY TOKEN AND CARRIES NOTHING PER-WALLET. The per-wallet
 * detail is the stored record and a later dashboard tab. An empty period sends
 * NOTHING: a recurring "0 wallets traded" line trains the reader to ignore the
 * channel, and `monitor_runs` already distinguishes silence from a dead monitor.
 * Failures alert on `system`, as every other monitor does.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { RpcClient } from './token-updates/rpc.js';
import { loadIntakeConfig } from '../intake/plan.js';
import {
  WATCHER_SCHEMA, loadWatchlistWallets, persistWatchRows, sweepWatchlistActivity,
  type SweepReport,
} from '../intake/watcher.js';

interface Pending { stored: number }
const pending = new Map<string, Pending>();

const adapter: SourceAdapter<{ token: string }> = {
  type: 'watchlist-watch',

  validate(options, monitorId) {
    for (const k of ['chain', 'config', 'cohort_alert_channel'] as const) {
      if (k === 'cohort_alert_channel') continue;
      if (typeof options?.[k] !== 'string' || String(options[k]).trim() === '') {
        throw new Error(`${monitorId}: watchlist-watch requires a "${k}" option`);
      }
    }
    const known = new Set(['chain', 'config', 'slice_blocks', 'head_lag', 'ceiling']);
    const extra = Object.keys(options ?? {}).filter((k) => !known.has(k));
    if (extra.length > 0) {
      throw new Error(`${monitorId}: unexpected option(s) ${extra.join(', ')}`);
    }
  },

  async migrate(client) {
    await client.query(WATCHER_SCHEMA);
  },

  async fetch(ctx: AdapterContext): Promise<{ token: string }[]> {
    const chain = String(ctx.options['chain']);
    const cfg = await loadIntakeConfig(String(ctx.options['config']));
    const slice = Number(ctx.options['slice_blocks'] ?? 20000);
    const lag = Number(ctx.options['head_lag'] ?? 200);
    const ceiling = Number(ctx.options['ceiling'] ?? 100000);

    const key = ctx.configVars.get(cfg.rpcKeyVar);
    if (!key) throw new Error(`${cfg.rpcKeyVar} is not set in this process`);
    const rpc = new RpcClient(cfg.rpcUrlTemplate.replace('{key}', key),
      cfg.requestTimeoutMs, ceiling);

    const client = await ctx.db.connect();
    let report: SweepReport;
    let stored = 0;
    let from = 0; let to = 0;
    try {
      const wallets = await loadWatchlistWallets(client, chain);

      /*
       * THE CURSOR IS THE ONLY PROGRESS STATE and it advances in the same
       * transaction as the rows. A run that dies leaves it where it was and the
       * next run re-reads that range; re-reading is safe because the row key is
       * unique, and skipping is impossible because the cursor never passes
       * uncommitted data.
       *
       * SEEDED WHERE THE WATCHLIST BEGINS, NEVER AT THE HEAD. Seeding at the head
       * skips the backlog permanently and silently (step 15).
       */
      const head = await rpc.blockNumber();
      const cur = await client.query<{ cursor_block: string }>(
        `select cursor_block::text from token_ingest_cursor
          where chain = $1 and token = 'WATCHLIST' and kind = 'watch'`, [chain],
      );
      const target = head - lag;
      from = cur.rowCount ? Number(cur.rows[0]!.cursor_block) + 1 : target - slice;
      to = Math.min(from + slice - 1, target);
      if (to <= from) {
        ctx.log.info('nothing to advance', { from, to, head, lag });
        pending.set(ctx.monitorId, { stored: 0 });
        return [];
      }

      report = await sweepWatchlistActivity(
        client, rpc, chain,
        {
          v4PoolManager: cfg.v4PoolManager, usdAsset: cfg.usdAsset,
          nativeAssets: cfg.nativeAssets, maxLogSpanBlocks: cfg.maxLogSpanBlocks,
          minLogSpanBlocks: cfg.minLogSpanBlocks,
          sparseLogSpanBlocks: cfg.sparseLogSpanBlocks, bucketBlocks: cfg.bucketBlocks,
        },
        wallets, from, to,
      );

      await client.query('begin');
      try {
        stored = await persistWatchRows(client, chain, report.rows);
        await client.query(
          `insert into token_ingest_cursor
             (chain, token, kind, cursor_block, head_block, last_run_at, last_status,
              last_error, rows_written, runs)
           values ($1,'WATCHLIST','watch',$2,$3,now(),'success',null,$4,1)
           on conflict (chain, token, kind) do update
             set cursor_block = excluded.cursor_block,
                 head_block   = excluded.head_block,
                 last_run_at  = excluded.last_run_at,
                 last_status  = 'success',
                 rows_written = token_ingest_cursor.rows_written + excluded.rows_written,
                 runs         = token_ingest_cursor.runs + 1`,
          [chain, to, head, stored],
        );
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw err;
      }

      ctx.log.info('watchlist activity', {
        blocks: `${from}..${to}`, wallets: wallets.length,
        transfers_matched: report.transfersMatched,
        candidates: report.candidates,
        trades: report.trades,
        stored,
        wallet_to_wallet_skipped: report.walletToWallet,
        rejected_counterparty_not_a_pool: report.rejectedNoPoolCounterparty,
        rejected_no_swap_on_that_pool: report.rejectedNoSwapOnThatPool,
        rejected_token_not_in_that_pool: report.rejectedTokenNotInPool,
        pools_newly_classified: report.poolsClassified,
        usd_priced: report.usdPriced,
        usd_null: report.usdNull,
        usd_null_reasons: report.nullReasons,
        cu_spent: rpc.cuSpent,
        dollars: ((rpc.cuSpent * 0.45) / 1e6).toFixed(5),
      });

      /*
       * AGGREGATED BY TOKEN, NOTHING PER-WALLET, AND SILENT WHEN EMPTY.
       */
      if (report.rows.length > 0) {
        const byToken = new Map<string, {
          buyers: Set<string>; sellers: Set<string>; amount: number; usd: number; anyNull: boolean;
        }>();
        for (const r of report.rows) {
          const e = byToken.get(r.token) ?? {
            buyers: new Set<string>(), sellers: new Set<string>(),
            amount: 0, usd: 0, anyNull: false,
          };
          if (r.side === 'buy') e.buyers.add(r.wallet); else e.sellers.add(r.wallet);
          e.amount += Math.abs(Number(r.tokenAmount));
          if (r.usdAmount === null) e.anyNull = true; else e.usd += r.usdAmount;
          byToken.set(r.token, e);
        }
        const lines = [...byToken.entries()]
          .sort((a, b) => b[1].usd - a[1].usd)
          .map(([token, e]) => {
            const usd = e.usd > 0
              ? `$${e.usd.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
              : 'unpriced';
            // A partial total says so. Presenting it as complete would understate.
            const qualifier = e.anyNull && e.usd > 0 ? ' (partial)' : '';
            return `\`${token}\`  bought ${e.buyers.size}  sold ${e.sellers.size}  `
              + `${e.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} tokens  `
              + `${usd}${qualifier}`;
          });
        ctx.queueAlert({
          title: `Watchlist activity: ${byToken.size} token(s), ${report.trades} trades`,
          description: `Blocks ${from}–${to}. ${lines.length} token(s), aggregated.\n\n`
            + lines.join('\n'),
          level: 'info',
        }, 'crypto_screener');
      }
    } finally {
      client.release();
    }

    pending.set(ctx.monitorId, { stored });
    return [...new Set(report.rows.map((r) => r.token))].map((token) => ({ token }));
  },

  async persist(ctx): Promise<number> {
    const p = pending.get(ctx.monitorId);
    pending.delete(ctx.monitorId);
    return p?.stored ?? 0;
  },
};

export default adapter;
