/**
 * Alert routing check: `npm run alert-test [channel ...]`
 *
 * Sends one test alert per channel and reports where each landed. Exists
 * because routing is the one part of alerting that cannot be verified by
 * reading logs: a misrouted alert is delivered successfully, it just arrives
 * somewhere nobody is watching. The only proof is looking in the channel.
 *
 * With no arguments it covers the system channel plus every channel any monitor
 * routes to. Deliberately does not touch Postgres, so it still works when the
 * database is down — which is exactly when alerting matters most.
 */

import { DEFAULT_ALERT_CHANNEL, loadMonitorConfigs } from '../config.js';
import { loadEnv } from '../env.js';
import { errorFields, log } from '../logger.js';
import { DiscordSink } from '../sinks/discord.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const monitors = await loadMonitorConfigs(env.monitorsDir);

  const discord = new DiscordSink({
    channels: env.discordChannels,
    fallbackUrl: env.discordWebhookUrl,
  });

  const requested = process.argv.slice(2).map((c) => c.toLowerCase());
  const targets = requested.length
    ? requested
    : [...new Set([DEFAULT_ALERT_CHANNEL, ...monitors.map((m) => m.alerts.channel)])];

  log.info('alert routing check starting', {
    channels_from_env: [...env.discordChannels.keys()],
    fallback_configured: env.discordWebhookUrl !== null,
    targets,
  });

  let failures = 0;

  for (const channel of targets) {
    const resolution = discord.resolve(channel);
    const users = monitors.filter((m) => m.alerts.channel === channel).map((m) => m.id);

    const description =
      resolution.via === 'channel'
        ? `Routing check for the \`${channel}\` channel. This message was delivered ` +
          `using \`${resolution.envVar}\`. If you are reading it in the channel you ` +
          `expect, routing for \`${channel}\` is correct.`
        : resolution.via === 'fallback'
          ? `Routing check for the \`${channel}\` channel. **No \`${`DISCORD_WEBHOOK_${channel.toUpperCase()}`}\` is set**, ` +
            `so this fell back to \`DISCORD_WEBHOOK_URL\` and arrived in the fallback ` +
            `channel rather than its own. Set that variable to fix routing.`
          : `Routing check for the \`${channel}\` channel. No webhook is configured for ` +
            `it and there is no fallback, so nothing can be delivered.`;

    const ok = await discord.send(
      {
        level: resolution.via === 'channel' ? 'recovery' : 'warning',
        title: `Routing check — ${channel}`,
        description,
        fields: [
          { name: 'Channel', value: channel, inline: true },
          { name: 'Resolved via', value: resolution.via, inline: true },
          { name: 'Variable', value: resolution.envVar ?? 'none', inline: true },
          {
            name: 'Content alerts from',
            value: users.length ? users.join(', ') : '(none yet)',
            inline: false,
          },
          {
            name: 'Failure/recovery alerts',
            value:
              channel === DEFAULT_ALERT_CHANNEL
                ? 'All monitors report failures and recoveries here.'
                : `Not here — those always go to \`${DEFAULT_ALERT_CHANNEL}\`.`,
            inline: false,
          },
        ],
      },
      channel,
    );

    if (!ok) failures += 1;
    log.info('routing check sent', {
      channel,
      resolved_via: resolution.via,
      env_var: resolution.envVar,
      delivered: ok,
      monitors: users,
    });
  }

  log.info('alert routing check complete', {
    sent: targets.length - failures,
    failed: failures,
  });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((err) => {
  log.error('alert-test failed', errorFields(err));
  process.exit(1);
});
