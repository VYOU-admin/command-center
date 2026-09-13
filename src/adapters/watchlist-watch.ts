/**
 * The watcher monitor: what the watchlist wallets traded, on any token.
 *
 * docs/ROBINHOOD.md step 17. ITS OWN MONITOR, not part of `wallet-scores`, and the
 * reason is step 13's in reverse: the watchlist rebuild belongs beside scoring
 * because both are free and have no cursor, while this one is cursor-driven and
 * SPENDS. Coupling a metered job to a free one means a ceiling or a rate limit
 * stops the free one too, and a sweep failure would stop scoring.
 *
 * THE ALERT GOES TO THE `crypto` CHANNEL, WHICH IS #crypto-screener. The webhook
 * named "Crypto" is DISCORD_WEBHOOK_CRYPTO and the loop in env.ts already
 * registers it, so nothing new is created and the log reads via:"channel". The
 * channel name and the Discord channel name differ; see env.ts.
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
  WATCHER_SCHEMA, deriveSliceEthUsd, loadWatchlistWallets, persistWatchRows,
  sweepWatchlistActivity, type SweepReport,
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

      /*
       * DERIVE ETH/USD FOR THIS SLICE FIRST, in memory, persisting nothing. The
       * hourly job owns the stored series and trails the head, and the gap grows
       * at the rate the chain produces blocks -- it cost 188 of 231 rows their USD
       * before this existed. Step 10: exactly one monitor PERSISTS the series and
       * every other derives it in memory for its own slice.
       */
      const px = await deriveSliceEthUsd(
        client, rpc, chain,
        {
          v4PoolManager: cfg.v4PoolManager, maxLogSpanBlocks: cfg.maxLogSpanBlocks,
          minLogSpanBlocks: cfg.minLogSpanBlocks, bucketBlocks: cfg.bucketBlocks,
          bucketOrigin: cfg.bucketOrigin, nativeFenceMultiple: cfg.nativeFenceMultiple,
        },
        from, to,
      );
      ctx.log.info('eth/usd derived for this slice', {
        buckets: px.prices.size, ticks: px.ticks,
        discarded_by_fence: px.discarded, requests: px.requests,
        prices: [...px.prices.entries()].map(([b, v]) => `${b}:$${v.toFixed(2)}`),
        note: 'in memory only; native_usd_prices is owned by token-updates and is '
          + 'not written here',
      });

      report = await sweepWatchlistActivity(
        client, rpc, chain,
        {
          v4PoolManager: cfg.v4PoolManager, usdAsset: cfg.usdAsset,
          nativeAssets: cfg.nativeAssets, maxLogSpanBlocks: cfg.maxLogSpanBlocks,
          minLogSpanBlocks: cfg.minLogSpanBlocks,
          sparseLogSpanBlocks: cfg.sparseLogSpanBlocks, bucketBlocks: cfg.bucketBlocks,
          bucketOrigin: cfg.bucketOrigin,
        },
        wallets, from, to, px.prices,
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
        interface Agg {
          name: string | null; symbol: string | null;
          buyers: Set<string>; sellers: Set<string>;
          boughtTokens: number; soldTokens: number;
          boughtUsd: number; soldUsd: number;
          boughtTrades: number; soldTrades: number;
          boughtUnpriced: number; soldUnpriced: number;
        }
        const byToken = new Map<string, Agg>();
        for (const r of report.rows) {
          const e = byToken.get(r.token) ?? {
            name: r.tokenName, symbol: r.tokenSymbol,
            buyers: new Set<string>(), sellers: new Set<string>(),
            boughtTokens: 0, soldTokens: 0, boughtUsd: 0, soldUsd: 0,
            boughtTrades: 0, soldTrades: 0, boughtUnpriced: 0, soldUnpriced: 0,
          };
          const amt = Math.abs(Number(r.tokenAmount));
          if (r.side === 'buy') {
            e.buyers.add(r.wallet); e.boughtTokens += amt; e.boughtTrades += 1;
            if (r.usdAmount === null) e.boughtUnpriced += 1; else e.boughtUsd += r.usdAmount;
          } else {
            e.sellers.add(r.wallet); e.soldTokens += amt; e.soldTrades += 1;
            if (r.usdAmount === null) e.soldUnpriced += 1; else e.soldUsd += r.usdAmount;
          }
          byToken.set(r.token, e);
        }

        const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
        const n0 = (x: number): string =>
          x.toLocaleString('en-US', { maximumFractionDigits: 0 });
        const tok = (x: number): string =>
          x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 })
            : x.toLocaleString('en-US', { maximumFractionDigits: 4 });
        /*
         * A ZERO USD FIGURE IS NEVER PRINTED AS $0. Either some rows on that side
         * were unpriced -- shown as `unpriced` or `$n+` -- or there was no activity
         * on that side, shown as a dash. `$0` would be a measurement, and it would
         * be the wrong one.
         */
        const usd = (v: number, unpriced: number, trades: number): string => {
          if (trades === 0) return '—';
          if (unpriced === trades) return 'unpriced';
          return unpriced > 0 ? `$${n0(v)}+` : `$${n0(v)}`;
        };

        const lines = [...byToken.entries()]
          .sort((a, b) => (b[1].boughtUsd + b[1].soldUsd) - (a[1].boughtUsd + a[1].soldUsd))
          .map(([token, e]) => {
            /*
             * A SYMBOL IS A LABEL, NOT AN IDENTITY -- two tokens on this chain both
             * answer symbol() with "NVDA". The address is always shown alongside,
             * and a token that answers neither name() nor symbol() shows the
             * address rather than an invented label.
             */
            const label = e.symbol && e.name ? `**${e.symbol}** — ${e.name}`
              : e.symbol ? `**${e.symbol}**`
                : e.name ? `**${e.name}**`
                  : `\`${short(token)}\``;
            const chart = `https://dexscreener.com/robinhood/${token}`;
            const nb = e.buyers.size; const ns = e.sellers.size;
            const side = (
              wallets: number, trades: number, usdV: number, unpriced: number, amount: number,
            ): string => (trades === 0 ? '—  —  —'
              : `${wallets} wallet${wallets === 1 ? '' : 's'}  `
                + `${usd(usdV, unpriced, trades)}  ${tok(amount)}`);
            return `[${label}](${chart})  \`${short(token)}\`\n`
              + `　bought  ${side(nb, e.boughtTrades, e.boughtUsd, e.boughtUnpriced, e.boughtTokens)}\n`
              + `　sold  　${side(ns, e.soldTrades, e.soldUsd, e.soldUnpriced, e.soldTokens)}`;
          });

        /*
         * DISCORD CAPS AN EMBED DESCRIPTION AT 4,096 CHARACTERS. 67 tokens at three
         * lines each overruns it, and a truncated embed is REJECTED rather than
         * trimmed -- the alert would vanish. So the list is capped and the tokens
         * left out are COUNTED IN THE MESSAGE: a silent trim would read as "that is
         * all that happened".
         */
        const LIMIT = 20;
        const shown = lines.slice(0, LIMIT);
        const omitted = lines.length - shown.length;
        const totalUsd = [...byToken.values()].reduce((n, e) => n + e.boughtUsd + e.soldUsd, 0);
        const unpricedRows = report.usdNull;
        ctx.queueAlert({
          title: `Watchlist: ${report.trades} trades, ${byToken.size} tokens, `
            + `${new Set(report.rows.map((r) => r.wallet)).size} wallets`,
          description: `Blocks ${from}–${to}  ·  $${n0(totalUsd)} priced`
            + (unpricedRows > 0 ? `  ·  ${unpricedRows} of ${report.trades} rows unpriced` : '')
            + `\n\n${shown.join('\n\n')}`
            + (omitted > 0
              ? `\n\n_…and ${omitted} more token${omitted === 1 ? '' : 's'}, ordered by USD._`
              : '')
            /*
             * THE LINK IS OMITTED WHEN THERE IS NO DOMAIN, never printed broken.
             * Step 14: a dead link that looks live is the same shape of failure as
             * a filter that matches nothing.
             */
            + (ctx.publicUrl
              ? `\n\n**[Every trade on the watchlist tab →](${ctx.publicUrl}/watchlist)**`
                + `  ·  filterable by token and by wallet`
              : `\n\nAll ${report.trades} trades are in \`watchlist_activity\`; the `
                + 'watchlist tab has no public URL configured.'),
          level: 'info',
        }, 'crypto');
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
