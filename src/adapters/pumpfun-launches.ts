/**
 * pump.fun launch stream.
 *
 * Architecturally this is the first monitor here that is not a poll. The source
 * is two persistent websockets, held open by `PumpFunStream`, and the scheduled
 * `fetch()` drains whatever they have buffered since the last run.
 *
 * Wrapping the stream in the existing adapter contract rather than teaching the
 * spine about long-lived connections was deliberate. The drain keeps scheduling,
 * the run registry, health, and failure/recovery alerting working exactly as
 * they do for a polled source: a drain that finds the socket dead or silent
 * throws, and `consecutive_failures` does the rest. The only spine change is an
 * optional `shutdown()` hook, so a Railway SIGTERM flushes the buffer instead of
 * dropping one drain interval's worth of launches.
 *
 * PURPOSE: this monitor exists to build a dataset, not a buy list. It ranks
 * nothing and alerts on nothing but its own failure.
 */

import type { AdapterContext, PanelContext, SourceAdapter } from './types.js';
import type { PoolClient } from '../store/db.js';
import { parseStreamConfig, type StreamConfig } from './pumpfun/config.js';
import { SCHEMA } from './pumpfun/schema.js';
import { PumpFunStream, type DrainResult } from './pumpfun/stream.js';
import { renderPumpFunPanel } from '../web/pumpfun-panel.js';

/**
 * Collapse repeats of the same mint within one batch, keeping the last.
 *
 * Postgres refuses an ON CONFLICT DO UPDATE whose statement targets the same
 * row twice — "command cannot affect row a second time" — and because the whole
 * drain is one transaction, that error discards the entire batch: every launch,
 * every migration, and every curve sample collected since the last drain.
 *
 * Duplicates are not hypothetical. A socket reconnect can replay events, and
 * this cost five batches in production before it was caught.
 */
function dedupeByMint<T extends { mint: string }>(rows: T[]): T[] {
  const byMint = new Map<string, T>();
  for (const row of rows) byMint.set(row.mint, row);
  return [...byMint.values()];
}

/**
 * One stream per monitor id. The adapter module is a singleton loaded once by
 * the registry, so the connection has to live beside it rather than inside a
 * run.
 */
const streams = new Map<string, PumpFunStream>();

/**
 * How long after start-up a not-yet-connected stream is still considered normal
 * rather than broken. Comfortably longer than one drain interval so a fresh
 * deploy never records a spurious first failure.
 */
const CONNECT_GRACE_SECONDS = 90;

function getStream(ctx: AdapterContext, cfg: StreamConfig): PumpFunStream {
  let stream = streams.get(ctx.monitorId);
  if (!stream) {
    stream = new PumpFunStream(cfg, ctx.log);
    streams.set(ctx.monitorId, stream);
    stream.start();
  }
  return stream;
}

/* ----------------------------------------------------------------- persist */

