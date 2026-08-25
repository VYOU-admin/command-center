/**
 * Shared startup: read env, load configs, discover adapters, connect Postgres,
 * create tables, sync the registry. Used by both the long-running service and
 * the one-shot CLI so they can never drift apart.
 */

import { loadAdapters } from './adapters/registry.js';
import type { AnyAdapter } from './adapters/types.js';
import { Alerter } from './alerts.js';
import { DEFAULT_ALERT_CHANNEL, loadMonitorConfigs, type MonitorConfig } from './config.js';
import { loadEnv, redact, type Env } from './env.js';
import { log } from './logger.js';
import { DiscordSink } from './sinks/discord.js';
import { createPool, migrate, withTransaction, type Pool } from './store/db.js';
import { reconcileRecordCounts, syncMonitors } from './store/registry.js';

export interface App {
  env: Env;
  pool: Pool;
  monitors: MonitorConfig[];
  adapters: Map<string, AnyAdapter>;
  discord: DiscordSink;
  alerter: Alerter;
}

export async function bootstrap(): Promise<App> {
  const env = loadEnv();

  const [monitors, adapters] = await Promise.all([
    loadMonitorConfigs(env.monitorsDir),
    loadAdapters(),
  ]);

  // Validate every monitor against its adapter before touching the database.
  // A typo in a YAML file should fail the deploy immediately and loudly, not
  // turn into a monitor that silently never produces anything.
  for (const monitor of monitors) {
    const adapter = adapters.get(monitor.source);
    if (!adapter) {
      throw new Error(
        `${monitor.sourceFile}: unknown source "${monitor.source}". ` +
          `Available: ${[...adapters.keys()].join(', ')}`,
      );
    }
    adapter.validate(monitor.options, monitor.id);
  }

  log.info('configuration loaded', {
    adapters: [...adapters.keys()],
    monitors: monitors.map((m) => ({
      id: m.id,
      source: m.source,
      schedule: m.schedule,
      enabled: m.enabled,
    })),
    discord_channels: [...env.discordChannels.keys()],
    discord_fallback_configured: env.discordWebhookUrl !== null,
    database: redact(env.databaseUrl),
  });

  if (!env.discordWebhookUrl && env.discordChannels.size === 0) {
    log.warn(
      'no Discord webhooks configured — alerts will only appear in logs and /health',
    );
  }

  const pool = createPool(env.databaseUrl);
  await migrate(pool);

  // Adapters that own their storage declare their own tables. Run these after
  // the core schema and only for adapters a configured monitor actually uses,
  // so an unused adapter never creates tables in the database.
  const usedSources = new Set(monitors.map((m) => m.source));
  for (const [type, adapter] of adapters) {
    if (!adapter.migrate || !usedSources.has(type)) continue;
    await withTransaction(pool, (client) => adapter.migrate!(client));
    log.info('adapter schema ready', { source: type });
  }

  await syncMonitors(pool, monitors);
  await reconcileRecordCounts(pool);

  const discord = new DiscordSink({
    channels: env.discordChannels,
    fallbackUrl: env.discordWebhookUrl,
  });

  // Report the routing table at boot. A misrouted alert still fires, it just
  // lands where nobody is looking, so the mapping has to be visible without
  // having to watch every channel to discover it.
  const routing = [
    { channel: DEFAULT_ALERT_CHANNEL, used_for: 'all failure/recovery alerts' },
    ...[...new Set(monitors.map((m) => m.alerts.channel))]
      .filter((c) => c !== DEFAULT_ALERT_CHANNEL)
      .map((c) => ({
        channel: c,
        used_for: monitors.filter((m) => m.alerts.channel === c).map((m) => m.id).join(', '),
      })),
  ].map((entry) => ({ ...entry, ...discord.resolve(entry.channel) }));

  log.info('discord alert routing', {
    channels_configured: [...env.discordChannels.keys()],
    fallback_configured: env.discordWebhookUrl !== null,
    routing,
  });

  for (const entry of routing.filter((r) => r.via !== 'channel')) {
    if (entry.via === 'fallback') {
      log.warn('alert channel falling back to DISCORD_WEBHOOK_URL', {
        channel: entry.channel,
        expected_var: `DISCORD_WEBHOOK_${entry.channel.toUpperCase()}`,
        used_for: entry.used_for,
      });
    } else {
      log.warn('alert channel has no webhook at all; alerts will only reach logs', {
        channel: entry.channel,
        used_for: entry.used_for,
      });
    }
  }
  const alerter = new Alerter(pool, discord, env);

  return { env, pool, monitors, adapters, discord, alerter };
}
