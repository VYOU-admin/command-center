/**
 * Configuration for the pump.fun launch monitors.
 *
 * Every threshold, window, and cap lives in the monitor YAML rather than here,
 * because these are the numbers that get tuned against real data — the dense
 * window, the sampling rates, and the retention horizons all change as the
 * dataset grows.
 */

import { configNumber, section } from '../types.js';

export interface StreamConfig {
  /**
   * Silence, in seconds, after which a long-lived socket is force-closed and
   * reconnected. Liveness is measured by data arriving, not by socket state: a
   * half-open socket reports itself connected forever and never fires close.
   */
  streamSilenceReconnectSeconds: number;
  /** PumpPortal data socket. Free tier needs no API key. */
  pumpportalUrl: string;
  /** Solana JSON-RPC websocket, for bonding-curve account subscriptions. */
  rpcUrl: string;
  /**
   * Concurrent accountSubscribe slots. Measured hard cap on the public RPC is
   * 100 per connection: attempting the 101st closes the socket with code 1013.
   */
  maxCurveSubscriptions: number;
  /** How long a token stays instrumented before its slot is recycled. */
  denseWindowMinutes: number;
  /**
   * Instrument every launch whose initial market cap clears the platform
   * default. Above-default initial mcap is the strongest t=0 predictor in the
   * survival literature (Cox HR 4.51), so these are always sampled.
   */
  instrumentMcapSolAbove: number;
  /** Instrument launches advertising a Telegram channel (8.94x graduation lift). */
  instrumentIfTelegram: boolean;
  /**
   * Fraction of launches that fail the filter but get instrumented anyway.
   * This is the control group. Without it the dataset can only describe tokens
   * the filter already liked, and the filter itself becomes unfalsifiable.
   */
  controlSampleRate: number;
  /** Give up on metadata (socials) after this long; the launch row still lands. */
  metadataTimeoutMs: number;
  /** Concurrent metadata fetches in flight. */
  metadataConcurrency: number;
  /** Buffer ceiling per drain. Beyond this, events are dropped and counted. */
  maxBufferedEvents: number;
  /**
   * Fail the monitor if no launch event has arrived in this long. The socket
   * reconnecting cleanly but receiving nothing is the silent-failure case that
   * a plain connection check would miss.
   */
  silenceFailAfterSeconds: number;
}

export interface OutcomeConfig {
  /** No curve movement for this long and never graduated => dead. */
  deathAfterIdleMinutes: number;
  /**
   * A token we never instrumented is called dead once it is this old without a
   * graduation. This is sound because the migration subscription is global: it
   * reports every graduation on the platform, so the absence of one is real
   * evidence rather than merely absence of observation.
   */
  unobservedDeathAfterHours: number;
  /** SOL levels at which trades-taken and seconds-taken are recorded. */
  velocityThresholdsSol: number[];
  /** Token ages, in seconds, at which curve state is snapshotted. */
  snapshotSeconds: number[];
  /** Keep full per-trade samples this long, then collapse to a summary. */
  rawSampleRetentionDays: number;
  /** Graduates are 0.2% of rows, so they keep full fidelity far longer. */
  graduateSampleRetentionDays: number;
  /** Samples for tokens that died without activity are dropped this fast. */
  deadSampleRetentionDays: number;
  /** Rows to touch per maintenance pass, so a run never runs long. */
  maxRowsPerPass: number;
}

