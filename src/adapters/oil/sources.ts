/**
 * Per-source scrape routines. Each returns observations or throws.
 *
 * A source is a parser keyed by id plus its YAML entry, so enabling a source
 * that already has a routine here is a config change rather than a code change.
 */

import type { Logger } from '../../logger.js';
import type { CompanyBlurb, SourceConfig } from './config.js';
import type { Fetcher } from './fetch.js';
import {
  ParseError,
  parseCashHeatingOil,
  parseMcKinleyHistory,
  parseMcKinleyToday,
} from './parse.js';
import { extractBands } from './vendor.js';

export interface Observation {
  source: string;
  company: string | null;
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
  blurbs: CompanyBlurb[],
) => Promise<ScrapeOutput>;

/** Collapse whitespace and case so a reflowed blurb still matches. */
const normalise = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

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
      company: source.company,
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

/* ------------------------------------------------------------------ vendor */

/**
 * Any vendor whose page is an anchor heading followed by prices. All the
 * site-specific knowledge lives in the YAML extract rules, so a new company
 * with this shape needs no code.
 */
const scrapeVendor: ScrapeFn = async (source, fetcher, log) => {
  const html = await fetcher.get(source.url);
  const observations: Observation[] = [];

  for (const rule of source.extract) {
    const bands = extractBands(html, rule, source.id);
    for (const band of bands) {
      observations.push({
        source: source.id,
        company: source.company,
        zip: null,
        city: null,
        state: null,
        listingId: null,
        dealerId: null,
        listingPosition: null,
        product: band.product,
        paymentType: null,
        gallonMin: band.gallonMin,
        gallonMax: band.gallonMax,
        pricePerGallon: band.pricePerGallon,
        gallonMinimum: rule.defaultGallonMin,
        surchargeNote: null,
        priceDate: null,
        deliveryDate: null,
        priceUpdatedOn: null,
      });
    }
    log.info('vendor bands parsed', {
      source: source.id,
      product: rule.product,
      bands: bands.length,
    });
  }

  return { observations, history: [], notes: { bands: observations.length } };
};

/* -------------------------------------------------------- cashheatingoil */

const scrapeCashHeatingOil: ScrapeFn = async (source, fetcher, log, blurbs) => {
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
      // This site hides dealer names, so the only identifier a human can use is
      // the listing's own blurb. Matching a distinctive phrase rather than the
      // whole paragraph means the vendor can edit the rest of it without the
      // tag silently disappearing.
      const blurb = normalise(listing.blurb ?? '');
      const matched = blurbs.find((b) => blurb.includes(normalise(b.phrase)));
      const company = matched
        ? matched.company
        : listing.dealerId
          ? `${source.label} #${listing.dealerId}`
          : `${source.label} pos${listing.position}`;

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
            company,
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
  notes['tagged_companies'] = [
    ...new Set(observations.map((o) => o.company).filter((c) => c && !c.includes('#'))),
  ];
  return { observations, history: [], notes };
};

/* ----------------------------------------------------------------- blocked */

/**
 * Sources that exist but cannot be scraped — a bot challenge we will not defeat,
 * a price behind a login, a price rendered only by client-side JavaScript, or no
 * public site at all. They stay in the config with their reason recorded so the
 * roster is complete and visible, and this throws if one is ever enabled, so it
 * cannot be switched on by accident.
 */
const scrapeBlocked: ScrapeFn = async (source) => {
  throw new ParseError(
    source.id,
    `not scrapeable: ${source.disabledReason ?? 'no reason recorded'}`,
  );
};

/**
 * Keyed by SHAPE, not by company. `vendor` covers every site whose page is an
 * anchor followed by prices, which is most of them.
 */
export const SCRAPERS: Record<string, ScrapeFn> = {
  mckinley: scrapeMcKinley,
  cashheatingoil: scrapeCashHeatingOil,
  vendor: scrapeVendor,
  blocked: scrapeBlocked,
};
