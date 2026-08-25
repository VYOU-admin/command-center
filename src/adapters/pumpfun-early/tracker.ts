/**
 * Which tokens are followed, what is remembered about each, and when a
 * snapshot is due.
 *
 * State is per token and cumulative: counters only ever move forward, and the
 * unique-wallet sets are the reason this monitor needs the trade stream rather
 * than curve state. A snapshot is a copy of that state at a scheduled age, so a
 * token with no trades between two marks still produces two rows carrying the
 * same figures — the flat stretch is data, not a gap.
 */

import type { Logger } from '../../logger.js';
import { buildMarks, type EarlyConfig } from './config.js';
import { TOTAL_SUPPLY, type Trade } from './trades.js';

export interface LaunchInfo {
  mint: string;
  deployer: string | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  bondingCurve: string | null;
  pool: string | null;
  signature: string | null;
  launchedAt: Date;
  initialMcapSol: number | null;
  initialVSol: number | null;
}

/**
 * 'early'    — inside the first 10 minutes; every launch is here.
 * 'extended' — kept past the decision mark, full state, snapshots on the grid.
 * 'outcome'  — dropped at the decision mark, but still emits the forced outcome
 *              marks so the death rule cannot decide the outcome horizon.
 */
export type Phase = 'early' | 'extended' | 'outcome';

export interface TrackedToken extends LaunchInfo {
  sampleReason: 'all' | 'graduate';
  phase: Phase;
  /** Why it survived the decision mark: 'activity' | 'control' | null. */
  keepReason: string | null;
  decidedAt: Date | null;
  curveSolAtDecision: number | null;
  socialsFetched: boolean;
  hasTelegram: boolean | null;
  hasTwitter: boolean | null;
  hasWebsite: boolean | null;
  websiteIsSelf: boolean | null;
  graduated: boolean;
  graduatedAt: Date | null;
  trackingEndsAt: number;
  /** Marks for this token, regenerated if its horizon extends on graduation. */
  marks: number[];
  /** Marks already emitted, so a snapshot is never written twice. */
  nextMarkIndex: number;
  lastTradeAt: number;
  /** Cumulative trade count as of the previous snapshot, for has_market. */
  lastSnapshotTrades: number;
  /** lastTradeAt as last written to the database, so updates stay bounded. */
  persistedTradeAt: number | null;
  /* cumulative */
  trades: number;
  buys: number;
  sells: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buyers: Set<string>;
  sellers: Set<string>;
  largestBuySol: number;
  /* last known curve state, carried between trades */
  curveSol: number;
  virtualSol: number;
  tokenReserves: number;
  virtualTokenReserves: number;
  mcapSol: number;
  priceSol: number;
  /* post-graduation enrichment, refreshed on its own cadence */
  dexLiquidityUsd: number | null;
  dexVolume24h: number | null;
  dexTxns24h: number | null;
  dexPriceUsd: number | null;
}

export interface Snapshot {
  mint: string;
  snapshotAt: Date;
  secondsSinceLaunch: number;
  phase: Phase;
  /** A forced mark, written regardless of trading state. Never pruned. */
  isOutcomeMark: boolean;
  curveSol: number;
  virtualSol: number;
  tokenReserves: number;
  virtualTokenReserves: number;
  mcapSol: number;
  priceSol: number;
  mcapUsd: number | null;
  priceUsd: number | null;
  solUsd: number | null;
  trades: number;
  buys: number;
  sells: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  largestBuySol: number | null;
  postGraduation: boolean;
  dexLiquidityUsd: number | null;
  dexVolume24h: number | null;
  dexTxns24h: number | null;
  dexPriceUsd: number | null;
  /** Which price regime produced priceUsdEffective: 'curve' or 'dex'. */
  priceSource: 'curve' | 'dex';
  /** The single column return analysis should read. Null when unavailable. */
  priceUsdEffective: number | null;
  /** False when no trade arrived since the previous snapshot. */
  hasMarket: boolean;
}

/**
 * The 10-minute decision, written when it is made rather than when the token
 * resolves six hours later. Which arm a token is in — kept on activity, kept as
 * a control, or dropped — is the comparison the control group exists to make,
 * and a restart before resolution would otherwise lose it. The snapshot 'phase'
 * column cannot substitute: both kept arms are 'extended'.
 */
export interface Decision {
  mint: string;
  keepReason: string | null;
  decidedAt: Date;
  curveSolAtDecision: number;
}

