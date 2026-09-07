/**
 * Incremental token update job.
 *
 * Brings one token's cohort rows forward from a cursor to the chain head, one
 * bounded slice per run. It is the standing counterpart to the one-off intake
 * in docs/ROBINHOOD.md and applies the same rules: pools
 * re-enumerated every run, scope applied to both venues, decimals read per
 * contract, direction taken from the transfer, USD null where underivable, and
 * all four floors.
 *
 * THE CURSOR IS THE ONLY PROGRESS STATE. It advances in the SAME transaction
 * that writes the rows, so a run that dies halfway leaves it where it was and
 * the next run re-reads that range. Re-reading is safe because
 * wallet_transactions has a unique key over the event; skipping is impossible
 * because the cursor never passes uncommitted data. Everything else this job
 * needs lives in Postgres, so a container replacement costs nothing.
 *
 * IT LAGS THE HEAD. The last few hundred blocks are left unread so a reorg at
 * the tip cannot strand rows for blocks that later change. The lag is a
 * constant offset and costs no extra calls.
 *
 * WHAT FAILS THE RUN AND WHAT DOES NOT:
 *   - a range that cannot be read      -> FAILS. Partial block coverage is not
 *                                        partial success; the cursor would
 *                                        advance over unread blocks.
 *   - pool enumeration failing         -> FAILS. A stale pool list silently
 *                                        drops trades and reports success.
 *   - the compute-unit ceiling         -> FAILS, and says where it stopped.
 *   - price derivation failing         -> does NOT fail. Rows are written with
 *                                        usd_amount NULL, which is honest and
 *                                        recoverable, and the count is reported.
 */

import type { AdapterContext, SourceAdapter } from './types.js';
import { parseConfig, type UpdateConfig } from './token-updates/config.js';
import { SCHEMA } from './token-updates/schema.js';
import { RpcClient } from './token-updates/rpc.js';
import {
  TOPICS,
  addressTopic,
  decodeSwap,
  decodeTransfer,
  decodeUint8,
  normalizeAddress,
  SELECTORS,
  type SwapLog,
} from './token-updates/decode.js';
import { loadPools, persistPools, poolKey, scanForPools, type PoolRow } from './token-updates/pools.js';
import {
  bucketOf,
  counterUsdResolver,
  derivePrices,
  loadNativeForRange,
  loadNativeReference,
  persistPrices,
  type PriceSeries,
} from './token-updates/prices.js';
import { tradeLegsWithProvenPayment } from '../intake/payment.js';
import { buildRows, tradeLegs, type RowStats, type WalletRow } from './token-updates/rows.js';
import { loadExclusions } from './token-updates/exclusions.js';
import type { PoolClient } from '../store/db.js';

const INFRASTRUCTURE_PATH = 'config/infrastructure.yaml';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface Pending {
  cfg: UpdateConfig;
  from: number;
  to: number;
  head: number;
  newPools: PoolRow[];
  prices: PriceSeries | null;
  priceError: string | null;
  stats: RowStats;
  cuSpent: number;
  callCounts: Record<string, number>;
  swapCounts: { v3: number; v4: number };
  transferCount: number;
  poolsRejected: number;
  idle: boolean;
}

/**
 * Side data produced by fetch() and consumed by persist(). Keyed by monitor
 * because the scheduler runs at most one instance of a monitor at a time and
 * always calls persist immediately after a successful fetch.
 */
const pending = new Map<string, Pending>();

