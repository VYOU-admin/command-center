/**
 * Configuration for the early-window monitor. Every tunable lives in YAML.
 */

import { configNumber, section } from '../types.js';

export interface EarlyConfig {
  pumpportalUrl: string;
  rpcUrl: string;
  /** pump.fun program, subscribed to program-wide for all trade events. */
  programId: string;
  /**
   * Fraction of BELOW-FLOOR tokens kept as a control past the decision mark.
   * Every launch is tracked from t=0 regardless; this only governs what
   * survives the 10-minute cut.
   */
  controlRate: number;
  /** Seconds after launch at which the keep/stop decision is made. */
  decisionSeconds: number;
  /** Curve SOL at the decision mark above which a token is kept in full. */
  activityFloorSol: number;
  /** Track every graduating token for 6h from GRADUATION, not from launch. */
  trackGraduates: boolean;
  /** How long a token is followed after launch. */
  windowMinutes: number;
  /** No trades for this long ends tracking early. */
  deathAfterIdleMinutes: number;
  /** Guard on memory and write volume, not on any upstream limit. */
  maxConcurrentTracked: number;
  /** Snapshot cadence, densest first: [{untilSeconds, everySeconds}]. */
  cadence: { untilSeconds: number; everySeconds: number }[];
  metadataTimeoutMs: number;
  metadataConcurrency: number;
  /**
   * Ages, in seconds since launch, at which a snapshot is written for every
   * tracked token whether or not it is still trading. These exist so the death
   * rule cannot decide the outcome horizon.
   */
  outcomeMarks: number[];
  /** Days of full-resolution snapshots kept before the middle is collapsed. */
  retentionFullDays: number;
  /** Rows deleted per maintenance pass. */
  retentionMaxRowsPerPass: number;
  /** Tokens collapsed per maintenance pass. Bounds the work, not the backlog. */
  retentionBatchTokens: number;
  /**
   * Hours after launch at which the dense early grid is thinned for tokens that
   * turned out uninteresting. The first tier only collapses carried-forward
   * duplicates in the mid-window, which is a small minority of the rows; the
   * dense sub-minute grid is the bulk, so without this growth is unbounded.
   */
  densePurgeHours: number;
  /** The mark the dense thinning always preserves. Kept in sync with the alert. */
  fiveMinuteMarkSeconds: number;
  /** Minutes between maintenance passes. The drain runs far more often. */
  retentionIntervalMinutes: number;
  /**
   * Silence, in seconds, after which a long-lived socket is force-closed and
   * reconnected. Liveness is measured by data arriving, not by socket state: a
   * half-open socket reports itself connected forever and never fires close.
   */
  streamSilenceReconnectSeconds: number;
  /** How often the SOL/USD rate is refreshed from DexScreener. */
  solPriceRefreshSeconds: number;
  /** How often graduated tokens are enriched from DexScreener. */
  dexRefreshSeconds: number;
  dexBatchSize: number;
  timeoutMs: number;
  maxBufferedSnapshots: number;
  /** Fail the run if no trade event has arrived in this long. */
  silenceFailAfterSeconds: number;
  /**
   * Seconds of ZERO decoded launches, while the stream is otherwise delivering,
   * after which the monitor fails. The watchdog recovers a dead socket on its
   * own, but a stream that is talking normally and yielding no creates means the
   * event layout moved — which no reconnect can fix and a human has to see.
   */
  launchSilenceFailSeconds: number;
}

function str(o: Record<string, unknown>, k: string, d: string): string {
  const v = o[k];
  return typeof v === 'string' && v.trim() ? v.trim() : d;
}

