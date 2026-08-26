/**
 * Alert construction and change detection for the oil monitor.
 *
 * The alert answers "did anything move anywhere", so it is built across all
 * sources at once rather than per site. Discord embeds cap at 25 fields and
 * 1024 characters per field, and a full scrape is well over a hundred gallon
 * bands, so the message leads with a comparable headline price per source and
 * then lists what actually moved — everything is in Postgres regardless.
 */

import type { Alert } from '../../sinks/discord.js';
import type { AdapterContext } from '../types.js';
import type { OilConfig, SourceConfig } from './config.js';
import type { Observation } from './sources.js';

export interface PriceKey {
  source: string;
  zip: string | null;
  dealer_id?: string | null;
  payment_type?: string | null;
  product: string;
  gallon_min?: number | null;
  gallon_max?: number | null;
}

export interface PriceChange {
  observation: Observation;
  from: number | null;
  to: number;
}

function key(o: Observation): string {
  return [o.source, o.zip ?? '', o.dealerId ?? '', o.paymentType ?? '', o.product, o.gallonMin ?? ''].join('|');
}

const usdFixed = (n: number): string => `$${n.toFixed(3).replace(/0$/, '')}`;

/** Company name as a markdown link, when the source declares a site. */
function linked(o: Observation, sources: SourceConfig[]): string {
  const name = o.company ?? o.source;
  const src = sources.find((s) => s.id === o.source);
  const url = src?.siteUrl;
  return url ? `[${name}](${url})` : name;
}

function bandLabel(o: Observation): string {
  if (o.gallonMin === null) return '';
  return o.gallonMax ? `${o.gallonMin}-${o.gallonMax}gal` : `${o.gallonMin}+gal`;
}

/**
 * CSV of the recent window: every check, every quote, cheapest first inside each
 * timestamp. The alert body is deliberately short, so this carries the full
 * picture for anyone who wants it.
 */
export function buildCsv(rows: CsvRow[]): string {
  const header = 'timestamp,company,source,zip,gallon_band,payment_type,price_per_gallon';
  const esc = (v: string | null): string => {
    const s = v ?? '';
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) =>
    [
      r.observed_at.toISOString(),
      esc(r.company),
      esc(r.source),
      esc(r.zip),
      esc(r.band),
      esc(r.payment_type),
      Number(r.price_per_gallon).toFixed(3),
    ].join(','),
  );
  return [header, ...body].join('\n') + '\n';
}

export interface CsvRow {
  observed_at: Date;
  company: string | null;
  source: string;
  zip: string | null;
  band: string | null;
  payment_type: string | null;
  price_per_gallon: string | number;
}

/**
 * A change is a price that moved OR a quote that did not exist before. A quote
 * that disappeared is deliberately not treated as a change: dealers drop off
 * the listing routinely and alerting on it would fire constantly.
 */
export function diffPrices(
  previous: Map<string, { price: number; observedAt: Date }>,
  current: Observation[],
): PriceChange[] {
  const changes: PriceChange[] = [];
  for (const o of current) {
    const before = previous.get(key(o));
    if (before === undefined) {
      // On a first-ever scrape everything is "new"; that is not a price move
      // and must not fire an alert claiming a hundred changes.
      if (previous.size === 0) continue;
      changes.push({ observation: o, from: null, to: o.pricePerGallon });
    } else if (Math.abs(before.price - o.pricePerGallon) >= 0.005) {
      changes.push({ observation: o, from: before.price, to: o.pricePerGallon });
    }
  }
  return changes;
}

/** Local calendar date and hour in an IANA zone, for the daily digest. */
export function localParts(date: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    // Some locales render midnight as 24; normalise it.
    hour: Number.parseInt(get('hour'), 10) % 24,
  };
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

function label(o: Observation): string {
  const where = o.zip ? `${o.city ?? o.zip} ${o.zip}` : '';
  const who = o.dealerId ? ` dealer ${o.dealerId}` : '';
  const band = o.gallonMin !== null ? ` ${o.gallonMin}${o.gallonMax ? `-${o.gallonMax}` : '+'}gal` : '';
  const pay = o.paymentType ? ` ${o.paymentType}` : '';
  return `${o.source}${where ? ` ${where}` : ''}${who}${band}${pay}`.trim();
}

