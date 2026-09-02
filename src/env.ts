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
  /**
   * Values a monitor's YAML may reference as ${NAME}, so a secret can be named
   * in committed config without its value living there. Populated from the
   * allowlist below rather than from all of process.env, so a typo in a YAML
   * cannot reach an unrelated variable.
   */
  configVars: Map<string, string>;
}

/** Environment variables monitor YAML is permitted to interpolate. */
const CONFIG_VAR_ALLOWLIST = ['HELIUS_API_KEY', 'HELIUS_RPC_URL', 'ALCHEMY_API_KEY'] as const;

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

  /*
   * Webhooks whose env var does not follow the DISCORD_WEBHOOK_<NAME> shape.
   *
   * ADDITIVE ONLY. Nothing above is changed, and an alias never overwrites a
   * channel the loop already registered. Without this, a monitor pointed at
   * "mos-price-alert" would resolve to no channel and DiscordSink would quietly
   * fall back to DISCORD_WEBHOOK_URL -- posting price alerts into the general
   * channel while reporting success. A missing alias is left unregistered
   * rather than defaulted, so /health shows via:"fallback" and the misrouting
   * is visible instead of silent.
   */
  const WEBHOOK_ALIASES: ReadonlyArray<readonly [string, string]> = [
    ['MOS_PRICE_CHECK', 'mos-price-alert'],
  ];
  for (const [envVar, channel] of WEBHOOK_ALIASES) {
    const value = process.env[envVar]?.trim();
    if (!value) continue;
    if (!value.startsWith('https://')) throw new Error(`${envVar} must be an https:// URL`);
    if (discordChannels.has(channel)) continue;   // never shadow a real channel
    discordChannels.set(channel, value);
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
    configVars: (() => {
      const m = new Map<string, string>();
      for (const key of CONFIG_VAR_ALLOWLIST) {
        const v = process.env[key]?.trim();
        if (v) m.set(key, v);
      }
      // Convenience: a bare Helius key becomes the RPC URL a monitor needs, so
      // the same secret does not have to be set twice in two shapes.
      const key = m.get('HELIUS_API_KEY');
      if (key && !m.has('HELIUS_RPC_URL')) {
        m.set('HELIUS_RPC_URL', `https://mainnet.helius-rpc.com/?api-key=${key}`);
      }
      return m;
    })(),
    // The scheduler wakes on this interval and runs whatever is due. It must be
    // meaningfully SHORTER than the shortest monitor schedule, not equal to it.
    //
    // At 30s it equalled the 30s minimum schedule, and a monitor on that
    // schedule ran at half rate. Each tick captures `now`, then awaits a
    // database round-trip before marking the monitor attempted, so the stamp
    // lands tens of milliseconds after `now`. The following tick therefore
    // computed an elapsed time a hair under 30,000ms, judged the monitor not
    // due, and skipped it until the tick after. Measured in production:
    // pumpfun-early-window drained every 60.0s against a configured 30s.
    //
    // A 5s tick leaves that headroom. It only changes when a due monitor is
    // noticed; isDue still gates every monitor by its own schedule, so nothing
    // runs more often than its configuration allows.
    tickMs: 5_000,
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