export interface Resolution {
  mint: string;
  died: boolean;
  diedAt: Date | null;
  stopReason: string;
  snapshotCount: number;
  keepReason: string | null;
  curveSolAtDecision: number | null;
  decidedAt: Date | null;
}

/**
 * Sampling is a hash of the mint, not a coin flip. Membership has to be
 * reproducible months later — otherwise the sample cannot be audited, and
 * "was this token in the sample" becomes unanswerable.
 */
export function stableUnitHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

export class Tracker {
  private readonly tracked = new Map<string, TrackedToken>();
  /** Launch times for every launch seen, so a graduate's age is known. */
  private readonly launchSeen = new Map<string, LaunchInfo>();
  private deniedByCap = 0;
  private snapshotsDropped = 0;
  private graduationsUntracked = 0;
  private keptActivity = 0;
  private keptControl = 0;
  private stopped = 0;

  constructor(
    private readonly cfg: EarlyConfig,
    private readonly log: Logger,
  ) {}

  get size(): number {
    return this.tracked.size;
  }

  /**
   * EVERY launch is tracked from t=0. There is no sampling here — the
   * program-wide subscription already receives these trades, so what to keep is
   * decided at the 10-minute mark once the token has shown what it does.
   *
   * This is also what makes a graduate's early features real: by the time it
   * graduates it has been recorded from second zero, so nothing is back-filled.
   */
  noteLaunch(info: LaunchInfo): TrackedToken | null {
    this.launchSeen.set(info.mint, info);
    if (this.launchSeen.size > 60_000) {
      const cutoff = Date.now() - this.cfg.windowMinutes * 60_000 * 2;
      for (const [mint, seen] of this.launchSeen) {
        if (seen.launchedAt.getTime() < cutoff) this.launchSeen.delete(mint);
      }
    }
    return this.adopt(info, 'all');
  }

  /**
   * A graduate is tracked for six hours from GRADUATION, not from launch, so
   * the interesting part of its life is not cut off by a window that started
   * before it became tradeable.
   *
   * It is never adopted here. Every launch is already tracked from t=0, so a
   * graduate we witnessed launching already holds genuine early snapshots. One
   * whose launch predates this monitor is skipped rather than adopted with
   * back-filled marks — that back-fill is what made earlier graduate features
   * unusable.
   */
  noteGraduation(mint: string, at: Date): TrackedToken | null {
    const t = this.tracked.get(mint);
    if (!t) {
      this.graduationsUntracked++;
      return null;
    }
    t.graduated = true;
    t.graduatedAt = at;
    if (!this.cfg.trackGraduates) return t;

    // Extend the window to graduation + the full tracking period, and promote
    // it out of 'outcome' if the decision mark had already dropped it.
    const extended = at.getTime() + this.cfg.windowMinutes * 60_000;
    if (extended > t.trackingEndsAt) {
      t.trackingEndsAt = extended;
      const horizon = (extended - t.launchedAt.getTime()) / 1000;
      t.marks = buildMarks(this.cfg, horizon);
    }
    if (t.phase === 'outcome') {
      t.phase = 'extended';
      t.keepReason = 'graduated';
    }
    return t;
  }

  private adopt(info: LaunchInfo, reason: 'all' | 'graduate'): TrackedToken | null {
    if (this.tracked.has(info.mint)) return this.tracked.get(info.mint)!;
    const endsAt = info.launchedAt.getTime() + this.cfg.windowMinutes * 60_000;
    if (endsAt <= Date.now()) return null; // window already over

    if (this.tracked.size >= this.cfg.maxConcurrentTracked) {
      this.deniedByCap++;
      return null;
    }

    const t: TrackedToken = {
      ...info,
      sampleReason: reason,
      phase: 'early',
      keepReason: null,
      decidedAt: null,
      curveSolAtDecision: null,
      marks: buildMarks(this.cfg, this.cfg.windowMinutes * 60),
      socialsFetched: false,
      hasTelegram: null,
      hasTwitter: null,
      hasWebsite: null,
      websiteIsSelf: null,
      graduated: false,
      graduatedAt: null,
      trackingEndsAt: endsAt,
      nextMarkIndex: 0,
      lastTradeAt: Date.now(),
      lastSnapshotTrades: 0,
      persistedTradeAt: null,
      trades: 0,
      buys: 0,
      sells: 0,
      buyVolumeSol: 0,
      sellVolumeSol: 0,
      buyers: new Set(),
      sellers: new Set(),
      largestBuySol: 0,
      curveSol: 0,
      virtualSol: info.initialVSol ?? 0,
      tokenReserves: 0,
      virtualTokenReserves: 0,
      mcapSol: info.initialMcapSol ?? 0,
      priceSol: (info.initialMcapSol ?? 0) / TOTAL_SUPPLY,
      dexLiquidityUsd: null,
      dexVolume24h: null,
      dexTxns24h: null,
      dexPriceUsd: null,
    };
    this.tracked.set(info.mint, t);
    return t;
  }