export function parseStreamConfig(
  options: Record<string, unknown>,
  monitorId: string,
): StreamConfig {
  const ctx = `monitor "${monitorId}"`;
  const s = section(options, 'sampling');
  const l = section(options, 'limits');

  const pumpportalUrl =
    typeof options['pumpportal_url'] === 'string'
      ? (options['pumpportal_url'] as string).trim()
      : 'wss://pumpportal.fun/api/data';
  const rpcUrl =
    typeof options['rpc_url'] === 'string'
      ? (options['rpc_url'] as string).trim()
      : 'wss://api.mainnet-beta.solana.com';

  for (const [key, url] of [
    ['pumpportal_url', pumpportalUrl],
    ['rpc_url', rpcUrl],
  ] as const) {
    if (!/^wss?:\/\//.test(url)) {
      throw new Error(`${ctx}: options.${key} must be a ws:// or wss:// URL, got "${url}"`);
    }
  }

  const maxCurveSubscriptions = configNumber(l, 'max_curve_subscriptions', ctx, 95);
  if (maxCurveSubscriptions > 100) {
    throw new Error(
      `${ctx}: limits.max_curve_subscriptions is ${maxCurveSubscriptions}, but the RPC ` +
        'closes the connection above 100 concurrent subscriptions. Use 100 or fewer.',
    );
  }

  const streamSilenceReconnectSeconds = configNumber(
    options,
    'stream_silence_reconnect_seconds',
    ctx,
    120,
  );
  const controlSampleRate = configNumber(s, 'control_sample_rate', ctx, 0.1);
  if (controlSampleRate > 1) {
    throw new Error(`${ctx}: sampling.control_sample_rate must be between 0 and 1`);
  }

  return {
    pumpportalUrl,
    rpcUrl,
    maxCurveSubscriptions,
    denseWindowMinutes: configNumber(s, 'dense_window_minutes', ctx, 10),
    instrumentMcapSolAbove: configNumber(s, 'instrument_mcap_sol_above', ctx, 32),
    instrumentIfTelegram: s['instrument_if_telegram'] !== false,
    controlSampleRate,
    streamSilenceReconnectSeconds,
    metadataTimeoutMs: configNumber(l, 'metadata_timeout_ms', ctx, 5000),
    metadataConcurrency: configNumber(l, 'metadata_concurrency', ctx, 6),
    maxBufferedEvents: configNumber(l, 'max_buffered_events', ctx, 20000),
    silenceFailAfterSeconds: configNumber(l, 'silence_fail_after_seconds', ctx, 300),
  };
}

export function parseOutcomeConfig(
  options: Record<string, unknown>,
  monitorId: string,
): OutcomeConfig {
  const ctx = `monitor "${monitorId}"`;
  const r = section(options, 'retention');

  const rawThresholds = options['velocity_thresholds_sol'];
  const velocityThresholdsSol = Array.isArray(rawThresholds)
    ? rawThresholds.map((v, i) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          throw new Error(
            `${ctx}: velocity_thresholds_sol[${i}] must be a positive number, got ${String(v)}`,
          );
        }
        return v;
      })
    : [10, 25, 50];
  if (velocityThresholdsSol.length === 0) {
    throw new Error(`${ctx}: velocity_thresholds_sol must list at least one SOL level`);
  }

  const rawSnapshots = options['snapshot_seconds'];
  const snapshotSeconds = Array.isArray(rawSnapshots)
    ? rawSnapshots.map((v, i) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          throw new Error(
            `${ctx}: snapshot_seconds[${i}] must be a positive number, got ${String(v)}`,
          );
        }
        return v;
      })
    : [30, 60, 120];
  if (snapshotSeconds.length === 0) {
    throw new Error(`${ctx}: snapshot_seconds must list at least one age`);
  }

  return {
    deathAfterIdleMinutes: configNumber(options, 'death_after_idle_minutes', ctx, 60),
    unobservedDeathAfterHours: configNumber(options, 'unobserved_death_after_hours', ctx, 24),
    velocityThresholdsSol,
    snapshotSeconds,
    rawSampleRetentionDays: configNumber(r, 'raw_sample_days', ctx, 30),
    graduateSampleRetentionDays: configNumber(r, 'graduate_sample_days', ctx, 180),
    deadSampleRetentionDays: configNumber(r, 'dead_sample_days', ctx, 7),
    maxRowsPerPass: configNumber(r, 'max_rows_per_pass', ctx, 50000),
  };
}
