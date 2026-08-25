/**
 * pump.fun early-window monitor.
 *
 * Follows a sample of launches minute by minute for their first six hours, so
 * that "which early conditions precede a token going up" becomes a question the
 * data can answer. It collects and nothing else: no scoring, no filtering, no
 * alerting beyond the spine's own failure reporting.
 *
 * Three long-lived inputs, all held by the adapter and drained on a schedule,
 * the same shape as the other streaming monitor:
 *
 *   PumpPortal  subscribeNewToken  -> launches (deployer, uri, initial mcap)
 *               subscribeMigration -> graduations
 *   Solana RPC  logsSubscribe      -> every pump.fun trade, program-wide
 *
 * The program-wide subscription is the design decision worth knowing about.
 * Per-token subscriptions cap at 100 per connection and the RPC closes the
 * socket on the 101st, so following ~830 tokens would need 9-10 sockets and a
 * cliff if any over-subscribed. One program subscription has no cap, which is
 * what lets the sample rate be a storage decision rather than an RPC one.
 */

import type { AdapterContext, PanelContext, SourceAdapter } from './types.js';
import type { PoolClient } from '../store/db.js';
import { parseEarlyConfig, type EarlyConfig } from './pumpfun-early/config.js';
import { SCHEMA } from './pumpfun-early/schema.js';
import { TradeStream } from './pumpfun-early/trades.js';
import {
  Tracker,
  type Decision,
  type Resolution,
  type Snapshot,
  type TrackedToken,
} from './pumpfun-early/tracker.js';
import { SolPrice, enrichGraduates, fetchSocials } from './pumpfun-early/feeds.js';
import { renderEarlyWindowPanel } from '../web/early-window-panel.js';

/** Long enough for the sockets to open before a missing connection is a fault. */
const CONNECT_GRACE_SECONDS = 90;

interface Runtime {
  cfg: EarlyConfig;
  tracker: Tracker;
  trades: TradeStream;
  solPrice: SolPrice;
  /** Tokens newly adopted, awaiting their row in early_tokens. */
  pendingTokens: TrackedToken[];
  pendingSnapshots: Snapshot[];
  pendingResolutions: Resolution[];
  pendingDecisions: Decision[];
  socialsQueue: TrackedToken[];
  socialsInFlight: number;
  lastDexRefresh: number;
  /** When retention last ran. Maintenance is paced independently of the drain. */
  lastPrune: number;
  timer: NodeJS.Timeout | null;
}

const runtimes = new Map<string, Runtime>();

