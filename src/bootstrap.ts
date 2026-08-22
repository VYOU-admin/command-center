/**
 * Shared startup: read env, load configs, discover adapters, connect Postgres,
 * create tables, sync the registry. Used by both the long-running service and
 * the one-shot CLI so they can never drift apart.
 */

import { loadAdapters } from './adapters/registry.js';
import type { SourceAdapter } from './adapters/types.js';
import { Alerter } from './alerts.js';
import { loadMonitorConfigs, type MonitorConfig } from './config.js';
import { loadEnv, redact, type Env } from './env.js';
import { log } from './logger.js';
import { DiscordSink } from './sinks/discord.js';
import { createPool, migrate, type Pool } from './store/db.js';
import { syncMonitors } from './store/registry.js';

export interface App {
  env: Env;
  pool: Pool;
  monitors: MonitorConfig[];
  adapters: Map<string, SourceAdapter>;
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
    discord_configured: env.discordWebhookUrl !== null,
    database: redact(env.databaseUrl),
  });

  if (!env.discordWebhookUrl) {
    log.warn(
      'DISCORD_WEBHOOK_URL is not set — failure alerts will only appear in logs and /health',
    );
  }

  const pool = createPool(env.databaseUrl);
  await migrate(pool);
  await syncMonitors(pool, monitors);

  const discord = new DiscordSink(env.discordWebhookUrl);
  const alerter = new Alerter(pool, discord, env);

  return { env, pool, monitors, adapters, discord, alerter };
}
