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

/** Anchor derives an event's discriminator from sha256("event:<Name>"). */
const TRADE_DISCRIMINATOR = createHash('sha256')
  .update('event:TradeEvent')
  .digest()
  .subarray(0, 8);

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

export interface TradeStreamStats {
  connected: boolean;
  notifications: number;
  trades: number;
  undecodable: number;
  reconnects: number;
  secondsSinceLastTrade: number | null;
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
  private stats = { notifications: 0, trades: 0, undecodable: 0, reconnects: 0 };

  constructor(
    private readonly url: string,
    private readonly programId: string,
    private readonly log: Logger,
    private readonly onTrade: (trade: Trade) => void,
  ) {}

  start(): void {
    if (this.startedAt) return;
    this.startedAt = Date.now();
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
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

    ws.onmessage = (event) => this.onMessage(String(event.data));
    ws.onerror = (event) => {
      this.log.warn('trade stream socket error', {
        error: (event as unknown as { message?: string }).message ?? 'unknown',
      });
    };
    ws.onclose = (event) => {
      if (this.ws === ws) this.ws = null;
      this.reconnect(`code ${event.code} ${event.reason}`);
    };
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
      }
    }
  }

  snapshotStats(): TradeStreamStats {
    const s = {
      connected: this.ws?.readyState === 1,
      ...this.stats,
      secondsSinceLastTrade:
        this.lastTradeAt === null ? null : Math.round((Date.now() - this.lastTradeAt) / 1000),
    };
    this.stats = { notifications: 0, trades: 0, undecodable: 0, reconnects: 0 };
    return s;
  }

  /** Reference point for the silence check: last trade, else stream start. */
  silentForSeconds(): number {
    return (Date.now() - (this.lastTradeAt ?? this.startedAt)) / 1000;
  }
}
