/**
 * pump.fun early-activity alert.
 *
 * This monitor COLLECTS NOTHING. It reads the snapshots pumpfun-early-window
 * already writes, and alerts when a token's five-minute snapshot clears an
 * activity filter. Keeping the two apart means the filter can be retuned, or
 * muted, without touching collection — the dataset stays intact regardless of
 * what the alerting does.
 *
 * EXACTLY ONCE, EVER. The alert is not sent and then recorded; it is recorded
 * and then sent. `early_alerts` has a primary key on (monitor_id, mint) and the
 * insert uses ON CONFLICT DO NOTHING, so only a row that was genuinely inserted
 * produces a message. A restart, an overlapping run, or the same snapshot being
 * re-read cannot produce a second alert. The spine dispatches queued alerts
 * after the persist transaction commits, so a Discord failure loses that one
 * message rather than replaying it — at most once, never twice.
 *
 * NO BACKLOG ON BOOT. Only snapshots that appear after the monitor starts are
 * considered. Without this, a deploy would fire one alert for every qualifying
 * token already sitting in the table.
 *
 * LATENCY. The alert can only be as fresh as the row it reads. Collection
 * drains on its own schedule, so a five-minute snapshot becomes visible some
 * seconds after the mark, and this monitor's own schedule adds its share on top.
 * `age_at_alert_seconds` is recorded on every row so the real end-to-end delay
 * is measurable from the data rather than assumed.
 */

import type { AdapterContext, SourceAdapter } from './types.js';
import type { PoolClient } from '../store/db.js';
import { configNumber, section } from './types.js';
import { SCHEMA } from './pumpfun-early-alert/schema.js';

interface AlertConfig {
  enabled: boolean;
  sourceMonitorId: string;
  markSeconds: number;
  minCurveSol: number;
  maxBuyShare: number;
  lookbackMinutes: number;
  maxPerRun: number;
  /** Unvalidated display-only ranges. They never gate an alert. */
  testCurveMin: number;
  testCurveMax: number;
  testSellBuyMax: number;
}

/** Per-monitor boot time, so a deploy never alerts on the existing backlog. */
const startedAt = new Map<string, Date>();

function parseConfig(options: Record<string, unknown>, ctx: string): AlertConfig {
  const t = section(options, 'trigger');
  const enabledRaw = options['enabled'];
  if (enabledRaw !== undefined && typeof enabledRaw !== 'boolean') {
    throw new Error(`${ctx}: options.enabled must be true or false`);
  }
  const source = options['source_monitor_id'];
  if (source !== undefined && typeof source !== 'string') {
    throw new Error(`${ctx}: options.source_monitor_id must be a string`);
  }
  const maxBuyShare = configNumber(t, 'max_buy_share', ctx, 0.7);
  if (maxBuyShare <= 0) {
    throw new Error(`${ctx}: trigger.max_buy_share must be greater than 0`);
  }
  const markSeconds = configNumber(t, 'mark_seconds', ctx, 300);
  if (markSeconds <= 0) {
    throw new Error(`${ctx}: trigger.mark_seconds must be greater than 0`);
  }
  return {
    enabled: enabledRaw ?? true,
    sourceMonitorId: source ?? 'pumpfun-early-window',
    markSeconds,
    minCurveSol: configNumber(t, 'min_curve_sol', ctx, 10),
    maxBuyShare,
    lookbackMinutes: configNumber(options, 'lookback_minutes', ctx, 30),
    maxPerRun: configNumber(options, 'max_alerts_per_run', ctx, 50),
    testCurveMin: configNumber(t, 'test_curve_min', ctx, 60),
    testCurveMax: configNumber(t, 'test_curve_max', ctx, 79),
    testSellBuyMax: configNumber(t, 'test_sell_buy_max', ctx, 0.5),
  };
}

interface Candidate {
  mint: string;
  name: string | null;
  symbol: string | null;
  launchedAt: Date;
  ageSeconds: number;
  curveSol: number;
  mcapUsd: number | null;
  priceUsd: number | null;
  trades: number;
  buys: number;
  sells: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  largestBuySol: number;
  largestBuyShare: number;
  /** sell_volume / buy_volume at the mark. Null when nothing was bought. */
  sellBuyRatio: number | null;
  hasTelegram: boolean | null;
  hasTwitter: boolean | null;
  hasWebsite: boolean | null;
}