export function parseEarlyConfig(
  options: Record<string, unknown>,
  monitorId: string,
): EarlyConfig {
  const ctx = `monitor "${monitorId}"`;
  const s = section(options, 'sampling');
  const l = section(options, 'limits');
  const e = section(options, 'enrichment');

  const pumpportalUrl = str(options, 'pumpportal_url', 'wss://pumpportal.fun/api/data');
  const rpcUrl = str(options, 'rpc_url', 'wss://api.mainnet-beta.solana.com');
  for (const [k, v] of [['pumpportal_url', pumpportalUrl], ['rpc_url', rpcUrl]] as const) {
    if (!/^wss?:\/\//.test(v)) throw new Error(`${ctx}: options.${k} must be a ws:// or wss:// URL`);
  }

  const controlRate = configNumber(s, 'control_rate', ctx, 0.05);
  if (controlRate > 1) throw new Error(`${ctx}: sampling.control_rate must be between 0 and 1`);
  const decisionSeconds = configNumber(s, 'decision_seconds', ctx, 600);
  const activityFloorSol = configNumber(s, 'activity_floor_sol', ctx, 1);

  const rawCadence = options['cadence'];
  const cadence = Array.isArray(rawCadence) && rawCadence.length
    ? rawCadence.map((c, i) => {
        if (typeof c !== 'object' || c === null || Array.isArray(c)) {
          throw new Error(`${ctx}: cadence[${i}] must be a mapping`);
        }
        const r = c as Record<string, unknown>;
        const until = configNumber(r, 'until_seconds', `${ctx} cadence[${i}]`, 0);
        const every = configNumber(r, 'every_seconds', `${ctx} cadence[${i}]`, 0);
        if (until <= 0 || every <= 0) {
          throw new Error(`${ctx}: cadence[${i}] needs positive until_seconds and every_seconds`);
        }
        return { untilSeconds: until, everySeconds: every };
      })
    : [
        { untilSeconds: 300, everySeconds: 15 },
        { untilSeconds: 600, everySeconds: 30 },
        { untilSeconds: 3600, everySeconds: 60 },
        { untilSeconds: 21600, everySeconds: 300 },
      ];
  // Ascending, so building the mark list is a single forward pass.
  for (let i = 1; i < cadence.length; i++) {
    if (cadence[i]!.untilSeconds <= cadence[i - 1]!.untilSeconds) {
      throw new Error(`${ctx}: cadence until_seconds must increase; entry ${i} does not`);
    }
  }

  const windowMinutes = configNumber(options, 'window_minutes', ctx, 360);
  const lastMark = cadence[cadence.length - 1]!.untilSeconds;
  if (lastMark > windowMinutes * 60) {
    throw new Error(
      `${ctx}: cadence reaches ${lastMark}s but the window is only ${windowMinutes * 60}s`,
    );
  }

  const rawOutcome = options['outcome_marks_seconds'];
  const outcomeMarks = Array.isArray(rawOutcome) && rawOutcome.length
    ? rawOutcome.map((v, i) => {
        if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
          throw new Error(`${ctx}: outcome_marks_seconds[${i}] must be positive`);
        }
        return v;
      })
    : [1800, 3600, 7200, 10800, 21600];

  const r = section(options, 'retention');

  return {
    pumpportalUrl,
    rpcUrl,
    programId: str(options, 'program_id', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    controlRate,
    decisionSeconds,
    activityFloorSol,
    outcomeMarks,
    retentionFullDays: configNumber(r, 'full_resolution_days', ctx, 3),
    retentionMaxRowsPerPass: configNumber(r, 'max_rows_per_pass', ctx, 50000),
    retentionBatchTokens: configNumber(r, 'batch_tokens', ctx, 500),
    densePurgeHours: configNumber(r, 'dense_purge_hours', ctx, 24),
    fiveMinuteMarkSeconds: configNumber(r, 'protect_mark_seconds', ctx, 300),
    streamSilenceReconnectSeconds: configNumber(
      options as Record<string, unknown>,
      'stream_silence_reconnect_seconds',
      ctx,
      120,
    ),
    retentionIntervalMinutes: configNumber(r, 'interval_minutes', ctx, 10),
    trackGraduates: s['track_graduates'] !== false,
    windowMinutes,
    deathAfterIdleMinutes: configNumber(options, 'death_after_idle_minutes', ctx, 60),
    maxConcurrentTracked: configNumber(l, 'max_concurrent_tracked', ctx, 2000),
    cadence,
    metadataTimeoutMs: configNumber(l, 'metadata_timeout_ms', ctx, 5000),
    metadataConcurrency: configNumber(l, 'metadata_concurrency', ctx, 6),
    solPriceRefreshSeconds: configNumber(e, 'sol_price_refresh_seconds', ctx, 300),
    dexRefreshSeconds: configNumber(e, 'dex_refresh_seconds', ctx, 300),
    dexBatchSize: configNumber(e, 'dex_batch_size', ctx, 30),
    timeoutMs: configNumber(l, 'timeout_ms', ctx, 20000),
    maxBufferedSnapshots: configNumber(l, 'max_buffered_snapshots', ctx, 50000),
    silenceFailAfterSeconds: configNumber(l, 'silence_fail_after_seconds', ctx, 300),
    launchSilenceFailSeconds: configNumber(l, 'launch_silence_fail_seconds', ctx, 300),
  };
}

/**
 * Snapshot marks in seconds since launch, up to `horizon`.
 *
 * Generated against a horizon rather than a fixed array because a token that
 * graduates late is tracked for six hours from GRADUATION, which can run past
 * six hours from launch. The final cadence band simply repeats to cover it.
 */
export function buildMarks(cfg: EarlyConfig, horizonSeconds: number): number[] {
  const marks: number[] = [];
  let from = 0;
  for (const step of cfg.cadence) {
    const until = Math.min(step.untilSeconds, horizonSeconds);
    for (let t = from + step.everySeconds; t <= until; t += step.everySeconds) marks.push(t);
    from = step.untilSeconds;
    if (from >= horizonSeconds) break;
  }
  // Extend with the last band so a late graduation is still covered.
  const last = cfg.cadence[cfg.cadence.length - 1]!;
  for (let t = Math.max(from, last.untilSeconds) + last.everySeconds; t <= horizonSeconds; t += last.everySeconds) {
    marks.push(t);
  }
  for (const m of cfg.outcomeMarks) {
    if (m <= horizonSeconds && !marks.includes(m)) marks.push(m);
  }
  marks.sort((a, b) => a - b);
  return marks;
}
