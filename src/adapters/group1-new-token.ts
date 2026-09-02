/**
 * Group 1 wallets buying tokens that just launched.
 *
 * THE MIRROR OF group2-new-token, watching the other population. Group 1 is
 * "bought and never sold", so there is no PnL threshold -- filtering on realized
 * PnL would empty the list. The watchlist is every Group 1 wallet across the six
 * Robinhood tokens, deduplicated: 2,956, not the 2,991 the per-token counts sum
 * to, because 35 wallets sit in two cohorts.
 *
 * IT IS 8.5x THE TRANSFER-SCAN COST OF group2, measured: 2,956 wallets is 15
 * chunks x 2 windows and came back as 34 requests and 136 s against the live
 * endpoint, where group2's 331 wallets cost 4 requests. That is ~152 s of the
 * 300 s guard gone before a single receipt, which is why the schedule is 20m
 * and why receipt_cap_per_token matters more here than it does for group2.
 *
 * ON PublicRpc AT 4,000 ms, DELIBERATELY UNCHANGED. Halving the spacing would
 * save ~68 s, but the 4,000 ms figure was measured on exactly this call --
 * eth_getLogs over 200 addresses -- and it is the most expensive request the
 * project makes. The receipt phase runs on its own faster limiter because
 * receipts are cheap point lookups; the two are not the same bet.
 *
 * SHARES group2's pure helpers by import, never by copy: the receipt resolver,
 * the DexScreener client and the line renderer are one implementation, so the
 * two monitors cannot drift. Everything stateful is this monitor's own.
 *
 * A NARROWER new-token-watch, not a replacement for it. The old monitor watches
 * 6,344 wallets built from three union rules; this watches the 331 Group 2
 * wallets whose realized PnL is at or above the threshold -- a strict subset
 * (all 331 are already on the old list) and about 19x smaller. That is what
 * makes the cycle affordable: the old monitor needed 4-way staggering to fit and
 * still exceeded the spine's 300 s ceiling on 6 of 25 cycles. At 331 wallets the
 * transfer scan is 2 chunks, so there is no staggering here at all -- it would
 * delay detection by up to 45 minutes and save nothing.
 *
 * REUSED FROM new-token-watch, unchanged: PublicRpc (pacing, recursive window
 * splitting), the v4 PoolManager Initialize sweep, the token_pool_first pool
 * cache, the venue-transfer attribution rule, and tokenLink.
 *
 * ATTRIBUTION IS THE SAME RULE AND IT SIDESTEPS tx.from. An inbound Transfer
 * whose `from` is the PoolManager IS the buyer's balance delta, so nothing here
 * depends on tx.from -- which identifies the trader only about 46% of the time
 * on this chain. Measured on the old monitor: 26.5% of inbound transfers pass
 * the venue filter; without it this is a spam feed of airdrops.
 *
 * KNOWN LIMITATION -- V3 LAUNCHES ARE INVISIBLE. Detection keys entirely off the
 * v4 PoolManager's Initialize event. A token launched only on a v3 factory pool
 * will never be detected. This is demonstrable rather than theoretical: PONS is
 * recorded as uniswap v3 with a 20-byte pool address, and token_pool_first holds
 * a different, later v4 poolId for it -- the sweep never saw its real launch.
 * Covering v3 needs each factory address and its PoolCreated topic. The size of
 * the gap has NOT been measured.
 *
 * OWN CURSOR, SHARED POOL CACHE. group1_new_token_cursor rather than
 * new_token_cursor: the latter is keyed on chain with no monitor_id, so writing
 * it would move the disabled new-token-watch's position and change its behaviour
 * on re-enable. token_pool_first is shared because its upsert is idempotent and
 * monitor-agnostic -- a second writer only makes it warmer.
 */
import type { AdapterContext, SourceAdapter } from './types.js';
import { requireString } from './types.js';
import type { PoolClient } from '../store/db.js';
import { migrate } from './group1-new-token/schema.js';
import { loadWatchlist } from './group1-new-token/watchlist.js';
import { PublicRpc, topicAddress, padAddress, type RpcLog } from './new-token-watch/rpc.js';
import { resolvePairs, topPairByToken } from './group2-new-token/dexscreener.js';
import { resolveSwapPools } from './group2-new-token/swappool.js';
import { renderAlert, type AlertLine } from './group1-new-token/message.js';

