/**
 * Solana new-token tracking.
 *
 * Two ingest stages, both free and key-less:
 *   1. Wide net  — DexScreener. Discover newly-listed Solana tokens, then poll
 *                  metrics for the entire tracked universe.
 *   2. Narrow pass — RugCheck. For candidates clearing the configured floors,
 *                  enrich with authority, LP, and holder data, then score.
 *
 * Two things about the shape of this are worth knowing:
 *
 * DexScreener has no endpoint that enumerates a chain's pairs by age — only
 * per-token, per-pair, search (which returns mature pairs), and the "latest
 * profiles/boosts" feeds. So the universe is *accumulated*: every Solana token
 * ever seen in those feeds is tracked from then on, and tokens age into the
 * scoring window naturally. Coverage grows over days and is biased toward
 * tokens that appear in those feeds. It is not an exhaustive view of the chain.
 *
 * Tracking deliberately continues past the scoring window. The age band gates
 * *candidacy*, not *observation* — a token dropped at 7 days could never answer
 * "did it still have liquidity at day 7".
 */

import {
  configNumber,
  optionalNumber,
  section,
  type AdapterContext,
  type PanelContext,
  type SourceAdapter,
} from './types.js';
import type { PoolClient } from '../store/db.js';
import { renderSolanaPanel } from '../web/solana-panel.js';

const DEXSCREENER = 'https://api.dexscreener.com';
const RUGCHECK = 'https://api.rugcheck.xyz/v1';
const USER_AGENT = 'command-center-monitor/0.1 (+https://github.com/VYOU-admin/command-center)';

/** DexScreener accepts up to 30 comma-separated addresses per request. */
const BATCH_SIZE = 30;

export interface Floors {
  liquidityUsd: number;
  volume24h: number;
  volumeToMcap: number;
  liquidityToMcap: number;
  txns1h: number;
}

export interface Weights {
  mintRenounced: number;
  freezeRenounced: number;
  lpLocked: number;
  holderDistribution: number;
  liquidityDepth: number;
  dispersion: number;
}

interface Config {
  minAgeHours: number;
  maxAgeHours: number;
  floors: Floors;
  weights: Weights;
  /** Unrenounced mint authority multiplies the final score by this. */
  mintNotRenouncedMultiplier: number;
  /** liquidity/mcap ratio treated as a full-marks depth score. */
  liquidityDepthTarget: number;
  /** Holder count treated as full marks for dispersion. */
  dispersionHolderTarget: number;
  /** Minimum fraction of scoring weight that must be measurable to score at all. */
  minCompleteness: number;
  maxTracked: number;
  maxEnrichPerRun: number;
  /**
   * Monitor id whose graduated pump.fun tokens join this monitor's universe.
   * Null disables it and leaves discovery on the DexScreener feeds alone.
   */
  graduateSource: string | null;
  /** How far back to pull graduates on each run. */
  graduateLookbackHours: number;
  topN: number;
  alertCooldownHours: number;
  requestDelayMs: number;
  timeoutMs: number;
}

export interface TokenObservation {
  mint: string;
  symbol: string | null;
  name: string | null;
  pairAddress: string | null;
  dexId: string | null;
  pairUrl: string | null;
  launchAt: Date | null;
  ageHours: number | null;
  liquidityUsd: number | null;
  volume24h: number | null;
  volume1h: number | null;
  mcap: number | null;
  fdv: number | null;
  priceUsd: number | null;
  txns1h: number | null;
  txns24h: number | null;
  buys1h: number | null;
  sells1h: number | null;
  inAgeWindow: boolean;
  passedFloors: boolean;
  enriched: boolean;
  holders: number | null;
  top10Pct: number | null;
  insiderPct: number | null;
  lpLockedPct: number | null;
  mintRenounced: boolean | null;
  freezeRenounced: boolean | null;
  usdPerHolder: number | null;
  score: number | null;
  /** Fraction of total scoring weight that was actually measurable, 0-1. */
  completeness: number | null;
  breakdown: Record<string, number | null> | null;
}

/* ------------------------------------------------------------------ config */

