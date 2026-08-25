/**
 * Program-wide pump.fun trade stream.
 *
 * ONE `logsSubscribe` on the pump.fun program carries every trade on the
 * platform — roughly 116 notifications/second, 37 of them trades. That is more
 * data than a per-token subscription would need, but it removes the constraint
 * that shaped the older monitor: the RPC closes a connection on its 101st
 * concurrent subscription, so per-token tracking of ~830 tokens would have meant
 * 9-10 sockets and a hard cliff if any one over-subscribed. Here there is one
 * socket and no cap, so how many tokens are followed becomes a storage decision
 * rather than an RPC one.
 *
 * WHY THE LOGS AND NOT THE ACCOUNT: `accountSubscribe` gives curve state but not
 * who traded. This monitor requires buyer and seller wallets, and only the
 * emitted event carries them.
 *
 * THE LAYOUT WAS DERIVED, NOT ASSUMED. pump.fun does not publish its event
 * layout and has changed it. Every offset below was verified against live data:
 *
 *   - the 8-byte Anchor discriminator is matched exactly, so other events on the
 *     same program cannot be mistaken for trades
 *   - `mint` at 8..40 was checked against mints known independently from
 *     PumpPortal's create stream (311 matches; a wrong offset yields none)
 *   - `is_buy` at 56 predicted the SIGN of the change in real SOL across
 *     consecutive trades in 1701 of 1703 cases (99.9%)
 *   - `sol_amount` at 40 equalled the magnitude of that change in 99.7% of cases
 *   - the field widths close exactly: 40 + 8 + 8 + 1 + 32 + 8 = 97, the verified
 *     offset of virtual_sol_reserves, leaving no unexplained gap
 *
 * A note on validation: an early version of this check filtered out events whose
 * decoded amount was <= 0, which quietly hid every mis-decoded event and made a
 * wrong layout look correct. The checks above are all self-validating instead —
 * they compare decoded fields against each other or against an outside source.
 */

import { createHash } from 'node:crypto';
import type { Logger } from '../../logger.js';
import { SilenceWatchdog } from '../ws-watchdog.js';

/** Anchor derives an event's discriminator from sha256("event:<Name>"). */
const discriminator = (name: string): Buffer =>
  createHash('sha256').update(`event:${name}`).digest().subarray(0, 8);

const TRADE_DISCRIMINATOR = discriminator('TradeEvent');
/** A token being created. Carries everything PumpPortal's create event did. */
const CREATE_DISCRIMINATOR = discriminator('CreateEvent');
/** The bonding curve filling and the token migrating to the AMM: graduation. */
const MIGRATION_DISCRIMINATOR = discriminator('CompletePumpAmmMigrationEvent');

const OFF_MINT = 8;
const OFF_SOL_AMOUNT = 40;
const OFF_TOKEN_AMOUNT = 48;
const OFF_IS_BUY = 56;
const OFF_USER = 57;
const OFF_TIMESTAMP = 89;
const OFF_VIRTUAL_SOL = 97;
const OFF_VIRTUAL_TOKEN = 105;
const OFF_REAL_SOL = 113;
const OFF_REAL_TOKEN = 121;
const MIN_LEN = OFF_REAL_TOKEN + 8;

const LAMPORTS = 1e9;
const TOKEN_UNITS = 1e6;
/** pump.fun mints a fixed supply; verified as exactly 1e9 whole tokens. */
export const TOTAL_SUPPLY = 1e9;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf: Buffer): string {
  const digits = [0];
  for (const byte of buf) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '';
  for (const byte of buf) {
    if (byte === 0) out += '1';
    else break;
  }
  return out + digits.reverse().map((d) => B58[d]).join('');
}

export interface Trade {
  mint: string;
  user: string;
  isBuy: boolean;
  solAmount: number;
  tokenAmount: number;
  virtualSol: number;
  virtualToken: number;
  realSol: number;
  realToken: number;
  /** Market cap in SOL. Always defined — reserves ride on every event. */
  mcapSol: number;
  /** SOL per whole token. */
  priceSol: number;
}

