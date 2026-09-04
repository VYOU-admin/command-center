/**
 * The ingest contract.
 *
 * v1 assumed every source produced document-shaped records that the spine could
 * store in one shared table. The Solana monitor disproved that: it needs
 * append-only time series, where the same token must write a new row on every
 * poll — the exact opposite of the document store's "one row per id, never
 * overwrite" rule.
 *
 * So storage shape is now the adapter's business. A source may declare its own
 * tables (`migrate`), its own write path (`persist`), and its own dashboard
 * panel (`renderPanel`). Sources that are genuinely document-shaped, like RSS,
 * declare none of these and get the shared behaviour for free.
 *
 * The pump.fun monitor extended the same idea to liveness. Its source is a
 * persistent websocket rather than a request, which fits none of `fetch()`'s
 * assumptions. Rather than fork the spine into polled and streaming monitors,
 * the adapter holds the socket and buffers events, and its scheduled `fetch()`
 * drains the buffer. Scheduling, health, and alerting then work on a stream
 * unchanged — a drain that finds the socket dead or silent simply throws.
 *
 * The spine keeps what is genuinely common to every source: scheduling, the
 * run registry, health, and failure/recovery alerting.
 */

import type { Logger } from '../logger.js';
import type { Alert } from '../sinks/discord.js';
import type { PlatformInfo } from '../env.js';
import type { Pool, PoolClient } from '../store/db.js';

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
  monitorName: string;
  /** The `options` block from the monitor's YAML, already validated. */
  options: Record<string, unknown>;
  log: Logger;
  /** Aborted when the run exceeds its timeout; adapters should honour it. */
  signal: AbortSignal;
  /**
   * Read access for adapters that maintain their own state — the Solana
   * monitor needs its tracked universe before it can decide what to poll.
   */
  db: Pool;
  /**
   * Platform identity from the environment. Present so an adapter can ask the
   * hosting provider about the infrastructure it runs on instead of being told
   * in configuration -- a constant in YAML is a claim, not a measurement.
   */
  platform: PlatformInfo;
  /**
   * Queue a Discord alert. Deliberately queued rather than sent: alerts are
   * raised inside the persist transaction but must not perform network I/O
   * while holding it open, so the scheduler flushes them after the commit.
   *
   * Defaults to the monitor's own `alerts.channel`. The override exists for
   * adapters that scrape several sources in one run: one source breaking is an
   * operational failure and belongs in the system channel, even though that
   * monitor's content alerts go somewhere topic-specific.
   */
  queueAlert(alert: Alert, channel?: string): void;
}

export interface PanelContext {
  db: Pool;
  monitorId: string;
  monitorName: string;
  options: Record<string, unknown>;
  /** The monitor's configured dashboard window, from its `dashboard:` block. */
  windowHours: number;
}

export interface SourceAdapter<TRecord = NormalizedRecord> {
  /** Matches the `source:` field in monitor YAML. Must be unique. */
  readonly type: string;

  /**
   * Called once per monitor at boot. Throw on bad config so a typo fails the
   * deploy loudly instead of showing up as a silently broken monitor later.
   */
  validate(options: Record<string, unknown>, monitorId: string): void;

  fetch(ctx: AdapterContext): Promise<TRecord[]>;

  /** Create any tables this source owns. Run at boot, after the core schema. */
  migrate?(client: PoolClient): Promise<void>;

  /**
   * Write a run's records. Returns how many rows were newly stored, which is
   * what the registry reports as the run's new-record count. Omit to get the
   * shared document store with dedupe by `externalId`.
   */
  persist?(ctx: AdapterContext, client: PoolClient, records: TRecord[]): Promise<number>;

  /** Render this source's dashboard section. Omit for the default record list. */
  renderPanel?(ctx: PanelContext): Promise<string>;

  /**
   * Release anything held between runs. Polled sources own nothing outside a
   * run and omit this; a source backed by a persistent connection uses it so a
   * Railway SIGTERM closes the socket and flushes buffered events rather than
   * dropping one drain interval's worth of data.
   */
  shutdown?(): Promise<void>;
}

/** The spine handles adapters without knowing their record type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyAdapter = SourceAdapter<any>;

/* Option helpers, so each adapter is not rewriting config parsing. */

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

/** Read a nested config object, e.g. options.floors.liquidity_usd. */
export function section(
  options: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = options[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Numbers from YAML that may legitimately be zero (a floor of 0 disables it),
 * so this accepts 0 where optionalNumber does not.
 */
export function configNumber(
  options: Record<string, unknown>,
  key: string,
  context: string,
  fallback: number,
): number {
  const value = options[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context}: ${key} must be a number >= 0, got ${String(value)}`);
  }
  return value;
}