function parseConfig(options: Record<string, unknown>, monitorId: string): Config {
  const ctx = `monitor "${monitorId}"`;
  const f = section(options, 'floors');
  const w = section(options, 'weights');
  const s = section(options, 'scoring');
  const l = section(options, 'limits');
  const a = section(options, 'alerts');
  const d = section(options, 'discovery');

  const weights: Weights = {
    mintRenounced: configNumber(w, 'mint_renounced', ctx, 25),
    freezeRenounced: configNumber(w, 'freeze_renounced', ctx, 10),
    lpLocked: configNumber(w, 'lp_locked', ctx, 25),
    holderDistribution: configNumber(w, 'holder_distribution', ctx, 15),
    liquidityDepth: configNumber(w, 'liquidity_depth', ctx, 10),
    dispersion: configNumber(w, 'dispersion', ctx, 15),
  };

  const total = Object.values(weights).reduce((sum, n) => sum + n, 0);
  if (total <= 0) throw new Error(`${ctx}: weights must sum to more than 0`);

  const minAgeHours = configNumber(options, 'min_age_hours', ctx, 6);
  const maxAgeHours = configNumber(options, 'max_age_hours', ctx, 24 * 7);
  if (minAgeHours >= maxAgeHours) {
    throw new Error(`${ctx}: min_age_hours (${minAgeHours}) must be below max_age_hours (${maxAgeHours})`);
  }

  return {
    minAgeHours,
    maxAgeHours,
    floors: {
      liquidityUsd: configNumber(f, 'liquidity_usd', ctx, 15_000),
      volume24h: configNumber(f, 'volume_24h_usd', ctx, 25_000),
      volumeToMcap: configNumber(f, 'volume_to_mcap', ctx, 0.3),
      liquidityToMcap: configNumber(f, 'liquidity_to_mcap', ctx, 0.1),
      txns1h: configNumber(f, 'txns_1h', ctx, 100),
    },
    weights,
    mintNotRenouncedMultiplier: configNumber(s, 'mint_not_renounced_multiplier', ctx, 0.25),
    liquidityDepthTarget: configNumber(s, 'liquidity_depth_target', ctx, 0.4),
    dispersionHolderTarget: configNumber(s, 'dispersion_holder_target', ctx, 2000),
    minCompleteness: configNumber(s, 'min_completeness', ctx, 0.5),
    maxTracked: configNumber(l, 'max_tracked', ctx, 400),
    graduateSource:
      typeof d['pumpfun_monitor_id'] === 'string' && d['pumpfun_monitor_id'].trim()
        ? (d['pumpfun_monitor_id'] as string).trim()
        : null,
    graduateLookbackHours: configNumber(d, 'graduate_lookback_hours', ctx, 24 * 14),
    maxEnrichPerRun: configNumber(l, 'max_enrich_per_run', ctx, 25),
    requestDelayMs: configNumber(l, 'request_delay_ms', ctx, 250),
    timeoutMs: optionalNumber(l, 'timeout_ms', monitorId, 20_000),
    topN: configNumber(a, 'top_n', ctx, 20),
    alertCooldownHours: configNumber(a, 're_entry_cooldown_hours', ctx, 24),
  };
}

