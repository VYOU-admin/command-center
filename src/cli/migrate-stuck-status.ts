/**
 * `npm run migrate-stuck-status -- [--commit]`
 *
 * MOVES EVERY `exit_exhausted` ROW TO `needs_exit`, THE STATUS THE BOOT SWEEP LOOKS FOR.
 *
 * WHY THESE ROWS EXIST. When the in-loop exit ladder exhausted, the loop first wrote
 * `exit_exhausted` — a status in NO set. `NON_TERMINAL` does not contain it, so boot
 * reconciliation never examines those rows; `clearNeedsExit` looks only for `needs_exit`,
 * so nothing ever tries to sell them. The status was replaced by `needs_exit` on
 * 2026-09-16 for exactly that reason, **and the rows written before that fix were never
 * migrated** — LAUNCHBOT.md asserted they had been until the store was read. This is the
 * migration that makes the document true.
 *
 * WHAT IT CAUSES, WHICH MATTERS MORE THAN WHAT IT WRITES. A `needs_exit` row is acted on
 * at the next boot of that mode, BEFORE the bot arms: `clearNeedsExit` reads the holder's
 * balance and either resolves the row (balance zero) or climbs the exit ladder. **If the
 * ladder exhausts, or a row carries no address to sell from, it calls `halt()` — and the
 * kill switch is keyed on CHAIN, not mode, so it stops every mode on `robinhood`.** These
 * rows are precisely the ones whose ladder has already exhausted once, so that is not a
 * remote possibility. The dry run therefore predicts the boot outcome per row rather than
 * only counting rows, because "seven rows updated" is not the consequence anybody cares
 * about.
 *
 * THE DRY RUN IS THE DEFAULT and reports the counts the write must produce beside the
 * live figures they have to reconcile against. On any mismatch it aborts rather than
 * adjusting the numbers to fit.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { id } from 'ethers';
import type { PoolClient } from '../store/db.js';

const FROM_STATUS = 'exit_exhausted';
const TO_STATUS = 'needs_exit';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

/** Computed, never transcribed — see wallet-probe for why four bytes are not safe. */
const BALANCE_OF = id('balanceOf(address)').slice(0, 10);

interface Row {
  id: string; chain: string; mode: string; token: string; pool_id: string;
  position_usd: string | null; exit_sim_from: string | null; note: string | null;
  created_at: string;
}

