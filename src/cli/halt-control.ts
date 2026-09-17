/**
 * `npm run halt-control -- --status`
 * `npm run halt-control -- --halt-chain "<reason>" [--commit]`
 * `npm run halt-control -- --clear-chain "<reason>" [--commit]`
 * `npm run halt-control -- --clear-mode <mode> "<reason>" [--commit]`
 *
 * THE OPERATOR'S SIDE OF THE KILL SWITCH. docs/LAUNCHBOT.md section 4.
 *
 * ---------------------------------------------------------------------------
 * TWO SCOPES, AND ONLY A HUMAN CAN REACH THE WIDER ONE
 * ---------------------------------------------------------------------------
 *
 * As of 2026-09-16 `bot_control` is keyed `(chain, mode)`:
 *
 *   - **`mode = '*'` is CHAIN-WIDE** and stops every mode. **Only this tool writes it.**
 *     `state.halt()` — the automatic path the bot itself calls — REFUSES the sentinel, so
 *     the bot cannot stop every mode because one of its own runs could not close a
 *     position.
 *   - **`mode = <a real mode>` is that mode only**, which is what an automatic halt writes.
 *
 * **THE BOT STILL CANNOT CLEAR ANY HALT.** This is an operator tool; nothing in
 * `launchbot`'s path clears a row. A process that can switch off the thing that switched
 * it off has no kill switch.
 *
 * ---------------------------------------------------------------------------
 * THE GUARDS DIFFER BY SCOPE, DELIBERATELY
 * ---------------------------------------------------------------------------
 *
 * **Clearing a MODE halt refuses while that mode still has `needs_exit` rows.** An
 * automatic halt is a statement about an unresolved position; clearing it while the
 * position is unresolved is the failure the halt exists to prevent.
 *
 * **Clearing the CHAIN-WIDE halt does NOT have that guard**, and that is not an
 * oversight. A manual stop is a human decision and un-stopping is the same human's
 * decision — a guard here would mean an operator who hit the switch could be prevented
 * from releasing it by a condition they had already decided to accept. What it does
 * instead is REPORT everything outstanding, per mode, so the decision is informed rather
 * than blocked.
 *
 * Dry by default. Counts before, counts after, on a fresh connection.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { ALL_MODES, BOT_SCHEMA } from '../bot/state.js';
import { isDryRunMode } from '../bot/mode.js';
import type { PoolClient } from '../store/db.js';

const CHAIN = 'robinhood';

interface Row { mode: string; halted: boolean; reason: string | null; updated_at: string }

async function rows(c: PoolClient): Promise<Row[]> {
  const r = await c.query<Row>(
    `select mode, halted, reason, updated_at::text from bot_control
      where chain = $1 order by (mode = $2) desc, mode`, [CHAIN, ALL_MODES]);
  return r.rows;
}

async function stuckByMode(c: PoolClient): Promise<Record<string, number>> {
  const r = await c.query<{ mode: string; n: string }>(
    `select mode, count(*)::text n from bot_trades
      where chain = $1 and status = 'needs_exit' group by mode order by mode`, [CHAIN]);
  const out: Record<string, number> = {};
  for (const x of r.rows) out[x.mode] = Number(x.n);
  return out;
}

async function status(c: PoolClient): Promise<void> {
  const rs = await rows(c);
  const stuck = await stuckByMode(c);
  log.info('KILL SWITCH, EVERY SCOPE', {
    chain: CHAIN,
    chain_wide: (() => {
      const w = rs.find((x) => x.mode === ALL_MODES);
      if (w === undefined) return 'RETURNED NO ROWS — never set';
      return { halted: w.halted, reason: w.reason, updated_at: w.updated_at };
    })(),
    per_mode: rs.filter((x) => x.mode !== ALL_MODES).length === 0
      ? 'RETURNED NO ROWS — no mode has an automatic halt'
      : rs.filter((x) => x.mode !== ALL_MODES).map((x) =>
        `${x.mode}: halted=${x.halted} @ ${x.updated_at} :: `
        + `${(x.reason ?? '').slice(0, 90)}`),
    needs_exit_rows_by_mode: Object.keys(stuck).length === 0
      ? 'RETURNED NO ROWS — nothing unresolved anywhere' : stuck,
    note: 'a CHAIN-WIDE halt stops every mode and is only ever set by this tool. A MODE '
      + 'halt stops that mode and is what the bot itself raises.',
  });
}

async function haltChain(c: PoolClient, reason: string, commit: boolean): Promise<void> {
  const rs = await rows(c);
  const wide = rs.find((x) => x.mode === ALL_MODES);
  log.warn('SETTING THE CHAIN-WIDE HALT — THIS STOPS EVERY MODE', {
    chain: CHAIN,
    current: wide === undefined ? 'RETURNED NO ROWS' : wide,
    new_reason: reason,
    stops: 'live and every dry-run mode on this chain',
  });
  if (!commit) {
    log.info('DRY RUN — NOTHING WRITTEN', { note: 'pass --commit to halt the chain' });
    return;
  }
  await c.query(
    `insert into bot_control (chain, mode, halted, reason) values ($1, $2, true, $3)
     on conflict (chain, mode) do update
       set halted = true, reason = $3, updated_at = now()`, [CHAIN, ALL_MODES, reason]);
  log.warn('CHAIN-WIDE HALT SET', { reason });
}

async function clearChain(c: PoolClient, reason: string, commit: boolean): Promise<void> {
  const rs = await rows(c);
  const wide = rs.find((x) => x.mode === ALL_MODES);
  const stuck = await stuckByMode(c);
  /*
   * NO GUARD, BUT FULL DISCLOSURE. Releasing a manual stop is the same human's decision
   * as setting it; what must not happen is releasing it without being shown what is
   * still outstanding.
   */
  log.info('CLEARING THE CHAIN-WIDE HALT', {
    current: wide === undefined ? 'RETURNED NO ROWS' : wide,
    still_outstanding_needs_exit_by_mode: Object.keys(stuck).length === 0
      ? 'none' : stuck,
    modes_with_their_own_automatic_halt: rs
      .filter((x) => x.mode !== ALL_MODES && x.halted).map((x) => x.mode),
    note: 'clearing this does NOT clear a mode\'s own automatic halt — those are separate '
      + 'rows and each is cleared on its own, so releasing the manual stop cannot '
      + 'silently release an unresolved position too',
    new_reason: reason,
  });
  if (wide === undefined || !wide.halted) {
    log.info('NOTHING TO CLEAR — the chain-wide halt is not set', {
      note: 'reported rather than treated as success',
    });
    return;
  }
  if (!commit) {
    log.info('DRY RUN — NOTHING WRITTEN', { note: 'pass --commit to clear' });
    return;
  }
  await c.query(
    `update bot_control set halted = false, reason = $3, updated_at = now()
      where chain = $1 and mode = $2`, [CHAIN, ALL_MODES, reason]);
  log.info('CHAIN-WIDE HALT CLEARED', { reason });
}

