/**
 * `npm run resolve-unsellable -- --trade <id> [--commit]`
 * `npm run resolve-unsellable -- --clear-halt "<reason>" [--commit]`
 *
 * RESOLVES A POSITION THE EXIT LADDER CANNOT SELL, AND CLEARS THE HALT IT CAUSED.
 * docs/LAUNCHBOT.md section 4 and 2C.
 *
 * ---------------------------------------------------------------------------
 * IT PROVES THE POOL PAYS NOTHING RATHER THAN TAKING ANYBODY'S WORD
 * ---------------------------------------------------------------------------
 *
 * **THIS IS THE WHOLE DESIGN.** A tool that marks a position `closed_unsellable` because a
 * human said so is a tool for making an inconvenient loss disappear, and the difference
 * between "nothing will buy this" and "I would rather not look at this" is the difference
 * between a record and a fiction.
 *
 * So the premise is re-established from the chain, through **`executeExit` itself** — the
 * one executor the boot sweep and the loop both use — with no broadcaster, so it
 * simulates. Three outcomes, and only one of them resolves as unsellable:
 *
 *   - the ladder FILLS      -> the pool pays after all. The row is closed as a normal
 *                              exit and NOT marked unsellable. The tool was wrong and
 *                              says so.
 *   - it exhausts, actual=0 -> the pool pays NOTHING at any bound. Resolved
 *                              `closed_unsellable`, with the evidence in the note.
 *   - it exhausts, actual>0 -> the pool WOULD pay, just less than the widest rung. That
 *                              is a MISPRICED QUOTE, not a dead pool, and it REFUSES:
 *                              the ladder's own finding is that a retry rescues the first
 *                              and not the second, so calling it unsellable would hide a
 *                              position that is sellable at a price.
 *
 * `seed-stuck` set the precedent — it *"refused to seed cases whose balances were not
 * actually measured rather than inventing one"*.
 *
 * ---------------------------------------------------------------------------
 * CLEARING THE HALT IS A SEPARATE ACTION WITH ITS OWN GUARD
 * ---------------------------------------------------------------------------
 *
 * The kill switch is chain-wide by decision (section 4), and **the bot must never be able
 * to clear its own halt** — a process that can switch off the thing that switched it off
 * has no kill switch. This is an OPERATOR tool, not the bot, and it keeps that distinction
 * meaningful two ways:
 *
 *   - **it refuses to clear while ANY `needs_exit` row remains on the chain.** Clearing a
 *     halt while the condition that caused it persists is the failure the halt exists to
 *     prevent, and it is the reason this cannot be automated into the boot path.
 *   - **the existing reason is printed before anything is cleared**, and a new reason is
 *     REQUIRED, so the record says who cleared it and why rather than going blank.
 *
 * Dry by default. Counts before, counts after, on a fresh connection.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { executeExit } from '../bot/exit-exec.js';
import { readTokenBalance } from '../bot/allowance.js';
import { EXIT_RETRY } from '../bot/config.js';
import type { PoolClient } from '../store/db.js';

const CHAIN = 'robinhood';
const RPC_URL = 'https://robinhood-mainnet.g.alchemy.com/v2/{key}';

async function stuckCount(c: PoolClient): Promise<number> {
  const r = await c.query<{ n: string }>(
    `select count(*)::text n from bot_trades
      where chain = $1 and status = 'needs_exit'`, [CHAIN]);
  return Number(r.rows[0]!.n);
}

async function haltRow(c: PoolClient): Promise<{ halted: boolean; reason: string } | null> {
  const r = await c.query<{ halted: boolean; reason: string | null }>(
    'select halted, reason from bot_control where chain = $1', [CHAIN]);
  if (r.rowCount === 0) return null;
  return { halted: r.rows[0]!.halted, reason: r.rows[0]!.reason ?? '' };
}

async function clearHalt(
  c: PoolClient, reason: string, commit: boolean,
): Promise<void> {
  const before = await haltRow(c);
  const stuck = await stuckCount(c);
  log.info('LIVE FIGURES BEFORE CLEARING THE HALT', {
    halt_row: before === null ? 'RETURNED NO ROWS' : before,
    needs_exit_rows_on_this_chain: stuck,
    new_reason: reason,
  });
  if (before === null || !before.halted) {
    log.info('NOTHING TO CLEAR — the chain is not halted', {
      note: 'reported rather than treated as success; a halt that was never set is a '
        + 'different fact from one this run cleared',
    });
    return;
  }
  if (stuck > 0) {
    /*
     * THE GUARD. Clearing a halt while the condition that caused it persists is the
     * failure the halt exists to prevent.
     */
    throw new Error(`REFUSING TO CLEAR: ${stuck} needs_exit row(s) still exist on `
      + `${CHAIN}. The halt is doing its job. Resolve them first — a boot of their mode `
      + 'sweeps the ones whose holder balance is now zero, and this tool resolves one '
      + 'whose pool provably pays nothing.');
  }
  if (!commit) {
    log.info('DRY RUN — the halt is NOT cleared', { note: 'pass --commit to clear it' });
    return;
  }
  await c.query(
    `update bot_control set halted = false, reason = $2, updated_at = now()
      where chain = $1`, [CHAIN, reason]);
  log.info('HALT CLEARED', { reason });
}