async function counts(c: PoolClient): Promise<Record<string, number>> {
  const r = await c.query<{ status: string; n: string }>(
    `select status, count(*)::text n from bot_trades group by status`);
  const out: Record<string, number> = {};
  for (const x of r.rows) out[x.status] = Number(x.n);
  return out;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const app = await bootstrap();
  const c = await app.pool.connect();

  try {
    /* ---- 1. THE LIVE FIGURES, BEFORE ANYTHING ---------------------------- */
    const before = await counts(c);
    const totalBefore = Object.values(before).reduce((a, b) => a + b, 0);
    const rows = (await c.query<Row>(
      `select id::text, chain, mode, token, pool_id, position_usd::text,
              exit_sim_from, note, created_at::text
         from bot_trades where status = $1 order by id`, [FROM_STATUS])).rows;

    log.info('LIVE FIGURES BEFORE THE WRITE', {
      status_counts: before,
      total_rows: totalBefore,
      [`${FROM_STATUS}_rows`]: rows.length,
      [`${TO_STATUS}_rows`]: before[TO_STATUS] ?? 0,
      note: `a ${TO_STATUS} count of 0 is a result and is reported, not omitted`,
    });

    if (rows.length === 0) {
      /* A filter matching nothing is reported as such, never as a clean pass. */
      log.warn(`NO ROWS WITH status = '${FROM_STATUS}' — RETURNED NO ROWS`, {
        note: 'nothing to migrate; this is either already done or the wrong question',
      });
      c.release(); await app.pool.end(); process.exit(0);
    }

    /* ---- 2. WHAT THE WRITE WILL CAUSE, PER ROW --------------------------- */
    /*
     * The balance is read from the chain because it is what `clearNeedsExit` will read.
     * Predicting the boot outcome from the row alone would be predicting our own record
     * rather than the thing that adjudicates it.
     */
    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set; the boot outcome cannot be '
      + 'predicted and this migration will not be made blind');
    const rpc = new ReadOnlyRpc(new RpcClient(RPC_URL.replace('{key}', key), 60000, 50_000));

    const predictions: string[] = [];
    let willHalt = 0; let willResolve = 0; let willAttempt = 0;
    for (const r of rows) {
      if (!r.exit_sim_from) {
        willHalt += 1;
        predictions.push(`trade ${r.id} [${r.mode}] NO exit_sim_from -> BOOT EXIT `
          + 'IMPOSSIBLE: halts the CHAIN and the bot never arms');
        continue;
      }
      const data = BALANCE_OF + '0'.repeat(24) + r.exit_sim_from.slice(2).toLowerCase();
      const raw = await rpc.call('eth_call', [{ to: r.token, data }, 'latest']);
      if (typeof raw !== 'string' || raw === '0x') {
        /* Unknown is not zero, and here it decides a halt. */
        willHalt += 1;
        predictions.push(`trade ${r.id} [${r.mode}] balanceOf returned ${JSON.stringify(raw)} `
          + '-> UNKNOWN, not zero; the boot sweep would fail reading it');
        continue;
      }
      const bal = BigInt(raw);
      if (bal === 0n) {
        willResolve += 1;
        predictions.push(`trade ${r.id} [${r.mode}] holder balance 0 -> resolves to `
          + 'closed_unfilled at boot, no exit attempted, no halt');
      } else {
        willAttempt += 1;
        predictions.push(`trade ${r.id} [${r.mode}] holder holds ${bal} raw -> the boot `
          + 'sweep CLIMBS THE LADDER; if it exhausts it halts the CHAIN');
      }
    }

    log.warn('WHAT THIS WRITE WILL CAUSE AT THE NEXT BOOT OF THESE MODES', {
      rows: rows.length,
      will_resolve_without_an_exit: willResolve,
      will_attempt_the_ladder: willAttempt,
      will_halt_immediately: willHalt,
      per_row: predictions,
      kill_switch_scope: 'bot_control is keyed on CHAIN, so a halt stops every mode on '
        + 'robinhood, not only the mode that failed',
      cu_spent: rpc.cuSpent,
    });

    /* ---- 3. THE COUNTS THE WRITE MUST PRODUCE ---------------------------- */
    const expected = {
      [`${FROM_STATUS}_after`]: 0,
      [`${TO_STATUS}_after`]: (before[TO_STATUS] ?? 0) + rows.length,
      total_rows_after: totalBefore,
      rows_updated: rows.length,
    };
    log.info('THE COUNTS THIS WRITE MUST PRODUCE', {
      ...expected,
      reconciles_against: `${FROM_STATUS} ${rows.length} -> 0 and `
        + `${TO_STATUS} ${before[TO_STATUS] ?? 0} -> ${expected[`${TO_STATUS}_after`]}; `
        + `the total must not move because this updates rather than inserts`,
    });

    if (!commit) {
      log.info('DRY RUN — NOTHING WRITTEN', { note: 'pass --commit to apply' });
      c.release(); await app.pool.end(); process.exit(0);
    }

    /* ---- 4. THE WRITE, SCOPED AND CHECKED -------------------------------- */
    await c.query('begin');
    const upd = await c.query(
      `update bot_trades
          set status = $2,
              note = coalesce(note || ' | ', '')
                     || 'migrated from exit_exhausted 2026-09-16: a status no sweep reads',
              updated_at = now()
        where status = $1`, [FROM_STATUS, TO_STATUS]);
    const updated = upd.rowCount ?? 0;
    if (updated !== rows.length) {
      /* ABORT ON A MISMATCH rather than adjusting the number to fit. */
      await c.query('rollback');
      throw new Error(`the update touched ${updated} rows where the dry run counted `
        + `${rows.length}. ROLLED BACK — the figure approved is not the figure acted on.`);
    }
    await c.query('commit');
    log.info('WRITE COMMITTED', { rows_updated: updated });
  } finally {
    c.release();
  }

  /* ---- 5. VERIFY ON A FRESH CONNECTION --------------------------------- */
  /* A script that exited without throwing is not evidence the write landed. */
  const fresh = await app.pool.connect();
  try {
    const after = await counts(fresh);
    const totalAfter = Object.values(after).reduce((a, b) => a + b, 0);
    log.info('VERIFIED ON A FRESH CONNECTION', {
      status_counts: after,
      total_rows: totalAfter,
      [`${FROM_STATUS}_remaining`]: after[FROM_STATUS] ?? 0,
      [`${TO_STATUS}_now`]: after[TO_STATUS] ?? 0,
    });
    if ((after[FROM_STATUS] ?? 0) !== 0) {
      throw new Error(`${after[FROM_STATUS]} rows still carry '${FROM_STATUS}' after a `
        + 'write that reported success');
    }
  } finally { fresh.release(); }

  await app.pool.end();
  process.exit(0);
}

main().catch((err) => {
  log.error('migrate-stuck-status failed', errorFields(err)); process.exit(1);
});