/* ------------------------------------------------------------------- utils */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function num(value: unknown): number | null {
  const n = typeof value === 'string' ? Number.parseFloat(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

async function getJson(
  url: string,
  ctx: AdapterContext,
  timeoutMs: number,
): Promise<unknown> {
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
  const response = await fetch(url, {
    signal,
    redirect: 'follow',
    headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} from ${new URL(url).host}`);
  }
  return response.json();
}

/* --------------------------------------------------------------- discovery */

/** DexScreener's "latest" feeds, which are the only free path to new tokens. */
const DISCOVERY_FEEDS = [
  `${DEXSCREENER}/token-profiles/latest/v1`,
  `${DEXSCREENER}/token-boosts/latest/v1`,
  `${DEXSCREENER}/token-boosts/top/v1`,
];

/**
 * Graduated pump.fun tokens, from the launch monitor's tables.
 *
 * This is the fix for a known bias. DexScreener's only free path to new tokens
 * is its "latest profiles/boosts" feeds, which list tokens whose developers paid
 * for visibility — so the universe accumulated from them over-represents exactly
 * the launches with a marketing budget. Graduates are selected by the market
 * instead, and by the time a token graduates it has a real pair with real
 * liquidity, which is what everything downstream here already assumes.
 *
 * Pre-graduation launches are deliberately NOT pulled in: at ~70k/day they would
 * swamp the tracked universe, and none of them have the DEX pair, liquidity, or
 * age that this monitor's floors are written against.
 */
async function discoverGraduates(ctx: AdapterContext, cfg: Config): Promise<string[]> {
  if (!cfg.graduateSource) return [];
  try {
    const result = await ctx.db.query(
      `select mint from pump_launches
        where monitor_id = $1
          and outcome = 'graduated'
          and graduated_at > now() - ($2 || ' hours')::interval
        order by graduated_at desc
        limit $3`,
      [cfg.graduateSource, cfg.graduateLookbackHours, cfg.maxTracked],
    );
    return result.rows.map((r: { mint: string }) => r.mint);
  } catch (err) {
    // The launch monitor may not be deployed, in which case its tables do not
    // exist. That must not take down discovery — this monitor has to keep
    // working standalone, exactly as it did before.
    ctx.log.warn('graduate discovery unavailable, continuing with feeds only', {
      source: cfg.graduateSource,
      error: (err as Error).message,
    });
    return [];
  }
}

async function discover(ctx: AdapterContext, cfg: Config): Promise<Set<string>> {
  const found = new Set<string>();
  let failures = 0;

  for (const url of DISCOVERY_FEEDS) {
    try {
      const body = await getJson(url, ctx, cfg.timeoutMs);
      const entries = Array.isArray(body) ? body : [];
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        if (e['chainId'] !== 'solana') continue;
        const address = e['tokenAddress'];
        if (typeof address === 'string' && address.trim()) found.add(address.trim());
      }
    } catch (err) {
      failures += 1;
      ctx.log.warn('discovery feed failed', { url, error: (err as Error).message });
    }
    await sleep(cfg.requestDelayMs);
  }

  const fromFeeds = found.size;
  const graduates = await discoverGraduates(ctx, cfg);
  for (const mint of graduates) found.add(mint);

  ctx.log.info('discovery complete', {
    discovered: found.size,
    from_feeds: fromFeeds,
    from_graduates: graduates.length,
    feeds_failed: failures,
  });
  return found;
}

async function loadTracked(ctx: AdapterContext, limit: number): Promise<string[]> {
  const result = await ctx.db.query(
    `select mint from solana_tokens
      where monitor_id = $1
      order by last_seen_at desc nulls last, first_seen_at desc
      limit $2`,
    [ctx.monitorId, limit],
  );
  return result.rows.map((r: { mint: string }) => r.mint);
}

/* ----------------------------------------------------------------- metrics */

interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number }>;
  volume?: Record<string, number>;
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
}

/** A token can have many pairs; the deepest one is the meaningful market. */
function bestPair(pairs: DexPair[]): DexPair | null {
  let best: DexPair | null = null;
  for (const pair of pairs) {
    if (pair.chainId !== 'solana') continue;
    const liq = pair.liquidity?.usd ?? 0;
    if (!best || liq > (best.liquidity?.usd ?? 0)) best = pair;
  }
  return best;
}

async function fetchMetrics(
  ctx: AdapterContext,
  cfg: Config,
  mints: string[],
): Promise<Map<string, DexPair>> {
  const byMint = new Map<string, DexPair[]>();
  let failedChunks = 0;

  for (let i = 0; i < mints.length; i += BATCH_SIZE) {
    const chunk = mints.slice(i, i + BATCH_SIZE);
    try {
      const body = (await getJson(
        `${DEXSCREENER}/latest/dex/tokens/${chunk.join(',')}`,
        ctx,
        cfg.timeoutMs,
      )) as { pairs?: DexPair[] | null };
      for (const pair of body.pairs ?? []) {
        const address = pair.baseToken?.address;
        if (!address) continue;
        const list = byMint.get(address) ?? [];
        list.push(pair);
        byMint.set(address, list);
      }
    } catch (err) {
      failedChunks += 1;
      ctx.log.warn('metrics chunk failed', {
        chunk_start: i,
        chunk_size: chunk.length,
        error: (err as Error).message,
      });
    }
    if (i + BATCH_SIZE < mints.length) await sleep(cfg.requestDelayMs);
  }

  // Every chunk failing means DexScreener is down, not that nothing matched.
  // Let that surface as a run failure rather than an empty, healthy-looking run.
  const chunks = Math.ceil(mints.length / BATCH_SIZE);
  if (chunks > 0 && failedChunks === chunks) {
    throw new Error(`all ${chunks} DexScreener metric requests failed`);
  }

  const best = new Map<string, DexPair>();
  for (const [mint, pairs] of byMint) {
    const pick = bestPair(pairs);
    if (pick) best.set(mint, pick);
  }
  return best;
}

function toObservation(mint: string, pair: DexPair, now: number): TokenObservation {
  const launchMs = pair.pairCreatedAt ?? null;
  const ageHours = launchMs === null ? null : (now - launchMs) / 3_600_000;
  const txns1h = pair.txns?.['h1'];
  const txns24h = pair.txns?.['h24'];

  return {
    mint,
    symbol: pair.baseToken?.symbol ?? null,
    name: pair.baseToken?.name ?? null,
    pairAddress: pair.pairAddress ?? null,
    dexId: pair.dexId ?? null,
    pairUrl: pair.url ?? null,
    launchAt: launchMs === null ? null : new Date(launchMs),
    ageHours,
    liquidityUsd: num(pair.liquidity?.usd),
    volume24h: num(pair.volume?.['h24']),
    volume1h: num(pair.volume?.['h1']),
    mcap: num(pair.marketCap),
    fdv: num(pair.fdv),
    priceUsd: num(pair.priceUsd),
    txns1h: txns1h ? (txns1h.buys ?? 0) + (txns1h.sells ?? 0) : null,
    txns24h: txns24h ? (txns24h.buys ?? 0) + (txns24h.sells ?? 0) : null,
    buys1h: txns1h?.buys ?? null,
    sells1h: txns1h?.sells ?? null,
    inAgeWindow: false,
    passedFloors: false,
    enriched: false,
    holders: null,
    top10Pct: null,
    insiderPct: null,
    lpLockedPct: null,
    mintRenounced: null,
    freezeRenounced: null,
    usdPerHolder: null,
    score: null,
    completeness: null,
    breakdown: null,
  };
}

/** The hard floors. All must pass; any failure disqualifies. */
function passesFloors(o: TokenObservation, floors: Floors): boolean {
  const liq = o.liquidityUsd ?? 0;
  const vol = o.volume24h ?? 0;
  const mcap = o.mcap ?? 0;
  if (liq < floors.liquidityUsd) return false;
  if (vol < floors.volume24h) return false;
  if ((o.txns1h ?? 0) < floors.txns1h) return false;
  // Ratio floors are meaningless without a market cap, so treat it as failing.
  if (mcap <= 0) return false;
  if (vol / mcap < floors.volumeToMcap) return false;
  if (liq / mcap < floors.liquidityToMcap) return false;
  return true;
}

/* -------------------------------------------------------------- enrichment */

interface RugcheckReport {
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  totalHolders?: number;
  topHolders?: { pct?: number; insider?: boolean }[];
  markets?: { lp?: { lpLockedPct?: number; lpLockedUSD?: number } }[];
  rugged?: boolean;
}

async function enrich(
  ctx: AdapterContext,
  cfg: Config,
  observation: TokenObservation,
): Promise<void> {
  const report = (await getJson(
    `${RUGCHECK}/tokens/${observation.mint}/report`,
    ctx,
    cfg.timeoutMs,
  )) as RugcheckReport;

  // RugCheck reports a null/empty authority when it has been renounced, which
  // is the outcome we want to reward.
  const mintAuth = report.mintAuthority;
  const freezeAuth = report.freezeAuthority;
  observation.mintRenounced = mintAuth === null || mintAuth === undefined || mintAuth === '';
  observation.freezeRenounced = freezeAuth === null || freezeAuth === undefined || freezeAuth === '';

  observation.holders = typeof report.totalHolders === 'number' ? report.totalHolders : null;

  const top = Array.isArray(report.topHolders) ? report.topHolders : [];
  if (top.length > 0) {
    observation.top10Pct = Number(
      top.slice(0, 10).reduce((sum, h) => sum + (h.pct ?? 0), 0).toFixed(4),
    );
    observation.insiderPct = Number(
      top.filter((h) => h.insider).reduce((sum, h) => sum + (h.pct ?? 0), 0).toFixed(4),
    );
  }

  // A token can trade on several markets; the deepest locked LP is the one
  // that actually protects holders.
  let lpLockedPct: number | null = null;
  for (const market of report.markets ?? []) {
    const pct = market.lp?.lpLockedPct;
    if (typeof pct === 'number' && (lpLockedPct === null || pct > lpLockedPct)) lpLockedPct = pct;
  }
  observation.lpLockedPct = lpLockedPct;

  if (observation.holders && observation.holders > 0 && observation.volume24h !== null) {
    observation.usdPerHolder = Number((observation.volume24h / observation.holders).toFixed(4));
  }

  observation.enriched = true;
}

/* ----------------------------------------------------------------- scoring */

/**
 * Score 0-100, renormalised over the components that could actually be measured.
 *
 * This matters because RugCheck's holder fields are unreliable: `totalHolders`
 * and `topHolders` come back populated sometimes and zeroed other times for the
 * very same mint, minutes apart. Scoring an absent value as zero would conflate
 * "this token is badly distributed" with "we could not see its distribution",
 * and would cap every score near 70 — making a "scoring 80+" question
 * unanswerable regardless of how good a token actually was.
 *
 * So each component reports whether it was measurable, the score is the
 * weighted average over the measurable ones, and `completeness` records what
 * fraction of the total weight that covered. A score is only meaningful read
 * alongside its completeness, which is why both are stored and both are shown.
 *
 * Dispersion uses holder count rather than unique trading wallets: no free API
 * exposes unique traders, and holders are rent-funded on-chain accounts that
 * cost real SOL to create — far harder to fake than transaction counts, which
 * volume bots inflate in lockstep with volume itself.
 */
function score(o: TokenObservation, cfg: Config): void {
  if (!o.enriched) return;
  const w = cfg.weights;

  const parts = [
    {
      key: 'mintRenounced',
      weight: w.mintRenounced,
      available: o.mintRenounced !== null,
      value: o.mintRenounced ? 1 : 0,
    },
    {
      key: 'freezeRenounced',
      weight: w.freezeRenounced,
      available: o.freezeRenounced !== null,
      value: o.freezeRenounced ? 1 : 0,
    },
    {
      key: 'lpLocked',
      weight: w.lpLocked,
      available: o.lpLockedPct !== null,
      value: clamp01((o.lpLockedPct ?? 0) / 100),
    },
    {
      key: 'holderDistribution',
      weight: w.holderDistribution,
      available: o.top10Pct !== null,
      // Insider-held supply is discounted on top of raw concentration.
      value: clamp01(1 - (o.top10Pct ?? 100) / 100) * clamp01(1 - (o.insiderPct ?? 0) / 100),
    },
    {
      key: 'liquidityDepth',
      weight: w.liquidityDepth,
      available: o.mcap !== null && o.mcap > 0 && o.liquidityUsd !== null,
      value:
        o.mcap && o.mcap > 0 && o.liquidityUsd !== null
          ? clamp01(o.liquidityUsd / o.mcap / cfg.liquidityDepthTarget)
          : 0,
    },
    {
      key: 'dispersion',
      weight: w.dispersion,
      available: o.holders !== null && o.holders > 0,
      value:
        o.holders && o.holders > 0
          ? clamp01(Math.log10(o.holders) / Math.log10(Math.max(cfg.dispersionHolderTarget, 10)))
          : 0,
    },
  ];

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  const measurable = parts.filter((p) => p.available);
  const measuredWeight = measurable.reduce((sum, p) => sum + p.weight, 0);

  o.completeness = totalWeight > 0 ? Number((measuredWeight / totalWeight).toFixed(4)) : 0;

  // Too little of the picture to call it a score at all.
  if (measuredWeight <= 0 || o.completeness < cfg.minCompleteness) {
    o.breakdown = Object.fromEntries(
      parts.map((p) => [p.key, p.available ? Number(p.value.toFixed(4)) : null]),
    );
    return;
  }

  let raw = (measurable.reduce((sum, p) => sum + p.value * p.weight, 0) / measuredWeight) * 100;

  // A live mint authority means supply can be inflated at will. Penalised only
  // when we positively know it is live — never on missing data.
  if (o.mintRenounced === false) raw *= cfg.mintNotRenouncedMultiplier;

  o.score = Math.round(clamp01(raw / 100) * 100);
  o.breakdown = Object.fromEntries(
    parts.map((p) => [p.key, p.available ? Number(p.value.toFixed(4)) : null]),
  );
}

/* ------------------------------------------------------------------ schema */

export const SCHEMA = `
create table if not exists solana_tokens (
  monitor_id    text        not null,
  mint          text        not null,
  symbol        text,
  name          text,
  pair_address  text,
  dex_id        text,
  pair_url      text,
  launch_at     timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz,
  primary key (monitor_id, mint)
);

-- Append-only. One row per token per poll, never updated, never overwritten.
-- This is what makes retrospective questions answerable: "of tokens scoring 80+
-- at hour 12, how many still had liquidity at day 7" is a query over this table.
create table if not exists solana_token_observations (
  id                         bigserial primary key,
  monitor_id                 text        not null,
  mint                       text        not null,
  checked_at                 timestamptz not null default now(),
  age_hours                  numeric,
  liquidity_usd              numeric,
  volume_24h                 numeric,
  volume_1h                  numeric,
  mcap                       numeric,
  fdv                        numeric,
  price_usd                  numeric,
  txns_1h                    integer,
  txns_24h                   integer,
  buys_1h                    integer,
  sells_1h                   integer,
  in_age_window              boolean     not null default false,
  passed_floors              boolean     not null default false,
  enriched                   boolean     not null default false,
  holders                    integer,
  top10_pct                  numeric,
  insider_pct                numeric,
  lp_locked_pct              numeric,
  mint_authority_renounced   boolean,
  freeze_authority_renounced boolean,
  usd_per_holder             numeric,
  score                      integer,
  -- Fraction of scoring weight that was measurable. A score is only meaningful
  -- read alongside this: RugCheck's holder fields come and go.
  completeness               numeric,
  score_breakdown            jsonb
);

create index if not exists solana_obs_mint_time_idx
  on solana_token_observations (monitor_id, mint, checked_at desc);
create index if not exists solana_obs_time_idx
  on solana_token_observations (monitor_id, checked_at desc);
create index if not exists solana_obs_score_idx
  on solana_token_observations (monitor_id, score desc nulls last, checked_at desc);

-- Top-N membership, so entry alerts fire on edges rather than on every run.
create table if not exists solana_top_membership (
  monitor_id      text        not null,
  mint            text        not null,
  in_top          boolean     not null default false,
  last_entered_at timestamptz,
  last_exited_at  timestamptz,
  last_alerted_at timestamptz,
  primary key (monitor_id, mint)
);
`;

/* ----------------------------------------------------------------- persist */

interface MembershipRow {
  mint: string;
  in_top: boolean;
  last_exited_at: Date | null;
}

async function handleTopEntryAlerts(
  ctx: AdapterContext,
  client: PoolClient,
  cfg: Config,
  rows: TokenObservation[],
): Promise<void> {
  const scored = rows
    .filter((r) => r.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, cfg.topN);

  const existing = await client.query(
    'select mint, in_top, last_exited_at from solana_top_membership where monitor_id = $1',
    [ctx.monitorId],
  );
  const previous = new Map<string, MembershipRow>(
    existing.rows.map((r: MembershipRow) => [r.mint, r]),
  );

  // No membership recorded at all means this is the first scored run. Seed it
  // silently — otherwise a fresh deploy fires topN alerts at once.
  const seeding = previous.size === 0;
  const now = new Date();
  const cooldownMs = cfg.alertCooldownHours * 3_600_000;
  const topMints = new Set(scored.map((r) => r.mint));

  for (const row of scored) {
    const prior = previous.get(row.mint);
    const wasIn = prior?.in_top ?? false;
    if (wasIn) continue; // still in the top N — re-ranking is not an event

    const exitedAt = prior?.last_exited_at ?? null;
    const cooledDown = !exitedAt || now.getTime() - exitedAt.getTime() >= cooldownMs;
    const shouldAlert = !seeding && cooledDown;

    if (shouldAlert) ctx.queueAlert(buildEntryAlert(ctx, row, cfg));

    await client.query(
      `insert into solana_top_membership
         (monitor_id, mint, in_top, last_entered_at, last_alerted_at)
       values ($1, $2, true, $3, $4)
       on conflict (monitor_id, mint) do update set
         in_top          = true,
         last_entered_at = $3,
         last_alerted_at = coalesce($4, solana_top_membership.last_alerted_at)`,
      [ctx.monitorId, row.mint, now, shouldAlert ? now : null],
    );
  }

  // Anything that was in the top and no longer is has exited; record when, so
  // the re-entry cooldown has something to measure from.
  for (const [mint, row] of previous) {
    if (row.in_top && !topMints.has(mint)) {
      await client.query(
        `update solana_top_membership
            set in_top = false, last_exited_at = $3
          where monitor_id = $1 and mint = $2`,
        [ctx.monitorId, mint, now],
      );
    }
  }

  if (seeding && scored.length > 0) {
    ctx.log.info('seeded top-N membership without alerting', { seeded: scored.length });
  }
}

function fmtUsd(value: number | null): string {
  if (value === null) return '—';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function fmtAge(hours: number | null): string {
  if (hours === null) return 'unknown';
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function buildEntryAlert(ctx: AdapterContext, o: TokenObservation, cfg: Config) {
  const label = o.symbol ? `${o.symbol}` : o.mint.slice(0, 8);
  return {
    level: 'warning' as const,
    title: `${label} entered the top ${cfg.topN} — score ${o.score}`,
    description:
      `\`${o.mint}\`\n` +
      (o.pairUrl ? `[View on DexScreener](${o.pairUrl})` : '') +
      `\n\nMonitor \`${ctx.monitorId}\``,
    fields: [
      { name: 'Score', value: `**${o.score}**/100`, inline: true },
      { name: 'Age', value: fmtAge(o.ageHours), inline: true },
      { name: 'Liquidity', value: fmtUsd(o.liquidityUsd), inline: true },
      { name: '24h volume', value: fmtUsd(o.volume24h), inline: true },
      { name: 'Market cap', value: fmtUsd(o.mcap), inline: true },
      { name: 'Txns 1h', value: String(o.txns1h ?? '—'), inline: true },
      {
        name: 'Authorities',
        value: `mint ${o.mintRenounced ? 'renounced ✓' : '**LIVE ✗**'} · freeze ${o.freezeRenounced ? 'renounced ✓' : 'live ✗'}`,
        inline: false,
      },
      {
        name: 'LP locked',
        value: o.lpLockedPct === null ? '—' : `${o.lpLockedPct.toFixed(1)}%`,
        inline: true,
      },
      { name: 'Holders', value: o.holders === null ? '—' : o.holders.toLocaleString('en-US'), inline: true },
      {
        name: 'Top-10 held',
        value: o.top10Pct === null ? '—' : `${o.top10Pct.toFixed(1)}%`,
        inline: true,
      },
      {
        // Without this, a score built on half the signals looks identical to one
        // built on all of them.
        name: 'Signal coverage',
        value:
          o.completeness === null
            ? '—'
            : `${Math.round(o.completeness * 100)}% of scoring weight measurable` +
              (o.holders === null || o.holders === 0 ? ' (holder data unavailable)' : ''),
        inline: false,
      },
    ],
  };
}

/* ----------------------------------------------------------------- adapter */

const adapter: SourceAdapter<TokenObservation> = {
  type: 'solana-tokens',

  validate(options, monitorId) {
    parseConfig(options, monitorId);
  },

  async migrate(client) {
    await client.query(SCHEMA);
  },

  async fetch(ctx) {
    const cfg = parseConfig(ctx.options, ctx.monitorId);
    const now = Date.now();

    const [discovered, tracked] = await Promise.all([
      discover(ctx, cfg),
      loadTracked(ctx, cfg.maxTracked),
    ]);

    // Newly discovered tokens take priority over the tail of the tracked set,
    // so the universe cap never blocks new arrivals from entering.
    const universe: string[] = [...discovered];
    for (const mint of tracked) {
      if (universe.length >= cfg.maxTracked) break;
      if (!discovered.has(mint)) universe.push(mint);
    }

    if (universe.length === 0) {
      throw new Error('no tokens to poll: discovery returned nothing and nothing is tracked yet');
    }

    const pairs = await fetchMetrics(ctx, cfg, universe);
    const observations: TokenObservation[] = [];
    for (const [mint, pair] of pairs) observations.push(toObservation(mint, pair, now));

    // The age band gates candidacy only. Observation continues past it, because
    // "did it survive to day 7" needs rows from day 7.
    const candidates: TokenObservation[] = [];
    for (const o of observations) {
      o.inAgeWindow =
        o.ageHours !== null && o.ageHours >= cfg.minAgeHours && o.ageHours <= cfg.maxAgeHours;
      o.passedFloors = passesFloors(o, cfg.floors);
      if (o.inAgeWindow && o.passedFloors) candidates.push(o);
    }

    // Best candidates first, so the enrichment cap spends its budget well.
    candidates.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
    const toEnrich = candidates.slice(0, cfg.maxEnrichPerRun);

    let enrichFailures = 0;
    for (const candidate of toEnrich) {
      try {
        await enrich(ctx, cfg, candidate);
        score(candidate, cfg);
      } catch (err) {
        enrichFailures += 1;
        ctx.log.warn('enrichment failed', {
          mint: candidate.mint,
          error: (err as Error).message,
        });
      }
      await sleep(cfg.requestDelayMs);
    }

    ctx.log.info('solana run summary', {
      discovered: discovered.size,
      universe: universe.length,
      observed: observations.length,
      in_age_window: observations.filter((o) => o.inAgeWindow).length,
      passed_floors: candidates.length,
      enriched: toEnrich.length - enrichFailures,
      enrich_failures: enrichFailures,
      scored: observations.filter((o) => o.score !== null).length,
    });

    return observations;
  },

  async persist(ctx, client, rows) {
    const cfg = parseConfig(ctx.options, ctx.monitorId);
    const now = new Date();

    for (const o of rows) {
      await client.query(
        `insert into solana_tokens
           (monitor_id, mint, symbol, name, pair_address, dex_id, pair_url, launch_at, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         on conflict (monitor_id, mint) do update set
           symbol       = coalesce(excluded.symbol, solana_tokens.symbol),
           name         = coalesce(excluded.name, solana_tokens.name),
           pair_address = coalesce(excluded.pair_address, solana_tokens.pair_address),
           dex_id       = coalesce(excluded.dex_id, solana_tokens.dex_id),
           pair_url     = coalesce(excluded.pair_url, solana_tokens.pair_url),
           launch_at    = coalesce(solana_tokens.launch_at, excluded.launch_at),
           last_seen_at = excluded.last_seen_at`,
        [
          ctx.monitorId, o.mint, o.symbol, o.name, o.pairAddress,
          o.dexId, o.pairUrl, o.launchAt, now,
        ],
      );

      await client.query(
        `insert into solana_token_observations
           (monitor_id, mint, checked_at, age_hours, liquidity_usd, volume_24h, volume_1h,
            mcap, fdv, price_usd, txns_1h, txns_24h, buys_1h, sells_1h, in_age_window,
            passed_floors, enriched, holders, top10_pct, insider_pct, lp_locked_pct,
            mint_authority_renounced, freeze_authority_renounced, usd_per_holder,
            score, completeness, score_breakdown)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
                 $21,$22,$23,$24,$25,$26,$27)`,
        [
          ctx.monitorId, o.mint, now, o.ageHours, o.liquidityUsd, o.volume24h, o.volume1h,
          o.mcap, o.fdv, o.priceUsd, o.txns1h, o.txns24h, o.buys1h, o.sells1h, o.inAgeWindow,
          o.passedFloors, o.enriched, o.holders, o.top10Pct, o.insiderPct, o.lpLockedPct,
          o.mintRenounced, o.freezeRenounced, o.usdPerHolder, o.score, o.completeness,
          o.breakdown ? JSON.stringify(o.breakdown) : null,
        ],
      );
    }

    await handleTopEntryAlerts(ctx, client, cfg, rows);

    // Append-only: every observation is a new row, so the run's "new records"
    // count is simply how many were written.
    return rows.length;
  },

  async renderPanel(ctx: PanelContext) {
    return renderSolanaPanel(ctx);
  },
};

export default adapter;
export { parseConfig };
