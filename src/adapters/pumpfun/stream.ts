/**
 * The persistent side of the pump.fun monitor.
 *
 * Two sockets are held open here, and the scheduler never sees either of them:
 *
 *   1. PumpPortal  — free, key-less. `subscribeNewToken` gives every launch,
 *      `subscribeMigration` gives every graduation. Both verified live.
 *   2. Solana RPC  — `accountSubscribe` on a token's bonding-curve account.
 *      Every trade mutates that account, so each push is one trade. That is
 *      what makes per-trade velocity measurable without paying for a trade
 *      feed: PumpPortal's own `subscribeTokenTrade` is metered at 0.01 SOL per
 *      10k events, which at ~70k launches/day is not viable.
 *
 * Events accumulate in memory and the adapter's scheduled `fetch()` drains
 * them. That keeps the whole thing inside the existing adapter contract: no
 * stream lifecycle in the spine, and a drain that finds the socket dead simply
 * throws, so the existing consecutive-failure and recovery alerting applies
 * unchanged.
 *
 * The subscription pool exists because the RPC closes the connection with code
 * 1013 on the 101st concurrent subscription. Slots are recycled by
 * `accountUnsubscribe`, which was verified to free capacity rather than count
 * against a cumulative total.
 */

import type { Logger } from '../../logger.js';
import type { StreamConfig } from './config.js';

export interface LaunchEvent {
  mint: string;
  deployer: string | null;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  bondingCurve: string | null;
  pool: string | null;
  signature: string | null;
  initialBuySol: number | null;
  initialVSol: number | null;
  initialMcapSol: number | null;
  launchedAt: Date;
  instrumented: boolean;
  instrumentReason: string | null;
  socialsFetched: boolean;
  hasTwitter: boolean | null;
  hasTelegram: boolean | null;
  hasWebsite: boolean | null;
  websiteIsSelf: boolean | null;
}

export interface MigrationEvent {
  mint: string;
  signature: string | null;
  pool: string | null;
  observedAt: Date;
}

export interface CurveSample {
  mint: string;
  observedAt: Date;
  tradeSeq: number;
  ageSeconds: number;
  realSol: number;
  virtualSol: number;
  complete: boolean;
}

export interface DrainResult {
  launches: LaunchEvent[];
  migrations: MigrationEvent[];
  samples: CurveSample[];
  stats: StreamStats;
}

export interface StreamStats {
  pumpportalConnected: boolean;
  rpcConnected: boolean;
  activeSubscriptions: number;
  secondsSinceLastLaunch: number | null;
  droppedEvents: number;
  slotsDenied: number;
  reconnects: number;
}

/** Curve account layout: 8-byte discriminator, then five u64s, then `complete`. */
const OFF_VIRTUAL_SOL = 16;
const OFF_REAL_SOL = 32;
const OFF_COMPLETE = 48;
const LAMPORTS = 1e9;

function decodeCurve(base64: string): { realSol: number; virtualSol: number; complete: boolean } | null {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < OFF_COMPLETE + 1) return null;
  return {
    virtualSol: Number(buf.readBigUInt64LE(OFF_VIRTUAL_SOL)) / LAMPORTS,
    realSol: Number(buf.readBigUInt64LE(OFF_REAL_SOL)) / LAMPORTS,
    complete: buf.readUInt8(OFF_COMPLETE) === 1,
  };
}

/**
 * Control-group membership is a hash of the mint, not a coin flip. Sampling has
 * to be reproducible: months later you must be able to prove a token was in the
 * control group rather than take the dataset's word for it.
 */
function stableUnitHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 100000) / 100000;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

interface Slot {
  mint: string;
  bondingCurve: string;
  subId: number | null;
  requestId: number;
  launchedAt: number;
  expiresAt: number;
  tradeSeq: number;
  lastRealSol: number | null;
}

export class PumpFunStream {
  private pump: WebSocket | null = null;
  private rpc: WebSocket | null = null;

