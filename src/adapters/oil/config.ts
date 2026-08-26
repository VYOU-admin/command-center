/**
 * Oil monitor configuration.
 *
 * Which sites are scraped is a YAML list, not a list in code. Each entry names
 * a parser and carries its own settings, so enabling a source that already has
 * a parser is a config change. Forbes is present but disabled: the site runs a
 * proof-of-work bot challenge, and turning it on is a decision about how to
 * deal with that, not a code change.
 */

import { configNumber, section } from '../types.js';
import type { ExtractRule } from './vendor.js';

export interface SourceConfig {
  /** Stable key stored on every row. */
  id: string;
  label: string;
  /**
   * Which scrape routine to use. Keyed by shape rather than by company, so a
   * vendor whose page has the common "anchor then prices" layout is added in
   * YAML with no new code.
   */
  kind: string;
  enabled: boolean;
  /** Why a source is off, shown at boot and on the dashboard. */
  disabledReason: string | null;
  /** Public page to link the company name to in alerts. */
  siteUrl: string | null;
  /** Company name shown in alerts. Defaults to the label. */
  company: string;
  /** Text-anchored extraction rules, for kind: vendor. */
  extract: ExtractRule[];
  url: string;
  /** Extra URLs the parser needs, e.g. a frameset's inner frames. */
  extraUrls: Record<string, string>;
  /** Zip codes, for zip-driven sources. */
  zips: string[];
  /** Pull the vendor's published history once, on first successful run. */
  backfill: boolean;
}

export interface CompanyBlurb {
  company: string;
  /** Distinctive phrase, matched case- and whitespace-insensitively. */
  phrase: string;
}

export interface OilConfig {
  /** Which source the narrow CashHeatingOil workbook is built from. */
  cashSourceId: string;
  /** The company label the blurb match assigns to FJB. */
  fjbCompany: string;
  cashBandMin: number;
  cashBandMax: number;
  /** How many cheapest dealers per zip the workbook reports. */
  cashTopN: number;
  /**
   * Send a ping on the first run after the rank state is empty. Without it a
   * wipe would produce files nobody is told about, because there is nothing to
   * diff against and the change list is empty by construction.
   */
  forceFirstPing: boolean;
  /** Delivery size the single reported price must cover. */
  exportGallons: number;
  /** Sources that publish no band; their label says so rather than inventing one. */
  noBandSources: string[];
  sources: SourceConfig[];
  /**
   * Identifies a company on listing sites that hide the dealer name. Matched on
   * a distinctive phrase rather than the whole paragraph, so the vendor editing
   * the rest of their blurb does not silently drop the tag.
   */
  companyBlurbs: CompanyBlurb[];
  /** Hours of full-resolution rows kept before collapsing. */
  retentionFullHours: number;
  /** Rows to delete per maintenance pass. */
  retentionMaxRowsPerPass: number;
  /** Hours of history the attached CSV covers. */
  csvWindowHours: number;
  userAgent: string;
  timeoutMs: number;
  /** Pause between HTTP requests. These are small business sites. */
  requestDelayMs: number;
  /** Retries per request, with linear backoff. */
  maxRetries: number;
  /** Consecutive failures of ONE source before it alerts to the system channel. */
  sourceFailureAlertAfter: number;
  /** Local hour for the daily digest. */
  digestHour: number;
  /** IANA zone the digest hour is interpreted in. */
  timezone: string;
  /** Gallon quantity the dashboard normalises to for comparison. */
  compareGallons: number;
}

