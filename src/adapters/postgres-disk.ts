/**
 * Postgres volume usage watch.
 *
 * WHY THIS EXISTS. The volume filled and every monitor stopped writing with
 * "could not extend file: No space left on device". Nothing saw it coming, and
 * nothing could have: the spine watches whether monitors run, not whether the
 * disk they write to has room. This closes that gap.
 *
 * It alerts at two thresholds and reports what is actually needed to act:
 * current size, measured growth rate, and projected days until full. A
 * percentage on its own does not tell you whether you have a week or an hour.
 *
 * Growth is measured from stored samples, never assumed. With fewer than two
 * samples spanning the minimum window the projection is reported as unknown
 * rather than guessed, because a wrong number here is worse than no number.
 *
 * POSTGRES CANNOT SEE ITS OWN VOLUME. pg_database_size reports the database,
 * not the filesystem, so the ceiling comes from configuration. If the volume is
 * resized, volume_gb in the YAML must be updated to match — otherwise this
 * monitor confidently describes a disk that no longer exists. That coupling is
 * the price of not requiring cloud-provider credentials here.
 */

import type { AdapterContext, SourceAdapter } from './types.js';
import { configNumber, section } from './types.js';
import { SCHEMA } from './postgres-disk/schema.js';

interface DiskConfig {
  volumeBytes: number;
  warnPct: number;
  criticalPct: number;
  growthWindowHours: number;
  minSamplesForProjection: number;
  retentionDays: number;
}

const GB = 1024 * 1024 * 1024;

function parseConfig(options: Record<string, unknown>, ctx: string): DiskConfig {
  const t = section(options, 'thresholds');
  const volumeGb = configNumber(options, 'volume_gb', ctx, 5);
  if (volumeGb <= 0) throw new Error(`${ctx}: options.volume_gb must be greater than 0`);
  const warnPct = configNumber(t, 'warn_pct', ctx, 70);
  const criticalPct = configNumber(t, 'critical_pct', ctx, 85);
  if (warnPct <= 0 || warnPct >= 100) throw new Error(`${ctx}: thresholds.warn_pct must be between 0 and 100`);
  if (criticalPct <= warnPct || criticalPct >= 100) {
    throw new Error(`${ctx}: thresholds.critical_pct must be above warn_pct and below 100`);
  }
  return {
    volumeBytes: Math.round(volumeGb * GB),
    warnPct,
    criticalPct,
    growthWindowHours: configNumber(options, 'growth_window_hours', ctx, 6),
    minSamplesForProjection: configNumber(options, 'min_samples_for_projection', ctx, 2),
    retentionDays: configNumber(options, 'sample_retention_days', ctx, 30),
  };
}

interface Reading {
  cfg: DiskConfig;
  dbBytes: number;
  walBytes: number;
  totalBytes: number;
  usedPct: number;
  /** Bytes/day, or null when there is not enough history to measure it. */
  growthPerDay: number | null;
  daysUntilFull: number | null;
  sampleSpanHours: number | null;
  level: 'ok' | 'warn' | 'critical';
  previousLevel: string;
  biggestTables: { name: string; bytes: number }[];
}

const fmtBytes = (b: number): string =>
  b >= GB ? `${(b / GB).toFixed(2)} GB` : `${(b / 1048576).toFixed(0)} MB`;

const fmtDays = (d: number | null): string => {
  if (d === null) return 'unknown';
  if (d < 1) return `${(d * 24).toFixed(1)} hours`;
  return `${d.toFixed(1)} days`;
};

