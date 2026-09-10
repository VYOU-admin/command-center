/**
 * Wallet scoring, one window: `npm run score -- <chain> <token> --tag TAG [--write]`
 *
 * A THIN WRAPPER over src/scoring/run.ts, which the recurring monitor also
 * calls. The logic used to live in this file's main(), so the only way to score
 * was to run this by hand -- and every token was scored once at intake and never
 * again while rows arrived hourly.
 *
 * READS THE DATABASE ONLY. Report-only unless --write.
 */

import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { withTransaction } from '../store/db.js';
import { SCORES_SCHEMA } from '../scoring/schema.js';
import { scoreWindow } from '../scoring/run.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const chain = positional[0];
  const token = positional[1];
  const tagIndex = args.indexOf('--tag');
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  const write = args.includes('--write');
  const topIndex = args.indexOf('--top');
  const top = topIndex >= 0 ? Number.parseInt(args[topIndex + 1] ?? '20', 10) : 20;

  if (!chain || !token || !tag) {
    throw new Error('usage: score <chain> <token> --tag <TAG> [--write] [--top N]');
  }

  const app = await bootstrap();
  await withTransaction(app.pool, (c) => c.query(SCORES_SCHEMA).then(() => undefined));
  const r = await scoreWindow(app.pool, chain, token, tag, { write, top });
  log.info('done', { ...r });
  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('score failed', errorFields(err));
  process.exit(1);
});
