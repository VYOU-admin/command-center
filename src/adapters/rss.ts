/**
 * Generic RSS/Atom adapter. CoinDesk is the first user, but nothing here is
 * CoinDesk-specific — a second feed is just another YAML file pointing at this
 * same `source: rss`.
 */

import Parser from 'rss-parser';
import {
  optionalNumber,
  requireString,
  type AdapterContext,
  type NormalizedRecord,
  type PanelContext,
  type SourceAdapter,
} from './types.js';
import { getRecentRecords } from '../store/records.js';
import { renderRecordListPanel } from '../web/views.js';

const parser = new Parser({
  customFields: { item: [['dc:creator', 'dcCreator']] },
});

const USER_AGENT =
  'command-center-monitor/0.1 (+https://github.com/VYOU-admin/command-center)';

/** Feed summaries are HTML. Store readable text instead. */
function toPlainText(input: string | undefined | null): string | null {
  if (!input) return null;
  const text = input
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text;
}

/**
 * rss-parser keeps XML attributes, so a <category domain="..."> arrives as
 * { _: 'Finance', $: { domain: '...' } } rather than a string. Flatten to the
 * label, which is all we store.
 */
function toCategoryNames(categories: unknown): string[] {
  if (!Array.isArray(categories)) return [];
  const names: string[] = [];
  for (const entry of categories.slice(0, 10)) {
    if (typeof entry === 'string') {
      if (entry.trim()) names.push(entry.trim());
    } else if (entry && typeof entry === 'object' && typeof (entry as { _?: unknown })._ === 'string') {
      const label = ((entry as { _: string })._).trim();
      if (label) names.push(label);
    }
  }
  return names;
}

function toDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const adapter: SourceAdapter = {
  type: 'rss',

  validate(options, monitorId) {
    const url = requireString(options, 'url', monitorId);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`monitor "${monitorId}": options.url is not a valid URL: ${url}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`monitor "${monitorId}": options.url must be http(s), got ${parsed.protocol}`);
    }
    optionalNumber(options, 'timeout_ms', monitorId, 20_000);
  },

  async fetch(ctx: AdapterContext): Promise<NormalizedRecord[]> {
    const url = requireString(ctx.options, 'url', ctx.monitorId);
    const timeoutMs = optionalNumber(ctx.options, 'timeout_ms', ctx.monitorId, 20_000);

    // Fetch the bytes here rather than letting rss-parser do it, so that an HTTP
    // error reports as "HTTP 503" instead of an opaque parse failure. Knowing
    // *how* a monitor broke is most of the value of the alert.
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);

    const response = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*' },
    });

    if (!response.ok) {
      throw new Error(`feed request failed: HTTP ${response.status} ${response.statusText}`);
    }

    const body = await response.text();
    if (!body.trim()) {
      throw new Error('feed returned an empty body');
    }

    const feed = await parser.parseString(body);
    const items = feed.items ?? [];

    if (items.length === 0) {
      // A feed that parses but carries nothing is a real signal, not a success.
      // Treat it as a failure so it counts toward the alert threshold.
      throw new Error('feed parsed but contained no items');
    }

    const records: NormalizedRecord[] = [];

    for (const item of items) {
      // Dedupe key: prefer the publisher's GUID, fall back to the link. Without
      // one of these we cannot dedupe, so skip rather than insert duplicates.
      const externalId = (item.guid ?? item.link ?? '').trim();
      if (!externalId) {
        ctx.log.warn('skipping feed item with no guid or link', { title: item.title });
        continue;
      }

      const title = (item.title ?? '').trim() || '(untitled)';
      const link = (item.link ?? '').trim() || null;
      const creator =
        (item as { dcCreator?: string }).dcCreator ?? item.creator ?? null;

      records.push({
        externalId,
        title,
        url: link,
        publishedAt: toDate(item.isoDate ?? item.pubDate),
        summary: toPlainText(item.contentSnippet ?? item.content ?? item.summary),
        payload: {
          feed_title: feed.title ?? null,
          author: creator,
          categories: toCategoryNames(item.categories),
        },
      });
    }

    return records;
  },

  // No migrate() or persist(): articles are genuinely document-shaped, so this
  // adapter keeps the spine's shared record store and its dedupe by externalId.

  async renderPanel(ctx: PanelContext) {
    const windowHours = ctx.windowHours;
    const records = await getRecentRecords(ctx.db, {
      hours: windowHours,
      monitorId: ctx.monitorId,
      limit: 200,
    });
    return renderRecordListPanel({ monitorName: ctx.monitorName, records, windowHours });
  },
};

export default adapter;
