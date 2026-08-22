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
  };
  dashboard: {
    windowHours: number;
  };
  /** Path the config was loaded from, for error messages. */
  sourceFile: string;
}

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
    alerts: { discordOnConsecutiveFailures: threshold },
    dashboard: { windowHours },
    sourceFile: file,
  };
}

export async function loadMonitorConfigs(dir: string): Promise<MonitorConfig[]> {
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
    const text = await readFile(path, 'utf8');
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