interface Alerted { token: string; chain: string; count: number }
interface PoolPick { token: string; chain: string; poolId: string; source: string; transfers: number | null }
interface RunResult {
  alerted: Alerted[];
  pools: { token: string; block: number; poolId: string; at: Date }[];
  picks: PoolPick[];
  truncations: { token: string; transfersSeen: number; receiptsFetched: number }[];
  chunks: Record<string, number | boolean>[];
  parts: string[];
  stats: Record<string, number>;
  sweptFrom: number;
  sweptTo: number;
  messageText: string;
}

const num = (o: Record<string, unknown>, k: string, d: number): number => {
  const v = o[k]; return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

/**
 * Mutable snapshot of how far the current cycle got, for the abort path.
 *
 * PHASES ARE DERIVED FROM A LIVE COUNTER, NOT ASSIGNED AT THE END OF A LOOP.
 * The previous version set transferReq only after the transfer loop finished, so
 * an abort mid-loop wrote 0 and the stats row said the cycle died in the sweep
 * when it had in fact spent four minutes in the transfer scan. That single wrong
 * number produced four wrong diagnoses in a row. Marks record where each phase
 * ENDED; anything still running is measured against the live counter instead.
 */
const ABORT = {
  started: Date.now(),
  live: (): number => 0,          // replaced with () => rpc.requests once it exists
  liveSplits: (): number => 0,
  liveRetries: (): number => 0,
  overheadAt: null as number | null,
  sweepAt: null as number | null,
  transfersAt: null as number | null,
  receiptReq: 0,
  watchlistSize: 0, transfers: 0, venueTransfers: 0,
  tokensDetected: 0, tokensEligibleAge: 0, tokensWithBuyer: 0, tokensSuppressed: 0,
  chunks: [] as Record<string, number | boolean>[],
  reset(): void {
    this.started = Date.now();
    this.live = () => 0; this.liveSplits = () => 0; this.liveRetries = () => 0;
    this.overheadAt = null; this.sweepAt = null; this.transfersAt = null;
    this.receiptReq = 0; this.watchlistSize = 0; this.transfers = 0;
    this.venueTransfers = 0; this.tokensDetected = 0; this.tokensEligibleAge = 0;
    this.tokensWithBuyer = 0; this.tokensSuppressed = 0; this.chunks = [];
  },
  durationMs(): number { return Date.now() - this.started; },
  /** Requests per phase, correct whether or not the phase finished. */
  phases(): { overhead: number; sweep: number; transfers: number; receipts: number; total: number } {
    const now = this.live();
    const overhead = this.overheadAt ?? now;
    const sweep = (this.sweepAt ?? now) - overhead;
    const transfers = this.sweepAt === null ? 0 : (this.transfersAt ?? now) - this.sweepAt;
    return { overhead, sweep: Math.max(0, sweep), transfers: Math.max(0, transfers),
      receipts: this.receiptReq, total: now + this.receiptReq };
  },
  snapshot(): Record<string, unknown> {
    return { ...this.phases(), chunksDone: this.chunks.length,
      tokensDetected: this.tokensDetected, tokensWithBuyer: this.tokensWithBuyer };
  },
};

async function runCycle(ctx: AdapterContext): Promise<RunResult[]> {
    ABORT.reset();
    const o = ctx.options;
    const chain = String(o.chain);
    const PM = String(o.pool_manager).toLowerCase();
    const INIT = String(o.initialize_topic).toLowerCase();
    const TRANSFER = String(o.transfer_topic).toLowerCase();
    const SWAP = String(o.swap_topic).toLowerCase();
    const maxAgeMin = num(o, 'max_pool_age_minutes', 120);
    const lookbackH = num(o, 'lookback_hours', 1);
    const bootstrapH = num(o, 'bootstrap_hours', 3);
    const chunkSize = num(o, 'watchlist_chunk', 200);
    const transferWindow = num(o, 'transfer_block_window', 20_000);
    const sweepWindow = num(o, 'sweep_block_window', 20_000);
    const TOKENS = (ctx.options.tokens as string[]).map(String);
    const started = Date.now();
    // Carried outside the try so the abort path can write what it got to.
    let requestsExtra = 0;
    const progress: Record<string, number> = { sweep: 0, transfers: 0, receipts: 0 };
    const mark = (k: string, v: number): void => { progress[k] = v; };

    const rpc = new PublicRpc(String(o.rpc_url), num(o, 'min_interval_ms', 4000), ctx.log, ctx.signal);
    ABORT.live = () => rpc.requests;
    ABORT.liveSplits = () => rpc.splits;
    ABORT.liveRetries = () => rpc.retries;
    const head = await rpc.blockNumber();

    // Block time is MEASURED each run. It sets the lookback range and every pool
    // age, so a pinned constant would mis-age every token at once.
    const probe = Math.max(1, head - 100_000);
    const [tHead, tProbe] = [await rpc.blockTimestamp(head), await rpc.blockTimestamp(probe)];
    const blockSeconds = (tHead - tProbe) / (head - probe);
    if (!(blockSeconds > 0) || !Number.isFinite(blockSeconds))
      throw new Error(`implausible block time ${blockSeconds}`);
    const perHour = Math.floor(3600 / blockSeconds);
    ABORT.overheadAt = rpc.requests;          // head + both timestamps are done

    // ---- Initialize sweep, incremental from this monitor's own cursor -----
    const cur = await ctx.db.query(
      `select last_swept_block from group1_new_token_cursor where chain = $1`, [chain]);
    // BOUNDED CATCH-UP. Without it a run that failed on duration makes the next
    // run longer and likelier to fail -- a spiral. Anything older than
    // bootstrap_hours is older than the age rule would allow anyway.
    const floorBlock = head - Math.floor(perHour * bootstrapH);
    const rawFrom = cur.rows.length ? Number(cur.rows[0].last_swept_block) + 1 : floorBlock;
    const sweptFrom = Math.max(rawFrom, floorBlock);
    if (sweptFrom > rawFrom)
      ctx.log.warn('sweep catch-up capped at bootstrap_hours',
        { cursorWanted: rawFrom, sweepingFrom: sweptFrom, skippedBlocks: sweptFrom - rawFrom });
    const initLogs = sweptFrom <= head
      ? await rpc.logsRange({ address: PM, topics: [INIT] }, sweptFrom, head, sweepWindow)
      : [];
    // topics[1] is the poolId, which is what DexScreener uses as the pair
    // address on v4 and therefore what a link needs.
    mark('sweep', rpc.requests); ABORT.sweepAt = rpc.requests;
    const created = new Map<string, { block: number; poolId: string }>();
    for (const l of initLogs) {
      const block = Number.parseInt(l.blockNumber, 16);
      const poolId = String(l.topics[1] ?? '').toLowerCase();
      for (const t of [topicAddress(l.topics[2]), topicAddress(l.topics[3])]) {
        const prev = created.get(t);
        if (prev === undefined || block < prev.block) created.set(t, { block, poolId });
      }
    }

    // ---- inbound transfers to the watchlist, no staggering ----------------
    const watchlist = await loadWatchlist(ctx.db, chain, TOKENS);
    ABORT.watchlistSize = watchlist.length;
    const inList = new Set(watchlist);
    ctx.log.info('watchlist', { wallets: watchlist.length, tokens: TOKENS.length,
      chunks: Math.ceil(watchlist.length / chunkSize) });

    const lo = head - Math.floor(perHour * lookbackH);
    const addrs = watchlist.map((w) => padAddress(w));
    const transfers: RpcLog[] = [];
    // PER CHUNK, RECORDED AS IT GOES. Requests, elapsed time, and whether the
    // window split or a request was retried -- a split is one extra paced
    // request, a retry is a paced request PLUS 3000*(n+1)^2 of backoff, and
    // those were previously indistinguishable from the outside.
    const windowsPerChunk = Math.ceil((head - lo + 1) / transferWindow);
    for (let i = 0, n = 0; i < addrs.length; i += chunkSize, n++) {
      // THE RECORD IS PUSHED BEFORE THE AWAIT, and finalised in `finally`. The
      // previous version pushed it after the chunk returned, so the ONLY chunk
      // that mattered -- the one the abort landed in -- was the one with no
      // record. That is the same defect as assigning a phase counter after its
      // loop, made twice in the same change.
      const rec: Record<string, number | boolean> = {
        chunk: n, wallets: Math.min(chunkSize, addrs.length - i),
        expected: windowsPerChunk, requests: 0, splits: 0, retries: 0,
        ms: 0, logs: 0, complete: false,
      };
      ABORT.chunks.push(rec);
      const r0 = rpc.requests, s0 = rpc.splits, y0 = rpc.retries, t0 = Date.now();
      try {
        const got = await rpc.logsRange(
          { topics: [TRANSFER, null, addrs.slice(i, i + chunkSize)] }, lo, head, transferWindow);
        transfers.push(...got);
        rec.complete = true;
      } finally {
        rec.requests = rpc.requests - r0;
        rec.splits = rpc.splits - s0;
        rec.retries = rpc.retries - y0;
        rec.ms = Date.now() - t0;
        rec.logs = transfers.length;
      }
      ABORT.transfers = transfers.length;
    }
    // A TRANSFER IS NOT A BUY. Only tokens handed over by the venue contract
    // count; an airdrop arrives as an inbound transfer too.
    mark('transfers', rpc.requests - progress.sweep!);
    ABORT.transfersAt = rpc.requests;
    const venue = transfers.filter((l) => topicAddress(l.topics[1]) === PM);
    ABORT.venueTransfers = venue.length;

    // ---- pool age, cache first --------------------------------------------
    const distinct = [...new Set(venue.map((l) => l.address.toLowerCase()))];
    const cached = distinct.length
      ? await ctx.db.query(
          `select token, created_block, created_at, older_than_sweep, pool_id
             from token_pool_first where chain = $1 and token = any($2::text[])`,
          [chain, distinct])
      : { rows: [] as Record<string, unknown>[] };
    const resolved = new Map<string, { block: number; poolId: string | null }>();
    for (const r of cached.rows as Record<string, unknown>[]) {
      const token = String(r.token);
      const swept = created.get(token);
      if (r.older_than_sweep === true || r.created_block === null) continue;
      resolved.set(token, {
        block: Number(r.created_block),
        poolId: r.pool_id == null ? swept?.poolId ?? null : String(r.pool_id),
      });
    }
    for (const token of distinct) {
      if (resolved.has(token)) continue;
      const entry = created.get(token);
      // Not created inside any swept window, so older than our coverage.
      if (entry !== undefined) resolved.set(token, { block: entry.block, poolId: entry.poolId });
    }

    // ---- age rule, then distinct watchlist buyers per token ---------------
    const maxAgeBlocks = (maxAgeMin * 60) / blockSeconds;
    const eligible = new Set<string>();
    const buyers = new Map<string, Set<string>>();
    // The transactions behind each token's qualifying transfers. Kept here so
    // the poolId lookup later costs no extra log queries -- only receipts, and
    // only for tokens that survive the re-alert rule.
    const txsOf = new Map<string, string[]>();
    // A POOL FIRST SWEPT IN THIS CYCLE IS ALWAYS ELIGIBLE, whatever its age.
    // The age rule is about staleness, not about punishing downtime: if the
    // monitor was off for ninety minutes, the cursor-based sweep catches those
    // blocks up (bounded by bootstrap_hours) and the pools created in the gap
    // are already older than the window the moment we first see them. Without
    // this they would be detected, cached, and then silently dropped -- a launch
    // missed for no reason except that we were not watching at the time.
    // created_block >= sweptFrom is exactly "this cycle's sweep is the first one
    // that could have seen it", and it uses only this monitor's own cursor.
    let admittedByGrace = 0;
    for (const l of venue) {
      const token = l.address.toLowerCase();
      const r = resolved.get(token);
      if (!r) continue;
      const firstSweptNow = r.block >= sweptFrom;
      if (head - r.block > maxAgeBlocks) {
        if (!firstSweptNow) continue;
        if (!eligible.has(token)) admittedByGrace++;
      }
      eligible.add(token);
      const wallet = topicAddress(l.topics[2]);
      if (!inList.has(wallet)) continue;
      let s = buyers.get(token);
      if (!s) { s = new Set(); buyers.set(token, s); }
      s.add(wallet);
      const t = txsOf.get(token);
      if (t) t.push(l.transactionHash); else txsOf.set(token, [l.transactionHash]);
    }

    // ---- re-alert rule: strictly above the highest count ever alerted -----
    const withBuyer = [...buyers.keys()];
    const highs = new Map<string, number>();
    if (withBuyer.length) {
      const h = await ctx.db.query(
        `select token, last_alerted_count from group1_token_alerts
          where chain = $1 and token = any($2::text[])`, [chain, withBuyer]);
      for (const r of h.rows as Record<string, unknown>[])
        highs.set(String(r.token), Number(r.last_alerted_count));
    }
    const candidates = withBuyer.filter((t) => (buyers.get(t)?.size ?? 0) > (highs.get(t) ?? 0));
    const suppressed = withBuyer.length - candidates.length;
    ABORT.tokensDetected = distinct.length; ABORT.tokensEligibleAge = eligible.size;
    ABORT.tokensWithBuyer = withBuyer.length; ABORT.tokensSuppressed = suppressed;

    // ---- which pool to link -----------------------------------------------
    // THE POOL THE WALLETS ACTUALLY TRADED, not the earliest one created. Only
    // candidates are looked up, which is what keeps the receipt cost small.
    const work = new Map<string, string[]>();
    for (const t of candidates) { const h = txsOf.get(t); if (h?.length) work.set(t, h); }
    const swap = await resolveSwapPools(work, {
      url: String(o.rpc_url), poolManager: PM, swapTopic: SWAP,
      batchSize: num(o, 'receipt_batch', 25),
      concurrency: num(o, 'receipt_concurrency', 2),
      intervalMs: num(o, 'receipt_interval_ms', 2000),
      capPerToken: num(o, 'receipt_cap_per_token', 50),
      signal: ctx.signal,
    });
    requestsExtra = swap.requests;
    progress.receipts = swap.requests;
    ABORT.receiptReq = swap.requests;

    // Confirm the swap pool is one DexScreener actually indexes; that call also
    // supplies the symbol, so it replaces a per-token eth_call.
    const swapIds = [...swap.chosen.values()].map((v) => v.poolId);
    const { found, failedBatches } = swapIds.length
      ? await resolvePairs(String(o.dexscreener_chain), swapIds, ctx.signal)
      : { found: new Map(), failedBatches: 0 };

    const lines: AlertLine[] = [];
    const picks: PoolPick[] = [];
    let linkedFromSwap = 0, linkedFromFallback = 0, multiPoolIdTokens = 0;
    for (const token of candidates) {
      const count = buyers.get(token)!.size;
      const prev = highs.get(token);
      const pick = swap.chosen.get(token);
      if (pick && pick.distinctPools > 1) multiPoolIdTokens++;
      let poolId: string | null = null, symbol: string | null = null, source = '';
      let transfers: number | null = null;
      if (pick && found.has(pick.poolId)) {
        poolId = pick.poolId; symbol = found.get(pick.poolId)!.symbol;
        source = 'swap'; transfers = pick.transfers; linkedFromSwap++;
      } else {
        // FALLBACK, not a guess: highest liquidity for this token address.
        const top = await topPairByToken(String(o.dexscreener_chain), token, ctx.signal);
        if (top) { poolId = top.poolId; symbol = top.symbol; source = 'fallback'; linkedFromFallback++; }
      }
      if (!poolId) continue;                     // no pair anywhere: omit the line
      picks.push({ token, chain, poolId, source, transfers });
      lines.push({ token, poolId, symbol, wallets: count,
        growth: prev === undefined ? null : count - prev });
    }
    const omittedNoPoolId = 0;
    const omittedNoPair = candidates.length - lines.length;

    const { parts, duplicateSymbols } = renderAlert(String(o.dashboard_url), lines);
    const messageText = parts.join('\n---\n');

    const stats = {
      // rpc.requests counts only the PublicRpc phases; the receipt phase runs on
      // its own limiter and its own counter, so it has to be added back or the
      // cycle under-reports its own cost.
      head, blockSeconds, requests: rpc.requests + swap.requests,
      watchlistSize: watchlist.length,
      transfers: transfers.length, venueTransfers: venue.length,
      tokensDetected: distinct.length, tokensEligibleAge: eligible.size,
      tokensWithBuyer: withBuyer.length, tokensAlerted: lines.length,
      tokensSuppressed: suppressed, omittedNoPoolId, omittedNoPair, duplicateSymbols,
      admittedByGrace,
      linkedFromSwap, linkedFromFallback, multiPoolIdTokens,
      ambiguousReceipts: swap.ambiguousReceipts, missingReceipts: swap.missingReceipts,
      extraRpcRequests: swap.requests, receiptRateLimited: swap.rateLimited,
      truncatedTokens: swap.truncations.length,
      phaseSweepReq: progress.sweep ?? 0, phaseTransferReq: progress.transfers ?? 0,
      phaseReceiptReq: swap.requests, rpcSplits: rpc.splits, rpcRetries: rpc.retries,
      dexscreenerFailedBatches: failedBatches, durationMs: Date.now() - started,
    };
    ctx.log.info('group1 new-token cycle', stats);

    return [{
      alerted: lines.map((l) => ({ token: l.token, chain, count: l.wallets })),
      pools: [...created.entries()].map(([token, e]) => ({
        token, block: e.block, poolId: e.poolId,
        at: new Date((tHead - (head - e.block) * blockSeconds) * 1000),
      })),
      picks, parts, stats, sweptFrom, sweptTo: head, messageText,
      truncations: swap.truncations, chunks: ABORT.chunks,
    }];
}


const adapter: SourceAdapter<RunResult> = {
  type: 'group1-new-token',
  validate(o, id) {
    requireString(o, 'chain', id);
    requireString(o, 'rpc_url', id);
    requireString(o, 'pool_manager', id);
    requireString(o, 'initialize_topic', id);
    requireString(o, 'transfer_topic', id);
    requireString(o, 'swap_topic', id);
    requireString(o, 'dashboard_url', id);
    requireString(o, 'dexscreener_chain', id);
    if (!Array.isArray(o.tokens) || !o.tokens.length)
      throw new Error(`monitor "${id}": options.tokens must be a non-empty list of token names`);
    if (num(o, 'watchlist_chunk', 0) < 1 || num(o, 'watchlist_chunk', 0) > 400)
      throw new Error(`monitor "${id}": options.watchlist_chunk must be 1..400 (measured: 500 times out)`);
  },
  migrate,

  async fetch(ctx: AdapterContext): Promise<RunResult[]> {
    // AN ABORTED CYCLE MUST LEAVE EVIDENCE. The scheduler only reaches persist()
    // after fetch() resolves, so a run killed at MAX_RUN_MS used to write nothing
    // at all -- the worst cycles were the ones with no record. This writes the
    // partial funnel and the abort reason DIRECTLY (outside persist's
    // transaction, which will never run) and then rethrows, so the run is still
    // recorded as a failure rather than being quietly downgraded to a success.
    // The row is flagged aborted so it can never be mistaken for a complete one.
    try {
      return await runCycle(ctx);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      try {
        await ctx.db.query(
          `insert into group1_cycle_stats (ran_at, requests, watchlist_size, transfers_seen,
             venue_transfers, tokens_detected, tokens_eligible_age, tokens_with_buyer,
             tokens_alerted, tokens_suppressed, omitted_no_pair, duration_ms,
             phase_sweep_req, phase_transfer_req, phase_receipt_req,
             aborted, abort_reason, chunk_timeline, rpc_splits, rpc_retries)
           values (now(),$1,$2,$3,$4,$5,$6,$7,0,$8,0,$9,$10,$11,$12,true,$13,$14,$15,$16)`,
          [ABORT.phases().total, ABORT.watchlistSize, ABORT.transfers, ABORT.venueTransfers,
           ABORT.tokensDetected, ABORT.tokensEligibleAge, ABORT.tokensWithBuyer,
           ABORT.tokensSuppressed, ABORT.durationMs(), ABORT.phases().sweep,
           ABORT.phases().transfers, ABORT.receiptReq, msg.slice(0, 300),
           JSON.stringify(ABORT.chunks), ABORT.liveSplits(), ABORT.liveRetries()]);
        ctx.log.warn('cycle aborted; partial stats written',
        { reason: msg, ...ABORT.snapshot(), splits: ABORT.liveSplits(), retries: ABORT.liveRetries() });
      } catch (e2) {
        ctx.log.error('could not write aborted-cycle stats',
          { reason: msg, writeError: e2 instanceof Error ? e2.message : String(e2) });
      }
      throw err;
    }
  },

  async persist(ctx, client: PoolClient, records): Promise<number> {
    const r = records[0];
    if (!r) return 0;
    const chain = String(ctx.options.chain);

    // Shared, monitor-agnostic pool cache. Idempotent: least() on the block,
    // coalesce on pool_id, so a second writer never degrades it.
    for (let i = 0; i < r.pools.length; i += 500) {
      const b = r.pools.slice(i, i + 500);
      await client.query(
        `insert into token_pool_first (token, chain, created_block, created_at, older_than_sweep, pool_id)
         select * from unnest($1::text[], $2::text[], $3::bigint[], $4::timestamptz[], $5::boolean[], $6::text[])
         on conflict (token) do update set
           created_block = least(token_pool_first.created_block, excluded.created_block),
           created_at = least(token_pool_first.created_at, excluded.created_at),
           older_than_sweep = false,
           pool_id = coalesce(token_pool_first.pool_id, excluded.pool_id)`,
        [b.map((p) => p.token), b.map(() => chain), b.map((p) => p.block),
         b.map((p) => p.at), b.map(() => false), b.map((p) => p.poolId)]);
    }

    const sendAlerts = ctx.options.send_alerts !== false;

    // The pool this monitor chose. NO COALESCE: a better-evidenced pool always
    // replaces the stored one. token_pool_first is untouched.
    if (r.picks.length && sendAlerts) {
      for (const p of r.picks) {
        await client.query(
          `insert into group1_token_pool (token, chain, pool_id, source, n_transfers, updated_at)
           values ($1,$2,$3,$4,$5, now())
           on conflict (token, chain) do update set
             pool_id = excluded.pool_id, source = excluded.source,
             n_transfers = excluded.n_transfers, updated_at = now()`,
          [p.token, p.chain, p.poolId, p.source, p.transfers]);
      }
    }

    // ONLY WHAT WAS ACTUALLY SENT raises the high-water mark. A token whose line
    // was omitted for want of a pair must keep its old high, or it would be
    // suppressed at a count it was never announced at.
    let n = 0;
    if (r.alerted.length && sendAlerts) {
      for (const a of r.alerted) {
        const res = await client.query(
          `insert into group1_token_alerts
             (token, chain, last_alerted_count, last_alerted_at, first_alerted_at)
           values ($1,$2,$3, now(), now())
           on conflict (token, chain) do update set
             last_alerted_count = excluded.last_alerted_count,
             last_alerted_at = now()`,
          [a.token, a.chain, a.count]);
        n += res.rowCount ?? 0;
      }
    }

    await client.query(
      `insert into group1_new_token_cursor (chain, last_swept_block) values ($1, $2)
       on conflict (chain) do update set last_swept_block = excluded.last_swept_block`,
      [chain, r.sweptTo]);

    const s = r.stats;
    await client.query(
      `insert into group1_cycle_stats (ran_at, head_block, block_seconds, requests,
         watchlist_size, transfers_seen, venue_transfers, tokens_detected,
         tokens_eligible_age, tokens_with_buyer, tokens_alerted, tokens_suppressed,
         omitted_no_pool_id, omitted_no_pair, duplicate_symbols, linked_from_swap,
         linked_from_fallback, multi_poolid_tokens, ambiguous_receipts,
         extra_rpc_requests, admitted_by_grace, receipt_rate_limited, truncated_tokens,
         truncations, phase_sweep_req, phase_transfer_req, phase_receipt_req, aborted,
         chunk_timeline, rpc_splits, rpc_retries,
         swept_from, swept_to, duration_ms, message_text)
       values (now(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,false,$27,$28,$29,$30,$31,$32,$33)`,
      [s.head, s.blockSeconds, s.requests, s.watchlistSize, s.transfers, s.venueTransfers,
       s.tokensDetected, s.tokensEligibleAge, s.tokensWithBuyer, s.tokensAlerted,
       s.tokensSuppressed, s.omittedNoPoolId, s.omittedNoPair, s.duplicateSymbols,
       s.linkedFromSwap, s.linkedFromFallback, s.multiPoolIdTokens, s.ambiguousReceipts,
       s.extraRpcRequests, s.admittedByGrace, s.receiptRateLimited, s.truncatedTokens,
       JSON.stringify(r.truncations), s.phaseSweepReq, s.phaseTransferReq, s.phaseReceiptReq,
       JSON.stringify(r.chunks), s.rpcSplits, s.rpcRetries,
       r.sweptFrom, r.sweptTo, s.durationMs, r.messageText || null]);

    if (r.parts.length && sendAlerts) {
      for (const p of r.parts)
        ctx.queueAlert({ level: 'warning', title: 'Group 1 new-token buys', description: p });
      ctx.log.info('queued alert parts', { parts: r.parts.length });
    } else if (r.parts.length) {
      ctx.log.info('send_alerts is false; rendered but not queued', { parts: r.parts.length });
    } else {
      ctx.log.info('nothing to alert this cycle');
    }
    return n;
  },
};
export default adapter;