async function resolveOne(
  c: PoolClient, rpc: ReadOnlyRpc, tradeId: string, commit: boolean,
): Promise<void> {
  const r = await c.query<{
    id: string; mode: string; status: string; pool_id: string; token: string;
    counter: string; fee: number; tick_spacing: number; hooks: string;
    first_swap_block: string; exit_sim_from: string | null; position_usd: string | null;
  }>(
    `select id::text, mode, status, pool_id, token, counter, fee, tick_spacing, hooks,
            first_swap_block::text, exit_sim_from, position_usd::text
       from bot_trades where chain = $1 and id = $2`, [CHAIN, tradeId]);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`no bot_trades row ${tradeId} on ${CHAIN}`);
  if (row.status !== 'needs_exit') {
    throw new Error(`trade ${tradeId} is '${row.status}', not 'needs_exit'. This tool only `
      + 'resolves a position the boot sweep could not sell; anything else is a different '
      + 'question and must not be marked unsellable.');
  }
  if (row.exit_sim_from === null) {
    throw new Error(`trade ${tradeId} carries no address to sell from, so nothing can be `
      + 'simulated and its sellability cannot be established.');
  }

  /* THE BALANCE FIRST. A zero balance is not unsellable — it is GONE, and the boot
   * sweep resolves that as `closed_unfilled` without any of this. */
  const bal = await readTokenBalance(rpc, row.token, row.exit_sim_from);
  log.info('THE POSITION, AND WHAT IS BEING ESTABLISHED', {
    trade: tradeId, mode: row.mode, pool: row.pool_id,
    token: row.token, holder: row.exit_sim_from,
    holder_balance_raw: bal.toString(),
    position_usd: row.position_usd,
    ladder: EXIT_RETRY.BOUND_BPS,
    question: 'does this pool pay ANYTHING at the widest measured rung? Re-established '
      + 'from the chain through executeExit, the same executor the boot sweep uses.',
  });
  if (bal === 0n) {
    throw new Error(`the holder holds NONE of ${row.token}. That is a resolved position, `
      + 'not an unsellable one: a boot of its mode closes it as closed_unfilled. '
      + 'Refusing to mark a position that is gone as unsellable.');
  }

  /* ---- THE PREMISE, RE-ESTABLISHED THROUGH THE ONE EXECUTOR ------------- */
  let filled = false; let detail = '';
  try {
    const out = await executeExit(
      {
        rpc, client: c, chain: CHAIN, broadcaster: null,
        wait: async (): Promise<void> => {},
      },
      {
        tradeId, poolId: row.pool_id, token: row.token, counter: row.counter,
        fee: row.fee, tickSpacing: row.tick_spacing, hooks: row.hooks,
        amountIn: bal, firstSwapBlock: Number(row.first_swap_block),
        sellFrom: row.exit_sim_from,
      },
    );
    filled = out.filled;
    detail = out.attempts[out.attempts.length - 1]?.detail ?? '';
  } catch (e) {
    detail = (e as Error).message;
  }

  if (filled) {
    /*
     * THE POOL PAYS AFTER ALL. Not unsellable, and the tool says it was wrong rather
     * than resolving anyway.
     */
    log.warn('THE EXIT SIMULATED CLEAN — THIS POSITION IS NOT UNSELLABLE', {
      trade: tradeId, detail: detail.slice(0, 160),
      note: 'the pool pays at a bound on the ladder. Nothing is marked unsellable. Boot '
        + 'its mode and let the sweep sell it, which is the path that exists for this.',
    });
    return;
  }

  /*
   * IT EXHAUSTED. NOW THE DISTINCTION THAT DECIDES EVERYTHING: did the pool offer
   * nothing at all, or merely less than the widest rung?
   */
  const paysNothing = /actual=0(?![0-9])/.test(detail);
  if (!paysNothing) {
    throw new Error(`trade ${tradeId} exhausted the ladder but the pool did NOT report `
      + `paying zero. Last reason: ${detail.slice(0, 200)}\n`
      + 'That is a MISPRICED QUOTE or a bound too tight, not a dead pool — the position '
      + 'is sellable at some price and marking it unsellable would hide that. Refusing.');
  }

  log.info('ESTABLISHED: THE POOL PAYS NOTHING AT ANY RUNG', {
    trade: tradeId,
    evidence: detail.slice(0, 200),
    rungs_tried: EXIT_RETRY.BOUND_BPS,
    note: 'V4TooLittleReceived reports what the pool WOULD pay, and it reported 0 at '
      + 'every rung. No bound can rescue that — a retry ladder rescues a mispriced quote, '
      + 'not a dead pool.',
  });

  const expected = { status_after: 'closed_unsellable', rows_updated: 1 };
  log.info('THE COUNTS THIS WRITE MUST PRODUCE', expected);
  if (!commit) {
    log.info('DRY RUN — NOTHING WRITTEN', { note: 'pass --commit to resolve' });
    return;
  }

  const upd = await c.query(
    `update bot_trades
        set status = 'closed_unsellable',
            note = coalesce(note || ' | ', '')
                   || 'resolve-unsellable: pool pays 0 at every rung ('
                   || $3 || '); ' || $4,
            updated_at = now()
      where chain = $1 and id = $2 and status = 'needs_exit'`,
    [CHAIN, tradeId, EXIT_RETRY.BOUND_BPS.join('/') + ' bps', detail.slice(0, 120)]);
  if ((upd.rowCount ?? 0) !== 1) {
    throw new Error(`the update touched ${upd.rowCount} rows where 1 was expected; the `
      + 'row may have changed status underneath this run');
  }
  log.info('RESOLVED', { trade: tradeId, status: 'closed_unsellable' });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const ti = args.indexOf('--trade');
  const ci = args.indexOf('--clear-halt');
  if ((ti >= 0) === (ci >= 0)) {
    throw new Error('pass exactly one of --trade <id> or --clear-halt "<reason>". They are '
      + 'separate actions: one resolves a position, the other lifts a chain-wide stop, and '
      + 'doing both in one command would hide which of them a run performed.');
  }

  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    if (ci >= 0) {
      const reason = String(args[ci + 1] ?? '');
      if (reason.trim() === '' || reason.startsWith('--')) {
        throw new Error('--clear-halt requires a reason. The record must say who cleared '
          + 'the halt and why rather than going blank.');
      }
      await clearHalt(c, reason, commit);
    } else {
      const key = process.env['ALCHEMY_API_KEY'];
      if (!key) throw new Error('ALCHEMY_API_KEY is not set');
      const rpc = new ReadOnlyRpc(
        new RpcClient(RPC_URL.replace('{key}', key), 60000, 50_000));
      await resolveOne(c, rpc, String(args[ti + 1] ?? ''), commit);
    }
  } finally { c.release(); }

  /* VERIFY ON A FRESH CONNECTION. A clean exit is not evidence. */
  const fresh = await app.pool.connect();
  try {
    log.info('VERIFIED ON A FRESH CONNECTION', {
      needs_exit_rows: await stuckCount(fresh),
      halt_row: (await haltRow(fresh)) ?? 'RETURNED NO ROWS',
    });
  } finally { fresh.release(); }

  await app.pool.end();
  process.exit(0);
}

main().catch((e) => {
  log.error('resolve-unsellable failed', errorFields(e)); process.exit(1);
});
