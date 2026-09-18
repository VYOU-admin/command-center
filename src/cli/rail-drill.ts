/**
 * `npm run rail-drill -- [--commit]`
 *
 * TRIPS EVERY SAFETY RAIL DELIBERATELY AND REPORTS WHAT EACH ONE DID.
 *
 * "A rail that has never been exercised is a rail you do not have." Four of the five
 * rails had never fired in anger: MAX_CONCURRENT and MAX_DAILY_LOSS_USD were constants
 * in config.ts that no code read, and the kill switch had only ever been evaluated
 * against an empty `bot_control`.
 *
 * IT RUNS ON chain='drill', NOT 'robinhood'. `bot_control` is keyed (chain, mode) as of
 * 2026-09-16, and a CHAIN-WIDE halt still stops every mode on its chain -- so tripping
 * the real kill switch to test it would halt the live dry run, a test that breaks the
 * thing it is testing. Every row this writes carries chain='drill' and is
 * deleted at the end, and the deletion is verified on a fresh connection rather than
 * inferred from the script exiting cleanly.
 *
 * EACH RAIL IS TESTED IN BOTH DIRECTIONS. One short of the threshold must be ALLOWED
 * and the threshold itself must BLOCK. A rail that blocks at both is not a rail, it is
 * an outage, and the one-below case is what tells the two apart.
 */
import { bootstrap } from '../bootstrap.js';
import { errorFields, log } from '../logger.js';
import { ALL_MODES, BOT_SCHEMA, halt } from '../bot/state.js';
import { RAILS } from '../bot/config.js';
import { checkRails, deployedCapIsTerminal, deployedUsd, loserDeadlineFires,
  priceStopFires, runCapReached } from '../bot/rails.js';
import type { RailState } from '../bot/rails.js';
import type { PoolClient } from '../store/db.js';

const CHAIN = 'drill';
const MODE = 'drill';

async function wipe(c: PoolClient): Promise<number> {
  const a = await c.query('delete from bot_trades where chain = $1', [CHAIN]);
  await c.query('delete from bot_control where chain = $1', [CHAIN]);
  return a.rowCount ?? 0;
}

/**
 * `basis` IS THE ROW'S COST BASIS AND IT DEFAULTS TO A REAL ONE.
 *
 * MAX_DEPLOYED_USD sums `position_usd` over open rows, and an open row with a NULL basis
 * makes deployed capital UNKNOWN — which now blocks, deliberately. Seeding nulls would
 * therefore make every other rail's case block for the wrong reason, and a case that
 * blocks for the wrong reason passes an expectation of BLOCK while testing nothing. Each
 * open row carries MAX_POSITION_USD unless a case is specifically about the basis.
 */
async function seed(
  c: PoolClient, n: number, status: string, pnl: number | null, tag: string,
  basis: number | null = RAILS.MAX_POSITION_USD,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await c.query(
      `insert into bot_trades (chain,mode,pool_id,token,counter,status,net_pnl_usd,fee,
         position_usd)
       values ($1,$2,$3,'0xtok','0xcnt',$4,$5,500,$6)`,
      [CHAIN, MODE, `0x${tag}${i.toString(16).padStart(4, '0')}`, status, pnl, basis]);
  }
}

