/**
 * Every secret and environment-specific value enters the process here.
 * Nothing else in the codebase reads process.env, and nothing is hardcoded.
 */

import { resolve } from 'node:path';

export interface Env {
  /** Postgres connection string. Required. */
  databaseUrl: string;
  /**
   * Legacy single webhook, now the fallback for any channel without its own.
   * Optional; alerts degrade to logs when neither this nor a channel is set.
   */
  discordWebhookUrl: string | null;
  /**
   * Per-channel webhooks, keyed by lowercased channel name.
   *
   * Discovered from the environment rather than listed here: any variable named
   * DISCORD_WEBHOOK_<NAME> becomes channel <name>. Adding a channel is setting
   * a variable and naming it in a monitor's YAML — it never requires editing
   * code, which is the same promise the adapter registry makes for sources.
   */
  discordChannels: Map<string, string>;
  /** Railway injects PORT; default is for local runs. */
  port: number;
  /** Directory holding monitor YAML files. */
  monitorsDir: string;
  /** How often the scheduler wakes up to look for due monitors. */
  tickMs: number;
  /** Public dashboard URL, used to link alerts back. Null when unknown. */
  publicUrl: string | null;
}

export function loadEnv(): Env {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is not set. Attach a Postgres database (Railway sets this ' +
        'automatically) or copy .env.example to .env for local development.',
    );
  }

  const rawPort = process.env.PORT?.trim();
  const port = rawPort ? Number.parseInt(rawPort, 10) : 3000;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a valid port number, got: ${rawPort}`);
  }

  const discordWebhookUrl = process.env.DISCORD_WEBHOOK_URL?.trim() || null;
  if (discordWebhookUrl && !discordWebhookUrl.startsWith('https://')) {
    throw new Error('DISCORD_WEBHOOK_URL must be an https:// URL');
  }

  // DISCORD_WEBHOOK_URL is the fallback, not a channel called "url".
  const discordChannels = new Map<string, string>();
  for (const [key, raw] of Object.entries(process.env)) {
    const match = /^DISCORD_WEBHOOK_(.+)$/.exec(key);
    if (!match || key === 'DISCORD_WEBHOOK_URL') continue;
    const value = raw?.trim();
    if (!value) continue;
    if (!value.startsWith('https://')) {
      throw new Error(`${key} must be an https:// URL`);
    }
    discordChannels.set(match[1]!.toLowerCase(), value);
  }

  // Railway injects RAILWAY_PUBLIC_DOMAIN once a domain is attached, so alerts
  // can link back to the dashboard without any extra configuration.
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  const publicUrl =
    process.env.PUBLIC_URL?.trim().replace(/\/+$/, '') ||
    (railwayDomain ? `https://${railwayDomain}` : null);

  return {
    databaseUrl,
    discordWebhookUrl,
    discordChannels,
    port,
    monitorsDir: resolve(process.env.MONITORS_DIR?.trim() || 'monitors'),
    tickMs: 30_000,
    publicUrl,
  };
}

/**
 * Connection strings and webhooks end up in log lines and error messages by
 * accident. Scrub credentials before anything leaves the process.
 */
export function redact(value: string): string {
  return value
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//***:***@')
    .replace(/(https:\/\/discord\.com\/api\/webhooks\/\d+\/)[\w-]+/g, '$1***');
}