function start(ctx: AdapterContext, cfg: EarlyConfig): Runtime {
  const existing = runtimes.get(ctx.monitorId);
  if (existing) return existing;

  const tracker = new Tracker(cfg, ctx.log);
  const solPrice = new SolPrice(cfg, ctx.log);

  const rt: Runtime = {
    cfg,
    tracker,
    solPrice,
    pendingTokens: [],
    pendingSnapshots: [],
    pendingResolutions: [],
    pendingDecisions: [],
    socialsQueue: [],
    socialsInFlight: 0,
    lastDexRefresh: 0,
    lastPrune: 0,
    timer: null,
    trades: null as unknown as TradeStream,
  };

  // ONE subscription, one dependency. Launches, graduations and trades all
  // arrive as events on the same program-wide log subscription, so there is no
  // second feed to go silently dead — which is exactly what happened when this
  // monitor took launches from PumpPortal instead.
  rt.trades = new TradeStream(
    cfg.rpcUrl,
    cfg.programId,
    ctx.log,
    (trade) => tracker.applyTrade(trade),
    cfg.streamSilenceReconnectSeconds * 1000,
    {
      onCreate: (created) => {
        const adopted = tracker.noteLaunch({
          mint: created.mint,
          deployer: created.user,
          name: created.name,
          symbol: created.symbol,
          uri: created.uri,
          bondingCurve: created.bondingCurve,
          pool: 'pump',
          signature: null,
          launchedAt: new Date(),
          // The creation instant, BEFORE the deployer's own opening buy. That
          // buy arrives moments later as an ordinary trade on this stream and
          // is measured there rather than folded into the starting value.
          initialMcapSol: created.mcapSol,
          initialVSol: created.virtualSol,
        });
        if (adopted) {
          rt.pendingTokens.push(adopted);
          if (adopted.uri) rt.socialsQueue.push(adopted);
        }
      },
      // A graduate is never adopted here — every launch is already tracked from
      // t=0, so it already holds genuine early snapshots. This only extends its
      // window to six hours from graduation and records the outcome.
      onMigration: (mint) => {
        tracker.noteGraduation(mint, new Date());
      },
    },
  );

  rt.trades.start();

  // Snapshots are emitted on their own clock, not on the drain schedule: a mark
  // at 15s cannot wait for a drain that runs every 30s.
  const tick = setInterval(() => {
    const { snapshots, resolved, decided } = tracker.collect(Date.now(), solPrice.current);
    if (snapshots.length) rt.pendingSnapshots.push(...snapshots);
    if (resolved.length) rt.pendingResolutions.push(...resolved);
    if (decided.length) rt.pendingDecisions.push(...decided);
    pumpSocials(rt, ctx);
  }, 1000);
  tick.unref();
  rt.timer = tick;

  runtimes.set(ctx.monitorId, rt);
  ctx.log.info('early-window monitor started', {
    tracking: 'every launch from t=0',
    decision_seconds: cfg.decisionSeconds,
    activity_floor_sol: cfg.activityFloorSol,
    control_rate: cfg.controlRate,
    window_minutes: cfg.windowMinutes,
    outcome_marks: cfg.outcomeMarks,
    max_concurrent: cfg.maxConcurrentTracked,
  });
  return rt;
}

function pumpSocials(rt: Runtime, ctx: AdapterContext): void {
  while (rt.socialsInFlight < rt.cfg.metadataConcurrency && rt.socialsQueue.length > 0) {
    const token = rt.socialsQueue.shift()!;
    rt.socialsInFlight++;
    void fetchSocials(token, rt.cfg, ctx.signal).finally(() => {
      rt.socialsInFlight--;
    });
  }
}

/* ---------------------------------------------------------------- persist */

async function writeTokens(
  client: PoolClient,
  monitorId: string,
  tokens: TrackedToken[],
): Promise<number> {
  if (tokens.length === 0) return 0;
  const res = await client.query(
    `insert into early_tokens (
       monitor_id, mint, deployer, name, symbol, uri, bonding_curve, pool, signature,
       launched_at, initial_mcap_sol, initial_vsol, sample_reason,
       socials_fetched, has_telegram, has_twitter, has_website, website_is_self,
       graduated, graduated_at, tracking_ends_at
     )
     select $1, * from unnest(
       $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[],
       $10::timestamptz[], $11::numeric[], $12::numeric[], $13::text[],
       $14::boolean[], $15::boolean[], $16::boolean[], $17::boolean[], $18::boolean[],
       $19::boolean[], $20::timestamptz[], $21::timestamptz[]
     )
     on conflict (monitor_id, mint) do update set
       socials_fetched = excluded.socials_fetched or early_tokens.socials_fetched,
       has_telegram    = coalesce(excluded.has_telegram, early_tokens.has_telegram),
       has_twitter     = coalesce(excluded.has_twitter, early_tokens.has_twitter),
       has_website     = coalesce(excluded.has_website, early_tokens.has_website),
       website_is_self = coalesce(excluded.website_is_self, early_tokens.website_is_self),
       graduated       = early_tokens.graduated or excluded.graduated,
       graduated_at    = coalesce(early_tokens.graduated_at, excluded.graduated_at)`,
    [
      monitorId,
      tokens.map((t) => t.mint),
      tokens.map((t) => t.deployer),
      tokens.map((t) => t.name),
      tokens.map((t) => t.symbol),
      tokens.map((t) => t.uri),
      tokens.map((t) => t.bondingCurve),
      tokens.map((t) => t.pool),
      tokens.map((t) => t.signature),
      tokens.map((t) => t.launchedAt),
      tokens.map((t) => t.initialMcapSol),
      tokens.map((t) => t.initialVSol),
      tokens.map((t) => t.sampleReason),
      tokens.map((t) => t.socialsFetched),
      tokens.map((t) => t.hasTelegram),
      tokens.map((t) => t.hasTwitter),
      tokens.map((t) => t.hasWebsite),
      tokens.map((t) => t.websiteIsSelf),
      tokens.map((t) => t.graduated),
      tokens.map((t) => t.graduatedAt),
      tokens.map((t) => new Date(t.trackingEndsAt)),
    ],
  );
  return res.rowCount ?? 0;
}