export function decodeTrade(data: Buffer): Trade | null {
  if (data.length < MIN_LEN) return null;
  if (!data.subarray(0, 8).equals(TRADE_DISCRIMINATOR)) return null;

  const virtualSolRaw = Number(data.readBigUInt64LE(OFF_VIRTUAL_SOL));
  const virtualTokenRaw = Number(data.readBigUInt64LE(OFF_VIRTUAL_TOKEN));
  if (virtualTokenRaw <= 0) return null;

  const virtualSol = virtualSolRaw / LAMPORTS;
  const virtualToken = virtualTokenRaw / TOKEN_UNITS;
  // Decimals cancel in supply/reserves, so market cap needs no decimals constant.
  const mcapSol = virtualSol * (TOTAL_SUPPLY / virtualToken);

  return {
    mint: base58(data.subarray(OFF_MINT, OFF_MINT + 32)),
    user: base58(data.subarray(OFF_USER, OFF_USER + 32)),
    isBuy: data.readUInt8(OFF_IS_BUY) === 1,
    solAmount: Number(data.readBigUInt64LE(OFF_SOL_AMOUNT)) / LAMPORTS,
    tokenAmount: Number(data.readBigUInt64LE(OFF_TOKEN_AMOUNT)) / TOKEN_UNITS,
    virtualSol,
    virtualToken,
    realSol: Number(data.readBigUInt64LE(OFF_REAL_SOL)) / LAMPORTS,
    realToken: Number(data.readBigUInt64LE(OFF_REAL_TOKEN)) / TOKEN_UNITS,
    mcapSol,
    priceSol: mcapSol / TOTAL_SUPPLY,
  };
}

/**
 * A token creation, decoded from the same program-wide subscription as trades.
 *
 * THE LAYOUT WAS DERIVED, NOT ASSUMED, by the same method used for TradeEvent.
 * CreateEvent begins with three Borsh strings, so the fixed fields sit at an
 * offset that depends on the token's own name, symbol and URI — they cannot be
 * read from constants and must be parsed sequentially:
 *
 *   0    discriminator (8)
 *   8    name    : u32 length + bytes
 *   ..   symbol  : u32 length + bytes
 *   ..   uri     : u32 length + bytes
 *   ..   mint          (32)
 *   ..   bondingCurve  (32)
 *   ..   user          (32)   the deployer
 *   ..   creator       (32)
 *   ..   timestamp     (i64)
 *   ..   virtualTokenReserves (u64)
 *   ..   virtualSolReserves   (u64)
 *
 * Verified against PumpPortal's independent create stream over live data:
 *
 *   - mint, name, symbol, URI and deployer matched on all 187 tokens both
 *     sources saw in a four-minute window; the RPC saw 9 more and missed none
 *   - virtual SOL reserves decode to exactly 30 SOL on essentially every token,
 *     a constant a wrong offset could not produce
 *   - bondingCurve at +32 matched PumpPortal on 89 of 95. The six exceptions
 *     all carried the SAME key on six different mints, which is impossible for
 *     a per-token account: PumpPortal emits a placeholder there. The decoder is
 *     right and the other source is wrong, which is itself part of the reason
 *     this monitor no longer depends on it.
 *
 * TWO FIELDS DIFFER BY DEFINITION, and are not a decode error. CreateEvent
 * carries reserves at the creation instant — always 30 SOL, mcap 27.96 —
 * whereas PumpPortal reports them AFTER the deployer's opening buy in the same
 * transaction. Measured over 49 tokens the deployer bought in 96% of them, and
 * the creation-instant figure was never above PumpPortal's, as it cannot be.
 * The dev buy is not lost: it arrives moments later as an ordinary TradeEvent
 * on this same stream, where it is measured properly rather than folded into a
 * starting constant.
 */
export interface CreateEvent {
  mint: string;
  name: string | null;
  symbol: string | null;
  uri: string | null;
  bondingCurve: string;
  user: string;
  virtualSol: number;
  virtualToken: number;
  mcapSol: number;
}

/** Borsh string: u32 little-endian length, then that many UTF-8 bytes. */
function readString(data: Buffer, at: number): { value: string; next: number } | null {
  if (at + 4 > data.length) return null;
  const len = data.readUInt32LE(at);
  // A wrong offset produces an absurd length; reject rather than throw.
  if (len > 4096 || at + 4 + len > data.length) return null;
  return { value: data.subarray(at + 4, at + 4 + len).toString('utf8'), next: at + 4 + len };
}

