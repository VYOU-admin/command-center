/**
 * The intake runner's plan: configuration, phases, STOP points, per-phase
 * compute-unit ceilings, and the state that lets a phase resume after a STOP.
 *
 * WHY THIS EXISTS. The PONS intake was carried out by ad-hoc scripts in a
 * scratchpad directory. The container recycled and every one of them was lost;
 * only docs/ROBINHOOD.md survived. This is that procedure as code,
 * in the repository, so the next token does not start from prose.
 *
 * EVERY STOP IN THE DOCUMENT IS A STOP HERE. The runner reports and exits at
 * each one rather than proceeding. They sit where a wrong answer is cheap to
 * correct and expensive to carry forward: scope, cohort membership and pricing
 * each propagate into everything downstream.
 *
 * EVERY PHASE HAS A COMPUTE-UNIT CEILING SET BEFORE IT STARTS. An account cap
 * protects the wallet; only an in-job ceiling protects against a phase whose
 * scope was wrong from its first request. A phase that reaches its ceiling stops
 * and reports where it stopped.
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type { PoolClient } from '../store/db.js';

export const PHASES = [
  'identity',
  'windows',
  'pools',
  'scope',
  'sweep',
  'conventions',
  'cohort',
  'tags',
  'timestamps',
  'prices',
  'dryrun',
  'write',
] as const;

export type Phase = (typeof PHASES)[number];

/**
 * Phases that end by reporting and waiting for review. Taken directly from the
 * step order in docs/ROBINHOOD.md:
 *
 *   pools    -- the pool set decides what is swept and what is missed
 *   scope    -- the counter-asset decision decides every price downstream
 *   cohort   -- before anything is written to wallet_tags
 *   prices   -- before any USD figure is attached to a row
 *   dryrun   -- the counts for the write, before the write
 */
export const STOP_AFTER: ReadonlySet<Phase> = new Set<Phase>([
  'pools',
  'scope',
  'cohort',
  'prices',
  'dryrun',
]);

export interface IntakeWindow {
  label: string;
  /** ISO 8601 with an explicit offset. A bare local time is rejected. */
  start: string;
  end: string;
  startBlock?: number;
  endBlock?: number;
}

export interface IntakeConfig {
  chain: string;
  token: string;
  ticker: string;
  chartedPair: string | null;
  windows: IntakeWindow[];

  rpcUrlTemplate: string;
  rpcKeyVar: string;
  requestTimeoutMs: number;
  minLogSpanBlocks: number;
  /**
   * Starting span for a DENSE filter -- swaps and transfers. Measured on this
   * account: 100,000 blocks succeeds, 250,000 is refused with "Log response
   * size exceeded". The limit is response SIZE, so it belongs to the filter and
   * not to the endpoint.
   */
  maxLogSpanBlocks: number;
  /**
   * Starting span for a SPARSE filter -- pool creation events filtered to one
   * token. Measured on AI: Initialize filtered to the token returned 4,615 logs
   * across 40,000,000 blocks in ONE call. Carrying the dense constant here cost
   * ~1,864 calls where 8 sufficed, a 230x overshoot.
   */
  sparseLogSpanBlocks: number;
  /** Target logs per request; the sweeper sizes spans to hit this. */
  targetLogsPerRequest: number;

  v3Factory: string;
  v4PoolManager: string;
  pricingAssets: string[];
  usdAsset: string;
  nativeAssets: string[];
  /** Second-hop assets: priced from their OWN pools against a pricing asset. */
  bridgeAssets: string[];

  /** Minimum distinct recipients before an address is even probed. */
  routerMinRecipients: number;
  /** Share of an address's sends that must sit inside a swap transaction. */
  routerMinSwapShare: number;

  /** Blocks per slice wherever stored logs are read back. One value, one place. */
  sliceBlocks: number;
  /** Stop and report above this many pools rather than reading them all. */
  maxPools: number;
  /** An implied token price above this fails the USD-total sanity check. */
  impliedPriceCeiling: number;

  bucketBlocks: number;
  bucketOrigin: number;
  tickFenceMultiple: number;
  nativeFenceMultiple: number;

  floors: {
    tokenRawUnits: number;
    paidRawUnits: number;
    tokenAmount: number;
    usd: number;
  };

  tokenUsdTable: string;
  nativeUsdTable: string;

  /** Compute-unit ceiling per phase, by phase name. */
  ceilings: Record<Phase, number>;
}

