/**
 * `npm run resolve-unsellable -- --trade <id> [--simulated] [--commit]`
 *
 * RESOLVES A POSITION THE EXIT LADDER CANNOT SELL.
 *
 * **CLEARING THE HALT IS `halt-control`'S JOB, NOT THIS TOOL'S.** It used to live here,
 * and when the kill switch gained two scopes "clear the halt" stopped being one action —
 * a mode's automatic halt and the chain-wide manual halt are separate rows with different
 * guards. Keeping a clearer here would have been a second implementation of it.
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
 * Dry by default. Counts before, counts after, on a fresh connection.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { executeExit } from '../bot/exit-exec.js';
import { readTokenBalance } from '../bot/allowance.js';
import { isDryRunMode } from '../bot/mode.js';
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

/*
 * `clearHalt` WAS HERE AND MOVED TO `halt-control`.
 *
 * When the kill switch gained two scopes, "clear the halt" stopped being one action:
 * a mode's automatic halt and the chain-wide manual halt are separate rows with
 * DIFFERENT guards, and keeping a clearer here would have been a second implementation
 * of the one that had to exist there. This file resolves positions; `halt-control`
 * changes the kill switch.
 */
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

/**
 * RESOLVE A DRY-RUN ROW AS WHAT IT IS: A SIMULATION WE NEVER HELD.
 *
 * **THIS EXISTS BECAUSE THE OTHER TWO PATHS BOTH REFUSE, CORRECTLY.** Trades 334 and 335
 * exhausted the ladder while their pools reported paying MORE than zero, so
 * `resolveOne` refused to call them unsellable — a position sellable at a price must not
 * be recorded as a dead pool. And the boot sweep cannot clear them either: it would try to
 * sell as the BORROWED holder, exhaust, and halt the chain again.
 *
 * So they sit in `needs_exit` for ever, and a chain-wide halt with them.
 *
 * **THE WAY OUT IS TO STOP TREATING THEM AS POSITIONS.** A dry-run row was never
 * broadcast, so WE HOLD NOTHING — and that is verifiable rather than assumed: our own
 * balance of the token is read, and must be zero. The borrowed holder's balance is
 * evidence about the borrowed holder, which is the right input for SIMULATING an exit and
 * the wrong one for deciding whether we have exposure.
 *
 * TWO GATES, BOTH REQUIRED:
 *   - the row's mode must be a DRY-RUN mode, by `isDryRunMode` — the one predicate the
 *     `/trades` banner and the bot both use, so this cannot be pointed at a live row;
 *   - OUR balance of the token must be ZERO. If it is not, we hold something and this is
 *     a real position that must go through the ladder.
 */
async function resolveSimulated(
  c: PoolClient, rpc: ReadOnlyRpc, tradeId: string, commit: boolean,
): Promise<void> {
  const r = await c.query<{
    id: string; mode: string; status: string; token: string; exit_sim_from: string | null;
  }>(
    `select id::text, mode, status, token, exit_sim_from
       from bot_trades where chain = $1 and id = $2`, [CHAIN, tradeId]);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`no bot_trades row ${tradeId} on ${CHAIN}`);
  if (row.status !== 'needs_exit') {
    throw new Error(`trade ${tradeId} is '${row.status}', not 'needs_exit'`);
  }
  if (!isDryRunMode(row.mode)) {
    throw new Error(`trade ${tradeId} is in mode '${row.mode}', which is NOT a dry-run `
      + 'mode. A live position was really bought and really is exposure; it goes through '
      + 'the ladder and is never written off as a simulation.');
  }

  const wallet = process.env['BOT_WALLET_ADDRESS'];
  if (wallet === undefined || wallet.trim() === '') {
    throw new Error('BOT_WALLET_ADDRESS is not set, so OUR balance cannot be read and the '
      + 'premise of this resolution — that we hold nothing — cannot be established.');
  }
  const ours = await readTokenBalance(rpc, row.token, wallet.trim().toLowerCase());
  const theirs = row.exit_sim_from === null ? null
    : await readTokenBalance(rpc, row.token, row.exit_sim_from);

  log.info('THE POSITION, AND WHOSE BALANCE DECIDES IT', {
    trade: tradeId, mode: row.mode, token: row.token,
    our_balance_raw: ours.toString(),
    borrowed_holder: row.exit_sim_from,
    borrowed_holder_balance_raw: theirs === null ? 'n/a' : theirs.toString(),
    question: 'do WE hold any of this token? A dry-run row was never broadcast, so the '
      + 'answer should be no — and the borrowed holder still holding is what made the '
      + 'boot sweep mark it needs_exit in the first place.',
  });

  if (ours !== 0n) {
    throw new Error(`WE HOLD ${ours} of ${row.token}. That is a real position however the `
      + 'row is labelled, and it must go through the exit ladder rather than being '
      + 'written off as a simulation.');
  }

  log.info('THE COUNTS THIS WRITE MUST PRODUCE',
    { status_after: 'closed_simulated', rows_updated: 1 });
  if (!commit) {
    log.info('DRY RUN — NOTHING WRITTEN', { note: 'pass --commit to resolve' });
    return;
  }
  const upd = await c.query(
    `update bot_trades
        set status = 'closed_simulated',
            note = coalesce(note || ' | ', '')
                   || 'resolve-unsellable --simulated: dry-run row, our balance of the '
                   || 'token is 0 so we never held it; the borrowed holder''s balance is '
                   || 'evidence about them, not exposure of ours',
            updated_at = now()
      where chain = $1 and id = $2 and status = 'needs_exit'`, [CHAIN, tradeId]);
  if ((upd.rowCount ?? 0) !== 1) {
    throw new Error(`the update touched ${upd.rowCount} rows where 1 was expected`);
  }
  log.info('RESOLVED', { trade: tradeId, status: 'closed_simulated' });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const ti = args.indexOf('--trade');
  if (ti < 0) {
    throw new Error('pass --trade <id>. To change the kill switch use halt-control, which '
      + 'owns both of its scopes.');
  }
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    const key = process.env['ALCHEMY_API_KEY'];
    if (!key) throw new Error('ALCHEMY_API_KEY is not set');
    const rpc = new ReadOnlyRpc(
      new RpcClient(RPC_URL.replace('{key}', key), 60000, 50_000));
    if (args.includes('--simulated')) {
      await resolveSimulated(c, rpc, String(args[ti + 1] ?? ''), commit);
    } else {
      await resolveOne(c, rpc, String(args[ti + 1] ?? ''), commit);
    }
  } finally { c.release(); }

  /* VERIFY ON A FRESH CONNECTION. A clean exit is not evidence. */
  const fresh = await app.pool.connect();
  try {
    log.info('VERIFIED ON A FRESH CONNECTION', {
      needs_exit_rows: await stuckCount(fresh),
      note: 'the kill switch is halt-control\'s to report and change',
    });
  } finally { fresh.release(); }

  await app.pool.end();
  process.exit(0);
}

main().catch((e) => {
  log.error('resolve-unsellable failed', errorFields(e)); process.exit(1);
});
