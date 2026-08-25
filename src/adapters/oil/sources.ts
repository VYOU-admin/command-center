/**
 * Per-source scrape routines. Each returns observations or throws.
 *
 * A source is a parser keyed by id plus its YAML entry, so enabling a source
 * that already has a routine here is a config change rather than a code change.
 */

import type { Logger } from '../../logger.js';
import type { SourceConfig } from './config.js';
import type { Fetcher } from './fetch.js';
import {
  ParseError,
  parseCashHeatingOil,
  parseMcKinleyHistory,
  parseMcKinleyToday,
} from './parse.js';

export interface Observation {
  source: string;
  zip: string | null;
  city: string | null;
  state: string | null;
  listingId: string | null;
  dealerId: string | null;
  listingPosition: number | null;
  product: string;
  paymentType: string | null;
  gallonMin: number | null;
  gallonMax: number | null;
  pricePerGallon: number;
  gallonMinimum: number | null;
  surchargeNote: string | null;
  priceDate: string | null;
  deliveryDate: string | null;
  priceUpdatedOn: string | null;
}

export interface ScrapeOutput {
  observations: Observation[];
  history: { priceDate: string; price: number }[];
  /** Facts worth logging that are not prices, e.g. dealers listing nothing. */
  notes: Record<string, unknown>;
}

export type ScrapeFn = (
  source: SourceConfig,
  fetcher: Fetcher,
  log: Logger,
) => Promise<ScrapeOutput>;

/* --------------------------------------------------------------- mckinley */

const scrapeMcKinley: ScrapeFn = async (source, fetcher, log) => {
  // The site is a frameset; the price lives in a child frame, not the page the
  // URL points at. The frame URLs contain spaces and must stay encoded.
  const todayUrl = source.extraUrls['today'];
  if (!todayUrl) {
    throw new ParseError(source.id, 'extra_urls.today is required (the price frame)');
  }

  const today = parseMcKinleyToday(await fetcher.get(todayUrl));
  log.info('mckinley parsed', { ...today });

  const observations: Observation[] = [
    {
      source: source.id,
      zip: null,
      city: null,
      state: null,
      listingId: null,
      dealerId: null,
      listingPosition: null,
      product: 'fuel_oil',
      paymentType: null,
      gallonMin: today.gallonMinimum,
      gallonMax: null,
      pricePerGallon: today.pricePerGallon,
      gallonMinimum: today.gallonMinimum,
      surchargeNote: today.surchargeNote,
      priceDate: today.priceDate,
      deliveryDate: null,
      priceUpdatedOn: today.priceDate,
    },
  ];

  return { observations, history: [], notes: {} };
};

/** Separate from the price scrape: run once, then never again. */
export const scrapeMcKinleyHistory = async (
  source: SourceConfig,
  fetcher: Fetcher,
  log: Logger,
): Promise<{ priceDate: string; price: number }[]> => {
  const url = source.extraUrls['history'];
  if (!url) throw new ParseError(source.id, 'extra_urls.history is required for backfill');
  const { rows, skipped } = parseMcKinleyHistory(await fetcher.get(url));
  if (skipped.length > 0) {
    log.warn('history rows skipped: vendor published impossible dates', {
      source: source.id,
      skipped,
      parsed: rows.length,
    });
  }
  return rows;
};

/* -------------------------------------------------------- cashheatingoil */

const scrapeCashHeatingOil: ScrapeFn = async (source, fetcher, log) => {
  if (source.zips.length === 0) {
    throw new ParseError(source.id, 'at least one zip is required');
  }

  const observations: Observation[] = [];
  const notes: Record<string, unknown> = {};
  const emptyDealers: string[] = [];

  for (const zip of source.zips) {
    // The zip -> URL slug is resolved by posting the site's own lookup form and
    // following its redirect, rather than guessing that 06716 maps to
    // "wolcott_ct". Guessing would break silently the day a slug differs.
    const lookupUrl = source.url;
    const html = await fetcher.get(lookupUrl, {
      method: 'POST',
      formData: { txtzipcode: zip, btnsubmit: 'Continue' },
    });
    const resolvedUrl = fetcher.lastUrl;
    log.info('cashheatingoil zip resolved', { zip, url: resolvedUrl });

    const page = parseCashHeatingOil(html, zip);

    for (const listing of page.listings) {
      if (listing.cash.length === 0 && listing.credit.length === 0) {
        emptyDealers.push(`${zip}:${listing.dealerId ?? listing.position}`);
        continue;
      }
      for (const [paymentType, bands] of [
        ['cash', listing.cash],
        ['credit', listing.credit],
      ] as const) {
        for (const band of bands) {
          observations.push({
            source: source.id,
            zip,
            city: page.city,
            state: page.state,
            listingId: listing.listingId ?? page.listingId,
            dealerId: listing.dealerId,
            listingPosition: listing.position,
            product: 'fuel_oil',
            paymentType,
            gallonMin: band.gallonMin,
            gallonMax: band.gallonMax,
            pricePerGallon: band.pricePerGallon,
            gallonMinimum: null,
            surchargeNote: null,
            priceDate: listing.priceUpdatedOn,
            deliveryDate: listing.deliveryDate,
            priceUpdatedOn: listing.priceUpdatedOn,
          });
        }
      }
    }
    notes[`${zip}_listings`] = page.listings.length;
    notes[`${zip}_city`] = page.city;
  }

  if (emptyDealers.length > 0) notes['dealers_listing_no_prices'] = emptyDealers;
  return { observations, history: [], notes };
};

/* ------------------------------------------------------------------ forbes */

const scrapeForbes: ScrapeFn = async (source) => {
  // Deliberately not implemented. forbesfueloil.com serves a BotStopper
  // proof-of-work challenge on every path, including /wp-json/ and the sitemap,
  // so reading it means defeating an access control the owner installed rather
  // than simply parsing a public page. Left disabled pending that decision, so
  // that turning it on is never an accident.
  throw new ParseError(
    source.id,
    'not implemented: the site serves a proof-of-work bot challenge site-wide. ' +
      'Enabling this source requires deciding how to handle that challenge.',
  );
};

export const SCRAPERS: Record<string, ScrapeFn> = {
  mckinley: scrapeMcKinley,
  cashheatingoil: scrapeCashHeatingOil,
  forbes: scrapeForbes,
};