const DEFAULT_CEILINGS: Record<Phase, number> = {
  identity: 1_000,
  windows: 5_000,
  pools: 250_000,
  scope: 100_000,
  sweep: 4_000_000,
  conventions: 50_000,
  cohort: 600_000,
  tags: 0,
  timestamps: 2_000_000,
  prices: 0,
  dryrun: 0,
  write: 0,
};

const TABLE_NAME = /^[a-z_][a-z0-9_]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** An instant must carry a zone. "2026-08-07 04:00" is ambiguous, so it fails. */
const ZONED = /(Z|[+-]\d{2}:?\d{2})$/;

function req<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null || value === '') {
    throw new Error(`intake config: ${what} is required`);
  }
  return value;
}

function num(section: Record<string, unknown>, key: string, fallback: number): number {
  const v = section[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    throw new Error(`intake config: ${key} must be a number >= 0, got ${String(v)}`);
  }
  return v;
}

function obj(source: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = source[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function strList(source: Record<string, unknown>, key: string): string[] {
  const v = source[key];
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error(`intake config: ${key} must be a non-empty list`);
  }
  return v.map((x, i) => {
    if (typeof x !== 'string' || !x.trim()) {
      throw new Error(`intake config: ${key}[${i}] must be a non-empty string`);
    }
    return x.trim();
  });
}

export async function loadIntakeConfig(path: string): Promise<IntakeConfig> {
  const raw = parseYaml(await readFile(path, 'utf8')) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw new Error(`${path}: expected a YAML mapping`);

  const rpc = obj(raw, 'rpc');
  const venues = obj(raw, 'venues');
  const pricing = obj(raw, 'pricing');
  const floors = obj(raw, 'floors');
  const tables = obj(raw, 'tables');
  const ceilings = obj(raw, 'ceilings');

  const token = String(req(raw['token'], 'token'));
  if (!ADDRESS.test(token)) throw new Error(`intake config: token is not an EVM address`);

  const rawWindows = raw['windows'];
  if (!Array.isArray(rawWindows) || rawWindows.length === 0) {
    throw new Error('intake config: at least one window is required');
  }
  /*
   * MULTIPLE WINDOWS ARE SUPPORTED. The PONS intake had exactly one, so this
   * path was never exercised there; a token whose accumulation happened in two
   * separate periods needs both, and each produces its own tag.
   */
  const windows: IntakeWindow[] = rawWindows.map((w, i) => {
    const entry = w as Record<string, unknown>;
    const label = String(req(entry['label'], `windows[${i}].label`));
    const start = String(req(entry['start'], `windows[${i}].start`));
    const end = String(req(entry['end'], `windows[${i}].end`));
    for (const [k, v] of [['start', start], ['end', end]] as const) {
      if (!ZONED.test(v)) {
        throw new Error(
          `intake config: windows[${i}].${k} "${v}" has no timezone offset. ` +
            'A bare local time means a different instant depending on who reads it.',
        );
      }
      if (Number.isNaN(Date.parse(v))) {
        throw new Error(`intake config: windows[${i}].${k} "${v}" is not a valid instant`);
      }
    }
    if (Date.parse(end) <= Date.parse(start)) {
      throw new Error(`intake config: windows[${i}] ends at or before it starts`);
    }
    return { label, start, end };
  });

  const labels = new Set(windows.map((w) => w.label));
  if (labels.size !== windows.length) {
    throw new Error('intake config: two windows share a label; tags would collide');
  }

  const table = (key: string, fallback: string): string => {
    const v = tables[key];
    if (v === undefined || v === null) return fallback;
    if (typeof v !== 'string' || !TABLE_NAME.test(v)) {
      throw new Error(`intake config: tables.${key} must be a plain identifier`);
    }
    return v;
  };

  const cfg: IntakeConfig = {
    chain: String(req(raw['chain'], 'chain')),
    token,
    ticker: String(req(raw['ticker'], 'ticker')),
    chartedPair: typeof raw['charted_pair'] === 'string' ? raw['charted_pair'] : null,
    windows,

    rpcUrlTemplate: String(req(rpc['url_template'], 'rpc.url_template')),
    rpcKeyVar: String(req(rpc['key_var'], 'rpc.key_var')),
    requestTimeoutMs: num(rpc, 'request_timeout_ms', 120_000),
    minLogSpanBlocks: num(rpc, 'min_log_span_blocks', 25),
    maxLogSpanBlocks: num(rpc, 'max_log_span_blocks', 100_000),
    sparseLogSpanBlocks: num(rpc, 'sparse_log_span_blocks', 40_000_000),
    targetLogsPerRequest: num(rpc, 'target_logs_per_request', 6_000),

    v3Factory: String(req(venues['v3_factory'], 'venues.v3_factory')),
    v4PoolManager: String(req(venues['v4_pool_manager'], 'venues.v4_pool_manager')),

    pricingAssets: strList(pricing, 'assets'),
    usdAsset: String(req(pricing['usd_asset'], 'pricing.usd_asset')),
    nativeAssets: strList(pricing, 'native_assets'),
    bridgeAssets: (() => {
      const v = pricing['bridge_assets'];
      if (v === undefined || v === null) return [];
      if (!Array.isArray(v)) throw new Error('pricing.bridge_assets must be a list');
      return v.map((x) => String(x).trim());
    })(),
    sliceBlocks: num(rpc, 'slice_blocks', 500_000),
    maxPools: num(raw, 'max_pools', 2_000),
    impliedPriceCeiling: num(raw, 'implied_price_ceiling', 1_000_000),
    routerMinRecipients: num(obj(raw, 'routers'), 'min_recipients', 50),
    routerMinSwapShare: num(obj(raw, 'routers'), 'min_swap_share', 0.5),

    bucketBlocks: num(pricing, 'bucket_blocks', 10_000),
    bucketOrigin: num(pricing, 'bucket_origin', 0),
    tickFenceMultiple: num(pricing, 'tick_fence_multiple', 100),
    nativeFenceMultiple: num(pricing, 'native_fence_multiple', 10),

    floors: {
      tokenRawUnits: num(floors, 'token_raw_units', 1),
      paidRawUnits: num(floors, 'paid_raw_units', 1),
      tokenAmount: num(floors, 'token_amount', 0.001),
      usd: num(floors, 'usd', 0.01),
    },

    tokenUsdTable: table('token_usd', 'token_usd_prices'),
    nativeUsdTable: table('native_usd', 'native_usd_prices'),

    ceilings: Object.fromEntries(
      PHASES.map((p) => [p, num(ceilings, p, DEFAULT_CEILINGS[p])]),
    ) as Record<Phase, number>,
  };

  const known = new Set(cfg.pricingAssets.map((a) => a.toLowerCase()));
  for (const a of [cfg.usdAsset, ...cfg.nativeAssets]) {
    if (!known.has(a.toLowerCase())) {
      throw new Error(`intake config: pricing asset ${a} is not in pricing.assets`);
    }
  }
  return cfg;
}

/* ------------------------------------------------------------------------- */

export const STATE_SCHEMA = `
create table if not exists token_intake_state (
  chain      text        not null,
  token      text        not null,
  phase      text        not null,
  status     text        not null,
  detail     jsonb       not null default '{}'::jsonb,
  cu_spent   bigint      not null default 0,
  updated_at timestamptz not null default now(),
  primary key (chain, token, phase)
);
`;

export interface PhaseRecord {
  phase: Phase;
  status: 'complete' | 'stopped' | 'failed';
  detail: Record<string, unknown>;
  cuSpent: number;
}

export async function readPhase(
  client: PoolClient,
  chain: string,
  token: string,
  phase: Phase,
): Promise<PhaseRecord | null> {
  const res = await client.query<{
    status: string;
    detail: Record<string, unknown>;
    cu_spent: number;
  }>(
    `select status, detail, cu_spent from token_intake_state
      where chain = $1 and token = $2 and phase = $3`,
    [chain, token, phase],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    phase,
    status: row.status as PhaseRecord['status'],
    detail: row.detail,
    cuSpent: Number(row.cu_spent),
  };
}

export async function writePhase(
  client: PoolClient,
  chain: string,
  token: string,
  record: PhaseRecord,
): Promise<void> {
  await client.query(
    `insert into token_intake_state (chain, token, phase, status, detail, cu_spent, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, now())
     on conflict (chain, token, phase) do update
       set status = excluded.status,
           detail = excluded.detail,
           cu_spent = excluded.cu_spent,
           updated_at = now()`,
    [chain, token, record.phase, record.status, JSON.stringify(record.detail), record.cuSpent],
  );
}