const adapter: SourceAdapter<WalletRow> = {
  type: 'token-updates',

  validate(options, monitorId) {
    parseConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx: AdapterContext): Promise<WalletRow[]> {
    const cfg = parseConfig(ctx.options, ctx.monitorId);

    const key = ctx.configVars.get(cfg.rpcKeyVar);
    if (!key) {
      throw new Error(
        `${cfg.rpcKeyVar} is not set in this process. The job reads logs from an ` +
          'archival endpoint that also populates blockTimestamp; it cannot run without it.',
      );
    }
    const rpc = new RpcClient(
      cfg.rpcUrlTemplate.replace('{key}', key),
      cfg.requestTimeoutMs,
      cfg.cuCeiling,
    );

    const client = await ctx.db.connect();
    let cursor: number;
    let existingPools: Map<string, PoolRow>;
    let cohort: Set<string>;
    let nativeReference: number[];
    let tokenDecimals: number;
    try {
      cursor = await readCursor(client, cfg);
      existingPools = await loadPools(client, cfg.chain, cfg.token);
      cohort = await loadCohort(client, cfg);
      nativeReference = await loadNativeReference(client, cfg.nativeUsdTable, cfg.chain);
      tokenDecimals = await readTokenDecimals(client, rpc, cfg);
    } finally {
      client.release();
    }

    if (cohort.size === 0) {
      // A cohort that matched nothing is a suspected defect, not a quiet run:
      // every subsequent stage would report zero rows and look clean.
      throw new Error(
        `no wallets carry any of the tags ${cfg.cohortTags.join(', ')} for ${cfg.token}. ` +
          'A cohort filter matching nothing would make every run report zero rows.',
      );
    }

    const head = await rpc.blockNumber();
    const target = head - cfg.lagBlocks;
    const from = cursor + 1;
    // Clamp to a bucket boundary so no row is priced from a partially-seen
    // bucket. See prices.ts for why that matters.
    const rawTo = Math.min(cursor + cfg.maxBlocksPerRun, target);
    const to =
      cfg.bucketOrigin +
      Math.floor((rawTo + 1 - cfg.bucketOrigin) / cfg.bucketBlocks) * cfg.bucketBlocks -
      1;

    if (to < from) {
      ctx.log.info('nothing to do: the head has not advanced a full price bucket yet', {
        cursor,
        head,
        target,
        next_boundary:
          bucketOf(cursor, cfg.bucketBlocks, cfg.bucketOrigin) + cfg.bucketBlocks,
      });
      pending.set(ctx.monitorId, {
        cfg, from, to: cursor, head, newPools: [], prices: null, priceError: null,
        stats: emptyStats(), cuSpent: rpc.cuSpent, callCounts: rpc.callCounts(),
        swapCounts: { v3: 0, v4: 0 }, transferCount: 0,
        poolsRejected: 0, idle: true,
      });
      return [];
    }

    /* ---- pool enumeration: fails the run if it fails --------------------- */
    const scan = await scanForPools(rpc, cfg, existingPools, from, to);
    ctx.log.info('pool enumeration', {
      blocks: `${from}..${to}`,
      creation_events_seen: scan.seen,
      new_in_scope: scan.added.length,
      new_out_of_scope: scan.rejected.length,
    });

    /* ---- swaps ----------------------------------------------------------- */
    const v3Pools = [...scan.all.values()].filter((p) => p.venue === 'v3').map((p) => p.pool);
    const v4Ids = [...scan.all.values()].filter((p) => p.venue === 'v4').map((p) => p.pool);

    const swaps: { swap: SwapLog; pool: PoolRow }[] = [];
    if (v3Pools.length > 0) {
      // Measured: 5,834 v3 swap logs across 36,000 blocks came back in ONE
      // request. The span halves only if a busier hour is refused.
      const logs = await rpc.getLogs(
        { address: v3Pools, topics: [TOPICS.swapV3] },
        from, to, to - from + 1, cfg.minLogSpanBlocks,
      );
      for (const log of logs) {
        const swap = decodeSwap(log, 'v3');
        const pool = scan.all.get(poolKey('v3', swap.pool));
        if (pool) swaps.push({ swap, pool });
      }
    }
    const v3Count = swaps.length;
    if (v4Ids.length > 0) {
      // Measured: 1,276 v4 swap logs across 36,000 blocks, filtered by 540
      // pool ids in the topic array, in ONE request.
      const logs = await rpc.getLogs(
        { address: cfg.v4PoolManager, topics: [TOPICS.swapV4, v4Ids] },
        from, to, to - from + 1, cfg.minLogSpanBlocks,
      );
      for (const log of logs) {
        const swap = decodeSwap(log, 'v4');
        const pool = scan.all.get(poolKey('v4', swap.pool));
        if (pool) swaps.push({ swap, pool });
      }
    }
    const v4Count = swaps.length - v3Count;

    /* ---- transfers: the attribution source ------------------------------- */
    // Transfers are the one stream measured to exceed the result cap: 36,000
    // blocks is refused, 18,000 returns 7,113 logs. It starts at the narrower
    // span rather than paying for a refusal every run.
    const transferLogs = await rpc.getLogs(
      { address: cfg.token, topics: [TOPICS.transfer] },
      from, to, cfg.logSpanBlocks, cfg.minLogSpanBlocks,
    );
    const transfers = transferLogs.map(decodeTransfer);

    /*
     * WHO PAID. A buy has two halves and the token's own transfers prove only
     * the first; this proves the second. One eth_getLogs per pricing asset,
     * with every pool counterparty as a topic array, so the cost is per asset
     * rather than per pool. See docs/ROBINHOOD.md step 7.
     *
     * Native-ETH-quoted pools move value without a Transfer log and are not
     * covered -- that limitation is recorded in the document, not worked around.
     */
    /*
     * THE PAYMENT HALF OF A BUY -- proven from receipts, in the SAME
     * implementation the intake uses. See intake/payment.ts and
     * docs/ROBINHOOD.md step 7.
     *
     * This used to sweep `Transfer` on each pricing asset with the pools as a
     * topic filter and ask whether the wallet had sent one to a pool. That
     * question is much narrower than "did the wallet give up value", and
     * measured against 40 decoded transactions it rejected 39 real buyers, 36
     * of whom paid in native ETH -- which moves with no Transfer log at all.
     * The two getLogs calls it cost per run are gone with it.
     */
    /* ---- prices: a failure here does NOT fail the run -------------------- */
    /*
     * The FIRST run after seeding starts mid-bucket, because the seed block is
     * wherever the intake stopped. That bucket's ticks are only partly visible
     * here, so it is not recomputed -- the price stored for it by the intake is
     * loaded instead, and used to price this run's rows without being rewritten.
     * From the second run on, `from` is already a bucket boundary and this
     * lookup returns nothing.
     */
    const firstCompleteBucket =
      cfg.bucketOrigin +
      Math.ceil((from - cfg.bucketOrigin) / cfg.bucketBlocks) * cfg.bucketBlocks;

    let prices: PriceSeries | null = null;
    let priceError: string | null = null;
    try {
      prices = derivePrices(swaps, cfg, tokenDecimals, nativeReference, firstCompleteBucket);
    } catch (err) {
      priceError = err instanceof Error ? err.message : String(err);
      ctx.log.error('price derivation failed; rows will store a null usd_amount', {
        error: priceError,
      });
      ctx.queueAlert(
        {
          title: `${ctx.monitorName}: price derivation failed`,
          description:
            `Blocks ${from}..${to} were read, but no price could be derived for them.\n` +
            `Error: ${priceError}\n\n` +
            'Rows are still being written with usd_amount NULL. Nothing has been ' +
            'stored as zero and nothing has been carried forward from an earlier bucket.',
          level: 'warning',
        },
        'system',
      );
    }

    /* Prices used to VALUE rows: newly derived, plus stored values for any
     * bucket this run saw only in part. Only the derived ones are written. */
    const pricingMap = new Map<number, { price: number }>(prices?.nativeUsd ?? []);
    let storedBucketsUsed = 0;
    if (firstCompleteBucket > from) {
      const client2 = await ctx.db.connect();
      try {
        const stored = await loadNativeForRange(
          client2, cfg.nativeUsdTable, cfg.chain,
          bucketOf(from, cfg.bucketBlocks, cfg.bucketOrigin), firstCompleteBucket - 1,
        );
        for (const [bucket, v] of stored) {
          if (!pricingMap.has(bucket)) {
            pricingMap.set(bucket, v);
            storedBucketsUsed += 1;
          }
        }
      } finally {
        client2.release();
      }
    }

    const exclusionList = await loadExclusions(INFRASTRUCTURE_PATH, cfg.chain);
    const exclusions = new Set(exclusionList.map((e) => e.address));
    const knownPools = new Set([...scan.all.values()].map((p) => p.pool));

    const resolver = counterUsdResolver(cfg, pricingMap);
    const proven = await tradeLegsWithProvenPayment(
      rpc, cfg.token, knownPools,
      (payments) => tradeLegs(
        swaps, transfers, cfg, resolver, exclusions, knownPools, payments,
      ),
    );
    const { rows, stats } = buildRows(
      swaps,
      transfers,
      cfg,
      tokenDecimals,
      resolver,
      exclusions,
      knownPools,
      proven.index,
      cohort,
    );

    ctx.log.info('slice read', {
      blocks: `${from}..${to}`,
      block_count: to - from + 1,
      head,
      swaps_v3: v3Count,
      swaps_v4: v4Count,
      transfers: transfers.length,
      receipts_fetched: proven.receiptsFetched,
      candidate_buy_transactions: proven.candidateTransactions,
      buys_rejected_no_payment: proven.buysRejected,
      buys_accepted_purpose_unproven: proven.purposeUnproven,
      rows_built: rows.length,
      price_buckets_partial_skipped: prices?.stats.bucketsPartial ?? 0,
      price_buckets_reused_from_store: storedBucketsUsed,
      cu_spent: rpc.cuSpent,
      calls: rpc.callCounts(),
    });

    pending.set(ctx.monitorId, {
      cfg, from, to, head,
      newPools: scan.added,
      prices,
      priceError,
      stats,
      cuSpent: rpc.cuSpent,
      callCounts: rpc.callCounts(),
      swapCounts: { v3: v3Count, v4: v4Count },
      transferCount: transfers.length,
      poolsRejected: scan.rejected.length,
      idle: false,
    });
    return rows;
  },

  /**
   * One transaction: pools, prices, rows, cursor. The cursor moving is what
   * declares the range done, so it must not be able to commit without them.
   */
  async persist(ctx, client, rows) {
    const p = pending.get(ctx.monitorId);
    if (!p) throw new Error('persist called without a completed fetch');
    pending.delete(ctx.monitorId);
    if (p.idle) return 0;

    await persistPools(client, p.cfg.chain, p.cfg.token, p.newPools);
    /*
     * `token_payment_logs` is no longer written. It recorded the log-based
     * rule's evidence -- wallets that sent a pricing asset directly to a pool,
     * which is the minority path -- and the receipt rule does not need it. The
     * TABLE and its 625,888 rows are deliberately kept: they are a measurement
     * that was made, and this project does not delete history.
     */
    const priceWrites = p.prices
      ? await persistPrices(client, p.cfg, p.prices)
      : { tokenUsdInserted: 0, tokenUsdAlreadyPresent: 0,
          nativeUsdInserted: 0, nativeUsdAlreadyPresent: 0 };

    let stored = 0;
    for (const r of rows) {
      const res = await client.query(
        `insert into wallet_transactions
           (chain, token, wallet, side, counterparty, tx_hash, pool,
            block_time, block_number, token_amount, usd_amount, price_usd)
         values ($1, $2, $3, $4, null, $5, $6, $7, $8, $9, $10, $11)
         on conflict do nothing`,
        [
          p.cfg.chain, p.cfg.token, r.wallet, r.side, r.txHash, r.pool,
          r.blockTime, r.blockNumber, r.tokenAmount, r.usdAmount, r.priceUsd,
        ],
      );
      stored += res.rowCount ?? 0;
    }

    await client.query(
      `insert into token_ingest_cursor
         (chain, token, kind, cursor_block, head_block, last_run_at, last_status,
          last_error, rows_written, runs)
       values ($1, $2, 'swap', $3, $4, now(), $5, $6, $7, 1)
       on conflict (chain, token, kind) do update
         set cursor_block = excluded.cursor_block,
             head_block   = excluded.head_block,
             last_run_at  = excluded.last_run_at,
             last_status  = excluded.last_status,
             last_error   = excluded.last_error,
             rows_written = token_ingest_cursor.rows_written + excluded.rows_written,
             runs         = token_ingest_cursor.runs + 1`,
      [
        p.cfg.chain, p.cfg.token, p.to, p.head,
        p.priceError ? 'success_unpriced' : 'success', p.priceError, stored,
      ],
    );

    ctx.log.info('slice committed', {
      blocks: `${p.from}..${p.to}`,
      rows_seen: rows.length,
      rows_stored: stored,
      rows_already_present: rows.length - stored,
      new_pools: p.newPools.length,
      pools_rejected_out_of_scope: p.poolsRejected,
      price_buckets: priceWrites,
      floors: {
        swaps_below_token_raw: p.stats.swapsBelowTokenRawFloor,
        swaps_below_paid_raw: p.stats.swapsBelowPaidRawFloor,
        rows_below_token_amount: p.stats.rowsBelowTokenAmountFloor,
        rows_below_usd: p.stats.rowsBelowUsdFloor,
      },
      buys_rejected_no_payment: p.stats.buysWithNoPayment,
      excluded: {
        infrastructure: p.stats.walletsExcludedInfrastructure,
        is_a_pool: p.stats.walletsExcludedIsPool,
        round_trippers: p.stats.roundTrippers,
        outside_cohort: p.stats.rowsOutsideCohort,
      },
      null_usd_rows: p.stats.rowsWithNullUsd,
      cu_spent: p.cuSpent,
    });
    return stored;
  },
};

