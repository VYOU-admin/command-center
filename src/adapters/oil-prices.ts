/**
 * Home heating oil price monitor.
 *
 * Scrapes several small business sites on a schedule and stores every quoted
 * price, append-only. Three things shape the design:
 *
 * 1. SOURCES FAIL INDEPENDENTLY. One site changing its HTML must not stop the
 *    others from storing. Each source is scraped inside its own try/catch, and
 *    a failing one is tracked per source rather than only per run — otherwise a
 *    permanently broken scraper would live inside successful runs and never be
 *    noticed, which is the silent failure this whole project is built against.
 *
 * 2. A WRONG PRICE IS WORSE THAN A MISSING ONE. Parsers throw instead of
 *    returning a plausible-looking number, prices are range-checked, and the
 *    price column is `not null check (> 0)`. A source that breaks stores
 *    nothing and says so.
 *
 * 3. ALERTS ARE CROSS-SOURCE. The question being asked is "did anything move
 *    anywhere", so one scrape produces at most one change alert covering every
 *    source, not one alert per site.
 */

import type { AdapterContext, SourceAdapter } from './types.js';
import type { PoolClient } from '../store/db.js';
import { parseOilConfig, type OilConfig, type SourceConfig } from './oil/config.js';
import { SCHEMA } from './oil/schema.js';
import { createFetcher } from './oil/fetch.js';
import { SCRAPERS, scrapeMcKinleyHistory, type Observation } from './oil/sources.js';
import {
  buildCashWorkbook,
  buildOtherWorkbook,
  diffCompanyRows,
  diffTopRanks,
  selectCashRows,
  selectCompanyRows,
  type CashRow,
  type CompanyRow,
} from './oil/workbook.js';
import {
  buildChangeAlert,
  buildCsv,
  buildDigestAlert,
  buildSourceFailureAlert,
  diffPrices,
  localParts,
  type CsvRow,
  type PriceKey,
} from './oil/alerts.js';

interface SourceResult {
  source: SourceConfig;
  ok: boolean;
  observations: Observation[];
  history: { priceDate: string; price: number }[];
  error: string | null;
  notes: Record<string, unknown>;
}

interface ScrapeRun {
  cfg: OilConfig;
  results: SourceResult[];
}

/* ------------------------------------------------------------------ fetch */

async function scrapeAll(ctx: AdapterContext, cfg: OilConfig): Promise<SourceResult[]> {
  const fetcher = createFetcher(cfg, ctx.log, ctx.signal);
  const results: SourceResult[] = [];

  // Sequential on purpose. Running these in parallel would defeat the shared
  // request spacing and hit several small sites at once.
  for (const source of cfg.sources.filter((s) => s.enabled)) {
    const scraper = SCRAPERS[source.kind];
    if (!scraper) {
      results.push({
        source,
        ok: false,
        observations: [],
        history: [],
        notes: {},
        error: `no scraper for kind "${source.kind}" (source "${source.id}")`,
      });
      continue;
    }

    try {
      const out = await scraper(source, fetcher, ctx.log, cfg.companyBlurbs);
      if (out.observations.length === 0) {
        throw new Error('scrape produced no observations');
      }

      let history: { priceDate: string; price: number }[] = [];
      if (source.backfill && (await needsBackfill(ctx, source.id))) {
        history = await scrapeMcKinleyHistory(source, fetcher, ctx.log);
        ctx.log.info('history backfill scraped', { source: source.id, rows: history.length });
      }

      results.push({ source, ok: true, observations: out.observations, history, notes: out.notes, error: null });
      ctx.log.info('source scraped', {
        source: source.id,
        observations: out.observations.length,
        history_rows: history.length,
        ...out.notes,
      });
    } catch (err) {
      const message = (err as Error).message;
      results.push({ source, ok: false, observations: [], history: [], notes: {}, error: message });
      // Loud, because a broken parser is the failure mode that matters here.
      ctx.log.error('source scrape failed', { source: source.id, error: message });
    }
  }

  return results;
}

async function needsBackfill(ctx: AdapterContext, source: string): Promise<boolean> {
  const result = await ctx.db.query(
    `select backfilled_at from oil_source_state where monitor_id = $1 and source = $2`,
    [ctx.monitorId, source],
  );
  return result.rows.length === 0 || result.rows[0].backfilled_at === null;
}

/* ---------------------------------------------------------------- persist */

