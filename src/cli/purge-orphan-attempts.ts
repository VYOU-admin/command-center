/**
 * `npm run purge-orphan-attempts -- [--commit]`
 *
 * DELETES `bot_exit_attempts` ROWS WHOSE TRADE DOES NOT EXIST ON THEIR CHAIN.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS: A DRILL WROTE INTO LIVE DATA
 * ---------------------------------------------------------------------------
 *
 * `exit-exec`'s attempt insert carried the literal `'robinhood'` as its chain rather than
 * taking it from its caller. `exit-broadcast-drill` runs on `chain='drill'` and deletes
 * `chain='drill'` afterwards, so its first run left **three orphan rows under
 * `chain='robinhood'`** carrying trade ids that do not exist there — including one, 336,
 * that is not a trade at all.
 *
 * **THAT MATTERS BECAUSE `bot_exit_attempts` IS A MEASUREMENT TABLE, NOT A LOG.** The
 * ladder's own effectiveness was derived from it — run 4's rung table, *39 attempts across
 * 17 trades, one rescued at rung 2*, was read out of these rows — so false rows there
 * corrupt a future derivation rather than merely sitting around. The cause is fixed
 * (`ExitExecContext.chain` is required), and this removes what the defect already wrote.
 *
 * **AN ORPHAN IS DEFINED BY THE JOIN, NOT BY A DATE OR A SHAPE.** Deleting "rows that look
 * like the drill's" would mean guessing, and a guess that deletes a real attempt destroys
 * evidence. A row whose `(chain, trade_id)` has no `bot_trades` row cannot describe a real
 * position under any reading, and that is the whole test.
 *
 * Dry by default. Counts are reported before the write and reconciled after it on a fresh
 * connection, per the standing protocol.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import type { PoolClient } from '../store/db.js';

const ORPHAN_WHERE = `not exists (
  select 1 from bot_trades t where t.id = a.trade_id and t.chain = a.chain)`;

async function counts(c: PoolClient): Promise<{ total: number; orphans: number }> {
  const t = await c.query<{ n: string }>('select count(*)::text n from bot_exit_attempts');
  const o = await c.query<{ n: string }>(
    `select count(*)::text n from bot_exit_attempts a where ${ORPHAN_WHERE}`);
  return { total: Number(t.rows[0]!.n), orphans: Number(o.rows[0]!.n) };
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const before = await counts(c);
    const rows = await c.query<{
      chain: string; trade_id: string; attempt: number; detail: string; recorded_at: string;
    }>(
      `select a.chain, a.trade_id, a.attempt, left(a.detail, 70) detail,
              a.recorded_at::text
         from bot_exit_attempts a where ${ORPHAN_WHERE}
        order by a.recorded_at desc`);

    log.info('LIVE FIGURES BEFORE THE WRITE', {
      bot_exit_attempts_total: before.total,
      orphans: before.orphans,
      note: 'an orphan is a row whose (chain, trade_id) has no bot_trades row. Zero is a '
        + 'result and is reported, not omitted.',
      rows: rows.rows.map((r) => `${r.chain} trade ${r.trade_id} attempt ${r.attempt} `
        + `@ ${r.recorded_at} :: ${r.detail}`),
    });

    if (before.orphans === 0) {
      log.info('NOTHING TO PURGE — RETURNED NO ROWS', {
        note: 'the table holds no attempt row without a matching trade',
      });
      c.release(); await app.pool.end(); process.exit(0);
    }

    const expected = {
      orphans_after: 0,
      total_after: before.total - before.orphans,
      rows_deleted: before.orphans,
    };
    log.info('THE COUNTS THIS WRITE MUST PRODUCE', {
      ...expected,
      reconciles_against: `${before.total} total - ${before.orphans} orphans = `
        + `${expected.total_after}`,
    });

    if (!commit) {
      log.info('DRY RUN — NOTHING WRITTEN', { note: 'pass --commit to apply' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    await c.query('begin');
    const del = await c.query(
      `delete from bot_exit_attempts a where ${ORPHAN_WHERE}`);
    const n = del.rowCount ?? 0;
    if (n !== before.orphans) {
      /* ABORT rather than adjusting the figure to fit. */
      await c.query('rollback');
      throw new Error(`the delete touched ${n} rows where the dry run counted `
        + `${before.orphans}. ROLLED BACK — the figure approved is not the figure acted `
        + 'on.');
    }
    await c.query('commit');
    log.info('WRITE COMMITTED', { rows_deleted: n });
  } finally { c.release(); }

  /* VERIFY ON A FRESH CONNECTION — a clean exit is not evidence the write landed. */
  const fresh = await app.pool.connect();
  try {
    const after = await counts(fresh);
    log.info('VERIFIED ON A FRESH CONNECTION', {
      bot_exit_attempts_total: after.total,
      orphans_remaining: after.orphans,
    });
    if (after.orphans !== 0) {
      throw new Error(`${after.orphans} orphan attempt row(s) remain after a write that `
        + 'reported success');
    }
  } finally { fresh.release(); }

  await app.pool.end();
  process.exit(0);
}

main().catch((e) => {
  log.error('purge-orphan-attempts failed', errorFields(e)); process.exit(1);
});
