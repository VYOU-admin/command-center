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
import { buildMarks, parseEarlyConfig, type EarlyConfig } from './pumpfun-early/config.js';
import { SCHEMA } from './pumpfun-early/schema.js';
import { TradeStream } from './pumpfun-early/trades.js';
import { Tracker, type Resolution, type Snapshot, type TrackedToken } from './pumpfun-early/tracker.js';
import { LaunchFeed, SolPrice, enrichGraduates, fetchSocials } from './pumpfun-early/feeds.js';
import { renderEarlyWindowPanel } from '../web/early-window-panel.js';

/** Long enough for the sockets to open before a missing connection is a fault. */
const CONNECT_GRACE_SECONDS = 90;

interface Runtime {
  cfg: EarlyConfig;
  tracker: Tracker;
  trades: TradeStream;
  feed: LaunchFeed;
  solPrice: SolPrice;
  /** Tokens newly adopted, awaiting their row in early_tokens. */
  pendingTokens: TrackedToken[];
  pendingSnapshots: Snapshot[];
  pendingResolutions: Resolution[];
  socialsQueue: TrackedToken[];
  socialsInFlight: number;
  lastDexRefresh: number;
  timer: NodeJS.Timeout | null;
}

const runtimes = new Map<string, Runtime>();

function start(ctx: AdapterContext, cfg: EarlyConfig): Runtime {
  const existing = runtimes.get(ctx.monitorId);
  if (existing) return existing;

  const marks = buildMarks(cfg);
  const tracker = new Tracker(cfg, marks, ctx.log);
  const solPrice = new SolPrice(cfg, ctx.log);

  const rt: Runtime = {
    cfg,
    tracker,
    solPrice,
    pendingTokens: [],
    pendingSnapshots: [],
    pendingResolutions: [],
    socialsQueue: [],
    socialsInFlight: 0,
    lastDexRefresh: 0,
    timer: null,
    trades: null as unknown as TradeStream,
    feed: null as unknown as LaunchFeed,
  };

  rt.feed = new LaunchFeed(cfg.pumpportalUrl, ctx.log, {
    onLaunch: (info) => {
      const adopted = tracker.noteLaunch(info);
      if (adopted) {
        rt.pendingTokens.push(adopted);
        if (adopted.uri) rt.socialsQueue.push(adopted);
      }
    },
    onGraduation: (mint, at) => {
      const adopted = tracker.noteGraduation(mint, at);
      // A graduate adopted here was not previously tracked, so it still needs
      // its row; one already tracked just had its outcome updated in place.
      if (adopted && adopted.sampleReason === 'graduate' && adopted.nextMarkIndex === 0) {
        if (!rt.pendingTokens.includes(adopted)) rt.pendingTokens.push(adopted);
        if (adopted.uri) rt.socialsQueue.push(adopted);
      }
    },
  });

  rt.trades = new TradeStream(cfg.rpcUrl, cfg.programId, ctx.log, (trade) =>
    tracker.applyTrade(trade),
  );

  rt.feed.start();
  rt.trades.start();

  // Snapshots are emitted on their own clock, not on the drain schedule: a mark
  // at 15s cannot wait for a drain that runs every 30s.
  const tick = setInterval(() => {
    const { snapshots, resolved } = tracker.collect(Date.now(), solPrice.current);
    if (snapshots.length) rt.pendingSnapshots.push(...snapshots);
    if (resolved.length) rt.pendingResolutions.push(...resolved);
    pumpSocials(rt, ctx);
  }, 1000);
  tick.unref();
  rt.timer = tick;

  runtimes.set(ctx.monitorId, rt);
  ctx.log.info('early-window monitor started', {
    sample_rate: cfg.sampleRate,
    window_minutes: cfg.windowMinutes,
    marks: marks.length,
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
       post_graduation, dex_liquidity_usd, dex_volume_24h, dex_txns_24h, dex_price_usd
     )
     select $1, * from unnest(
       $2::text[], $3::timestamptz[], $4::numeric[],
       $5::numeric[], $6::numeric[], $7::numeric[], $8::numeric[],
       $9::numeric[], $10::numeric[], $11::numeric[], $12::numeric[], $13::numeric[],
       $14::int[], $15::int[], $16::int[], $17::numeric[], $18::numeric[],
       $19::int[], $20::int[], $21::numeric[],
       $22::boolean[], $23::numeric[], $24::numeric[], $25::int[], $26::numeric[]
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
    ],
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
       snapshot_count = u.snapshot_count
     from unnest($2::text[], $3::boolean[], $4::timestamptz[], $5::text[], $6::int[])
            as u(mint, died, died_at, stop_reason, snapshot_count)
     where t.monitor_id = $1 and t.mint = u.mint`,
    [
      monitorId,
      rows.map((r) => r.mint),
      rows.map((r) => r.died),
      rows.map((r) => r.diedAt),
      rows.map((r) => r.stopReason),
      rows.map((r) => r.snapshotCount),
    ],
  );
}

/* ---------------------------------------------------------------- adapter */

interface Drain {
  tokens: TrackedToken[];
  snapshots: Snapshot[];
  resolutions: Resolution[];
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

    const drain: Drain = {
      tokens: rt.pendingTokens,
      snapshots: rt.pendingSnapshots,
      resolutions: rt.pendingResolutions,
    };
    rt.pendingTokens = [];
    rt.pendingSnapshots = [];
    rt.pendingResolutions = [];

    const streamStats = rt.trades.snapshotStats();
    const feedStats = rt.feed.drainCounters();
    const counters = rt.tracker.drainCounters();

    ctx.log.info('early window drained', {
      new_tokens: drain.tokens.length,
      snapshots: drain.snapshots.length,
      resolved: drain.resolutions.length,
      tracked_now: rt.tracker.size,
      sol_usd: rt.solPrice.current,
      launches_seen: feedStats.launches,
      migrations_seen: feedStats.migrations,
      ...streamStats,
      ...counters,
    });

    if (counters.deniedByCap > 0) {
      ctx.log.warn('tokens not tracked: concurrency cap reached', {
        denied: counters.deniedByCap,
        cap: cfg.maxConcurrentTracked,
      });
    }
    if (counters.snapshotsDropped > 0) {
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
          `launches=${rt.feed.connected ? 'up' : 'down'}]`,
      );
    }
    if (!streamStats.connected && silentFor > CONNECT_GRACE_SECONDS) {
      throw new Error('trade stream is not connected');
    }

    return [drain];
  },

  async persist(ctx, client, drains) {
    const drain = drains[0];
    if (!drain) return 0;

    // Tokens first: a snapshot has no row to belong to otherwise.
    const tokens = await writeTokens(client, ctx.monitorId, dedupe(drain.tokens));
    const snapshots = await writeSnapshots(client, ctx.monitorId, drain.snapshots);
    await writeResolutions(client, ctx.monitorId, drain.resolutions);

    return tokens + snapshots;
  },

  async shutdown() {
    for (const rt of runtimes.values()) {
      if (rt.timer) clearInterval(rt.timer);
      await rt.trades.stop();
      await rt.feed.stop();
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