async function writeObservations(
  client: PoolClient,
  monitorId: string,
  rows: Observation[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await client.query(
    `insert into oil_observations (
       monitor_id, source, company, zip, city, state, listing_id, dealer_id, listing_position,
       product, payment_type, gallon_min, gallon_max, price_per_gallon,
       gallon_minimum, surcharge_note, price_date, delivery_date, price_updated_on
     )
     select $1, * from unnest(
       $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::int[],
       $10::text[], $11::text[], $12::int[], $13::int[], $14::numeric[],
       $15::int[], $16::text[], $17::date[], $18::date[], $19::date[]
     )`,
    [
      monitorId,
      rows.map((r) => r.source),
      rows.map((r) => r.company),
      rows.map((r) => r.zip),
      rows.map((r) => r.city),
      rows.map((r) => r.state),
      rows.map((r) => r.listingId),
      rows.map((r) => r.dealerId),
      rows.map((r) => r.listingPosition),
      rows.map((r) => r.product),
      rows.map((r) => r.paymentType),
      rows.map((r) => r.gallonMin),
      rows.map((r) => r.gallonMax),
      rows.map((r) => r.pricePerGallon),
      rows.map((r) => r.gallonMinimum),
      rows.map((r) => r.surchargeNote),
      rows.map((r) => r.priceDate),
      rows.map((r) => r.deliveryDate),
      rows.map((r) => r.priceUpdatedOn),
    ],
  );
  return result.rowCount ?? 0;
}

async function writeHistory(
  client: PoolClient,
  monitorId: string,
  source: string,
  rows: { priceDate: string; price: number }[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const result = await client.query(
    `insert into oil_price_history (monitor_id, source, price_date, price_per_gallon)
     select $1, $2, * from unnest($3::date[], $4::numeric[])
     on conflict (monitor_id, source, price_date) do nothing`,
    [monitorId, source, rows.map((r) => r.priceDate), rows.map((r) => r.price)],
  );
  return result.rowCount ?? 0;
}

/** Previous known price for every key, read before this scrape is inserted. */
async function previousPrices(
  client: PoolClient,
  monitorId: string,
): Promise<Map<string, { price: number; observedAt: Date }>> {
  const result = await client.query(
    `select distinct on (source, coalesce(zip,''), coalesce(dealer_id,''),
                         coalesce(payment_type,''), product, coalesce(gallon_min,-1))
            source, zip, dealer_id, payment_type, product, gallon_min, gallon_max,
            price_per_gallon, observed_at
       from oil_observations
      where monitor_id = $1
      order by source, coalesce(zip,''), coalesce(dealer_id,''),
               coalesce(payment_type,''), product, coalesce(gallon_min,-1), observed_at desc`,
    [monitorId],
  );
  const map = new Map<string, { price: number; observedAt: Date }>();
  for (const r of result.rows) {
    map.set(keyOf(r as PriceKey), {
      price: Number(r.price_per_gallon),
      observedAt: r.observed_at as Date,
    });
  }
  return map;
}

export function keyOf(r: PriceKey): string {
  return [
    r.source,
    r.zip ?? '',
    r.dealer_id ?? (r as { dealerId?: string | null }).dealerId ?? '',
    r.payment_type ?? (r as { paymentType?: string | null }).paymentType ?? '',
    r.product,
    r.gallon_min ?? (r as { gallonMin?: number | null }).gallonMin ?? '',
  ].join('|');
}


/** Cash quotes in the reported band for the most recent observation time. */
async function latestCashQuotes(
  client: PoolClient,
  monitorId: string,
  cfg: OilConfig,
): Promise<
  {
    observed_at: Date;
    zip: string;
    price_per_gallon: string;
    company: string | null;
    dealer_id: string | null;
    listing_position: number | null;
  }[]
> {
  const r = await client.query(
    `with latest as (
       select max(observed_at) t from oil_observations
        where monitor_id = $1 and source = $2
     )
     select o.observed_at, o.zip, o.price_per_gallon, o.company, o.dealer_id, o.listing_position
       from oil_observations o, latest
      where o.monitor_id = $1 and o.source = $2 and o.observed_at = latest.t
        and o.payment_type = 'cash'
        and o.gallon_min = $3 and o.gallon_max = $4
        and o.zip is not null`,
    [monitorId, cfg.cashSourceId, cfg.cashBandMin, cfg.cashBandMax],
  );
  return r.rows as never;
}

/**
 * One heating-oil price per company: the band covering a 150-gallon delivery,
 * taken from each source's most recent scrape. Propane, diesel and DEF never
 * reach here — the product filter is applied in SQL and the band choice is made
 * on parsed bounds rather than on each site's own wording.
 */
async function companyRows(
  client: PoolClient,
  monitorId: string,
  cfg: OilConfig,
): Promise<CompanyRow[]> {
  const r = await client.query(
    `with latest as (
       select source, max(observed_at) t from oil_observations
        where monitor_id = $1 and source <> $2 and product = 'fuel_oil'
        group by source
     )
     select o.observed_at, o.company, o.source, o.zip, o.gallon_min, o.gallon_max,
            o.payment_type, o.price_per_gallon
       from oil_observations o join latest l
         on l.source = o.source and l.t = o.observed_at
      where o.monitor_id = $1 and o.product = 'fuel_oil'`,
    [monitorId, cfg.cashSourceId],
  );
  return selectCompanyRows(
    r.rows.map((x) => ({
      observed_at: x.observed_at as Date,
      company: x.company === null ? null : String(x.company),
      source: String(x.source),
      zip: x.zip === null ? null : String(x.zip),
      gallon_min: x.gallon_min === null ? null : Number(x.gallon_min),
      gallon_max: x.gallon_max === null ? null : Number(x.gallon_max),
      payment_type: x.payment_type === null ? null : String(x.payment_type),
      price_per_gallon: x.price_per_gallon as string,
      // OMNI publishes no band at all; the config's default lower bound must
      // not be presented as if the site had stated one.
      band_label_override: cfg.noBandSources.includes(String(x.source))
        ? '(no band stated)'
        : null,
    })),
    cfg.exportGallons,
  );
}

async function loadPreviousRanks(
  client: PoolClient,
  monitorId: string,
): Promise<CashRow[]> {
  const r = await client.query(
    `select zip, rank, price, dealer_id, is_fjb, observed_at
       from oil_rank_state where monitor_id = $1 order by zip, rank`,
    [monitorId],
  );
  return r.rows.map((x) => ({
    observed_at: x.observed_at as Date,
    zip: String(x.zip),
    rank: Number(x.rank),
    price_per_gallon: Number(x.price),
    is_fjb: Boolean(x.is_fjb),
    dealer_id: x.dealer_id === null ? null : String(x.dealer_id),
    listing_position: null,
    extra: false,
  }));
}

async function saveRanks(
  client: PoolClient,
  monitorId: string,
  rows: CashRow[],
): Promise<void> {
  await client.query(`delete from oil_rank_state where monitor_id = $1`, [monitorId]);
  const top = rows.filter((r) => !r.extra);
  if (top.length === 0) return;
  await client.query(
    `insert into oil_rank_state (monitor_id, zip, rank, price, dealer_id, is_fjb, observed_at)
     select $1, * from unnest($2::text[], $3::int[], $4::numeric[], $5::text[], $6::boolean[], $7::timestamptz[])`,
    [
      monitorId,
      top.map((r) => r.zip),
      top.map((r) => r.rank),
      top.map((r) => r.price_per_gallon),
      top.map((r) => r.dealer_id),
      top.map((r) => r.is_fjb),
      top.map((r) => r.observed_at),
    ],
  );
}

/**
 * Rolling window for the attachment: every check, every quote, ordered by
 * timestamp then price so the cheapest option sits at the top of each block.
 */
async function csvRows(
  client: PoolClient,
  monitorId: string,
  hours: number,
): Promise<CsvRow[]> {
  const result = await client.query(
    `select observed_at, company, source, zip,
            case when gallon_min is null then null
                 when gallon_max is null then gallon_min || '+'
                 else gallon_min || '-' || gallon_max end as band,
            payment_type, price_per_gallon
       from oil_observations
      where monitor_id = $1 and observed_at > now() - ($2 || ' hours')::interval
      order by observed_at desc, price_per_gallon asc`,
    [monitorId, hours],
  );
  return result.rows as CsvRow[];
}

/**
 * Retention. Prices move about once a day but are sampled every 15 minutes, so
 * roughly 95 of every 96 rows per quote restate the previous one.
 *
 * Recent rows are kept whole, because that is what the attached CSV reads and
 * what you want when investigating something that just happened. Past that
 * horizon each quote keeps, per day: the first row of every distinct price run,
 * the daily high, the daily low, and the day's last row. Everything else is
 * redundant — a price with a start and an end is a step function, so the runs
 * that remain reconstruct the series exactly rather than approximating it.
 *
 * `oil_price_history` is never touched: it is the vendor's own daily series
 * back to 2008, already one row per day, and irreplaceable.
 */
async function pruneObservations(
  client: PoolClient,
  monitorId: string,
  cfg: OilConfig,
): Promise<number> {
  const result = await client.query(
    `with candidates as (
       select id, observed_at, price_per_gallon,
              (observed_at at time zone $4)::date as local_day,
              source, coalesce(zip,'') zk, coalesce(dealer_id,'') dk,
              coalesce(payment_type,'') pk, product, coalesce(gallon_min,-1) gk
         from oil_observations
        where monitor_id = $1
          and observed_at < now() - ($2 || ' hours')::interval
     ),
     marked as (
       select id,
              price_per_gallon,
              lag(price_per_gallon) over w as prev_price,
              row_number() over (partition by source, zk, dk, pk, product, gk, local_day
                                 order by observed_at desc) as rn_last,
              -- Pick the specific low and high ROWS. Comparing each row's price
              -- against the day's min and max instead protects every row on a
              -- day that only saw two prices, which is most days — the first
              -- version of this deleted nothing at all.
              row_number() over (partition by source, zk, dk, pk, product, gk, local_day
                                 order by price_per_gallon asc, observed_at asc) as rn_low,
              row_number() over (partition by source, zk, dk, pk, product, gk, local_day
                                 order by price_per_gallon desc, observed_at asc) as rn_high
         from candidates
       window w as (partition by source, zk, dk, pk, product, gk order by observed_at)
     ),
     doomed as (
       select id from marked
        where prev_price is not null
          and price_per_gallon = prev_price   -- not a change point
          and rn_last <> 1                    -- not the day's last row
          and rn_low <> 1                     -- not the row holding the daily low
          and rn_high <> 1                    -- not the row holding the daily high
        limit $3
     )
     delete from oil_observations o using doomed d where o.id = d.id`,
    [monitorId, cfg.retentionFullHours, cfg.retentionMaxRowsPerPass, cfg.timezone],
  );
  return result.rowCount ?? 0;
}

async function updateSourceState(
  ctx: AdapterContext,
  client: PoolClient,
  cfg: OilConfig,
  results: SourceResult[],
): Promise<void> {
  // A source that was failing and has since been disabled is not broken, it is
  // switched off. Leaving its old streak in place would keep the dashboard
  // showing a source as broken forever with nothing able to clear it — a
  // permanent false alarm, which is worse than no signal at all.
  const disabled = cfg.sources.filter((s) => !s.enabled).map((s) => s.id);
  if (disabled.length > 0) {
    await client.query(
      `update oil_source_state
          set consecutive_failures = 0, failure_alert_sent = false,
              last_error = null
        where monitor_id = $1 and source = any($2)
          and (consecutive_failures > 0 or failure_alert_sent)`,
      [ctx.monitorId, disabled],
    );
  }

  for (const result of results) {
    const backfilled = result.ok && result.history.length > 0;
    const state = await client.query(
      `insert into oil_source_state
         (monitor_id, source, consecutive_failures, last_ok_at, last_attempt_at,
          last_error, backfilled_at)
       values ($1, $2, $3, $4, now(), $5, case when $6 then now() else null end)
       on conflict (monitor_id, source) do update set
         consecutive_failures = case when $7 then 0
                                     else oil_source_state.consecutive_failures + 1 end,
         last_ok_at      = case when $7 then now() else oil_source_state.last_ok_at end,
         last_attempt_at = now(),
         last_error      = $5,
         backfilled_at   = case when $6 then now() else oil_source_state.backfilled_at end
       returning consecutive_failures, failure_alert_sent`,
      [
        ctx.monitorId,
        result.source.id,
        result.ok ? 0 : 1,
        result.ok ? new Date() : null,
        result.error,
        backfilled,
        result.ok,
      ],
    );

    const row = state.rows[0] as { consecutive_failures: number; failure_alert_sent: boolean };

    // Per-source failure alerting, mirroring the spine's per-monitor logic one
    // level down. Routed to the system channel: a broken scraper is an
    // operational problem, not a price update.
    if (!result.ok && row.consecutive_failures >= cfg.sourceFailureAlertAfter && !row.failure_alert_sent) {
      ctx.queueAlert(
        buildSourceFailureAlert(ctx, result.source, row.consecutive_failures, result.error),
        'system',
      );
      await client.query(
        `update oil_source_state set failure_alert_sent = true
          where monitor_id = $1 and source = $2`,
        [ctx.monitorId, result.source.id],
      );
    }

    if (result.ok && row.failure_alert_sent) {
      ctx.queueAlert(
        {
          level: 'recovery',
          title: `Oil source ${result.source.label} is scraping again`,
          description: `\`${result.source.id}\` parsed successfully after a failing streak.`,
          fields: [{ name: 'Prices stored', value: String(result.observations.length), inline: true }],
        },
        'system',
      );
      await client.query(
        `update oil_source_state set failure_alert_sent = false
          where monitor_id = $1 and source = $2`,
        [ctx.monitorId, result.source.id],
      );
    }
  }
}

/* ---------------------------------------------------------------- adapter */

const adapter: SourceAdapter<ScrapeRun> = {
  type: 'oil-prices',

  validate(options, monitorId) {
    const cfg = parseOilConfig(options, monitorId);
    for (const source of cfg.sources) {
      if (source.enabled && !SCRAPERS[source.kind]) {
        throw new Error(
          `monitor "${monitorId}": source "${source.id}" has kind "${source.kind}" but no ` +
            `scraper exists for it. Available kinds: ${Object.keys(SCRAPERS).join(', ')}`,
        );
      }
    }
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx) {
    const cfg = parseOilConfig(ctx.options, ctx.monitorId);
    const results = await scrapeAll(ctx, cfg);

    // Every source failing is a real run failure. Some failing is not: the
    // others have good data that must still be stored, and the per-source
    // state above is what makes the broken one visible.
    if (results.every((r) => !r.ok)) {
      throw new Error(
        `all ${results.length} oil sources failed: ` +
          results.map((r) => `${r.source.id}: ${r.error}`).join(' | '),
      );
    }

    return [{ cfg, results }];
  },

  async persist(ctx, client, runs) {
    const run = runs[0];
    if (!run) return 0;
    const { cfg, results } = run;

    const previous = await previousPrices(client, ctx.monitorId);
    // Taken BEFORE this run's rows land, so the comparison is run-to-run.
    const observationsBefore = await companyRows(client, ctx.monitorId, cfg);

    const observations = results.flatMap((r) => r.observations);
    const stored = await writeObservations(client, ctx.monitorId, observations);

    let historyRows = 0;
    for (const result of results) {
      if (result.history.length > 0) {
        historyRows += await writeHistory(client, ctx.monitorId, result.source.id, result.history);
      }
    }

    await updateSourceState(ctx, client, cfg, results);

    const changes = diffPrices(previous, observations);
    const failed = results.filter((r) => !r.ok);

    const now = new Date();
    const { date: localDate, hour: localHour } = localParts(now, cfg.timezone);
    // Read as text, not as a Date. last_digest_on already IS a local calendar
    // date; letting the driver hand back a Date makes it midnight UTC, and
    // converting that back into America/New_York lands on the previous day —
    // so the comparison never matched and the digest fired on every run.
    const alertState = await client.query(
      `select to_char(last_digest_on, 'YYYY-MM-DD') as last_digest_on
         from oil_alert_state where monitor_id = $1`,
      [ctx.monitorId],
    );
    const lastDigestStr = (alertState.rows[0]?.last_digest_on as string | undefined) ?? null;
    const digestDue = localHour >= cfg.digestHour && lastDigestStr !== localDate;

    // ---- the two workbooks, and what changed in the ranked view ----
    const quotes = await latestCashQuotes(client, ctx.monitorId, cfg);
    const { rows: cashRows, zipsSeen, zipsWithFjb } = selectCashRows(
      quotes,
      cfg.fjbCompany,
      cfg.cashTopN,
    );

    // A zip where the blurb matched nothing is NOT the same as FJB being absent
    // from that zip, and the two are indistinguishable once the data is stored.
    // Say so loudly rather than letting a broken match look like a real result.
    const fjbMisses = [...zipsSeen].filter((z) => !zipsWithFjb.has(z)).sort();
    if (fjbMisses.length > 0) {
      ctx.log.warn('FJB blurb matched no listing', { zips: fjbMisses });
      ctx.queueAlert(
        {
          level: 'warning',
          title: `FJB not found in ${fjbMisses.length} zip${fjbMisses.length > 1 ? 's' : ''}`,
          description:
            'The FJB blurb matched no listing in the zips below. This is reported ' +
            'because a silent match failure is indistinguishable from FJB simply ' +
            'not being listed, and the two mean very different things.\n\n' +
            `Zips: **${fjbMisses.join(', ')}**`,
          fields: [
            { name: 'Source', value: cfg.cashSourceId, inline: true },
            { name: 'Zips checked', value: String(zipsSeen.size), inline: true },
            { name: 'Zips with FJB', value: String(zipsWithFjb.size), inline: true },
          ],
        },
        'system',
      );
    }

    const previousRanks = await loadPreviousRanks(client, ctx.monitorId);
    const rankChanges = diffTopRanks(previousRanks, cashRows);

    // Other sources get the same change-only treatment: a vendor that did not
    // move its price should not generate a ping just because a run happened.
    const otherNow = await companyRows(client, ctx.monitorId, cfg);
    const otherChanges = diffCompanyRows(observationsBefore, otherNow);
    // After a wipe there is no baseline, so the change list is empty by
    // construction. Ping anyway once, or the first clean run produces files
    // nobody is told about.
    const firstPing = cfg.forceFirstPing && previousRanks.length === 0 && cashRows.length > 0;
    const shouldPing = rankChanges.length > 0 || otherChanges.length > 0 || firstPing;

    const files =
      shouldPing || digestDue
        ? [
            {
              filename: 'cashheatingoil.xlsx',
              content: await buildCashWorkbook(cashRows, fjbMisses.map((zip) => ({ zip }))),
              contentType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              encoding: 'base64' as const,
            },
            {
              filename: 'competitor-pricing.xlsx',
              content: await buildOtherWorkbook(otherNow),
              contentType:
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              encoding: 'base64' as const,
            },
          ]
        : [];

    if (shouldPing) {
      const lines = firstPing
        ? ['Baseline after reset — no previous run to compare against.']
        : [...rankChanges, ...otherChanges];
      ctx.queueAlert({
        level: 'warning',
        title: firstPing
          ? `Oil baseline — ${zipsSeen.size} zips, ${cashRows.length} rows`
          : `Oil prices moved — ${rankChanges.length} in top ${cfg.cashTopN}` +
            (otherChanges.length > 0 ? `, ${otherChanges.length} other source(s)` : ''),
        description: lines.slice(0, 25).join('\n') || 'no detail',
        fields: [
          { name: 'Zips', value: String(zipsSeen.size), inline: true },
          { name: 'FJB found in', value: `${zipsWithFjb.size}/${zipsSeen.size}`, inline: true },
          { name: 'Band', value: `${cfg.cashBandMin}-${cfg.cashBandMax} cash`, inline: true },
        ],
        files,
      });
    }
    if (digestDue) {
      ctx.queueAlert(buildDigestAlert(cfg, observations, failed, localDate, null, files));
    }

    // Record what was sent. Without this the digest has no memory of the day
    // it last ran, so `last_digest_on != today` stays true and it fires on
    // EVERY run rather than once a day.
    await client.query(
      `insert into oil_alert_state (monitor_id, last_alert_at, last_digest_on, last_change_count)
       values ($1, case when $2 then now() else null end, case when $3 then $4::date else null end, $5)
       on conflict (monitor_id) do update set
         last_alert_at     = case when $2 then now() else oil_alert_state.last_alert_at end,
         last_digest_on    = case when $3 then $4::date else oil_alert_state.last_digest_on end,
         last_change_count = $5`,
      [
        ctx.monitorId,
        shouldPing,
        digestDue,
        localDate,
        rankChanges.length + otherChanges.length,
      ],
    );

    await saveRanks(client, ctx.monitorId, cashRows);

    const pruned = await pruneObservations(client, ctx.monitorId, cfg);

    ctx.log.info('oil scrape stored', {
      rows_pruned: pruned,
      sources_ok: results.filter((r) => r.ok).map((r) => r.source.id),
      sources_failed: failed.map((r) => r.source.id),
      observations: stored,
      history_rows: historyRows,
      price_changes: changes.length,
      digest_sent: digestDue,
    });

    return stored + historyRows;
  },
};

export default adapter;