function emptyStats(): RowStats {
  return {
    swapsConsidered: 0, swapsBelowTokenRawFloor: 0, swapsBelowPaidRawFloor: 0,
    groups: 0, groupsWithMultiplePools: 0, groupsWithoutTransfers: 0,
    candidateWallets: 0, walletsExcludedInfrastructure: 0, walletsExcludedIsPool: 0,
    roundTrippers: 0, rowsBelowTokenAmountFloor: 0, rowsBelowUsdFloor: 0,
    rowsOutsideCohort: 0, rowsWithNullUsd: 0, nullUsdBecauseNoBucketPrice: 0,
    buysWithNoPayment: 0,
  };
}

async function readCursor(client: PoolClient, cfg: UpdateConfig): Promise<number> {
  const res = await client.query<{ cursor_block: number }>(
    `select cursor_block from token_ingest_cursor
      where chain = $1 and token = $2 and kind = 'swap'`,
    [cfg.chain, cfg.token],
  );
  if (res.rowCount === 0) {
    if (cfg.seedCursorBlock <= 0) {
      throw new Error(
        'no cursor row exists and seed_cursor_block is not set. Seeding at the head ' +
          'would silently skip every block before it.',
      );
    }
    return cfg.seedCursorBlock;
  }
  return Number(res.rows[0]!.cursor_block);
}

async function loadCohort(client: PoolClient, cfg: UpdateConfig): Promise<Set<string>> {
  const res = await client.query<{ wallet: string }>(
    `select distinct wallet from wallet_tags where mint = $1 and tag = any($2::text[])`,
    [cfg.token, cfg.cohortTags],
  );
  return new Set(res.rows.map((r) => normalizeAddress(r.wallet)));
}

/** Read from the contract. A `0x` return is unknown, never 18 and never 0. */
async function readTokenDecimals(
  client: PoolClient,
  rpc: RpcClient,
  cfg: UpdateConfig,
): Promise<number> {
  const res = await client.query<{ decimals: number }>(
    `select decimals from tokens where mint = $1`,
    [cfg.token],
  );
  const stored = res.rows[0]?.decimals;
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= 0) return stored;
  return decodeUint8(await rpc.ethCall(cfg.token, SELECTORS.decimals));
}

export default adapter;
