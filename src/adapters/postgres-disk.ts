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
 * THE VOLUME IS MEASURED, NOT CONFIGURED. This monitor previously divided by a
 * volume_gb constant in its own YAML. That constant said 5 GB against a volume
 * that is actually 50 GB, so it reported 212% full, latched at `critical`, and
 * could never alert again. After a cleanup it would have read under 1%. Both
 * numbers were wrong in the same way: they were arithmetic against a value we
 * wrote down ourselves, not a reading.
 *
 * Size AND usage now come from the Railway API, using the token Railway injects
 * into the container. If that read fails the run FAILS. It does not fall back to
 * a constant, because a plausible wrong percentage is worse than a monitor that
 * is visibly broken — the whole reason this defect survived a week.
 *
 * pg_database_size is still recorded, as context rather than as the measure. It
 * is not the same quantity: a 27 MB database has sat on a volume reporting
 * 14.4 GB used.
 */

import type { AdapterContext, SourceAdapter } from './types.js';
import { configNumber, section } from './types.js';
import type { PlatformInfo } from '../env.js';
import { SCHEMA } from './postgres-disk/schema.js';

interface DiskConfig {
  /** Which volume to read, when the project has more than one. */
  volumeName: string | null;
  warnPct: number;
  criticalPct: number;
  growthWindowHours: number;
  minSamplesForProjection: number;
  retentionDays: number;
}

const MB = 1024 * 1024;
const GB = 1024 * MB;

function parseConfig(options: Record<string, unknown>, ctx: string): DiskConfig {
  const t = section(options, 'thresholds');
  if (options.volume_gb !== undefined) {
    throw new Error(
      `${ctx}: options.volume_gb is no longer supported. The volume size is read ` +
        `from the Railway API; a constant here was the defect that made this monitor ` +
        `report 212% and stop alerting.`,
    );
  }
  const rawName = options.volume_name;
  const volumeName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
  const warnPct = configNumber(t, 'warn_pct', ctx, 70);
  const criticalPct = configNumber(t, 'critical_pct', ctx, 85);
  if (warnPct <= 0 || warnPct >= 100) throw new Error(`${ctx}: thresholds.warn_pct must be between 0 and 100`);
  if (criticalPct <= warnPct || criticalPct >= 100) {
    throw new Error(`${ctx}: thresholds.critical_pct must be above warn_pct and below 100`);
  }
  return {
    volumeName,
    warnPct,
    criticalPct,
    growthWindowHours: configNumber(options, 'growth_window_hours', ctx, 6),
    minSamplesForProjection: configNumber(options, 'min_samples_for_projection', ctx, 2),
    retentionDays: configNumber(options, 'sample_retention_days', ctx, 30),
  };
}


/**
 * The volume as the provider describes it.
 *
 * EVERY FAILURE THROWS. No default size, no cached previous value, no
 * substituted constant. A monitor whose whole job is to say how full a disk is
 * must not invent the denominator.
 */
interface VolumeReading {
  name: string;
  mountPath: string | null;
  sizeMB: number;
  usedMB: number;
}

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

const VOLUME_QUERY = `query($id:String!){ project(id:$id){ volumes{ edges{ node{ id name
  volumeInstances{ edges{ node{ sizeMB currentSizeMB mountPath state } } } } } } } }`;

