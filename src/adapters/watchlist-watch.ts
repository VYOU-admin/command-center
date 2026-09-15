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
import { bucketOf } from './token-updates/prices.js';
import { loadIntakeConfig } from '../intake/plan.js';
import {
  WATCHER_SCHEMA, deriveSliceEthUsd, loadWatchlistWallets, persistWatchRows,
  sweepWatchlistActivity, type SweepReport,
} from '../intake/watcher.js';
import {
  chartUrl, n0, px as priceFigure, short, tokenLabel, usdFigure,
} from '../intake/alert-format.js';
import {
  SUPPLY_SCHEMA, SUPPLY_TTL_DAYS, loadSupplies, readSupplies, supplyWorkSet,
} from '../intake/supply.js';
import { buildAgeAlert } from '../intake/age-alert.js';
import {
  AGE_SCHEMA, BLOCKS_PER_HOUR, ageWorkSet, loadAges, resolveAges, windowBlocks,
  type AgeAnchor,
} from '../intake/token-age.js';

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
    /*
     * THE ALLOW-LIST IS THE GUARD, AND EVERY NEW OPTION BELONGS IN IT.
     *
     * An option the adapter does not know is almost always a typo that would
     * silently do nothing -- which is exactly what `bridge_assets` did on the hourly
     * job, accepted by the parser and read by no one, for 80% of AI's volume. This
     * refuses to boot instead. Adding the four market-cap options to the YAML without
     * adding them here failed the deploy on 2026-09-15, which is the guard working:
     * the previous container kept serving and nothing silently ignored a threshold.
     */
    const known = new Set([
      'chain', 'config', 'slice_blocks', 'head_lag', 'ceiling',
      'supply_ttl_days', 'supply_reads_per_run',
      'launch_window_minutes', 'age_bisects_per_run',
    ]);
    const extra = Object.keys(options ?? {}).filter((k) => !known.has(k));
    if (extra.length > 0) {
      throw new Error(`${monitorId}: unexpected option(s) ${extra.join(', ')}`);
    }
  },

  async migrate(client) {
    await client.query(WATCHER_SCHEMA);
    await client.query(SUPPLY_SCHEMA);
    await client.query(AGE_SCHEMA);
  },

  async fetch(ctx: AdapterContext): Promise<{ token: string }[]> {
    const chain = String(ctx.options['chain']);
    const cfg = await loadIntakeConfig(String(ctx.options['config']));
    const slice = Number(ctx.options['slice_blocks'] ?? 20000);
    const lag = Number(ctx.options['head_lag'] ?? 200);
    const ceiling = Number(ctx.options['ceiling'] ?? 100000);
    /*
     * THE LAUNCH ALERT'S OWN CONFIG.
     *
     * THE WINDOW IS IN MINUTES AND THE BLOCK COUNT IS DERIVED, never written as a
     * constant: at 35,622 blocks/hour a hard-coded block count would silently stop
     * meaning an hour the moment block time moved. The derived figure is logged.
     *
     * `age_bisects_per_run` bounds the only variable term. The base check is bounded
     * by the novel-token count, which the chain decides; the bisect is bounded by how
     * many of those are genuinely new, which nothing bounds in advance. 25 is ~10x
     * the measured novel-token rate per run (9.1), so it cannot bind on a normal run
     * and does bind on a pathological one. It is reported whenever it does.
     */
    const launchWindowMinutes = Number(ctx.options['launch_window_minutes'] ?? 60);
    const bisectCap = Number(ctx.options['age_bisects_per_run'] ?? 25);
    const supplyTtlDays = Number(ctx.options['supply_ttl_days'] ?? SUPPLY_TTL_DAYS);
    const supplyPerRun = Number(ctx.options['supply_reads_per_run'] ?? 200);

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

      /*
       * THE SLICE ENDS ON A WHOLE BUCKET BOUNDARY, so the derivation never sees a
       * partial bucket. `boundary` is the last block of the last COMPLETE bucket at
       * or below `head - lag`; the `safe + 1` form handles the exact-boundary case
       * without a branch. Blocks past it are not read this run -- the cursor stops
       * there and the next run picks them up once their bucket completes.
       *
       * THE COST IS FRESHNESS: up to one bucket width, 16.8 minutes at 35,622
       * blocks/hour, against ~0.3 minutes when the sweep was clamped to head
       * instead. That is what never pricing from a fraction of a bucket costs, and
       * it is stated rather than absorbed.
       */
      const safe = head - lag;
      const boundary = bucketOf(safe + 1, cfg.bucketBlocks, cfg.bucketOrigin) - 1;
      from = cur.rowCount ? Number(cur.rows[0]!.cursor_block) + 1 : boundary - slice + 1;
      to = Math.min(from + slice - 1, boundary);
      if (to < from) {
        /*
         * NOT AN ERROR, and reported with the numbers rather than as silence: the
         * cursor has reached the last complete bucket and the next one is still
         * filling. A run that advances nothing is the design working.
         */
        ctx.log.info('nothing to advance: the next bucket has not completed', {
          cursor: from - 1, head, lag, safe, boundary,
          blocks_waiting: safe - boundary,
          note: 'the slice may not end inside an incomplete bucket',
        });
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
      /*
       * PER BUCKET, NOT AGGREGATED. The previous version logged only the totals, and
       * when a run's per-bucket detail was later asked for it was unrecoverable: the
       * derivation persists nothing by design, so whatever it does not log is gone.
       */
      ctx.log.info('eth/usd derived for this slice', {
        slice: `${from}..${to}`,
        sweep_range: `${px.buckets[0]?.bucket ?? from}..${to}`,
        buckets_total: px.buckets.length,
        ticks_total: px.ticks,
        discarded_by_fence_total: px.discarded,
        requests: px.requests,
        per_bucket: px.buckets.map((b) => ({
          bucket: b.bucket,
          whole: true,
          bucket_range: `${b.bucket}..${b.bucket + cfg.bucketBlocks - 1}`,
          ticks: b.ticks,
          discarded: b.discarded,
          price_usd: Number(b.price.toFixed(2)),
          tick_blocks: `${b.firstTickBlock}..${b.lastTickBlock}`,
        })),
        note: 'in memory only; native_usd_prices is owned by token-updates and is '
          + 'not written here. Every bucket is whole by construction -- the slice ends '
          + 'on a bucket boundary -- so there is no partial count to report.',
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
          boughtUsd: number; soldUsd: number;
          boughtTrades: number; soldTrades: number;
          boughtUnpriced: number; soldUnpriced: number;
          /*
           * The price line's two terms. BOTH are accumulated over PRICED ROWS ONLY.
           * Including an unpriced row's tokens in the denominator would divide real
           * dollars by tokens that contributed none, understating the price by
           * whatever share of the slice went unpriced.
           */
          pricedUsd: number; pricedTokens: number;
        }
        const byToken = new Map<string, Agg>();
        for (const r of report.rows) {
          const e = byToken.get(r.token) ?? {
            name: r.tokenName, symbol: r.tokenSymbol,
            buyers: new Set<string>(), sellers: new Set<string>(),
            boughtUsd: 0, soldUsd: 0, boughtTrades: 0, soldTrades: 0,
            boughtUnpriced: 0, soldUnpriced: 0, pricedUsd: 0, pricedTokens: 0,
          };
          const amt = Math.abs(Number(r.tokenAmount));
          if (r.side === 'buy') {
            e.buyers.add(r.wallet); e.boughtTrades += 1;
            if (r.usdAmount === null) e.boughtUnpriced += 1; else e.boughtUsd += r.usdAmount;
          } else {
            e.sellers.add(r.wallet); e.soldTrades += 1;
            if (r.usdAmount === null) e.soldUnpriced += 1; else e.soldUsd += r.usdAmount;
          }
          if (r.usdAmount !== null) { e.pricedUsd += r.usdAmount; e.pricedTokens += amt; }
          byToken.set(r.token, e);
        }

        /*
         * THESE WERE INLINE HERE AND ARE NOW IMPORTED. A second alert needed the same
         * rules, and copying them would have been the fifth instance of the
         * two-implementations trap step 7 records. `usd` keeps its local name so the
         * block below reads exactly as it did.
         */
        const usd = usdFigure;

        /*
         * ORDERED BY DISTINCT BUYING WALLETS, then USD bought. It was total USD
         * across both sides, which was wrong twice over: two wallets buying the same
         * token is the coordination signal this system exists to find, and a USD-first
         * order sorted every token with no USD route off the end -- a token with
         * nothing priced totals zero, so it landed last by construction and was always
         * the first cut. Sell-only tokens now sort below every token with a buyer,
         * which is deliberate: the alert leads with accumulation.
         */
        const ordered = [...byToken.entries()].sort((a, b) =>
          (b[1].buyers.size - a[1].buyers.size) || (b[1].boughtUsd - a[1].boughtUsd));

        const block = ([token, e]: [string, Agg]): string => {
          /* Symbol-is-a-label and the DexScreener URL are shared; see alert-format. */
          const label = tokenLabel(token, e.symbol, e.name);
          const chart = chartUrl(token);
          const nb = e.buyers.size; const ns = e.sellers.size;
          const sideLine = (
            wallets: number, trades: number, v: number, unpriced: number,
          ): string => (trades === 0 ? '—'
            : `${wallets} wallet${wallets === 1 ? '' : 's'}  ${usd(v, unpriced, trades)}`);
          /*
           * SLICE-IMPLIED PRICE, NOT THE STORED SERIES. Total USD over total token
           * amount across this token's PRICED rows in this slice, both sides
           * combined, from the rows already aggregated above -- no series read and
           * no extra request. It is a volume-weighted average over one wallet set's
           * trades in ~10,000 blocks: a signal figure, not the accounting record,
           * and never to be compared with a <token>_usd_prices bucket as though it
           * were. Where nothing priced it reads `unpriced` rather than being
           * omitted -- a missing line would read as "no price exists".
           */
          /*
           * IMPORTED AS `priceFigure`, NOT `px`. The inline formatter this replaces
           * was named `px` and SHADOWED the slice-price map declared above under the
           * same name. Removing the inner declaration made this line resolve to the
           * map, which the type checker caught; the rename keeps the two apart by
           * name rather than by scope.
           */
          const priceLine = e.pricedTokens > 0 && e.pricedUsd > 0
            ? priceFigure(e.pricedUsd / e.pricedTokens)
            : 'unpriced';
          return `[${label}](${chart})  \`${short(token)}\`\n`
            + `　bought   ${sideLine(nb, e.boughtTrades, e.boughtUsd, e.boughtUnpriced)}\n`
            + `　sold     ${sideLine(ns, e.soldTrades, e.soldUsd, e.soldUnpriced)}\n`
            + `　price    ${priceLine}`;
        };

        const totalUsd = [...byToken.values()].reduce((n, e) => n + e.boughtUsd + e.soldUsd, 0);
        const unpricedRows = report.usdNull;
        const nothingPriced = (e: Agg): boolean => !(e.pricedTokens > 0 && e.pricedUsd > 0);

        /*
         * THE CAP IS 12 AND THE GUARD IS THE REAL LIMIT.
         *
         * Discord's embed description caps at 4,096 characters and the sink slices to
         * 4,000 BEFORE posting, so an overrun does not make the alert vanish -- it
         * silently removes the tail, which is the "and N more" footer and the tab
         * link, the two elements that say something was omitted. A truncated alert
         * would look complete.
         *
         * A cap alone cannot guarantee the fit because a block's length is not fixed:
         * names run from FAB to Large Language Model, USD from $40 to $8,537+, prices
         * from $0.0000350 to $2,524.13. 20 blocks measured 3,801 characters. So the
         * body is MEASURED and blocks are dropped from the tail until it fits inside
         * MARGIN -- 3,600, which is 400 below the slice, room for one more four-line
         * block plus footer growth. The margin is a round number, not a measurement.
         */
        const CAP = 12;
        const MARGIN = 3600;
        const render = (count: number): string => {
          const shown = ordered.slice(0, count);
          const omitted = ordered.slice(count);
          const omittedUnpriced = omitted.filter(([, e]) => nothingPriced(e)).length;
          return `Blocks ${from}–${to}  ·  $${n0(totalUsd)} priced`
            + (unpricedRows > 0 ? `  ·  ${unpricedRows} of ${report.trades} rows unpriced` : '')
            + `\n\n${shown.map(block).join('\n\n')}`
            /*
             * THE FOOTER STATES WHAT THE GUARD ACTUALLY DROPPED, not the cap.
             * Reporting the cap arithmetic after dropping to fit would understate what
             * was left out -- a silent trim one step removed. The unpriced count says
             * whether the tail went for being quiet or for being unpriceable.
             */
            + (omitted.length > 0
              ? `\n\n_…and ${omitted.length} more token${omitted.length === 1 ? '' : 's'}`
                + `, ${omittedUnpriced} with nothing priced._`
              : '')
            + (ctx.publicUrl
              ? `\n\n**[Every trade on the watchlist tab →](${ctx.publicUrl}/watchlist)**`
                + `  ·  filterable by token and by wallet`
              : `\n\nAll ${report.trades} trades are in \`watchlist_activity\`; the `
                + 'watchlist tab has no public URL configured.');
        };

        let shownCount = Math.min(CAP, ordered.length);
        let description = render(shownCount);
        while (description.length > MARGIN && shownCount > 1) {
          shownCount -= 1;
          description = render(shownCount);
        }
        /*
         * A SINGLE BLOCK THAT STILL OVERRUNS IS REPORTED, NOT SILENTLY SENT. It cannot
         * happen at current lengths -- one block plus footer is ~450 characters -- and
         * if it ever does, the sink would slice and the tail would vanish, so say so.
         */
        if (description.length > MARGIN) {
          ctx.log.warn('alert body exceeds the margin at a single token block', {
            characters: description.length, margin: MARGIN,
            note: 'the sink slices at 4,000 and the footer would be lost',
          });
        }
        ctx.log.info('alert body sized', {
          tokens_total: ordered.length,
          tokens_shown: shownCount,
          tokens_omitted: ordered.length - shownCount,
          omitted_with_nothing_priced:
            ordered.slice(shownCount).filter(([, e]) => nothingPriced(e)).length,
          characters: description.length,
          cap: CAP, margin: MARGIN, sink_slice: 4000,
          dropped_by_guard: Math.min(CAP, ordered.length) - shownCount,
        });

        ctx.queueAlert({
          title: `Watchlist: ${report.trades} trades, ${byToken.size} tokens, `
            + `${new Set(report.rows.map((r) => r.wallet)).size} wallets`,
          description,
          level: 'info',
        }, 'crypto');

        /* ---------------- the SECOND alert: tokens that just launched -------- */
        /*
         * A SEPARATE MESSAGE TO THE SAME CHANNEL ON THE SAME RUN. The alert above is
         * unchanged and posts first; this one asks a different question of the same
         * slice -- which tokens that launched in the last hour did the watchlist buy.
         * It is built after the first so a failure here cannot cost the first alert,
         * and it posts nothing when nothing launched, which is most runs.
         *
         * ITS FILTER WAS MARKET CAP UNTIL 2026-09-15 and was dropped on evidence:
         * both of that figure's terms are approximations and its own measurements
         * found no boundary in them. Market cap is still DISPLAYED here. See step 17.
         */
        const tokensSeen = [...new Set(report.rows.map((r) => r.token.toLowerCase()))];

        /*
         * READ SUPPLY FOR WHAT THIS RUN NEEDS, BOUNDED. A newly-seen token gets a
         * supply without anyone running the backfill again, and the weekly re-reads
         * drain a few per cycle. The bound is a per-run cap so a backlog cannot turn
         * one cycle into a 1,220-token job against a shared ceiling.
         */
        const work = await supplyWorkSet(client, chain, supplyTtlDays, supplyPerRun);
        const supplyRead = work.tokens.length > 0
          ? await readSupplies(client, rpc, chain, work.tokens)
          : {
            attempted: 0, resolved: 0, unresolved: 0, emptyReturn: 0, errored: 0,
            cuSpent: 0,
          };
        ctx.log.info('supply read', {
          ...supplyRead,
          work_set_total: work.total,
          never_read: work.neverRead,
          stale: work.stale,
          fresh: work.fresh,
          per_run_cap: supplyPerRun,
          ttl_days: supplyTtlDays,
          note: 'supply_read_at is set on every ATTEMPT, so a contract that does not '
            + 'answer is not re-asked until its TTL expires',
        });

        /*
         * AGE, AND THE WORK SET IS DERIVED AND LOGGED BEFORE THE FIRST REQUEST.
         *
         * THE WINDOW IS ANCHORED AT `head`, NOT AT THE SLICE. The slice trails the
         * head by up to a whole bucket by design -- the boundary rule above -- and
         * "launched in the last hour" means the last hour NOW, not the last hour as
         * of a block the cursor happens to have reached. Using `to` would quietly
         * widen the window by the cursor's lag.
         *
         * `hi` IS THE SLICE'S LAST BLOCK, because that is where the token is KNOWN to
         * exist: it traded there. `head` is only believed to exist.
         */
        const winBlocks = windowBlocks(launchWindowMinutes);
        const windowStartBlock = head - winBlocks;
        const anchors: AgeAnchor[] = tokensSeen.map((t) => ({
          token: t, lo: windowStartBlock, hi: to,
        }));
        const cachedAges = await loadAges(client, chain, tokensSeen);
        const ageWork = ageWorkSet(anchors, cachedAges);
        ctx.log.info('age work set, BEFORE the first request', {
          launch_window_minutes: launchWindowMinutes,
          window_blocks: winBlocks,
          blocks_per_hour: BLOCKS_PER_HOUR,
          window: `${windowStartBlock}..${head}`,
          tokens_this_slice: ageWork.total,
          settled_by_stored_deployment_block: ageWork.knownDeployment,
          settled_by_stored_existed_at_block: ageWork.knownOld,
          needing_a_request: ageWork.anchors.length,
          estimated_base_cu: ageWork.estimatedBaseCu,
          bisect_cap: bisectCap,
          ceiling_remaining_cu: rpc.ceilingRemaining,
          note: 'one eth_getCode at the window start settles each; only positives are '
            + 'bisected, and only inside that range. window_blocks is DERIVED from the '
            + 'measured 35,622 blocks/hour, never written as a constant.',
        });
        const ageRead = ageWork.anchors.length > 0
          ? await resolveAges(client, rpc, chain, ageWork.anchors, bisectCap)
          : {
            attempted: 0, old: 0, deployed: 0, bisectsSkipped: 0, failed: 0,
            anomalous: 0, cuSpent: 0, bisectCapBound: false,
          };
        ctx.log.info('age resolved', {
          ...ageRead,
          dollars: ((ageRead.cuSpent * 0.45) / 1e6).toFixed(5),
          estimated_base_cu: ageWork.estimatedBaseCu,
          note: 'a NEGATIVE is permanent -- existed_at_block only ever moves down. A '
            + 'POSITIVE stores the deployment block so age is recomputed per run '
            + 'rather than re-read. A failed read is UNKNOWN, never old and never new.',
        });
        if (ageRead.bisectCapBound) {
          ctx.log.warn('age bisect cap bound: some launches were left unresolved', {
            skipped: ageRead.bisectsSkipped, cap: bisectCap,
            note: 'no column was written for those tokens, so the next run re-asks them',
          });
        }
        if (ageRead.anomalous > 0) {
          ctx.log.warn('tokens with no code at the slice end despite trading there', {
            anomalous: ageRead.anomalous,
            note: 'the bisect would have invented a deployment block; recorded unknown',
          });
        }

        const ages = await loadAges(client, chain, tokensSeen);
        const supplies = await loadSupplies(client, chain, tokensSeen);
        const launch = buildAgeAlert({
          rows: report.rows.map((r) => ({
            token: r.token, wallet: r.wallet, side: r.side,
            tokenAmount: Number(r.tokenAmount), usdAmount: r.usdAmount,
            tokenName: r.tokenName, tokenSymbol: r.tokenSymbol,
          })),
          ages,
          supplies,
          windowStartBlock,
          launchWindowMinutes,
          now: new Date(),
          fromBlock: from,
          toBlock: to,
          unknownAge: ageRead.failed + ageRead.bisectsSkipped + ageRead.anomalous,
          publicUrl: ctx.publicUrl,
        });

        ctx.log.info('launch alert sized', {
          launch_window_minutes: launchWindowMinutes,
          window_blocks: winBlocks,
          launched: launch.launched,
          older_than_the_window: launch.older,
          age_unknown: launch.unknown,
          tokens_with_buys: launch.tokensWithBuys,
          buy_rows: launch.buyRows,
          buy_wallets: launch.buyWallets,
          shown: launch.shown,
          dropped_by_guard: launch.dropped,
          characters: launch.characters,
          margin: 3600,
          sink_slice: 4000,
          sent: launch.body !== null,
          note: launch.body === null
            ? 'NOTHING SENT: no token bought this slice deployed inside the window. '
              + 'That is the expected outcome on most runs, not a fault.'
            : 'sent',
        });
        if (launch.overran) {
          ctx.log.warn('launch alert body exceeds the margin at its floor', {
            characters: launch.characters,
            note: 'the sink slices at 4,000 and the footer would be lost',
          });
        }
        if (launch.body !== null && launch.title !== null) {
          ctx.queueAlert({
            title: launch.title, description: launch.body, level: 'info',
          }, 'crypto');
        }
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
