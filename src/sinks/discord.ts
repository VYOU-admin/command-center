/**
 * Discord sink. Delivery is best-effort: a webhook outage must never take down
 * ingest, so every failure here is logged and swallowed.
 */

import { redact } from '../env.js';
import { log } from '../logger.js';

export type AlertLevel = 'critical' | 'warning' | 'recovery';

const COLORS: Record<AlertLevel, number> = {
  critical: 0xd7263d,
  warning: 0xf2a33c,
  recovery: 0x2ecc71,
};

const ICONS: Record<AlertLevel, string> = {
  critical: '🔴',
  warning: '🟠',
  recovery: '🟢',
};

export interface Alert {
  level: AlertLevel;
  title: string;
  description: string;
  fields?: { name: string; value: string; inline?: boolean }[];
}

/** How a channel name resolved to a webhook, for logging and /health. */
export interface ChannelResolution {
  channel: string;
  /** `channel` = its own webhook, `fallback` = DISCORD_WEBHOOK_URL, `none` = nowhere. */
  via: 'channel' | 'fallback' | 'none';
  /** The variable that supplied it, for the boot log. Never the URL itself. */
  envVar: string | null;
}

export interface DiscordSinkOptions {
  /** Channel name -> webhook, from DISCORD_WEBHOOK_<NAME>. */
  channels: Map<string, string>;
  /** DISCORD_WEBHOOK_URL, used when a named channel has no webhook of its own. */
  fallbackUrl: string | null;
}

export class DiscordSink {
  private readonly channels: Map<string, string>;
  private readonly fallbackUrl: string | null;

  constructor(opts: DiscordSinkOptions) {
    this.channels = opts.channels;
    this.fallbackUrl = opts.fallbackUrl;
  }

  get enabled(): boolean {
    return this.fallbackUrl !== null || this.channels.size > 0;
  }

  /**
   * Resolve without sending, so boot can report the routing table and /health
   * can expose it. A misrouted alert is a silent failure — the alert fires, it
   * just lands somewhere nobody is reading — so the mapping has to be
   * inspectable rather than only discoverable by watching channels.
   */
  resolve(channel: string): ChannelResolution {
    const key = channel.toLowerCase();
    if (this.channels.has(key)) {
      return { channel: key, via: 'channel', envVar: `DISCORD_WEBHOOK_${key.toUpperCase()}` };
    }
    if (this.fallbackUrl) {
      return { channel: key, via: 'fallback', envVar: 'DISCORD_WEBHOOK_URL' };
    }
    return { channel: key, via: 'none', envVar: null };
  }

  async send(alert: Alert, channel = 'system'): Promise<boolean> {
    const key = channel.toLowerCase();
    const resolution = this.resolve(key);
    const webhookUrl = this.channels.get(key) ?? this.fallbackUrl;

    if (!webhookUrl) {
      // Still emit the alert so it is not lost entirely when no webhook is set.
      log.warn('discord webhook not configured; alert not delivered', {
        alert_title: alert.title,
        alert_level: alert.level,
        channel: key,
      });
      return false;
    }

    if (resolution.via === 'fallback') {
      // Loud on purpose: this is the case where a forgotten variable sends
      // crypto alerts into the system channel and looks like it worked.
      log.warn('discord channel has no webhook of its own; using DISCORD_WEBHOOK_URL', {
        channel: key,
        expected_var: `DISCORD_WEBHOOK_${key.toUpperCase()}`,
      });
    }

    const body = {
      username: 'command-center',
      embeds: [
        {
          title: `${ICONS[alert.level]} ${alert.title}`.slice(0, 256),
          description: alert.description.slice(0, 4000),
          color: COLORS[alert.level],
          timestamp: new Date().toISOString(),
          fields: (alert.fields ?? []).slice(0, 25).map((f) => ({
            name: f.name.slice(0, 256),
            value: (f.value || '—').slice(0, 1024),
            inline: f.inline ?? true,
          })),
        },
      ],
    };

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        log.error('discord webhook rejected the alert', {
          channel: key,
          status: response.status,
          body: redact((await response.text().catch(() => '')).slice(0, 300)),
        });
        return false;
      }

      log.info('discord alert delivered', {
        alert_title: alert.title,
        alert_level: alert.level,
        channel: key,
        via: resolution.via,
      });
      return true;
    } catch (err) {
      log.error('discord webhook request failed', {
        error: redact((err as Error).message),
        alert_title: alert.title,
        channel: key,
      });
      return false;
    }
  }
}