async function writeSnapshots(
  client: PoolClient,
  monitorId: string,
  rows: Snapshot[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await client.query(
    `insert into early_snapshots (
       monitor_id, mint, snapshot_at, seconds_since_launch,
       curve_sol, virtual_sol, token_reserves, virtual_token_reserves,
       mcap_sol, price_sol, mcap_usd, price_usd, sol_usd,
       trades, buys, sells, buy_volume_sol, sell_volume_sol,
       unique_buyers, unique_sellers, largest_buy_sol,
       post_graduation, dex_liquidity_usd, dex_volume_24h, dex_txns_24h, dex_price_usd,
       price_source, price_usd_effective, has_market, phase, is_outcome_mark
     )
     select $1, * from unnest(
       $2::text[], $3::timestamptz[], $4::numeric[],
       $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[],
       $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[],
       $14::int[], $15::int[], $16::int[], $17::numeric[], $18::numeric[],
       $19::int[], $20::int[], $21::numeric[],
       $22::boolean[], $23::numeric[], $24::numeric[], $25::int[], $26::numeric[],
       $27::text[], $28::numeric[], $29::boolean[], $30::text[], $31::boolean[]
     )`,
    [
      monitorId,
      rows.map((r) => r.mint),
      rows.map((r) => r.snapshotAt),
      rows.map((r) => r.secondsSinceLaunch),
      rows.map((r) => r.curveSol),
      rows.map((r) => r.virtualSol),
      rows.map((r) => r.tokenReserves),
      rows.map((r) => r.virtualTokenReserves),
      rows.map((r) => r.mcapSol),
      rows.map((r) => r.priceSol),
      rows.map((r) => r.mcapUsd),
      rows.map((r) => r.priceUsd),
      rows.map((r) => r.solUsd),
      rows.map((r) => r.trades),
      rows.map((r) => r.buys),
      rows.map((r) => r.sells),
      rows.map((r) => r.buyVolumeSol),
      rows.map((r) => r.sellVolumeSol),
      rows.map((r) => r.uniqueBuyers),
      rows.map((r) => r.uniqueSellers),
      rows.map((r) => r.largestBuySol),
      rows.map((r) => r.postGraduation),
      rows.map((r) => r.dexLiquidityUsd),
      rows.map((r) => r.dexVolume24h),
      rows.map((r) => r.dexTxns24h),
      rows.map((r) => r.dexPriceUsd),
      rows.map((r) => r.priceSource),
      rows.map((r) => r.priceUsdEffective),
      rows.map((r) => r.hasMarket),
      rows.map((r) => r.phase),
      rows.map((r) => r.isOutcomeMark),
    ],
  );
  return res.rowCount ?? 0;
}

/**
 * Keep last_trade_at current for tokens that traded since the previous drain.
 * Bounded to those tokens rather than rewriting the whole tracked set.
 */
async function writeLastTradeAt(
  client: PoolClient,
  monitorId: string,
  rows: { mint: string; lastTradeAt: Date }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await client.query(
    `update early_tokens t set last_trade_at = u.last_trade_at
       from unnest($2::text[], $3::timestamptz[]) as u(mint, last_trade_at)
      where t.monitor_id = $1 and t.mint = u.mint`,
    [monitorId, rows.map((r) => r.mint), rows.map((r) => r.lastTradeAt)],
  );
  return res.rowCount ?? 0;
}

async function writeResolutions(
  client: PoolClient,
  monitorId: string,
  rows: Resolution[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `update early_tokens t set
       died = u.died, died_at = u.died_at,
       tracking_stopped_at = now(), stop_reason = u.stop_reason,
       snapshot_count = u.snapshot_count,
       keep_reason = u.keep_reason, decided_at = u.decided_at,
       curve_sol_at_decision = u.curve_sol_at_decision
     from unnest($2::text[], $3::boolean[], $4::timestamptz[], $5::text[], $6::int[],
                 $7::text[], $8::timestamptz[], $9::numeric[])
            as u(mint, died, died_at, stop_reason, snapshot_count,
                 keep_reason, decided_at, curve_sol_at_decision)
     where t.monitor_id = $1 and t.mint = u.mint`,
    [
      monitorId,
      rows.map((r) => r.mint),
      rows.map((r) => r.died),
      rows.map((r) => r.diedAt),
      rows.map((r) => r.stopReason),
      rows.map((r) => r.snapshotCount),
      rows.map((r) => r.keepReason),
      rows.map((r) => r.decidedAt),
      rows.map((r) => r.curveSolAtDecision),
    ],
  );
}

/**
 * The 10-minute decision, recorded when it is made. Written separately from the
 * resolution because six hours separate the two, and a restart in between would
 * otherwise leave no record of which arm the token was in.
 */
async function writeDecisions(
  client: PoolClient,
  monitorId: string,
  rows: Decision[],
): Promise<void> {
  if (rows.length === 0) return;
  await client.query(
    `update early_tokens t set
       keep_reason = u.keep_reason, decided_at = u.decided_at,
       curve_sol_at_decision = u.curve_sol_at_decision
     from unnest($2::text[], $3::text[], $4::timestamptz[], $5::numeric[])
            as u(mint, keep_reason, decided_at, curve_sol_at_decision)
     where t.monitor_id = $1 and t.mint = u.mint`,
    [
      monitorId,
      rows.map((r) => r.mint),
      rows.map((r) => r.keepReason),
      rows.map((r) => r.decidedAt),
      rows.map((r) => r.curveSolAtDecision),
    ],
  );
}

/**
 * Retention.
 *
 * At ~1.6M snapshots a day this table would otherwise grow without bound, so
 * older rows are collapsed the same way the pump.fun monitor collapses its
 * curve samples: keep the shape, drop the repetition.
 *
 * Three classes of row are never touched, because they are the analysis:
 *
 *   1. The first ten minutes. Every launch is recorded densely there, and that
 *      window is the entire feature set — it is the reason for the redesign.
 *   2. Outcome marks. They are the outcome variable, and they exist precisely
 *      so that a token going quiet cannot erase its own result.
 *   3. Rows where a trade actually happened (has_market), and the first row of
 *      every distinct price run. A price with a start and an end is a step
 *      function, so these reconstruct the series exactly rather than
 *      approximating it.
 *
 * What goes is the middle: repeated carried-forward prices between ten minutes
 * and six hours on tokens that had already stopped trading.
 *
 * WHY THIS IS BATCHED BY TOKEN. Finding carried-forward duplicates needs a
 * window function over each token's series, and a window function cannot stop
 * early — so a pass written against "every row older than N days" would sort
 * millions of rows on every run to delete a few thousand. Instead each pass
 * claims a bounded batch of tokens, collapses only their rows, and marks them
 * done. A token is examined exactly once in its life, so the cost of a pass is
 * fixed no matter how large the table grows.
 */
async function pruneSnapshots(
  client: PoolClient,
  monitorId: string,
  cfg: EarlyConfig,
): Promise<{ pruned: number; tokens: number }> {
  // Claim a batch. A token is due once it is older than the full-resolution
  // window; tracking has necessarily stopped by then, since the window is six
  // hours and the retention floor is days.
  const batch = await client.query<{ mint: string }>(
    `select mint from early_tokens
      where monitor_id = $1 and not snapshots_pruned
        and launched_at < now() - ($2 || ' days')::interval
      order by launched_at
      limit $3`,
    [monitorId, cfg.retentionFullDays, cfg.retentionBatchTokens],
  );
  const mints = batch.rows.map((r) => r.mint);
  if (mints.length === 0) return { pruned: 0, tokens: 0 };

  const result = await client.query(
    `with candidates as (
       select id, price_usd_effective, has_market,
              lag(price_usd_effective) over (
                partition by mint order by seconds_since_launch
              ) as prev_price
         from early_snapshots
        where monitor_id = $1 and mint = any($2::text[])
          and not is_outcome_mark
          and seconds_since_launch > $3
     ),
     doomed as (
       select id from candidates
        where has_market is not true
          and prev_price is not null
          and price_usd_effective is not distinct from prev_price
        limit $4
     )
     delete from early_snapshots s using doomed d where s.id = d.id`,
    [monitorId, mints, cfg.decisionSeconds, cfg.retentionMaxRowsPerPass],
  );

  // Mark the batch done regardless of how many rows it yielded — a token with
  // nothing to collapse is finished with too, and re-examining it every pass is
  // exactly the cost this design exists to avoid.
  await client.query(
    `update early_tokens set snapshots_pruned = true
      where monitor_id = $1 and mint = any($2::text[])`,
    [monitorId, mints],
  );

  return { pruned: result.rowCount ?? 0, tokens: mints.length };
}

/**
 * Retention, second tier: thin the dense early grid.
 *
 * WHY THIS EXISTS. The first tier collapses carried-forward duplicates between
 * ten minutes and six hours. Measured against the real table that is only ~17%
 * of the rows, while the dense sub-minute grid inside the first ten minutes is
 * ~80%. A policy that protects 80% of the volume cannot bound growth no matter
 * how its day threshold is tuned, which is exactly how a 500 MB volume filled
 * in ten hours at ~90,000 rows/hour.
 *
 * WHAT IS THINNED, AND ONLY THIS. A token qualifies only when every one of the
 * following is true, so the thinning can never touch a token that turned out to
 * matter:
 *
 *   - it was DROPPED at the ten-minute decision (decided, no keep_reason), so
 *     it is neither an activity keeper nor part of the random control arm
 *   - it never graduated
 *   - it never traded at all (last_trade_at is null, which the tracker only
 *     writes for tokens with at least one trade)
 *   - it never produced an alert
 *   - it is older than dense_purge_hours
 *
 * WHAT SURVIVES EVEN THEN — the protect list:
 *
 *   - the five-minute mark, the entry point every return is measured from
 *   - every outcome mark, the outcome variable itself
 *   - the first row of each distinct price run, so the series still
 *     reconstructs exactly as a step function rather than approximately
 *   - every row of every token that appears in early_alerts, without exception
 *
 * A token is examined once and marked, so a pass costs the same however large
 * the table grows.
 */
async function thinDenseGrid(
  client: PoolClient,
  monitorId: string,
  cfg: EarlyConfig,
): Promise<{ removed: number; tokens: number }> {
  const batch = await client.query<{ mint: string }>(
    `select t.mint from early_tokens t
      where t.monitor_id = $1
        and not t.dense_pruned
        and t.launched_at < now() - ($2 || ' hours')::interval
        and t.decided_at is not null
        and t.keep_reason is null
        and not t.graduated
        and t.last_trade_at is null
        and not exists (select 1 from early_alerts a where a.mint = t.mint)
      order by t.launched_at
      limit $3`,
    [monitorId, cfg.densePurgeHours, cfg.retentionBatchTokens],
  );
  const mints = batch.rows.map((r) => r.mint);
  if (mints.length === 0) return { removed: 0, tokens: 0 };

  const result = await client.query(
    `with candidates as (
       select id, seconds_since_launch, is_outcome_mark, price_usd_effective,
              lag(price_usd_effective) over (
                partition by mint order by seconds_since_launch
              ) as prev_price
         from early_snapshots
        where monitor_id = $1 and mint = any($2::text[])
     ),
     doomed as (
       select id from candidates
        where seconds_since_launch <> $3
          and not is_outcome_mark
          and prev_price is not null
          and price_usd_effective is not distinct from prev_price
     )
     delete from early_snapshots s using doomed d where s.id = d.id`,
    [monitorId, mints, cfg.fiveMinuteMarkSeconds],
  );

  await client.query(
    `update early_tokens set dense_pruned = true
      where monitor_id = $1 and mint = any($2::text[])`,
    [monitorId, mints],
  );

  return { removed: result.rowCount ?? 0, tokens: mints.length };
}

/* ---------------------------------------------------------------- adapter */

interface Drain {
  cfg: EarlyConfig;
  /** Whether this drain should also run a retention pass. Decided in fetch(),
   *  which owns the runtime clock; persist() must not reach for runtime state. */
  prune: boolean;
  tokens: TrackedToken[];
  snapshots: Snapshot[];
  resolutions: Resolution[];
  decisions: Decision[];
  traded: { mint: string; lastTradeAt: Date }[];
}

const adapter: SourceAdapter<Drain> = {
  type: 'pumpfun-early-window',

  validate(options, monitorId) {
    parseEarlyConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx) {
    const cfg = parseEarlyConfig(ctx.options, ctx.monitorId);
    const rt = start(ctx, cfg);

    const now = Date.now();
    if (rt.solPrice.due(now)) await rt.solPrice.refresh(ctx.signal);

    if (now - rt.lastDexRefresh >= cfg.dexRefreshSeconds * 1000) {
      rt.lastDexRefresh = now;
      const mints = rt.tracker.graduatedMints();
      if (mints.length > 0) {
        const updated = await enrichGraduates(mints, rt.tracker, cfg, ctx.log, ctx.signal);
        ctx.log.info('graduate enrichment', { requested: mints.length, updated });
      }
    }

    const pruneDue = now - rt.lastPrune >= cfg.retentionIntervalMinutes * 60_000;
    if (pruneDue) rt.lastPrune = now;

    const drain: Drain = {
      cfg,
      prune: pruneDue,
      tokens: rt.pendingTokens,
      snapshots: rt.pendingSnapshots,
      resolutions: rt.pendingResolutions,
      decisions: rt.pendingDecisions,
      traded: rt.tracker.tradedSincePersist(),
    };
    rt.pendingTokens = [];
    rt.pendingSnapshots = [];
    rt.pendingResolutions = [];
    rt.pendingDecisions = [];

    const streamStats = rt.trades.snapshotStats();
    const counters = rt.tracker.drainCounters();

    ctx.log.info('early window drained', {
      new_tokens: drain.tokens.length,
      snapshots: drain.snapshots.length,
      snapshots_with_market: drain.snapshots.filter((s) => s.hasMarket).length,
      resolved: drain.resolutions.length,
      decided: drain.decisions.length,
      tracked_now: rt.tracker.size,
      ...rt.tracker.phaseCounts(),
      sol_usd: rt.solPrice.current,
      launches_seen: streamStats.launches,
      migrations_seen: streamStats.migrations,
      ...streamStats,
      ...counters,
    });

    if ((counters.deniedByCap ?? 0) > 0) {
      ctx.log.warn('tokens not tracked: concurrency cap reached', {
        denied: counters.deniedByCap,
        cap: cfg.maxConcurrentTracked,
      });
    }
    if ((counters.snapshotsDropped ?? 0) > 0) {
      ctx.log.warn('snapshots dropped: buffer full', { dropped: counters.snapshotsDropped });
    }
    if (streamStats.undecodable > 0) {
      // Counted, never silently skipped: a rise here means the event layout moved.
      ctx.log.warn('trade events matched the discriminator but did not decode', {
        undecodable: streamStats.undecodable,
      });
    }

    // Connected-but-silent is the failure a liveness check alone would miss.
    const silentFor = rt.trades.silentForSeconds();
    if (silentFor > cfg.silenceFailAfterSeconds) {
      throw new Error(
        `no pump.fun trade events for ${Math.round(silentFor)}s ` +
          `(threshold ${cfg.silenceFailAfterSeconds}s) [trades=${streamStats.connected ? 'up' : 'down'} ` +
          `launches=${streamStats.launches}]`,
      );
    }
    if (!streamStats.connected && silentFor > CONNECT_GRACE_SECONDS) {
      throw new Error('trade stream is not connected');
    }

    // Launches now ride the trade subscription, so a socket fault shows up as
    // trade silence above and the watchdog reconnects on its own. This catches
    // the case a reconnect CANNOT fix: the stream delivering normally while
    // yielding no creates, which means pump.fun changed the event layout.
    const sinceLaunch = streamStats.secondsSinceLastLaunch;
    const launchReference = sinceLaunch ?? silentFor;
    if (launchReference > cfg.launchSilenceFailSeconds && streamStats.trades > 0) {
      throw new Error(
        `no pump.fun launches decoded for ${Math.round(launchReference)}s ` +
          `(threshold ${cfg.launchSilenceFailSeconds}s) while the stream delivered ` +
          `${streamStats.trades} trades — the CreateEvent layout has probably moved`,
      );
    }

    return [drain];
  },

  async persist(ctx, client, drains) {
    const drain = drains[0];
    if (!drain) return 0;

    // Tokens first: a snapshot has no row to belong to otherwise.
    const tokens = await writeTokens(client, ctx.monitorId, dedupe(drain.tokens));
    const snapshots = await writeSnapshots(client, ctx.monitorId, drain.snapshots);
    await writeLastTradeAt(client, ctx.monitorId, drain.traded);
    await writeDecisions(client, ctx.monitorId, drain.decisions);
    await writeResolutions(client, ctx.monitorId, drain.resolutions);

    // Paced: the drain runs every 30 seconds, maintenance does not need to.
    if (drain.prune) {
      const { pruned, tokens } = await pruneSnapshots(client, ctx.monitorId, drain.cfg);
      if (tokens > 0) ctx.log.info('snapshots pruned', { pruned, tokens_collapsed: tokens });

      const dense = await thinDenseGrid(client, ctx.monitorId, drain.cfg);
      if (dense.tokens > 0) {
        ctx.log.info('dense grid thinned', {
          rows_removed: dense.removed,
          tokens_thinned: dense.tokens,
          older_than_hours: drain.cfg.densePurgeHours,
        });
      }
    }

    return tokens + snapshots;
  },

  async shutdown() {
    for (const rt of runtimes.values()) {
      if (rt.timer) clearInterval(rt.timer);
      await rt.trades.stop();
    }
    runtimes.clear();
  },

  async renderPanel(ctx: PanelContext) {
    return renderEarlyWindowPanel(ctx);
  },
};

/** Postgres rejects an ON CONFLICT statement that targets one row twice. */
function dedupe(tokens: TrackedToken[]): TrackedToken[] {
  const byMint = new Map<string, TrackedToken>();
  for (const t of tokens) byMint.set(t.mint, t);
  return [...byMint.values()];
}

export default adapter;