interface Drain {
  cfg: AlertConfig;
  candidates: Candidate[];
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const nOrNull = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const fmtSol = (v: number): string =>
  v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(4);

const fmtUsd = (v: number | null): string => {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toFixed(2)}`;
};

const fmtPrice = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? '—' : `$${v.toPrecision(3)}`;

const fmtAge = (s: number): string => {
  const m = Math.floor(s / 60);
  const r = Math.round(s % 60);
  return `${m}m ${String(r).padStart(2, '0')}s`;
};

/**
 * Compact by design: these are read on a phone at roughly one a minute, so the
 * decision-relevant numbers go in inline fields and nothing is spelled out that
 * a glance can infer.
 */
function buildAlert(c: Candidate, cfg: AlertConfig) {
  const label = c.symbol?.trim() || c.name?.trim() || c.mint.slice(0, 8);
  const socials = [
    c.hasTelegram ? 'TG' : null,
    c.hasTwitter ? 'X' : null,
    c.hasWebsite ? 'web' : null,
  ].filter(Boolean);

  return {
    level: 'warning' as const,
    title: `${label} — ${fmtSol(c.curveSol)} SOL on the curve at 5m`,
    description:
      `\`${c.mint}\`\n` +
      `[DexScreener](https://dexscreener.com/solana/${c.mint})` +
      ` · ${fmtUsd(c.mcapUsd)} mcap · ${fmtPrice(c.priceUsd)}`,
    fields: [
      { name: 'Curve', value: `**${fmtSol(c.curveSol)}** SOL`, inline: true },
      {
        name: 'Largest buy',
        value: `${fmtSol(c.largestBuySol)} SOL (${(c.largestBuyShare * 100).toFixed(0)}%)`,
        inline: true,
      },
      { name: 'Age', value: fmtAge(c.ageSeconds), inline: true },
      {
        name: 'Trades',
        value: `${c.trades} (${c.buys}B / ${c.sells}S)`,
        inline: true,
      },
      {
        name: 'Wallets',
        value: `${c.uniqueBuyers} buy / ${c.uniqueSellers} sell`,
        inline: true,
      },
      {
        name: 'Volume',
        value: `${fmtSol(c.buyVolumeSol)} / ${fmtSol(c.sellVolumeSol)} SOL`,
        inline: true,
      },
      {
        name: 'Sell/buy',
        value: c.sellBuyRatio === null ? '—' : c.sellBuyRatio.toFixed(2),
        inline: true,
      },
      {
        name: 'Socials',
        value: socials.length ? socials.join(' · ') : 'none',
        inline: true,
      },
      // Visually separated and explicitly labelled. These ranges gate nothing
      // and have never been validated; presenting them like the measured
      // fields above would read as a recommendation, which they are not.
      {
        name: '\u200b',
        value: buildTestRanges(c, cfg),
        inline: false,
      },
    ],
  };
}

/**
 * The unvalidated test ranges, rendered as a fenced block so they read as a
 * scratchpad rather than as part of the measured data above.
 */
function buildTestRanges(c: Candidate, cfg: AlertConfig): string {
  const curveIn = c.curveSol >= cfg.testCurveMin && c.curveSol <= cfg.testCurveMax;
  const ratioIn = c.sellBuyRatio !== null && c.sellBuyRatio <= cfg.testSellBuyMax;
  const mark = (v: boolean): string => (v ? 'IN RANGE' : 'out');
  const ratioTxt = c.sellBuyRatio === null ? 'n/a (no buys)' : c.sellBuyRatio.toFixed(2);
  // Fixed-width label column so the two checks line up under each other; a
  // ragged block is harder to scan at a glance on a phone.
  const line = (label: string, value: string, ok: boolean): string =>
    `${label.padEnd(26)}${value.padStart(9)}  [${mark(ok)}]`;
  return (
    '⚠️ **TEST RANGES — unvalidated.** Not a signal; these gate nothing.\n' +
    '```\n' +
    line(`Curve at 5m ${cfg.testCurveMin}-${cfg.testCurveMax} SOL`, fmtSol(c.curveSol), curveIn) +
    '\n' +
    line(`Sell/buy ratio <= ${cfg.testSellBuyMax.toFixed(2)}`, ratioTxt, ratioIn) +
    '\n```'
  );
}