const trimmed = (v: string): string | null => (v.trim() === '' ? null : v.trim());

export function decodeCreate(data: Buffer): CreateEvent | null {
  if (data.length < 8 || !data.subarray(0, 8).equals(CREATE_DISCRIMINATOR)) return null;

  const name = readString(data, 8);
  if (!name) return null;
  const symbol = readString(data, name.next);
  if (!symbol) return null;
  const uri = readString(data, symbol.next);
  if (!uri) return null;

  let at = uri.next;
  // mint, bondingCurve, user, creator, then timestamp, then the reserves.
  if (at + 32 * 4 + 8 * 3 > data.length) return null;
  const mint = data.subarray(at, at + 32);
  at += 32;
  const bondingCurve = data.subarray(at, at + 32);
  at += 32;
  const user = data.subarray(at, at + 32);
  at += 32 + 32 + 8; // skip creator and timestamp
  const virtualTokenRaw = Number(data.readBigUInt64LE(at));
  const virtualSolRaw = Number(data.readBigUInt64LE(at + 8));
  if (!Number.isFinite(virtualSolRaw) || !Number.isFinite(virtualTokenRaw)) return null;
  if (virtualSolRaw <= 0 || virtualTokenRaw <= 0) return null;

  const virtualSol = virtualSolRaw / LAMPORTS;
  const virtualToken = virtualTokenRaw / TOKEN_UNITS;
  return {
    mint: base58(mint),
    name: trimmed(name.value),
    symbol: trimmed(symbol.value),
    uri: trimmed(uri.value),
    bondingCurve: base58(bondingCurve),
    user: base58(user),
    virtualSol,
    virtualToken,
    mcapSol: virtualSol * (TOTAL_SUPPLY / virtualToken),
  };
}

/**
 * Graduation. `CompletePumpAmmMigrationEvent` is the migration to the AMM, and
 * matched PumpPortal's `migrate` event one-for-one on live data.
 *
 *   0   discriminator (8)
 *   8   user (32), mint (32), ...
 */
export function decodeMigration(data: Buffer): { mint: string } | null {
  if (data.length < 8 + 64 || !data.subarray(0, 8).equals(MIGRATION_DISCRIMINATOR)) return null;
  return { mint: base58(data.subarray(40, 72)) };
}

export interface TradeStreamStats {
  connected: boolean;
  notifications: number;
  trades: number;
  undecodable: number;
  reconnects: number;
  /** Token creations decoded from this same subscription. */
  launches: number;
  /** Graduations (AMM migrations) decoded from this same subscription. */
  migrations: number;
  secondsSinceLastTrade: number | null;
  /** Reconnects forced by the silence watchdog rather than by a close event. */
  forcedReconnects: number;
  /** Milliseconds since the last frame of any kind, null before the first. */
  silentForMs: number | null;
  /** Seconds since the last decoded launch, null before the first. */
  secondsSinceLastLaunch: number | null;
}

/**
 * Holds the program subscription open and hands every decoded trade to a
 * callback. Deliberately knows nothing about which tokens are tracked — that
 * filtering belongs to the tracker, so this layer stays a pure decoder.
 */
export class TradeStream {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff = 0;
  private lastTradeAt: number | null = null;
  private startedAt = 0;
  private readonly timers = new Set<NodeJS.Timeout>();
  private stats = {
    notifications: 0,
    trades: 0,
    undecodable: 0,
    reconnects: 0,
    launches: 0,
    migrations: 0,
  };
  private readonly watchdog: SilenceWatchdog;
  private lastLaunchAt: number | null = null;

  constructor(
    private readonly url: string,
    private readonly programId: string,
    private readonly log: Logger,
    private readonly onTrade: (trade: Trade) => void,
    silenceReconnectMs = 120_000,
    private readonly handlers: {
      onCreate?: (event: CreateEvent) => void;
      onMigration?: (mint: string) => void;
    } = {},
  ) {
    this.watchdog = new SilenceWatchdog(silenceReconnectMs, 'trade stream', log, (ms) =>
      this.forceReconnect(`silent for ${Math.round(ms / 1000)}s`),
    );
  }

