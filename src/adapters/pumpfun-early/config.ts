/**
 * Configuration for the early-window monitor. Every tunable lives in YAML.
 */

import { configNumber, section } from '../types.js';

export interface EarlyConfig {
  pumpportalUrl: string;
  rpcUrl: string;
  /** pump.fun program, subscribed to program-wide for all trade events. */
  programId: string;
  /** Fraction of new launches drawn at random at the create event. */
  sampleRate: number;
  /** Track every graduating token for whatever remains of its window. */
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
  /** How often the SOL/USD rate is refreshed from DexScreener. */
  solPriceRefreshSeconds: number;
  /** How often graduated tokens are enriched from DexScreener. */
  dexRefreshSeconds: number;
  dexBatchSize: number;
  timeoutMs: number;
  maxBufferedSnapshots: number;
  /** Fail the run if no trade event has arrived in this long. */
  silenceFailAfterSeconds: number;
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

  const sampleRate = configNumber(s, 'rate', ctx, 0.05);
  if (sampleRate > 1) throw new Error(`${ctx}: sampling.rate must be between 0 and 1`);

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

  return {
    pumpportalUrl,
    rpcUrl,
    programId: str(options, 'program_id', '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P'),
    sampleRate,
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
  };
}

/** Snapshot marks in seconds, built once from the cadence. */
export function buildMarks(cfg: EarlyConfig): number[] {
  const marks: number[] = [];
  let from = 0;
  for (const step of cfg.cadence) {
    for (let t = from + step.everySeconds; t <= step.untilSeconds; t += step.everySeconds) {
      marks.push(t);
    }
    from = step.untilSeconds;
  }
  return marks;
}