async function writeAndPick(
  client: PoolClient,
  monitorId: string,
  cfg: AlertConfig,
  rows: Candidate[],
): Promise<Set<string>> {
  const inserted = new Set<string>();
  if (rows.length === 0) return inserted;

  // Recorded first, sent second. Only a row that was actually inserted is
  // returned here, which is what makes the alert exactly-once.
  const res = await client.query<{ mint: string }>(
    `insert into early_alerts (
       monitor_id, mint, alerted_at, age_at_alert_seconds, name, symbol,
       curve_sol, mcap_usd, price_usd, trade_count, buy_count, sell_count,
       unique_buyers, unique_sellers, buy_volume_sol, sell_volume_sol,
       largest_buy_sol, largest_buy_share, has_telegram, has_twitter,
       has_website, min_curve_sol, max_buy_share,
       sell_buy_ratio, in_test_curve_range, in_test_sell_buy_range,
       test_curve_min, test_curve_max, test_sell_buy_max
     )
     select $1, * from unnest(
       $2::text[], $3::timestamptz[], $4::numeric[], $5::text[], $6::text[],
       $7::numeric[], $8::numeric[], $9::numeric[], $10::int[], $11::int[], $12::int[],
       $13::int[], $14::int[], $15::numeric[], $16::numeric[],
       $17::numeric[], $18::numeric[], $19::boolean[], $20::boolean[],
       $21::boolean[], $22::numeric[], $23::numeric[],
       $24::numeric[], $25::boolean[], $26::boolean[],
       $27::numeric[], $28::numeric[], $29::numeric[]
     )
     on conflict (monitor_id, mint) do nothing
     returning mint`,
    [
      monitorId,
      rows.map((r) => r.mint),
      rows.map(() => new Date()),
      rows.map((r) => r.ageSeconds),
      rows.map((r) => r.name),
      rows.map((r) => r.symbol),
      rows.map((r) => r.curveSol),
      rows.map((r) => r.mcapUsd),
      rows.map((r) => r.priceUsd),
      rows.map((r) => r.trades),
      rows.map((r) => r.buys),
      rows.map((r) => r.sells),
      rows.map((r) => r.uniqueBuyers),
      rows.map((r) => r.uniqueSellers),
      rows.map((r) => r.buyVolumeSol),
      rows.map((r) => r.sellVolumeSol),
      rows.map((r) => r.largestBuySol),
      rows.map((r) => r.largestBuyShare),
      rows.map((r) => r.hasTelegram),
      rows.map((r) => r.hasTwitter),
      rows.map((r) => r.hasWebsite),
      rows.map(() => cfg.minCurveSol),
      rows.map(() => cfg.maxBuyShare),
      rows.map((r) => r.sellBuyRatio),
      rows.map((r) => r.curveSol >= cfg.testCurveMin && r.curveSol <= cfg.testCurveMax),
      rows.map((r) => r.sellBuyRatio !== null && r.sellBuyRatio <= cfg.testSellBuyMax),
      rows.map(() => cfg.testCurveMin),
      rows.map(() => cfg.testCurveMax),
      rows.map(() => cfg.testSellBuyMax),
    ],
  );
  for (const row of res.rows) inserted.add(row.mint);
  return inserted;
}

