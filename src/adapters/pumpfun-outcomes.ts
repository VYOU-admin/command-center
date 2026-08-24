/**
 * pump.fun outcome reconciliation, deployer statistics, and retention.
 *
 * Split from the launch stream on purpose. The stream is latency-critical and
 * runs every 30 seconds; this is a slow maintenance pass with entirely different
 * failure modes. Keeping them as separate monitors means each has its own health
 * and its own staleness alert — if outcome tracking wedges, that fails loudly
 * instead of hiding behind a healthy-looking stream.
 *
 * The deployer table is the one signal here that needs no low latency at all,
 * which is exactly why it is the most trustworthy thing this monitor produces.
 */

import type { AdapterContext, PanelContext, SourceAdapter } from './types.js';
import type { PoolClient } from '../store/db.js';
import { parseOutcomeConfig, type OutcomeConfig } from './pumpfun/config.js';
import { SCHEMA } from './pumpfun/schema.js';
import { renderDeployerPanel } from '../web/pumpfun-panel.js';

interface MaintenanceResult {
  cfg: OutcomeConfig;
  counts: Record<string, number>;
}

/**
 * Resolve pending tokens.
 *
 * Two different rules, because the evidence differs. An instrumented token has
 * a curve we were watching, so silence on that curve is the signal. A token we
 * never instrumented has no curve history at all — but the migration feed is
 * platform-wide, so never having seen a graduation for it is itself conclusive
 * once enough time has passed.
 */
async function markDead(
  client: PoolClient,
  monitorId: string,
  cfg: OutcomeConfig,
): Promise<number> {
  const res = await client.query(
    `update pump_launches set outcome = 'dead', died_at = now()
      where monitor_id = $1
        and outcome = 'pending'
        and mint in (
          select mint from pump_launches
           where monitor_id = $1 and outcome = 'pending'
             and (
               (instrumented
                  and coalesce(last_moved_at, launched_at) < now() - ($2 || ' minutes')::interval)
               or
               (not instrumented and launched_at < now() - ($3 || ' hours')::interval)
             )
           limit $4
        )`,
    [monitorId, cfg.deathAfterIdleMinutes, cfg.unobservedDeathAfterHours, cfg.maxRowsPerPass],
  );
  return res.rowCount ?? 0;
}

/**
 * Collapse raw per-trade samples into the features that survive retention.
 * Computed once a token has resolved, so the curve is final.
 */
async function computeVelocitySummaries(
  client: PoolClient,
  monitorId: string,
  cfg: OutcomeConfig,
): Promise<number> {
  const res = await client.query(
    `with cand as (
       select l.mint
         from pump_launches l
        where l.monitor_id = $1
          and l.instrumented
          and l.outcome <> 'pending'
          and l.sample_count > 0
          and not exists (
            select 1 from pump_velocity_summary v
             where v.monitor_id = $1 and v.mint = l.mint
          )
        limit $3
     ),
     thr as (select unnest($2::numeric[]) as sol),
     crossed as (
       select s.mint, t.sol,
              min(s.trade_seq)   filter (where s.real_sol >= t.sol) as trades,
              min(s.age_seconds) filter (where s.real_sol >= t.sol) as seconds
         from pump_curve_samples s
         join cand c on c.mint = s.mint
        cross join thr t
        where s.monitor_id = $1
        group by s.mint, t.sol
     ),
     totals as (
       select s.mint,
              max(s.real_sol)  as peak_sol,
              max(s.trade_seq) as total_trades
         from pump_curve_samples s
         join cand c on c.mint = s.mint
        where s.monitor_id = $1
        group by s.mint
     )
     insert into pump_velocity_summary
       (monitor_id, mint, thresholds, peak_sol, total_trades, sol_per_trade)
     select $1, t.mint,
            (select jsonb_agg(
                      jsonb_build_object('sol', c.sol, 'trades', c.trades, 'seconds', c.seconds)
                      order by c.sol)
               from crossed c where c.mint = t.mint),
            t.peak_sol, t.total_trades,
            t.peak_sol / nullif(t.total_trades, 0)
       from totals t
     on conflict (monitor_id, mint) do nothing`,
    [monitorId, cfg.velocityThresholdsSol, cfg.maxRowsPerPass],
  );
  return res.rowCount ?? 0;
}