interface Case { name: string; expect: 'ALLOW' | 'BLOCK'; }

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const app = await bootstrap();
  const c = await app.pool.connect();
  const results: Array<Case & { got: string; blocked: string[]; pass: boolean }> = [];
  try {
    await c.query(BOT_SCHEMA);
    const pre = await c.query<{ n: string }>(
      'select count(*)::text n from bot_trades where chain = $1', [CHAIN]);
    log.info('DRY-RUN COUNTS BEFORE THE DRILL', {
      drill_rows_present: pre.rows[0]!.n,
      note: 'must be 0; a non-zero count means a previous drill did not clean up',
      rails: RAILS, commit,
    });
    if (!commit) {
      log.info('DRY RUN -- nothing written', { note: 'pass --commit to run the drill' });
      c.release(); await app.pool.end(); process.exit(0);
    }
    await wipe(c);

    const run = async (name: string, expect: 'ALLOW' | 'BLOCK'): Promise<void> => {
      const v = await checkRails(c, CHAIN, MODE);
      const got = v.allowed ? 'ALLOW' : 'BLOCK';
      results.push({ name, expect, got, blocked: v.blocked, pass: got === expect });
      log.info(`RAIL CASE: ${name}`, { expect, got, blocked: v.blocked, state: v.state });
    };

    /* --- MAX_CONCURRENT --------------------------------------------------- */
    await seed(c, RAILS.MAX_CONCURRENT - 1, 'holding', null, 'aa');
    await run(`MAX_CONCURRENT at ${RAILS.MAX_CONCURRENT - 1} open (one below)`, 'ALLOW');
    await seed(c, 1, 'holding', null, 'ab');
    await run(`MAX_CONCURRENT at ${RAILS.MAX_CONCURRENT} open (at the rail)`, 'BLOCK');
    await wipe(c);

    /* --- MAX_DEPLOYED_USD, THE HARD CAPITAL CAP ---------------------------- */
    /*
     * EVERY CASE HERE HOLDS 4 POSITIONS, ONE BELOW MAX_CONCURRENT, SO THE CAP IS THE
     * ONLY RAIL THAT CAN FIRE. The cap cannot bind on the live path — MAX_CONCURRENT 5
     * x $10 plus a $50 daily loss caps deployed at $100 against a $100 cap — so the only
     * way to exercise it is to construct a state the other rails would never produce.
     * A drill that could only reach $65 would report PASS on a rail it never reached.
     *
     * The cap admits while `deployed + MAX_POSITION_USD <= MAX_DEPLOYED_USD`, so with a
     * $100 cap and a $10 position the last admissible state is $90 deployed.
     */
    const cap = RAILS.MAX_DEPLOYED_USD;
    const room = cap - RAILS.MAX_POSITION_USD;   /* the largest admissible deployed */

    await seed(c, 4, 'holding', null, 'ea', (room - 5) / 4);
    await run(`MAX_DEPLOYED_USD at $${room - 5} deployed (one below)`, 'ALLOW');
    await wipe(c);

    await seed(c, 4, 'holding', null, 'eb', room / 4);
    await run(`MAX_DEPLOYED_USD at $${room} deployed (the last admissible trade)`, 'ALLOW');
    await wipe(c);

    await seed(c, 4, 'holding', null, 'ec', (room + 1) / 4);
    await run(`MAX_DEPLOYED_USD at $${room + 1} deployed (at the rail)`, 'BLOCK');
    await wipe(c);

    /*
     * THE LOSS TERM, TESTED IN BOTH DIRECTIONS AND BELOW MAX_DAILY_LOSS_USD SO THAT
     * RAIL CANNOT BE WHAT FIRES. Without this term the cap is a concurrency limit in
     * dollars: a bot that loses $10 and reopens has the same open basis and less money.
     */
    /* Derived from the rail, never typed, so raising it cannot silently make this case
     * breach BOTH rails at once and pass its expectation while proving nothing about
     * which one fired. At $50 this is $46. */
    const loss = RAILS.MAX_DAILY_LOSS_USD - 4;
    await seed(c, 4, 'holding', null, 'fa', (room - loss) / 4);
    await seed(c, 1, 'closed', -loss, 'fb');
    await run(`MAX_DEPLOYED_USD: $${room - loss} open + $${loss} of realised losses `
      + `= $${room} (one below, and the loss rail is NOT what is being tested)`, 'ALLOW');
    await wipe(c);

    await seed(c, 4, 'holding', null, 'fc', (room - loss + 1) / 4);
    await seed(c, 1, 'closed', -loss, 'fd');
    await run(`MAX_DEPLOYED_USD: $${room - loss + 1} open + $${loss} of realised losses `
      + `= $${room + 1} (at the rail, on the LOSS term)`, 'BLOCK');
    await wipe(c);

    /*
     * A PROFITABLE DAY MUST NOT BUY HEADROOM. The loss term is max(0, -pnl), so the
     * same over-cap state blocks whether the day made $50 or nothing. The symmetric
     * form would quietly turn one good morning into a larger afternoon.
     */
    await seed(c, 4, 'holding', null, 'ga', (room + 1) / 4);
    await seed(c, 1, 'closed', 50, 'gb');
    await run(`MAX_DEPLOYED_USD at $${room + 1} deployed WITH a +$50 profitable day `
      + '(profit must not create headroom)', 'BLOCK');
    await wipe(c);

    /*
     * AN OPEN POSITION WITH NO RECORDED COST BASIS. `sum()` skips a null, so without
     * this branch the cap would report $0 deployed over a position of unknown size and
     * pass — the plausible-value-on-an-error-path failure this project records most.
     */
    await seed(c, 1, 'holding', null, 'ha', null);
    await run('MAX_DEPLOYED_USD with an open position carrying a NULL position_usd '
      + '(deployed is UNKNOWN)', 'BLOCK');
    await wipe(c);

    /*
     * A POSITION THE EXIT LADDER COULD NOT SELL IS STILL OUR MONEY, AND IT IS OUTSIDE
     * `NON_TERMINAL`. These two cases are the regression guard for a hole found by
     * re-auditing this change: `needs_exit` and `exit_exhausted` are what the loop
     * leaves behind when a ladder exhausts, and neither is swept by MAX_CONCURRENT.
     *
     * THE TELL IS THAT `openPositions` READS 0 WHILE THE CAP BLOCKS. If the cap used
     * `NON_TERMINAL` like MAX_CONCURRENT does, $91 of unsellable tokens would read as
     * $0 deployed and every one of these would ALLOW.
     */
    for (const status of ['needs_exit', 'exit_exhausted']) {
      await seed(c, 4, status, null, status === 'needs_exit' ? 'ia' : 'ib', (room + 1) / 4);
      await run(`MAX_DEPLOYED_USD counts '${status}' positions: $${room + 1} of tokens `
        + 'the ladder could not sell, with MAX_CONCURRENT seeing 0 open', 'BLOCK');
      await wipe(c);
    }

    /* --- MAX_DAILY_LOSS_USD ----------------------------------------------- */
    await seed(c, 1, 'closed', -(RAILS.MAX_DAILY_LOSS_USD - 1), 'ba');
    await run(`MAX_DAILY_LOSS_USD at -$${RAILS.MAX_DAILY_LOSS_USD - 1}`, 'ALLOW');
    await seed(c, 1, 'closed', -1, 'bb');
    await run(`MAX_DAILY_LOSS_USD at -$${RAILS.MAX_DAILY_LOSS_USD}`, 'BLOCK');
    await wipe(c);

    /* A PROFITABLE DAY OF THE SAME MAGNITUDE MUST NOT HALT. The absolute-value form
     * of this comparison would stop the bot for making money; this proves it does not. */
    await seed(c, 1, 'closed', RAILS.MAX_DAILY_LOSS_USD + 5, 'bc');
    await run(`daily PnL of +$${RAILS.MAX_DAILY_LOSS_USD + 5} (profit, same magnitude)`, 'ALLOW');
    await wipe(c);

    /* --- MAX_CONSECUTIVE_REVERTS ------------------------------------------ */
    await seed(c, RAILS.MAX_CONSECUTIVE_REVERTS - 1, 'sim_reverted', null, 'ca');
    await run(`MAX_CONSECUTIVE_REVERTS at ${RAILS.MAX_CONSECUTIVE_REVERTS - 1}`, 'ALLOW');
    await seed(c, 1, 'sim_reverted', null, 'cb');
    await run(`MAX_CONSECUTIVE_REVERTS at ${RAILS.MAX_CONSECUTIVE_REVERTS}`, 'BLOCK');
    /* A CLEAN TRADE BREAKS THE RUN. Without this the counter would be "reverts ever",
     * not "reverts in a row", and the bot would halt on a normal failure rate. */
    await seed(c, 1, 'simulated', null, 'cc');
    await run('a clean simulation after the run of reverts', 'ALLOW');
    await wipe(c);

    /* --- MAX_TRADES_PER_DAY ----------------------------------------------- */
    await seed(c, RAILS.MAX_TRADES_PER_DAY - 1, 'closed', null, 'da');
    await run(`MAX_TRADES_PER_DAY at ${RAILS.MAX_TRADES_PER_DAY - 1}`, 'ALLOW');
    await seed(c, 1, 'closed', null, 'db');
    await run(`MAX_TRADES_PER_DAY at ${RAILS.MAX_TRADES_PER_DAY}`, 'BLOCK');
    await wipe(c);

    /* --- THE KILL SWITCH, AND ITS TWO SCOPES ------------------------------- */
    /*
     * THE SCOPES ARE THE WHOLE POINT OF THE 2026-09-16 CHANGE, SO THEY ARE EXERCISED
     * AGAINST TWO MODES RATHER THAN ONE.
     *
     * A drill on a single mode can show that a halt blocks — which the old cases did —
     * and CANNOT show the property that was actually bought: that one mode's automatic
     * halt leaves another mode alone. Testing it needs a second mode, and the case that
     * matters is the one expecting ALLOW.
     */
    const OTHER = 'drill-other';
    const runIn = async (
      mode: string, name: string, expect: 'ALLOW' | 'BLOCK',
    ): Promise<void> => {
      const v = await checkRails(c, CHAIN, mode);
      const got = v.allowed ? 'ALLOW' : 'BLOCK';
      results.push({ name, expect, got, blocked: v.blocked, pass: got === expect });
      log.info(`RAIL CASE: ${name}`, { mode, expect, got, blocked: v.blocked });
    };

    await run('kill switch not set', 'ALLOW');

    /* ---- AN AUTOMATIC HALT IS MODE-SCOPED -------------------------------- */
    await halt(c, CHAIN, MODE, 'rail drill: automatic, mode-scoped');
    await runIn(MODE, `AUTOMATIC halt on '${MODE}' blocks '${MODE}'`, 'BLOCK');
    await runIn(OTHER,
      `AUTOMATIC halt on '${MODE}' does NOT block '${OTHER}' — THE POINT OF THE CHANGE`,
      'ALLOW');
    await c.query('delete from bot_control where chain = $1', [CHAIN]);
    await runIn(MODE, 'mode halt cleared', 'ALLOW');

    /* ---- A MANUAL HALT IS CHAIN-WIDE ------------------------------------- */
    /*
     * Written with the sentinel directly, because that is what `halt-control` writes and
     * what `state.halt()` REFUSES. The refusal is its own case below.
     */
    await c.query(
      `insert into bot_control (chain, mode, halted, reason) values ($1, $2, true, $3)
       on conflict (chain, mode) do update set halted = true, reason = $3`,
      [CHAIN, ALL_MODES, 'rail drill: manual, chain-wide']);
    await runIn(MODE, `MANUAL chain-wide halt blocks '${MODE}'`, 'BLOCK');
    await runIn(OTHER, `MANUAL chain-wide halt ALSO blocks '${OTHER}'`, 'BLOCK');

    /* ---- AND IT IS REPORTED AS CHAIN-WIDE, NOT AS THE MODE'S OWN --------- */
    {
      const v = await checkRails(c, CHAIN, MODE);
      const saysChainWide = v.blocked.some((b) => b.includes('CHAIN-WIDE'));
      results.push({
        name: 'a chain-wide halt is REPORTED as chain-wide, not as the mode\'s own',
        expect: 'BLOCK', got: saysChainWide ? 'BLOCK' : 'ALLOW',
        blocked: v.blocked, pass: saysChainWide,
      });
      log.info('RAIL CASE: chain-wide halt is labelled as such', { blocked: v.blocked });
    }
    await c.query('delete from bot_control where chain = $1', [CHAIN]);
    await runIn(MODE, 'chain-wide halt cleared', 'ALLOW');

    /* ---- THE BOT CANNOT RAISE A CHAIN-WIDE HALT -------------------------- */
    /*
     * The one guarantee that keeps the two scopes meaningful: `state.halt()` is the
     * AUTOMATIC path and refuses the sentinel, so no amount of bot misbehaviour can stop
     * every mode. A default parameter is exactly how every automatic halt was chain-wide
     * before, so the refusal is asserted rather than assumed.
     */
    {
      let refused = false; let msg = '';
      try {
        await halt(c, CHAIN, ALL_MODES, 'the bot trying to stop everything');
      } catch (e) { refused = true; msg = (e as Error).message.slice(0, 120); }
      results.push({
        name: 'state.halt() REFUSES the chain-wide sentinel (the bot cannot stop every mode)',
        expect: 'BLOCK', got: refused ? 'BLOCK' : 'ALLOW', blocked: [msg], pass: refused,
      });
      log.info('RAIL CASE: halt() refuses the sentinel', { refused, msg });
    }
    await wipe(c);

    /* --- DOES A BREACHED CAP HALT THE DAY, OR SKIP ONE LAUNCH? ------------- */
    /*
     * The blocking decision above says WHETHER a trade is refused; this says whether
     * the bot stops. Open basis falls as positions close, so that case must SKIP;
     * realised losses never fall within a day and an unknown basis is a defect, so
     * both must HALT. Exercised as a pure function because the halting branch needs a
     * $90 loss, which MAX_DAILY_LOSS_USD makes unreachable through the database.
     */
    const base: RailState = {
      halted: false, haltReason: '', openPositions: 0, openCostBasisUsd: 0,
      openPositionsUnknownBasis: 0, tradesToday: 0, realisedPnlTodayUsd: 0,
      consecutiveReverts: 0,
    };
    const termCases: Array<{ name: string; state: RailState; expect: boolean }> = [
      { name: 'cap breached by OPEN BASIS alone -> skips, positions close and it clears',
        state: { ...base, openPositions: 4, openCostBasisUsd: cap }, expect: false },
      { name: `cap breached with a $${loss} loss -> still skips, the loss leaves room`,
        state: { ...base, openPositions: 4, openCostBasisUsd: cap, realisedPnlTodayUsd: -loss },
        expect: false },
      { name: `LOSSES ALONE leave no room ($${cap} lost) -> HALTS, waiting cannot help`,
        state: { ...base, realisedPnlTodayUsd: -cap }, expect: true },
      { name: 'an UNKNOWN basis -> HALTS, it is a defect and cannot resolve itself',
        state: { ...base, openPositions: 1, openPositionsUnknownBasis: 1 }, expect: true },
    ];
    for (const t of termCases) {
      const got = deployedCapIsTerminal(t.state);
      results.push({
        name: `TERMINALITY: ${t.name}`,
        expect: t.expect ? 'BLOCK' : 'ALLOW',
        got: got === t.expect ? (t.expect ? 'BLOCK' : 'ALLOW') : (t.expect ? 'ALLOW' : 'BLOCK'),
        blocked: [`halts=${got}`, `deployed=$${deployedUsd(t.state).toFixed(2)}`],
        pass: got === t.expect,
      });
      log.info(`RAIL CASE: TERMINALITY: ${t.name}`, {
        halts: got, expected_halt: t.expect,
        deployed_usd: Number(deployedUsd(t.state).toFixed(2)),
      });
    }

    /*
     * =====================================================================
     * THE IN-PROCESS RAILS AND THE STOPS -- PART 2, TRIPPED HERE
     * =====================================================================
     *
     * `MAX_TRADES_PER_RUN`, the price stop and the loser deadline are not database
     * rails and `checkRails` does not see them. They are exercised through the pure
     * predicates in `bot/rails.ts` that `launchbot.ts` itself calls, so this drill trips
     * THE SAME CODE the loop runs rather than a re-implementation of it.
     *
     * Each is tested at the threshold and one below. **A guard that fires in both cases
     * is an outage, not a guard**, and the one-below case is the only thing that tells
     * them apart -- four of the five original rails had never been tripped at all.
     */
    const pureCases: Array<{ name: string; got: boolean; expect: boolean; detail: string }> = [];

    /* --- MAX_TRADES_PER_RUN ----------------------------------------------- */
    const runCap = RAILS.MAX_TRADES_PER_RUN;
    pureCases.push({
      name: `MAX_TRADES_PER_RUN at ${runCap - 1} broadcasts (one below)`,
      got: runCapReached(runCap - 1), expect: false,
      detail: `cap=${runCap}`,
    });
    pureCases.push({
      name: `MAX_TRADES_PER_RUN at ${runCap} broadcasts (at the rail)`,
      got: runCapReached(runCap), expect: true,
      detail: `cap=${runCap}`,
    });
    pureCases.push({
      name: 'MAX_TRADES_PER_RUN at 0 broadcasts (a fresh run must be allowed to trade)',
      got: runCapReached(0), expect: false,
      detail: `cap=${runCap}`,
    });

    /* --- THE PRICE STOP --------------------------------------------------- */
    /*
     * Derived from the rail so raising it cannot silently make the "one below" case
     * breach it. `paid` is a round 1e15 wei so the bps arithmetic is exact rather than
     * landing a basis point either side of the threshold by rounding.
     */
    const paid = 1_000_000_000_000_000n;
    const markAt = (bps: number): bigint => paid - (paid * BigInt(bps)) / 10000n;
    const stopBps = RAILS.STOP_LOSS_BPS;
    pureCases.push({
      name: `price stop at a ${stopBps - 1} bps decline (one below the ${stopBps} bps limit)`,
      got: priceStopFires(paid, markAt(stopBps - 1)).fires, expect: false,
      detail: `decline=${String(priceStopFires(paid, markAt(stopBps - 1)).declineBps)} bps`,
    });
    pureCases.push({
      name: `price stop at a ${stopBps} bps decline (at the limit)`,
      got: priceStopFires(paid, markAt(stopBps)).fires, expect: true,
      detail: `decline=${String(priceStopFires(paid, markAt(stopBps)).declineBps)} bps`,
    });
    /*
     * THE MEASURED CASE, AND IT IS THE IMPORTANT ONE. -200 bps is the worst price any of
     * the twelve live positions showed while still sellable, and it IS the LP fee. This
     * case asserts the stop does NOT fire there, which is the same as asserting the
     * measurement: **a price stop could not have saved any of the twelve.** If this
     * case ever flips to BLOCK, `STOP_LOSS_BPS` has been tightened onto the fee and the
     * bot will sell every position on entry.
     */
    pureCases.push({
      name: 'price stop at -200 bps, the WORST decline seen while sellable (= the LP fee) '
        + '-> must NOT fire; 0 of 12 live positions could have been saved by a price stop',
      got: priceStopFires(paid, markAt(200)).fires, expect: false,
      detail: `decline=${String(priceStopFires(paid, markAt(200)).declineBps)} bps, `
        + `limit=${stopBps} bps`,
    });
    /* AN UNREADABLE MARK IS NOT A DECLINE. */
    pureCases.push({
      name: 'price stop with an UNREADABLE mark -> must NOT fire (unknown is not a loss)',
      got: priceStopFires(paid, null).fires, expect: false,
      detail: 'mark=null',
    });
    pureCases.push({
      name: 'price stop with NO recorded cost basis -> must NOT fire (nothing to compare)',
      got: priceStopFires(0n, markAt(9000)).fires, expect: false,
      detail: 'paid=0',
    });

    /* --- THE LOSER DEADLINE ----------------------------------------------- */
    const dl = RAILS.LOSER_DEADLINE_BLOCKS;
    pureCases.push({
      name: `loser deadline at ${dl - 1} blocks held (one below)`,
      got: loserDeadlineFires(1_000_000, 1_000_000 + dl - 1).fires, expect: false,
      detail: `limit=${dl} blocks`,
    });
    pureCases.push({
      name: `loser deadline at ${dl} blocks held (at the deadline)`,
      got: loserDeadlineFires(1_000_000, 1_000_000 + dl).fires, expect: true,
      detail: `limit=${dl} blocks`,
    });
    /*
     * THE MEASURED CASE. 11 of the 12 live positions were unsellable within 20 seconds
     * = 200 blocks. This asserts the deadline does NOT fire there, which is the same as
     * asserting that the deadline is six to twenty-four times slower than the window
     * that decided every one of them, and that the sellability poll is what has to
     * catch them.
     */
    pureCases.push({
      name: 'loser deadline at 200 blocks (= 20 s, by which 11 of 12 live positions were '
        + 'ALREADY DEAD) -> does NOT fire; the deadline is not what calls these losers',
      got: loserDeadlineFires(1_000_000, 1_000_200).fires, expect: false,
      detail: `limit=${dl} blocks = ${dl / 10} s`,
    });
    pureCases.push({
      name: 'loser deadline with NO entry block -> must NOT fire (we do not know when it started)',
      got: loserDeadlineFires(null, 9_999_999).fires, expect: false,
      detail: 'entry_block=null',
    });

    for (const t of pureCases) {
      results.push({
        name: `IN-PROCESS: ${t.name}`,
        expect: t.expect ? 'BLOCK' : 'ALLOW',
        got: t.got ? 'BLOCK' : 'ALLOW',
        blocked: [t.detail],
        pass: t.got === t.expect,
      });
      log.info(`RAIL CASE: IN-PROCESS: ${t.name}`, {
        fires: t.got, expected_to_fire: t.expect, detail: t.detail,
      });
    }

    /* --- CLEANUP, VERIFIED ON A FRESH CONNECTION --------------------------- */
    await wipe(c);
  } finally {
    c.release();
  }

  const fresh = await app.pool.connect();
  let leftover = -1; let control = -1;
  try {
    const a = await fresh.query<{ n: string }>(
      'select count(*)::text n from bot_trades where chain = $1', [CHAIN]);
    const b = await fresh.query<{ n: string }>(
      'select count(*)::text n from bot_control where chain = $1', [CHAIN]);
    leftover = Number(a.rows[0]!.n); control = Number(b.rows[0]!.n);
  } finally { fresh.release(); }

  const failed = results.filter((r) => !r.pass);
  log.info('RAIL DRILL COMPLETE', {
    cases: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results: results.map((r) => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  expected `
      + `${r.expect} got ${r.got}${r.blocked.length ? ` [${r.blocked.join('; ')}]` : ''}`),
    cleanup_verified_on_fresh_connection: {
      bot_trades_rows_left: leftover, bot_control_rows_left: control,
    },
  });
  await app.pool.end();
  if (failed.length > 0 || leftover !== 0 || control !== 0) {
    log.error('RAIL DRILL FAILED', { failed: failed.length, leftover, control });
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { log.error('rail-drill failed', errorFields(err)); process.exit(1); });
