/**
 * Monitor options for the incremental token update job.
 *
 * Thresholds, floors, fences and per-token wiring live in YAML because they are
 * tuned. Topic hashes and event layouts do not: they are facts about the chain,
 * they are verified against live logs rather than recalled, and a typo in one
 * matches zero logs and reads as a clean run. Those stay in code.
 */

import { configNumber, requireString, section } from '../types.js';

export interface Floors {
  /** Token side must move at least this many RAW units. */
  tokenRawUnits: number;
  /** Paid side must move at least this many RAW units. */
  paidRawUnits: number;
  /** Token amount in whole tokens. Catches a dust leg carrying huge USD. */
  tokenAmount: number;
  /** USD floor. Applies ONLY to rows that have a USD value. */
  usd: number;
}

export interface UpdateConfig {
  chain: string;
  token: string;
  /** Only wallets carrying one of these tags produce rows. */
  cohortTags: string[];
  /** Where the cursor starts when the table has no row yet. */
  seedCursorBlock: number;

  rpcUrlTemplate: string;
  rpcKeyVar: string;
  requestTimeoutMs: number;

  /** Blocks left unread behind the head, so a tip reorg cannot strand rows. */
  lagBlocks: number;
  /** Most blocks one run will advance the cursor by. */
  maxBlocksPerRun: number;
  /** Hard ceiling on compute units for a single run. */
  cuCeiling: number;
  /** Starting span for a getLogs request that may hit the result cap. */
  logSpanBlocks: number;
  /** Never narrow a span below this; below it, throw instead of looping. */
  minLogSpanBlocks: number;

  v3Factory: string;
  v4PoolManager: string;
  /** Counter assets whose own USD price is sound enough to price ours. */
  pricingAssets: string[];
  /** Counter asset treated as dollars directly. */
  usdAsset: string;
  /** Counter assets denominated in the native asset. */
  nativeAssets: string[];

  bucketBlocks: number;
  /** Discard a tick outside this multiple of its bucket's median. */
  tickFenceMultiple: number;
  /** Discard a derived native price outside this multiple of the median. */
  nativeFenceMultiple: number;

  floors: Floors;
  tokenUsdTable: string;
  nativeUsdTable: string;
  alertAfterFailures: number;
}

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;

function requireStringArray(
  options: Record<string, unknown>,
  key: string,
  context: string,
): string[] {
  const value = options[key];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${context}: ${key} must be a non-empty list`);
  }
  return value.map((v, i) => {
    if (typeof v !== 'string' || v.trim() === '') {
      throw new Error(`${context}: ${key}[${i}] must be a non-empty string`);
    }
    return v.trim();
  });
}

/**
 * Table names arrive from config because the live tables are named for the
 * first token loaded (`pons_usd_prices`) and renaming them is a migration, not
 * a config change. They are interpolated into SQL, so they are constrained to
 * a plain identifier here rather than trusted.
 */
function requireTableName(
  options: Record<string, unknown>,
  key: string,
  context: string,
  fallback: string,
): string {
  const value = options[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !TABLE_NAME.test(value)) {
    throw new Error(
      `${context}: ${key} must be a plain table identifier, got: ${String(value)}`,
    );
  }
  return value;
}

export function parseConfig(
  options: Record<string, unknown>,
  monitorId: string,
): UpdateConfig {
  const rpc = section(options, 'rpc');
  const venues = section(options, 'venues');
  const pricing = section(options, 'pricing');
  const floors = section(options, 'floors');
  const tables = section(options, 'tables');

  const cfg: UpdateConfig = {
    chain: requireString(options, 'chain', monitorId),
    token: requireString(options, 'token', monitorId),
    cohortTags: requireStringArray(options, 'cohort_tags', monitorId),
    seedCursorBlock: configNumber(options, 'seed_cursor_block', monitorId, 0),

    rpcUrlTemplate: requireString(rpc, 'url_template', monitorId),
    rpcKeyVar: requireString(rpc, 'key_var', monitorId),
    requestTimeoutMs: configNumber(rpc, 'request_timeout_ms', monitorId, 60_000),
    lagBlocks: configNumber(rpc, 'lag_blocks', monitorId, 200),
    maxBlocksPerRun: configNumber(rpc, 'max_blocks_per_run', monitorId, 40_000),
    cuCeiling: configNumber(rpc, 'cu_ceiling', monitorId, 5_000),
    logSpanBlocks: configNumber(rpc, 'log_span_blocks', monitorId, 18_000),
    minLogSpanBlocks: configNumber(rpc, 'min_log_span_blocks', monitorId, 25),

    v3Factory: requireString(venues, 'v3_factory', monitorId),
    v4PoolManager: requireString(venues, 'v4_pool_manager', monitorId),

    pricingAssets: requireStringArray(pricing, 'assets', monitorId),
    usdAsset: requireString(pricing, 'usd_asset', monitorId),
    nativeAssets: requireStringArray(pricing, 'native_assets', monitorId),
    bucketBlocks: configNumber(pricing, 'bucket_blocks', monitorId, 10_000),
    tickFenceMultiple: configNumber(pricing, 'tick_fence_multiple', monitorId, 100),
    nativeFenceMultiple: configNumber(pricing, 'native_fence_multiple', monitorId, 10),

    floors: {
      tokenRawUnits: configNumber(floors, 'token_raw_units', monitorId, 1),
      paidRawUnits: configNumber(floors, 'paid_raw_units', monitorId, 1),
      tokenAmount: configNumber(floors, 'token_amount', monitorId, 0.001),
      usd: configNumber(floors, 'usd', monitorId, 0.01),
    },

    tokenUsdTable: requireTableName(tables, 'token_usd', monitorId, 'token_usd_prices'),
    nativeUsdTable: requireTableName(tables, 'native_usd', monitorId, 'native_usd_prices'),
    alertAfterFailures: configNumber(options, 'alert_after_failures', monitorId, 3),
  };

  if (cfg.bucketBlocks <= 0) {
    throw new Error(`${monitorId}: pricing.bucket_blocks must be positive`);
  }
  /*
   * The cursor always lands on a bucket boundary, so max_blocks_per_run below
   * one bucket could never advance it and the job would spin forever making
   * zero progress -- a silent stall, not a visible failure.
   */
  if (cfg.maxBlocksPerRun < cfg.bucketBlocks) {
    throw new Error(
      `${monitorId}: rpc.max_blocks_per_run (${cfg.maxBlocksPerRun}) must be at least ` +
        `pricing.bucket_blocks (${cfg.bucketBlocks}), or the cursor can never advance`,
    );
  }
  const known = new Set(cfg.pricingAssets.map((a) => a.toLowerCase()));
  for (const a of [cfg.usdAsset, ...cfg.nativeAssets]) {
    if (!known.has(a.toLowerCase())) {
      throw new Error(`${monitorId}: pricing asset ${a} is not in pricing.assets`);
    }
  }
  return cfg;
}