  private launches: LaunchEvent[] = [];
  private migrations: MigrationEvent[] = [];
  private samples: CurveSample[] = [];

  /** bondingCurve -> slot, for slots we have asked to subscribe. */
  private readonly slots = new Map<string, Slot>();
  /** RPC subscription id -> bondingCurve, filled in when the ack arrives. */
  private readonly subToCurve = new Map<number, string>();
  /** Our request id -> bondingCurve, so an ack can be matched to its slot. */
  private readonly reqToCurve = new Map<number, string>();

  private nextRequestId = 1;
  private lastLaunchAt: number | null = null;
  private droppedEvents = 0;
  private slotsDenied = 0;
  private reconnects = 0;
  private pumpBackoff = 0;
  private rpcBackoff = 0;
  private metadataInFlight = 0;
  private readonly metadataQueue: LaunchEvent[] = [];
  private stopped = false;
  private started = false;
  private startedAt = 0;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly cfg: StreamConfig,
    private readonly log: Logger,
  ) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    this.startedAt = Date.now();
    this.connectPump();
    this.connectRpc();
    const sweep = setInterval(() => this.recycleExpiredSlots(), 15_000);
    sweep.unref();
    this.timers.add(sweep);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const ws of [this.pump, this.rpc]) {
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
    }
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.stopped) fn();
    }, ms);
    t.unref();
    this.timers.add(t);
  }

  /** Full jitter, so a Railway redeploy does not reconnect every replica in lockstep. */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    return Math.round(Math.random() * ceiling);
  }

  /* ------------------------------------------------------------ PumpPortal */

  private connectPump(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.pumpportalUrl);
    } catch (err) {
      this.schedulePumpReconnect(err);
      return;
    }
    this.pump = ws;

    ws.onopen = () => {
      this.pumpBackoff = 0;
      this.log.info('pumpportal connected');
      ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws.send(JSON.stringify({ method: 'subscribeMigration' }));
    };
    ws.onmessage = (event) => this.onPumpMessage(event.data);
    ws.onerror = (event) => {
      this.log.warn('pumpportal socket error', {
        error: (event as unknown as { message?: string }).message ?? 'unknown',
      });
    };
    ws.onclose = (event) => {
      if (this.pump === ws) this.pump = null;
      this.schedulePumpReconnect(`code ${event.code} ${event.reason}`);
    };
  }

  private scheduleWsReconnect(what: 'pumpportal' | 'rpc', detail: unknown): void {
    if (this.stopped) return;
    const attempt = what === 'pumpportal' ? this.pumpBackoff++ : this.rpcBackoff++;
    const delay = this.backoffMs(attempt);
    this.reconnects++;
    this.log.warn(`${what} disconnected, reconnecting`, {
      detail: typeof detail === 'string' ? detail : String((detail as Error)?.message ?? detail),
      delay_ms: delay,
    });
    this.later(() => (what === 'pumpportal' ? this.connectPump() : this.connectRpc()), delay);
  }

  private schedulePumpReconnect(detail: unknown): void {
    this.scheduleWsReconnect('pumpportal', detail);
  }

  private onPumpMessage(raw: unknown): void {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }
    if (data['message'] !== undefined) return; // subscription ack

    const txType = data['txType'];
    if (txType === 'create') this.onLaunch(data);
    else if (txType === 'migrate') this.onMigration(data);
  }

  private onLaunch(data: Record<string, unknown>): void {
    const mint = str(data['mint']);
    if (!mint) return;

    if (this.launches.length >= this.cfg.maxBufferedEvents) {
      this.droppedEvents++;
      return;
    }

    this.lastLaunchAt = Date.now();
    const mcap = num(data['marketCapSol']);
    const bondingCurve = str(data['bondingCurveKey']);

    const event: LaunchEvent = {
      mint,
      deployer: str(data['traderPublicKey']),
      name: str(data['name']),
      symbol: str(data['symbol']),
      uri: str(data['uri']),
      bondingCurve,
      pool: str(data['pool']),
      signature: str(data['signature']),
      initialBuySol: num(data['solAmount']),
      initialVSol: num(data['vSolInBondingCurve']),
      initialMcapSol: mcap,
      launchedAt: new Date(),
      instrumented: false,
      instrumentReason: null,
      socialsFetched: false,
      hasTwitter: null,
      hasTelegram: null,
      hasWebsite: null,
      websiteIsSelf: null,
    };

    // Decide on what is knowable at t=0 and subscribe immediately — the first
    // trades land within seconds, so waiting on the metadata fetch would lose
    // exactly the part of the curve this monitor exists to measure.
    if (mcap !== null && mcap > this.cfg.instrumentMcapSolAbove) {
      this.instrument(event, 'mcap_above_default');
    } else if (stableUnitHash(mint) < this.cfg.controlSampleRate) {
      this.instrument(event, 'control');
    }

    this.launches.push(event);
    if (event.uri) this.queueMetadata(event);
  }

  private onMigration(data: Record<string, unknown>): void {
    const mint = str(data['mint']);
    if (!mint) return;
    if (this.migrations.length >= this.cfg.maxBufferedEvents) {
      this.droppedEvents++;
      return;
    }
    this.migrations.push({
      mint,
      signature: str(data['signature']),
      pool: str(data['pool']),
      observedAt: new Date(),
    });
    this.log.info('graduation observed', { mint });
  }

  /* -------------------------------------------------------------- metadata */

  private queueMetadata(event: LaunchEvent): void {
    this.metadataQueue.push(event);
    this.pumpMetadataQueue();
  }

  private pumpMetadataQueue(): void {
    while (
      this.metadataInFlight < this.cfg.metadataConcurrency &&
      this.metadataQueue.length > 0
    ) {
      const event = this.metadataQueue.shift()!;
      this.metadataInFlight++;
      void this.fetchSocials(event).finally(() => {
        this.metadataInFlight--;
        this.pumpMetadataQueue();
      });
    }
  }

  private async fetchSocials(event: LaunchEvent): Promise<void> {
    if (!event.uri) return;
    try {
      const res = await fetch(event.uri, {
        signal: AbortSignal.timeout(this.cfg.metadataTimeoutMs),
        headers: { accept: 'application/json' },
      });
      if (!res.ok) return;
      const meta = (await res.json()) as Record<string, unknown>;

      const twitter = str(meta['twitter']);
      const telegram = str(meta['telegram']);
      const website = str(meta['website']);
      // pump.fun fills "website" with a link back to the coin's own page for
      // most launches. Counted naively that makes website presence useless as a
      // feature, so self-links are recorded separately rather than as a site.
      const isSelf = website !== null && /(^|\/\/)(www\.)?pump\.fun\//.test(website);

      event.hasTwitter = twitter !== null;
      event.hasTelegram = telegram !== null;
      event.hasWebsite = website !== null && !isSelf;
      event.websiteIsSelf = isSelf;
      event.socialsFetched = true;

      // Telegram presence carries the largest published graduation lift, so it
      // earns a slot even though the socials arrive a beat after the launch.
      if (!event.instrumented && this.cfg.instrumentIfTelegram && event.hasTelegram) {
        this.instrument(event, 'telegram');
      }
    } catch {
      // Metadata is a nice-to-have; the launch row lands either way with
      // socials_fetched=false so the gap is visible rather than silently null.
    }
  }

  /* ------------------------------------------------- curve subscriptions */

  private instrument(event: LaunchEvent, reason: string): void {
    if (!event.bondingCurve) return;
    if (this.slots.size >= this.cfg.maxCurveSubscriptions) {
      this.recycleExpiredSlots();
      if (this.slots.size >= this.cfg.maxCurveSubscriptions) {
        this.slotsDenied++;
        return;
      }
    }

    const requestId = this.nextRequestId++;
    const slot: Slot = {
      mint: event.mint,
      bondingCurve: event.bondingCurve,
      subId: null,
      requestId,
      launchedAt: event.launchedAt.getTime(),
      expiresAt: event.launchedAt.getTime() + this.cfg.denseWindowMinutes * 60_000,
      tradeSeq: 0,
      lastRealSol: null,
    };
    this.slots.set(event.bondingCurve, slot);
    this.reqToCurve.set(requestId, event.bondingCurve);

    event.instrumented = true;
    event.instrumentReason = reason;

    this.sendSubscribe(slot);
  }

  private sendSubscribe(slot: Slot): void {
    if (this.rpc?.readyState !== 1) return; // resubscribed on reconnect
    this.rpc.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: slot.requestId,
        method: 'accountSubscribe',
        params: [slot.bondingCurve, { encoding: 'base64', commitment: 'processed' }],
      }),
    );
  }

  private recycleExpiredSlots(): void {
    const now = Date.now();
    for (const [curve, slot] of this.slots) {
      if (slot.expiresAt > now) continue;
      this.releaseSlot(curve, slot);
    }
  }

  private releaseSlot(curve: string, slot: Slot): void {
    this.slots.delete(curve);
    this.reqToCurve.delete(slot.requestId);
    if (slot.subId !== null) {
      this.subToCurve.delete(slot.subId);
      if (this.rpc?.readyState === 1) {
        this.rpc.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: this.nextRequestId++,
            method: 'accountUnsubscribe',
            params: [slot.subId],
          }),
        );
      }
    }
  }

  private connectRpc(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.rpcUrl);
    } catch (err) {
      this.scheduleWsReconnect('rpc', err);
      return;
    }
    this.rpc = ws;

    ws.onopen = () => {
      this.rpcBackoff = 0;
      this.log.info('rpc connected', { active_slots: this.slots.size });
      // Slots outlive the socket; re-arm whatever is still inside its window.
      this.subToCurve.clear();
      const now = Date.now();
      for (const [curve, slot] of this.slots) {
        if (slot.expiresAt <= now) {
          this.slots.delete(curve);
          continue;
        }
        slot.subId = null;
        slot.requestId = this.nextRequestId++;
        this.reqToCurve.set(slot.requestId, curve);
        this.sendSubscribe(slot);
      }
    };
    ws.onmessage = (event) => this.onRpcMessage(event.data);
    ws.onerror = (event) => {
      this.log.warn('rpc socket error', {
        error: (event as unknown as { message?: string }).message ?? 'unknown',
      });
    };
    ws.onclose = (event) => {
      if (this.rpc === ws) this.rpc = null;
      // Code 1013 means we exceeded the concurrent-subscription cap. That is a
      // configuration error rather than a transient fault, so say so plainly.
      if (event.code === 1013) {
        this.log.error('rpc rejected subscriptions: concurrent cap exceeded', {
          active_slots: this.slots.size,
          max_curve_subscriptions: this.cfg.maxCurveSubscriptions,
          hint: 'lower limits.max_curve_subscriptions or shorten sampling.dense_window_minutes',
        });
      }
      this.scheduleWsReconnect('rpc', `code ${event.code} ${event.reason}`);
    };
  }

  private onRpcMessage(raw: unknown): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(raw)) as Record<string, unknown>;
    } catch {
      return;
    }

    // Subscription acknowledgement: bind the RPC's id to our slot.
    if (msg['id'] !== undefined) {
      const reqId = msg['id'] as number;
      const curve = this.reqToCurve.get(reqId);
      this.reqToCurve.delete(reqId);
      const result = msg['result'];
      if (curve && typeof result === 'number') {
        const slot = this.slots.get(curve);
        if (slot) {
          slot.subId = result;
          this.subToCurve.set(result, curve);
        }
      }
      return;
    }

    if (msg['method'] !== 'accountNotification') return;
    const params = msg['params'] as { subscription?: number; result?: unknown } | undefined;
    const subId = params?.subscription;
    if (typeof subId !== 'number') return;
    const curve = this.subToCurve.get(subId);
    if (!curve) return;
    const slot = this.slots.get(curve);
    if (!slot) return;

    const value = (params?.result as { value?: { data?: unknown } } | undefined)?.value;
    const data = value?.data;
    const encoded = Array.isArray(data) ? (data[0] as string) : null;
    if (typeof encoded !== 'string') return;
    const state = decodeCurve(encoded);
    if (!state) return;

    if (this.samples.length >= this.cfg.maxBufferedEvents) {
      this.droppedEvents++;
      return;
    }

    const now = Date.now();
    slot.tradeSeq++;
    slot.lastRealSol = state.realSol;

    this.samples.push({
      mint: slot.mint,
      observedAt: new Date(now),
      tradeSeq: slot.tradeSeq,
      ageSeconds: (now - slot.launchedAt) / 1000,
      realSol: state.realSol,
      virtualSol: state.virtualSol,
      complete: state.complete,
    });

    // A completed curve has graduated; the slot has nothing left to say.
    if (state.complete) this.releaseSlot(curve, slot);
  }

  /* ----------------------------------------------------------------- drain */

  drain(): DrainResult {
    const launches = this.launches;
    const migrations = this.migrations;
    const samples = this.samples;
    this.launches = [];
    this.migrations = [];
    this.samples = [];

    const stats: StreamStats = {
      pumpportalConnected: this.pump?.readyState === 1,
      rpcConnected: this.rpc?.readyState === 1,
      activeSubscriptions: this.slots.size,
      secondsSinceLastLaunch:
        this.lastLaunchAt === null ? null : Math.round((Date.now() - this.lastLaunchAt) / 1000),
      droppedEvents: this.droppedEvents,
      slotsDenied: this.slotsDenied,
      reconnects: this.reconnects,
    };
    this.droppedEvents = 0;
    this.slotsDenied = 0;
    this.reconnects = 0;

    return { launches, migrations, samples, stats };
  }

  /**
   * The silent-failure case: the socket reconnects fine but nothing arrives.
   * Launches run at roughly 50/minute, so a gap of minutes means broken, and
   * throwing here routes it into the spine's existing failure alerting.
   *
   * Silence is measured from the last launch OR from when the stream started,
   * whichever is later. Measuring only from the last launch would mean a stream
   * that never connected at all had no reference point and could never be
   * called unhealthy — the exact failure this is here to catch.
   *
   * The grace period matters as much as the threshold. The scheduler runs a
   * tick the instant the process boots, so the first drain happens while the
   * sockets are still opening. Without grace, every single deploy would record
   * a failed first run.
   */
  assertHealthy(): void {
    const reference = this.lastLaunchAt ?? this.startedAt;
    const silentFor = (Date.now() - reference) / 1000;
    const connecting = this.lastLaunchAt === null;

    if (silentFor > this.cfg.silenceFailAfterSeconds) {
      throw new Error(
        connecting
          ? `no pump.fun launch events in the ${Math.round(silentFor)}s since the stream started ` +
            `(threshold ${this.cfg.silenceFailAfterSeconds}s); it has never received an event ` +
            `[pumpportal=${this.pump?.readyState === 1 ? 'up' : 'down'} ` +
            `rpc=${this.rpc?.readyState === 1 ? 'up' : 'down'}]`
          : `no pump.fun launch events for ${Math.round(silentFor)}s ` +
            `(threshold ${this.cfg.silenceFailAfterSeconds}s); the stream is connected but silent`,
      );
    }
  }

  /** True while the stream is young enough that not having connected is normal. */
  isWarmingUp(graceSeconds: number): boolean {
    return this.lastLaunchAt === null && (Date.now() - this.startedAt) / 1000 < graceSeconds;
  }
}