/**
 * The comparable headline: the cheapest quote each source offers at the
 * configured comparison quantity. Picking a band that actually covers that
 * quantity is what makes two vendors' numbers mean the same thing.
 */
function headlines(cfg: OilConfig, observations: Observation[]): Map<string, Observation[]> {
  const groups = new Map<string, Observation[]>();
  for (const o of observations) {
    const covers =
      o.gallonMin === null ||
      (o.gallonMin <= cfg.compareGallons && (o.gallonMax === null || o.gallonMax >= cfg.compareGallons));
    if (!covers) continue;
    const g = `${o.source}${o.zip ? ` · ${o.city ?? o.zip} ${o.zip}` : ''}`;
    const list = groups.get(g) ?? [];
    list.push(o);
    groups.set(g, list);
  }

  for (const [g, list] of groups) {
    const best = new Map<string, Observation>();
    for (const o of list) {
      const pay = o.paymentType ?? 'price';
      const cur = best.get(pay);
      if (!cur || o.pricePerGallon < cur.pricePerGallon) best.set(pay, o);
    }
    groups.set(g, [...best.values()]);
  }
  return groups;
}

function priceListFields(
  cfg: OilConfig,
  observations: Observation[],
  changed: Map<string, PriceChange>,
): { name: string; value: string; inline: boolean }[] {
  const fields: { name: string; value: string; inline: boolean }[] = [];
  for (const [group, best] of headlines(cfg, observations)) {
    const lines = best
      .sort((a, b) => (a.paymentType ?? '').localeCompare(b.paymentType ?? ''))
      .map((o) => {
        const change = changed.get(key(o));
        const pay = o.paymentType ? `${o.paymentType}: ` : '';
        const moved = change
          ? change.from === null
            ? `  **new** ${usd(change.to)}`
            : `  **${usd(change.from)} → ${usd(change.to)}**`
          : `  ${usd(o.pricePerGallon)}`;
        const extra = o.gallonMinimum ? ` (min ${o.gallonMinimum}gal)` : '';
        return `${pay}${moved}${extra}`;
      });
    fields.push({ name: group, value: lines.join('\n').slice(0, 1024) || '—', inline: true });
  }
  return fields;
}

function failureField(failed: { source: SourceConfig; error: string | null }[]): {
  name: string;
  value: string;
  inline: boolean;
}[] {
  if (failed.length === 0) return [];
  return [
    {
      name: '⚠️ Sources that failed this scrape',
      value: failed
        .map((f) => `\`${f.source.id}\`: ${(f.error ?? 'unknown').slice(0, 160)}`)
        .join('\n')
        .slice(0, 1024),
      inline: false,
    },
  ];
}

export function buildChangeAlert(
  cfg: OilConfig,
  changes: PriceChange[],
  failed: { source: SourceConfig; error: string | null }[],
  csv: string | null,
  csvHours: number,
): Alert {
  // Body is ONLY what moved: company, old -> new, direction, delta. The full
  // picture is the attachment, so the message stays readable on a phone even
  // when a dozen dealers reprice at once.
  const lines = changes
    .sort((a, b) => Math.abs(b.to - (b.from ?? b.to)) - Math.abs(a.to - (a.from ?? a.to)))
    .map((c) => {
      const name = linked(c.observation, cfg.sources);
      const band = bandLabel(c.observation);
      const pay = c.observation.paymentType ? ` ${c.observation.paymentType}` : '';
      const where = c.observation.zip ? ` ${c.observation.zip}` : '';
      const tail = [band, pay.trim(), where.trim()].filter(Boolean).join(' · ');
      if (c.from === null) return `🆕 ${name} — ${usdFixed(c.to)}${tail ? `  _${tail}_` : ''}`;
      const delta = c.to - c.from;
      const arrow = delta > 0 ? '🔺' : '🔻';
      return (
        `${arrow} ${name} — ${usdFixed(c.from)} → **${usdFixed(c.to)}** ` +
        `(${delta > 0 ? '+' : ''}${delta.toFixed(3).replace(/0$/, '')})` +
        (tail ? `  _${tail}_` : '')
      );
    });

  // Discord caps a description at 4096 characters.
  let body = '';
  let shown = 0;
  for (const line of lines) {
    if (body.length + line.length + 1 > 3900) break;
    body += (body ? '\n' : '') + line;
    shown++;
  }
  if (shown < lines.length) {
    body += `\n…and ${lines.length - shown} more — see the attached CSV`;
  }

  return {
    level: 'warning',
    title: `Oil prices changed — ${changes.length} quote${changes.length === 1 ? '' : 's'}`,
    description: body || 'No changes.',
    fields: failureField(failed),
    ...(csv
      ? {
          files: [
            {
              filename: `oil-prices-${csvHours}h.csv`,
              content: csv,
              contentType: 'text/csv',
            },
          ],
        }
      : {}),
  };
}

