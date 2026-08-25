/**
 * The non-trade inputs: launches and graduations from PumpPortal, the SOL/USD
 * rate, token metadata for socials, and DexScreener enrichment once a token has
 * graduated off the curve.
 *
 * All of these are best-effort. A failure here must not stop the trade stream,
 * because the trade stream is the part that cannot be backfilled.
 */

import type { Logger } from '../../logger.js';
import { SilenceWatchdog } from '../ws-watchdog.js';
import type { EarlyConfig } from './config.js';
import type { LaunchInfo, TrackedToken } from './tracker.js';

const DEXSCREENER = 'https://api.dexscreener.com';
/** Wrapped SOL, used to read the SOL/USD rate. */
const WSOL = 'So11111111111111111111111111111111111111112';
const USER_AGENT = 'command-center-monitor/1.0 (+https://github.com/VYOU-admin/command-center)';

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number.parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/* --------------------------------------------------------- PumpPortal feed */

export interface LaunchFeedHandlers {
  onLaunch: (info: LaunchInfo) => void;
  onGraduation: (mint: string, at: Date) => void;
}

/**
 * PumpPortal's free, key-less stream. `subscribeNewToken` is the only place a
 * launch's deployer, metadata URI and initial market cap arrive together;
 * `subscribeMigration` is the graduation signal.
 */
export class LaunchFeed {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 0;
  private readonly timers = new Set<NodeJS.Timeout>();
  private launches = 0;
  private migrations = 0;
  private readonly watchdog: SilenceWatchdog;

  constructor(
    private readonly url: string,
    private readonly log: Logger,
    private readonly handlers: LaunchFeedHandlers,
    silenceReconnectMs = 120_000,
  ) {
    this.watchdog = new SilenceWatchdog(silenceReconnectMs, 'launch feed', log, (ms) =>
      this.forceReconnect(`silent for ${Math.round(ms / 1000)}s`),
    );
  }

  start(): void {
    this.connect();
    this.watchdog.start();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watchdog.stop();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === 1;
  }

  drainCounters(): { launches: number; migrations: number; forcedReconnects: number } {
    const out = {
      launches: this.launches,
      migrations: this.migrations,
      forcedReconnects: this.watchdog.tripCount,
    };
    this.launches = 0;
    this.migrations = 0;
    return out;
  }

  /** Milliseconds since the last frame of any kind, or null before the first. */
  silentForMs(): number | null {
    return this.watchdog.silentForMs();
  }

  /**
   * Abandon the current socket and reconnect without waiting for a close event
   * that may never come. Handlers are detached first so the dead socket cannot
   * schedule a second reconnect if it does eventually close.
   */
  private forceReconnect(detail: string): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    this.reconnect(detail);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.reconnect((err as Error).message);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.backoff = 0;
      this.watchdog.reset();
      this.log.info('launch feed connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
    };
    ws.onmessage = (event) => {
      // Liveness is measured on ANY frame, control frames included: the
      // question is whether the peer is still talking, not what it said.
      this.watchdog.notify();
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(String(event.data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (d['message'] !== undefined) return;

      if (d['txType'] === 'create') {
        const mint = str(d['mint']);
        if (!mint) return;
        this.launches++;
        this.handlers.onLaunch({
          mint,
          deployer: str(d['traderPublicKey']),
          name: str(d['name']),
          symbol: str(d['symbol']),
          uri: str(d['uri']),
          bondingCurve: str(d['bondingCurveKey']),
          pool: str(d['pool']),
          signature: str(d['signature']),
          launchedAt: new Date(),
          initialMcapSol: num(d['marketCapSol']),
          initialVSol: num(d['vSolInBondingCurve']),
        });
      } else if (d['txType'] === 'migrate') {
        const mint = str(d['mint']);
        if (!mint) return;
        this.migrations++;
        this.handlers.onGraduation(mint, new Date());
      }
    };
    ws.onerror = (event) => {
      this.log.warn('launch feed socket error', {
        error: (event as unknown as { message?: string }).message ?? 'unknown',
      });
    };
    ws.onclose = (event) => {
      // A socket the watchdog already abandoned must not reconnect again.
      if (this.ws !== ws) return;
      this.ws = null;
      this.reconnect(`code ${event.code} ${event.reason}`);
    };
  }

  private reconnect(detail: string): void {
    if (this.stopped) return;
    const delay = Math.round(Math.random() * Math.min(30_000, 1000 * 2 ** Math.min(this.backoff++, 5)));
    this.log.warn('launch feed disconnected, reconnecting', { detail, delay_ms: delay });
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.connect();
    }, delay);
    t.unref();
    this.timers.add(t);
  }
}

/* --------------------------------------------------------------- SOL price */