async function persistLaunches(
  client: PoolClient,
  monitorId: string,
  launches: DrainResult['launches'],
): Promise<number> {
  if (launches.length === 0) return 0;

  const result = await client.query(
    `insert into pump_launches (
       monitor_id, mint, deployer, name, symbol, uri, bonding_curve, pool, signature,
       launched_at, initial_buy_sol, initial_vsol, initial_mcap_sol,
       socials_fetched, has_twitter, has_telegram, has_website, website_is_self,
       instrumented, instrument_reason, observed_from_launch
     )
     select $1, * , true from unnest(
       $2::text[],  $3::text[],  $4::text[],  $5::text[],  $6::text[],
       $7::text[],  $8::text[],  $9::text[],  $10::timestamptz[],
       $11::numeric[], $12::numeric[], $13::numeric[],
       $14::boolean[], $15::boolean[], $16::boolean[], $17::boolean[], $18::boolean[],
       $19::boolean[], $20::text[]
     )
     on conflict (monitor_id, mint) do update set
       -- A stub row created by an early graduation gets its real t=0 features
       -- if the launch itself turns up later; otherwise the launch is a dupe
       -- and nothing should be overwritten.
       deployer          = coalesce(pump_launches.deployer, excluded.deployer),
       name              = coalesce(pump_launches.name, excluded.name),
       symbol            = coalesce(pump_launches.symbol, excluded.symbol),
       uri               = coalesce(pump_launches.uri, excluded.uri),
       bonding_curve     = coalesce(pump_launches.bonding_curve, excluded.bonding_curve),
       initial_mcap_sol  = coalesce(pump_launches.initial_mcap_sol, excluded.initial_mcap_sol),
       observed_from_launch = pump_launches.observed_from_launch or excluded.observed_from_launch
     returning (xmax = 0) as inserted`,
    [
      monitorId,
      launches.map((l) => l.mint),
      launches.map((l) => l.deployer),
      launches.map((l) => l.name),
      launches.map((l) => l.symbol),
      launches.map((l) => l.uri),
      launches.map((l) => l.bondingCurve),
      launches.map((l) => l.pool),
      launches.map((l) => l.signature),
      launches.map((l) => l.launchedAt),
      launches.map((l) => l.initialBuySol),
      launches.map((l) => l.initialVSol),
      launches.map((l) => l.initialMcapSol),
      launches.map((l) => l.socialsFetched),
      launches.map((l) => l.hasTwitter),
      launches.map((l) => l.hasTelegram),
      launches.map((l) => l.hasWebsite),
      launches.map((l) => l.websiteIsSelf),
      launches.map((l) => l.instrumented),
      launches.map((l) => l.instrumentReason),
    ],
  );

  return result.rows.filter((r: { inserted: boolean }) => r.inserted).length;
}

async function persistSamples(
  client: PoolClient,
  monitorId: string,
  samples: DrainResult['samples'],
): Promise<void> {
  if (samples.length === 0) return;

  await client.query(
    `insert into pump_curve_samples
       (monitor_id, mint, observed_at, trade_seq, age_seconds, real_sol, virtual_sol,
        price_sol, mcap_sol, complete)
     select $1, * from unnest(
       $2::text[], $3::timestamptz[], $4::int[], $5::numeric[],
       $6::numeric[], $7::numeric[], $8::numeric[], $9::numeric[], $10::boolean[]
     )`,
    [
      monitorId,
      samples.map((s) => s.mint),
      samples.map((s) => s.observedAt),
      samples.map((s) => s.tradeSeq),
      samples.map((s) => s.ageSeconds),
      samples.map((s) => s.realSol),
      samples.map((s) => s.virtualSol),
      samples.map((s) => s.priceSol),
      samples.map((s) => s.mcapSol),
      samples.map((s) => s.complete),
    ],
  );

  // Roll the batch into the launch row so the common questions ("how far did it
  // get", "how many trades did that take") need no join against the sample table.
  await client.query(
    `with agg as (
       select mint,
              max(trade_seq)                                   as max_seq,
              count(*)                                         as n,
              max(real_sol)                                    as peak_sol,
              max(observed_at)                                 as last_at,
              (array_agg(real_sol order by trade_seq desc))[1]  as last_sol,
              (array_agg(real_sol order by trade_seq asc))[1]   as first_sol,
              bool_or(complete)                                as graduated
         from unnest($2::text[], $3::int[], $4::numeric[], $5::timestamptz[], $6::boolean[])
                as t(mint, trade_seq, real_sol, observed_at, complete)
        group by mint
     )
     update pump_launches l set
       first_sol     = coalesce(l.first_sol, agg.first_sol),
       peak_sol      = greatest(coalesce(l.peak_sol, 0), agg.peak_sol),
       last_sol      = agg.last_sol,
       last_moved_at = greatest(coalesce(l.last_moved_at, agg.last_at), agg.last_at),
       -- trade_seq is a per-token counter from the subscription slot, so the
       -- max is authoritative and re-running a drain cannot double-count.
       trade_count   = greatest(l.trade_count, agg.max_seq),
       sample_count  = l.sample_count + agg.n,
       outcome       = case when agg.graduated then 'graduated' else l.outcome end,
       graduated_at  = case when agg.graduated then coalesce(l.graduated_at, agg.last_at) else l.graduated_at end
     from agg
      where l.monitor_id = $1 and l.mint = agg.mint`,
    [
      monitorId,
      samples.map((s) => s.mint),
      samples.map((s) => s.tradeSeq),
      samples.map((s) => s.realSol),
      samples.map((s) => s.observedAt),
      samples.map((s) => s.complete),
    ],
  );
}