  /** Fold one trade into a tracked token. Untracked mints are ignored. */
  applyTrade(trade: Trade): void {
    const t = this.tracked.get(trade.mint);
    if (!t) return;
    t.trades++;
    t.lastTradeAt = Date.now();
    if (trade.isBuy) {
      t.buys++;
      t.buyVolumeSol += trade.solAmount;
      t.buyers.add(trade.user);
      if (trade.solAmount > t.largestBuySol) t.largestBuySol = trade.solAmount;
    } else {
      t.sells++;
      t.sellVolumeSol += trade.solAmount;
      t.sellers.add(trade.user);
    }
    t.curveSol = trade.realSol;
    t.virtualSol = trade.virtualSol;
    t.tokenReserves = trade.realToken;
    t.virtualTokenReserves = trade.virtualToken;
    t.mcapSol = trade.mcapSol;
    t.priceSol = trade.priceSol;
  }

  /**
   * Emit every snapshot now due, and resolve tokens whose window has closed or
   * which have gone quiet long enough to call dead.
   */
  collect(
    now: number,
    solUsd: number | null,
  ): { snapshots: Snapshot[]; resolved: Resolution[]; decided: Decision[] } {
    const snapshots: Snapshot[] = [];
    const resolved: Resolution[] = [];
    const decided: Decision[] = [];
    const idleMs = this.cfg.deathAfterIdleMinutes * 60_000;
    const outcome = new Set(this.cfg.outcomeMarks);

    for (const [mint, t] of this.tracked) {
      const ageMs = now - t.launchedAt.getTime();
      const ageSec = ageMs / 1000;

      // THE DECISION. Every launch is recorded for the first ten minutes; at
      // that point the token has shown whether anything is happening, and only
      // then is it decided what to keep. Sampling before this point would throw
      // away the early history of tokens that later turn out to matter.
      if (t.phase === 'early' && ageSec >= this.cfg.decisionSeconds) {
        t.decidedAt = new Date(now);
        t.curveSolAtDecision = t.curveSol;
        if (t.curveSol > this.cfg.activityFloorSol) {
          t.phase = 'extended';
          t.keepReason = 'activity';
          this.keptActivity++;
        } else if (stableUnitHash(mint) < this.cfg.controlRate) {
          t.phase = 'extended';
          t.keepReason = 'control';
          this.keptControl++;
        } else {
          t.phase = 'outcome';
          t.keepReason = null;
          this.stopped++;
          // Release the heavy state. ~86% of launches land here and are held
          // for six more hours only to emit five outcome rows; keeping their
          // wallet sets would dominate memory for no analytical gain.
          t.buyers = new Set();
          t.sellers = new Set();
        }
        decided.push({
          mint,
          keepReason: t.keepReason,
          decidedAt: t.decidedAt,
          curveSolAtDecision: t.curveSolAtDecision,
        });
      }

      while (t.nextMarkIndex < t.marks.length && t.marks[t.nextMarkIndex]! <= ageSec) {
        const mark = t.marks[t.nextMarkIndex]!;
        t.nextMarkIndex++;
        const isOutcome = outcome.has(mark);
        // Marks inside the first ten minutes are UNCONDITIONAL. Every launch is
        // recorded there and the decision at 600s must not retroactively erase
        // them — which it would if a delayed drain let a token cross the
        // decision mark before its early marks had been emitted.
        const isEarlyWindow = mark <= this.cfg.decisionSeconds;
        if (t.phase === 'outcome' && !isOutcome && !isEarlyWindow) continue;
        if (snapshots.length >= this.cfg.maxBufferedSnapshots) {
          this.snapshotsDropped++;
          continue;
        }
        const hasMarket = t.trades > t.lastSnapshotTrades;
        t.lastSnapshotTrades = t.trades;
        const priceSource: 'curve' | 'dex' = t.graduated ? 'dex' : 'curve';
        const priceUsdEffective =
          priceSource === 'dex'
            ? t.dexPriceUsd
            : solUsd === null
              ? null
              : t.priceSol * solUsd;

        snapshots.push({
          mint,
          snapshotAt: new Date(now),
          secondsSinceLaunch: mark,
          // Label by the mark's own position, not the token's current phase: a
          // 90-second row is an early-window row even if it was written after
          // the token had already been dropped.
          phase: isEarlyWindow ? 'early' : t.phase,
          isOutcomeMark: isOutcome,
          priceSource,
          priceUsdEffective,
          hasMarket,
          curveSol: t.curveSol,
          virtualSol: t.virtualSol,
          tokenReserves: t.tokenReserves,
          virtualTokenReserves: t.virtualTokenReserves,
          mcapSol: t.mcapSol,
          priceSol: t.priceSol,
          mcapUsd: solUsd === null ? null : t.mcapSol * solUsd,
          priceUsd: solUsd === null ? null : t.priceSol * solUsd,
          solUsd,
          trades: t.trades,
          buys: t.buys,
          sells: t.sells,
          buyVolumeSol: t.buyVolumeSol,
          sellVolumeSol: t.sellVolumeSol,
          uniqueBuyers: t.buyers.size,
          uniqueSellers: t.sellers.size,
          largestBuySol: t.largestBuySol > 0 ? t.largestBuySol : null,
          postGraduation: t.graduated,
          dexLiquidityUsd: t.dexLiquidityUsd,
          dexVolume24h: t.dexVolume24h,
          dexTxns24h: t.dexTxns24h,
          dexPriceUsd: t.dexPriceUsd,
        });
      }

      // Tracking ends only at the window's end, or when a token that has
      // already been dropped goes quiet. A token still inside its window is
      // never released early, because its outcome marks are still owed.
      const windowOver = now >= t.trackingEndsAt;
      const exhausted = t.nextMarkIndex >= t.marks.length;
      const quietAndDropped =
        t.phase === 'outcome' && now - t.lastTradeAt >= idleMs && exhausted;
      if (windowOver || quietAndDropped) {
        resolved.push({
          mint,
          died: now - t.lastTradeAt >= idleMs,
          diedAt: now - t.lastTradeAt >= idleMs ? new Date(t.lastTradeAt + idleMs) : null,
          stopReason: windowOver ? 'window_complete' : 'idle',
          snapshotCount: t.nextMarkIndex,
          keepReason: t.keepReason,
          curveSolAtDecision: t.curveSolAtDecision,
          decidedAt: t.decidedAt,
        });
        this.tracked.delete(mint);
      }
    }

    return { snapshots, resolved, decided };
  }