export function buildDigestAlert(
  cfg: OilConfig,
  observations: Observation[],
  failed: { source: SourceConfig; error: string | null }[],
  localDate: string,
  csv: string | null,
  files?: Alert['files'],
): Alert {
  // Unlike the change alert, this one is meant to be read cold, so it carries
  // the full ranked list rather than only what moved.
  const covering = observations.filter(
    (o) =>
      o.product === 'fuel_oil' &&
      (o.gallonMin === null ||
        (o.gallonMin <= cfg.compareGallons &&
          (o.gallonMax === null || o.gallonMax >= cfg.compareGallons))),
  );

  const best = new Map<string, Observation>();
  for (const o of covering) {
    const k = `${o.company ?? o.source}|${o.paymentType ?? ''}`;
    const cur = best.get(k);
    if (!cur || o.pricePerGallon < cur.pricePerGallon) best.set(k, o);
  }

  const ranked = [...best.values()].sort((a, b) => a.pricePerGallon - b.pricePerGallon);
  const lines = ranked.map((o, i) => {
    const pay = o.paymentType ? ` _${o.paymentType}_` : '';
    const where = o.zip ? ` _${o.zip}_` : '';
    return `\`${String(i + 1).padStart(2)}\` ${usdFixed(o.pricePerGallon)}  ${linked(o, cfg.sources)}${pay}${where}`;
  });

  let body = `Every source, cheapest first, at ${cfg.compareGallons} gallons.\n\n`;
  for (const line of lines) {
    if (body.length + line.length + 1 > 3900) {
      body += `\n…${lines.length - lines.indexOf(line)} more in the attached CSV`;
      break;
    }
    body += line + '\n';
  }

  return {
    level: 'recovery',
    title: `Daily oil price digest — ${localDate}`,
    description: body,
    fields: failureField(failed),
    // The digest now carries the same two workbooks as the change ping; the
    // legacy CSV path is kept only for callers that still pass one.
    ...(files && files.length > 0
      ? { files }
      : csv
        ? {
            files: [
              { filename: `oil-prices-${cfg.csvWindowHours}h.csv`, content: csv, contentType: 'text/csv' },
            ],
          }
        : {}),
  };
}

export function buildSourceFailureAlert(
  ctx: AdapterContext,
  source: SourceConfig,
  consecutiveFailures: number,
  error: string | null,
): Alert {
  return {
    level: 'critical',
    title: `Oil source ${source.label} has failed ${consecutiveFailures} scrapes in a row`,
    description:
      `\`${source.id}\` has failed its last ${consecutiveFailures} scrapes while other ` +
      `sources in \`${ctx.monitorId}\` kept working, so the monitor itself still reports ` +
      `healthy. Prices for this source have stopped updating — most likely its HTML changed.`,
    fields: [
      { name: 'Error', value: `\`\`\`${(error ?? 'unknown').slice(0, 900)}\`\`\``, inline: false },
      { name: 'URL', value: source.url, inline: false },
    ],
  };
}
