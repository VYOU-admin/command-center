/**
 * A LOADED TOKEN WITHOUT AN HOURLY MONITOR MUST NOT LOOK COMPLETE.
 *
 * The intake writes rows up to wherever it swept and stops. Nothing in it
 * requires a monitor, so a token can finish every phase, score, and render on
 * the dashboard while never advancing again -- which is exactly what happened to
 * AI: loaded, scored, verified, and then 26,883,347 blocks behind head a month
 * later with no error anywhere, because there was no error to raise.
 *
 * The intake cannot CREATE the monitor: monitors are YAML in the repository,
 * read at boot, and a file written by a container does not survive it or reach
 * git. So the gate is the other half of the instruction -- fail loudly, name the
 * file to add, and refuse to call the intake finished without it.
 *
 * It also checks the values that must AGREE with the intake config. Copying
 * another token's monitor is the natural shortcut and silently wrong: a
 * `bucket_origin` from the wrong token matches no stored bucket and prices every
 * row null, and a missing `bridge_assets` drops every bridge-quoted pool.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface MonitorMatch {
  id: string;
  file: string;
  problems: string[];
}

export async function findMonitorFor(
  dir: string,
  token: string,
  expect: { bucketOrigin: number; bridgeAssets: string[]; tokenUsdTable: string },
): Promise<MonitorMatch | null> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
  } catch {
    return null;
  }
  for (const f of files) {
    const raw = parse(await readFile(join(dir, f), 'utf8')) as Record<string, unknown> | null;
    const opts = (raw?.['options'] ?? {}) as Record<string, unknown>;
    if (String(opts['token'] ?? '').toLowerCase() !== token.toLowerCase()) continue;

    const problems: string[] = [];
    if (raw?.['enabled'] === false) problems.push('the monitor is disabled');
    const pricing = (opts['pricing'] ?? {}) as Record<string, unknown>;
    const origin = Number(pricing['bucket_origin'] ?? NaN);
    if (origin !== expect.bucketOrigin) {
      problems.push(
        `bucket_origin is ${String(pricing['bucket_origin'])} but the intake used `
        + `${expect.bucketOrigin}. A wrong anchor matches no stored bucket and prices `
        + 'every row null.',
      );
    }
    const bridges = Array.isArray(pricing['bridge_assets'])
      ? (pricing['bridge_assets'] as unknown[]).map((x) => String(x).toLowerCase()).sort()
      : [];
    const want = expect.bridgeAssets.map((a) => a.toLowerCase()).sort();
    if (JSON.stringify(bridges) !== JSON.stringify(want)) {
      problems.push(
        `bridge_assets is ${JSON.stringify(bridges)} but the intake used `
        + `${JSON.stringify(want)}. A missing bridge drops every pool quoted in it.`,
      );
    }
    const tables = (opts['tables'] ?? {}) as Record<string, unknown>;
    if (String(tables['token_usd'] ?? '') !== expect.tokenUsdTable) {
      problems.push(
        `tables.token_usd is ${String(tables['token_usd'])} but the intake wrote `
        + `${expect.tokenUsdTable}.`,
      );
    }
    return { id: String(raw?.['id'] ?? f), file: f, problems };
  }
  return null;
}

/** Raises unless a correctly configured, enabled monitor exists for the token. */
export async function requireMonitorFor(
  dir: string,
  ticker: string,
  token: string,
  expect: { bucketOrigin: number; bridgeAssets: string[]; tokenUsdTable: string },
): Promise<MonitorMatch> {
  const m = await findMonitorFor(dir, token, expect);
  if (!m) {
    throw new Error(
      `${ticker} has no hourly monitor. Every phase can pass and the token will still `
      + `stop advancing the moment the intake ends, with nothing to say so -- AI sat `
      + `26,883,347 blocks behind head for a month exactly this way. Add `
      + `monitors/${ticker.toLowerCase()}-updates.yaml with source: token-updates, its own `
      + `id, token: "${token}", the cohort tags, seed_cursor_block at the last swept block, `
      + `pricing.bucket_origin: ${expect.bucketOrigin}, `
      + `pricing.bridge_assets: ${JSON.stringify(expect.bridgeAssets)} and `
      + `tables.token_usd: ${expect.tokenUsdTable}. Then re-run.`,
    );
  }
  if (m.problems.length > 0) {
    throw new Error(
      `${ticker}'s monitor ${m.file} disagrees with the intake config: `
      + `${m.problems.join(' ')} Copying another token's monitor is the usual cause.`,
    );
  }
  return m;
}
