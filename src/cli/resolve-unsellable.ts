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
import { AbiCoder, id } from 'ethers';
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { RpcClient } from '../adapters/token-updates/rpc.js';
import { ReadOnlyRpc } from '../bot/rpc.js';
import { executeExit } from '../bot/exit-exec.js';
import { readTokenBalance } from '../bot/allowance.js';
import { isDryRunMode } from '../bot/mode.js';
import { configuredWallet } from '../bot/wallet.js';
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
/** COMPUTED, never looked up. */
const ERROR_STRING = id('Error(string)').slice(0, 10);
const BURN = '0x000000000000000000000000000000000000dead';

/**
 * CAN THE HOLDER MOVE THIS TOKEN AT ALL?
 *
 * **A SECOND PREMISE FOR "UNSELLABLE", AND IT IS STRONGER THAN THE FIRST.** `resolveOne`
 * accepted only `actual=0` — the pool offering nothing at any rung. CME is unsellable for
 * a different and worse reason: **the TOKEN refuses the transfer.** Every route reverts
 * `Error("blacklisted")` for an ordinary holder while the PoolManager can move it, so
 * buys succeed and no buyer can ever leave. No bound, no ladder and no pool state makes
 * that sellable, where a pool paying zero today might pay tomorrow.
 *
 * It asks the question directly and about US: simulate `transfer(0x…dead, OUR WHOLE
 * BALANCE)` from the holder's own address. A revert here is not an inference from a
 * router failure — `TRANSFER_FROM_FAILED` through the router names the symptom, and this
 * names the cause.
 *
 * **A SUCCESS IS THE ANSWER TOO, AND IT REFUSES THE RESOLUTION.** If the token moves, the
 * position is not unsellable-by-the-token and must go back through the ladder.
 */
async function probeTransferRefusal(
  rpc: ReadOnlyRpc, token: string, holder: string, amount: bigint,
): Promise<string | null> {
  const data = `0xa9059cbb${BURN.slice(2).padStart(64, '0')}`
    + amount.toString(16).padStart(64, '0');
  try {
    await rpc.call('eth_call', [{ from: holder, to: token, data }, 'latest']);
    return null;
  } catch (err) {
    const e = err as Error & { data?: unknown };
    const d = e.data;
    if (typeof d === 'string' && d.startsWith(ERROR_STRING)) {
      try {
        const dec = AbiCoder.defaultAbiCoder()
          .decode(['string'], `0x${d.slice(10)}`) as unknown as string[];
        return `Error("${String(dec[0]).slice(0, 80)}")`;
      } catch { /* fall through to the raw form */ }
    }
    return typeof d === 'string' && d.length >= 10
      ? `custom ${d.slice(0, 10)}` : e.message.slice(0, 120);
  }
}

