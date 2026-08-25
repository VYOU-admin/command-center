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

export interface SourceConfig {
  /** Stable key stored on every row. Also selects the parser. */
  id: string;
  label: string;
  enabled: boolean;
  url: string;
  /** Extra URLs the parser needs, e.g. a frameset's inner frames. */
  extraUrls: Record<string, string>;
  /** Zip codes, for zip-driven sources. */
  zips: string[];
  /** Pull the vendor's published history once, on first successful run. */
  backfill: boolean;
}

export interface OilConfig {
  sources: SourceConfig[];
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

    return {
      id,
      label: str(s, 'label', id),
      enabled: s['enabled'] !== false,
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

  return {
    sources,
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