const adapter: SourceAdapter<Reading> = {
  type: 'postgres-disk',

  validate(options, monitorId) {
    parseConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx: AdapterContext) {
    const cfg = parseConfig(ctx.options, ctx.monitorId);

    const sizes = await ctx.db.query<{ db_bytes: string; wal_bytes: string }>(
      `select pg_database_size(current_database())::bigint as db_bytes,
              coalesce((select sum(size) from pg_ls_waldir()), 0)::bigint as wal_bytes`,
    );
    const dbBytes = Number(sizes.rows[0]?.db_bytes ?? 0);
    const walBytes = Number(sizes.rows[0]?.wal_bytes ?? 0);
    const totalBytes = dbBytes + walBytes;
    const usedPct = (totalBytes / cfg.volumeBytes) * 100;

    // Growth from the oldest sample inside the window, so a single spike does
    // not dominate and a resize does not have to be special-cased.
    const prev = await ctx.db.query<{ total_bytes: string; age_hours: string }>(
      `select total_bytes::bigint,
              extract(epoch from (now() - sampled_at)) / 3600 as age_hours
         from disk_usage_samples
        where monitor_id = $1 and sampled_at > now() - ($2 || ' hours')::interval
        order by sampled_at
        limit 1`,
      [ctx.monitorId, cfg.growthWindowHours],
    );

    let growthPerDay: number | null = null;
    let daysUntilFull: number | null = null;
    let sampleSpanHours: number | null = null;
    const row = prev.rows[0];
    if (row) {
      const spanHours = Number(row.age_hours);
      const delta = totalBytes - Number(row.total_bytes);
      // Too short a span turns measurement noise into a wild projection.
      if (spanHours >= 0.5) {
        sampleSpanHours = spanHours;
        growthPerDay = (delta / spanHours) * 24;
        if (growthPerDay > 0) {
          daysUntilFull = (cfg.volumeBytes - totalBytes) / growthPerDay;
        }
      }
    }

    const state = await ctx.db.query<{ last_level: string }>(
      `select last_level from disk_alert_state where monitor_id = $1`,
      [ctx.monitorId],
    );
    const previousLevel = state.rows[0]?.last_level ?? 'ok';
    const level: Reading['level'] =
      usedPct >= cfg.criticalPct ? 'critical' : usedPct >= cfg.warnPct ? 'warn' : 'ok';

    const tables = await ctx.db.query<{ relname: string; bytes: string }>(
      `select c.relname, pg_total_relation_size(c.oid)::bigint as bytes
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'
        order by pg_total_relation_size(c.oid) desc
        limit 3`,
    );

    ctx.log.info('disk usage', {
      used_pct: Number(usedPct.toFixed(1)),
      total: fmtBytes(totalBytes),
      volume: fmtBytes(cfg.volumeBytes),
      growth_per_day: growthPerDay === null ? null : fmtBytes(growthPerDay),
      days_until_full: daysUntilFull === null ? null : Number(daysUntilFull.toFixed(1)),
      level,
    });

    return [
      {
        cfg,
        dbBytes,
        walBytes,
        totalBytes,
        usedPct,
        growthPerDay,
        daysUntilFull,
        sampleSpanHours,
        level,
        previousLevel,
        biggestTables: tables.rows.map((r) => ({ name: r.relname, bytes: Number(r.bytes) })),
      },
    ];
  },

  async persist(ctx, client, readings) {
    const r = readings[0];
    if (!r) return 0;

    await client.query(
      `insert into disk_usage_samples
         (monitor_id, sampled_at, db_bytes, wal_bytes, total_bytes, volume_bytes, used_pct)
       values ($1, now(), $2, $3, $4, $5, $6)
       on conflict do nothing`,
      // bigint columns reject fractional values; round rather than trust the
      // source to always hand back whole bytes.
      [
        ctx.monitorId,
        Math.round(r.dbBytes),
        Math.round(r.walBytes),
        Math.round(r.totalBytes),
        Math.round(r.cfg.volumeBytes),
        r.usedPct.toFixed(3),
      ],
    );

    // The history is the point of the table, but it is still a table on the
    // disk being watched: a watcher that grows without bound is a bad watcher.
    await client.query(
      `delete from disk_usage_samples
        where monitor_id = $1 and sampled_at < now() - ($2 || ' days')::interval`,
      [ctx.monitorId, r.cfg.retentionDays],
    );

    // Alert only when the level RISES. Crossing 70% says it once; reaching 85%
    // still says it again. Falling back below clears the state so a later
    // crossing is announced afresh.
    const rank = { ok: 0, warn: 1, critical: 2 } as const;
    const rose = rank[r.level] > (rank[r.previousLevel as keyof typeof rank] ?? 0);

    if (rose) {
      const headroom = r.cfg.volumeBytes - r.totalBytes;
      ctx.queueAlert({
        level: r.level === 'critical' ? 'critical' : 'warning',
        title:
          `Postgres volume ${r.usedPct.toFixed(1)}% full` +
          (r.daysUntilFull !== null ? ` — ${fmtDays(r.daysUntilFull)} left` : ''),
        description:
          `${fmtBytes(r.totalBytes)} of ${fmtBytes(r.cfg.volumeBytes)} used, ` +
          `${fmtBytes(headroom)} free.\n` +
          (r.growthPerDay === null
            ? 'Growth not yet measurable — fewer than two samples 30 minutes apart.'
            : `Growing **${fmtBytes(r.growthPerDay)}/day** ` +
              `(measured over ${r.sampleSpanHours?.toFixed(1)}h).`),
        fields: [
          { name: 'Database', value: fmtBytes(r.dbBytes), inline: true },
          { name: 'WAL', value: fmtBytes(r.walBytes), inline: true },
          { name: 'Free', value: fmtBytes(headroom), inline: true },
          {
            name: 'Projected full',
            value: r.daysUntilFull === null ? 'unknown' : fmtDays(r.daysUntilFull),
            inline: true,
          },
          {
            name: 'Largest tables',
            value:
              r.biggestTables.map((t) => `${t.name} ${fmtBytes(t.bytes)}`).join('\n') || '—',
            inline: false,
          },
        ],
      });
    }

    await client.query(
      `insert into disk_alert_state (monitor_id, last_level, last_alert_at, last_used_pct)
       values ($1, $2, case when $3 then now() else null end, $4)
       on conflict (monitor_id) do update set
         last_level    = excluded.last_level,
         last_used_pct = excluded.last_used_pct,
         last_alert_at = coalesce(excluded.last_alert_at, disk_alert_state.last_alert_at)`,
      [ctx.monitorId, r.level, rose, r.usedPct.toFixed(3)],
    );

    return 1;
  },
};

export default adapter;
