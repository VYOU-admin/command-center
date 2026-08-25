/**
 * HTTP fetching for the oil sources.
 *
 * These are small business sites — one is a 1990s frameset, another runs on
 * shared hosting. The monitor must be a considerate visitor: a real user agent
 * that says who we are, a deliberate pause between requests, few retries, and
 * a hard timeout so a hanging socket cannot wedge the run.
 */

import type { Logger } from '../../logger.js';
import type { OilConfig } from './config.js';

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class FetchError extends Error {
  constructor(url: string, detail: string) {
    super(`${url}: ${detail}`);
    this.name = 'FetchError';
  }
}

export interface Fetcher {
  get(url: string, init?: { method?: string; body?: string; formData?: Record<string, string> }): Promise<string>;
  /** Final URL after redirects, for the zip -> slug lookup. */
  lastUrl: string | null;
}

export function createFetcher(cfg: OilConfig, log: Logger, signal: AbortSignal): Fetcher {
  let lastRequestAt = 0;

  const fetcher: Fetcher = {
    lastUrl: null,
    async get(url, init) {
      // Space out requests globally, not per source, so the whole run stays
      // gentle no matter how many sources are enabled.
      const since = Date.now() - lastRequestAt;
      if (lastRequestAt > 0 && since < cfg.requestDelayMs) {
        await sleep(cfg.requestDelayMs - since);
      }

      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= cfg.maxRetries; attempt++) {
        if (attempt > 0) await sleep(cfg.requestDelayMs * attempt);
        lastRequestAt = Date.now();
        try {
          const timeout = AbortSignal.timeout(cfg.timeoutMs);
          const response = await fetch(url, {
            method: init?.method ?? 'GET',
            headers: {
              'user-agent': cfg.userAgent,
              accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'accept-language': 'en-US,en;q=0.9',
              ...(init?.formData
                ? { 'content-type': 'application/x-www-form-urlencoded' }
                : {}),
            },
            ...(init?.formData
              ? { body: new URLSearchParams(init.formData).toString() }
              : init?.body
                ? { body: init.body }
                : {}),
            redirect: 'follow',
            signal: AbortSignal.any([signal, timeout]),
          });

          if (!response.ok) {
            throw new FetchError(url, `HTTP ${response.status} ${response.statusText}`);
          }
          const text = await response.text();
          if (text.trim().length === 0) {
            throw new FetchError(url, 'empty response body');
          }
          fetcher.lastUrl = response.url || url;
          return text;
        } catch (err) {
          lastError = err as Error;
          if (signal.aborted) throw lastError;
          log.warn('oil request failed', {
            url,
            attempt: attempt + 1,
            of: cfg.maxRetries + 1,
            error: lastError.message,
          });
        }
      }
      throw lastError ?? new FetchError(url, 'unknown failure');
    },
  };

  return fetcher;
}