async function resolveOne(
  c: PoolClient, rpc: ReadOnlyRpc, tradeId: string, commit: boolean,
): Promise<void> {
  const r = await c.query<{
    id: string; mode: string; status: string; pool_id: string; token: string;
    counter: string; fee: number; tick_spacing: number; hooks: string;
    first_swap_block: string; exit_sim_from: string | null; position_usd: string | null;
    exit_due_block: string | null;
  }>(
    `select id::text, mode, status, pool_id, token, counter, fee, tick_spacing, hooks,
            first_swap_block::text, exit_sim_from, position_usd::text,
            exit_due_block::text
       from bot_trades where chain = $1 and id = $2`, [CHAIN, tradeId]);
  const row = r.rows[0];
  if (row === undefined) throw new Error(`no bot_trades row ${tradeId} on ${CHAIN}`);
  const headBlock = Number(BigInt(String(await rpc.call('eth_blockNumber', []))));
  /*
   * `holding` IS ACCEPTED FOR A LIVE ROW PAST ITS HORIZON, AND THE REASON IS AN ORDERING
   * DEFECT RATHER THAN A LOOSENING.
   *
   * The path that turns `holding` into `needs_exit` is boot reconciliation — and the
   * boot runs the ARMING GATE first, which refuses when the balance is below
   * `MAX_CONCURRENT x MAX_POSITION_USD`. So a wallet drained by its own open positions
   * cannot boot to recover them: **the guard that stops new trades also stops the
   * recovery of existing ones.** That is the same shape as the abandon defect it is
   * being used to clean up after, and it is recorded in section 7 rather than fixed
   * here under time pressure.
   *
   * The narrowing that keeps this safe: LIVE only, and only once `exit_due_block` has
   * actually passed. A dry-run row or a position still inside its horizon is refused
   * exactly as before.
   */
  const overdue = row.status === 'holding' && !isDryRunMode(row.mode)
    && row.exit_due_block !== null && Number(row.exit_due_block) <= headBlock;
  if (row.status !== 'needs_exit' && !overdue) {
    throw new Error(`trade ${tradeId} is '${row.status}', not 'needs_exit'. This tool only `
      + 'resolves a position the boot sweep could not sell, or a LIVE `holding` row whose '
      + 'exit horizon has already passed; anything else is a different question and must '
      + 'not be marked unsellable.');
  }
  /*
   * WHOSE POSITION IS IT? A LIVE ROW CARRIES NO `exit_sim_from` AND THAT IS DELIBERATE.
   *
   * **THIS RAISED ON THE FIRST LIVE STUCK POSITION AND COULD NOT RESOLVE IT AT ALL.** The
   * text here was *"trade N carries no address to sell from"* — written when every row was
   * a dry run and `exit_sim_from` was always the borrowed first-swap sender. A live
   * position is OURS, so the loop writes NULL there on purpose: telling boot reconciliation
   * to read somebody else's balance to decide whether WE hold a token is the opposite of
   * what it must do.
   *
   * `reconcileOnBoot` already had the fallback (`r.exit_sim_from ?? wallet`) and so did
   * `clearNeedsExit` (`ctx.broadcaster?.address ?? r.exit_sim_from`). **This tool — the one
   * an operator reaches for precisely when a position is stuck — had neither**, so the
   * moment live rows existed it refused the only rows it was needed for, and it refused
   * while a dead position blocked the boot sweep from reaching a live one.
   *
   * A tool written when only one kind of row existed, whose assumption stops holding the
   * day the other kind arrives, failing at the worst possible moment.
   */
  const holder = row.exit_sim_from ?? configuredWallet();
  if (holder === null) {
    throw new Error(`trade ${tradeId} carries no exit_sim_from and BOT_WALLET_ADDRESS is `
      + 'not set, so there is no address whose balance could establish whether this '
      + 'position is sellable. Set BOT_WALLET_ADDRESS: a live position is OURS and it is '
      + 'our balance that decides.');
  }
  const isOurs = row.exit_sim_from === null;

  /* THE BALANCE FIRST. A zero balance is not unsellable — it is GONE, and the boot
   * sweep resolves that as `closed_unfilled` without any of this. */
  const bal = await readTokenBalance(rpc, row.token, holder);
  log.info('THE POSITION, AND WHAT IS BEING ESTABLISHED', {
    trade: tradeId, mode: row.mode, pool: row.pool_id,
    token: row.token, holder,
    holder_is: isOurs ? 'OUR OWN WALLET — a LIVE position, so this balance is the position'
      : 'the BORROWED first-swap sender — a dry-run fixture, and its balance is evidence '
        + 'about IT rather than about us',
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
        sellFrom: holder,
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

  /*
   * THE SECOND PREMISE. Asked ALWAYS, not only when the first fails, so the evidence for
   * every resolution records both answers rather than whichever one happened to be
   * reached first.
   */
  const refusal = await probeTransferRefusal(rpc, row.token, holder, bal);
  log.info('CAN THE HOLDER MOVE THIS TOKEN AT ALL?', {
    trade: tradeId, holder, amount_raw: bal.toString(),
    transfer_to_burn: refusal === null ? 'SUCCEEDS — the token is movable' : refusal,
    note: refusal === null
      ? 'so any unsellability is the POOL, not the token'
      : 'the TOKEN refuses the transfer. No bound, ladder or pool state fixes that.',
  });

  if (!paysNothing && refusal === null) {
    throw new Error(`trade ${tradeId} exhausted the ladder but the pool did NOT report `
      + `paying zero AND the token moves freely. Last reason: ${detail.slice(0, 200)}\n`
      + 'That is a MISPRICED QUOTE or a bound too tight, not a dead pool — the position '
      + 'is sellable at some price and marking it unsellable would hide that. Refusing.');
  }

  log.info(paysNothing
    ? 'ESTABLISHED: THE POOL PAYS NOTHING AT ANY RUNG'
    : 'ESTABLISHED: THE TOKEN ITSELF REFUSES THE TRANSFER', {
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

  /*
   * A POSITION THAT CANNOT BE SOLD IS A TOTAL LOSS, AND THE RAIL HAS TO BE ABLE TO SEE
   * IT. `net_pnl_usd` was NULL on every row ever written, so `MAX_DAILY_LOSS_USD` read
   * exactly $0 no matter what happened — four live total losses had already been
   * resolved against a rail that could never fire. That is the convention
   * `realised-backtest` established from the other direction: **an unsellable position
   * is -100%, not 0%.** A row whose buy never landed keeps NULL, because nothing was
   * spent on it.
   */
  const upd = await c.query(
    `update bot_trades
        set status = 'closed_unsellable',
            net_pnl_usd = case when entry_tx is not null
                               then -position_usd else net_pnl_usd end,
            note = coalesce(note || ' | ', '')
                   || 'resolve-unsellable: ' || $5 || ' ('
                   || $3 || '); ' || $4,
            updated_at = now()
      where chain = $1 and id = $2 and status in ('needs_exit', 'holding')`,
    [CHAIN, tradeId, `${EXIT_RETRY.BOUND_BPS.join('/')} bps`, detail.slice(0, 120),
      paysNothing ? 'pool pays 0 at every rung'
        : `the TOKEN refuses our transfer: ${refusal ?? ''}`]);
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

  /*
   * `--backfill-pnl` — GIVE THE DAILY-LOSS RAIL SOMETHING TO READ.
   *
   * Every `closed_unsellable` row written before 2026-09-17 carries a NULL
   * `net_pnl_usd`, so `MAX_DAILY_LOSS_USD` summed to $0 over four real total losses.
   * Scoped to LIVE rows that are `closed_unsellable` AND carry an `entry_tx`: a buy that
   * landed and a position that cannot be sold is a total loss of its cost basis. A row
   * with no `entry_tx` never bought anything and is left NULL rather than invented.
   */
  if (args.includes('--backfill-pnl')) {
    const app2 = await bootstrap();
    const c2 = await app2.pool.connect();
    try {
      const dry = await c2.query(`select id::text, position_usd, entry_tx is not null e
         from bot_trades where chain=$1 and mode='live'
          and status='closed_unsellable' and net_pnl_usd is null`, [CHAIN]);
      log.info('THE COUNTS THIS WRITE MUST PRODUCE', {
        rows_to_update: dry.rows.filter((r) => r.e).length,
        rows_left_null_no_entry_tx: dry.rows.filter((r) => !r.e).length,
        total_loss_to_record:
          dry.rows.filter((r) => r.e).reduce((a, r) => a + Number(r.position_usd), 0),
        rows: dry.rows.map((r) => `${r.id}: ${r.e ? `-$${r.position_usd}` : 'NULL (no buy)'}`),
      });
      if (!commit) { log.info('DRY RUN — NOTHING WRITTEN', {}); return; }
      const u = await c2.query(`update bot_trades set net_pnl_usd = -position_usd,
           updated_at = now()
         where chain=$1 and mode='live' and status='closed_unsellable'
           and net_pnl_usd is null and entry_tx is not null`, [CHAIN]);
      const expected = dry.rows.filter((r) => r.e).length;
      if ((u.rowCount ?? 0) !== expected) {
        throw new Error(`the update touched ${u.rowCount} rows where ${expected} were `
          + 'expected; refusing rather than adjusting the figure to fit');
      }
      const back = await c2.query(`select coalesce(sum(net_pnl_usd),0) s
         from bot_trades where chain=$1 and mode='live'`, [CHAIN]);
      log.info('VERIFIED ON A FRESH READ', {
        rows_updated: u.rowCount, live_realised_pnl_now: back.rows[0]?.s,
      });
    } finally { c2.release(); await app2.pool.end(); }
    return;
  }

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
