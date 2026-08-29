/**
 * Monitors are defined in YAML, one file per monitor. Everything is validated
 * at boot so a bad config fails the deploy rather than becoming a silent hole.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface MonitorConfig {
  id: string;
  name: string;
  /** Adapter type key, e.g. "rss". */
  source: string;
  enabled: boolean;
  /** Original schedule string, kept for display. */
  schedule: string;
  scheduleMs: number;
  options: Record<string, unknown>;
  alerts: {
    discordOnConsecutiveFailures: number;
    /**
     * Which Discord channel this monitor's CONTENT alerts go to, resolved
     * against DISCORD_WEBHOOK_<CHANNEL>. Failure and recovery alerts ignore
     * this and always go to the system channel — an outage should surface in
     * one place regardless of which monitor broke.
     */
    channel: string;
  };
  dashboard: {
    windowHours: number;
  };
  /** Path the config was loaded from, for error messages. */
  sourceFile: string;
}

/**
 * Where a monitor's content alerts go when its YAML does not say. Also where
 * every failure and recovery alert goes, unconditionally.
 */
export const DEFAULT_ALERT_CHANNEL = 'system';

const DURATION = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseDuration(input: string, context: string): number {
  const match = DURATION.exec(input.trim());
  if (!match) {
    throw new Error(
      `${context}: invalid duration "${input}". Use forms like 30s, 15m, 1h, 2d.`,
    );
  }
  const amount = Number.parseFloat(match[1]!);
  const ms = amount * UNIT_MS[match[2]!.toLowerCase() as keyof typeof UNIT_MS];
  if (ms < 30_000) {
    throw new Error(`${context}: schedule "${input}" is below the 30s minimum.`);
  }
  return Math.round(ms);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMonitor(raw: unknown, file: string): MonitorConfig {
  if (!isPlainObject(raw)) {
    throw new Error(`${file}: expected a YAML mapping at the top level`);
  }

  const id = raw['id'];
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
    throw new Error(
      `${file}: "id" must be a lowercase slug (letters, digits, - and _), got: ${String(id)}`,
    );
  }

  const source = raw['source'];
  if (typeof source !== 'string' || source.trim() === '') {
    throw new Error(`${file}: "source" must name an adapter, e.g. rss`);
  }

  const schedule = raw['schedule'];
  if (typeof schedule !== 'string') {
    throw new Error(`${file}: "schedule" is required, e.g. 1h`);
  }

  const alerts = isPlainObject(raw['alerts']) ? raw['alerts'] : {};
  const threshold = alerts['discord_on_consecutive_failures'] ?? 3;
  if (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold < 1) {
    throw new Error(`${file}: alerts.discord_on_consecutive_failures must be an integer >= 1`);
  }

  const channelRaw = alerts['channel'] ?? DEFAULT_ALERT_CHANNEL;
  if (typeof channelRaw !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(channelRaw)) {
    throw new Error(
      `${file}: alerts.channel must be a lowercase slug naming a channel ` +
        `(it resolves to DISCORD_WEBHOOK_<CHANNEL>), got: ${String(channelRaw)}`,
    );
  }

  const dashboard = isPlainObject(raw['dashboard']) ? raw['dashboard'] : {};
  const windowHours = dashboard['window_hours'] ?? 24;
  if (typeof windowHours !== 'number' || windowHours <= 0) {
    throw new Error(`${file}: dashboard.window_hours must be a positive number`);
  }

  const name = raw['name'];
  const options = raw['options'];

  return {
    id,
    name: typeof name === 'string' && name.trim() ? name.trim() : id,
    source: source.trim(),
    enabled: raw['enabled'] !== false,
    schedule,
    scheduleMs: parseDuration(schedule, `${file}: schedule`),
    options: isPlainObject(options) ? options : {},
    alerts: { discordOnConsecutiveFailures: threshold, channel: channelRaw },
    dashboard: { windowHours },
    sourceFile: file,
  };
}

/**
 * Substitute ${VAR} placeholders in monitor YAML from a supplied map.
 *
 * Secrets must not sit in a committed YAML file, but an adapter reaching into
 * process.env directly would break the rule env.ts states: every
 * environment value enters the process in exactly one place. So the values are
 * resolved by env.ts and passed in here, and the YAML carries only the name.
 *
 * An unset variable is a hard error rather than an empty string, because a
 * monitor silently pointed at "" would fail later as a confusing network error
 * instead of a clear boot failure.
 */
export function interpolate(text: string, vars: Map<string, string>, path: string): string {
  return text.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name: string) => {
    const v = vars.get(name);
    if (v === undefined || v === '') {
      throw new Error(`${path}: \${${name}} is referenced but not set in the environment`);
    }
    return v;
  });
}

export async function loadMonitorConfigs(
  dir: string,
  vars: Map<string, string> = new Map(),
): Promise<MonitorConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new Error(
      `Could not read monitors directory "${dir}": ${(err as Error).message}`,
    );
  }

  const files = entries.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml')).sort();
  if (files.length === 0) {
    throw new Error(`No monitor configs found in "${dir}". Expected at least one .yaml file.`);
  }

  const monitors: MonitorConfig[] = [];
  const seen = new Map<string, string>();

  for (const file of files) {
    const path = join(dir, file);
    const text = interpolate(await readFile(path, 'utf8'), vars, path);
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (err) {
      throw new Error(`${path}: invalid YAML — ${(err as Error).message}`);
    }
    const monitor = parseMonitor(raw, path);
    const previous = seen.get(monitor.id);
    if (previous) {
      throw new Error(`Duplicate monitor id "${monitor.id}" in ${previous} and ${path}`);
    }
    seen.set(monitor.id, path);
    monitors.push(monitor);
  }

  return monitors;
}