const adapter: SourceAdapter<Drain> = {
  type: 'pumpfun-early-alert',

  validate(options, monitorId) {
    parseConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx: AdapterContext) {
    const cfg = parseConfig(ctx.options, ctx.monitorId);

    let boot = startedAt.get(ctx.monitorId);
    if (!boot) {
      boot = new Date();
      startedAt.set(ctx.monitorId, boot);
      ctx.log.info('early-alert monitor started', {
        alerting: cfg.enabled,
        source: cfg.sourceMonitorId,
        mark_seconds: cfg.markSeconds,
        min_curve_sol: cfg.minCurveSol,
        max_buy_share: cfg.maxBuyShare,
        note: 'only snapshots written after this moment are eligible',
      });
    }

    // The lookback bounds the scan; the boot time is what prevents a backlog.
    // Whichever is later wins, so a long outage does not replay old tokens.
    const since = new Date(
      Math.max(boot.getTime(), Date.now() - cfg.lookbackMinutes * 60_000),
    );

    const res = await ctx.db.query(
      `select s.mint, t.name, t.symbol, t.launched_at,
              extract(epoch from (now() - t.launched_at)) as age_seconds,
              s.curve_sol, s.mcap_usd, s.price_usd_effective,
              s.trades, s.buys, s.sells, s.unique_buyers, s.unique_sellers,
              s.buy_volume_sol, s.sell_volume_sol, s.largest_buy_sol,
              t.has_telegram, t.has_twitter, t.has_website
         from early_snapshots s
         join early_tokens t
           on t.monitor_id = s.monitor_id and t.mint = s.mint
        where s.monitor_id = $1
          and s.seconds_since_launch = $2
          and s.snapshot_at > $3
          and s.price_usd_effective is not null
          and s.curve_sol >= $4
          and coalesce(s.largest_buy_sol, 0) <= $5 * s.curve_sol
          and not exists (
            select 1 from early_alerts a
             where a.monitor_id = $6 and a.mint = s.mint
          )
        order by s.snapshot_at
        limit $7`,
      [
        cfg.sourceMonitorId,
        cfg.markSeconds,
        since,
        cfg.minCurveSol,
        cfg.maxBuyShare,
        ctx.monitorId,
        cfg.maxPerRun,
      ],
    );

    const candidates: Candidate[] = res.rows.map((r) => {
      const curveSol = n(r.curve_sol);
      const largestBuySol = n(r.largest_buy_sol);
      return {
        mint: String(r.mint),
        name: r.name === null || r.name === undefined ? null : String(r.name),
        symbol: r.symbol === null || r.symbol === undefined ? null : String(r.symbol),
        launchedAt: r.launched_at as Date,
        ageSeconds: n(r.age_seconds),
        curveSol,
        mcapUsd: nOrNull(r.mcap_usd),
        priceUsd: nOrNull(r.price_usd_effective),
        trades: n(r.trades),
        buys: n(r.buys),
        sells: n(r.sells),
        uniqueBuyers: n(r.unique_buyers),
        uniqueSellers: n(r.unique_sellers),
        buyVolumeSol: n(r.buy_volume_sol),
        sellVolumeSol: n(r.sell_volume_sol),
        largestBuySol,
        largestBuyShare: curveSol > 0 ? largestBuySol / curveSol : 0,
        // Null, not zero: "nothing was bought" and "nothing was sold" are
        // different facts and must not collapse into the same number.
        sellBuyRatio: n(r.buy_volume_sol) > 0 ? n(r.sell_volume_sol) / n(r.buy_volume_sol) : null,
        hasTelegram: (r.has_telegram as boolean | null) ?? null,
        hasTwitter: (r.has_twitter as boolean | null) ?? null,
        hasWebsite: (r.has_website as boolean | null) ?? null,
      };
    });

    if (candidates.length > 0) {
      const ages = candidates.map((c) => c.ageSeconds).sort((a, b) => a - b);
      ctx.log.info('early-alert candidates', {
        candidates: candidates.length,
        alerting: cfg.enabled,
        // The number that matters: how far past the 5-minute mark these are.
        age_median_s: Math.round(ages[Math.floor(ages.length / 2)]!),
        age_max_s: Math.round(ages[ages.length - 1]!),
      });
    }

    return [{ cfg, candidates }];
  },

  async persist(ctx, client, drains) {
    const drain = drains[0];
    if (!drain || drain.candidates.length === 0) return 0;

    const inserted = await writeAndPick(client, ctx.monitorId, drain.cfg, drain.candidates);

    // Muting stops the message, not the record. The row is still written, so a
    // muted period stays measurable rather than becoming a hole in the data.
    if (drain.cfg.enabled) {
      for (const c of drain.candidates) {
        if (inserted.has(c.mint)) ctx.queueAlert(buildAlert(c, drain.cfg));
      }
    } else if (inserted.size > 0) {
      ctx.log.info('alerts muted by options.enabled=false', { recorded: inserted.size });
    }

    return inserted.size;
  },
};

export default adapter;
