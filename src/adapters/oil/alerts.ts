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
  observations: Observation[],
  changes: PriceChange[],
  failed: { source: SourceConfig; error: string | null }[],
): Alert {
  const changed = new Map(changes.map((c) => [key(c.observation), c]));

  const detail = changes
    .slice(0, 20)
    .map((c) =>
      c.from === null
        ? `• ${label(c.observation)} — new at ${usd(c.to)}`
        : `• ${label(c.observation)} — ${usd(c.from)} → ${usd(c.to)} (${c.to > c.from ? '+' : ''}${(c.to - c.from).toFixed(2)})`,
    )
    .join('\n');
  const more = changes.length > 20 ? `\n…and ${changes.length - 20} more` : '';

  const sources = new Set(changes.map((c) => c.observation.source));

  return {
    level: 'warning',
    title: `Oil prices changed — ${changes.length} quote${changes.length === 1 ? '' : 's'} moved`,
    description:
      `${changes.length} quote${changes.length === 1 ? '' : 's'} changed across ` +
      `${sources.size} source${sources.size === 1 ? '' : 's'} since the last scrape. ` +
      `Headline prices below are the cheapest quote covering ${cfg.compareGallons} gallons.`,
    fields: [
      ...priceListFields(cfg, observations, changed),
      { name: 'What moved', value: (detail + more).slice(0, 1024) || '—', inline: false },
      ...failureField(failed),
    ],
  };
}

export function buildDigestAlert(
  cfg: OilConfig,
  observations: Observation[],
  failed: { source: SourceConfig; error: string | null }[],
  localDate: string,
): Alert {
  const empty = new Map<string, PriceChange>();
  return {
    level: 'recovery',
    title: `Daily oil price digest — ${localDate}`,
    description:
      `Current prices from every source, sent once a day whether or not anything ` +
      `moved. Headline prices are the cheapest quote covering ${cfg.compareGallons} gallons; ` +
      `every gallon band is stored in full.`,
    fields: [...priceListFields(cfg, observations, empty), ...failureField(failed)],
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