  start(): void {
    if (this.startedAt) return;
    this.startedAt = Date.now();
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
      this.log.info('trade stream connected', { program: this.programId });
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'logsSubscribe',
          params: [{ mentions: [this.programId] }, { commitment: 'processed' }],
        }),
      );
    };

    ws.onmessage = (event) => {
      // Every frame counts as liveness, including the ~90% that carry no
      // decodable event: the question is whether the RPC is still talking.
      this.watchdog.notify();
      this.onMessage(String(event.data));
    };
    ws.onerror = (event) => {
      this.log.warn('trade stream socket error', {
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

  private reconnect(detail: string): void {
    if (this.stopped) return;
    this.stats.reconnects++;
    // Full jitter, so a redeploy does not reconnect in lockstep.
    const delay = Math.round(Math.random() * Math.min(30_000, 1000 * 2 ** Math.min(this.backoff++, 5)));
    this.log.warn('trade stream disconnected, reconnecting', { detail, delay_ms: delay });
    const t = setTimeout(() => {
      this.timers.delete(t);
      this.connect();
    }, delay);
    t.unref();
    this.timers.add(t);
  }

  private onMessage(raw: string): void {
    // Cheap reject before parsing: at ~116 messages/second, JSON.parse on every
    // one is the dominant cost, and most carry no event data at all.
    if (!raw.includes('Program data:')) return;

    let msg: { method?: string; params?: { result?: { value?: { logs?: string[] } } } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.method !== 'logsNotification') return;
    this.stats.notifications++;

    for (const line of msg.params?.result?.value?.logs ?? []) {
      if (!line.startsWith('Program data: ')) continue;
      const payload = line.slice(14);
      let buf: Buffer;
      try {
        buf = Buffer.from(payload, 'base64');
      } catch {
        continue;
      }
      // Only count a failure when the discriminator says this WAS a trade.
      if (buf.length >= 8 && buf.subarray(0, 8).equals(TRADE_DISCRIMINATOR)) {
        const trade = decodeTrade(buf);
        if (!trade) {
          this.stats.undecodable++;
          continue;
        }
        this.stats.trades++;
        this.lastTradeAt = Date.now();
        try {
          this.onTrade(trade);
        } catch (err) {
          this.log.error('trade handler threw', { error: (err as Error).message });
        }
        continue;
      }

      // Creations and graduations ride the SAME subscription as trades, which
      // is why this monitor needs no second feed. Decoding them here rather
      // than from PumpPortal removes the only other network dependency, and
      // the RPC proved the more complete of the two sources.
      if (this.handlers.onCreate && buf.subarray(0, 8).equals(CREATE_DISCRIMINATOR)) {
        const created = decodeCreate(buf);
        if (!created) {
          this.stats.undecodable++;
          continue;
        }
        this.stats.launches++;
        this.lastLaunchAt = Date.now();
        try {
          this.handlers.onCreate(created);
        } catch (err) {
          this.log.error('create handler threw', { error: (err as Error).message });
        }
        continue;
      }

      if (this.handlers.onMigration && buf.subarray(0, 8).equals(MIGRATION_DISCRIMINATOR)) {
        const migrated = decodeMigration(buf);
        if (!migrated) {
          this.stats.undecodable++;
          continue;
        }
        this.stats.migrations++;
        try {
          this.handlers.onMigration(migrated.mint);
        } catch (err) {
          this.log.error('migration handler threw', { error: (err as Error).message });
        }
      }
    }
  }

  snapshotStats(): TradeStreamStats {
    const s = {
      connected: this.ws?.readyState === 1,
      ...this.stats,
      secondsSinceLastTrade:
        this.lastTradeAt === null ? null : Math.round((Date.now() - this.lastTradeAt) / 1000),
      forcedReconnects: this.watchdog.tripCount,
      silentForMs: this.watchdog.silentForMs(),
      secondsSinceLastLaunch:
        this.lastLaunchAt === null ? null : Math.round((Date.now() - this.lastLaunchAt) / 1000),
    };
    this.stats = {
      notifications: 0,
      trades: 0,
      undecodable: 0,
      reconnects: 0,
      launches: 0,
      migrations: 0,
    };
    return s;
  }

  /** Reference point for the silence check: last trade, else stream start. */
  silentForSeconds(): number {
    return (Date.now() - (this.lastTradeAt ?? this.startedAt)) / 1000;
  }
}
