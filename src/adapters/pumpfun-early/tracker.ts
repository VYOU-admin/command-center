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
import type { EarlyConfig } from './config.js';
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

export interface TrackedToken extends LaunchInfo {
  sampleReason: 'random' | 'graduate';
  socialsFetched: boolean;
  hasTelegram: boolean | null;
  hasTwitter: boolean | null;
  hasWebsite: boolean | null;
  websiteIsSelf: boolean | null;
  graduated: boolean;
  graduatedAt: Date | null;
  trackingEndsAt: number;
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

export interface Resolution {
  mint: string;
  died: boolean;
  diedAt: Date | null;
  stopReason: string;
  snapshotCount: number;
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
  private readonly marks: number[];
  private deniedByCap = 0;
  private snapshotsDropped = 0;

  constructor(
    private readonly cfg: EarlyConfig,
    marks: number[],
    private readonly log: Logger,
  ) {
    this.marks = marks;
  }

  get size(): number {
    return this.tracked.size;
  }

  /** Remember every launch; only some become tracked. */
  noteLaunch(info: LaunchInfo): TrackedToken | null {
    this.launchSeen.set(info.mint, info);
    // Bound the memory: a launch older than the window can never be adopted.
    if (this.launchSeen.size > 40_000) {
      const cutoff = Date.now() - this.cfg.windowMinutes * 60_000;
      for (const [mint, seen] of this.launchSeen) {
        if (seen.launchedAt.getTime() < cutoff) this.launchSeen.delete(mint);
      }
    }
    if (stableUnitHash(info.mint) >= this.cfg.sampleRate) return null;
    return this.adopt(info, 'random');
  }

  /** Graduates are tracked in full, for whatever remains of their window. */
  noteGraduation(mint: string, at: Date): TrackedToken | null {
    const existing = this.tracked.get(mint);
    if (existing) {
      existing.graduated = true;
      existing.graduatedAt = at;
      return existing;
    }
    if (!this.cfg.trackGraduates) return null;
    const seen = this.launchSeen.get(mint);
    // Without a launch time there is no age, and every snapshot's
    // seconds_since_launch would be a guess. Skip rather than invent one.
    if (!seen) return null;
    const adopted = this.adopt(seen, 'graduate');
    if (adopted) {
      adopted.graduated = true;
      adopted.graduatedAt = at;
    }
    return adopted;
  }

  private adopt(info: LaunchInfo, reason: 'random' | 'graduate'): TrackedToken | null {
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
  collect(now: number, solUsd: number | null): { snapshots: Snapshot[]; resolved: Resolution[] } {
    const snapshots: Snapshot[] = [];
    const resolved: Resolution[] = [];
    const idleMs = this.cfg.deathAfterIdleMinutes * 60_000;

    for (const [mint, t] of this.tracked) {
      const ageMs = now - t.launchedAt.getTime();

      while (t.nextMarkIndex < this.marks.length && this.marks[t.nextMarkIndex]! * 1000 <= ageMs) {
        const mark = this.marks[t.nextMarkIndex]!;
        t.nextMarkIndex++;
        if (snapshots.length >= this.cfg.maxBufferedSnapshots) {
          this.snapshotsDropped++;
          continue;
        }
        // A snapshot only has a market if a trade landed since the previous
        // one. Without this, an idle token's carried-forward price computes a
        // 0% return that reads as "held flat" when it means "nothing traded".
        const hasMarket = t.trades > t.lastSnapshotTrades;
        t.lastSnapshotTrades = t.trades;

        // After graduation the curve is complete and its price is frozen, so
        // the DEX price is the only live one. Left null rather than falling
        // back to the stale curve print when DexScreener has not reported yet.
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
          priceSource,
          priceUsdEffective,
          hasMarket,
          secondsSinceLaunch: mark,
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

      const windowOver = now >= t.trackingEndsAt;
      const wentQuiet = now - t.lastTradeAt >= idleMs;
      if (windowOver || wentQuiet) {
        resolved.push({
          mint,
          died: wentQuiet && !windowOver,
          diedAt: wentQuiet && !windowOver ? new Date(t.lastTradeAt + idleMs) : null,
          stopReason: windowOver ? 'window_complete' : 'idle',
          snapshotCount: t.nextMarkIndex,
        });
        this.tracked.delete(mint);
      }
    }

    return { snapshots, resolved };
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

  drainCounters(): { deniedByCap: number; snapshotsDropped: number } {
    const out = { deniedByCap: this.deniedByCap, snapshotsDropped: this.snapshotsDropped };
    this.deniedByCap = 0;
    this.snapshotsDropped = 0;
    return out;
  }
}