async function readVolume(
  platform: PlatformInfo, want: string | null, signal: AbortSignal,
): Promise<VolumeReading> {
  if (!platform.apiToken) throw new Error('RAILWAY_API_TOKEN is not set; volume size cannot be read');
  if (!platform.projectId) throw new Error('RAILWAY_PROJECT_ID is not set; volume size cannot be read');

  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${platform.apiToken}` },
    body: JSON.stringify({ query: VOLUME_QUERY, variables: { id: platform.projectId } }),
  });
  if (!res.ok) throw new Error(`Railway API returned HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { project?: { volumes?: { edges?: { node: Record<string, unknown> }[] } } };
    errors?: { message?: string }[];
  };
  if (body.errors?.length) {
    throw new Error(`Railway API error: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  const nodes = (body.data?.project?.volumes?.edges ?? []).map((e) => e.node);
  if (nodes.length === 0) throw new Error('Railway API returned no volumes for this project');

  const matches = want ? nodes.filter((n) => String(n.name) === want) : nodes;
  if (matches.length === 0) {
    throw new Error(`no volume named "${want}"; found: ${nodes.map((n) => String(n.name)).join(', ')}`);
  }
  // AMBIGUITY IS AN ERROR, not a reason to pick the first one.
  if (matches.length > 1) {
    throw new Error(
      `project has ${matches.length} volumes (${matches.map((n) => String(n.name)).join(', ')}); ` +
        `set options.volume_name to choose one`,
    );
  }
  const node = matches[0]!;
  const inst = ((node.volumeInstances as { edges?: { node: Record<string, unknown> }[] } | undefined)
    ?.edges ?? []).map((e) => e.node)[0];
  if (!inst) throw new Error(`volume "${String(node.name)}" has no attached instance`);

  const sizeMB = Number(inst.sizeMB);
  const usedMB = Number(inst.currentSizeMB);
  // A missing field arrives as NaN. Reporting that as 0 would read as an empty
  // disk, which is the most dangerous possible wrong answer here.
  if (!Number.isFinite(sizeMB) || sizeMB <= 0) throw new Error('Railway API returned no usable sizeMB');
  if (!Number.isFinite(usedMB) || usedMB < 0) throw new Error('Railway API returned no usable currentSizeMB');

  return {
    name: String(node.name),
    mountPath: inst.mountPath == null ? null : String(inst.mountPath),
    sizeMB,
    usedMB,
  };
}

interface Reading {
  cfg: DiskConfig;
  volume: VolumeReading;
  volumeBytes: number;
  volumeUsedBytes: number;
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

    // The denominator AND the numerator come from the provider. Throws rather
    // than falling back, so a broken read is visible instead of plausible.
    const volume = await readVolume(ctx.platform, cfg.volumeName, ctx.signal);
    // The ratio is unit-independent, so it is computed from the MB figures as
    // returned rather than after a conversion whose base could be wrong.
    const usedPct = (volume.usedMB / volume.sizeMB) * 100;
    const volumeBytes = Math.round(volume.sizeMB * MB);
    const volumeUsedBytes = Math.round(volume.usedMB * MB);

    // Growth from the oldest sample inside the window, so a single spike does
    // not dominate and a resize does not have to be special-cased.
    const prev = await ctx.db.query<{ total_bytes: string; age_hours: string }>(
      `select coalesce(volume_used_bytes, total_bytes)::bigint as total_bytes,
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
      const delta = volumeUsedBytes - Number(row.total_bytes);
      // Too short a span turns measurement noise into a wild projection.
      if (spanHours >= 0.5) {
        sampleSpanHours = spanHours;
        growthPerDay = (delta / spanHours) * 24;
        if (growthPerDay > 0) {
          daysUntilFull = (volumeBytes - volumeUsedBytes) / growthPerDay;
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
      volume_name: volume.name,
      volume_used: fmtBytes(volumeUsedBytes),
      volume_size: fmtBytes(volumeBytes),
      db_only: fmtBytes(totalBytes),
      growth_per_day: growthPerDay === null ? null : fmtBytes(growthPerDay),
      days_until_full: daysUntilFull === null ? null : Number(daysUntilFull.toFixed(1)),
      level,
    });

    return [
      {
        cfg,
        volume,
        volumeBytes,
        volumeUsedBytes,
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
         (monitor_id, sampled_at, db_bytes, wal_bytes, total_bytes, volume_bytes,
          used_pct, volume_used_bytes, measured_from)
       values ($1, now(), $2, $3, $4, $5, $6, $7, $8)
       on conflict do nothing`,
      // bigint columns reject fractional values; round rather than trust the
      // source to always hand back whole bytes.
      [
        ctx.monitorId,
        Math.round(r.dbBytes),
        Math.round(r.walBytes),
        Math.round(r.totalBytes),
        Math.round(r.volumeBytes),
        r.usedPct.toFixed(3),
        Math.round(r.volumeUsedBytes),
        `railway-api:${r.volume.name}`,
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
      const headroom = r.volumeBytes - r.volumeUsedBytes;
      ctx.queueAlert({
        level: r.level === 'critical' ? 'critical' : 'warning',
        title:
          `Postgres volume ${r.usedPct.toFixed(1)}% full` +
          (r.daysUntilFull !== null ? ` — ${fmtDays(r.daysUntilFull)} left` : ''),
        description:
          `${fmtBytes(r.volumeUsedBytes)} of ${fmtBytes(r.volumeBytes)} used on volume ` +
          `\`${r.volume.name}\`, ` +
          `${fmtBytes(headroom)} free.\n` +
          (r.growthPerDay === null
            ? 'Growth not yet measurable — fewer than two samples 30 minutes apart.'
            : `Growing **${fmtBytes(r.growthPerDay)}/day** ` +
              `(measured over ${r.sampleSpanHours?.toFixed(1)}h).`),
        fields: [
          { name: 'Database', value: fmtBytes(r.dbBytes), inline: true },
          { name: 'Volume', value: fmtBytes(r.volumeBytes), inline: true },
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
