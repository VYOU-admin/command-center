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

export class DiscordSink {
  constructor(private readonly webhookUrl: string | null) {}

  get enabled(): boolean {
    return this.webhookUrl !== null;
  }

  async send(alert: Alert): Promise<boolean> {
    if (!this.webhookUrl) {
      // Still emit the alert so it is not lost entirely when no webhook is set.
      log.warn('discord webhook not configured; alert not delivered', {
        alert_title: alert.title,
        alert_level: alert.level,
      });
      return false;
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
      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        log.error('discord webhook rejected the alert', {
          status: response.status,
          body: redact((await response.text().catch(() => '')).slice(0, 300)),
        });
        return false;
      }

      log.info('discord alert delivered', { alert_title: alert.title, alert_level: alert.level });
      return true;
    } catch (err) {
      log.error('discord webhook request failed', {
        error: redact((err as Error).message),
        alert_title: alert.title,
      });
      return false;
    }
  }
}