/**
 * SOL/USD, refreshed on its own slow cadence and cached.
 *
 * Every snapshot stores the rate it used alongside the USD figures, so a stale
 * or wrong rate can be identified and the USD columns recomputed later. The
 * SOL-denominated columns never depend on this.
 */
export class SolPrice {
  private value: number | null = null;
  private fetchedAt = 0;

  constructor(
    private readonly cfg: EarlyConfig,
    private readonly log: Logger,
  ) {}

  get current(): number | null {
    return this.value;
  }

  due(now: number): boolean {
    return now - this.fetchedAt >= this.cfg.solPriceRefreshSeconds * 1000;
  }

  async refresh(signal: AbortSignal): Promise<void> {
    this.fetchedAt = Date.now();
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${WSOL}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.cfg.timeoutMs)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { pairs?: { priceUsd?: string; liquidity?: { usd?: number } }[] };
      // Deepest pair, not the first: a thin pool can quote a silly price.
      let best: { price: number; liq: number } | null = null;
      for (const p of body.pairs ?? []) {
        const price = num(p.priceUsd);
        const liq = num(p.liquidity?.usd) ?? 0;
        if (price === null || price <= 0) continue;
        if (!best || liq > best.liq) best = { price, liq };
      }
      if (!best) throw new Error('no usable SOL pair');
      // Sanity band: a decode or feed error should not silently rewrite every
      // USD column in the table.
      if (best.price < 1 || best.price > 10_000) {
        throw new Error(`implausible SOL price ${best.price}`);
      }
      this.value = best.price;
      this.log.info('sol price refreshed', { sol_usd: best.price });
    } catch (err) {
      // Keep the previous value; USD columns simply go stale rather than null.
      this.log.warn('sol price refresh failed, keeping previous', {
        error: (err as Error).message,
        previous: this.value,
      });
    }
  }
}

/* ------------------------------------------------------------- enrichment */

/** Token metadata, for socials at launch. */
export async function fetchSocials(
  token: TrackedToken,
  cfg: EarlyConfig,
  signal: AbortSignal,
): Promise<void> {
  if (!token.uri) return;
  try {
    const res = await fetch(token.uri, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.metadataTimeoutMs)]),
    });
    if (!res.ok) return;
    const meta = (await res.json()) as Record<string, unknown>;
    const website = str(meta['website']);
    const isSelf = website !== null && /(^|\/\/)(www\.)?pump\.fun\//.test(website);
    token.hasTelegram = str(meta['telegram']) !== null;
    token.hasTwitter = str(meta['twitter']) !== null;
    token.hasWebsite = website !== null && !isSelf;
    token.websiteIsSelf = isSelf;
    token.socialsFetched = true;
  } catch {
    // socials_fetched stays false, so the gap is visible rather than a silent null
  }
}

/** DexScreener metrics for tokens that have graduated off the curve. */
export async function enrichGraduates(
  mints: string[],
  tokens: Map<string, TrackedToken> | { get(m: string): TrackedToken | undefined },
  cfg: EarlyConfig,
  log: Logger,
  signal: AbortSignal,
): Promise<number> {
  let updated = 0;
  for (let i = 0; i < mints.length; i += cfg.dexBatchSize) {
    const chunk = mints.slice(i, i + cfg.dexBatchSize);
    try {
      const res = await fetch(`${DEXSCREENER}/latest/dex/tokens/${chunk.join(',')}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(cfg.timeoutMs)]),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as {
        pairs?: {
          baseToken?: { address?: string };
          liquidity?: { usd?: number };
          volume?: Record<string, number>;
          txns?: Record<string, { buys?: number; sells?: number }>;
          priceUsd?: string;
        }[];
      };
      const best = new Map<string, { liq: number; vol: number | null; txns: number | null; price: number | null }>();
      for (const pair of body.pairs ?? []) {
        const addr = pair.baseToken?.address;
        if (!addr) continue;
        const liq = num(pair.liquidity?.usd) ?? 0;
        const cur = best.get(addr);
        if (cur && cur.liq >= liq) continue;
        const t24 = pair.txns?.['h24'];
        best.set(addr, {
          liq,
          vol: num(pair.volume?.['h24']),
          txns: t24 ? (t24.buys ?? 0) + (t24.sells ?? 0) : null,
          price: num(pair.priceUsd),
        });
      }
      for (const [mint, m] of best) {
        const t = tokens.get(mint);
        if (!t) continue;
        t.dexLiquidityUsd = m.liq;
        t.dexVolume24h = m.vol;
        t.dexTxns24h = m.txns;
        t.dexPriceUsd = m.price;
        updated++;
      }
    } catch (err) {
      log.warn('dexscreener enrichment chunk failed', {
        chunk_start: i,
        error: (err as Error).message,
      });
    }
  }
  return updated;
}