function str(o: Record<string, unknown>, key: string, fallback: string): string {
  const v = o[key];
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

export function parseOilConfig(
  options: Record<string, unknown>,
  monitorId: string,
): OilConfig {
  const ctx = `monitor "${monitorId}"`;
  const l = section(options, 'limits');
  const a = section(options, 'alerts');

  const rawSources = options['sources'];
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    throw new Error(`${ctx}: options.sources must be a non-empty list`);
  }

  const seen = new Set<string>();
  const sources: SourceConfig[] = rawSources.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${ctx}: sources[${i}] must be a mapping`);
    }
    const s = raw as Record<string, unknown>;
    const id = s['id'];
    if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
      throw new Error(`${ctx}: sources[${i}].id must be a lowercase slug, got ${String(id)}`);
    }
    if (seen.has(id)) throw new Error(`${ctx}: duplicate source id "${id}"`);
    seen.add(id);

    const url = s['url'];
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      throw new Error(`${ctx}: sources[${i}].url must be an http(s) URL, got ${String(url)}`);
    }

    const extraRaw = section(s, 'extra_urls');
    const extraUrls: Record<string, string> = {};
    for (const [k, v] of Object.entries(extraRaw)) {
      if (typeof v !== 'string' || !/^https?:\/\//.test(v)) {
        throw new Error(`${ctx}: sources[${i}].extra_urls.${k} must be an http(s) URL`);
      }
      extraUrls[k] = v;
    }

    const zipsRaw = s['zips'];
    const zips = Array.isArray(zipsRaw)
      ? zipsRaw.map((z, j) => {
          // YAML turns a bare 06716 into the number 6716, silently losing the
          // leading zero. Requiring quotes is friendlier than a 404 later.
          if (typeof z !== 'string' || !/^\d{5}$/.test(z)) {
            throw new Error(
              `${ctx}: sources[${i}].zips[${j}] must be a quoted 5-digit string ` +
                `(YAML reads an unquoted 06716 as the number 6716), got ${String(z)}`,
            );
          }
          return z;
        })
      : [];

    const rawExtract = s['extract'];
    const extract: ExtractRule[] = Array.isArray(rawExtract)
      ? rawExtract.map((e, j) => {
          if (typeof e !== 'object' || e === null || Array.isArray(e)) {
            throw new Error(`${ctx}: sources[${i}].extract[${j}] must be a mapping`);
          }
          const r = e as Record<string, unknown>;
          const anchor = r['anchor'];
          if (typeof anchor !== 'string' || anchor.trim() === '') {
            throw new Error(`${ctx}: sources[${i}].extract[${j}].anchor is required`);
          }
          const dgm = r['default_gallon_min'];
          return {
            anchor: anchor.trim(),
            window: configNumber(r, 'window', `${ctx} sources[${i}].extract[${j}]`, 20),
            product: typeof r['product'] === 'string' ? (r['product'] as string) : 'fuel_oil',
            defaultGallonMin: typeof dgm === 'number' ? dgm : null,
          };
        })
      : [];

    const label = str(s, 'label', id);
    const kind = str(s, 'kind', 'vendor');
    const enabled = s['enabled'] !== false;

    if (enabled && kind === 'vendor' && extract.length === 0) {
      throw new Error(
        `${ctx}: sources[${i}] ("${id}") is an enabled vendor source but declares no ` +
          `extract rules, so it would scrape nothing`,
      );
    }

    return {
      id,
      label,
      kind,
      enabled,
      disabledReason:
        typeof s['disabled_reason'] === 'string' ? (s['disabled_reason'] as string).trim() : null,
      siteUrl: typeof s['site_url'] === 'string' ? (s['site_url'] as string).trim() : url,
      company: str(s, 'company', label),
      extract,
      url,
      extraUrls,
      zips,
      backfill: s['backfill'] === true,
    };
  });

  if (!sources.some((s) => s.enabled)) {
    throw new Error(`${ctx}: every source is disabled, so this monitor would do nothing`);
  }

  const digestHour = configNumber(a, 'digest_hour', ctx, 7);
  if (!Number.isInteger(digestHour) || digestHour > 23) {
    throw new Error(`${ctx}: alerts.digest_hour must be an integer 0-23, got ${digestHour}`);
  }

  const timezone = str(a, 'timezone', 'America/New_York');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error(`${ctx}: alerts.timezone is not a valid IANA zone: ${timezone}`);
  }

  const ex = (options['exports'] ?? {}) as Record<string, unknown>;
  const cashSourceId = typeof ex['cash_source_id'] === 'string' ? ex['cash_source_id'] : 'cashheatingoil';
  const fjbCompany = typeof ex['fjb_company'] === 'string' ? ex['fjb_company'] : 'FJBOil';
  const cashBandMin = typeof ex['band_min'] === 'number' ? ex['band_min'] : 100;
  const cashBandMax = typeof ex['band_max'] === 'number' ? ex['band_max'] : 149;
  const cashTopN = typeof ex['top_n'] === 'number' ? ex['top_n'] : 2;
  const forceFirstPing = ex['force_first_ping'] !== false;
  const exportGallons = typeof ex['gallons'] === 'number' ? ex['gallons'] : 150;
  const noBandSources = Array.isArray(ex['no_band_sources'])
    ? (ex['no_band_sources'] as unknown[]).map((v) => String(v))
    : [];

  const rawBlurbs = options['company_blurbs'];
  const companyBlurbs: CompanyBlurb[] = Array.isArray(rawBlurbs)
    ? rawBlurbs.map((b, i) => {
        if (typeof b !== 'object' || b === null || Array.isArray(b)) {
          throw new Error(`${ctx}: company_blurbs[${i}] must be a mapping`);
        }
        const r = b as Record<string, unknown>;
        if (typeof r['company'] !== 'string' || typeof r['phrase'] !== 'string') {
          throw new Error(`${ctx}: company_blurbs[${i}] needs string company and phrase`);
        }
        const phrase = (r['phrase'] as string).trim();
        if (phrase.length < 12) {
          throw new Error(
            `${ctx}: company_blurbs[${i}].phrase is only ${phrase.length} characters; too short ` +
              `to identify a company without false positives`,
          );
        }
        return { company: (r['company'] as string).trim(), phrase };
      })
    : [];

  const r = section(options, 'retention');

  return {
    cashSourceId,
    fjbCompany,
    cashBandMin,
    cashBandMax,
    cashTopN,
    forceFirstPing,
    exportGallons,
    noBandSources,
    sources,
    companyBlurbs,
    retentionFullHours: configNumber(r, 'full_resolution_hours', ctx, 48),
    retentionMaxRowsPerPass: configNumber(r, 'max_rows_per_pass', ctx, 20000),
    csvWindowHours: configNumber(a, 'csv_window_hours', ctx, 24),
    userAgent: str(
      options,
      'user_agent',
      'command-center-oil-monitor/1.0 (+https://github.com/VYOU-admin/command-center)',
    ),
    timeoutMs: configNumber(l, 'timeout_ms', ctx, 25_000),
    requestDelayMs: configNumber(l, 'request_delay_ms', ctx, 3000),
    maxRetries: configNumber(l, 'max_retries', ctx, 2),
    sourceFailureAlertAfter: configNumber(a, 'source_failure_alert_after', ctx, 3),
    digestHour,
    timezone,
    compareGallons: configNumber(options, 'compare_gallons', ctx, 150),
  };
}
