/**
 * `npm run pump-points -- <config.yaml> [--commit]`
 *
 * Writes a token's pump points into `token_events` from its intake config.
 *
 * WHY THIS EXISTS. `token_events` is created by SCORES_SCHEMA and read by
 * scoring/run.ts, and until 2026-09-13 it was written by NO CODE in this
 * repository -- the same shape as `token_swap_logs`, which section 9 records. Every
 * earlier token's pumps were inserted by hand, so a fresh database would have
 * scored nothing and `scoreWindow` would have raised "no pump events stored" with
 * no path to fix it. `pump_points` in an intake config was inert: `plan.ts` never
 * read the key.
 *
 * EVERY INSTANT MUST CARRY ITS OFFSET, rejected otherwise, for exactly the reason
 * a window bound is: "08-07 04:00 Eastern" is a different moment from "08-07 04:00
 * UTC" by four hours in August, and metrics 5 and 6 both key off a 48-hour window
 * and a linear distance to this instant. The offset is not cosmetic.
 *
 * DRY RUN BY DEFAULT. Reads the config and the stored rows, reports both, and
 * writes only with --commit.
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { loadIntakeConfig } from '../intake/plan.js';
import { SCORES_SCHEMA } from '../scoring/schema.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const configPath = args.find((a) => !a.startsWith('--'));
  if (!configPath) throw new Error('usage: pump-points <config.yaml> [--commit]');
  const commit = args.includes('--commit');

  const cfg = await loadIntakeConfig(configPath);
  /*
   * Read the raw YAML for `pump_points` rather than adding it to IntakeConfig.
   * The intake config is the token's specification and this reads one key from it;
   * threading it through the parsed shape would put a scoring input on every phase
   * that never uses it.
   */
  const raw = parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  const list = raw['pump_points'];
  if (!Array.isArray(list) || list.length === 0) {
    /*
     * ZERO IS NOT A QUIET PASS. A token with no pump points cannot be scored at
     * all -- scoreWindow raises -- so an empty list is a configuration error to
     * report, not an empty result to carry forward.
     */
    throw new Error(
      `${configPath} has no pump_points. Metrics 5 and 6 are defined against them `
      + 'and scoreWindow raises without them, so an empty list cannot be scored.',
    );
  }

  const OFFSET = /(Z|[+-]\d{2}:?\d{2})$/;
  const instants = list.map((v, i) => {
    const str = String(v);
    if (!OFFSET.test(str)) {
      throw new Error(
        `pump_points[${i}] "${str}" has no timezone offset. "04:00 Eastern" and `
        + '"04:00 UTC" are four hours apart in August and both metrics key off a '
        + '48-hour window, so the offset is required.',
      );
    }
    const d = new Date(str);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`pump_points[${i}] "${str}" is not a valid instant`);
    }
    return { raw: str, iso: d.toISOString() };
  });

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query(SCORES_SCHEMA);
    const before = await c.query<{ event_at: string }>(
      `select event_at::text from token_events
        where chain = $1 and token = $2 and kind = 'pump' order by event_at`,
      [cfg.chain, cfg.token],
    );
    log.info(commit ? 'WRITING pump points' : 'DRY RUN', {
      token: cfg.token, ticker: cfg.ticker,
      from_config: instants.map((x) => `${x.raw}  ->  ${x.iso}`),
      already_stored: before.rowCount,
      already_stored_list: before.rows.map((r) => r.event_at),
    });

    if (!commit) {
      log.info('nothing written; pass --commit', {});
    } else {
      let inserted = 0;
      for (const x of instants) {
        const r = await c.query(
          `insert into token_events (chain, token, kind, event_at, label)
           values ($1, $2, 'pump', $3::timestamptz, $4)
           on conflict (chain, token, kind, event_at) do nothing`,
          [cfg.chain, cfg.token, x.raw, `${cfg.ticker} pump`],
        );
        inserted += r.rowCount ?? 0;
      }
      /*
       * VERIFY, DO NOT ASSUME. Re-read and require the stored set to hold every
       * configured instant; the statements having run is not evidence, and scoring
       * silently using a short list would weight metrics 5 and 6 against the wrong
       * number of pumps.
       */
      const after = await c.query<{ event_at: string }>(
        `select event_at::text from token_events
          where chain = $1 and token = $2 and kind = 'pump' order by event_at`,
        [cfg.chain, cfg.token],
      );
      const storedIso = new Set(after.rows.map((r) => new Date(r.event_at).toISOString()));
      const missing = instants.filter((x) => !storedIso.has(x.iso));
      if (missing.length > 0) {
        throw new Error(
          `after writing, ${missing.length} configured pump point(s) are not stored: `
          + missing.map((m) => m.iso).join(', '),
        );
      }
      log.info('pump points written', {
        inserted, already_present: instants.length - inserted,
        stored_total: after.rowCount,
        stored: after.rows.map((r) => r.event_at),
      });
    }
  } finally {
    c.release();
  }
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => { log.error('pump-points failed', errorFields(err)); process.exit(1); });
