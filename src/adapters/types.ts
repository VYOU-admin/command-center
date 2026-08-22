/**
 * The ingest contract. This is the one interface that has to stay stable as
 * sources are added: a source fetches from somewhere and returns normalized
 * records. It knows nothing about Postgres, the dashboard, or Discord.
 */

import type { Logger } from '../logger.js';

export interface NormalizedRecord {
  /**
   * Stable identity of this item *within its monitor*. Reruns must produce the
   * same value for the same item — that is what makes dedupe work. For RSS this
   * is the article GUID.
   */
  externalId: string;
  title: string;
  url: string | null;
  publishedAt: Date | null;
  summary: string | null;
  /** Source-specific extras, stored as jsonb. Keep it small. */
  payload: Record<string, unknown>;
}

export interface AdapterContext {
  monitorId: string;
  /** The `options` block from the monitor's YAML, already validated. */
  options: Record<string, unknown>;
  log: Logger;
  /** Aborted when the run exceeds its timeout; adapters should honour it. */
  signal: AbortSignal;
}

export interface SourceAdapter {
  /** Matches the `source:` field in monitor YAML. Must be unique. */
  readonly type: string;

  /**
   * Called once per monitor at boot. Throw on bad config so a typo fails the
   * deploy loudly instead of showing up as a silently broken monitor later.
   */
  validate(options: Record<string, unknown>, monitorId: string): void;

  fetch(ctx: AdapterContext): Promise<NormalizedRecord[]>;
}

/** Small helpers so each adapter is not rewriting option parsing. */

export function requireString(
  options: Record<string, unknown>,
  key: string,
  monitorId: string,
): string {
  const value = options[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`monitor "${monitorId}": options.${key} must be a non-empty string`);
  }
  return value.trim();
}

export function optionalNumber(
  options: Record<string, unknown>,
  key: string,
  monitorId: string,
  fallback: number,
): number {
  const value = options[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`monitor "${monitorId}": options.${key} must be a positive number`);
  }
  return value;
}