async function persistMigrations(
  client: PoolClient,
  monitorId: string,
  migrations: DrainResult['migrations'],
): Promise<void> {
  if (migrations.length === 0) return;

  // A graduation can arrive for a token that launched before this monitor was
  // running. That outcome is still worth recording — it is what monitor #2
  // draws its universe from — so a stub row is created and flagged as having no
  // trustworthy t=0 features.
  await client.query(
    `insert into pump_launches (monitor_id, mint, pool, signature, outcome, graduated_at, observed_from_launch)
     select $1, t.mint, t.pool, t.signature, 'graduated', t.observed_at, false
       from unnest($2::text[], $3::text[], $4::text[], $5::timestamptz[])
              as t(mint, pool, signature, observed_at)
     on conflict (monitor_id, mint) do update set
       outcome      = 'graduated',
       graduated_at = coalesce(pump_launches.graduated_at, excluded.graduated_at),
       died_at      = null`,
    [
      monitorId,
      migrations.map((m) => m.mint),
      migrations.map((m) => m.pool),
      migrations.map((m) => m.signature),
      migrations.map((m) => m.observedAt),
    ],
  );
}

/* ----------------------------------------------------------------- adapter */

const adapter: SourceAdapter<DrainResult> = {
  type: 'pumpfun-launches',

  validate(options, monitorId) {
    parseStreamConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx) {
    const cfg = parseStreamConfig(ctx.options, ctx.monitorId);
    const stream = getStream(ctx, cfg);

    const result = stream.drain();

    ctx.log.info('stream drained', {
      launches: result.launches.length,
      migrations: result.migrations.length,
      curve_samples: result.samples.length,
      ...result.stats,
    });

    if (result.stats.droppedEvents > 0) {
      // Never let a dropped event be invisible: a silently truncated dataset is
      // worse than a smaller one, because nothing downstream can tell.
      ctx.log.warn('buffer overflow, events dropped', {
        dropped: result.stats.droppedEvents,
        hint: 'raise limits.max_buffered_events or shorten the schedule',
      });
    }
    if (result.stats.slotsDenied > 0) {
      ctx.log.warn('curve subscription slots exhausted', {
        denied: result.stats.slotsDenied,
        active: result.stats.activeSubscriptions,
        hint: 'shorten sampling.dense_window_minutes or lower sampling.control_sample_rate',
      });
    }

    // Connected-but-silent is the failure this would otherwise miss entirely.
    stream.assertHealthy();

    // A hard connection failure is reported faster than the silence threshold,
    // but only once the stream has had a fair chance to open its sockets: the
    // scheduler ticks the instant the process boots, so the very first drain of
    // every deploy runs while the connection is still being established.
    if (
      !result.stats.pumpportalConnected &&
      result.launches.length === 0 &&
      !stream.isWarmingUp(CONNECT_GRACE_SECONDS)
    ) {
      throw new Error('pumpportal socket is not connected and no events were buffered');
    }

    return [result];
  },

  async persist(ctx, client, results) {
    const result = results[0];
    if (!result) return 0;

    const launches = dedupeByMint(result.launches);
    const migrations = dedupeByMint(result.migrations);
    const droppedDupes =
      result.launches.length - launches.length + (result.migrations.length - migrations.length);
    if (droppedDupes > 0) {
      ctx.log.info('collapsed duplicate mints within batch', {
        dropped: droppedDupes,
        launches: result.launches.length,
        migrations: result.migrations.length,
      });
    }

    // Migrations first: a graduation stub must exist before samples try to roll
    // into it, and a launch arriving in the same batch then fills in its t=0.
    await persistMigrations(client, ctx.monitorId, migrations);
    const newLaunches = await persistLaunches(client, ctx.monitorId, launches);
    // Samples are append-only with no conflict target, so repeats are harmless
    // and are left alone.
    await persistSamples(client, ctx.monitorId, result.samples);

    return newLaunches;
  },

  async shutdown() {
    for (const stream of streams.values()) await stream.stop();
    streams.clear();
  },

  async renderPanel(ctx: PanelContext) {
    return renderPumpFunPanel(ctx);
  },
};

export default adapter;