  /**
   * Tokens whose last trade time has moved since it was last written. Keeps the
   * per-drain update bounded to tokens that actually traded.
   */
  tradedSincePersist(): { mint: string; lastTradeAt: Date }[] {
    const out: { mint: string; lastTradeAt: Date }[] = [];
    for (const [mint, t] of this.tracked) {
      if (t.trades > 0 && t.persistedTradeAt !== t.lastTradeAt) {
        t.persistedTradeAt = t.lastTradeAt;
        out.push({ mint, lastTradeAt: new Date(t.lastTradeAt) });
      }
    }
    return out;
  }

  /** Tokens still on the curve, for DexScreener enrichment after graduation. */
  graduatedMints(): string[] {
    return [...this.tracked.values()].filter((t) => t.graduated).map((t) => t.mint);
  }

  get(mint: string): TrackedToken | undefined {
    return this.tracked.get(mint);
  }

  drainCounters(): Record<string, number> {
    const out = {
      deniedByCap: this.deniedByCap,
      snapshotsDropped: this.snapshotsDropped,
      graduationsUntracked: this.graduationsUntracked,
      keptActivity: this.keptActivity,
      keptControl: this.keptControl,
      stoppedAtDecision: this.stopped,
    };
    this.deniedByCap = 0;
    this.snapshotsDropped = 0;
    this.graduationsUntracked = 0;
    this.keptActivity = 0;
    this.keptControl = 0;
    this.stopped = 0;
    return out;
  }

  /** Live phase mix, for the drain log. */
  phaseCounts(): Record<string, number> {
    const c: Record<string, number> = { early: 0, extended: 0, outcome: 0 };
    for (const t of this.tracked.values()) c[t.phase] = (c[t.phase] ?? 0) + 1;
    return c;
  }
}