async function clearMode(
  c: PoolClient, mode: string, reason: string, commit: boolean,
): Promise<void> {
  if (mode === ALL_MODES) {
    throw new Error(`--clear-mode will not take the ${ALL_MODES} sentinel. Use `
      + '--clear-chain, so the log says which scope was released.');
  }
  const rs = await rows(c);
  const own = rs.find((x) => x.mode === mode);
  const stuck = await stuckByMode(c);
  const mine = stuck[mode] ?? 0;
  log.info('CLEARING A MODE\'S AUTOMATIC HALT', {
    mode, is_dry_run_mode: isDryRunMode(mode),
    current: own === undefined ? 'RETURNED NO ROWS' : own,
    needs_exit_rows_in_this_mode: mine,
    new_reason: reason,
  });
  if (own === undefined || !own.halted) {
    log.info('NOTHING TO CLEAR — this mode is not halted', {
      note: 'reported rather than treated as success',
    });
    return;
  }
  if (mine > 0) {
    /*
     * THE GUARD. An automatic halt is a statement about an unresolved position, and
     * clearing it while the position is unresolved is the failure it exists to prevent.
     */
    throw new Error(`REFUSING TO CLEAR mode '${mode}': ${mine} needs_exit row(s) remain `
      + 'in it. The halt is doing its job. Resolve them first — a boot of the mode sweeps '
      + 'the ones whose holder now holds nothing, and resolve-unsellable handles a pool '
      + 'that provably pays nothing or a dry-run row we never held.');
  }
  if (!commit) {
    log.info('DRY RUN — NOTHING WRITTEN', { note: 'pass --commit to clear' });
    return;
  }
  await c.query(
    `update bot_control set halted = false, reason = $3, updated_at = now()
      where chain = $1 and mode = $2`, [CHAIN, mode, reason]);
  log.info('MODE HALT CLEARED', { mode, reason });
}

function reasonAt(args: string[], i: number): string {
  const v = String(args[i] ?? '');
  if (v.trim() === '' || v.startsWith('--')) {
    throw new Error('a reason is REQUIRED. The record must say who changed the kill '
      + 'switch and why rather than going blank.');
  }
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const app = await bootstrap();
  const c = await app.pool.connect();
  try {
    await c.query(BOT_SCHEMA);
    const actions = ['--status', '--halt-chain', '--clear-chain', '--clear-mode']
      .filter((a) => args.includes(a));
    if (actions.length !== 1) {
      throw new Error('pass exactly one of --status, --halt-chain, --clear-chain, '
        + `--clear-mode. Got ${actions.length === 0 ? 'none' : actions.join(', ')} — each `
        + 'is a different change of scope and combining them would hide which a run made.');
    }
    const a = actions[0]!;
    if (a === '--status') await status(c);
    else if (a === '--halt-chain') {
      await haltChain(c, reasonAt(args, args.indexOf(a) + 1), commit);
    } else if (a === '--clear-chain') {
      await clearChain(c, reasonAt(args, args.indexOf(a) + 1), commit);
    } else {
      const i = args.indexOf(a);
      const mode = String(args[i + 1] ?? '');
      if (mode.trim() === '' || mode.startsWith('--')) {
        throw new Error('--clear-mode needs a mode, then a reason');
      }
      await clearMode(c, mode, reasonAt(args, i + 2), commit);
    }
  } finally { c.release(); }

  /* VERIFY ON A FRESH CONNECTION. A clean exit is not evidence. */
  const fresh = await app.pool.connect();
  try {
    log.info('VERIFIED ON A FRESH CONNECTION', { rows: await rows(fresh) });
  } finally { fresh.release(); }
  await app.pool.end();
  process.exit(0);
}

main().catch((e) => { log.error('halt-control failed', errorFields(e)); process.exit(1); });
