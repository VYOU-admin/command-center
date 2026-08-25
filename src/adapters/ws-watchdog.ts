/**
 * Recovery for long-lived WebSockets that stop delivering without closing.
 *
 * WHY THIS EXISTS. Every stream in this repo reconnected on exactly two
 * events: a connect error, and a socket `close`. Neither fires when the peer
 * goes away without sending a FIN — a half-open socket, which is routine for a
 * process behind cloud NAT. The socket stays readyState OPEN, `close` never
 * arrives, the reconnect path is never reached, and the feed sits dead while
 * reporting itself connected.
 *
 * That is not hypothetical: the pump.fun launch feed ran silently dead for
 * 4.7 hours in production, logging "the stream is connected but silent" once
 * every 30 seconds and never attempting to recover.
 *
 * Liveness has to be measured by DATA ARRIVING, not by socket state. A stream
 * that has heard nothing for longer than its threshold is treated as dead
 * regardless of what readyState claims.
 *
 * The threshold is a data-rate question, so it belongs to the caller: the trade
 * stream carries ~116 messages/second and the launch feed ~1/second, but both
 * are orders of magnitude busier than any sane threshold, which is what makes a
 * single configured value workable for both.
 */

import type { Logger } from '../logger.js';

/** How often the clock is checked, relative to the threshold. */
const CHECK_DIVISOR = 4;
const MAX_CHECK_MS = 15_000;

export class SilenceWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private lastActivity = 0;
  /** Suppresses a second trip while a reconnect is already in flight. */
  private tripped = false;
  private trips = 0;

  /**
   * @param thresholdMs  Silence longer than this means the socket is dead.
   * @param onSilent     Must tear the socket down and reconnect.
   * @param isActive     Optional. When it returns false the stream is not
   *                     expected to be delivering anything — a subscription
   *                     socket with nothing subscribed, say — so the clock is
   *                     held rather than counted. Without this such a stream
   *                     would reconnect on a loop while merely idle.
   */
  constructor(
    private readonly thresholdMs: number,
    private readonly label: string,
    private readonly log: Logger,
    private readonly onSilent: (silentMs: number) => void,
    private readonly isActive?: () => boolean,
  ) {}

  /** Called on every inbound frame, including control frames. */
  notify(): void {
    this.lastActivity = Date.now();
    this.tripped = false;
  }

  /**
   * Restart the clock. Called when a socket opens so a fresh connection gets a
   * full grace period rather than inheriting the dead one's silence.
   */
  reset(): void {
    this.notify();
  }

  start(): void {
    if (this.timer || this.thresholdMs <= 0) return;
    this.reset();
    const every = Math.max(1000, Math.min(MAX_CHECK_MS, Math.round(this.thresholdMs / CHECK_DIVISOR)));
    const t = setInterval(() => this.check(), every);
    t.unref();
    this.timer = t;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get tripCount(): number {
    return this.trips;
  }

  /** Milliseconds since the last frame, or null before the first one. */
  silentForMs(): number | null {
    return this.lastActivity === 0 ? null : Date.now() - this.lastActivity;
  }

  private check(): void {
    if (this.tripped || this.lastActivity === 0) return;
    // Idle by design is not silence. Hold the clock so the stream is judged
    // only over periods it was actually expected to deliver.
    if (this.isActive && !this.isActive()) {
      this.lastActivity = Date.now();
      return;
    }
    const silent = Date.now() - this.lastActivity;
    if (silent < this.thresholdMs) return;
    this.tripped = true;
    this.trips++;
    this.log.warn('stream silent, forcing reconnect', {
      stream: this.label,
      silent_ms: silent,
      threshold_ms: this.thresholdMs,
    });
    this.onSilent(silent);
  }
}