/**
 * Retention. The asymmetry is the whole point: graduations are ~0.2% of rows,
 * so keeping them at full fidelity is nearly free, while the tokens that died
 * without ever moving are both the overwhelming bulk of the data and the least
 * informative per byte. Launch rows are never deleted here — they are the
 * denominator, and without them no base rate can be computed.
 */
async function pruneSamples(
  client: PoolClient,
  monitorId: string,
  cfg: OutcomeConfig,
): Promise<number> {
  const res = await client.query(
    `with victims as (
       select s.id
         from pump_curve_samples s
         join pump_launches l
           on l.monitor_id = s.monitor_id and l.mint = s.mint
        where s.monitor_id = $1
          -- Never prune a token whose features have not been extracted yet.
          and exists (
            select 1 from pump_velocity_summary v
             where v.monitor_id = s.monitor_id and v.mint = s.mint
          )
          and s.observed_at < now() - (
                case
                  when l.outcome = 'graduated' then $2
                  when l.outcome = 'dead' and l.trade_count = 0 then $4
                  else $3
                end || ' days')::interval
        limit $5
     )
     delete from pump_curve_samples s using victims v where s.id = v.id`,
    [
      monitorId,
      cfg.graduateSampleRetentionDays,
      cfg.rawSampleRetentionDays,
      cfg.deadSampleRetentionDays,
      cfg.maxRowsPerPass,
    ],
  );

  if ((res.rowCount ?? 0) > 0) {
    await client.query(
      `update pump_launches l set samples_pruned = true
        where l.monitor_id = $1 and not l.samples_pruned and l.sample_count > 0
          and exists (select 1 from pump_velocity_summary v
                       where v.monitor_id = l.monitor_id and v.mint = l.mint)
          and not exists (select 1 from pump_curve_samples s
                           where s.monitor_id = l.monitor_id and s.mint = l.mint)`,
      [monitorId],
    );
  }
  return res.rowCount ?? 0;
}

/** Rebuild the deployer table from resolved launches. */
async function rebuildDeployerStats(client: PoolClient, monitorId: string): Promise<number> {
  const res = await client.query(
    `insert into pump_deployer_stats
       (monitor_id, deployer, tokens_launched, graduations, deaths,
        graduation_rate, first_launch_at, last_launch_at, updated_at)
     select $1, deployer,
            count(*),
            count(*) filter (where outcome = 'graduated'),
            count(*) filter (where outcome = 'dead'),
            -- Rate over RESOLVED launches only. Dividing by everything would
            -- drag a deployer's rate down purely for having launched recently.
            case when count(*) filter (where outcome <> 'pending') > 0
                 then count(*) filter (where outcome = 'graduated')::numeric
                      / count(*) filter (where outcome <> 'pending')
            end,
            min(launched_at), max(launched_at), now()
       from pump_launches
      where monitor_id = $1 and deployer is not null and observed_from_launch
      group by deployer
     on conflict (monitor_id, deployer) do update set
       tokens_launched = excluded.tokens_launched,
       graduations     = excluded.graduations,
       deaths          = excluded.deaths,
       graduation_rate = excluded.graduation_rate,
       first_launch_at = excluded.first_launch_at,
       last_launch_at  = excluded.last_launch_at,
       updated_at      = excluded.updated_at`,
    [monitorId],
  );
  return res.rowCount ?? 0;
}

const adapter: SourceAdapter<MaintenanceResult> = {
  type: 'pumpfun-outcomes',

  validate(options, monitorId) {
    parseOutcomeConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx: AdapterContext) {
    // All the work is against our own tables, so it belongs in the persist
    // transaction rather than here. This just carries the parsed config across.
    return [{ cfg: parseOutcomeConfig(ctx.options, ctx.monitorId), counts: {} }];
  },

  async persist(ctx, client, results) {
    const job = results[0];
    if (!job) return 0;
    const { cfg } = job;
    const source = (ctx.options['launch_monitor_id'] as string) || ctx.monitorId;

    const marked = await markDead(client, source, cfg);
    const summarised = await computeVelocitySummaries(client, source, cfg);
    const pruned = await pruneSamples(client, source, cfg);
    const deployers = await rebuildDeployerStats(client, source);

    ctx.log.info('outcome maintenance complete', {
      launch_monitor: source,
      marked_dead: marked,
      velocity_summaries: summarised,
      samples_pruned: pruned,
      deployers_updated: deployers,
    });

    return marked + summarised + deployers;
  },

  async renderPanel(ctx: PanelContext) {
    return renderDeployerPanel(ctx);
  },
};

export default adapter;
